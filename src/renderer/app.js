'use strict';
const $ = (id) => document.getElementById(id);

// ---------- État ----------
const state = {
  source: null,      // { path, url, name, info }
  clips: [],         // { id, file, url, in, out, at, duration, hasAudio }
  T: 0,              // position sur la timeline finale (secondes)
  playing: false,
  selectedId: null,
  segIndex: 0,
  cuts: [],          // parties supprimées : { id, target: 'src' | id du clip, start, end } en temps du média
  cutMode: false,    // ciseaux actifs
  sel: null,         // sélection sur la timeline finale : { a, b }
};
let nextId = 1;
let nextCutId = 1;
let nextChapterId = 1;
state.chapters = []; // { id, target: 'src' | id du clip, t (temps du média), title }

const srcVideo = $('srcVideo');
const clipVideo = $('clipVideo');

// ---------- Utilitaires ----------
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
// Affichage au centième pour les réglages précis.
function fmtP(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
function parseTime(str) {
  const p = String(str).trim().replace(',', '.').split(':');
  let t = 0;
  for (const x of p) { const n = parseFloat(x); if (isNaN(n)) return null; t = t * 60 + n; }
  return t;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Date et heure affichées en bas à droite du clip, ex : 20/10/2026 13:16
const stampDate = (ts) => new Date(ts).toLocaleDateString(i18n.locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
const stampTime = (ts) => new Date(ts).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const stampLabel = (ts) => `${stampDate(ts)} ${stampTime(ts)}`;
const recName = (ts) => t('Recording of {date} at {time}', { date: stampDate(ts), time: stampTime(ts) });

function busy(msg) { $('busyMsg').textContent = msg; $('busy').classList.toggle('hidden', !msg); }

function setSrc(el, url) {
  return new Promise((resolve) => {
    if (el.dataset.url === url && el.readyState >= 1) return resolve();
    el.dataset.url = url;
    el.addEventListener('loadedmetadata', () => resolve(), { once: true });
    el.src = url;
  });
}
function seekEl(el, t) {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - t) < 0.01) return resolve();
    el.addEventListener('seeked', () => resolve(), { once: true });
    el.currentTime = t;
  });
}

// Intervalle [s, e] moins une liste de coupes : renvoie les morceaux restants.
function subtract(s, e, cuts) {
  const out = [];
  let cur = s;
  for (const c of [...cuts].sort((x, y) => x.start - y.start)) {
    if (c.end <= cur) continue;
    if (c.start >= e) break;
    if (c.start > cur) out.push([cur, c.start]);
    cur = Math.max(cur, c.end);
  }
  if (cur < e) out.push([cur, e]);
  return out.filter(([a, b]) => b - a > 0.04);
}

// ---------- Séquence ----------
function segments() {
  if (!state.source) return [];
  const dur = state.source.info.duration;
  const sorted = [...state.clips].sort((a, b) => a.at - b.at);
  const segs = [];
  let pos = 0, off = 0;
  // Ajoute le morceau en retirant les parties supprimées qui le concernent.
  const push = (s) => {
    const target = s.type === 'src' ? 'src' : s.clip.id;
    for (const [start, end] of subtract(s.start, s.end, state.cuts.filter((c) => c.target === target))) {
      segs.push({ ...s, start, end, offset: off });
      off += end - start;
    }
  };
  for (const c of sorted) {
    if (c.at - pos > 0.04) push({ type: 'src', start: pos, end: c.at });
    push({ type: 'clip', clip: c, start: c.in, end: c.out });
    pos = c.at;
  }
  if (dur - pos > 0.04) push({ type: 'src', start: pos, end: dur });
  return segs;
}
const totalDuration = () => segments().reduce((s, x) => s + (x.end - x.start), 0);

function segAt(T, segs = segments()) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (T < s.offset + (s.end - s.start) - 1e-6) return i;
  }
  return segs.length - 1;
}

// Moment dans la vidéo d'origine qui correspond à la position actuelle.
function sourceTimeAtCurrent() {
  const segs = segments();
  if (!segs.length) return 0;
  const s = segs[segAt(state.T, segs)];
  if (s.type === 'clip') return s.clip.at;
  return clamp(s.start + (state.T - s.offset), 0, state.source.info.duration);
}

// ---------- Lecture ----------
// Deux lecteurs vidéo superposés : pendant que l'un joue un morceau, l'autre est déjà calé
// sur le début du morceau suivant. Au passage d'une coupe ou d'un clip, on bascule sans attendre.
const players = [srcVideo, clipVideo];
let cur = 0;
let prepToken = 0;
const segUrl = (s) => (s.type === 'src' ? state.source.url : s.clip.url);
const segKey = (s) => s ? `${segUrl(s)}#${s.start.toFixed(3)}` : '';

function showPlayer(i) {
  players[i].classList.remove('back');
  players[1 - i].classList.add('back');
}

// Date et heure à afficher en bas à droite : clips, et vidéo enregistrée dans Carnet.
function segStamp(s) {
  if (s.type === 'clip') return s.clip.recordedAt ? stampLabel(s.clip.recordedAt) : null;
  return state.source && state.source.recordedAt ? stampLabel(state.source.recordedAt) : null;
}
function showSegInfo(s) {
  $('clipBadge').classList.toggle('hidden', s.type !== 'clip');
  const label = segStamp(s);
  $('clipStamp').classList.toggle('hidden', !label);
  if (label) $('clipStamp').textContent = label;
}

// Prépare le lecteur en attente sur le début du morceau i.
async function prepareNext(i) {
  const token = ++prepToken;
  const standby = players[1 - cur];
  standby.pause();
  standby.dataset.ready = '';
  const s = segments()[i];
  if (!s) return;
  await setSrc(standby, segUrl(s));
  if (token !== prepToken) return;
  await seekEl(standby, s.start);
  if (token !== prepToken) return;
  standby.dataset.ready = segKey(s);
}

async function seek(T) {
  const segs = segments();
  if (!segs.length) return;
  T = clamp(T, 0, totalDuration());
  state.T = T;
  const i = segAt(T, segs);
  state.segIndex = i;
  const s = segs[i];
  const el = players[cur];
  players[1 - cur].pause();
  await setSrc(el, segUrl(s));
  await seekEl(el, s.start + (T - s.offset));
  showPlayer(cur);
  showSegInfo(s);
  updateUI();
  prepareNext(i + 1);
}

const activeEl = () => players[cur];

async function play() {
  if (!state.source) return;
  if (state.T >= totalDuration() - 0.05) await seek(0);
  state.playing = true;
  setPlayIcon();
  try { await activeEl().play(); } catch (_) {}
  requestAnimationFrame(tick);
}
function pause() {
  state.playing = false;
  players.forEach((p) => p.pause());
  setPlayIcon();
}
let switching = false;
async function tick() {
  if (!state.playing) return;
  const segs = segments();
  const s = segs[state.segIndex];
  if (s && !switching) {
    const el = players[cur];
    state.T = s.offset + (el.currentTime - s.start);
    if (el.currentTime >= s.end - 0.02 || el.ended) {
      const next = segs[state.segIndex + 1];
      if (!next) { pause(); state.T = totalDuration(); updateUI(); return; }
      const standby = players[1 - cur];
      if (standby.dataset.ready === segKey(next)) {
        // Bascule immédiate : le lecteur en attente est déjà sur la bonne image.
        standby.play().catch(() => {});
        el.pause();
        cur = 1 - cur;
        showPlayer(cur);
        state.segIndex += 1;
        state.T = next.offset;
        showSegInfo(next);
        prepareNext(state.segIndex + 1);
      } else {
        // Le morceau suivant n'était pas prêt : on cale puis on reprend.
        switching = true;
        el.pause();
        await seek(next.offset);
        try { await activeEl().play(); } catch (_) {}
        switching = false;
      }
    }
    updateUI();
  }
  requestAnimationFrame(tick);
}
function setPlayIcon() {
  $('icoPlay').classList.toggle('hidden', state.playing);
  $('icoPause').classList.toggle('hidden', !state.playing);
}
function togglePlay() { state.playing ? pause() : play(); }

// ---------- Chapitres ----------
// Position d'un point du média sur la timeline finale. Si ce point a été coupé, on prend la suite.
function composedTime(target, t, segs = segments()) {
  const own = segs.filter((s) => (s.type === 'src' ? 'src' : s.clip.id) === target);
  for (const s of own) if (t >= s.start - 1e-6 && t < s.end) return s.offset + (t - s.start);
  const after = own.find((s) => s.start > t);
  return after ? after.offset : null;
}

// Chapitres placés sur la timeline finale, triés. Ceux dont la partie a été supprimée sont ignorés.
function placedChapters() {
  const segs = segments();
  return state.chapters
    .map((c) => ({ ch: c, T: composedTime(c.target, c.t, segs) }))
    .filter((x) => x.T !== null)
    .sort((a, b) => a.T - b.T);
}

function addChapter() {
  const segs = segments();
  if (!segs.length) return;
  const s = segs[segAt(state.T, segs)];
  const ch = {
    id: nextChapterId++,
    target: s.type === 'src' ? 'src' : s.clip.id,
    t: s.start + (state.T - s.offset),
    title: t('Chapter {n}', { n: state.chapters.length + 1 }),
  };
  state.chapters.push(ch);
  renderClips();
  // Met le curseur dans le titre pour le renommer tout de suite.
  const input = document.querySelector(`#chapterList input[data-id="${ch.id}"]`);
  if (input) { input.focus(); input.select(); }
}

