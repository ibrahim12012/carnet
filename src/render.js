// Fonctions FFmpeg, sans dépendance à Electron (testables avec Node seul).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');

// signal (facultatif) : { cancelled, kill } ; signal.kill() arrête FFmpeg tout de suite.
// onSpawn (optional): receives the process, for background work run at a lower priority.
function run(ffmpeg, args, onStderr, signal, onSpawn) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    if (onSpawn) onSpawn(p);
    if (signal) {
      signal.kill = () => { try { p.kill('SIGKILL'); } catch (_) {} };
      if (signal.cancelled) signal.kill();
    }
    let err = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onStderr) onStderr(s);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stderr: err }));
  });
}

// Lit durée, taille, fps, format vidéo et présence d'audio à partir de la sortie de "ffmpeg -i".
async function probe(ffmpeg, file) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file]);
  const info = { duration: 0, width: 1280, height: 720, fps: 30, vcodec: '', hasAudio: false, hasVideo: false };
  const d = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
  const v = stderr.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/);
  if (v) { info.hasVideo = true; info.width = +v[1]; info.height = +v[2]; }
  const c = stderr.match(/Stream #.*Video:\s*(\w+)/);
  if (c) info.vcodec = c[1].toLowerCase();
  const f = stderr.match(/Stream #.*Video:.*?([\d.]+) fps/);
  if (f) info.fps = Math.min(60, Math.max(10, parseFloat(f[1])));
  info.hasAudio = /Stream #.*Audio:/.test(stderr);
  const a = stderr.match(/Stream #.*Audio:\s*(\w+)/);
  info.acodec = a ? a[1].toLowerCase() : '';
  // Video marked as turned (phone filmed upright, or turned in Carnet): the size is the one shown, turned.
  const rot = stderr.match(/displaymatrix: rotation of (-?[\d.]+) degrees/);
  info.rotation = rot ? ((Math.round(-parseFloat(rot[1]) / 90) * 90) % 360 + 360) % 360 : 0;
  if (info.rotation === 90 || info.rotation === 270) [info.width, info.height] = [info.height, info.width];
  // Chapitres intégrés au fichier (MP4 exporté par Carnet, ou autre logiciel).
  info.chapters = [];
  const re = /Chapter #\d+:\d+: start ([\d.]+), end [\d.]+(?:\s*Metadata:\s*title\s*:[ \t]*([^\r\n]*))?/g;
  let m;
  while ((m = re.exec(stderr))) info.chapters.push({ t: parseFloat(m[1]), title: (m[2] || '').trim() });
  return info;
}

// Réécrit un enregistrement du navigateur (webm sans durée) pour qu'il soit lisible et découpable.
async function fixRecording(ffmpeg, input, output) {
  const r = await run(ffmpeg, ['-hide_banner', '-y', '-i', input, '-c', 'copy', output]);
  if (r.code !== 0) throw new Error(t('Converting the recording failed'));
  return probe(ffmpeg, output);
}

// Construit la liste des morceaux dans l'ordre : source, clip, source, clip, ..., source.
function buildSegments(sourceDuration, clips) {
  const sorted = [...clips].sort((a, b) => a.at - b.at);
  const segs = [];
  let pos = 0;
  for (const c of sorted) {
    const at = Math.max(0, Math.min(sourceDuration, c.at));
    if (at - pos > 0.04) segs.push({ type: 'src', start: pos, end: at });
    if (c.out - c.in > 0.04) segs.push({ type: 'clip', clip: c, start: c.in, end: c.out });
    pos = at;
  }
  if (sourceDuration - pos > 0.04) segs.push({ type: 'src', start: pos, end: sourceDuration });
  return segs;
}

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

// Texte en bas à droite du clip (date et heure). Les ":" et "'" doivent être échappés pour FFmpeg.
function stampFilter(label, fontFile) {
  if (!label) return '';
  const text = label.replace(/\\/g, '\\\\').replace(/'/g, "’").replace(/:/g, '\\:');
  const font = fontFile ? `fontfile='${fontFile.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : '';
  return `,drawtext=${font}text='${text}':fontcolor=white:fontsize=h/24:box=1:boxcolor=black@0.45:boxborderw=8:x=w-tw-h/30:y=h-th-h/30`;
}

// Assemble la vidéo finale.
// segments (prioritaire) : liste déjà découpée [{ type: 'src'|'clip', start, end, clip: { file, hasAudio, label } }]
// sinon clips : [{ file, in, out, at, hasAudio, label }]
// Fichier de métadonnées FFmpeg avec les chapitres (lus par VLC, YouTube Studio, etc.).
function chaptersMetadata(chapters, total) {
  const esc = (x) => String(x).replace(/[=;#\\\n]/g, (c) => '\\' + c);
  const list = [...chapters].sort((a, b) => a.t - b.t).filter((c) => c.t < total);
  let out = ';FFMETADATA1\n';
  list.forEach((c, i) => {
    const start = Math.round(c.t * 1000);
    const end = Math.round((i + 1 < list.length ? list[i + 1].t : total) * 1000);
    if (end > start) out += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start}\nEND=${end}\ntitle=${esc(c.title)}\n`;
  });
  return out;
}

async function exportVideo(ffmpeg, { source, sourceInfo, clips = [], segments, chapters = [], title = '', output, onProgress, fontFile, legacy = false, signal = null }) {
  const W = even(sourceInfo.width), H = even(sourceInfo.height);
  const segs = (segments || buildSegments(sourceInfo.duration, clips)).filter((s) => s.end - s.start > 0.04);
  if (!segs.length) throw new Error(t('The final video is empty.'));
  // Output frame rate: the highest among the video and the clips it uses (a clip filmed at 60 stays smooth in a
  // video at 30), rounded to the closest standard rate. A recording made in Carnet has a variable rate (one frame
  // per frame received from the phone): 57.3 on average gives 59.94, not a video at 57.3 frames per second.
  const want = Math.max(sourceInfo.fps || 30, ...segs.filter((s) => s.type === 'clip').map((s) => Math.min(60, (s.clip && s.clip.fps) || 0)));
  const F = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60].reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  const total = segs.reduce((s, x) => s + (x.end - x.start), 0);

  // -reinit_filter 0 : si la résolution change en cours de vidéo (fréquent avec les webcams),
  // FFmpeg ne reconstruit pas tout le graphe (ce qui perdait des morceaux et arrêtait l'export).
  // Le filtre scale de chaque morceau s'adapte tout seul à la nouvelle taille.
  const IN = (f) => ['-reinit_filter', '0', '-i', f];
  const inputs = IN(source);
  const fileIndex = new Map();
  for (const s of segs) {
    if (s.type === 'clip' && !fileIndex.has(s.clip.file)) {
      fileIndex.set(s.clip.file, fileIndex.size + 1);
      inputs.push(...IN(s.clip.file));
    }
  }

  const vfmt = `fps=${F},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
  const afmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const parts = [];
  const labels = [];
  const idxOf = (s) => (s.type === 'src' ? 0 : fileIndex.get(s.clip.file));
  const audioOf = (s) => (s.type === 'src' ? sourceInfo.hasAudio : s.clip.hasAudio !== false);

  // Chaque fichier est préparé une seule fois (cadence, taille, date incrustée, format du son), puis découpé.
  // Les morceaux ne font ensuite que recaler le temps : ils ne gardent aucune image en mémoire.
  // (Avant, chaque morceau avait sa propre chaîne de traitement : des centaines de chaînes en 1080p
  // gardaient chacune des images, et l'export manquait de mémoire.)
  const byInput = new Map();
  segs.forEach((s, i) => { const k = idxOf(s); if (!byInput.has(k)) byInput.set(k, []); byInput.get(k).push(i); });
  const vIn = new Map(), aIn = new Map(); // indice du morceau -> étiquette de son flux découpé
  for (const [idx, list] of byInput) {
    const first = segs[list[0]];
    const stamp = stampFilter(first.label || (first.clip && first.clip.label), fontFile);
    const hasA = audioOf(first);
    parts.push(`[${idx}:v]${vfmt}${stamp}[n${idx}v]`);
    if (hasA) parts.push(`[${idx}:a]${afmt}[n${idx}a]`);

    const ordered = list.every((i, n) => n === 0 || segs[i].start >= segs[list[n - 1]].end - 1e-6);
    if (!legacy && ordered) {
      // Découpe en un seul passage : chaque image ne va que dans son morceau.
      const pts = [...new Set(list.flatMap((i) => [segs[i].start, segs[i].end]).map((t) => +t.toFixed(3)))].filter((t) => t > 0).sort((x, y) => x - y);
      const owner = (k) => { const at = k === 0 ? 0 : pts[k - 1]; return list.find((i) => Math.abs(+segs[i].start.toFixed(3) - at) < 1e-6); };
      const cut = (kind, filter) => {
        const n = pts.length + 1;
        const outs = Array.from({ length: n }, (_, k) => `[s${idx}${kind}${k}]`);
        parts.push(pts.length ? `[n${idx}${kind}]${filter}=timestamps=${pts.join('|')}${outs.join('')}` : `[n${idx}${kind}]${kind === 'v' ? 'null' : 'anull'}${outs[0]}`);
        for (let k = 0; k < n; k++) {
          const o = owner(k);
          if (o === undefined) parts.push(`${outs[k]}${kind === 'v' ? 'nullsink' : 'anullsink'}`);
          else (kind === 'v' ? vIn : aIn).set(o, `${outs[k]}`);
        }
      };
      cut('v', 'segment');
      if (hasA) cut('a', 'asegment');
    } else {
      // Méthode classique : une copie du flux par morceau, coupée avec trim.
      const vs = list.map((i) => `[t${idx}v${i}]`), as = list.map((i) => `[t${idx}a${i}]`);
      parts.push(`[n${idx}v]split=${list.length}${vs.join('')}`);
      if (hasA) parts.push(`[n${idx}a]asplit=${list.length}${as.join('')}`);
      list.forEach((i, n) => {
        const st = segs[i].start.toFixed(3), en = segs[i].end.toFixed(3);
        vIn.set(i, `${vs[n]}trim=start=${st}:end=${en},`);
        if (hasA) aIn.set(i, `${as[n]}atrim=start=${st}:end=${en},`);
      });
    }
  }

  segs.forEach((s, i) => {
    parts.push(`${vIn.get(i)}setpts=PTS-STARTPTS[v${i}]`);
    if (audioOf(s)) parts.push(`${aIn.get(i)}asetpts=PTS-STARTPTS[a${i}]`);
    else parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${(s.end - s.start).toFixed(3)},${afmt}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${segs.length}:v=1:a=1[outv][outa]`);

  let metaFile = null;
  const meta = [];
  if (chapters.length) {
    metaFile = path.join(os.tmpdir(), `carnet-chapitres-${Date.now()}.txt`);
    fs.writeFileSync(metaFile, chaptersMetadata(chapters, total), 'utf8');
    const metaIdx = inputs.filter((x) => x === '-i').length;
    inputs.push('-i', metaFile);
    meta.push('-map_metadata', String(metaIdx), '-map_chapters', String(metaIdx));
  }

  // Le graphe de filtres est écrit dans un fichier : avec beaucoup de coupes (silences retirés),
  // il dépasserait la longueur maximale d'une ligne de commande Windows (32 767 caractères).
  const graphFile = path.join(os.tmpdir(), `carnet-graphe-${Date.now()}.txt`);
  fs.writeFileSync(graphFile, parts.join(';\n'), 'utf8');

  const args = ['-hide_banner', '-y', ...inputs,
    '-filter_complex_script', graphFile,
    '-map', '[outv]', '-map', '[outa]', ...meta, ...(title ? ['-metadata', `title=${title}`] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output];

  if (signal && signal.cancelled) throw Object.assign(new Error(t('Export cancelled')), { cancelled: true });
  const r = await run(ffmpeg, args, (s) => {
    const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
    if (m && onProgress && total > 0) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      onProgress(Math.min(1, t / total));
    }
  }, signal);
  if (metaFile) fs.rmSync(metaFile, { force: true });
  if (signal && signal.cancelled) {
    fs.rmSync(graphFile, { force: true });
    throw Object.assign(new Error(t('Export cancelled')), { cancelled: true });
  }
  fs.rmSync(graphFile, { force: true });
  if (r.code !== 0) {
    // On garde les lignes qui disent ce qui ne va pas, plutôt que les statistiques de fin.
    const lines = r.stderr.split(/\r?\n/).filter((l) => /error|invalid|fail|cannot|could not|unable|not found|no such|impossible/i.test(l) && !/^\s*(frame|size|video:)/.test(l));
    const err = new Error([...new Set(lines)].slice(-6).join('\n') || r.stderr.slice(-600));
    err.log = r.stderr;
    throw err;
  }
  return { duration: total };
}

