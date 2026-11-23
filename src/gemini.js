// Calls to the Gemini API (Google AI Studio), daily call counter, error handling and key type.
// The free daily quota resets at midnight Pacific time (Google's rule).
const { t } = require('./i18n');
const API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-flash-latest';

// Current quota day (YYYY-MM-DD, Pacific time).
const quotaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// Next quota reset (midnight Pacific), as a timestamp. Daylight saving changes happen at 2 a.m., after midnight.
function nextQuotaReset(now = Date.now()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(now))) p[x.type] = +x.value;
  return now - (now % 1000) + (86400 - (p.hour * 3600 + p.minute * 60 + p.second)) * 1000;
}

function usage(settings) {
  const day = quotaDay();
  const u = settings.geminiUsage && settings.geminiUsage.day === day ? settings.geminiUsage : { day, count: 0, blocked: false };
  const budget = settings.geminiBudget || 20;
  return { ...u, budget, left: u.blocked ? 0 : Math.max(0, budget - u.count) };
}

// kind: what went wrong, and whether waiting helps.
//   overload    : Gemini is overloaded (503, 500, capacity) - retry after a short wait
//   rate        : too many requests per minute - wait the time Gemini gives, then retry
//   daily       : daily quota used up - wait for the reset (midnight Pacific time)
//   quota       : spend cap or prepaid credits used up - nothing to do but wait or top up
//   unavailable : this model is not available with this key (free key on a paid-only model)
//   auth        : key refused
//   other       : anything else (bad request, unreadable answer…)
class GeminiError extends Error {
  constructor(message, o = {}) {
    super(message);
    this.status = o.status;
    this.kind = o.kind || 'other';
    this.retryMs = o.retryMs || 0;
    this.freeTier = !!o.freeTier;
    this.quota = this.kind === 'daily' || this.kind === 'quota';
  }
  get transient() { return this.kind === 'overload' || this.kind === 'rate'; }
}

const seconds = (v) => { const m = String(v || '').match(/([\d.]+)\s*s/); return m ? parseFloat(m[1]) : 0; };

// Reads Gemini's error body: { error: { code, message, status, details: [QuotaFailure, RetryInfo, ErrorInfo…] } }.
function classify(status, data, text) {
  const err = (data && data.error) || {};
  const details = Array.isArray(err.details) ? err.details : [];
  const msg = String(err.message || text || '');
  const ids = [];
  let retryMs = 0, reason = '';
  for (const d of details) {
    const type = String((d && d['@type']) || '');
    if (/QuotaFailure/.test(type)) for (const v of d.violations || []) ids.push(`${v.quotaId || ''} ${v.quotaMetric || ''}`);
    if (/RetryInfo/.test(type)) retryMs = seconds(d.retryDelay) * 1000;
    if (/ErrorInfo/.test(type)) reason = String(d.reason || '');
  }
  if (!retryMs) { const m = msg.match(/retry in ([\d.]+)\s*s/i); if (m) retryMs = parseFloat(m[1]) * 1000; }
  const all = `${msg} ${ids.join(' ')} ${reason}`;
  const freeTier = /free[_ -]?tier/i.test(all);
  const limitZero = /limit:\s*0\b/.test(msg);
  const st = String(err.status || '');
  let kind = 'other';
  if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/.test(`${st} ${reason}`)) kind = 'auth';
  else if ([500, 502, 503, 504].includes(status) || /^(UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)$/.test(st) || /overloaded/i.test(msg)) kind = 'overload';
  else if (status === 429 || st === 'RESOURCE_EXHAUSTED') {
    if (/CAPACITY/i.test(reason) || /capacity/i.test(msg)) kind = 'overload';
    else if (limitZero) kind = 'unavailable';
    else if (/PerDay/i.test(all)) kind = 'daily';
    else if (/spend(ing)?[ _-]?cap|prepa(y|id)|credits? (are |have been )?(depleted|exhausted)/i.test(msg)) kind = 'quota';
    else kind = 'rate';
  }
  return { kind, retryMs, freeTier };
}

const MESSAGES = {
  overload: () => t('Gemini is overloaded right now.'),
  rate: () => t('Too many requests to Gemini in a short time.'),
  daily: () => t('Daily Gemini quota used up.'),
  quota: () => t('Gemini spending limit reached (spend cap or prepaid credits).'),
  unavailable: () => t('This Gemini model is not available with this key. Choose another model in Settings.'),
  auth: () => t('Gemini refused the key. Check it in Settings.'),
};

async function request(fetchFn, key, path, body) {
  const res = await fetchFn(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const c = classify(res.status, data, text);
    const raw = (data && data.error && data.error.message) || text.slice(0, 300) || `HTTP ${res.status}`;
    const msg = MESSAGES[c.kind] ? `${MESSAGES[c.kind]()} (${String(raw).split('\n')[0].slice(0, 200)})` : raw;
    throw new GeminiError(msg, { status: res.status, ...c });
  }
  return data;
}

