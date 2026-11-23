// Journal: data (journal.json), requests sent to Gemini, and generated Markdown files.
// No dependency on Electron (testable with Node alone).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const i18n = require('./i18n');
const { t, tn } = i18n;

const DATA_FILE = 'journal.json';
const MD_FILE = 'Journal.md';
const INSTRUCTIONS_FILE = 'Journal instructions.md';
const OLD_INSTRUCTIONS_FILES = ['Instructions du journal.md'];
const TRANSCRIPTS_DIR = 'Transcripts';
const OLD_TRANSCRIPTS_DIR = 'Transcriptions';

const p2 = (x) => String(x).padStart(2, '0');
const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (key) => { const [y, m] = key.split('-'); return cap(new Date(+y, +m - 1, 1).toLocaleDateString(i18n.locale, { month: 'long', year: 'numeric' })); };
const dayLabel = (ts) => new Date(ts).toLocaleString(i18n.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortDay = (ts) => new Date(ts).toLocaleDateString(i18n.locale, { day: '2-digit', month: '2-digit' });
// Dates in requests to Gemini: one format, whatever the language.
const promptDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const promptShort = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

function fmtT(t0) {
  const x = Math.max(0, Math.floor(t0 || 0));
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}
function parseT(str) {
  const m = String(str || '').match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

// ---------- Transcript ----------
function cleanSegments(raw) {
  return raw
    .map((s) => ({ from: s.from, to: s.to, text: String(s.text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, '').replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text && !/^[.…,!?\s-]*$/.test(s.text));
}
function parseWhisperJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return cleanSegments((data.transcription || []).map((x) => ({
    from: (x.offsets && x.offsets.from || 0) / 1000,
    to: (x.offsets && x.offsets.to || 0) / 1000,
    text: x.text,
  })));
}

// Grouped text: by chapter if there are chapters, otherwise in paragraphs (2 s pause or 60 s of text).
function sections(segments, chapters) {
  const ch = [...(chapters || [])].sort((a, b) => a.t - b.t);
  if (ch.length) {
    return ch.map((c, i) => {
      const end = i + 1 < ch.length ? ch[i + 1].t : Infinity;
      return { t: c.t, title: c.title, text: segments.filter((s) => s.from >= c.t - 0.5 && s.from < end - 0.5).map((s) => s.text).join(' ') };
    }).filter((s, i) => s.text || i === 0);
  }
  const out = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.from - cur.last > 2 || s.from - cur.t > 60) { cur = { t: s.from, parts: [], last: s.to }; out.push(cur); }
    cur.parts.push(s.text);
    cur.last = s.to;
  }
  return out.map((c) => ({ t: c.t, title: null, text: c.parts.join(' ') }));
}

// ---------- Data ----------
// journal.json, version 3 (field names kept from the first versions, in French):
//   entries : the videos (transcript and summary card)
//   sujets  : the threads of thought running from one video to the next (where you're at, what's left to decide)
//   bilans  : summaries of a period (last 7 days, last 7 videos, this month)
//   semaines: summary of each calendar week
//   profile : who the person is, their strengths and weaknesses (see "You" below)
// Each idea of a card points to its subject: idee.sujet = subject id.
const hasIdeas = (e) => !!(e.analysis && (e.analysis.idees || []).length);
const BACKUP_DIR = 'Backups';
const OLD_BACKUP_DIR = 'Sauvegardes';
const BAK_FILE = DATA_FILE + '.bak';
const KEEP_DAYS = 14;

// Reads journal.json. If the file is damaged (power cut during a write, half-done sync), the last healthy copy is
// used: journal.json.bak (previous version), then the daily backups. The damaged file is put aside, never
// overwritten. If nothing is readable, data.broken is set and save() refuses to write: a frozen journal is better
// than an empty journal written over the old one.
function readJson(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const d = JSON.parse(txt);
  if (!d || typeof d !== 'object' || !Array.isArray(d.entries)) throw new Error(t('unexpected content'));
  return d;
}
function backupFiles(dir) {
  const out = [];
  for (const sub of [BACKUP_DIR, OLD_BACKUP_DIR]) {
    const bd = path.join(dir, sub);
    try { out.push(...fs.readdirSync(bd).filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => path.join(bd, f))); } catch (_) {}
  }
  return out.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}
// Folders named in French by earlier versions: renamed once (if that fails, the old ones are still read).
function migrateFolders(dir) {
  for (const [from, to] of [[OLD_BACKUP_DIR, BACKUP_DIR], [OLD_TRANSCRIPTS_DIR, TRANSCRIPTS_DIR]]) {
    const a = path.join(dir, from), b = path.join(dir, to);
    try { if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch (_) {}
  }
}
function load(dir) {
  migrateFolders(dir);
  const main = path.join(dir, DATA_FILE);
  let d = null, restoredFrom = null, broken = null;
  if (fs.existsSync(main)) {
    try { d = readJson(main); } catch (err) {
      for (const f of [path.join(dir, BAK_FILE), ...backupFiles(dir)]) {
        try { d = readJson(f); restoredFrom = f; break; } catch (_) {}
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const aside = path.join(dir, `${DATA_FILE}.damaged-${stamp}`);
      try { fs.copyFileSync(main, aside); } catch (_) {}
      if (!d) broken = t('journal.json cannot be read ({why}) and no backup can be read either. A copy of the damaged file is kept as {copy}. Carnet writes nothing more to the journal until this is fixed.', { why: err.message, copy: path.basename(aside) });
    }
  } else {
    // File gone (deleted or not synced yet) while a copy remains: the copy is used.
    for (const f of [path.join(dir, BAK_FILE), ...backupFiles(dir)]) {
      try { d = readJson(f); restoredFrom = f; break; } catch (_) {}
    }
  }
  d = d || {};
  const data = { version: 3, entries: d.entries || [], sujets: d.sujets || [], bilans: d.bilans || [], semaines: d.semaines || {}, precisions: d.precisions || [], profile: normalizeProfile(d.profile), progress: normalizeProgress(d.progress), rebuild: !!d.rebuild };
  for (const k of ['bilanDue', 'rebuildError', 'bilanError']) if (d[k] !== undefined) data[k] = d[k];
  // Journal from an earlier version (summaries by month): subjects are built from the cards.
  if ((d.version || 2) < 3 && data.entries.some(hasIdeas)) data.rebuild = true;
  // Session fields, never written to the file.
  Object.defineProperty(data, 'broken', { value: broken, writable: true, enumerable: false });
  Object.defineProperty(data, 'restoredFrom', { value: restoredFrom ? path.relative(dir, restoredFrom) : null, writable: true, enumerable: false });
  return data;
}
function save(dir, data) {
  if (data.broken) throw new Error(data.broken);
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, DATA_FILE);
  const txt = JSON.stringify(data, null, 1);
  // Safety: never replace a journal that has videos with an empty one
  // (unless the last video was just removed on purpose: data.emptiedOnPurpose).
  if (!data.entries.length && !data.emptiedOnPurpose && fs.existsSync(main)) {
    let refuse = false;
    try { refuse = readJson(main).entries.length > 0; } catch (_) {}
    if (refuse) throw new Error(t('Write refused: it would have emptied the journal.'));
  }
  // Previous version kept alongside, and one backup per day (the last 14 days).
  if (fs.existsSync(main)) {
    try { readJson(main); fs.copyFileSync(main, path.join(dir, BAK_FILE)); } catch (_) {}
    const bd = path.join(dir, BACKUP_DIR);
    const today = path.join(bd, `journal-${new Date().toLocaleDateString('en-CA')}.json`);
    if (!fs.existsSync(today)) {
      try {
        readJson(main);
        fs.mkdirSync(bd, { recursive: true });
        fs.copyFileSync(main, today);
        for (const old of backupFiles(dir).slice(KEEP_DAYS)) fs.rmSync(old, { force: true });
      } catch (_) {}
    }
  }
  const tmp = main + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, txt, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, main);
  writeMarkdown(dir, data);
}
const newId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const newSubjectId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const newItemId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Fingerprints of earlier default versions: if the file in the folder was not edited by hand, it is replaced
// by the new version.
const OLD_DEFAULTS = new Set(['bfa70c3da595f649', 'cb1dcf98caa77f21', '9237d6def9833a09', '127db5553d54ed01', '4b2aeb37eb1d5e23', '38e8e2a3f2fbf8f9', '8e034a1ef6858dad', '946a8e342766e3b8', '77a6d80c2281e591', '3e81c7d69618009a', 'ca8d800f1918c567']);
const fingerprint = (txt) => crypto.createHash('sha256').update(txt).digest('hex').slice(0, 16);

// Copies the default instructions file into the journal folder if it is not there. The earlier French file name:
// an untouched default is replaced, an edited one is kept under the new name.
function ensureInstructions(dir, defaultFile) {
  const p = path.join(dir, INSTRUCTIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  for (const old of OLD_INSTRUCTIONS_FILES) {
    const op = path.join(dir, old);
    try {
      if (fs.existsSync(op) && !fs.existsSync(p)) {
        if (OLD_DEFAULTS.has(fingerprint(fs.readFileSync(op)))) fs.rmSync(op); else fs.renameSync(op, p);
      }
    } catch (_) {}
  }
  if (!fs.existsSync(p) || OLD_DEFAULTS.has(fingerprint(fs.readFileSync(p)))) fs.copyFileSync(defaultFile, p);
  return p;
}
// Sections that came with later versions, by version: instructions edited before a version keep their text and get
// that version's sections added at each call (the file itself is not touched). A group already partly there (the
// person removed a section on purpose) is left as it is.
const NEW_SECTIONS = [['Tone', 'About the person', 'Strengths and weaknesses'], ['Progress', 'Look back', 'How far you\'ve come']];
function withNewSections(txt, defaultTxt) {
  const re = (h, rest = '') => new RegExp(`^## ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \t]*$${rest}`, 'm');
  const add = NEW_SECTIONS.filter((group) => !group.some((h) => re(h).test(txt)))
    .flatMap((group) => group.map((h) => (defaultTxt.match(re(h, '[\\s\\S]*?(?=^## |(?![\\s\\S]))')) || [''])[0].trim()).filter(Boolean));
  return add.length ? [txt.trimEnd(), ...add].join('\n\n') + '\n' : txt;
}
const readInstructions = (dir, defaultFile) => withNewSections(fs.readFileSync(ensureInstructions(dir, defaultFile), 'utf8'), fs.readFileSync(defaultFile, 'utf8'));

// Language of everything Gemini writes, added to the instructions at each call.
function languageRule(code = i18n.lang) {
  const l = i18n.info(code);
  return [
    '',
    '## Language',
    '',
    `Write every text you produce in ${l.english}, whatever the language of these instructions and of the videos. The transcript stays word for word, in the language that is spoken.`,
    `The person's own words: always between ${l.quotes[0].trim()} and ${l.quotes[1].trim()}, and these marks only for their exact words.`,
  ].join('\n');
}

// ---------- Subjects ----------
const DAY = 864e5;
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const strList = (x) => (Array.isArray(x) ? x.map((s) => String(s || '').trim()).filter(Boolean) : []);
const findSubject = (data, ref) => {
  if (!ref) return null;
  const r = String(ref).replace(/^\[|\]$/g, '').trim();
  return data.sujets.find((s) => s.id === r) || data.sujets.find((s) => norm(s.titre) === norm(r)) || null;
};
// Before the state of a subject is rewritten, the old version goes into its history, to follow how the person's
// position changed from one video to the next.
// source: 'video' (a new video), 'toi' (concluded or reopened by hand), 'reorganisation', 'precision'.
function remember(s, source) {
  if (!s.ou_j_en_suis && s.etat !== 'conclu') return;
  s.historique = s.historique || [];
  const last = s.historique[s.historique.length - 1];
  if (last && last.ou_j_en_suis === s.ou_j_en_suis && last.etat === s.etat && last.conclusion === s.conclusion) return;
  s.historique.push({ date: s.majLe || s.cree || 0, entry: s.majPar || null, source: s.majSource || 'video', evolution: s.evolution || '', ou_j_en_suis: s.ou_j_en_suis, a_trancher: [...(s.a_trancher || [])], etat: s.etat, conclusion: s.conclusion || '' });
  if (s.historique.length > 60) s.historique.splice(0, s.historique.length - 60);
  s.majSource = source;
}
// The state of a subject as it was just before a date (for summaries: where the person stood at the start).
function stateBefore(s, date) {
  if ((s.majLe || 0) < date) return s;
  const h = (s.historique || []).filter((x) => x.date < date);
  return h.length ? h[h.length - 1] : null;
}
function newSubject(titre, categorie, date) {
  return { id: newSubjectId(), titre: String(titre).trim(), categorie: categorie || '', etat: 'ouvert', ou_j_en_suis: '', a_trancher: [], pistes: [], conclusion: '', epingle: false, majLe: 0, cree: date || Date.now() };
}

// For each subject: its ideas (with their video, in chronological order), its videos, the first and last time.
function subjectStats(data) {
  const m = new Map(data.sujets.map((s) => [s.id, { ideas: [], entries: new Set(), first: Infinity, last: 0 }]));
  for (const e of [...data.entries].sort((a, b) => a.date - b.date)) {
    for (const i of (e.analysis && e.analysis.idees) || []) {
      const st = i.sujet && m.get(i.sujet);
      if (!st) continue;
      st.ideas.push({ ...i, entry: e });
      st.entries.add(e.id);
      st.first = Math.min(st.first, e.date);
      st.last = Math.max(st.last, e.date);
    }
  }
  return m;
}
// Subjects sorted: pinned first, then from the most recently discussed to the oldest.
function sortedSubjects(data, stats = subjectStats(data)) {
  const last = (s) => (stats.get(s.id) || {}).last || 0;
  return [...data.sujets].sort((a, b) => (b.epingle ? 1 : 0) - (a.epingle ? 1 : 0) || last(b) - last(a) || a.titre.localeCompare(b.titre));
}
// A subject with no idea left (video removed or analysed again) disappears.
function pruneSubjects(data) {
  const used = new Set();
  for (const e of data.entries) for (const i of (e.analysis && e.analysis.idees) || []) if (i.sujet) used.add(i.sujet);
  data.sujets = data.sujets.filter((s) => used.has(s.id));
}
// Merges subject a into subject b (duplicates created by the AI).
function mergeSubjects(data, aId, bId) {
  const a = data.sujets.find((s) => s.id === aId), b = data.sujets.find((s) => s.id === bId);
  if (!a || !b || a === b) return false;
  for (const e of data.entries) for (const i of (e.analysis && e.analysis.idees) || []) if (i.sujet === a.id) i.sujet = b.id;
  b.a_trancher = [...new Set([...b.a_trancher, ...a.a_trancher])];
  b.pistes = [...new Set([...b.pistes, ...a.pistes])];
  if (!b.ou_j_en_suis) b.ou_j_en_suis = a.ou_j_en_suis;
  if (!b.categorie) b.categorie = a.categorie;
  b.epingle = b.epingle || a.epingle;
  // The history of the merged subject is kept, with its old title.
  const fromA = [...(a.historique || [])];
  if (a.ou_j_en_suis || a.etat === 'conclu') fromA.push({ date: a.majLe || 0, entry: a.majPar || null, source: a.majSource || 'video', evolution: a.evolution || '', ou_j_en_suis: a.ou_j_en_suis, a_trancher: [...a.a_trancher], etat: a.etat, conclusion: a.conclusion || '' });
  b.historique = [...(b.historique || []), ...fromA.map((x) => ({ ...x, titre: x.titre || a.titre }))].sort((x, y) => x.date - y.date);
  data.sujets = data.sujets.filter((s) => s !== a);
  // Steps forward of the merged subject go with it (its "settled" step goes aside: b decides).
  for (const it of progressOf(data).items) {
    if (it.subject !== a.id) continue;
    if (it.source === 'subject') Object.assign(it, { status: 'archived', archivedWhy: 'merged', subject: null });
    else Object.assign(it, { subject: b.id, subjectTitle: b.titre });
  }
  return true;
}
function deleteSubject(data, id) {
  for (const e of data.entries) for (const i of (e.analysis && e.analysis.idees) || []) if (i.sujet === id) i.sujet = null;
  data.sujets = data.sujets.filter((s) => s.id !== id);
}

// Link that opens Carnet on the entry, at the given moment of the video.
const momentLink = (e, t0) => `carnet://entree/${e.id}${t0 !== null && t0 !== undefined ? '?t=' + Math.floor(t0) : ''}`;

// ---------- You: profile, strengths and weaknesses ----------
// profile.facts      : what the person says about themselves ({ id, text, source: 'video' | 'manual', entry, at, history })
// profile.removed    : facts removed by hand ({ text, at }): not added back from older videos
// profile.strengths, profile.weaknesses : the person's own lists ({ id, text, at, source: 'manual' | 'suggestion' })
// profile.suggestions: last suggestions ({ at, angle, strengths: [{ id, text, why, videos }], weaknesses: [...] })
// profile.dismissed  : suggestions set aside (not suggested again)
// profile.check      : "where you're at" ({ at, items: [{ id, status: 'shows' | 'changing' | 'not_seen', note, videos }] })
// profile.changes    : last automatic changes ({ at, action, text, before, entry })
function normalizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const list = (x) => (Array.isArray(x) ? x.filter((i) => i && i.text) : []);
  return {
    facts: list(p.facts), removed: Array.isArray(p.removed) ? p.removed : [],
    strengths: list(p.strengths), weaknesses: list(p.weaknesses),
    suggestions: p.suggestions || null, dismissed: Array.isArray(p.dismissed) ? p.dismissed : [],
    check: p.check || null, changes: Array.isArray(p.changes) ? p.changes : [],
  };
}
const profileOf = (data) => (data.profile = data.profile && data.profile.facts ? data.profile : normalizeProfile(data.profile));
const clean = (x, max = 300) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, max);