function renderChapters() {
  const placed = placedChapters();
  const total = totalDuration();
  const list = $('chapterList');
  list.innerHTML = '';
  for (const { ch, T } of placed) {
    const li = document.createElement('li');
    li.dataset.id = ch.id;
    const time = document.createElement('span');
    time.className = 'ch-time';
    time.textContent = fmt(T).replace(/\.\d$/, '');
    time.title = t('Go to the chapter');
    time.onclick = () => { pause(); seek(T); };
    const input = document.createElement('input');
    input.type = 'text';
    input.value = ch.title;
    input.dataset.id = ch.id;
    input.spellcheck = false;
    input.oninput = () => { ch.title = input.value; drawChapterMarks(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = t('Delete the chapter');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" fill="none"/></svg>';
    del.onclick = () => { state.chapters = state.chapters.filter((x) => x !== ch); renderClips(); };
    li.append(time, input, del);
    list.appendChild(li);
  }
  $('chaptersBox').classList.toggle('hidden', placed.length === 0);
  drawChapterMarks(placed, total);
}

function drawChapterMarks(placed = placedChapters(), total = totalDuration()) {
  const row = $('chapterRow');
  row.innerHTML = '';
  document.querySelectorAll('#timeline .chapter-line').forEach((n) => n.remove());
  if (!total) return;
  placed.forEach(({ ch, T }, i) => {
    const next = placed[i + 1] ? placed[i + 1].T : total;
    const m = document.createElement('div');
    m.className = 'chapter-mark';
    m.style.left = (T / total) * 100 + '%';
    m.style.maxWidth = `calc(${((next - T) / total) * 100}% - 2px)`;
    m.textContent = ch.title || t('Untitled');
    m.title = ch.title;
    m.onclick = () => { pause(); seek(T); };
    row.appendChild(m);
    const line = document.createElement('div');
    line.className = 'chapter-line';
    line.style.left = (T / total) * 100 + '%';
    $('timeline').appendChild(line);
  });
}

// Chapitre en cours à la tête de lecture.
function currentChapter() {
  let cur = null;
  for (const x of placedChapters()) if (x.T <= state.T + 0.01) cur = x;
  return cur;
}

// ---------- Niveau sonore ----------
const waves = new Map(); // chemin du fichier -> { step, levels }

// Calcul du niveau sonore d'un fichier (en arrière-plan, quelques secondes pour une longue vidéo).
// En cas d'échec, on réessaie deux fois avant d'abandonner.
const wavePromises = new Map();
function loadWave(file) {
  if (!file) return Promise.resolve(null);
  if (!wavePromises.has(file)) {
    waves.set(file, null);
    const attempt = async () => {
      for (let i = 0; i < 3; i++) {
        const w = await window.api.waveform(file).catch(() => null);
        if (w && w.levels.length) return w;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return { step: 0.05, levels: [], failed: true };
    };
    wavePromises.set(file, attempt().then((w) => {
      waves.set(file, w);
      renderTimeline();
      return w;
    }));
    renderTimeline();
  }
  return wavePromises.get(file);
}
const waveLoading = () => segments().some((s) => segHasAudio(s) && waves.get(segFile(s)) === null);

// ---------- Retrait automatique des silences ----------
// Dans chaque silence, on garde 1 s au début et 1 s à la fin, et on retire le milieu.
const AUTO_KEEP = 1;        // secondes gardées de chaque côté du silence
const AUTO_MIN_CUT = 0.3;   // on ne retire pas moins que ça

// Silences d'un fichier, en temps du fichier : [{ start, end }] à retirer.
function silenceCutsFor(w, from = 0, to = Infinity) {
  if (!w || !w.levels.length) return [];
  const { step, levels } = w;
  const out = [];
  let run = null;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] < SILENCE_LEVEL;
    if (quiet && run === null) run = i;
    if (!quiet && run !== null) {
      const a = Math.max(from, run * step) + AUTO_KEEP;
      const b = Math.min(to, i * step) - AUTO_KEEP;
      if (b - a >= AUTO_MIN_CUT) out.push({ start: a, end: b });
      run = null;
    }
  }
  return out;
}

async function autoRemoveSilences(target, file, hasAudio, from, to) {
  if (!hasAudio) return;
  const w = await loadWave(file);
  // La vidéo ou le clip a pu être retiré entre-temps.
  if (target === 'src' ? !state.source || state.source.path !== file : !state.clips.some((c) => c.id === target)) return;
  const cuts = silenceCutsFor(w, from, to);
  if (!cuts.length) return;
  const ids = cuts.map((c) => {
    const cut = { id: nextCutId++, target, start: c.start, end: c.end, auto: true };
    state.cuts.push(cut);
    return cut.id;
  });
  const total = cuts.reduce((t, c) => t + c.end - c.start, 0);
  const keepT = sourceAnchor();
  renderClips();
  seek(keepT());
  showToast(tn(cuts.length, '{n} silence removed, {total} in all. 1 s kept on each side.', '{n} silences removed, {total} in all. 1 s kept on each side.', { total: fmtP(total) }), t('Undo'), () => {
    state.cuts = state.cuts.filter((c) => !ids.includes(c.id));
    const back = sourceAnchor();
    renderClips();
    seek(back());
  });
}

// Garde la tête de lecture sur le même moment de la vidéo d'origine après un changement de coupes.
function sourceAnchor() {
  const segs = segments();
  if (!segs.length) return () => 0;
  const s = segs[segAt(state.T, segs)];
  const target = s.type === 'src' ? 'src' : s.clip.id;
  const t = s.start + (state.T - s.offset);
  return () => composedTime(target, t) ?? Math.min(state.T, totalDuration());
}
const segFile = (s) => (s.type === 'src' ? state.source.path : s.clip.file);
const segHasAudio = (s) => (s.type === 'src' ? state.source.info.hasAudio : s.clip.hasAudio !== false);

// Repérage des silences : sous ce niveau pendant au moins SILENCE_MIN secondes.
const SILENCE_LEVEL = 0.3;  // environ -42 dB
const SILENCE_MIN = 0.7;    // durée minimale (s)
const SILENCE_PAD = 0.12;   // marge laissée côté parole, pour ne pas couper le début ou la fin des mots

// Silences sur la timeline finale : [{ a, b }]. Rien n'est supprimé, c'est seulement un repérage.
function silences() {
  const out = [];
  for (const s of segments()) {
    const w = waves.get(segFile(s));
    if (!segHasAudio(s) || !w || !w.levels.length) continue;
    const { step, levels } = w;
    const i0 = Math.floor(s.start / step), i1 = Math.ceil(s.end / step);
    let run = null;
    for (let i = i0; i <= i1; i++) {
      const quiet = i < i1 && (levels[i] ?? 0) < SILENCE_LEVEL;
      if (quiet && run === null) run = i;
      if (!quiet && run !== null) {
        const ta = Math.max(s.start, run * step), tb = Math.min(s.end, i * step);
        if (tb - ta >= SILENCE_MIN) {
          const a = ta + (ta > s.start + 0.01 ? SILENCE_PAD : 0);
          const b = tb - (tb < s.end - 0.01 ? SILENCE_PAD : 0);
          if (b - a > 0.2) out.push({ a: s.offset + (a - s.start), b: s.offset + (b - s.start) });
        }
        run = null;
      }
    }
  }
  out.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const x of out) {
    const last = merged[merged.length - 1];
    if (last && x.a - last.b < 0.05) last.b = Math.max(last.b, x.b); else merged.push({ ...x });
  }
  return merged;
}

// Sélectionne un silence pour pouvoir le supprimer (bouton « Supprimer la partie » ou Suppr).
function selectSilence(z) {
  if (!state.cutMode) setCutMode(true);
  pause();
  state.sel = { a: z.a, b: z.b, pending: false };
  seek(z.a);
}

function drawWave(canvas, s) {
  const w = waves.get(segFile(s));
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  if (!segHasAudio(s) || !w || !w.levels.length) return;
  const { step, levels } = w;
  const top = s.type === 'clip' ? 16 : 4;    // laisse la place au nom du clip
  const mid = top + (H - top) / 2, half = (H - top) / 2 - 1;
  // Ligne du zéro : visible là où il n'y a pas de son.
  g.fillStyle = 'rgba(255,255,255,.18)';
  g.fillRect(0, Math.round(mid), W, 1);
  g.fillStyle = s.type === 'clip' ? 'rgba(255,255,255,.85)' : 'rgba(214,226,238,.85)';
  const span = s.end - s.start;
  for (let x = 0; x < W; x++) {
    const ia = Math.floor((s.start + (x / W) * span) / step);
    const ib = Math.max(ia + 1, Math.floor((s.start + ((x + 1) / W) * span) / step));
    let m = 0;
    for (let i = ia; i < ib && i < levels.length; i++) m = Math.max(m, levels[i]);
    if (m <= 0.02) continue;
    // Hauteur : racine de l'amplitude, comme dans les logiciels de montage (-10 dB ≈ 56 %, -30 dB ≈ 18 %).
    const amp = Math.pow(10, (m * 60 - 60) / 20);
    const h = Math.max(1, Math.sqrt(amp) * half);
    g.fillRect(x, mid - h, 1, h * 2);
  }
}

// Niveau en dB à un instant de la timeline finale (pour l'infobulle).
function dbAt(T) {
  const segs = segments();
  if (!segs.length) return null;
  const s = segs[segAt(T, segs)];
  const w = waves.get(segFile(s));
  if (!segHasAudio(s) || !w || !w.levels.length) return null;
  const i = Math.floor((s.start + (T - s.offset)) / w.step);
  const lv = w.levels[Math.min(i, w.levels.length - 1)] ?? 0;
  return lv <= 0 ? -60 : Math.round(lv * 60 - 60);
}

// ---------- Interface ----------
function updateUI() {
  const total = totalDuration();
  $('tCur').textContent = fmtP(state.T);
  const cur = state.chapters.length ? currentChapter() : null;
  $('chapterNow').classList.toggle('hidden', !cur);
  if (cur) $('chapterNow').textContent = cur.ch.title || t('Untitled');
  document.querySelectorAll('#chapterList li').forEach((li) => li.classList.toggle('now', !!cur && +li.dataset.id === cur.ch.id));
  $('tTotal').textContent = fmt(total);
  const tl = $('timeline');
  $('playhead').style.left = (total ? (state.T / total) * tl.clientWidth : 0) + 'px';
  // Sélection des ciseaux
  const sel = state.sel;
  // Entre « Début ici » et « Fin ici », la zone suit la tête de lecture.
  if (sel && sel.pending) sel.b = state.T;
  const ready = sel && !sel.pending && Math.abs(sel.b - sel.a) > 0.04;
  $('cutSel').classList.toggle('hidden', !sel || total <= 0);
  $('cutSel').classList.toggle('pending', !!(sel && sel.pending));
  $('btnCut').classList.toggle('hidden', !ready);
  $('cutBar').classList.toggle('hidden', !state.cutMode);
  $('btnMarkOut').disabled = !(sel && sel.pending);
  if (sel && total > 0) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    $('cutSel').style.left = (a / total) * 100 + '%';
    $('cutSel').style.width = ((b - a) / total) * 100 + '%';
  }
  if (state.cutMode) {
    $('selInfo').textContent = !sel ? t('Move the playhead to the start')
      : sel.pending ? t('Move the playhead to the end')
      : t('from {a} to {b} ({len})', { a: fmtP(Math.min(sel.a, sel.b)), b: fmtP(Math.max(sel.a, sel.b)), len: fmtP(Math.abs(sel.b - sel.a)) });
  }
}

function renderTimeline() {
  const segs = segments();
  const total = totalDuration();
  const track = $('track');
  track.innerHTML = '';
  for (const s of segs) {
    const d = document.createElement('div');
    d.className = 'seg ' + s.type;
    d.style.width = ((s.end - s.start) / total) * 100 + '%';
    const cv = document.createElement('canvas');
    cv.className = 'wave';
    d.appendChild(cv);
    if (s.type === 'clip') {
      const lab = document.createElement('span');
      lab.className = 'seg-label';
      lab.textContent = t('Clip {n}', { n: s.clip.num });
      d.appendChild(lab);
      d.dataset.id = s.clip.id;
      if (s.clip.id === state.selectedId) d.classList.add('sel');
    }
    track.appendChild(d);
    drawWave(cv, s);
  }
  $('waveMsg').classList.toggle('hidden', !waveLoading());
  // Silences repérés : blocs séparés de la parole, cliquables.
  const sil = $('silences');
  sil.innerHTML = '';
  if (total > 0) {
    const pxPerSec = (sil.clientWidth || 1000) / total;
    silences().forEach((z) => {
      const e = document.createElement('div');
      e.className = 'silence';
      e.style.left = (z.a / total) * 100 + '%';
      e.style.width = ((z.b - z.a) / total) * 100 + '%';
      const len = (z.b - z.a).toFixed(1).replace('.', ',') + ' s';
      if ((z.b - z.a) * pxPerSec > 46) e.textContent = len;
      e.title = t('{len} of silence: click to select it', { len });
      e.dataset.a = z.a; e.dataset.b = z.b;
      sil.appendChild(e);
    });
  }
  // Graduations
  const ruler = $('ruler');
  ruler.innerHTML = '';
  if (total > 0) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const width = ruler.clientWidth || 800;
    const step = steps.find((x) => (width / total) * x >= 70) || 600;
    for (let t = 0; t <= total; t += step) {
      const sp = document.createElement('span');
      sp.style.left = (t / total) * 100 + '%';
      sp.textContent = fmt(t).replace(/\.\d$/, '');
      ruler.appendChild(sp);
    }
  }
  updateUI();
}

function renderClips() {
  const sorted = [...state.clips].sort((a, b) => a.at - b.at);
  sorted.forEach((c, i) => (c.num = i + 1));
  // Durée réelle de chaque clip, parties supprimées déduites
  const segs = segments();
  const len = (c) => segs.filter((x) => x.type === 'clip' && x.clip.id === c.id).reduce((t, x) => t + x.end - x.start, 0);
  const list = $('clipList');
  list.innerHTML = '';
  for (const c of sorted) {
    const li = document.createElement('li');
    li.className = c.id === state.selectedId ? 'sel' : '';
    li.innerHTML = `<span class="swatch"></span><span class="meta"><span>${t('Clip {n}', { n: c.num })}</span><span class="muted small">${t('at {at}', { at: fmt(c.at) })} · ${fmt(len(c))}</span></span>`;
    li.onclick = () => selectClip(c.id, true);
    list.appendChild(li);
  }
  $('clipEmpty').classList.toggle('hidden', state.clips.length > 0);
  const sel = state.clips.find((c) => c.id === state.selectedId);
  $('props').classList.toggle('hidden', !sel);
  if (sel) {
    $('pDur').textContent = fmt(len(sel));
    if (document.activeElement !== $('pAt')) $('pAt').value = fmt(sel.at);
  }
  renderCuts();
  renderTimeline();
  renderChapters();
}

function renderCuts() {
  const list = $('cutList');
  list.innerHTML = '';
  const name = (c) => {
    if (c.target === 'src') return t('Video');
    const clip = state.clips.find((x) => x.id === c.target);
    return clip ? t('Clip {n}', { n: clip.num }) : t('Clip');
  };
  const sorted = [...state.cuts].sort((a, b) => (a.target === 'src' ? a.start : 1e9) - (b.target === 'src' ? b.start : 1e9));
  for (const c of sorted) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="meta"><span>${name(c)}${c.auto ? ' · ' + t('silence') : ''}</span><span class="muted small">${t('from {a} to {b}', { a: fmtP(c.start), b: fmtP(c.end) })}</span></span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = t('Restore');
    btn.onclick = () => restoreCut(c.id);
    li.appendChild(btn);
    list.appendChild(li);
  }
  $('cutsBox').classList.toggle('hidden', state.cuts.length === 0);
  $('btnRestoreSilences').classList.toggle('hidden', !state.cuts.some((c) => c.auto));
}