// Retries a call while the failure is temporary (overload, per-minute limit), with growing waits and the delay
// Gemini asks for. budgetMs: how long to keep trying in total. onWait({ attempt, wait, kind }) before each wait.
const SCALE = Number(process.env.CARNET_TIME_SCALE) || 1; // shortened waits, for tests only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SCALE));
async function withRetry(call, { budgetMs = 4 * 60e3, onWait, maxAttempts = 12 } = {}) {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try { return await call(attempt); }
    catch (err) {
      if (!(err instanceof GeminiError) || !err.transient || attempt >= maxAttempts) throw err;
      const base = err.kind === 'rate' && err.retryMs ? err.retryMs + 1000 : Math.min(60e3, 4e3 * 2 ** (attempt - 1));
      const wait = Math.round(base + Math.random() * 1500);
      if (Date.now() - start + wait * SCALE > budgetMs * SCALE) throw err;
      if (onWait) onWait({ attempt, wait, kind: err.kind });
      await sleep(wait);
    }
  }
}

// "Flash" models usable for text, most recent first.
async function listModels(fetchFn, key) {
  const names = await allModels(fetchFn, key);
  const flash = names
    .filter((n) => /flash/i.test(n) && !/image|tts|live|audio|embedding|vision|thinking-exp/i.test(n));
  const ver = (n) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  flash.sort((a, b) => ver(b) - ver(a) || a.length - b.length || a.localeCompare(b));
  if (flash.includes(DEFAULT_MODEL)) flash.splice(flash.indexOf(DEFAULT_MODEL), 1);
  return [DEFAULT_MODEL, ...flash];
}
async function allModels(fetchFn, key) {
  const data = await request(fetchFn, key, 'models?pageSize=200');
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

// Free or paid key? Google gives no direct way to know (the tier only shows in AI Studio). Test: a model that is
// not offered on the free tier answers a free key with "limit: 0" (and costs nothing); a paid key gets a
// one-word answer (a fraction of a cent). Returns { tier: 'free' | 'paid' | 'unknown', model }.
const PAID_ONLY = ['gemini-3.1-pro-preview', 'gemini-3-pro-preview'];
async function checkTier(fetchFn, key) {
  const names = await allModels(fetchFn, key);
  const model = PAID_ONLY.find((m) => names.includes(m));
  if (!model) return { tier: 'unknown', model: null };
  try {
    await request(fetchFn, key, `models/${model}:generateContent`, { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 16 } });
    return { tier: 'paid', model };
  } catch (err) {
    if (err.freeTier || err.kind === 'unavailable') return { tier: 'free', model };
    // Paid key that is rate limited or overloaded on this model: still a paid key.
    if (err.kind === 'rate' || err.kind === 'overload' || err.kind === 'quota') return { tier: err.freeTier ? 'free' : 'paid', model };
    return { tier: 'unknown', model, error: err.message };
  }
}

// One call = one request counted in the day's quota. Returns the JSON object produced by the model.
// audio (optional): { mimeType, data in base64 }, sent in the same request as the text.
// temperature: higher for suggestions that should vary from one call to the next.
async function generateJson(fetchFn, { key, model, system, prompt, schema, audio, temperature }) {
  const parts = audio ? [{ inlineData: { mimeType: audio.mimeType, data: audio.data } }, { text: prompt }] : [{ text: prompt }];
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    // Audio attached: low temperature, for a word-for-word transcript.
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: temperature !== undefined ? temperature : audio ? 0.2 : 0.4 },
  };
  const data = await request(fetchFn, key, `models/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`, body);
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(why ? t('Gemini blocked the answer ({why}).', { why }) : t('Empty answer from Gemini.'));
  }
  const text = (cand.content && cand.content.parts || []).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (_) {
    throw new GeminiError(t('Unreadable answer from Gemini ({why}).', { why: cand.finishReason || '?' }));
  }
}

// Response schemas (simplified OpenAPI format accepted by Gemini). Field names in French: those of the journal data.
const S = (type, extra = {}) => ({ type, ...extra });
const STR = S('STRING');
const LIST = S('ARRAY', { items: STR });

// State of a subject: where the person is at, what is left to decide, leads for next time.
const SUBJECT_FIELDS = {
  titre: STR,
  categorie: STR,
  evolution: STR,
  ou_j_en_suis: STR,
  a_trancher: LIST,
  pistes: LIST,
  etat: S('STRING', { enum: ['ouvert', 'conclu'] }),
  conclusion: STR,
};