// What is known about the person, sent with each video so Gemini updates it.
function profileBlock(data, entry) {
  const p = profileOf(data);
  const L = ['', 'About the person (what they have said about themselves so far; ids in brackets):'];
  if (p.facts.length) for (const f of p.facts) L.push(`[${f.id}] ${f.text}${f.source === 'manual' ? ' (written by the person)' : ''}`);
  else L.push('(nothing yet)');
  const removed = p.removed.filter((r) => !entry || r.at > (entry.date || 0)).slice(-30);
  if (removed.length) L.push('', 'Facts the person removed by hand (do not add them again unless this video says them again):', ...removed.map((r) => `- ${r.text}`));
  return L;
}
// Changes to the profile proposed by the analysis of a video: add, update (id), remove (id).
function applyProfileOps(data, e, ops) {
  const p = profileOf(data);
  let n = 0;
  const log = (action, text, before) => { p.changes.push({ at: Date.now(), action, text, before: before || null, entry: e ? e.id : null }); if (p.changes.length > 40) p.changes.splice(0, p.changes.length - 40); n++; };
  for (const op of Array.isArray(ops) ? ops : []) {
    const action = String(op.action || '').toLowerCase();
    const id = String(op.id || '').replace(/[[\]\s]/g, '');
    const text = clean(op.text || op.texte);
    const f = id && p.facts.find((x) => x.id === id);
    if (action === 'add' && text) {
      if (p.facts.some((x) => norm(x.text) === norm(text))) continue;
      const wasRemoved = p.removed.find((r) => norm(r.text) === norm(text));
      if (wasRemoved && e && e.date <= wasRemoved.at) continue;
      p.facts.push({ id: newItemId('f'), text, source: 'video', entry: e ? e.id : null, at: Date.now(), history: [] });
      log('add', text);
    } else if (action === 'update' && f && text && norm(text) !== norm(f.text)) {
      f.history = [...(f.history || []), { text: f.text, at: f.at, entry: f.entry || null, source: f.source }].slice(-10);
      log('update', text, f.text);
      Object.assign(f, { text, source: 'video', entry: e ? e.id : null, at: Date.now() });
    } else if (action === 'remove' && f) {
      p.facts = p.facts.filter((x) => x !== f);
      log('remove', f.text);
    }
  }
  return n;
}
// Edits made by hand on the "You" page.
function profileEdit(data, a) {
  const p = profileOf(data);
  const kind = a.kind === 'weaknesses' ? 'weaknesses' : 'strengths';
  const text = clean(a.text);
  switch (a.action) {
    case 'addFact':
      if (text && !p.facts.some((x) => norm(x.text) === norm(text))) {
        p.facts.push({ id: newItemId('f'), text, source: 'manual', entry: null, at: Date.now(), history: [] });
        p.removed = p.removed.filter((r) => norm(r.text) !== norm(text));
      }
      break;
    case 'editFact': {
      const f = p.facts.find((x) => x.id === a.id);
      if (f && text && text !== f.text) {
        f.history = [...(f.history || []), { text: f.text, at: f.at, entry: f.entry || null, source: f.source }].slice(-10);
        Object.assign(f, { text, source: 'manual', entry: null, at: Date.now() });
      }
      break;
    }
    case 'removeFact': {
      const f = p.facts.find((x) => x.id === a.id);
      if (f) { p.facts = p.facts.filter((x) => x !== f); p.removed.push({ text: f.text, at: Date.now() }); p.removed = p.removed.slice(-100); }
      break;
    }
    case 'addItem':
      if (text && !p[kind].some((x) => norm(x.text) === norm(text))) p[kind].push({ id: newItemId(kind === 'strengths' ? 'p' : 'c'), text, at: Date.now(), source: a.fromSuggestion ? 'suggestion' : 'manual' });
      if (a.fromSuggestion && p.suggestions) p.suggestions[kind] = (p.suggestions[kind] || []).filter((s) => s.id !== a.fromSuggestion);
      break;
    case 'editItem': {
      const it = p[kind].find((x) => x.id === a.id);
      if (it && text) it.text = text;
      break;
    }
    case 'removeItem':
      p[kind] = p[kind].filter((x) => x.id !== a.id);
      if (p.check) p.check.items = p.check.items.filter((x) => x.id !== a.id);
      break;
    case 'addAll':
      // Every suggestion of the column goes into the list.
      for (const s of (p.suggestions && p.suggestions[kind]) || []) {
        if (!p[kind].some((x) => norm(x.text) === norm(s.text))) p[kind].push({ id: newItemId(kind === 'strengths' ? 'p' : 'c'), text: s.text, at: Date.now(), source: 'suggestion' });
      }
      if (p.suggestions) p.suggestions[kind] = [];
      break;
    case 'dismiss': {
      const s = p.suggestions && (p.suggestions[kind] || []).find((x) => x.id === a.id);
      if (s) {
        p.suggestions[kind] = p.suggestions[kind].filter((x) => x !== s);
        p.dismissed.push({ text: s.text, kind, at: Date.now() });
        p.dismissed = p.dismissed.slice(-200);
      }
      break;
    }
    default: throw new Error(t('Unknown action.'));
  }
}