$('btnRestoreSilences').onclick = () => {
  pause();
  const back = sourceAnchor();
  state.cuts = state.cuts.filter((c) => !c.auto);
  renderClips();
  seek(back());
};

function selectClip(id, jump) {
  state.selectedId = id;
  renderClips();
  if (jump && id) {
    const s = segments().find((x) => x.type === 'clip' && x.clip.id === id);
    if (s) { pause(); seek(s.offset); }
  }
}

function enableEditing(on) {
  $('btnExport').disabled = !on;
  $('btnAddJournal').disabled = !on;
  $('btnRecord').disabled = !on;
  $('btnScissors').disabled = !on;
  $('btnChapter').disabled = !on;
  $('empty').classList.toggle('hidden', on);
}

// ---------- Ciseaux ----------
function setCutMode(on) {
  state.cutMode = on;
  $('btnScissors').classList.toggle('active', on);
  $('timeline').classList.toggle('cutting', on);
  state.sel = null;
  updateUI();
}

// Supprime la partie sélectionnée. Elle peut couvrir la vidéo et des clips à la fois.
function cutSelection() {
  const sel = state.sel; if (!sel || sel.pending) return;
  const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
  if (b - a < 0.05) return;
  pause();
  for (const s of segments()) {
    const len = s.end - s.start;
    const x = Math.max(a, s.offset), y = Math.min(b, s.offset + len);
    if (y - x < 0.02) continue;
    state.cuts.push({
      id: nextCutId++,
      target: s.type === 'src' ? 'src' : s.clip.id,
      start: s.start + (x - s.offset),
      end: s.start + (y - s.offset),
    });
  }
  state.sel = null;
  renderClips();
  seek(Math.min(a, totalDuration()));
}

function restoreCut(id) {
  pause();
  state.cuts = state.cuts.filter((c) => c.id !== id);
  renderClips();
  seek(Math.min(state.T, totalDuration()));
}

$('btnScissors').onclick = () => setCutMode(!state.cutMode);
$('btnChapter').onclick = addChapter;
$('btnCut').onclick = cutSelection;

// Début et fin de la coupe pris exactement à la position de la tête de lecture.
function markIn() {
  if (!state.source) return;
  if (!state.cutMode) setCutMode(true);
  pause();
  state.sel = { a: state.T, b: state.T, pending: true };
  updateUI();
}
function markOut() {
  const sel = state.sel;
  if (!sel || !sel.pending) return;
  pause();
  if (Math.abs(state.T - sel.a) < 0.04) return; // fin au même endroit que le début
  sel.b = state.T;
  sel.pending = false;
  updateUI();
}
$('btnMarkIn').onclick = markIn;
$('btnMarkOut').onclick = markOut;

// Avance ou recule d'une image.
function stepFrame(dir) {
  if (!state.source) return;
  pause();
  const segs = segments();
  const s = segs[segAt(state.T, segs)];
  const fps = s && s.type === 'clip' ? 30 : state.source.info.fps || 30;
  seek(state.T + dir / fps);
}

// ---------- Ouverture ----------
const hasWork = () => state.clips.length || state.cuts.length || state.chapters.length;

// Remplace la vidéo de travail. cuts : parties à retirer d'emblée (début et fin d'un nouvel enregistrement).
function showToast(msg, actionLabel, action) {
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = actionLabel;
    b.onclick = () => { t.classList.add('hidden'); action(); };
    t.appendChild(b);
  }
  t.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.add('hidden'), actionLabel ? 8000 : 4000);
}

async function setSource(v, cuts = []) {
  state.source = v;
  state.clips = [];
  state.cuts = cuts.map((c) => ({ id: nextCutId++, target: 'src', ...c }));
  const dur = v.info.duration || Infinity;
  state.chapters = (v.chapters || []).filter((c) => c.t < dur).map((c, i) => ({
    id: nextChapterId++, target: 'src', t: c.t, title: c.title || t('Chapter {n}', { n: i + 1 }),
  }));
  state.selectedId = null;
  setCutMode(false);
  players.forEach((p) => { p.pause(); p.dataset.url = ''; p.dataset.ready = ''; });
  cur = 0;
  await setSrc(srcVideo, v.url);
  if (!v.info.duration && isFinite(srcVideo.duration)) v.info.duration = srcVideo.duration;
  $('titleInput').value = v.recorded ? (v.titleHint || t('Journal')) : v.name.replace(/\.[^.]+$/, '');
  $('titleInput').title = v.recorded ? v.name : t('File: {name}', { name: v.name });
  $('titleInput').disabled = false;
  document.title = v.name + ' · Carnet';
  enableEditing(true);
  showScreen('editor');
  renderClips();
  await seek(0);
  autoRemoveSilences('src', v.path, v.info.hasAudio, 0, v.info.duration);
  if (v.info.hasAudio) loadWave(v.path);
  if (state.chapters.length) showToast(tn(state.chapters.length, '{n} chapter loaded from {from}', '{n} chapters loaded from {from}', { from: v.chaptersFrom }));
}

async function openFile(file) {
  if (!file) return;
  if (hasWork() && !confirm(t('Open another video? The clips and cuts will be removed.'))) return;
  pause();
  busy(t('Opening the video…'));
  try {
    const v = await window.api.loadVideo(file);
    if (!v.info.hasVideo) throw new Error(t('This file has no playable video.'));
    await setSource(v);
  } catch (e) {
    alert(t('Could not open the video.') + '\n' + (e.message || e));
  } finally {
    busy(null);
  }
}

$('btnOpen').onclick = $('btnOpenEmpty').onclick = async () => openFile(await window.api.openDialog());
window.api.onOpenFile(openFile);

const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) openFile(window.api.pathForFile(f));
});

// ---------- Transport ----------
$('btnPlay').onclick = togglePlay;
$('btnBack').onclick = () => seek(state.T - 5);
$('btnFwd').onclick = () => seek(state.T + 5);

// Timeline : clic et glisser pour se déplacer, clic sur un clip pour le sélectionner.
(function timelineDrag() {
  const tl = $('timeline');
  let dragging = false, wasPlaying = false;
  const toT = (e) => {
    const r = tl.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * totalDuration();
  };
  tl.addEventListener('pointerdown', (e) => {
    if (!state.source) return;
    const z = e.target.closest('.silence');
    if (z) { selectSilence({ a: +z.dataset.a, b: +z.dataset.b }); return; }
    const segEl = e.target.closest('.seg.clip');
    state.selectedId = segEl ? +segEl.dataset.id : null;
    renderClips();
    dragging = true; wasPlaying = state.playing;
    pause();
    tl.setPointerCapture(e.pointerId);
    seek(toT(e));
  });
  tl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.T = toT(e); updateUI();
    seek(state.T);
  });
  tl.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (wasPlaying) play();
  });
})();

window.addEventListener('resize', renderTimeline);
// Redessine la courbe dès que la timeline a une taille (par exemple en revenant sur l'écran de montage).
new ResizeObserver(() => { if ($('timeline').clientWidth) renderTimeline(); }).observe($('timeline'));

// Infobulle au survol de la timeline : temps et niveau sonore.
(function hoverReadout() {
  const tl = $('timeline'), tip = $('hoverTip');
  tl.addEventListener('pointermove', (e) => {
    const total = totalDuration();
    if (!total) return;
    const r = tl.getBoundingClientRect();
    const T = clamp((e.clientX - r.left) / r.width, 0, 1) * total;
    const db = dbAt(T);
    const segs = segments();
    const sg = segs.length ? segs[segAt(T, segs)] : null;
    const loading = sg && segHasAudio(sg) && !waves.get(segFile(sg));
    tip.textContent = `${fmtP(T)} · ${loading ? t('analysing the sound…') : db === null ? t('no sound') : db <= -60 ? t('silence') : db + ' dB'}`;
    tip.style.left = (e.clientX - r.left) + 'px';
    tip.classList.remove('hidden');
  });
  tl.addEventListener('pointerleave', () => tip.classList.add('hidden'));
})();

// ---------- Panneau clip ----------
function currentClip() { return state.clips.find((c) => c.id === state.selectedId); }
function moveClip(c, at) {
  c.at = clamp(at, 0, state.source.info.duration);
  renderClips();
  const s = segments().find((x) => x.type === 'clip' && x.clip.id === c.id);
  if (s) seek(s.offset);
}
$('pAt').addEventListener('change', () => {
  const c = currentClip(); const t = parseTime($('pAt').value);
  if (c && t !== null) moveClip(c, t); else renderClips();
});
$('btnMoveHere').onclick = () => {
  const c = currentClip(); if (!c) return;
  const segs = segments();
  const s = segs[segAt(state.T, segs)];
  // Si la tête de lecture est sur ce même clip, rien à déplacer.
  if (s.type === 'clip' && s.clip.id === c.id) return;
  moveClip(c, sourceTimeAtCurrent());
};
$('btnDeleteClip').onclick = () => deleteSelected();
$('btnEditClip').onclick = () => { const c = currentClip(); if (c) openRecorder(c); };

function deleteSelected() {
  const c = currentClip(); if (!c) return;
  if (!confirm(t('Delete clip {n}?', { n: c.num }))) return;
  pause();
  const anchor = c.at;
  state.clips = state.clips.filter((x) => x !== c);
  state.cuts = state.cuts.filter((x) => x.target !== c.id);
  state.chapters = state.chapters.filter((x) => x.target !== c.id);
  state.selectedId = null;
  window.api.deleteRecording(c.file);
  renderClips();
  // Se replacer au même moment de la vidéo d'origine.
  const s = segments().find((x) => x.type === 'src' && anchor <= x.end);
  seek(s ? s.offset + Math.max(0, anchor - s.start) : 0);
}

// ---------- Enregistrement ----------
const rec = {
  stream: null, recorder: null, chunks: [], startAt: 0, timer: null,
  audioCtx: null, meterRaf: null,
  editing: null,     // clip existant en cours de modification
  draft: null,       // { file, url, duration, hasAudio, in, out }
};

function show(id, on) { $(id).classList.toggle('hidden', !on); }

// Nouvelle vidéo : on enregistre la vidéo principale, puis on pourra y insérer des clips.
function newVideo() {
  if (hasWork() && !confirm(t('Start a new video? The current clips and cuts will be removed.'))) return;
  openRecorder(null, 'new');
}

async function openRecorder(existing = null, mode = 'clip') {
  pause();
  rec.editing = existing;
  rec.mode = mode;
  rec.draft = null;
  $('modal').classList.remove('hidden');
  $('insertAtField').classList.toggle('hidden', mode === 'new');
  // Notes à côté de la caméra : le sujet choisi, ou les pistes du dernier bilan.
  if (!existing && window.journalUI) window.journalUI.setupNotes(mode === 'clip' && state.source ? state.source.intention : null);
  if (mode === 'new') {
    $('modalTitle').textContent = t('New video');
    $('modalAt').textContent = t('You can insert clips into it afterwards');
    gotoRecord();
    await startCamera();
  } else if (existing) {
    rec.draft = { ...existing };
    $('modalTitle').textContent = t('Trim clip {n}', { n: existing.num });
    $('insertAt').value = fmt(existing.at);
    $('modalAt').textContent = '';
    gotoTrim();
  } else {
    const at = sourceTimeAtCurrent();
    $('insertAt').value = fmt(at);
    $('modalTitle').textContent = t('Record a clip');
    $('modalAt').textContent = t('Will be inserted at {at}', { at: fmt(at) });
    gotoRecord();
    await startCamera();
  }
}

function gotoRecord() {
  show('stepRecord', true); show('stepTrim', false); show('stepFail', false); show('stepWait', false); show('btnSaveCopy', false);
  show('btnRecToggle', true); show('btnOk', false); show('btnRetake', false);
  $('btnRecToggle').classList.remove('active');
  $('recLabel').textContent = t('Start');
  show('recIndicator', false);
  setDeviceSelects(true);
}

async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind) => {
    const cur = sel.value;
    sel.innerHTML = '';
    devs.filter((d) => d.kind === kind).forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || (kind === 'videoinput' ? t('Camera {n}', { n: i + 1 }) : t('Microphone {n}', { n: i + 1 }));
      sel.appendChild(o);
    });
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  };
  const curCam = rec.usePhone ? PHONE : $('selCam').value;
  fill($('selCam'), 'videoinput');
  // Toujours proposée : la caméra du téléphone, par QR code.
  const o = document.createElement('option');
  o.value = PHONE;
  o.textContent = t('Phone (Wi-Fi, QR code)');
  $('selCam').appendChild(o);
  if (curCam === PHONE) $('selCam').value = PHONE;
  fill($('selMic'), 'audioinput');
  rec.hasWebcam = devs.some((d) => d.kind === 'videoinput');
}
const PHONE = '__telephone__';