// Niveau sonore toutes les `step` secondes, de 0 (silence, -60 dB ou moins) à 1 (0 dB).
// Lit une liste de chapitres au format YouTube : une ligne par chapitre, "0:00 Intro", "1:02:30 Fin".
function parseChaptersText(text) {
  const out = [];
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.trim().match(/^\(?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?)\)?\s*[-–:|]?\s*(.*)$/);
    if (!m) continue;
    const t = m[1].replace(',', '.').split(':').reduce((a, x) => a * 60 + parseFloat(x), 0);
    out.push({ t, title: m[2].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

function waveform(ffmpeg, file, step = 0.05) {
  return new Promise((resolve, reject) => {
    const rate = 8000;
    const per = Math.round(rate * step);
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const levels = [];
    let sum = 0, n = 0, carry = null;
    p.stdout.on('data', (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) carry = buf.subarray(len);
      for (let i = 0; i < len; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        sum += v * v; n++;
        if (n === per) {
          const db = 10 * Math.log10(sum / n + 1e-12);
          levels.push(Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * 1000) / 1000);
          sum = 0; n = 0;
        }
      }
    });
    p.on('error', reject);
    p.stderr.on('data', () => {});
    p.on('close', () => {
      if (n > 0) levels.push(Math.max(0, Math.min(1, (10 * Math.log10(sum / n + 1e-12) + 60) / 60)));
      resolve({ step, levels });
    });
  });
}