// A step forward: done (a plan carried out), understood (how to act or how to see a kind of situation), moved
// (something that no longer weighs on the person).
const PROGRESS_ITEM = S('OBJECT', {
  properties: { kind: S('STRING', { enum: ['done', 'understood', 'moved'] }), text: STR, how: S('STRING', { enum: ['act', 'see', 'none'] }), situation: STR, subject: STR, moment: STR, since: STR },
  propertyOrdering: ['kind', 'text', 'how', 'situation', 'subject', 'moment', 'since'],
  required: ['kind', 'text'],
});

const ENTRY_SCHEMA = S('OBJECT', {
  properties: {
    titre: STR,
    resume: STR,
    idees: S('ARRAY', { items: S('OBJECT', { properties: { texte: STR, moment: STR, sujet: STR }, required: ['texte', 'sujet'] }) }),
    sujets: S('ARRAY', { items: S('OBJECT', { properties: { id: STR, ...SUBJECT_FIELDS }, propertyOrdering: ['id', 'titre', 'categorie', 'evolution', 'ou_j_en_suis', 'a_trancher', 'pistes', 'etat', 'conclusion'], required: ['titre', 'evolution', 'ou_j_en_suis', 'etat'] }) }),
    humeur: STR,
    personnes: LIST,
    a_faire: LIST,
    citation: STR,
    // What the video changes in what is known about the person (add, update or remove a fact).
    profile: S('ARRAY', { items: S('OBJECT', { properties: { action: S('STRING', { enum: ['add', 'update', 'remove'] }), id: STR, text: STR }, required: ['action'] }) }),
    // Progress: what the video shows as done, understood or left behind, only what the person says.
    progress: S('ARRAY', { items: PROGRESS_ITEM }),
    // Earlier realizations (or things left behind) that this video applies, goes against, or meets again.
    links: S('ARRAY', { items: S('OBJECT', { properties: { id: STR, effect: S('STRING', { enum: ['applied', 'against', 'similar'] }), note: STR, moment: STR }, propertyOrdering: ['id', 'effect', 'note', 'moment'], required: ['id', 'effect', 'note'] }) }),
  },
  propertyOrdering: ['titre', 'resume', 'idees', 'sujets', 'humeur', 'personnes', 'a_faire', 'citation', 'profile', 'progress', 'links'],
  required: ['titre', 'idees', 'sujets'],
});

// Same card, plus the transcript of the sound sent.
const ENTRY_AUDIO_SCHEMA = S('OBJECT', {
  properties: {
    transcription: S('ARRAY', { items: S('OBJECT', { properties: { debut: STR, texte: STR }, required: ['debut', 'texte'] }) }),
    ...ENTRY_SCHEMA.properties,
  },
  propertyOrdering: ['transcription', ...ENTRY_SCHEMA.propertyOrdering],
  required: ['transcription', ...ENTRY_SCHEMA.required],
});

// Reorganisation: the full list of subjects, each with the references of its ideas.
// A reorganisation has no "previous video": no evolution field.
const { evolution: _evo, ...REBUILD_FIELDS } = SUBJECT_FIELDS;
const REBUILD_SCHEMA = S('OBJECT', {
  properties: {
    sujets: S('ARRAY', { items: S('OBJECT', { properties: { ...REBUILD_FIELDS, idees: LIST }, propertyOrdering: ['titre', 'categorie', 'idees', 'ou_j_en_suis', 'a_trancher', 'pistes', 'etat', 'conclusion'], required: ['titre', 'idees', 'ou_j_en_suis', 'etat'] }) }),
  },
  required: ['sujets'],
});