// Ouvre la caméra en essayant du plus exigeant au plus simple. Si la caméra choisie ne répond pas,
// on prend n'importe quelle caméra disponible plutôt que d'échouer.
async function openStream(camId, micId) {
  const cam = camId ? { deviceId: camId } : {};   // préférence, pas obligation
  const mic = micId ? { deviceId: micId } : {};
  const tries = [
    { video: { ...cam, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: { ...mic, echoCancellation: true, noiseSuppression: true } },
    { video: camId ? cam : true, audio: micId ? mic : true },
    { video: true, audio: true },
  ];
  let lastErr = null;
  for (const c of tries) {
    try { return { stream: await navigator.mediaDevices.getUserMedia(c), micError: null }; }
    catch (e) { lastErr = e; if (e.name === 'NotAllowedError') throw e; }
  }
  // Dernier essai : caméra seule, puis micro à part.
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
  catch (e) { throw e.name === 'NotAllowedError' ? e : lastErr || e; }
  let micError = null;
  try {
    const a = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    a.getAudioTracks().forEach((t) => stream.addTrack(t));
  } catch (e) { micError = e; }
  return { stream, micError };
}

function cameraHelp(e, status) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || status.camera === 'denied') {
    return { text: t('Windows is blocking camera access for Carnet. Open the Windows camera settings and turn on “Let desktop apps access your camera”.'), settings: true };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { text: t('No camera found with this setting. Pick another camera in the list below, or try compatible mode.'), compat: true };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return { text: t('The camera won’t start. Another app may be using it (Teams, Zoom, a browser, the Camera app): close it and try again. If that changes nothing, turn on compatible mode: it uses the old Windows driver and fixes the problem on many built-in webcams.'), compat: true, settings: true };
  }
  return { text: t('The camera won’t start. Try again, pick another camera, or turn on compatible mode.'), compat: true, settings: true };
}

async function showCameraError(e) {
  const status = await window.api.mediaStatus().catch(() => ({ camera: 'unknown' }));
  const help = cameraHelp(e, status);
  const box = $('camMsg');
  box.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = help.text;
  const tech = document.createElement('p');
  tech.className = 'small muted';
  tech.textContent = t('Details: {error} · Windows permission: {perm}', { error: e ? e.name + (e.message ? ': ' + e.message : '') : t('unknown'), perm: status.camera }) + (status.compatCamera ? ' · ' + t('compatible mode on') : '');
  const actions = document.createElement('div');
  actions.className = 'cam-actions';
  const btn = (label, fn, cls = 'btn') => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; actions.appendChild(b); };
  btn(t('Try again'), () => startCamera(), 'btn primary');
  btn(t('Use the phone'), () => { rec.usePhone = true; startCamera(); });
  if (help.settings) btn(t('Windows camera settings'), () => window.api.openCameraSettings());
  if (help.compat || status.compatCamera) {
    btn(status.compatCamera ? t('Turn off compatible mode') : t('Turn on compatible mode'),
      () => { if (confirm(t('Carnet will restart to switch camera mode. Work in progress will be lost. Continue?'))) window.api.setCompatCamera(!status.compatCamera); });
  }
  box.append(p, tech, actions);
  show('camMsg', true);
}

// Webcams that can film at 60 frames per second usually start at 30 (the browser prefers 1080p at 30 over 720p at
// 60): the same camera is asked for at least 50, never below 720p; otherwise it keeps what it gives.
async function upTo60(track) {
  if (!track || !track.applyConstraints) return;
  const s0 = track.getSettings();
  if ((s0.frameRate || 0) >= 50) return;
  let max = 0;
  try { const c = track.getCapabilities(); max = (c.frameRate && c.frameRate.max) || 0; } catch (_) {}
  if (max && max < 50) return;
  try {
    await track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { min: 50, ideal: 60 } });
    const s = track.getSettings();
    if (Math.max(s.width || 0, s.height || 0) < 1280) await track.applyConstraints({ width: { ideal: s0.width || 1920 }, height: { ideal: s0.height || 1080 }, frameRate: { ideal: s0.frameRate || 30 } });
  } catch (_) {}
}

// Light recording: 720p at 30 frames per second, for a computer that cannot compress more without losing frames.
// Turned on by itself after a recording that kept far fewer frames than the camera sent; changeable in Settings.
const recLight = () => { try { return localStorage.getItem('carnet.recLight') === '1'; } catch (_) { return false; } };
const setRecLight = (on) => { try { localStorage.setItem('carnet.recLight', on ? '1' : '0'); } catch (_) {} $('selQuality').value = on ? 'light' : 'full'; };
// With the phone as camera, who records: the phone itself (picture and sound at its full quality, the file sent as
// it goes, whatever this computer's speed) or this computer (the picture it receives, its own microphone).
const recBy = () => { try { return localStorage.getItem('carnet.recBy') === 'pc' ? 'pc' : 'phone'; } catch (_) { return 'phone'; } };
const setRecBy = (v) => { try { localStorage.setItem('carnet.recBy', v === 'pc' ? 'pc' : 'phone'); } catch (_) {} $('selRecBy').value = v === 'pc' ? 'pc' : 'phone'; };
// Fields under the picture: "Recorded by" only with the phone, "Quality" only when this computer records.
function showRecChoices() {
  $('selRecBy').value = recBy();
  $('selQuality').value = recLight() ? 'light' : 'full';
  show('recByField', !!rec.usePhone);
  show('qualityField', !rec.phoneRec);
  show('recByHint', !!rec.phoneRec);
}
const MIC_WARN = 'Microphone unavailable: the recording will have no sound. Pick another microphone in the list.';
function micWarning(text) { $('micWarn').textContent = text || ''; $('micWarn').classList.toggle('hidden', !text); }
async function lighten(track) {
  if (!track || !track.applyConstraints) return;
  try { await track.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }); } catch (_) {}
}

async function startCamera() {
  stopCamera();
  show('camMsg', false);
  micWarning('');
  $('btnRecToggle').disabled = true;
  $('recLabel').textContent = t('Preparing…');
  // Appareils choisis dans les listes (sinon ceux par défaut de Windows).
  const camId = rec.pickedCam ? $('selCam').value : '', micId = rec.pickedMic ? $('selMic').value : '';
  // Pas de webcam sur cet ordinateur : le QR code pour le téléphone s'affiche directement.
  if (!rec.pickedCam && !rec.usePhone) {
    const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (!devs.some((d) => d.kind === 'videoinput')) rec.usePhone = true;
  }
  if (rec.usePhone || camId === PHONE) { await startPhoneCamera(micId); return; }
  if (rec.phoneRec) { rec.phoneRec = false; phoneArm(false); }
  showRecChoices();
  setDeviceSelects(true);
  let opened;
  try {
    opened = await openStream(camId, micId);
    if (recLight()) await lighten(opened.stream.getVideoTracks()[0]);
    else await upTo60(opened.stream.getVideoTracks()[0]);
  } catch (e) {
    $('recLabel').textContent = t('Start');
    try { await listDevices(); } catch (_) {}  // pour pouvoir choisir une autre caméra
    await showCameraError(e);
    return;
  }
  rec.stream = opened.stream;
  checkH264(rec.stream);
  rec.micWarning = opened.micError;
  $('camVideo').srcObject = rec.stream;
  startCamClock();
  // La caméra met un moment à envoyer des images régulières : on attend avant d'autoriser l'enregistrement.
  const stream = rec.stream;
  await waitForSteadyFrames($('camVideo'));
  if (rec.stream !== stream) return; // caméra changée entre-temps
  $('btnRecToggle').disabled = false;
  $('recLabel').textContent = t('Start');
  await listDevices();
  const v = rec.stream.getVideoTracks()[0]?.getSettings().deviceId;
  const a = rec.stream.getAudioTracks()[0]?.getSettings().deviceId;
  if (v) $('selCam').value = v;
  if (a) $('selMic').value = a;
  micWarning(opened.micError ? t(MIC_WARN) : '');
  startMeter();
}

// Attend que la caméra envoie des images à un rythme régulier (fin du gel de démarrage).
function waitForSteadyFrames(video, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    if (!video.requestVideoFrameCallback) return setTimeout(resolve, 1500);
    let last = null, steady = 0;
    const onFrame = (now) => {
      if (last !== null) {
        const gap = now - last;
        steady = gap < 100 ? steady + 1 : 0; // une image toutes les 100 ms au plus
      }
      last = now;
      if (steady >= 15 || now - t0 > timeoutMs) return resolve();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  });
}

function startMeter() {
  if (!rec.stream.getAudioTracks().length) return;
  rec.audioCtx = new AudioContext();
  const src = rec.audioCtx.createMediaStreamSource(rec.stream);
  const an = rec.audioCtx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const data = new Uint8Array(an.fftSize);
  const loop = () => {
    an.getByteTimeDomainData(data);
    let peak = 0;
    for (const x of data) peak = Math.max(peak, Math.abs(x - 128));
    $('meterBar').style.width = Math.min(100, (peak / 128) * 160) + '%';
    rec.meterRaf = requestAnimationFrame(loop);
  };
  loop();
}

// Date et heure en direct sur l'aperçu caméra, comme sur la vidéo finale.
function startCamClock() {
  clearInterval(rec.clock);
  const tick = () => { $('camStamp').textContent = stampLabel(Date.now()); };
  tick();
  rec.clock = setInterval(tick, 1000);
}

function stopCamera() {
  clearInterval(rec.clock);
  stopPhoneArm();
  if (rec.phoneOff) { rec.phoneOff(); rec.phoneOff = null; }
  if (rec.phoneTrack) { window.phoneCam.release(); rec.phoneTrack = null; }
  window.phoneCam.lockSize(false);
  show('phonePanel', false); show('phoneWarn', false); show('rotateBtns', false); show('phoneMode', false);
  $('camVideo').classList.remove('nomirror');
  if (rec.meterRaf) cancelAnimationFrame(rec.meterRaf);
  if (rec.audioCtx) rec.audioCtx.close();
  rec.audioCtx = null;
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  $('camVideo').srcObject = null;
  $('meterBar').style.width = '0';
}

function setDeviceSelects(on) {
  $('selCam').disabled = !on;
  $('selMic').disabled = !on || !!rec.phoneRec; // the phone records: its own microphone
  $('selRecBy').disabled = !on;
  $('selQuality').disabled = !on;
}
$('selRecBy').onchange = () => { setRecBy($('selRecBy').value); startCamera(); };
$('selQuality').onchange = () => { setRecLight($('selQuality').value === 'light'); startCamera(); };
$('selCam').onchange = () => { rec.pickedCam = true; rec.usePhone = $('selCam').value === PHONE; startCamera(); };