// Son d'une vidéo, mono et compressé pour l'envoi à Gemini (environ 2 Mo pour 10 minutes à 24 kb/s).
// Le débit baisse pour les longues vidéos afin de rester sous la taille maximale d'une requête.
async function extractVoice(ffmpeg, video, outBase, duration, onSpawn) {
  const maxBytes = 14 * 1024 * 1024; // le base64 ajoute un tiers : on reste sous 20 Mo par requête
  const kbps = Math.max(8, Math.min(24, Math.floor((maxBytes * 8) / Math.max(1, duration) / 1000)));
  const tries = [
    { ext: '.ogg', mime: 'audio/ogg', args: ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'voip'] },
    { ext: '.mp3', mime: 'audio/mp3', args: ['-c:a', 'libmp3lame', '-b:a', `${Math.max(16, kbps)}k`] },
  ];
  let last = '';
  for (const t of tries) {
    const out = outBase + t.ext;
    const r = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', ...t.args, out], null, null, onSpawn);
    if (r.code === 0) return { file: out, mimeType: t.mime };
    last = r.stderr.slice(-300);
  }
  throw new Error(t('Cannot extract the sound: {why}', { why: last }));
}

// Frames really in a video file, from the timestamps of its packets (nothing is decoded): count, average rate and
// longest gap. A recording that kept fewer frames than the camera sent shows it here.
function frameStats(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'], { windowsHide: true });
    const ts = [];
    let rest = '', tb = 1 / 1000;
    p.stdout.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        if (l.startsWith('#tb')) { const m = l.match(/(\d+)\/(\d+)/); if (m) tb = m[1] / m[2]; }
        else if (/^\d/.test(l)) { const pts = +l.split(',')[2]; if (Number.isFinite(pts)) ts.push(pts * tb); }
      }
    });
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', () => {
      ts.sort((a, b) => a - b);
      const span = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0;
      let gap = 0;
      for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
      resolve({ frames: ts.length, realFps: span > 0 ? (ts.length - 1) / span : 0, longestGap: gap });
    });
  });
}