// Strengths and weaknesses: one request says where the person is on each item of their list (recent videos) and
// suggests about ten new items of each kind. So that the suggestions are not the same every time: three angles
// drawn at random, older videos drawn at random, the last suggestions left out, and a high temperature.
const ANGLES = [
  'how they make decisions',
  'how they deal with other people (family, friends, colleagues)',
  'how they handle work and projects',
  'how they handle stress, doubt and setbacks',
  'their habits and energy from day to day',
  'how they talk about themselves',
  'what they start and what they finish',
  'how they handle money, time and commitments',
  'what they notice, learn and change their mind about',
  'what they avoid, put off or keep for later',
  'how they react when something goes wrong',
  'how they plan, and what happens to the plans',
  'what they ask of themselves and of others',
  'how they rest, eat, sleep and move',
  'how they handle conflict and disagreement',
  'what they are curious about and what they keep coming back to',
];
const SUGGESTIONS = 10; // asked for, of each kind
const SUGGESTIONS_MAX = 12; // kept at most, of each kind
function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function videoCard(data, e) {
  const sub = (id) => (data.sujets.find((s) => s.id === id) || {}).titre;
  return [
    `[${e.id}] ${promptDay(e.date)} · ${entryTitle(e)}`,
    e.analysis.resume ? `Summary: ${e.analysis.resume}` : null,
    ...e.analysis.idees.slice(0, 25).map((i) => `- (${sub(i.sujet) || 'no subject'}) ${i.texte}`),
    e.analysis.humeur ? `Mood: ${e.analysis.humeur}` : null,
  ].filter(Boolean).join('\n');
}
// Recent videos: the last 30 days, or the last 6 videos when there are fewer than 3 in that time (14 at most).
function recentEntries(data, now = Date.now()) {
  const done = data.entries.filter(hasIdeas).sort((a, b) => a.date - b.date);
  const month = done.filter((e) => e.date >= now - 30 * DAY);
  return (month.length >= 3 ? month : done.slice(-6)).slice(-14);
}
function reviewPrompt(data, rand = Math.random, now = Date.now()) {
  const p = profileOf(data);
  const recent = recentEntries(data, now);
  const older = shuffle(data.entries.filter(hasIdeas).filter((e) => !recent.includes(e)), rand).slice(0, 8).sort((a, b) => a.date - b.date);
  const angles = shuffle(ANGLES, rand).slice(0, 3);
  const angle = angles.join('; ');
  const items = [...p.strengths.map((x) => `[${x.id}] (strength) ${x.text}`), ...p.weaknesses.map((x) => `[${x.id}] (weakness) ${x.text}`)];
  const last = p.suggestions ? [...(p.suggestions.strengths || []), ...(p.suggestions.weaknesses || [])] : [];
  const prompt = [
    'Task: look at the strengths and weaknesses of the person, following the instructions: where they are on each item of their list in their recent videos, and new suggestions.',
    `Angles to start from for the suggestions this time: ${angle}. Then any other side of them the videos show.`,
    ...profileBlock(data, null),
    ...precisionsBlock(data, [...recent, ...older]),
    '',
    'Their list:', items.length ? items.join('\n') : '(empty)',
    '', 'Suggestions they set aside (never suggest them again):',
    p.dismissed.length ? p.dismissed.slice(-80).map((d) => `- ${d.text}`).join('\n') : '(none)',
    '', 'Suggestions shown last time, not answered (find other ones):',
    last.length ? last.map((s) => `- ${s.text}`).join('\n') : '(none)',
    '', `Recent videos (${recent.length}, oldest first):`, '', recent.map((e) => videoCard(data, e)).join('\n\n') || '(none)',
    ...(older.length ? ['', `Earlier videos (${older.length}, drawn at random, oldest first):`, '', older.map((e) => videoCard(data, e)).join('\n\n')] : []),
    '',
    `Answer in JSON: items, one per item of their list ({ id, status: shows | changing | not_seen, note, videos: the ids of the videos }); strengths and weaknesses, ${SUGGESTIONS} new suggestions of each ({ text, why, videos }), spread over different sides of their life, no two saying the same thing.`,
  ].join('\n');
  return { prompt, angle, entries: recent.map((e) => e.id) };
}
function applyReview(data, raw, meta = {}, now = Date.now()) {
  const p = profileOf(data);
  const ids = new Set(data.entries.map((e) => e.id));
  const vids = (x) => strList(x).map((v) => v.replace(/[[\]\s]/g, '')).filter((v) => ids.has(v));
  // Suggestions: not the ones set aside, not the ones already in the lists, not twice the same.
  const dismissed = new Set(p.dismissed.map((d) => norm(d.text)));
  const seen = new Set([...p.strengths, ...p.weaknesses].map((x) => norm(x.text)));
  const list = (x) => (Array.isArray(x) ? x : [])
    .map((s) => ({ id: newItemId('g'), text: clean(s.text, 160), why: clean(s.why, 500), videos: vids(s.videos) }))
    .filter((s) => { const k = norm(s.text); if (!s.text || dismissed.has(k) || seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, SUGGESTIONS_MAX);
  p.suggestions = { at: now, angle: meta.angle || '', strengths: list(raw.strengths), weaknesses: list(raw.weaknesses) };
  // Where the person is on each item.
  const known = new Set([...p.strengths, ...p.weaknesses].map((x) => x.id));
  const items = (Array.isArray(raw.items) ? raw.items : []).map((x) => ({
    id: String(x.id || '').replace(/[[\]\s]/g, ''),
    status: ['shows', 'changing', 'not_seen'].includes(x.status) ? x.status : 'not_seen',
    note: clean(x.note, 600),
    videos: vids(x.videos),
  })).filter((x) => known.has(x.id));
  p.check = { at: now, entries: recentEntries(data, now).map((e) => e.id), items };
  return p;
}

// ---------- Progress: what the person did, understood and left behind ----------
// So that what gets sorted out does not just disappear from view: each step forward is kept with the moment it
// started ("then") and the moment it was done, understood or left behind ("now"), both moments of the videos.
// progress.items: { id, kind: 'done' | 'understood' | 'moved', text, how: 'act' | 'see' | '' (understood),
//   situation (understood: the kind of situation it applies to), subject, subjectTitle, then, now ({ entry, t, date }),
//   date, at, source: 'video' | 'manual' | 'subject' (a concluded subject) | 'fading' (confirmed behind them),
//   status: 'active' | 'archived', plan (the plan it closes), settled (concluded subject),
//   track: [{ entry, date, effect: 'applied' | 'against' | 'similar', note, t }] (later videos),
//   review: { due, step, log: [{ at, answer }] } (understood and moved: they come back at growing intervals) }
// progress.asked    : subjects that stopped coming up and were asked about ({ [id]: { at, answer } })
// progress.lookbacks: look-back sessions ({ id, at, from, to, questions: [{ text, about }], entry, done })
// progress.reports  : "How far you've come" ({ id, at, months, from, to, then_now, changes, learned, still, patterns })
const REVIEW_DAYS = [3, 7, 14, 30, 90, 180];
const MOVED_DAYS = [30, 90, 180];
const LOOKBACK_EVERY = 30 * DAY;
function normalizeProgress(p) {
  p = p && typeof p === 'object' ? p : {};
  return {
    items: Array.isArray(p.items) ? p.items.filter((x) => x && x.id && x.text) : [],
    asked: p.asked && typeof p.asked === 'object' ? p.asked : {},
    lookbacks: Array.isArray(p.lookbacks) ? p.lookbacks : [],
    reports: Array.isArray(p.reports) ? p.reports : [],
    later: Number.isFinite(p.later) ? p.later : 0, // look-back put off until then ("Not now")
    backfilled: Number.isFinite(p.backfilled) ? p.backfilled : 0, // earlier videos looked through for steps forward
  };
}
const progressOf = (data) => (data.progress = data.progress && Array.isArray(data.progress.items) ? data.progress : normalizeProgress(data.progress));
const momentOf = (e, t0) => (e ? { entry: e.id, t: Number.isFinite(t0) ? t0 : null, date: e.date } : null);
const firstIdea = (stats, sid) => { const st = sid && stats.get(sid); const i = st && st.ideas[0]; return i ? momentOf(i.entry, i.t) : null; };
const lastIdea = (stats, sid) => { const st = sid && stats.get(sid); const i = st && st.ideas[st.ideas.length - 1]; return i ? momentOf(i.entry, i.t) : null; };
const newReview = (kind, from) => (kind === 'done' ? null : { due: from + (kind === 'moved' ? MOVED_DAYS[0] : REVIEW_DAYS[0]) * DAY, step: 0, log: [] });

// What the person had planned, put off or had to decide, so that a video saying it is done is noticed: the to-dos of
// the videos of the last 60 days, and what is still to decide on open subjects. Plans already closed are left out.
// The refs only depend on the data before the video, so the list is the same in the request and when applying it.
function planList(data, upTo) {
  const P = progressOf(data);
  // Plans closed by this same video do not count: analysed again, it can close them again.
  const closed = new Set(P.items.filter((x) => x.plan && !(upTo && x.now && x.now.entry === upTo.id)).map((x) => x.plan));
  const out = new Map();
  const end = upTo ? upTo.date : Date.now();
  const stats = subjectStats(data);
  for (const e of data.entries.filter((x) => x.analysis && x.date >= end - 60 * DAY && x.date < end && (!upTo || x.id !== upTo.id)).sort((a, b) => a.date - b.date)) {
    (e.analysis.a_faire || []).forEach((text, k) => {
      const ref = `t-${e.id}-${k}`;
      if (!closed.has(ref)) out.set(ref, { ref, text, label: `to do, said on ${promptShort(e.date)}`, then: momentOf(e, null), subject: null, subjectTitle: '' });
    });
  }
  for (const s of data.sujets.filter((x) => x.etat !== 'conclu')) {
    (s.a_trancher || []).forEach((text, k) => {
      const ref = `d-${s.id}-${k}`;
      if (!closed.has(ref)) out.set(ref, { ref, text, label: `still to decide on "${s.titre}"`, then: firstIdea(stats, s.id), subject: s.id, subjectTitle: s.titre });
    });
  }
  return out;
}

// For the analysis of a video: what was understood or left behind before (to link), and the plans (to close).
function progressBlock(data, entry) {
  const P = progressOf(data);
  const kindLabel = (x) => (x.kind === 'moved' ? 'left behind' : x.how === 'see' ? 'how to see it' : 'how to act');
  const earlier = P.items.filter((x) => x.status === 'active' && x.kind !== 'done' && (!x.now || x.now.entry !== entry.id)).slice(-60);
  const plans = [...planList(data, entry).values()].slice(-60);
  return [
    '',
    'What the person understood or left behind before (ids in brackets). In "links", say when this video applies one, goes against one, or meets the same kind of situation:',
    earlier.length ? earlier.map((x) => `[${x.id}] (${kindLabel(x)}) ${x.situation ? x.situation + ': ' : ''}${x.text} (${promptShort(x.date)})`).join('\n') : '(nothing yet)',
    '',
    'What they had planned, put off or had to decide (refs in brackets). When this video says one is done or settled, put it in "progress" as done, with since = its ref:',
    plans.length ? plans.map((p) => `[${p.ref}] ${p.text} (${p.label})`).join('\n') : '(nothing)',
  ];
}

// Gemini's answer about progress, for one video: new steps forward, and links to earlier ones. A video analysed
// again replaces what it had given (unless the person has already answered about it or edited it).
function applyProgress(data, e, raw, plans) {
  const P = progressOf(data);
  const stats = subjectStats(data);
  P.items = P.items.filter((it) => !(it.source === 'video' && it.now && it.now.entry === e.id && !(it.review && it.review.log.length) && !it.edited));
  for (const it of P.items) if (it.track) it.track = it.track.filter((x) => x.entry !== e.id);
  let added = 0, linked = 0;
  for (const x of Array.isArray(raw.progress) ? raw.progress : []) {
    const kind = ['done', 'understood', 'moved'].includes(x.kind) ? x.kind : null;
    const text = clean(x.text, 300);
    if (!kind || !text || P.items.some((it) => norm(it.text) === norm(text))) continue;
    const s = findSubject(data, x.subject);
    const plan = x.since ? plans.get(String(x.since).replace(/[[\]\s]/g, '')) : null;
    const sid = s ? s.id : plan ? plan.subject : null;
    let then = plan ? plan.then : firstIdea(stats, sid);
    if (then && then.entry === e.id) then = null; // started and sorted out in the same video
    const t0 = parseT(x.moment);
    P.items.push({
      id: newItemId('x'), kind, text,
      how: kind === 'understood' ? (x.how === 'see' ? 'see' : 'act') : '',
      situation: kind === 'understood' ? clean(x.situation, 200) : '',
      subject: sid, subjectTitle: s ? s.titre : plan ? plan.subjectTitle : '',
      then, now: momentOf(e, t0), date: e.date, at: Date.now(), source: 'video', status: 'active',
      plan: plan ? plan.ref : null, track: [], review: newReview(kind, e.date),
    });
    added++;
  }
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    const it = P.items.find((x) => x.id === String(l.id || '').replace(/[[\]\s]/g, ''));
    if (!it || it.status !== 'active' || it.kind === 'done' || (it.now && it.now.entry === e.id)) continue;
    const effect = ['applied', 'against', 'similar'].includes(l.effect) ? l.effect : 'similar';
    it.track = [...(it.track || []), { entry: e.id, date: e.date, effect, note: clean(l.note, 300), t: parseT(l.moment) }].sort((a, b) => a.date - b.date).slice(-40);
    // A realization that held in a video counts as remembered: it comes back later. One that did not: sooner.
    const days = it.kind === 'moved' ? MOVED_DAYS : REVIEW_DAYS;
    it.review = it.review || newReview(it.kind, e.date);
    if (effect === 'applied' && e.date >= (it.review.lastAt || 0)) { it.review.step = Math.min(days.length - 1, it.review.step + 1); it.review.due = e.date + days[it.review.step] * DAY; it.review.lastAt = e.date; }
    if (effect === 'against') it.review.due = Math.min(it.review.due, Date.now() + DAY);
    linked++;
  }
  return { added, linked };
}

// Concluded subjects are steps forward too ("settled"), with the moment the subject started and the one it was
// concluded. Reopened: the step is put aside. Called before each save.
function syncSettled(data) {
  const P = progressOf(data);
  const stats = subjectStats(data);
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const moved = new Set(P.items.filter((x) => x.kind === 'moved' && x.source === 'fading' && x.status === 'active').map((x) => x.subject));
  for (const s of data.sujets) {
    const it = P.items.find((x) => x.source === 'subject' && x.subject === s.id);
    if (s.etat === 'conclu' && !moved.has(s.id)) {
      const end = s.majPar && byId.get(s.majPar);
      const now = end ? momentOf(end, null) : lastIdea(stats, s.id);
      let then = firstIdea(stats, s.id);
      if (then && now && then.entry === now.entry) then = null; // started and concluded in the same video
      if (!it) {
        P.items.push({ id: newItemId('x'), kind: 'done', settled: true, text: s.conclusion || s.titre, how: '', situation: '', subject: s.id, subjectTitle: s.titre,
          then, now, date: s.majLe || (now && now.date) || Date.now(), at: Date.now(), source: 'subject', status: 'active', track: [], review: null });
      } else {
        // Put aside because the subject was reopened: back with it. Put aside by hand: stays aside.
        if (it.status !== 'active' && it.archivedWhy === 'reopened') { Object.assign(it, { status: 'active', date: s.majLe || it.date, now: now || it.now }); delete it.archivedWhy; }
        if (!it.edited) it.text = s.conclusion || s.titre;
        it.subjectTitle = s.titre;
      }
    } else if (it && it.status === 'active' && s.etat !== 'conclu') Object.assign(it, { status: 'archived', archivedAt: Date.now(), archivedWhy: 'reopened' });
  }
  // A subject merged into another, or deleted: its steps keep the title it had.
  const ids = new Set(data.sujets.map((x) => x.id));
  for (const it of P.items) if (it.subject && !ids.has(it.subject)) it.subject = null;
}

// Subjects that stopped coming up: discussed in 3 videos or more, then not once for 4 weeks while at least 3 videos
// were made. Carnet asks whether they are behind the person (asked again 60 days after "not really").
function fadingSubjects(data, now = Date.now()) {
  const P = progressOf(data);
  const stats = subjectStats(data);
  const analysed = data.entries.filter(hasIdeas);
  return data.sujets.filter((s) => {
    const st = stats.get(s.id);
    if (s.etat === 'conclu' || s.epingle || !st || st.entries.size < 3 || now - st.last < 28 * DAY) return false;
    if (analysed.filter((e) => e.date > st.last).length < 3) return false;
    const a = P.asked[s.id];
    return !a || (a.answer === 'no' && now - a.at > 60 * DAY);
  }).map((s) => ({ id: s.id, titre: s.titre, videos: stats.get(s.id).entries.size, last: stats.get(s.id).last }));
}

// Realizations and things left behind whose time has come to check them again, the oldest first.
function dueItems(data, now = Date.now()) {
  return progressOf(data).items.filter((x) => x.status === 'active' && x.kind !== 'done' && x.review && x.review.due <= now).sort((a, b) => a.review.due - b.review.due);
}

// Where the person stood a month ago on the subjects discussed since, when it is not where they stand now.
function monthAgo(data, now = Date.now()) {
  const at = now - 30 * DAY;
  const stats = subjectStats(data);
  const out = [];
  for (const s of data.sujets) {
    const st = stats.get(s.id);
    if (!st || st.last < at) continue;
    const b = stateBefore(s, at);
    if (!b || b === s || !b.ou_j_en_suis) continue;
    const cur = s.etat === 'conclu' ? s.conclusion || s.ou_j_en_suis : s.ou_j_en_suis;
    if (!cur || norm(cur) === norm(b.ou_j_en_suis)) continue;
    out.push({ id: s.id, titre: s.titre, etat: s.etat, then: b.ou_j_en_suis, thenDate: b.date || null, thenEntry: b.entry || null, now: cur, nowDate: s.majLe || null, nowEntry: s.majPar || null, last: st.last });
  }
  return out.sort((a, b) => b.last - a.last).slice(0, 6);
}

// The daily reminder (a Windows notification): what there is to check, or a step forward to remember. Nothing when
// there is nothing to say.
function reminderText(data, now = Date.now()) {
  const due = dueItems(data, now);
  if (due.length) {
    const x = due[0];
    const body = x.kind === 'moved' ? t('You left behind: {text}. Still behind you?', { text: i18n.quote(x.text) })
      : t('You understood: {text}. Did it hold?', { text: i18n.quote(x.text) });
    return { title: tn(due.length, '{n} thing to remember', '{n} things to remember'), body };
  }
  const lb = lookbackState(data, now);
  if (lb.due) return { title: t('Time to look back'), body: tn(lb.videos, '{n} video since {date}.', '{n} videos since {date}.', { date: shortDay(lb.from) }) };
  const f = fadingSubjects(data, now)[0];
  if (f) return { title: t('Is it behind you?'), body: t('“{title}” has not come up since {date}.', { title: f.titre, date: shortDay(f.last) }) };
  const m = monthAgo(data, now)[0];
  if (m) return { title: t('A month ago'), body: `${m.titre}: ${m.then}`.slice(0, 220) };
  return null;
}

// What the person does on the Progress page and the Remember card.
function progressEdit(data, a, now = Date.now()) {
  const P = progressOf(data);
  const it = a.id ? P.items.find((x) => x.id === a.id) : null;
  switch (a.action) {
    case 'add': {
      const kind = ['done', 'understood', 'moved'].includes(a.kind) ? a.kind : 'understood';
      const text = clean(a.text, 300);
      if (!text || P.items.some((x) => norm(x.text) === norm(text))) break;
      const s = a.subject ? findSubject(data, a.subject) : null;
      P.items.push({ id: newItemId('x'), kind, text, how: kind === 'understood' ? (a.how === 'see' ? 'see' : 'act') : '', situation: kind === 'understood' ? clean(a.situation, 200) : '',
        subject: s ? s.id : null, subjectTitle: s ? s.titre : '', then: null, now: null, date: now, at: now, source: 'manual', status: 'active', track: [], review: newReview(kind, now) });
      break;
    }
    case 'edit':
      if (it) {
        if (clean(a.text, 300)) it.text = clean(a.text, 300);
        if (a.situation !== undefined && it.kind === 'understood') it.situation = clean(a.situation, 200);
        if (a.how && it.kind === 'understood') it.how = a.how === 'see' ? 'see' : 'act';
        it.edited = now;
      }
      break;
    // Remember: "Applied it" / "Forgot it" / "No longer true" (understood), "Still behind me" / "It came back" (moved).
    case 'answer': {
      if (!it || !['applied', 'forgot', 'stale', 'still', 'back'].includes(a.answer)) break;
      const days = it.kind === 'moved' ? MOVED_DAYS : REVIEW_DAYS;
      it.review = it.review || newReview(it.kind === 'done' ? 'understood' : it.kind, now);
      it.review.log = [...(it.review.log || []), { at: now, answer: a.answer }].slice(-40);
      if (a.answer === 'stale' || a.answer === 'back') {
        Object.assign(it, { status: 'archived', archivedAt: now, archivedWhy: a.answer });
        // A subject concluded as "behind you" that came back: open again.
        const s = a.answer === 'back' && it.source === 'fading' && data.sujets.find((x) => x.id === it.subject);
        if (s && s.etat === 'conclu') {
          remember(s, 'toi');
          Object.assign(s, { etat: 'ouvert', conclusion: '', evolution: t('It came back (said on {date}).', { date: shortDay(now) }), majLe: now, majPar: null });
          delete P.asked[s.id];
        }
      } else {
        it.review.step = a.answer === 'forgot' ? Math.max(0, it.review.step - 1) : Math.min(days.length - 1, it.review.step + 1);
        it.review.due = now + (a.answer === 'forgot' ? REVIEW_DAYS[0] : days[it.review.step]) * DAY;
      }
      break;
    }
    case 'archive': if (it) Object.assign(it, { status: 'archived', archivedAt: now, archivedWhy: 'hand' }); break;
    case 'restore': if (it) { it.status = 'active'; delete it.archivedWhy; if (it.review) it.review.due = Math.min(it.review.due || now, now + REVIEW_DAYS[0] * DAY); } break;
    // Look-back: "Not now" puts it off for a week.
    case 'later': P.later = now + 7 * DAY; break;
    case 'delete': if (it && it.source !== 'subject') P.items = P.items.filter((x) => x !== it); break;
    // A subject that stopped coming up: behind the person (it becomes a step forward and the subject is concluded),
    // or not really (asked again in 60 days).
    case 'fading': {
      const s = data.sujets.find((x) => x.id === a.subject);
      if (!s) break;
      P.asked[s.id] = { at: now, answer: a.yes ? 'yes' : 'no' };
      if (!a.yes) break;
      const stats = subjectStats(data);
      const last = lastIdea(stats, s.id);
      P.items.push({ id: newItemId('x'), kind: 'moved', text: s.titre, how: '', situation: '', subject: s.id, subjectTitle: s.titre,
        then: firstIdea(stats, s.id), now: last, date: now, at: now, source: 'fading', status: 'active', track: [], review: newReview('moved', now) });
      remember(s, 'toi');
      Object.assign(s, { etat: 'conclu', conclusion: t('Behind you (said on {date}).', { date: shortDay(now) }), evolution: t('No longer comes up: you said it is behind you.'), majLe: now, majPar: null });
      break;
    }
    default: throw new Error(t('Unknown action.'));
  }
}

// ---------- Look back ----------
// Once a month (or when the person wants), the time since the last look-back: what was done, understood and left
// behind, the subjects then and now, and questions to answer in a video. That video is analysed like the others,
// with the look-back in mind, so what is said is linked to the earlier moments.
function lookbackFrom(data) {
  const P = progressOf(data);
  const last = P.lookbacks.filter((l) => l.done).sort((a, b) => (b.to || b.at) - (a.to || a.at))[0];
  const first = data.entries.filter(hasIdeas).sort((a, b) => a.date - b.date)[0];
  return last ? last.to || last.at : first ? first.date : Date.now();
}
function lookbackMaterial(data, from, to = Date.now()) {
  const P = progressOf(data);
  const inRange = (d) => d >= from && d <= to;
  const items = P.items.filter((x) => x.status === 'active' && inRange(x.date)).sort((a, b) => a.date - b.date);
  const tested = P.items.filter((x) => x.status === 'active' && !inRange(x.date) && (x.track || []).some((k) => inRange(k.date)));
  const entries = data.entries.filter((e) => hasIdeas(e) && inRange(e.date)).sort((a, b) => a.date - b.date);
  const touched = new Set(entries.flatMap((e) => e.analysis.idees.map((i) => i.sujet)).filter(Boolean));
  const subjects = data.sujets.filter((s) => touched.has(s.id) || (s.etat === 'conclu' && inRange(s.majLe || 0))).map((s) => {
    const b = stateBefore(s, from);
    return { id: s.id, titre: s.titre, etat: s.etat, then: b && b !== s ? b.ou_j_en_suis || '' : '', now: s.etat === 'conclu' ? s.conclusion || '' : s.ou_j_en_suis || '' };
  }).filter((x) => x.then || x.now);
  return { from, to, items, tested, entries: entries.map((e) => e.id), subjects };
}
// Shown in "Before you talk" when a month has passed and there is something to look back at, and on the
// Look back page (what happened since, the questions, the look-backs already done).
function lookbackState(data, now = Date.now()) {
  const P = progressOf(data);
  const open = P.lookbacks.find((l) => !l.done) || null;
  const from = open ? open.from : lookbackFrom(data);
  const m = lookbackMaterial(data, from, now);
  const due = !open && now - from >= LOOKBACK_EVERY && m.entries.length >= 3 && now >= (P.later || 0);
  return {
    open, from, due, items: m.items.length, videos: m.entries.length,
    material: { items: m.items.map((x) => x.id), tested: m.tested.map((x) => x.id), entries: m.entries, subjects: m.subjects },
    questions: open && open.questions.length ? open.questions : lookbackDefaultQuestions(data, from),
    done: P.lookbacks.filter((l) => l.done).sort((a, b) => (b.to || b.at) - (a.to || a.at)).slice(0, 12),
  };
}
function lookbackOpen(data, now = Date.now()) {
  const P = progressOf(data);
  let open = P.lookbacks.find((l) => !l.done);
  if (!open) {
    open = { id: newItemId('l'), at: now, from: lookbackFrom(data), to: null, questions: [], entry: null, done: false };
    P.lookbacks.push(open);
    P.lookbacks = P.lookbacks.slice(-24);
  }
  if (!open.questions.length) open.questions = lookbackDefaultQuestions(data, open.from);
  return open;
}
// Questions without Gemini: one per step that can be checked, one per subject that changed, and two general ones.
function lookbackDefaultQuestions(data, from) {
  const m = lookbackMaterial(data, from);
  const q = [];
  for (const x of m.items.filter((i) => i.kind !== 'done').slice(-3)) q.push({ text: t('You understood: {text}. Has it held since? When did it help, and when did you forget it?', { text: i18n.quote(x.text) }), about: x.id });
  for (const s of m.subjects.filter((x) => x.then && x.now && x.then !== x.now).slice(0, 2)) q.push({ text: t('About “{title}”: on {date} you were at “{then}”. How do you see it now?', { title: s.titre, date: shortDay(from), then: s.then.slice(0, 160) }), about: s.id });
  q.push({ text: t('What changed the most since {date}, in what you do or how you see things?', { date: shortDay(from) }), about: '' });
  q.push({ text: t('What still has not moved, and why?'), about: '' });
  return q;
}
function lookbackPrompt(data, l) {
  const m = lookbackMaterial(data, l.from);
  const kind = (x) => (x.kind === 'done' ? (x.settled ? 'settled' : 'done') : x.kind === 'moved' ? 'left behind' : 'understood');
  return [
    `Task: prepare the look-back of the person over the time since ${promptShort(l.from)}, following the instructions: questions that make them compare then and now.`,
    ...profileBlock(data, null),
    '',
    `Steps forward since ${promptShort(l.from)} (ids in brackets):`,
    m.items.map((x) => `[${x.id}] (${kind(x)}) ${x.situation ? x.situation + ': ' : ''}${x.text} · ${promptShort(x.date)}${x.then ? ` · it started on ${promptShort(x.then.date)}` : ''}`).join('\n') || '(none)',
    '', 'Earlier realizations met again in this time (how it went):',
    m.tested.map((x) => `[${x.id}] ${x.text}: ${(x.track || []).filter((k) => k.date >= l.from).map((k) => `${k.effect} on ${promptShort(k.date)}${k.note ? ' (' + k.note + ')' : ''}`).join(' ; ')}`).join('\n') || '(none)',
    '', 'Subjects then and now (ids in brackets):',
    m.subjects.map((s) => `[${s.id}] ${s.titre} (${s.etat === 'conclu' ? 'concluded' : 'open'})\n  Then: ${s.then || '(not started yet)'}\n  Now: ${s.now || '(nothing written)'}`).join('\n') || '(none)',
    '',
    'Answer in JSON: questions (5 to 7, each { text, about: the id of the step or subject it is about, empty if general }).',
  ].join('\n');
}
function applyLookbackQuestions(data, l, raw) {
  const ids = new Set([...progressOf(data).items.map((x) => x.id), ...data.sujets.map((x) => x.id)]);
  const q = (Array.isArray(raw.questions) ? raw.questions : []).map((x) => ({ text: clean(x.text, 400), about: ids.has(String(x.about || '').trim()) ? String(x.about).trim() : '' })).filter((x) => x.text).slice(0, 8);
  if (q.length) { l.questions = q; l.fromGemini = Date.now(); }
  return l;
}
// The video of the look-back has been added to the journal: the look-back is done, up to that video.
function lookbackRecorded(data, intention, entry) {
  const id = String(intention || '').startsWith('lookback:') ? intention.slice(9) : null;
  const l = id && progressOf(data).lookbacks.find((x) => x.id === id);
  if (!l) return;
  Object.assign(l, { entry: entry.id, done: true, to: entry.date });
}
// For the analysis of a look-back video: what it looks back at, and the questions it answers.
function lookbackBlock(data, entry) {
  const id = String(entry.intention || '').startsWith('lookback:') ? entry.intention.slice(9) : null;
  const l = id && progressOf(data).lookbacks.find((x) => x.id === id);
  if (!l) return [];
  return [
    '',
    `This video is a look-back: the person looks back at the time since ${promptShort(l.from)} and answers these questions:`,
    ...l.questions.map((q) => `- ${q.text}`),
    'Link what they say to their earlier realizations and to what they left behind ("links": applied when it held, against when it did not or it came back), and add what they now understand ("progress").',
  ];
}

// ---------- How far you've come ----------
// One request over 3, 6 or 12 months: the person at the start and now, from what they said.
function reportPrompt(data, months, now = Date.now()) {
  const from = now - months * 30.5 * DAY;
  const P = progressOf(data);
  const entries = data.entries.filter((e) => hasIdeas(e) && e.date >= from).sort((a, b) => a.date - b.date);
  // A long period: one video in two, three… so that the request stays a reasonable size (120 videos at most).
  const step = Math.max(1, Math.ceil(entries.length / 120));
  const shown = entries.filter((_, i) => i % step === 0 || i === entries.length - 1);
  const subs = data.sujets.map((s) => ({ s, b: stateBefore(s, from) })).filter(({ s, b }) => (s.majLe || 0) >= from || (b && b !== s));
  const items = P.items.filter((x) => x.status === 'active' && x.date >= from).sort((a, b) => a.date - b.date);
  const prof = profileOf(data);
  const byMonth = new Map();
  for (const e of entries) { const k = monthKey(e.date); if (!byMonth.has(k)) byMonth.set(k, []); if (e.analysis.humeur) byMonth.get(k).push(e.analysis.humeur); }
  return {
    from,
    prompt: [
      `Task: compare the person at the start of the last ${months} months (since ${promptShort(from)}) with now, following the instructions ("How far you've come").`,
      ...profileBlock(data, null),
      '',
      'Their strengths and weaknesses (their own list):',
      [...prof.strengths.map((x) => `- (strength) ${x.text}`), ...prof.weaknesses.map((x) => `- (weakness) ${x.text}`)].join('\n') || '(none)',
      '', 'Steps forward in this time:',
      items.map((x) => `- ${promptShort(x.date)} (${x.kind === 'done' ? (x.settled ? 'settled' : 'done') : x.kind === 'moved' ? 'left behind' : 'understood'}) ${x.text}${x.track && x.track.length ? ` · then ${x.track.map((k) => k.effect).join(', ')}` : ''}`).join('\n') || '(none)',
      '', 'Subjects then and now:',
      subs.map(({ s, b }) => `- ${s.titre} (${s.etat === 'conclu' ? 'concluded' : 'open'})\n  Then: ${b && b !== s ? b.ou_j_en_suis || '(not written)' : '(started in this time)'}\n  Now: ${s.etat === 'conclu' ? s.conclusion || s.ou_j_en_suis : s.ou_j_en_suis || '(not written)'}`).join('\n') || '(none)',
      '', 'Mood, month by month:',
      [...byMonth.entries()].map(([k, list]) => `- ${k}: ${list.join(' ; ')}`).join('\n') || '(not noted)',
      '', `Videos (${shown.length} of ${entries.length}, oldest first):`, '',
      shown.map((e) => `[${e.id}] ${promptShort(e.date)} · ${entryTitle(e)}${e.analysis.resume ? `\n${e.analysis.resume}` : ''}`).join('\n\n') || '(none)',
      '',
      'Answer in JSON: then_now (3 to 5 sentences: how they were then and how they are now), changes ({ text, then, now, videos }), learned, still ({ text, why }: what has not moved), patterns ({ text, videos }: what keeps coming back).',
    ].join('\n'),
  };
}
function applyReport(data, raw, months, from, now = Date.now()) {
  const P = progressOf(data);
  const ids = new Set(data.entries.map((e) => e.id));
  const vids = (x) => strList(x).map((v) => v.replace(/[[\]\s]/g, '')).filter((v) => ids.has(v));
  const r = {
    id: newItemId('r'), at: now, months, from, to: now,
    then_now: clean(raw.then_now, 2000),
    changes: (Array.isArray(raw.changes) ? raw.changes : []).map((c) => ({ text: clean(c.text, 300), then: clean(c.then, 500), now: clean(c.now, 500), videos: vids(c.videos) })).filter((c) => c.text).slice(0, 12),
    learned: strList(raw.learned).map((x) => clean(x, 300)).slice(0, 12),
    still: (Array.isArray(raw.still) ? raw.still : []).map((c) => ({ text: clean(c.text, 300), why: clean(c.why, 500) })).filter((c) => c.text).slice(0, 8),
    patterns: (Array.isArray(raw.patterns) ? raw.patterns : []).map((c) => ({ text: clean(c.text, 300), videos: vids(c.videos) })).filter((c) => c.text).slice(0, 8),
  };
  P.reports.push(r);
  P.reports = P.reports.slice(-12);
  return r;
}

// ---------- Earlier videos ----------
// One request over the cards of the videos (the last 250): the steps forward they contain, each with the reference
// of the idea where it is said and, when it shows, of the idea where it started. For a journal begun before
// progress was followed. What is already noted is left out.
function backfillPrompt(data) {
  const P = progressOf(data);
  const list = data.entries.filter(hasIdeas).sort((a, b) => a.date - b.date).slice(-250);
  const titles = new Map(data.sujets.map((s) => [s.id, s.titre]));
  const cards = list.map((e) => [
    `${promptDay(e.date)} · ${entryTitle(e)}`,
    ...e.analysis.idees.map((i, k) => `- ${e.id}#${k} ${i.sujet && titles.get(i.sujet) ? `(${titles.get(i.sujet)}) ` : ''}${i.texte}`),
    ...(e.analysis.a_faire || []).map((x) => `- to do: ${x}`),
  ].join('\n'));
  const known = P.items.filter((x) => x.status === 'active').map((x) => `- ${x.text}`);
  return [
    'Task: find the steps forward in these journal videos, following the instructions ("Progress"): what the person says they did or settled, understood (how to act, or how to see a situation) or left behind. Each idea has a reference (for example e12ab#3).',
    ...precisionsBlock(data, list),
    ...profileBlock(data, null),
    '',
    `${list.length} video(s), in chronological order:`,
    '',
    cards.join('\n\n'),
    '',
    known.length ? 'Already noted (do not give them again):\n' + known.slice(-150).join('\n') : 'Nothing noted yet.',
    '',
    'Answer in JSON: progress (each { kind: done | understood | moved, text, how: act | see | none, situation, subject: the title of its subject, at: the reference of the idea where it is said, from: the reference of the idea where it started, if it shows; empty otherwise }).',
  ].join('\n');
}
function applyBackfill(data, raw, now = Date.now()) {
  const P = progressOf(data);
  const refs = new Map();
  for (const e of data.entries) ((e.analysis && e.analysis.idees) || []).forEach((i, k) => refs.set(`${e.id}#${k}`, { i, e }));
  const ref = (x) => refs.get(String(x || '').replace(/[[\]\s]/g, ''));
  let added = 0;
  for (const x of Array.isArray(raw.progress) ? raw.progress : []) {
    const kind = ['done', 'understood', 'moved'].includes(x.kind) ? x.kind : null;
    const text = clean(x.text, 300);
    const at = ref(x.at);
    if (!kind || !text || !at || P.items.some((it) => norm(it.text) === norm(text))) continue;
    const from = ref(x.from);
    const s = findSubject(data, x.subject) || (at.i.sujet && data.sujets.find((y) => y.id === at.i.sujet)) || null;
    let then = from && from.e.date <= at.e.date ? momentOf(from.e, from.i.t) : null;
    if (then && then.entry === at.e.id && then.t === at.i.t) then = null;
    // They come back one at a time, every other day, rather than all at once.
    const review = kind === 'done' ? null : { due: now + (REVIEW_DAYS[0] + 2 * added) * DAY, step: 0, log: [] };
    P.items.push({
      id: newItemId('x'), kind, text, how: kind === 'understood' ? (x.how === 'see' ? 'see' : 'act') : '', situation: kind === 'understood' ? clean(x.situation, 200) : '',
      subject: s ? s.id : null, subjectTitle: s ? s.titre : '', then, now: momentOf(at.e, at.i.t), date: at.e.date, at: now, source: 'video', status: 'active',
      plan: null, track: [], review,
    });
    added++;
  }
  P.backfilled = now;
  return added;
}

// ---------- Progress reel ----------
// The moments of the steps forward of a period, oldest first: then (when it started) and now. Steps that have both
// moments first, then the others; 10 steps at most.
function reelPlan(data, from, to, max = 10) {
  const P = progressOf(data);
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const ok = (m) => m && byId.has(m.entry);
  const list = P.items.filter((x) => x.status === 'active' && x.date >= from && x.date <= to && ok(x.now));
  const both = list.filter((x) => ok(x.then)), one = list.filter((x) => !ok(x.then));
  return [...both, ...one].slice(0, max).sort((a, b) => a.date - b.date).map((x) => ({ item: x, then: ok(x.then) ? x.then : null, now: x.now }));
}

// ---------- Requests to Gemini ----------
// The subjects already in the journal, so that Gemini links the video to the right threads.
function subjectsBlock(data) {
  if (!data.sujets.length) return 'Subjects already in the journal: none yet.';
  const stats = subjectStats(data);
  const last = (s) => (stats.get(s.id) || {}).last || 0;
  const open = sortedSubjects(data, stats).filter((s) => s.etat !== 'conclu').slice(0, 80);
  const done = sortedSubjects(data, stats).filter((s) => s.etat === 'conclu').slice(0, 40);
  const L = ['Subjects already in the journal (when the video talks about one, use exactly its id and title):'];
  for (const s of open) {
    L.push(`[${s.id}] ${s.titre}${s.categorie ? ' · ' + s.categorie : ''} · open · discussed ${stats.get(s.id).entries.size} time(s), last on ${promptShort(last(s))}`);
    if (s.ou_j_en_suis) L.push(`   Where they're at: ${s.ou_j_en_suis}`);
    const before = (s.historique || []).filter((x) => !x.titre && x.ou_j_en_suis && x.ou_j_en_suis !== s.ou_j_en_suis).pop();
    if (before) L.push(`   Before (${promptShort(before.date)}): ${before.ou_j_en_suis.slice(0, 400)}`);
    if (s.a_trancher.length) L.push(`   Still to decide: ${s.a_trancher.join(' ; ')}`);
  }
  if (done.length) {
    L.push('', 'Concluded subjects (to reopen if the person comes back to them):');
    for (const s of done) L.push(`[${s.id}] ${s.titre} · concluded: ${s.conclusion || 'no detail'}`);
  }
  return L.join('\n');
}

// ---------- Clarifications from the person ----------
// What the person adds to clear up a misunderstanding: who is who, a misheard word, the context.
// Scope "journal": sent with every analysis and every summary. Scope "video": only when that video is concerned.
function precisionsBlock(data, entries, { markNew = false } = {}) {
  const ids = new Set((entries || []).map((e) => e.id));
  const list = (data.precisions || []).filter((p) => p.portee === 'journal' || (p.entry && ids.has(p.entry)));
  if (!list.length) return [];
  const label = (p) => {
    if (p.portee === 'journal') return '';
    const e = data.entries.find((x) => x.id === p.entry);
    return e ? `(video of ${promptShort(e.date)} · ${entryTitle(e)}) ` : '';
  };
  return [
    '',
    'Clarifications given by the person (always true: they come before the transcript and before what was written so far):',
    ...list.map((p) => `- ${label(p)}${p.texte}${markNew && !p.appliquee ? ' (new)' : ''}`),
  ];
}

function entryContext(data, entry) {
  const want = entry.intention && findSubject(data, entry.intention);
  return [
    `Date: ${promptDay(entry.date)}`,
    `Length: ${fmtT(entry.duration)}`,
    entry.title ? `Title given by the person: ${entry.title}` : null,
    entry.chapters && entry.chapters.length ? `Chapters set by the person: ${entry.chapters.map((c) => `${fmtT(c.t)} ${c.title}`).join(' ; ')}` : null,
    want ? `Before recording, the person chose to talk about: [${want.id}] ${want.titre}` : null,
    ...precisionsBlock(data, [entry]),
    '',
    subjectsBlock(data),
    ...profileBlock(data, entry),
    ...progressBlock(data, entry),
    ...lookbackBlock(data, entry),
  ];
}
const ENTRY_ANSWER = 'Answer in JSON: titre, resume, idees (every idea, each { texte, moment as m:ss, sujet: the title of the subject it belongs to, as written in the sujets list }), sujets (each subject discussed in this video, existing or new: { id: its id if it already exists, empty otherwise, titre, categorie, evolution: what this video changes compared with before, ou_j_en_suis, a_trancher, pistes, etat, conclusion }), humeur, personnes, a_faire, citation, profile (changes to what is known about the person: { action: add | update | remove, id, text }; empty if the video says nothing new about them), progress (only what the person says this video: { kind: done | understood | moved, text, how: act | see | none, situation, subject: the title of its subject, moment as m:ss, since: the ref of the plan it closes, if any }), links (earlier realizations or things left behind that this video meets: { id, effect: applied | against | similar, note, moment as m:ss }).';

function entryPrompt(data, entry) {
  const lines = (entry.transcript.segments || []).map((s) => `[${fmtT(s.from)}] ${s.text}`).join('\n');
  return [
    'Task: write the card of this journal video and update its subjects, following the instructions.',
    '',
    ...entryContext(data, entry),
    '',
    'Automatic transcript, with times:',
    lines || '(no speech detected)',
    '',
    ENTRY_ANSWER,
  ].filter((x) => x !== null).join('\n');
}

// Same request, but Gemini receives the sound of the video and also writes the transcript.
function entryAudioPrompt(data, entry) {
  return [
    'Task: the attached sound is a journal video. Transcribe it, then write the card of the video and update its subjects, following the instructions.',
    '',
    ...entryContext(data, entry),
    '',
    'Transcript: word for word, exactly what is said, in order, in the language spoken. Keep hesitations (um, er, like), repetitions, sentences left unfinished, slang, words from other languages and grammar mistakes as they are said. Rephrase nothing, correct nothing, summarise nothing, skip nothing. Only add punctuation. Split into sentences or short passages; for each passage, debut = the moment it starts in the sound, as m:ss (or h:mm:ss). If nothing is said, return an empty list.',
    '',
    ENTRY_ANSWER.replace('Answer in JSON: ', 'Answer in JSON: transcription (list of { debut, texte }), '),
  ].filter((x) => x !== null).join('\n');
}

// Transcript returned by Gemini -> segments { from, to, text } like whisper's.
function segmentsFromGemini(list, duration) {
  const raw = (Array.isArray(list) ? list : [])
    .map((x) => ({ from: parseT(x.debut), text: String(x.texte || '').replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.text);
  // Missing or out-of-order moments: the text order is kept and the previous moment reused.
  let last = 0;
  for (const x of raw) { if (x.from === null || x.from < last) x.from = last; last = x.from; }
  return raw.map((x, i) => ({ from: x.from, to: i + 1 < raw.length ? Math.max(x.from, raw[i + 1].from) : Math.max(x.from, duration || x.from), text: x.text }));
}

// State of a subject as returned by Gemini.
function normalizeSubject(s) {
  const etat = /^(conclu|concluded|closed|done)/.test(norm(s.etat)) ? 'conclu' : 'ouvert';
  return {
    id: String(s.id || '').replace(/[[\]\s]/g, ''),
    titre: String(s.titre || '').trim().replace(/\.$/, ''),
    categorie: String(s.categorie || '').trim().toLowerCase().replace(/^#/, ''),
    ou_j_en_suis: String(s.ou_j_en_suis || '').trim(),
    evolution: String(s.evolution || '').trim(),
    a_trancher: strList(s.a_trancher),
    pistes: strList(s.pistes),
    etat,
    conclusion: etat === 'conclu' ? String(s.conclusion || '').trim() : '',
  };
}

// Minimal card (video without speech).
const emptyAnalysis = (titre) => ({ titre: titre || t('No speech'), resume: '', idees: [], humeur: '', personnes: [], a_faire: [], citation: '' });

// Applies Gemini's answer to an entry: card, ideas linked to subjects, subjects and profile updated.
function applyEntryAnalysis(data, e, raw, meta = {}) {
  const plans = planList(data, e); // before the subjects change: the refs given in the request
  const keys = new Map(); // normalised title or id returned by Gemini -> subject
  const evolutions = []; // what the video changes, subject by subject
  for (const m of (Array.isArray(raw.sujets) ? raw.sujets : []).map(normalizeSubject)) {
    let s = (m.id && data.sujets.find((x) => x.id === m.id)) || findSubject(data, m.titre);
    if (!s) {
      if (!m.titre) continue;
      s = newSubject(m.titre, m.categorie, e.date);
      data.sujets.push(s);
    }
    // The state is only rewritten by a video at least as recent as the one that wrote it
    // (old videos imported afterwards only add their ideas to the thread).
    if (e.date >= (s.majLe || 0)) {
      if (s.majPar !== e.id) remember(s, 'video');
      if (m.ou_j_en_suis) s.ou_j_en_suis = m.ou_j_en_suis;
      s.evolution = m.evolution;
      if (m.evolution) evolutions.push({ sujet: s.id, texte: m.evolution });
      s.a_trancher = m.a_trancher;
      s.pistes = m.pistes;
      s.etat = m.etat;
      s.conclusion = m.conclusion;
      s.majLe = e.date;
      s.majPar = e.id;
      s.majSource = 'video';
    }
    if (!s.categorie && m.categorie) s.categorie = m.categorie;
    if (m.titre) keys.set(norm(m.titre), s);
    if (m.id) keys.set(m.id, s);
  }
  const idees = (Array.isArray(raw.idees) ? raw.idees : []).map((i) => {
    const ref = String(i.sujet || '').trim();
    let s = keys.get(ref.replace(/[[\]\s]/g, '')) || keys.get(norm(ref)) || findSubject(data, ref);
    if (!s && ref) { s = newSubject(ref, '', e.date); data.sujets.push(s); keys.set(norm(ref), s); }
    return { texte: String(i.texte || '').trim(), t: parseT(i.moment), sujet: s ? s.id : null };
  }).filter((i) => i.texte);
  e.analysis = {
    titre: String(raw.titre || '').trim().replace(/\.$/, '') || e.title || t('Untitled'),
    resume: String(raw.resume || '').trim(),
    idees,
    evolutions,
    humeur: String(raw.humeur || '').trim(),
    personnes: strList(raw.personnes),
    a_faire: strList(raw.a_faire),
    citation: String(raw.citation || '').trim().replace(/^["«“„\s]+|["»”“\s]+$/g, ''),
    ...meta,
  };
  // What the person said about themselves: only from a video at least as recent as the last profile change it
  // could contradict (an old video analysed again does not undo what a newer one said).
  if (Array.isArray(raw.profile) && raw.profile.length) {
    const p = profileOf(data);
    const newest = Math.max(0, ...p.facts.filter((f) => f.entry).map((f) => (data.entries.find((x) => x.id === f.entry) || {}).date || 0));
    const ops = e.date >= newest ? raw.profile : raw.profile.filter((op) => String(op.action || '').toLowerCase() === 'add');
    e.analysis.profileChanges = applyProfileOps(data, e, ops);
  }
  pruneSubjects(data);
  // Steps forward said in this video, and links to earlier ones.
  const pr = applyProgress(data, e, raw, plans);
  e.analysis.progressAdded = pr.added;
  e.analysis.progressLinks = pr.linked;
  return e.analysis;
}

// Reorganisation: Gemini reads all the ideas of the journal again and rebuilds the list of subjects.
// Used to build the subjects of an old journal, and to tidy up (duplicates, subjects that are too broad).
function rebuildPrompt(data) {
  const list = data.entries.filter(hasIdeas).sort((a, b) => a.date - b.date);
  const cards = list.map((e) => [
    `${promptDay(e.date)} · ${entryTitle(e)}`,
    e.analysis.resume ? `Summary: ${e.analysis.resume}` : null,
    ...e.analysis.idees.map((i, k) => `- ${e.id}#${k} ${i.texte}`),
  ].filter(Boolean).join('\n'));
  const cur = data.sujets.map((s) => `- ${s.titre}${s.etat === 'conclu' ? ' (concluded)' : ''}`);
  return [
    'Task: reorganise the subjects of the journal, following the instructions. Each idea below has a reference (for example e12ab#3): put each idea in one subject.',
    ...precisionsBlock(data, list),
    `${list.length} video(s), in chronological order:`,
    '',
    cards.join('\n\n'),
    '',
    cur.length ? 'Current subjects (keep their title when it fits):\n' + cur.join('\n') : 'No subjects yet.',
    '',
    'Answer in JSON: sujets (each { titre, categorie, idees: the references of the ideas of the subject, ou_j_en_suis, a_trancher, pistes, etat, conclusion }).',
  ].join('\n');
}
function applyRebuild(data, raw) {
  const refs = new Map();
  for (const e of data.entries) (e.analysis && e.analysis.idees || []).forEach((i, k) => refs.set(`${e.id}#${k}`, { i, e }));
  const old = data.sujets;
  data.sujets = [];
  for (const { i } of refs.values()) i.sujet = null;
  for (const r of Array.isArray(raw.sujets) ? raw.sujets : []) {
    const m = normalizeSubject(r);
    if (!m.titre) continue;
    const prev = old.find((x) => norm(x.titre) === norm(m.titre));
    const s = { ...newSubject(m.titre, m.categorie), ...m, id: prev ? prev.id : newSubjectId(), epingle: !!(prev && prev.epingle) };
    // The state before the reorganisation stays in the history.
    if (prev) { const p = { ...prev, historique: [...(prev.historique || [])] }; remember(p, 'reorganisation'); s.historique = p.historique; }
    let last = 0, first = Infinity;
    for (const ref of strList(r.idees)) {
      const x = refs.get(ref.replace(/[[\]\s]/g, ''));
      if (!x || x.i.sujet) continue;
      x.i.sujet = s.id;
      last = Math.max(last, x.e.date);
      first = Math.min(first, x.e.date);
    }
    s.majLe = last;
    s.majSource = 'reorganisation';
    s.evolution = '';
    s.cree = first === Infinity ? Date.now() : first;
    data.sujets.push(s);
  }
  data.rebuild = false;
  pruneSubjects(data);
}

// ---------- Summary of a period ----------
const PERIODS = { jours7: 'Last 7 days', videos7: 'Last 7 videos', mois: 'This month' };
const periodLabel = (k) => (PERIODS[k] ? t(PERIODS[k]) : k);
function periodEntries(data, period, now = Date.now()) {
  const done = data.entries.filter((e) => e.analysis).sort((a, b) => a.date - b.date);
  if (period === 'videos7') return done.slice(-7);
  if (period === 'mois') return done.filter((e) => monthKey(e.date) === monthKey(now));
  return done.filter((e) => e.date >= now - 7 * DAY);
}
function bilanPrompt(data, period, now = Date.now()) {
  const list = periodEntries(data, period, now);
  return [
    `Task: write the summary of the period "${PERIODS[period] || period}", following the instructions.`,
    ...periodBlock(data, list, now),
    '',
    'Answer in JSON: en_bref, avance (list of { sujet, texte }), en_suspens (list of { sujet, texte }), contradictions, a_dire.',
  ].join('\n');
}
// Videos of a period, state of the subjects discussed (at the start and now), open subjects not discussed.
function periodBlock(data, list, now) {
  const sub = (id) => data.sujets.find((s) => s.id === id);
  const cards = list.map((e) => [
    `${promptDay(e.date)} · ${entryTitle(e)}`,
    e.analysis.resume ? `Summary: ${e.analysis.resume}` : null,
    ...e.analysis.idees.map((i) => `- (${sub(i.sujet) ? sub(i.sujet).titre : 'no subject'}) ${i.texte}`),
    e.analysis.a_faire.length ? `To do: ${e.analysis.a_faire.join(' ; ')}` : null,
  ].filter(Boolean).join('\n'));
  const touched = new Set(list.flatMap((e) => e.analysis.idees.map((i) => i.sujet)).filter(Boolean));
  const stats = subjectStats(data);
  const start = list.length ? list[0].date : now;
  const state = data.sujets.filter((s) => touched.has(s.id)).map((s) => [
    `- ${s.titre} (${s.etat === 'conclu' ? 'concluded' : 'open'})`,
    (() => { const b = stateBefore(s, start); return b && b !== s && b.ou_j_en_suis ? `  At the start of the period: ${b.ou_j_en_suis}` : null; })(),
    s.ou_j_en_suis ? `  Where they're at: ${s.ou_j_en_suis}` : null,
    s.a_trancher.length ? `  Still to decide: ${s.a_trancher.join(' ; ')}` : null,
    s.conclusion ? `  Conclusion: ${s.conclusion}` : null,
  ].filter(Boolean).join('\n'));
  const asleep = sortedSubjects(data, stats).filter((s) => s.etat !== 'conclu' && !touched.has(s.id)).slice(0, 30)
    .map((s) => `- ${s.titre} (last time on ${promptShort(stats.get(s.id).last)})`);
  return [
    ...precisionsBlock(data, list),
    `${list.length} video(s), in chronological order:`,
    '',
    cards.join('\n\n'),
    '',
    'State of the subjects discussed during the period:',
    state.join('\n') || '(none)',
    '',
    'Open subjects that were not discussed during the period:',
    asleep.join('\n') || '(none)',
  ];
}
function normalizeBilan(raw, data, period, now = Date.now()) {
  const list = periodEntries(data, period, now);
  const items = (x) => (Array.isArray(x) ? x : []).map((it) => {
    const s = findSubject(data, it.sujet);
    return { sujet: s ? s.id : null, titre: s ? s.titre : String(it.sujet || '').trim(), texte: String(it.texte || '').trim() };
  }).filter((it) => it.texte);
  return {
    id: 'b' + now.toString(36), period, label: periodLabel(period), at: now,
    from: list.length ? list[0].date : now, to: list.length ? list[list.length - 1].date : now, n: list.length,
    entries: list.map((e) => e.id),
    en_bref: String(raw.en_bref || '').trim(),
    avance: items(raw.avance),
    en_suspens: items(raw.en_suspens),
    contradictions: strList(raw.contradictions),
    a_dire: strList(raw.a_dire),
  };
}

// ---------- Summary of each week (Monday to Sunday) ----------
// Each week is compared with the previous one: what moved, and what had been planned.
function weekStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
const weekKey = (ts) => { const d = new Date(weekStart(ts)); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const weekFrom = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const weekTo = (key) => { const d = new Date(weekFrom(key)); d.setDate(d.getDate() + 7); return d.getTime() - 1; };
const weekLabel = (key) => t('Week of {from} to {to}', { from: shortDay(weekFrom(key)), to: shortDay(weekTo(key)) });
const weekEntries = (data, key) => data.entries.filter((e) => e.analysis && weekKey(e.date) === key).sort((a, b) => a.date - b.date);
// Weeks that have at least one analysed video with ideas, oldest first.
const weeksWithVideos = (data) => [...new Set(data.entries.filter(hasIdeas).map((e) => weekKey(e.date)))].sort();
// Summary of the previous week that has videos (a week without videos is skipped).
function previousWeekly(data, key) {
  const k = Object.keys(data.semaines || {}).filter((x) => x < key).sort().pop();
  return k ? data.semaines[k] : null;
}
function weeklyPrompt(data, key, now = Date.now()) {
  const list = weekEntries(data, key);
  const prev = previousWeekly(data, key);
  const sub = (id) => (data.sujets.find((s) => s.id === id) || {}).titre;
  const items = (arr) => arr.map((it) => `- ${it.sujet && sub(it.sujet) ? sub(it.sujet) + ': ' : it.titre ? it.titre + ': ' : ''}${it.texte}`).join('\n');
  const span = (k) => `the week of ${promptShort(weekFrom(k))} to ${promptShort(weekTo(k))}`;
  const prevBlock = prev ? [
    `Summary of the previous week (${span(prev.key)}${weekFrom(key) - weekFrom(prev.key) > 8 * DAY ? ', ' + Math.round((weekFrom(key) - weekFrom(prev.key)) / (7 * DAY)) + ' weeks ago' : ''}):`,
    prev.en_bref ? `In short: ${prev.en_bref}` : null,
    prev.avance.length ? 'What had moved forward:\n' + items(prev.avance) : null,
    prev.en_suspens.length ? 'What had been left hanging:\n' + items(prev.en_suspens) : null,
    prev.a_dire.length ? 'What was planned for this week:\n' + prev.a_dire.map((x) => `- ${x}`).join('\n') : null,
  ].filter(Boolean) : ['No summary for a previous week: this is the first week of the journal.'];
  const done = now > weekTo(key);
  return [
    `Task: write the summary of ${span(key)}${done ? '' : ' (current week, not finished yet)'}, and compare it with the previous week, following the instructions.`,
    '',
    ...prevBlock,
    '',
    'This week:',
    ...periodBlock(data, list, now),
    '',
    'Answer in JSON: evolution_semaine, suivi, en_bref, avance (list of { sujet, texte }), en_suspens (list of { sujet, texte }), contradictions, a_dire.',
  ].join('\n');
}
function normalizeWeekly(raw, data, key, now = Date.now()) {
  const list = weekEntries(data, key);
  const b = normalizeBilan(raw, data, 'jours7', now);
  const prev = previousWeekly(data, key);
  return {
    ...b, key, id: 'w' + key, label: weekLabel(key), period: 'semaine',
    from: weekFrom(key), to: weekTo(key), n: list.length, entries: list.map((e) => e.id),
    enCours: now <= weekTo(key),
    precedente: prev ? prev.key : null,
    evolution_semaine: String(raw.evolution_semaine || '').trim(),
    suivi: strList(raw.suivi),
  };
}
// Next finished week without a summary (oldest first, since each summary builds on the previous one).
function nextWeekToDo(data, now = Date.now()) {
  return weeksWithVideos(data).find((k) => weekTo(k) < now && (!data.semaines[k] || data.semaines[k].enCours)) || null;
}

// ---------- Applying the clarifications to the whole journal ----------
// One call: Gemini reads everything written so far (cards, subjects, summaries, weeks, profile) with the
// clarifications, and returns only what changes, rewritten. Two subjects that are actually the same are merged.
function correctionPrompt(data) {
  const done = data.entries.filter((e) => e.analysis).sort((a, b) => a.date - b.date);
  const sub = (id) => (data.sujets.find((s) => s.id === id) || {}).titre;
  const items = (arr) => arr.map((it) => `  - ${it.sujet && sub(it.sujet) ? sub(it.sujet) + ': ' : it.titre ? it.titre + ': ' : ''}${it.texte}`).join('\n');
  const fiches = done.map((e) => [
    `[${e.id}] ${promptDay(e.date)} · ${entryTitle(e)}`,
    e.analysis.resume ? `Summary: ${e.analysis.resume}` : null,
    (e.analysis.personnes || []).length ? `People: ${e.analysis.personnes.join(', ')}` : null,
    ...e.analysis.idees.map((i, k) => `- ${e.id}#${k} (${sub(i.sujet) || 'no subject'}) ${i.texte}`),
  ].filter(Boolean).join('\n'));
  const sujets = data.sujets.map((s) => [
    `[${s.id}] ${s.titre}${s.categorie ? ' · ' + s.categorie : ''} · ${s.etat === 'conclu' ? 'concluded' : 'open'}`,
    s.evolution ? `  Last change: ${s.evolution}` : null,
    s.ou_j_en_suis ? `  Where they're at: ${s.ou_j_en_suis}` : null,
    s.a_trancher.length ? `  Still to decide: ${s.a_trancher.join(' ; ')}` : null,
    s.pistes.length ? `  Leads: ${s.pistes.join(' ; ')}` : null,
    s.conclusion ? `  Conclusion: ${s.conclusion}` : null,
  ].filter(Boolean).join('\n'));
  const bilan = (b, title) => [
    `[${b.id}] ${title}`,
    b.evolution_semaine ? `  Compared with the week before: ${b.evolution_semaine}` : null,
    (b.suivi || []).length ? `  Follow-up: ${b.suivi.join(' ; ')}` : null,
    b.en_bref ? `  In short: ${b.en_bref}` : null,
    b.avance.length ? '  What moved forward:\n' + items(b.avance) : null,
    b.en_suspens.length ? '  Left hanging:\n' + items(b.en_suspens) : null,
    b.contradictions.length ? `  To clarify: ${b.contradictions.join(' ; ')}` : null,
    b.a_dire.length ? `  Next: ${b.a_dire.join(' ; ')}` : null,
  ].filter(Boolean).join('\n');
  const bilans = [
    ...Object.values(data.semaines || {}).sort((a, b) => a.from - b.from).map((w) => bilan(w, `week of ${promptShort(w.from)} to ${promptShort(w.to)}`)),
    ...data.bilans.map((b) => bilan(b, `${PERIODS[b.period] || b.label}, from ${promptShort(b.from)} to ${promptShort(b.to)}`)),
  ];
  const p = profileOf(data);
  return [
    'Task: apply the person\'s clarifications to the whole journal, following the instructions. Return only what changes.',
    ...precisionsBlock(data, done, { markNew: true }),
    '',
    `Video cards (${done.length}):`, '', fiches.join('\n\n') || '(none)',
    '', `Subjects (${data.sujets.length}):`, '', sujets.join('\n\n') || '(none)',
    '', `Summaries (${bilans.length}):`, '', bilans.join('\n\n') || '(none)',
    '', `About the person (${p.facts.length}):`, '', p.facts.map((f) => `[${f.id}] ${f.text}`).join('\n') || '(none)',
    '',
    'Answer in JSON: fiches (only those that change: { id, titre, resume, personnes, idees: only the ideas that change, { ref, texte } }), sujets (only those that change: { id, titre, evolution, ou_j_en_suis, a_trancher, pistes, conclusion }), bilans (only those that change: { id, evolution_semaine, suivi, en_bref, avance, en_suspens, contradictions, a_dire }), fusions (subjects that are actually the same: { de, vers }), profile (facts about the person that change: { id, text }). An empty or missing field = unchanged.',
  ].join('\n');
}
function applyCorrections(data, raw) {
  const n = { fiches: 0, idees: 0, sujets: 0, bilans: 0, fusions: 0, profile: 0 };
  const txt = (x) => String(x || '').trim();
  for (const f of Array.isArray(raw.fiches) ? raw.fiches : []) {
    const e = data.entries.find((x) => x.id === txt(f.id).replace(/[[\]]/g, ''));
    if (!e || !e.analysis) continue;
    let changed = false;
    if (txt(f.titre)) { e.analysis.titre = txt(f.titre).replace(/\.$/, ''); changed = true; }
    if (txt(f.resume)) { e.analysis.resume = txt(f.resume); changed = true; }
    if (strList(f.personnes).length) { e.analysis.personnes = strList(f.personnes); changed = true; }
    for (const i of Array.isArray(f.idees) ? f.idees : []) {
      const m = /#(\d+)$/.exec(txt(i.ref));
      const idea = m && e.analysis.idees[Number(m[1])];
      if (idea && txt(i.texte)) { idea.texte = txt(i.texte); n.idees++; changed = true; }
    }
    if (changed) { e.analysis.corrige = Date.now(); n.fiches++; }
  }
  // Merges first: the corrected state returned for the remaining subject then replaces that of the merge.
  for (const f of Array.isArray(raw.fusions) ? raw.fusions : []) {
    const a = findSubject(data, txt(f.de)), b = findSubject(data, txt(f.vers));
    if (a && b && a !== b && mergeSubjects(data, a.id, b.id)) {
      // Summaries that mentioned the merged subject point to the remaining one.
      for (const bl of [...data.bilans, ...Object.values(data.semaines || {})]) for (const it of [...bl.avance, ...bl.en_suspens]) if (it.sujet === a.id) it.sujet = b.id;
      n.fusions++;
    }
  }
  for (const c of Array.isArray(raw.sujets) ? raw.sujets : []) {
    const s = data.sujets.find((x) => x.id === txt(c.id).replace(/[[\]]/g, ''));
    if (!s) continue;
    const before = JSON.stringify([s.titre, s.evolution, s.ou_j_en_suis, s.a_trancher, s.pistes, s.conclusion]);
    if (txt(c.ou_j_en_suis) && txt(c.ou_j_en_suis) !== s.ou_j_en_suis) remember(s, 'precision');
    if (txt(c.titre)) s.titre = txt(c.titre).replace(/\.$/, '');
    if (txt(c.evolution)) s.evolution = txt(c.evolution);
    if (txt(c.ou_j_en_suis)) s.ou_j_en_suis = txt(c.ou_j_en_suis);
    if (strList(c.a_trancher).length) s.a_trancher = strList(c.a_trancher);
    if (strList(c.pistes).length) s.pistes = strList(c.pistes);
    if (txt(c.conclusion) && s.etat === 'conclu') s.conclusion = txt(c.conclusion);
    if (JSON.stringify([s.titre, s.evolution, s.ou_j_en_suis, s.a_trancher, s.pistes, s.conclusion]) !== before) { s.majSource = 'precision'; n.sujets++; }
  }
  const mapItems = (x) => (Array.isArray(x) ? x : []).map((it) => {
    const s = findSubject(data, it.sujet);
    return { sujet: s ? s.id : null, titre: s ? s.titre : txt(it.sujet), texte: txt(it.texte) };
  }).filter((it) => it.texte);
  for (const c of Array.isArray(raw.bilans) ? raw.bilans : []) {
    const id = txt(c.id).replace(/[[\]]/g, '');
    const b = data.bilans.find((x) => x.id === id) || Object.values(data.semaines || {}).find((w) => w.id === id);
    if (!b) continue;
    let changed = false;
    for (const k of ['en_bref', 'evolution_semaine']) if (txt(c[k]) && (k in b || k === 'en_bref')) { b[k] = txt(c[k]); changed = true; }
    for (const k of ['suivi', 'contradictions', 'a_dire']) if (strList(c[k]).length && (k in b)) { b[k] = strList(c[k]); changed = true; }
    for (const k of ['avance', 'en_suspens']) if (mapItems(c[k]).length) { b[k] = mapItems(c[k]); changed = true; }
    if (changed) { b.corrige = Date.now(); n.bilans++; }
  }
  const p = profileOf(data);
  for (const c of Array.isArray(raw.profile) ? raw.profile : []) {
    const f = p.facts.find((x) => x.id === txt(c.id).replace(/[[\]]/g, ''));
    if (f && txt(c.text) && txt(c.text) !== f.text) {
      f.history = [...(f.history || []), { text: f.text, at: f.at, entry: f.entry || null, source: f.source }].slice(-10);
      f.text = clean(c.text);
      f.at = Date.now();
      n.profile++;
    }
  }
  for (const pr of data.precisions || []) { pr.appliquee = true; pr.appliqueeLe = Date.now(); }
  return n;
}

// ---------- Markdown ----------
// Markdown link to a file of the folder (relative path, possibly in a subfolder).
const link = (file) => String(file).split('/').map((x) => encodeURIComponent(x).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');
const entryTitle = (e) => (e.analysis && e.analysis.titre) || e.title || t('Untitled');
const transcriptName = (e) => path.parse(e.file).name + '.md';
const anchor = (x) => norm(x).replace(/ /g, '-');

function writeTranscript(dir, e) {
  if (!e.transcript) return;
  const L = [`# ${entryTitle(e)}`, '', `${dayLabel(e.date)} · ${fmtT(e.duration)} · [${t('Open the video')}](../${link(e.file)})`, ''];
  const secs = sections(e.transcript.segments || [], e.chapters || []);
  if (!secs.length) L.push(`_${t('No speech detected.')}_`);
  for (const s of secs) { L.push(`**${s.title ? s.title + ' · ' : ''}${fmtT(s.t)}**`, '', s.text, ''); }
  fs.mkdirSync(path.join(dir, TRANSCRIPTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, TRANSCRIPTS_DIR, transcriptName(e)), L.join('\n'), 'utf8');
}

function profileMarkdown(data, L) {
  const p = profileOf(data);
  if (!p.facts.length && !p.strengths.length && !p.weaknesses.length) return;
  L.push(`## ${t('You')}`, '');
  if (p.facts.length) L.push(`**${t('About you')}**`, '', ...p.facts.map((f) => `- ${f.text}`), '');
  if (p.strengths.length) L.push(`**${t('Strengths')}**`, '', ...p.strengths.map((x) => `- ${x.text}`), '');
  if (p.weaknesses.length) L.push(`**${t('Weaknesses')}**`, '', ...p.weaknesses.map((x) => `- ${x.text}`), '');
  if (p.check && p.check.items.length) {
    const all = new Map([...p.strengths, ...p.weaknesses].map((x) => [x.id, x.text]));
    const st = { shows: t('shows'), changing: t('changing'), not_seen: t('not in recent videos') };
    L.push(`**${t('Where you’re at')}** _(${dayLabel(p.check.at)})_`, '', ...p.check.items.filter((x) => all.has(x.id)).map((x) => `- ${all.get(x.id)} (${st[x.status]}): ${x.note}`), '');
  }
}

// Progress, month by month: what was done, understood and left behind, with the moments then and now.
// Name of the kind of a step forward, as shown everywhere (page, Journal.md, reel).
const kindLabel = (x) => (x.kind === 'done' ? (x.settled ? t('Settled') : t('Done')) : x.kind === 'moved' ? t('Moved past') : x.how === 'see' ? t('Understood (how to see it)') : t('Understood (how to act)'));
function progressMarkdown(data, L) {
  const P = progressOf(data);
  const items = P.items.filter((x) => x.status === 'active').sort((a, b) => b.date - a.date);
  if (!items.length) return;
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const at = (m, label) => { const e = m && byId.get(m.entry); return e ? `[${label} ${shortDay(e.date)}${m.t !== null && m.t !== undefined ? ' · ' + fmtT(m.t) : ''}](${momentLink(e, m.t)})` : null; };
  const kind = kindLabel;
  const count = (x, eff) => (x.track || []).filter((k) => k.effect === eff).length + ((x.review && x.review.log) || []).filter((k) => k.answer === eff || (eff === 'against' && k.answer === 'forgot')).length;
  L.push(`## ${t('Progress')}`, '');
  for (const k of [...new Set(items.map((x) => monthKey(x.date)))]) {
    L.push(`### ${monthLabel(k)}`, '');
    for (const x of items.filter((i) => monthKey(i.date) === k)) {
      const links = [at(x.then, t('then')), at(x.now, t('now'))].filter(Boolean).join(' · ');
      const ap = count(x, 'applied'), ag = count(x, 'against');
      const track = x.kind === 'understood' && (ap || ag) ? ` _(${[ap && tn(ap, 'applied {n} time', 'applied {n} times'), ag && tn(ag, 'forgotten {n} time', 'forgotten {n} times')].filter(Boolean).join(', ')})_` : '';
      L.push(`- **${kind(x)}**: ${x.situation ? x.situation + ': ' : ''}${x.text}${x.subjectTitle ? ` (${x.subjectTitle})` : ''}${track}${links ? ' · ' + links : ''}`);
    }
    L.push('');
  }
}

function renderMarkdown(data) {
  const entries = [...data.entries].sort((a, b) => b.date - a.date);
  const stats = subjectStats(data);
  const subs = sortedSubjects(data, stats);
  const open = subs.filter((s) => s.etat !== 'conclu'), done = subs.filter((s) => s.etat === 'conclu');
  const bilan = data.bilans[data.bilans.length - 1];
  const months = [...new Set(entries.map((e) => monthKey(e.date)))];
  const subTitle = (id) => { const s = data.sujets.find((x) => x.id === id); return s ? s.titre : t('no subject'); };
  const subLink = (id) => { const s = data.sujets.find((x) => x.id === id); return s ? `[${s.titre}](#${anchor(s.titre)})` : null; };
  const moment = (i) => `[${shortDay(i.entry.date)}${i.t !== null && i.t !== undefined ? ' · ' + fmtT(i.t) : ''}](${momentLink(i.entry, i.t)})`;
  const H = { week: t('Weeks'), last: t('Latest summary'), open: t('Open subjects'), done: t('Concluded subjects'), videos: t('Videos') };

  const L = [`# ${t('Journal')}`, '', `_${t('Updated on {date} · {videos} · {subjects}. File generated by Carnet: do not edit it by hand.', { date: dayLabel(Date.now()), videos: tn(entries.length, '{n} video', '{n} videos'), subjects: tn(open.length, '{n} open subject', '{n} open subjects') })}_`, ''];
  L.push(`## ${t('Contents')}`, '');
  if (data.profile && ['facts', 'strengths', 'weaknesses'].some((k) => (data.profile[k] || []).length)) L.push(`- [${t('You')}](#${anchor(t('You'))})`);
  if (progressOf(data).items.some((x) => x.status === 'active')) L.push(`- [${t('Progress')}](#${anchor(t('Progress'))})`);
  if (bilan) L.push(`- [${H.last}](#${anchor(H.last)})`);
  if (Object.keys(data.semaines || {}).length) L.push(`- [${H.week}](#${anchor(H.week)})`);
  L.push(`- [${H.open}](#${anchor(H.open)}) (${open.length})`);
  if (done.length) L.push(`- [${H.done}](#${anchor(H.done)}) (${done.length})`);
  L.push(`- [${H.videos}](#${anchor(H.videos)})`, '', `_${t('The date links open Carnet right at that moment of the video.')}_`, '');

  profileMarkdown(data, L);
  progressMarkdown(data, L);
  const it = (arr) => arr.map((x) => `- ${x.sujet ? `**${subTitle(x.sujet)}**: ` : x.titre ? `**${x.titre}**: ` : ''}${x.texte}`);
  const weeks = Object.keys(data.semaines || {}).sort().reverse();
  if (weeks.length) {
    L.push(`## ${H.week}`, '');
    for (const k of weeks) {
      const w = data.semaines[k];
      L.push(`### ${weekLabel(k)}${w.enCours ? ` (${t('in progress')})` : ''}`, '', `_${tn(w.n, '{n} video', '{n} videos')} · ${t('done on {date}', { date: dayLabel(w.at) })}_`, '');
      if (w.evolution_semaine) L.push(`**${t('Compared with the week before')}**: ${w.evolution_semaine}`, '');
      if (w.suivi.length) L.push(`**${t('What was planned')}**`, '', ...w.suivi.map((x) => `- ${x}`), '');
      if (w.en_bref) L.push(w.en_bref, '');
      if (w.avance.length) L.push(`**${t('What moved forward')}**`, '', ...it(w.avance), '');
      if (w.en_suspens.length) L.push(`**${t('Left hanging')}**`, '', ...it(w.en_suspens), '');
      if (w.contradictions.length) L.push(`**${t('To clarify')}**`, '', ...w.contradictions.map((x) => `- ${x}`), '');
      if (w.a_dire.length) L.push(`**${t('For the next week')}**`, '', ...w.a_dire.map((x) => `- ${x}`), '');
    }
  }
  if (bilan) {
    L.push(`## ${H.last}`, '', `_${t('{period}, from {from} to {to}', { period: periodLabel(bilan.period), from: shortDay(bilan.from), to: shortDay(bilan.to) })} · ${tn(bilan.n, '{n} video', '{n} videos')} · ${t('done on {date}', { date: dayLabel(bilan.at) })}_`, '');
    if (bilan.en_bref) L.push(bilan.en_bref, '');
    if (bilan.avance.length) L.push(`**${t('What moved forward')}**`, '', ...it(bilan.avance), '');
    if (bilan.en_suspens.length) L.push(`**${t('Left hanging')}**`, '', ...it(bilan.en_suspens), '');
    if (bilan.contradictions.length) L.push(`**${t('To clarify')}**`, '', ...bilan.contradictions.map((x) => `- ${x}`), '');
    if (bilan.a_dire.length) L.push(`**${t('For the next video')}**`, '', ...bilan.a_dire.map((x) => `- ${x}`), '');
  }

  const subjectMd = (s) => {
    const st = stats.get(s.id);
    L.push(`### ${s.titre}`, '', `_${[s.categorie, tn(st.entries.size, '{n} video', '{n} videos'), st.last ? t('last time on {date}', { date: shortDay(st.last) }) : null].filter(Boolean).join(' · ')}_`, '');
    if (s.etat === 'conclu' && s.conclusion) L.push(`**${t('Conclusion')}**: ${s.conclusion}`, '');
    if (s.ou_j_en_suis) L.push(`**${t('Where you’re at')}**: ${s.ou_j_en_suis}`, '');
    if (s.etat !== 'conclu' && s.a_trancher.length) L.push(`**${t('Still to decide')}**`, '', ...s.a_trancher.map((x) => `- ${x}`), '');
    if (s.etat !== 'conclu' && s.pistes.length) L.push(`**${t('Leads for next time')}**`, '', ...s.pistes.map((x) => `- ${x}`), '');
    const hist = (s.historique || []).filter((x) => x.ou_j_en_suis || x.etat === 'conclu');
    const concl = (x) => t('concluded: {what}', { what: x.conclusion || t('no detail') });
    if (hist.length) L.push(`**${t('How it changed')}**`, '', ...hist.map((x) => `- ${x.date ? shortDay(x.date) : '?'}${x.titre ? ` (${i18n.quote(x.titre)})` : ''}: ${x.evolution ? `_${x.evolution}_ ` : ''}${x.etat === 'conclu' ? concl(x) : x.ou_j_en_suis}`), `- ${t('now')}: ${s.evolution ? `_${s.evolution}_ ` : ''}${s.etat === 'conclu' ? concl(s) : s.ou_j_en_suis}`, '');
    if (st.ideas.length) L.push(`**${t('The thread')}**`, '', ...st.ideas.map((i) => `- ${i.texte} · ${moment(i)}`), '');
  };
  L.push(`## ${H.open}`, '');
  if (!open.length) L.push(`_${t('No subjects yet.')}_`, '');
  open.forEach(subjectMd);
  if (done.length) { L.push(`## ${H.done}`, ''); done.forEach(subjectMd); }

  L.push(`## ${H.videos}`, '');
  for (const k of months) {
    L.push(`### ${monthLabel(k)}`, '');
    for (const e of entries.filter((x) => monthKey(x.date) === k)) {
      const a = e.analysis;
      L.push(`#### ${shortDay(e.date)} · ${entryTitle(e)}`, '');
      const meta = [`[${t('Video')}](${link(e.file)})`, fmtT(e.duration)];
      if (e.transcript) meta.push(`[${t('Transcript')}](${TRANSCRIPTS_DIR}/${link(transcriptName(e))})`);
      if (a && a.humeur) meta.push(t('mood: {mood}', { mood: a.humeur }));
      L.push(`${dayLabel(e.date)} · ${meta.join(' · ')}`, '');
      if (!a) { L.push(`_${e.transcript ? t('Waiting for analysis.') : t('Waiting for transcript.')}_`, ''); continue; }
      if (a.resume) L.push(a.resume, '');
      if ((a.evolutions || []).length) L.push(`**${t('Compared with before')}**`, '', ...a.evolutions.map((x) => `- ${subLink(x.sujet) || subTitle(x.sujet)}: ${x.texte}`), '');
      const ids = [...new Set(a.idees.map((i) => i.sujet))];
      for (const id of ids) {
        L.push(`**${id ? subLink(id) || subTitle(id) : t('No subject')}**`, '');
        for (const i of a.idees.filter((x) => x.sujet === id)) L.push(`- ${i.texte}${i.t !== null && i.t !== undefined ? ` ([${fmtT(i.t)}](${momentLink(e, i.t)}))` : ''}`);
        L.push('');
      }
      if (a.citation) L.push(`> ${i18n.quote(a.citation)}`, '');
      if ((a.a_faire || []).length) L.push(`**${t('To do')}**: ${a.a_faire.join(' ; ')}`, '');
      if ((a.questions || []).length) L.push(`**${t('Questions')}**: ${a.questions.join(' ; ')}`, '');
      if ((a.personnes || []).length) L.push(`**${t('People')}**: ${a.personnes.join(', ')}`, '');
    }
  }
  return L.join('\n');
}

function writeMarkdown(dir, data) {
  fs.writeFileSync(path.join(dir, MD_FILE), renderMarkdown(data), 'utf8');
  for (const e of data.entries) if (e.transcript) writeTranscript(dir, e);
}

// ---------- Export of all the data as one text file ----------
// The whole journal, readable without Carnet: weeks, summaries, subjects (with how they changed and the thread
// of ideas), video cards, then the full transcripts and the settings (without the Gemini key).
function fullText(data, { settings = {}, instructions = '' } = {}) {
  const L = [
    `# ${t('Carnet: all the data')}`,
    '',
    `_${t('Exported on {date}', { date: dayLabel(Date.now()) })} · ${tn(data.entries.length, '{n} video', '{n} videos')} · ${tn(data.sujets.length, '{n} subject', '{n} subjects')} · ${tn(Object.keys(data.semaines || {}).length, '{n} weekly summary', '{n} weekly summaries')} · ${tn(data.bilans.length, '{n} period summary', '{n} period summaries')}_`,
    '',
    t('Contents: 1. the journal (you, weeks, latest summary, subjects, videos) · 2. all the period summaries · 3. the full transcripts · 4. the settings · 5. the instructions given to Gemini.'),
    '',
    '---',
    '',
  ];
  L.push(renderMarkdown(data).replace(/^# [^\n]*\n/, `# 1. ${t('The journal')}\n`), '', '---', '');
  L.push(`# 2. ${t('All the period summaries')}`, '');
  if (!data.bilans.length) L.push(`_${t('None.')}_`, '');
  const subTitle = (id) => (data.sujets.find((x) => x.id === id) || {}).titre;
  const items = (arr) => arr.map((x) => `- ${x.sujet && subTitle(x.sujet) ? `**${subTitle(x.sujet)}**: ` : x.titre ? `**${x.titre}**: ` : ''}${x.texte}`);
  for (const b of [...data.bilans].reverse()) {
    L.push(`## ${t('{period}, from {from} to {to}', { period: periodLabel(b.period), from: shortDay(b.from), to: shortDay(b.to) })}`, '', `_${tn(b.n, '{n} video', '{n} videos')} · ${t('done on {date}', { date: dayLabel(b.at) })}_`, '');
    if (b.en_bref) L.push(b.en_bref, '');
    if (b.avance.length) L.push(`**${t('What moved forward')}**`, '', ...items(b.avance), '');
    if (b.en_suspens.length) L.push(`**${t('Left hanging')}**`, '', ...items(b.en_suspens), '');
    if (b.contradictions.length) L.push(`**${t('To clarify')}**`, '', ...b.contradictions.map((x) => `- ${x}`), '');
    if (b.a_dire.length) L.push(`**${t('For the next video')}**`, '', ...b.a_dire.map((x) => `- ${x}`), '');
  }
  L.push('---', '', `# 2 bis. ${t('Your clarifications')}`, '');
  if (!(data.precisions || []).length) L.push(`_${t('None.')}_`, '');
  for (const p of data.precisions || []) {
    const e = p.entry && data.entries.find((x) => x.id === p.entry);
    const where = p.portee === 'journal' ? t('whole journal') : e ? t('video of {date} · {title}', { date: shortDay(e.date), title: entryTitle(e) }) : t('removed video');
    L.push(`- ${p.texte} _(${where}, ${dayLabel(p.at)}${p.appliquee ? '' : ', ' + t('not applied yet')})_`);
  }
  // How far you've come (written comparisons) and the look-backs.
  const P = progressOf(data);
  L.push('', '---', '', `# 2 ter. ${t('How far you’ve come')}`, '');
  if (!P.reports.length) L.push(`_${t('None.')}_`, '');
  for (const r of [...P.reports].reverse()) {
    L.push(`## ${tn(r.months, 'The last {n} month', 'The last {n} months')} · ${t('from {from} to {to}', { from: shortDay(r.from), to: shortDay(r.to) })}`, '');
    if (r.then_now) L.push(r.then_now, '');
    if (r.changes.length) L.push(`**${t('What changed')}**`, '', ...r.changes.map((c) => `- ${c.text}${c.then || c.now ? ` (${[c.then && `${t('then')}: ${c.then}`, c.now && `${t('now')}: ${c.now}`].filter(Boolean).join(' · ')})` : ''}`), '');
    if (r.learned.length) L.push(`**${t('What you learned')}**`, '', ...r.learned.map((x) => `- ${x}`), '');
    if (r.still.length) L.push(`**${t('Still the same')}**`, '', ...r.still.map((c) => `- ${c.text}${c.why ? ` (${c.why})` : ''}`), '');
    if (r.patterns.length) L.push(`**${t('What keeps coming back')}**`, '', ...r.patterns.map((c) => `- ${c.text}`), '');
  }
  const lbs = P.lookbacks.filter((l) => l.done);
  if (lbs.length) {
    L.push(`## ${t('Look-backs')}`, '');
    for (const l of lbs) {
      const e = l.entry && data.entries.find((x) => x.id === l.entry);
      L.push(`- ${t('Since {date}', { date: shortDay(l.from) })}${e ? ` · ${t('video of {date} · {title}', { date: shortDay(e.date), title: entryTitle(e) })}` : ''}`, ...l.questions.map((q) => `  - ${q.text}`));
    }
    L.push('');
  }
  L.push('---', '', `# 3. ${t('Full transcripts')}`, '');
  for (const e of [...data.entries].sort((a, b) => a.date - b.date)) {
    L.push(`## ${dayLabel(e.date)} · ${entryTitle(e)}`, '', `_${t('File: {file}', { file: e.file })} · ${fmtT(e.duration)}${e.transcript && e.transcript.model ? ' · ' + t('transcribed by {model}', { model: e.transcript.model }) : ''}_`, '');
    if (!e.transcript) { L.push(`_${t('Not transcribed yet.')}_`, ''); continue; }
    if (!e.transcript.segments.length) { L.push(`_${t('No speech detected.')}_`, ''); continue; }
    for (const sg of e.transcript.segments) L.push(`[${fmtT(sg.from)}] ${sg.text}`);
    L.push('');
  }
  L.push('---', '', `# 4. ${t('Settings')}`, '');
  const set = [
    [t('Journal folder'), settings.journalDir], [t('Exports folder'), settings.exportDir],
    [t('Language'), i18n.info(settings.lang || i18n.lang).name],
    [t('Transcription'), settings.transcriber || 'gemini'], [t('Gemini model'), settings.geminiModel],
    [t('Gemini calls per day'), settings.geminiBudget], [t('Gemini key'), settings.geminiKey ? t('saved on the computer (not exported)') : t('none')],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  L.push(...set.map(([k, v]) => `- ${k}: ${v}`), '');
  L.push('---', '', `# 5. ${t('Instructions given to Gemini')}`, '', instructions.trim() ? instructions.replace(/^#/gm, '##') : `_${t('None.')}_`, '');
  return L.join('\n');
}

module.exports = {
  DATA_FILE, MD_FILE, INSTRUCTIONS_FILE, TRANSCRIPTS_DIR, OLD_TRANSCRIPTS_DIR, PERIODS, periodLabel,
  fmtT, parseT, monthKey, monthLabel, dayLabel, shortDay, norm,
  parseWhisperJson, sections, load, save, newId, ensureInstructions, readInstructions, languageRule, hasIdeas,
  entryPrompt, entryAudioPrompt, segmentsFromGemini, emptyAnalysis, applyEntryAnalysis,
  rebuildPrompt, applyRebuild, periodEntries, bilanPrompt, normalizeBilan,
  weekKey, weekLabel, weekEntries, weeksWithVideos, weeklyPrompt, normalizeWeekly, nextWeekToDo,
  subjectStats, sortedSubjects, pruneSubjects, mergeSubjects, deleteSubject, findSubject, remember, stateBefore, BACKUP_DIR,
  renderMarkdown, entryTitle, momentLink, fullText, precisionsBlock, correctionPrompt, applyCorrections,
  normalizeProfile, profileOf, applyProfileOps, profileEdit, reviewPrompt, applyReview, recentEntries, ANGLES,
  normalizeProgress, progressOf, planList, progressBlock, applyProgress, syncSettled, fadingSubjects, progressEdit, REVIEW_DAYS, dueItems, monthAgo, reminderText,
  lookbackFrom, lookbackMaterial, lookbackState, lookbackOpen, lookbackPrompt, applyLookbackQuestions, lookbackRecorded,
  reportPrompt, applyReport, reelPlan, kindLabel, backfillPrompt, applyBackfill,
};