// ---------- Caméra du téléphone ----------
// Image du téléphone (par Wi-Fi). Recorded by this computer: with the sound of its microphone. Recorded by the phone:
// the picture here is only the preview, the phone records picture and sound itself (src/phone/index.html).
async function startPhoneCamera(micId) {
  rec.usePhone = true;
  rec.phonePairing = null; // adresse recalculée (le Wi-Fi a pu changer)
  rec.phoneRec = recBy() === 'phone';
  let micStream = null, micError = null;
  if (!rec.phoneRec) {
    phoneArm(false);
    const audio = { echoCancellation: true, noiseSuppression: true, ...(micId && micId !== PHONE ? { deviceId: micId } : {}) };
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
    catch (e) {
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch (e2) { micError = e2; }
    }
  }
  window.phoneCam.setLight(!rec.phoneRec && recLight());
  rec.phoneTrack = window.phoneCam.acquire();
  rec.stream = new MediaStream([rec.phoneTrack, ...(micStream ? micStream.getAudioTracks() : [])]);
  if (!rec.phoneRec) checkH264(rec.stream);
  rec.micWarning = micError;
  $('camVideo').srcObject = rec.stream;
  startCamClock();
  try { await listDevices(); } catch (_) {}
  $('selCam').value = PHONE;
  showRecChoices();
  if (rec.phoneRec) {
    // Only the phone's microphone: shown as such, its level comes from the phone.
    $('selMic').innerHTML = '';
    const o = document.createElement('option');
    o.value = PHONE; o.textContent = t('Phone microphone');
    $('selMic').appendChild(o);
    startPhoneArm();
  } else {
    const a = rec.stream.getAudioTracks()[0]?.getSettings().deviceId;
    if (a) $('selMic').value = a;
    micWarning(micError ? t(MIC_WARN) : '');
    startMeter();
  }
  setDeviceSelects(!rec.countdown);
  show('btnPhoneBack', !!rec.hasWebcam);
  show('rotateBtns', true);
  rec.phoneOff = window.phoneCam.onChange(updatePhoneUi);
  await updatePhoneUi();
}
// Tells the phone that it records (it opens its microphone), again every 3 seconds: a page reloaded or reconnected
// on the phone hears it too. The phone closes the microphone 20 seconds after the last reminder.
function phoneArm(on) { try { window.api.phoneStreamSend({ type: 'arm', on: !!on }); } catch (_) {} }
function startPhoneArm() {
  stopPhoneArm();
  window.phoneCam.resetMic();
  phoneArm(true);
  rec.armTimer = setInterval(() => { if (rec.phoneRec && rec.phoneTrack) phoneArm(true); }, 3000);
  rec.levelOff = window.phoneCam.onLevel((v) => { if (rec.phoneRec && rec.phoneTrack) $('meterBar').style.width = Math.min(100, v * 160) + '%'; });
}
function stopPhoneArm() {
  clearInterval(rec.armTimer); rec.armTimer = null;
  if (rec.levelOff) { rec.levelOff(); rec.levelOff = null; }
}
// Badge de l'aperçu : chemin de l'image, taille et cadence réelle, mis à jour chaque seconde.
function phoneInfo() {
  const i = window.phoneCam.info;
  const what = i.mode === 'direct' ? t('Direct') : t('Fallback mode');
  $('phoneMode').textContent = i.width && i.fps ? `${what} · ${i.width}x${i.height} · ${t('{n} fps', { n: i.fps })}` : what;
  $('phoneMode').title = i.mode === 'direct'
    ? t('Direct video from the phone. Frame rate: frames received in the last second.')
    : t('Direct video does not get through on this network: the phone’s picture comes the same way as the page. Carnet goes back to direct video on its own as soon as it can.');
}
setInterval(() => { if (rec.phoneTrack && window.phoneCam.state === 'live') phoneInfo(); }, 1000);
async function updatePhoneUi() {
  if (!rec.phoneTrack) return;
  const st = window.phoneCam.state, live = st === 'live';
  const onPhone = !!(rec.sess && rec.sess.phone && (rec.sess.state === 'starting' || rec.sess.state === 'recording'));
  const recording = (rec.recorder && rec.recorder.state === 'recording') || onPhone;
  if (rec.phoneRec) {
    const m = window.phoneCam.mic;
    micWarning(m && !m.ok ? t('The phone refuses the microphone: the recording will have no sound. Allow the microphone for the Carnet page on the phone, then tap Stop and Start camera there. Or choose “This computer” under “Recorded by”.') : '');
  }
  $('camVideo').classList.toggle('nomirror', window.phoneCam.facing === 'environment');
  // Rotation : seulement avant l'enregistrement (la taille de l'image est fixée pendant l'enregistrement).
  const r = window.phoneCam.rotation;
  $('rotLabel').textContent = r ? `${r}°` : '';
  $('btnRotL').disabled = $('btnRotR').disabled = !!recording;
  show('phoneMode', live);
  phoneInfo();
  if (recording) {
    // En cours d'enregistrement : on continue (le son est celui de l'ordinateur), l'image revient à la reconnexion.
    // The phone records: it goes on by itself; only the preview is missing.
    $('phoneWarn').textContent = onPhone
      ? t('The picture from the phone is not coming through. The phone goes on recording as long as its page stays open, and sends the rest when it can.')
      : t('The phone is not responding. Recording goes on with the computer’s sound; the picture comes back as soon as the phone reconnects (keep the page open and the screen on).');
    show('phoneWarn', !live);
    return;
  }
  // A message about the last try (recording not started), for a few seconds.
  const notice = rec.notice && Date.now() < rec.notice.until ? rec.notice.text : '';
  $('phoneWarn').textContent = notice;
  show('phoneWarn', !!notice);
  show('phonePanel', !live);
  if (!rec.countdown) {
    $('btnRecToggle').disabled = !live;
    $('recLabel').textContent = live ? t('Start') : t('Waiting for the phone');
  }
  if (live) return;
  if (!rec.phonePairing) {
    const p = await window.phoneCam.pairing();
    rec.phonePairing = p;
    if (p && p.lastContact) rec.phoneContact = p.lastContact;
    rec.phoneShownAt = Date.now();
  }
  drawPairing(rec.phonePairing);
  phoneStatusText();
}
// Où ça en est, d'après le dernier contact du téléphone avec l'ordinateur.
function phoneStatusText() {
  const st = window.phoneCam.state, c = rec.phoneContact;
  const age = c ? Date.now() - c.at : Infinity, recent = age < 120000, k = recent ? c.kind : '';
  let msg;
  if (k === 'old-page') msg = t('The page open on the phone comes from an older version of Carnet: close that tab on the phone, then scan this QR code again.');
  else if (k === 'bad-token') msg = t('The phone is using an old QR code: close the tab on the phone and scan this one.');
  else if ((k === 'frame' || k === 'direct' || k === 'rec') && age < 8000 && st !== 'lost') msg = t('The phone is sending the picture…');
  else if (k === 'page') msg = t('The page is open on the phone: tap “Start camera”.');
  else if (st === 'lost') msg = t('The phone disconnected. It reconnects on its own if the page stayed open; otherwise, scan the QR code again.');
  else if (k === 'no-answer') msg = t('The phone reached the computer, but the connection did not go through. Try again from the phone.');
  else if (k === 'offer' || k === 'answered' || st === 'connecting') msg = t('The phone reached the computer, the picture is on its way…');
  else msg = t('Waiting for the phone…');
  $('phoneStatus').textContent = msg;
  // Échec de la connexion vidéo : explication et détails à copier.
  const d = window.phoneCam.diagnostic;
  show('phoneDiag', !!d && st !== 'live');
  if (d) $('phoneDiagText').textContent = window.phoneCam.explain();
  // Aucune nouvelle du téléphone depuis 25 secondes : aide pour le réseau et le pare-feu.
  const never = !recent && rec.phoneShownAt && Date.now() - rec.phoneShownAt > 25000;
  show('phoneHelp', !!never && st !== 'live');
}
window.api.onPhoneContact((c) => { rec.phoneContact = c; if (rec.phoneTrack) phoneStatusText(); });
setInterval(() => { if (rec.phoneTrack && window.phoneCam.state !== 'live') phoneStatusText(); }, 5000);
$('btnPhoneDiagCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(window.phoneCam.diagnosticText()); showToast(t('Details copied: you can paste them into a message.')); } catch (_) { showToast(t('Could not copy.')); }
};
$('btnPhoneFirewall2').onclick = () => $('btnPhoneFirewall').click();
$('btnPhoneFirewall').onclick = async () => {
  $('btnPhoneFirewall').disabled = true;
  const r = await window.api.phoneAllowFirewall();
  $('btnPhoneFirewall').disabled = false;
  showToast(r.ok ? t('Carnet is now allowed through the Windows firewall. Scan the QR code again with the phone.') : t('The firewall was not changed: {error}', { error: r.error }));
};
function drawPairing(p) {
  if (!p || p.error || !p.url) {
    $('phoneQr').innerHTML = '';
    $('phoneUrl').textContent = p && p.error ? p.error : t('No network found: connect the computer to Wi-Fi.');
    return;
  }
  $('phoneQr').innerHTML = p.svg;
  $('phoneUrl').textContent = t('Without the QR code, type this address in the phone’s browser: {url}', { url: p.url }) + (p.addresses.length > 1 ? ' (' + t('other addresses of the computer: {list}', { list: p.addresses.slice(1).join(', ') }) + ')' : '');
}
$('btnRotL').onclick = () => window.phoneCam.rotate(-90);
$('btnRotR').onclick = () => window.phoneCam.rotate(90);
$('btnPhoneNewCode').onclick = async () => { rec.phonePairing = await window.phoneCam.newCode(); drawPairing(rec.phonePairing); };
$('btnPhoneBack').onclick = () => { rec.usePhone = false; rec.pickedCam = false; startCamera(); };
$('selMic').onchange = () => { rec.pickedMic = true; startCamera(); };