// ---------- Progress reel ----------
// Text for drawtext: ":" and "\" escaped, "'" replaced by a typographic one; expansion=none keeps "%" as it is.
const dtText = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
const dtFont = (f) => (f ? `fontfile='${f.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : '');

// Splits a text into lines of at most `max` characters, at the spaces; `lines` lines at most (the last one then
// ends with "…").
function wrapText(text, max, lines = 5) {
  // French spacing: « », : ; ! ? and % stay on the line of the word next to them.
  const words = String(text || '').replace(/[ \t\r\n]+/g, ' ').trim().replace(/ ([»:;!?%])/g, ' $1').replace(/« /g, '« ').split(' ').filter(Boolean);
  const out = [];
  let cur = '';
  for (let w of words) {
    while (w.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(w.slice(0, max)); w = w.slice(max); }
    if (!w) continue;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/[\s.,;:!?…]*$/, '') + '…'; }
  return out;
}

// A card: lines of text, centred, on the background colour of Carnet. lines: [{ text, size, color, gap }].
function cardFilter(lines, { W, H, F, duration, fontFile }) {
  const list = lines.filter((l) => String(l.text || '').trim());
  const total = list.reduce((s, l) => s + (l.gap || 0) + Math.round(l.size * 1.3), 0);
  let y = Math.round((H - total) / 2);
  const draws = list.map((l) => {
    y += l.gap || 0;
    const d = `drawtext=${dtFont(fontFile)}expansion=none:text='${dtText(l.text)}':fontcolor=${l.color || 'white'}:fontsize=${l.size}:x=(w-text_w)/2:y=${y}`;
    y += Math.round(l.size * 1.3);
    return d;
  });
  return [`color=c=0x1b1c1f:s=${W}x${H}:r=${F}:d=${duration.toFixed(2)}`, ...draws, 'format=yuv420p',
    'fade=t=in:st=0:d=0.3', `fade=t=out:st=${Math.max(0, duration - 0.3).toFixed(2)}:d=0.3`].join(',');
}

// Puts cards and moments of videos one after the other in a 1280x720 MP4. Each piece is made on its own (same size,
// rate and sound format), then they are joined without being compressed again. A moment that cannot be read
// (video damaged) is left out.
// parts: [{ type: 'card', lines, duration } | { type: 'clip', file, start, duration, hasAudio, label }]
async function reel(ffmpeg, { parts, output, fontFile, onProgress, signal = null, W = 1280, H = 720, F = 30 }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-reel-'));
  const total = parts.reduce((s, p) => s + p.duration, 0) || 1;
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(F), '-video_track_timescale', '15360',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
  const afmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const cancelled = () => Object.assign(new Error(t('Export cancelled')), { cancelled: true });
  const files = [], skipped = [];
  let done = 0;
  try {
    for (const [i, p] of parts.entries()) {
      if (signal && signal.cancelled) throw cancelled();
      const out = path.join(tmp, `p${String(i).padStart(3, '0')}.mp4`);
      const D = p.duration.toFixed(3), fadeOut = Math.max(0, p.duration - 0.4).toFixed(2);
      let args;
      if (p.type === 'card') {
        args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', cardFilter(p.lines, { W, H, F, duration: p.duration, fontFile }),
          '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-t', D, ...enc, out];
      } else {
        const label = p.label ? `,drawtext=${dtFont(fontFile)}expansion=none:text='${dtText(p.label)}':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.55:boxborderw=14:x=40:y=40` : '';
        const v = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${F},format=yuv420p${label},fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.4[v]`;
        const a = p.hasAudio ? `[0:a]${afmt},apad,afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut}:d=0.4[a]` : 'anullsrc=r=48000:cl=stereo[a]';
        args = ['-hide_banner', '-y', '-ss', p.start.toFixed(3), '-t', D, '-i', p.file, '-filter_complex', `${v};${a}`, '-map', '[v]', '-map', '[a]', '-t', D, ...enc, out];
      }
      const r = await run(ffmpeg, args, (s) => {
        const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m && onProgress) onProgress(Math.min(0.99, (done + Math.min(p.duration, (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]))) / total));
      }, signal);
      if (signal && signal.cancelled) throw cancelled();
      if (r.code !== 0 || !fs.existsSync(out)) {
        if (p.type === 'clip') { skipped.push(p.file); done += p.duration; continue; }
        const err = new Error(r.stderr.split(/\r?\n/).filter((l) => /error|invalid|fail|cannot|unable|no such/i.test(l)).slice(-4).join('\n') || r.stderr.slice(-600));
        err.log = r.stderr;
        throw err;
      }
      files.push(out);
      done += p.duration;
    }
    if (!files.length) throw new Error(t('The final video is empty.'));
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    const r = await run(ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output], null, signal);
    if (signal && signal.cancelled) throw cancelled();
    if (r.code !== 0) { const err = new Error(r.stderr.slice(-600)); err.log = r.stderr; throw err; }
    if (onProgress) onProgress(1);
    return { duration: done, skipped };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { run, extractVoice, parseChaptersText, waveform, probe, fixRecording, buildSegments, exportVideo, frameStats, wrapText, reel };
