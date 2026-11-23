// Transcription locale avec whisper.cpp (gratuit, hors ligne, sur le processeur).
// Installation au premier usage : programme depuis GitHub, modèle depuis Hugging Face.
const { app, net } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');

const MODELS = {
  rapide: { file: 'ggml-base-q5_1.bin', size: '60 MB', label: 'Fast' },
  precis: { file: 'ggml-small-q5_1.bin', size: '190 MB', label: 'Accurate' },
};
const MODEL_URL = (f) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;
const BIN_ASSET = 'whisper-bin-x64.zip';
const BIN_FALLBACK = `https://github.com/ggml-org/whisper.cpp/releases/download/b5454/${BIN_ASSET}`;

const dir = () => path.join(app.getPath('userData'), 'whisper');
const modelPath = (key) => path.join(dir(), 'models', MODELS[key].file);

function findExe(root) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  let fallback = null;
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/^whisper-cli(\.exe)?$/i.test(e.name)) return p;
      else if (/^main\.exe$/i.test(e.name)) fallback = p;
    }
  }
  return fallback;
}

function status(settings) {
  const exe = findExe(path.join(dir(), 'bin'));
  const models = Object.fromEntries(Object.keys(MODELS).map((k) => [k, fs.existsSync(modelPath(k))]));
  const model = settings.whisperModel && models[settings.whisperModel] ? settings.whisperModel : Object.keys(models).find((k) => models[k]) || null;
  return { installed: !!exe && !!model, exe: !!exe, models, model, auto: settings.autoTranscribe !== false, catalog: MODELS };
}

// Télécharge une URL vers un fichier, avec progression (0 à 1).
async function download(url, dest, onProgress) {
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(t('Download failed ({status}): {url}', { status: res.status, url }));
  const total = +res.headers.get('content-length') || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    if (total && onProgress) onProgress(got / total);
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, dest);
}

// Cherche le zip Windows dans les dernières versions de whisper.cpp (toutes n'en publient pas).
async function binaryUrl() {
  try {
    const res = await net.fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20', { headers: { Accept: 'application/vnd.github+json' } });
    if (res.ok) {
      for (const rel of await res.json()) {
        const a = (rel.assets || []).find((x) => x.name === BIN_ASSET);
        if (a) return a.browser_download_url;
      }
    }
  } catch (_) {}
  return BIN_FALLBACK;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    if (opts.onSpawn) opts.onSpawn(p);
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (opts.onStderr) opts.onStderr(String(d)); if (err.length > 100000) err = err.slice(-50000); });
    p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500) || `code ${code}`))));
  });
}

async function install(modelKey, onProgress) {
  const binDir = path.join(dir(), 'bin');
  if (!findExe(binDir)) {
    onProgress({ step: 'Whisper program', pct: 0 });
    const zip = path.join(dir(), BIN_ASSET);
    await download(await binaryUrl(), zip, (p) => onProgress({ step: 'Whisper program', pct: p }));
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.mkdirSync(binDir, { recursive: true });
    const q = (s) => s.replace(/'/g, "''");
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(binDir)}' -Force`]);
    fs.rmSync(zip, { force: true });
    if (!findExe(binDir)) throw new Error(t('The whisper program is not in the downloaded archive.'));
  }
  if (!fs.existsSync(modelPath(modelKey))) {
    const step = t('{label} model ({size})', { label: t(MODELS[modelKey].label), size: t(MODELS[modelKey].size) });
    onProgress({ step, pct: 0 });
    await download(MODEL_URL(MODELS[modelKey].file), modelPath(modelKey), (p) => onProgress({ step, pct: p }));
  }
}

// Transcrit une vidéo : extrait le son en 16 kHz mono, lance whisper-cli, renvoie le JSON.
// language: 'auto' = whisper detects the language spoken in each video (the interface language does not matter).
async function transcribe({ ffmpeg, video, modelKey, language = 'auto', onProgress, onSpawn }) {
  const exe = findExe(path.join(dir(), 'bin'));
  if (!exe) throw new Error(t('whisper is not installed.'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-whisper-'));
  const wav = path.join(work, 'audio.wav');
  const outBase = path.join(work, 'out');
  try {
    onProgress({ step: 'Extracting the sound', pct: 0 });
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { onSpawn });
    // Portable modeste : on laisse un cœur libre pour que l'ordinateur reste utilisable.
    const threads = Math.max(1, Math.min(8, os.cpus().length - 1));
    onProgress({ step: 'Transcription', pct: 0 });
    await run(exe, ['-m', modelPath(modelKey), '-f', wav, '-l', language, '-t', String(threads), '-oj', '-of', outBase, '-pp', '-np'], {
      cwd: path.dirname(exe),
      onSpawn,
      onStderr: (s) => {
        const m = s.match(/progress\s*=\s*(\d+)%/g);
        if (m) onProgress({ step: 'Transcription', pct: parseInt(m[m.length - 1].match(/\d+/)[0], 10) / 100 });
      },
    });
    return fs.readFileSync(outBase + '.json', 'utf8');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { MODELS, status, install, transcribe };