// L'enregistreur démarre tout de suite, mais un compte à rebours de 3 s laisse passer le gel de démarrage.
// Ces 3 s sont retirées automatiquement du clip.
const LEAD = 3;
// H.264 essayé une seconde, sans rien montrer, dès que l'aperçu tourne : utilisé seulement s'il produit vraiment
// de la vidéo (sinon un encodeur absent ou en panne arrêterait l'enregistrement). Une fois par lancement.
let h264Ok = null;
async function checkH264(stream) {
  const type = 'video/webm;codecs=h264';
  if (h264Ok !== null || checkH264.running) return;
  if (!MediaRecorder.isTypeSupported(type)) { h264Ok = false; return; }
  checkH264.running = true;
  try {
    const r = new MediaRecorder(new MediaStream(stream.getVideoTracks()), { mimeType: type, videoBitsPerSecond: 4e6 });
    let bytes = 0, failed = false;
    r.ondataavailable = (e) => { bytes += e.data.size; };
    r.onerror = () => { failed = true; };
    r.start(250);
    await new Promise((res) => setTimeout(res, 1500));
    if (r.state !== 'inactive') r.stop();
    await new Promise((res) => setTimeout(res, 300));
    h264Ok = !failed && bytes > 2000;
  } catch (_) { h264Ok = false; }
  checkH264.running = false;
}
async function startRecording() {
  // H.264 d'abord : encodé par la carte graphique quand elle sait le faire, il tient 1080p à 60 images par
  // seconde sans charger le processeur. Sinon VP8 (plus léger que VP9). Le clip H.264 est rangé en MP4.
  const types = [...(h264Ok ? ['video/webm;codecs=h264,opus'] : []), 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  const vp8 = types.find((t) => /vp8/.test(t));
  // Débit selon la taille et la cadence de l'image (1080p à 60 images/s : 10 Mbit/s ; sinon 6).
  const vt = rec.stream.getVideoTracks()[0], vs = vt ? vt.getSettings() : {};
  const pi = rec.phoneTrack ? window.phoneCam.info : null; // téléphone : taille et cadence réellement reçues
  let w = (pi && pi.width) || vs.width || 1280, h = (pi && pi.height) || vs.height || 720, fps = Math.min(60, (pi && pi.fps) || vs.frameRate || 30);
  if (recLight()) { const k = Math.min(1, 1280 / Math.max(w, h)); w *= k; h *= k; fps = Math.min(fps, 30); } // light recording
  const bitrate = Math.round(Math.min(12e6, Math.max(6e6, w * h * fps * 0.08)));
  rec.lead = 0;
  // L'enregistrement est écrit sur le disque au fur et à mesure (chaque seconde) : rien n'est perdu
  // en cas d'erreur ou de plantage, et un long enregistrement ne remplit pas la mémoire.
  // sess : cet enregistrement-ci (identifiant côté disque, morceaux pas encore écrits, erreur d'écriture).
  const sess = { id: null, chunks: [], diskError: null, chain: Promise.resolve() };
  rec.sess = sess;
  $('btnRecToggle').disabled = true;
  try { sess.id = await window.api.recBegin({ startedAt: Date.now() }); } catch (e) { sess.diskError = e; }
  showDiskWarning(sess);
  if (rec.phoneTrack) { window.phoneCam.lockSize(true); $('btnRotL').disabled = $('btnRotR').disabled = true; } // taille d'image fixe pendant l'enregistrement
  try { rec.recorder = new MediaRecorder(rec.stream, { mimeType, videoBitsPerSecond: bitrate }); }
  catch (_) { h264Ok = false; rec.recorder = new MediaRecorder(rec.stream, { mimeType: vp8, videoBitsPerSecond: bitrate }); } // H.264 refusé : VP8
  rec.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    // Morceaux écrits dans l'ordre. Si l'écriture échoue, ils attendent en mémoire et sont réécrits au morceau suivant.
    sess.chunks.push(e.data);
    if (sess.id) sess.chain = sess.chain.then(() => flushChunks(sess));
  };
  rec.recorder.onstop = finishRecording;
  rec.recorder.onstart = () => { rec.t0 = performance.now(); };
  // Frames the camera really sent during the recording (as shown in the preview), to compare with the file.
  const pv = $('camVideo'), seen = { n: 0, t0: performance.now(), t1: 0 };
  rec.seen = seen;
  const count = () => { if (rec.seen !== seen || !rec.recorder || rec.recorder.state !== 'recording') { seen.t1 = seen.t1 || performance.now(); return; } seen.n++; pv.requestVideoFrameCallback(count); };
  if (pv.requestVideoFrameCallback) pv.requestVideoFrameCallback(count);
  rec.t0 = performance.now();
  rec.recorder.start(1000);
  setDeviceSelects(false);
  $('btnRecToggle').disabled = true;
  $('recLabel').textContent = t('Starting…');
  // Moment réel où l'enregistrement utile commence.
  runCountdown(() => { rec.lead = (performance.now() - rec.t0) / 1000; });
}
// 3, 2, 1 over the picture, then the timer and the Stop button. atZero runs when it reaches zero.
function runCountdown(atZero) {
  show('countdown', true);
  let n = LEAD;
  $('countdown').textContent = n;
  rec.countdown = setInterval(() => {
    n -= 1;
    if (n > 0) { $('countdown').textContent = n; return; }
    clearInterval(rec.countdown);
    rec.countdown = null;
    show('countdown', false);
    atZero();
    rec.startAt = performance.now();
    rec.startedAt = Date.now();
    $('btnRecToggle').disabled = false;
    $('btnRecToggle').classList.add('active');
    $('recLabel').textContent = t('Stop');
    $('recTime').textContent = '0:00';
    show('recIndicator', true);
    rec.timer = setInterval(() => {
      const s = Math.floor((performance.now() - rec.startAt) / 1000);
      $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
  }, 1000);
}

// ---------- Recorded by the phone ----------
// Start and Stop are sent to the phone; it records picture and sound itself and sends the file in pieces, written to
// the disk as they come (src/phonerec.js). After Stop, the window waits for the end of the file, then trims it.
const phoneErrorText = (code) => (code === 'no-camera' ? t('The phone’s camera is not running: tap “Start camera” on the phone, then try again.')
  : code === 'no-recorder' ? t('This phone’s browser cannot record videos. Choose “This computer” under “Recorded by”.')
    : t('The phone could not start recording. Try again, or choose “This computer” under “Recorded by”.'));
async function startPhoneRecording() {
  const sess = { phone: true, id: null, state: 'starting', started: false, received: 0, total: 0, ended: false, reason: null, notice: null };
  rec.sess = sess;
  rec.lead = 0;
  $('btnRecToggle').disabled = true;
  $('recLabel').textContent = t('Starting…');
  setDeviceSelects(false);
  $('btnRotL').disabled = $('btnRotR').disabled = true;
  try { sess.id = await window.api.phoneRecStart({ lead: LEAD, rotation: window.phoneCam.rotation, startedAt: Date.now() }); }
  catch (e) { phoneRecNotStarted(sess, cleanErr(e)); return; }
  if (rec.sess !== sess) return;
  // No news from the phone 7 seconds after Start: it did not get the order (page hidden, Wi-Fi gone).
  sess.startTimer = setTimeout(() => { if (rec.sess === sess && !sess.started) phoneRecNotStarted(sess, t('The phone did not start recording. Check that the Carnet page is open and on screen on the phone, then try again.')); }, 7000);
  runCountdown(() => { if (rec.sess === sess && sess.state === 'starting') sess.state = 'recording'; });
}
// Back to the camera, with the reason over the picture. What the phone may have recorded anyway is kept (deleted
// recordings, 7 days).
function phoneRecNotStarted(sess, msg) {
  if (rec.sess !== sess) return;
  clearTimeout(sess.startTimer);
  if (sess.id) window.api.phoneRecAbandon(sess.id).catch(() => {});
  if (rec.countdown) { clearInterval(rec.countdown); rec.countdown = null; show('countdown', false); }
  clearInterval(rec.timer);
  rec.sess = null;
  show('recIndicator', false);
  $('btnRecToggle').classList.remove('active');
  $('btnRecToggle').disabled = window.phoneCam.state !== 'live';
  $('recLabel').textContent = t('Start');
  setDeviceSelects(true);
  $('btnRotL').disabled = $('btnRotR').disabled = false;
  rec.notice = { text: msg, until: Date.now() + 12000 };
  clearTimeout(rec.warnTimer);
  rec.warnTimer = setTimeout(updatePhoneUi, 12100);
  updatePhoneUi();
}
function stopPhoneRecording(reason) {
  const sess = rec.sess;
  if (!sess || !sess.phone || (sess.state !== 'recording' && sess.state !== 'starting')) return;
  const wasStarting = sess.state === 'starting';
  sess.state = 'stopping';
  clearTimeout(sess.startTimer);
  sess.stopAfter = rec.startAt && !wasStarting ? (performance.now() - rec.startAt) / 1000 : 0;
  if (rec.countdown) { clearInterval(rec.countdown); rec.countdown = null; show('countdown', false); }
  clearInterval(rec.timer);
  if (!reason) window.api.phoneRecStop(sess.id, sess.stopAfter).catch(() => {});
  else sess.notice = reason === 'phone' ? t('The recording was stopped on the phone.')
    : reason === 'interrupted' ? t('The phone stopped recording: its page was hidden or its screen locked. What it recorded until then is kept.')
      : reason === 'error' ? t('The phone stopped recording after an error. What it recorded until then is kept.') : null;
  $('btnRotL').disabled = $('btnRotR').disabled = false;
  stopCamera();
  gotoWait(sess);
}
function gotoWait(sess) {
  show('stepRecord', false); show('stepTrim', false); show('stepFail', false); show('stepWait', true);
  show('btnRecToggle', false); show('btnOk', false); show('btnRetake', false); show('btnSaveCopy', false);
  show('recIndicator', false);
  sess.lastNews = Date.now();
  $('waitNotice').textContent = sess.notice || '';
  show('waitNotice', !!sess.notice);
  drawWait(sess);
  clearInterval(rec.waitTimer);
  rec.waitTimer = setInterval(() => { if (rec.sess === sess && sess.state === 'stopping') drawWait(sess); else clearInterval(rec.waitTimer); }, 1000);
}
function drawWait(sess) {
  const total = Math.max(sess.total || 0, sess.received || 0);
  const all = sess.ended && total && sess.received >= total;
  $('waitBar').style.width = (total ? Math.min(100, Math.round((sess.received / total) * 100)) : 0) + '%';
  $('waitMsg').textContent = all ? t('Everything has arrived. Preparing the recording…')
    : total > sess.received ? t('{received} of {total} received', { received: goMo(sess.received), total: goMo(total) })
      : t('{received} received', { received: goMo(sess.received || 0) });
  // Nothing new for 6 seconds: the phone cannot reach the computer. It keeps the rest; what has arrived can be used.
  const quiet = !all && Date.now() - sess.lastNews > 6000;
  $('waitWarn').textContent = quiet ? t('Nothing has arrived from the phone for a few seconds. It keeps the recording as long as its page stays open, and sends the rest as soon as it reaches the computer again (same Wi-Fi, page on screen).') : '';
  show('waitWarn', quiet);
  show('btnWaitUse', quiet && sess.received > 0);
}
$('btnWaitUse').onclick = async () => {
  const sess = rec.sess;
  if (!sess || !sess.phone || sess.state !== 'stopping') return;
  $('btnWaitUse').disabled = true;
  try {
    const res = await window.api.phoneRecFinishNow(sess.id);
    if (rec.sess === sess && sess.state === 'stopping') { sess.state = 'done'; usePhoneResult(sess, res); }
  } catch (e) { $('waitWarn').textContent = cleanErr(e); show('waitWarn', true); }
  finally { $('btnWaitUse').disabled = false; }
};
// The file from the phone, ready: on to trimming, the start placed after the countdown.
function usePhoneResult(sess, res) {
  clearInterval(rec.waitTimer);
  show('stepWait', false);
  loadWave(res.path);
  const d = res.info.duration;
  const start = Math.max(0, Math.min(res.info.lead || 0, d - 0.3));
  let out = d;
  // Stop reached the phone late (cut off at that moment): the end is placed where Stop was clicked.
  if (Number.isFinite(res.info.stopAfter) && res.info.stopAfter > 0 && d - (start + res.info.stopAfter) > 2) out = Math.min(d, start + res.info.stopAfter + 0.5);
  rec.draft = { file: res.path, url: res.url, duration: d, hasAudio: res.info.hasAudio, in: start, out, recordedAt: rec.startedAt || Date.now(), info: res.info };
  const notes = [];
  if (sess.notice) notes.push(sess.notice);
  if (res.partial) notes.push(t('Only the part that had reached the computer is here. If the rest arrives later, the complete version will be in “Recordings”.'));
  if (!res.info.hasAudio) notes.push(t('This recording has no sound: the phone’s microphone was refused.'));
  $('fpsWarn').textContent = notes.join(' ');
  $('fpsWarn').classList.toggle('hidden', !notes.length);
  gotoTrim();
}
window.api.onPhoneRec((m) => {
  const sess = rec.sess && rec.sess.phone && rec.sess.id === m.id ? rec.sess : null;
  if (sess) sess.lastNews = Date.now();
  if (m.kind === 'progress') {
    if (sess) { sess.received = m.received; sess.total = m.total; sess.ended = sess.ended || m.ended; if (sess.state === 'stopping') drawWait(sess); }
  } else if (m.kind === 'started') {
    if (sess) { sess.started = true; if (Number.isFinite(m.lead)) sess.lead = m.lead; clearTimeout(sess.startTimer); }
  } else if (m.kind === 'error') {
    if (sess && (sess.state === 'starting' || sess.state === 'recording')) phoneRecNotStarted(sess, phoneErrorText(m.error));
  } else if (m.kind === 'ended') {
    if (!sess) return;
    sess.ended = true;
    // The phone ended the recording by itself (page hidden, Stop on the phone): the window follows.
    if (sess.state === 'recording' || sess.state === 'starting') stopPhoneRecording(m.reason === 'stopped' ? 'phone' : m.reason || 'phone');
  } else if (m.kind === 'done') {
    if (sess && (sess.state === 'stopping' || sess.state === 'recording')) { sess.state = 'done'; usePhoneResult(sess, m.result); }
    // Nobody waits for it here (window closed meanwhile, Carnet restarted, recording left on the phone): it is kept.
    else if (!sess && !m.abandoned) showToast(t('A recording from the phone has arrived: it is in “Recordings”.'), t('Open'), () => openRecover(false));
  } else if (m.kind === 'failed') {
    if (sess && sess.state !== 'done') { sess.state = 'failed'; clearInterval(rec.waitTimer); show('stepWait', false); showRecFailure(cleanErr(m.error)); }
  } else if (m.kind === 'complete') {
    showToast(t('The rest of the phone recording has arrived: the complete version is in “Recordings”.'), t('Open'), () => openRecover(false));
  } else if (m.kind === 'empty') {
    if (sess) { if (sess.state === 'stopping') { clearInterval(rec.waitTimer); show('stepWait', false); gotoRecord(); startCamera(); } phoneRecNotStarted(sess, t('The phone recorded nothing.')); }
  }
});

// Écrit sur le disque les morceaux en attente, dans l'ordre.
async function flushChunks(sess) {
  while (sess.id && sess.chunks.length) {
    try {
      const r = await window.api.recChunk(sess.id, await sess.chunks[0].arrayBuffer());
      sess.chunks.shift();
      // Le dossier des clips a refusé l'écriture : la suite est partie dans un dossier de secours.
      if (r && r.moved) { sess.moved = r.moved; showDiskWarning(sess); }
      if (sess.diskError) { sess.diskError = null; showDiskWarning(sess); }
    } catch (e) {
      if (!sess.diskError) { sess.diskError = e; showDiskWarning(sess); }
      return;
    }
  }
}
function showDiskWarning(sess) {
  if (rec.sess !== sess) return;
  const m = $('camMsg');
  if (sess.diskError) {
    m.textContent = (sess.id ? t('Cannot write to the disk right now, the recording goes on in memory: {error}', { error: cleanErr(sess.diskError) }) : t('The recording cannot be written to the disk, it is kept in memory (keep it to a few minutes): {error}', { error: cleanErr(sess.diskError) }));
    m.classList.add('warn');
    show('camMsg', true);
  } else if (sess.moved) {
    m.textContent = t('The usual folder refuses writing: the rest of the recording is written in “{dir}”. Nothing is lost, the pieces are joined back together when you stop.', { dir: sess.moved });
    m.classList.add('warn', 'info');
    show('camMsg', true);
  } else if (m.classList.contains('warn')) { m.classList.remove('warn'); show('camMsg', false); }
}
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Disque (ou mémoire en secours) -> fichier prêt à découper.
async function saveSession(sess) {
  if (sess.id) {
    await sess.chain;
    await flushChunks(sess);
    if (sess.chunks.length) throw new Error(t('Part of the recording could not be written to the disk: {error}', { error: cleanErr(sess.diskError) }));
    return window.api.recEnd(sess.id);
  }
  const saved = await window.api.saveRecording(await new Blob(sess.chunks, { type: 'video/webm' }).arrayBuffer());
  sess.chunks = [];
  return saved;
}
async function prepareRecording() {
  busy(t('Preparing the recording…'));
  try {
    const saved = await saveSession(rec.sess);
    show('stepFail', false);
    loadWave(saved.path);
    const d = saved.info.duration;
    // Début du clip placé après le compte à rebours, pour ne pas garder le gel de démarrage.
    const start = Math.max(0, Math.min(rec.lead || 0, d - 0.3));
    rec.draft = { file: saved.path, url: saved.url, duration: d, hasAudio: saved.info.hasAudio, in: start, out: d, recordedAt: rec.startedAt, info: saved.info };
    checkSmoothness(saved.info);
    gotoTrim();
  } catch (e) {
    // Jamais de retour à la caméra qui ferait perdre l'enregistrement : il reste sur le disque, avec des choix.
    showRecFailure(cleanErr(e));
  } finally {
    busy(null);
  }
}
async function finishRecording() {
  clearInterval(rec.timer);
  if (rec.seen && !rec.seen.t1) rec.seen.t1 = performance.now();
  $('btnRotL').disabled = $('btnRotR').disabled = false;
  stopCamera();
  await prepareRecording();
}
// The file kept far fewer frames than the camera sent: the computer could not compress the video fast enough
// (playback then looks jerky while the preview was smooth). The next recordings are made lighter, and it is said.
function checkSmoothness(info) {
  const s = rec.seen, warn = $('fpsWarn');
  warn.classList.add('hidden');
  if (!s || !info || !info.realFps || !s.t1) return;
  const cam = s.n / Math.max(0.5, (s.t1 - s.t0) / 1000), got = info.realFps;
  if (cam < 20 || got >= cam * 0.75) return;
  const n = { got: Math.round(got), cam: Math.round(cam) };
  if (!recLight()) {
    setRecLight(true);
    warn.textContent = t('This recording kept {got} frames per second while the camera sent {cam}: the computer could not compress the video fast enough. The next recordings will be in 720p at 30 frames per second, which is lighter. You can change this in Settings.', n);
  } else {
    warn.textContent = t('This recording kept {got} frames per second while the camera sent {cam}: the computer could not compress the video fast enough, even in 720p. Closing other programs while recording helps.', n);
  }
  warn.classList.remove('hidden');
}

function showRecFailure(msg) {
  show('stepRecord', false); show('stepTrim', false); show('stepFail', true);
  show('btnRecToggle', false); show('btnOk', false); show('btnRetake', false); show('btnSaveCopy', false);
  $('recFailMsg').textContent = msg;
  $('btnFailCopy').disabled = !rec.sess;
  $('btnFailRetry').disabled = false;
}
$('btnFailRetry').onclick = () => { $('btnFailRetry').disabled = true; if (rec.sess && rec.sess.phone) retryPhone(rec.sess); else prepareRecording(); };
// Recorded by the phone, could not be prepared: tried again from what is on the disk.
async function retryPhone(sess) {
  busy(t('Preparing the recording…'));
  try {
    const file = await window.api.recRecover(sess.id);
    const v = await window.api.loadVideo(file);
    show('stepFail', false);
    sess.state = 'done';
    usePhoneResult(sess, { path: v.path, url: v.url, info: { ...v.info, lead: Number.isFinite(sess.lead) ? sess.lead : LEAD } });
  } catch (e) { showRecFailure(cleanErr(e)); } finally { busy(null); }
}
// Copie depuis l'écran d'échec : la partie sur le disque, plus ce qui est resté en mémoire.
$('btnFailCopy').onclick = async () => {
  const sess = rec.sess;
  if (!sess) return;
  if (sess.phone || !sess.chunks.length) { saveCopy(sess.id); return; }
  try {
    const token = await window.api.recCopyBegin(sess.id);
    if (!token) return;
    busy(t('Copying the recording…'));
    for (const c of sess.chunks) await window.api.recCopyChunk(token, await c.arrayBuffer());
    const out = await window.api.recCopyEnd(token);
    showToast(t('Full copy saved: {file}', { file: out }));
  } catch (e) { alert(t('The copy could not be made.') + '\n' + cleanErr(e)); } finally { busy(null); }
};
$('btnSaveCopy').onclick = () => rec.draft && saveCopy(rec.draft.file);
async function saveCopy(idOrFile) {
  try {
    busy(t('Copying the recording…'));
    const out = await window.api.recSaveCopy(idOrFile);
    if (out) showToast(t('Copy saved: {file}', { file: out }));
  } catch (e) { alert(t('The copy could not be made.') + '\n' + cleanErr(e)); } finally { busy(null); }
}

$('btnRecToggle').onclick = () => {
  const s = rec.sess;
  if (s && s.phone && (s.state === 'starting' || s.state === 'recording')) { if (s.state === 'recording') stopPhoneRecording(); return; }
  if (rec.recorder && rec.recorder.state === 'recording') rec.recorder.stop();
  else if (rec.stream) { if (rec.phoneRec && rec.phoneTrack) startPhoneRecording(); else startRecording(); }
};

// ---------- Découpe ----------
const trimVideo = $('trimVideo');
let trimPlayingUntil = null;

async function gotoTrim() {
  show('stepRecord', false); show('stepTrim', true);
  show('btnRecToggle', false); show('btnOk', true);
  show('btnRetake', !rec.editing);
  show('btnSaveCopy', true);
  if (!rec.editing) $('modalTitle').textContent = rec.mode === 'new' ? t('Trim the video') : t('Trim the clip');
  trimVideo.dataset.url = '';
  const d = rec.draft;
  await setSrc(trimVideo, d.url);
  if (rec.draft !== d) return; // "Start over" or Cancel meanwhile
  if (!d.duration && isFinite(trimVideo.duration)) {
    d.duration = trimVideo.duration;
    d.out = d.out || trimVideo.duration;
  }
  await seekEl(trimVideo, d.in);
  if (rec.draft !== d) return;
  drawTrim();
}

function drawTrim() {
  const d = rec.draft; const D = d.duration || 1;
  const pIn = (d.in / D) * 100, pOut = (d.out / D) * 100;
  $('hIn').style.left = pIn + '%';
  $('hOut').style.left = pOut + '%';
  $('trimSel').style.left = pIn + '%';
  $('trimSel').style.width = (pOut - pIn) + '%';
  $('trimHead').style.left = (trimVideo.currentTime / D) * 100 + '%';
  $('tIn').textContent = fmt(d.in);
  $('tOut').textContent = fmt(d.out);
  $('tLen').textContent = fmt(d.out - d.in);
}

(function trimDrag() {
  const bar = $('trimBar');
  let mode = null;
  const toT = (e) => {
    const r = bar.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * rec.draft.duration;
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!rec.draft) return;
    mode = e.target.id === 'hIn' ? 'in' : e.target.id === 'hOut' ? 'out' : 'head';
    bar.setPointerCapture(e.pointerId);
    trimVideo.pause(); trimPlayingUntil = null;
    move(e);
  });
  const move = (e) => {
    if (!mode) return;
    const t = toT(e), d = rec.draft;
    if (mode === 'in') d.in = clamp(t, 0, d.out - 0.2);
    else if (mode === 'out') d.out = clamp(t, d.in + 0.2, d.duration);
    trimVideo.currentTime = mode === 'head' ? t : mode === 'in' ? d.in : d.out;
    drawTrim();
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', () => (mode = null));
})();

trimVideo.addEventListener('timeupdate', () => {
  if (trimPlayingUntil !== null && trimVideo.currentTime >= trimPlayingUntil) {
    trimVideo.pause(); trimPlayingUntil = null;
  }
  if (rec.draft) drawTrim();
});
$('btnTrimPlay').onclick = async () => {
  if (!trimVideo.paused) { trimVideo.pause(); trimPlayingUntil = null; return; }
  const d = rec.draft;
  if (trimVideo.currentTime < d.in || trimVideo.currentTime >= d.out - 0.05) await seekEl(trimVideo, d.in);
  trimPlayingUntil = d.out;
  trimVideo.play();
};

function closeRecorder() {
  if (rec.countdown) { clearInterval(rec.countdown); rec.countdown = null; show('countdown', false); }
  // Closed while the phone records or sends: it ends, and goes to the deleted recordings (kept 7 days).
  const ps = rec.sess && rec.sess.phone ? rec.sess : null;
  if (ps && ps.state !== 'done' && ps.state !== 'failed') { clearTimeout(ps.startTimer); window.api.phoneRecAbandon(ps.id).catch(() => {}); ps.state = 'abandoned'; }
  clearInterval(rec.waitTimer);
  show('stepWait', false);
  if (rec.phoneRec) phoneArm(false);
  if (rec.recorder && rec.recorder.state === 'recording') {
    // Annulé pendant l'enregistrement : ce qui a été filmé est quand même terminé sur le disque, puis mis
    // dans les enregistrements supprimés (récupérable 7 jours).
    const sess = rec.sess;
    rec.recorder.onstop = async () => {
      try { const saved = await saveSession(sess); window.api.deleteRecording(saved.path); } catch (_) {}
    };
    rec.recorder.stop();
  }
  clearInterval(rec.timer);
  stopCamera();
  trimVideo.pause();
  trimVideo.removeAttribute('src'); trimVideo.load(); trimVideo.dataset.url = '';
  $('modal').classList.add('hidden');
  rec.recorder = null;
}

$('btnCancel').onclick = () => {
  // Un long enregistrement n'est pas annulé sur un simple Échap.
  const ps = rec.sess && rec.sess.phone ? rec.sess : null;
  const recording = (rec.recorder && rec.recorder.state === 'recording') || !!(ps && ps.state === 'recording');
  const long = recording ? (performance.now() - (rec.startAt || performance.now())) / 1000
    : ps && ps.state === 'stopping' ? ps.stopAfter || 0
      : (!rec.editing && rec.draft ? rec.draft.duration : 0);
  if (long > 60 && !confirm(t('Cancel this {len} recording? It can be recovered for 7 days in “Recordings”.', { len: fmt(long) }))) return;
  // Un nouvel enregistrement annulé passe dans les enregistrements supprimés (gardés 7 jours).
  if (!rec.editing && rec.draft) window.api.deleteRecording(rec.draft.file);
  rec.draft = null;
  const wasNew = rec.mode === 'new';
  closeRecorder();
  if (wasNew && !state.source) showScreen('journal');
};
$('btnRetake').onclick = async () => {
  if (rec.draft) window.api.deleteRecording(rec.draft.file);
  rec.draft = null;
  trimVideo.pause();
  gotoRecord();
  await startCamera();
};
$('btnOk').onclick = async () => {
  const d = rec.draft; if (!d) return;
  if (rec.mode === 'new') {
    // L'enregistrement devient la vidéo de travail. Le découpage devient des parties supprimées.
    const D = d.duration;
    const name = recName(d.recordedAt);
    // Sujet choisi dans les notes : la vidéo en porte le titre, et Gemini sait de quoi tu voulais parler.
    const intention = window.journalUI ? window.journalUI.notesChoice() : null;
    const v = { path: d.file, url: d.url, name, recorded: true, recordedAt: d.recordedAt, info: { ...d.info, duration: D, hasVideo: true },
      intention, titleHint: intention ? window.journalUI.subjectTitle(intention) : null };
    const cuts = [];
    if (d.in > 0.04) cuts.push({ start: 0, end: d.in });
    if (D - d.out > 0.04) cuts.push({ start: d.out, end: D });
    rec.draft = null;
    closeRecorder();
    await setSource(v, cuts);
    return;
  }
  const at = parseTime($('insertAt').value);
  if (at === null) { alert(t('Invalid insertion point. Expected format: 1:23.4')); return; }
  const atClamped = clamp(at, 0, state.source.info.duration);
  let clip;
  if (rec.editing) {
    clip = rec.editing;
    Object.assign(clip, { in: d.in, out: d.out, at: atClamped });
  } else {
    clip = { id: nextId++, file: d.file, url: d.url, duration: d.duration, hasAudio: d.hasAudio, fps: d.info ? d.info.fps : null, in: d.in, out: d.out, at: atClamped, recordedAt: d.recordedAt };
    state.clips.push(clip);
    autoRemoveSilences(clip.id, clip.file, clip.hasAudio, clip.in, clip.out);
  }
  if (!rec.editing && window.journalUI && !state.source.intention) state.source.intention = window.journalUI.notesChoice();
  rec.draft = null;
  closeRecorder();
  state.selectedId = clip.id;
  renderClips();
  const s = segments().find((x) => x.type === 'clip' && x.clip.id === clip.id);
  if (s) await seek(s.offset);
};

$('btnRecord').onclick = () => openRecorder();
$('btnNew').onclick = $('btnNewEmpty').onclick = newVideo;

// ---------- Export ----------
// Après « Ajouter au journal » : le travail est enregistré, on repart d'un montage vide.
function clearEditorAfterJournal() {
  state.source = null; state.clips = []; state.cuts = []; state.chapters = []; state.selectedId = null; state.sel = null;
  players.forEach((p) => { p.pause(); p.removeAttribute('src'); p.load(); p.dataset.url = ''; p.dataset.ready = ''; });
  $('titleInput').value = ''; $('titleInput').disabled = true;
  enableEditing(false);
  renderClips();
}

// ---------- Écrans ----------
function showScreen(name) {
  $('journalScreen').classList.toggle('hidden', name !== 'journal');
  $('editorScreen').classList.toggle('hidden', name !== 'editor');
  if (name === 'journal') pause();
  else renderTimeline();
}
$('btnBackJournal').onclick = () => showScreen('journal');

// Date de la vidéo pour le journal : enregistrement Carnet, sinon premier clip, sinon maintenant.
function videoDateForJournal() {
  if (state.source && state.source.recordedAt) return state.source.recordedAt;
  const ts = state.clips.map((c) => c.recordedAt).filter(Boolean);
  return ts.length ? Math.min(...ts) : Date.now();
}

$('btnExport').onclick = () => doExport(false);
$('btnAddJournal').onclick = () => doExport(true);

async function doExport(toJournal) {
  if (!state.source) return;
  pause();
  $('exportBar').style.width = '0';
  $('exportMsg').textContent = '0 %';
  $('exportTitle').textContent = t('Exporting');
  show('btnShowFile', false); show('btnExportClose', false);
  show('btnExportCancel', true);
  $('btnExportCancel').disabled = false;
  let shown = false;
  const showModal = () => { if (!shown) { shown = true; $('exportModal').classList.remove('hidden'); } };
  window.__exportShow = showModal;
  showModal(); // tout de suite, pour pouvoir annuler
  try {
    const out = await window.api.exportVideo({
      source: state.source.path,
      sourceInfo: state.source.info,
      // Liste finale déjà découpée (clips insérés et parties supprimées)
      title: $('titleInput').value.trim(),
      toJournal,
      date: videoDateForJournal(),
      intention: state.source.intention || null,
      chapters: placedChapters().map((x) => ({ t: x.T, title: x.ch.title || t('Untitled') })),
      segments: segments().map((s) => ({
        type: s.type, start: s.start, end: s.end, label: segStamp(s),
        clip: s.type === 'clip' ? { file: s.clip.file, hasAudio: s.clip.hasAudio, fps: s.clip.fps, label: stampLabel(s.clip.recordedAt) } : null,
      })),
    });
    show('btnExportCancel', false);
    if (!out) { $('exportModal').classList.add('hidden'); return; }
    if (toJournal) {
      // Retour au journal, sur la nouvelle entrée : la transcription et l'analyse se font en arrière-plan.
      $('exportModal').classList.add('hidden');
      clearEditorAfterJournal();
      showScreen('journal');
      if (window.journalUI) window.journalUI.openEntryByFile(out);
      return;
    }
    showModal();
    $('exportBar').style.width = '100%';
    $('exportTitle').textContent = t('Export finished');
    $('exportMsg').textContent = out;
    show('btnShowFile', true); show('btnExportClose', true);
    $('btnShowFile').onclick = () => window.api.showInFolder(out);
  } catch (e) {
    showModal();
    show('btnExportCancel', false);
    if (String(e.message || e).includes('EXPORT_ANNULE')) {
      $('exportModal').classList.add('hidden');
      showToast(t('Export cancelled. The edit is intact.'));
      return;
    }
    $('exportTitle').textContent = t('Export failed');
    $('exportMsg').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 900);
    show('btnExportClose', true);
  }
}
window.api.onExportProgress((p) => {
  if (window.__exportShow) window.__exportShow();
  $('exportBar').style.width = (p * 100).toFixed(1) + '%';
  $('exportMsg').textContent = Math.round(p * 100) + ' %';
});
$('btnExportClose').onclick = () => $('exportModal').classList.add('hidden');
$('btnExportCancel').onclick = () => {
  $('btnExportCancel').disabled = true;
  $('exportTitle').textContent = t('Cancelling…');
  window.api.exportCancel();
};