const ITEMS = S('ARRAY', { items: S('OBJECT', { properties: { sujet: STR, texte: STR }, required: ['texte'] }) });
const BILAN_SCHEMA = S('OBJECT', {
  properties: { en_bref: STR, avance: ITEMS, en_suspens: ITEMS, contradictions: LIST, a_dire: LIST },
  propertyOrdering: ['en_bref', 'avance', 'en_suspens', 'contradictions', 'a_dire'],
  required: ['en_bref', 'avance', 'en_suspens', 'a_dire'],
});
// Applying the clarifications: only what changes.
const CORRECTION_SCHEMA = S('OBJECT', {
  properties: {
    fiches: S('ARRAY', { items: S('OBJECT', { properties: { id: STR, titre: STR, resume: STR, personnes: LIST, idees: S('ARRAY', { items: S('OBJECT', { properties: { ref: STR, texte: STR }, required: ['ref', 'texte'] }) }) }, required: ['id'] }) }),
    sujets: S('ARRAY', { items: S('OBJECT', { properties: { id: STR, titre: STR, evolution: STR, ou_j_en_suis: STR, a_trancher: LIST, pistes: LIST, conclusion: STR }, required: ['id'] }) }),
    bilans: S('ARRAY', { items: S('OBJECT', { properties: { id: STR, evolution_semaine: STR, suivi: LIST, en_bref: STR, avance: ITEMS, en_suspens: ITEMS, contradictions: LIST, a_dire: LIST }, required: ['id'] }) }),
    fusions: S('ARRAY', { items: S('OBJECT', { properties: { de: STR, vers: STR }, required: ['de', 'vers'] }) }),
    profile: S('ARRAY', { items: S('OBJECT', { properties: { id: STR, text: STR }, required: ['id', 'text'] }) }),
  },
  propertyOrdering: ['fiches', 'sujets', 'bilans', 'fusions', 'profile'],
  required: ['fiches', 'sujets', 'bilans', 'fusions'],
});
// Summary of a week: the same as a period, plus the comparison with the previous week.
const WEEK_SCHEMA = S('OBJECT', {
  properties: { evolution_semaine: STR, suivi: LIST, ...BILAN_SCHEMA.properties },
  propertyOrdering: ['evolution_semaine', 'suivi', ...BILAN_SCHEMA.propertyOrdering],
  required: ['evolution_semaine', ...BILAN_SCHEMA.required],
});

// Strengths and weaknesses, in one request: where the person is on each item of their list, and new suggestions
// (each with why and the videos that show it).
const SUGGESTION = S('OBJECT', { properties: { text: STR, why: STR, videos: LIST }, propertyOrdering: ['text', 'why', 'videos'], required: ['text', 'why'] });
const CHECK_ITEM = S('OBJECT', { properties: { id: STR, status: S('STRING', { enum: ['shows', 'changing', 'not_seen'] }), note: STR, videos: LIST }, propertyOrdering: ['id', 'status', 'note', 'videos'], required: ['id', 'status', 'note'] });
const REVIEW_SCHEMA = S('OBJECT', {
  properties: { items: S('ARRAY', { items: CHECK_ITEM }), strengths: S('ARRAY', { items: SUGGESTION }), weaknesses: S('ARRAY', { items: SUGGESTION }) },
  propertyOrdering: ['items', 'strengths', 'weaknesses'],
  required: ['items', 'strengths', 'weaknesses'],
});

// Look-back: questions to compare then and now, each about an item of the material (or none).
const LOOKBACK_SCHEMA = S('OBJECT', {
  properties: { questions: S('ARRAY', { items: S('OBJECT', { properties: { text: STR, about: STR }, propertyOrdering: ['text', 'about'], required: ['text'] }) }) },
  required: ['questions'],
});
// How far you've come: the person then and now, over months.
const REPORT_SCHEMA = S('OBJECT', {
  properties: {
    then_now: STR,
    changes: S('ARRAY', { items: S('OBJECT', { properties: { text: STR, then: STR, now: STR, videos: LIST }, propertyOrdering: ['text', 'then', 'now', 'videos'], required: ['text', 'then', 'now'] }) }),
    learned: LIST,
    still: S('ARRAY', { items: S('OBJECT', { properties: { text: STR, why: STR }, propertyOrdering: ['text', 'why'], required: ['text'] }) }),
    patterns: S('ARRAY', { items: S('OBJECT', { properties: { text: STR, videos: LIST }, propertyOrdering: ['text', 'videos'], required: ['text'] }) }),
  },
  propertyOrdering: ['then_now', 'changes', 'learned', 'still', 'patterns'],
  required: ['then_now', 'changes', 'learned', 'still', 'patterns'],
});

// Steps forward in the earlier videos: each with the reference of the idea where it is said ("at") and, when it
// shows, of the idea where it started ("from").
const BACKFILL_SCHEMA = S('OBJECT', {
  properties: {
    progress: S('ARRAY', { items: S('OBJECT', {
      properties: { kind: S('STRING', { enum: ['done', 'understood', 'moved'] }), text: STR, how: S('STRING', { enum: ['act', 'see', 'none'] }), situation: STR, subject: STR, at: STR, from: STR },
      propertyOrdering: ['kind', 'text', 'how', 'situation', 'subject', 'at', 'from'], required: ['kind', 'text', 'at'] }) }),
  },
  required: ['progress'],
});

module.exports = { BACKFILL_SCHEMA, LOOKBACK_SCHEMA, REPORT_SCHEMA, SCALE, DEFAULT_MODEL, quotaDay, nextQuotaReset, usage, listModels, checkTier, classify, withRetry, generateJson, GeminiError, ENTRY_SCHEMA, ENTRY_AUDIO_SCHEMA, REBUILD_SCHEMA, BILAN_SCHEMA, WEEK_SCHEMA, CORRECTION_SCHEMA, REVIEW_SCHEMA };