// ---------- Raccourcis ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  // Écran Journal : seul N (nouvelle entrée) est actif, le reste concerne le montage.
  if (!$('journalScreen').classList.contains('hidden') && $('modal').classList.contains('hidden')) {
    if (e.key === 'n' || e.key === 'N') newVideo();
    return;
  }
  if (!$('modal').classList.contains('hidden')) {
    if (e.key === 'Escape') $('btnCancel').click();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') seek(state.T - (e.shiftKey ? 5 : 1));
  else if (e.key === 'ArrowRight') seek(state.T + (e.shiftKey ? 5 : 1));
  else if ((e.key === 'r' || e.key === 'R') && state.source) openRecorder();
  else if (e.key === 'n' || e.key === 'N') newVideo();
  else if ((e.key === 'm' || e.key === 'M') && state.source) addChapter();
  else if (e.key === 'c' || e.key === 'C') { if (state.source) setCutMode(!state.cutMode); }
  else if (e.key === 'i' || e.key === 'I') markIn();
  else if (e.key === 'o' || e.key === 'O') markOut();
  else if (e.key === ',') stepFrame(-1);
  else if (e.key === '.') stepFrame(1);
  else if (e.key === 'Escape') setCutMode(false);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) cutSelection();
  else if (e.key === 'Delete' && state.selectedId) deleteSelected();
});

// ---------- Enregistrements gardés ----------
// Enregistrements pas encore utilisés dans un export ou le journal : interrompus (Carnet fermé ou planté),
// pas pu être préparés, ou abandonnés dans un montage non exporté. Proposés au démarrage, et toujours
// accessibles par « Enregistrements ».
const goMo = (n) => (n > 1e9 ? t('{n} GB', { n: (n / 1e9).toLocaleString(i18n.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t('{n} MB', { n: Math.max(1, Math.round(n / 1e6)) }));
async function openRecover(auto) {
  let list = [];
  try { list = await window.api.recPending(); } catch (_) { return; }
  if (auto) list = list.filter((r) => r.status !== 'deleted');
  if (auto && !list.length) return;
  const state_ = {
    recording: t('interrupted: Carnet was closed or crashed during the recording'),
    error: t('could not be prepared'),
    ready: t('not used yet in an export or the journal'),
    deleted: t('deleted'),
  };
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('recoverList').innerHTML = list.length ? list.map((r) => {
    const left = r.status === 'deleted' ? Math.max(0, Math.ceil((7 * 864e5 - (Date.now() - (r.deletedAt || r.at))) / 864e5)) : null;
    return `<div class="recover-item" data-id="${r.id}">
      <div class="ri-main"><b>${esc(recName(r.startedAt))}</b>
        <span class="muted small">${r.duration ? fmt(r.duration) + ' · ' : ''}${goMo(r.size || 0)} · ${esc(state_[r.status] || r.status)}${left !== null ? ', ' + tn(left, 'permanently deleted in {n} day', 'permanently deleted in {n} days') : ''}</span></div>
      <div class="ri-actions">
        <button class="btn small-btn" data-act="open">${t('Open as a video')}</button>
        ${state.source ? `<button class="btn small-btn" data-act="clip">${t('Insert as a clip here')}</button>` : ''}
        <button class="btn small-btn" data-act="copy">${t('Save a copy…')}</button>
        ${r.status !== 'deleted' ? `<button class="btn small-btn danger" data-act="forget">${t('Delete')}</button>` : ''}
      </div></div>`;
  }).join('') : `<p class="muted">${t('No recordings waiting.')}</p>`;
  $('recoverList').querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => recoverAction(b.closest('[data-id]').dataset.id, b.dataset.act)));
  show('recoverModal', true);
}
async function recoverAction(id, act) {
  try {
    if (act === 'copy') { await saveCopy(id); return; }
    if (act === 'forget') {
      if (!confirm(t('Delete this recording? It can still be recovered here for 7 days.'))) return;
      await window.api.recForget(id); openRecover(false); return;
    }
    busy(t('Preparing the recording…'));
    const file = await window.api.recRecover(id);
    busy(null);
    show('recoverModal', false);
    if (act === 'open') { showScreen('editor'); await openFile(file); return; }
    // Inséré comme clip à la tête de lecture de la vidéo ouverte.
    const v = await window.api.loadVideo(file);
    const clip = { id: nextId++, file: v.path, url: v.url, duration: v.info.duration, hasAudio: v.info.hasAudio, fps: v.info.fps, in: 0, out: v.info.duration, at: clamp(sourceTimeAtCurrent(), 0, state.source.info.duration), recordedAt: null };
    state.clips.push(clip);
    state.selectedId = clip.id;
    showScreen('editor');
    renderClips();
    autoRemoveSilences(clip.id, clip.file, clip.hasAudio, clip.in, clip.out);
  } catch (e) {
    alert(t('Could not recover this recording.') + '\n' + cleanErr(e) + '\n\n' + t('You can still save a copy of it.'));
  } finally { busy(null); }
}
$('btnRecoverClose').onclick = () => show('recoverModal', false);

// ---------- Exporter toutes les données ----------
// Un seul fichier au choix : texte lisible (.md), données brutes (.json), ou archive (.zip) avec vidéos en option.
let dataExporting = false;
async function openDataExport() {
  show('dataProgress', false);
  $('btnDataGo').disabled = false;
  show('dataModal', true);
  try {
    const i = await window.api.dataExportInfo();
    $('dataInfo').textContent = `${tn(i.entries, '{n} video in the journal', '{n} videos in the journal')} · ${tn(i.sujets, '{n} subject', '{n} subjects')}`;
    $('dataVideosLabel').textContent = t('Journal videos ({n}, {size})', { n: i.videos, size: goMo(i.videosBytes) });
    $('dataRecsLabel').textContent = t('Kept recordings not used yet ({n}, {size})', { n: i.recordings, size: goMo(i.recordingsBytes) });
    $('dataVideos').disabled = !i.videos; if (!i.videos) $('dataVideos').checked = false;
    $('dataRecs').disabled = !i.recordings; if (!i.recordings) $('dataRecs').checked = false;
  } catch (_) {}
}
$('btnJDataExport').onclick = openDataExport;
$('btnSetDataExport').onclick = openDataExport;
// Cocher une option de l'archive choisit l'archive.
['dataVideos', 'dataRecs'].forEach((id) => $(id).addEventListener('change', () => { document.querySelector('input[name=dataFormat][value=zip]').checked = true; }));
$('btnDataCancel').onclick = () => {
  if (dataExporting) { window.api.dataExportCancel(); return; }
  show('dataModal', false);
};
window.api.onDataExportProgress((p) => {
  $('dataBar').style.width = `${Math.round(p.pct * 100)}%`;
  $('dataProgressText').textContent = `${Math.round(p.pct * 100)} % · ${p.file}`;
});
$('btnDataGo').onclick = async () => {
  const format = document.querySelector('input[name=dataFormat]:checked').value;
  const opts = { format, videos: format === 'zip' && $('dataVideos').checked, recordings: format === 'zip' && $('dataRecs').checked };
  dataExporting = true;
  $('btnDataGo').disabled = true;
  if (opts.videos || opts.recordings) { $('dataBar').style.width = '0%'; $('dataProgressText').textContent = t('Preparing…'); show('dataProgress', true); }
  try {
    const out = await window.api.dataExport(opts);
    if (out) { show('dataModal', false); showToast(t('Data exported: {file}', { file: out })); window.api.showInFolder(out); }
  } catch (e) {
    alert(t('The export could not be done.') + '\n' + cleanErr(e));
  } finally {
    dataExporting = false;
    $('btnDataGo').disabled = false;
    show('dataProgress', false);
  }
};
$('btnJRecs').onclick = () => openRecover(false);

// ---------- Démarrage ----------
renderClips();
window.api.initialFile().then((f) => f && openFile(f));
setTimeout(() => openRecover(true), 1500);
