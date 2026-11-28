const { app, BrowserWindow, ipcMain, dialog, session, shell, systemPreferences, net, Tray, Menu, Notification, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const render = require('./render');
const whisper = require('./whisper');
const journal = require('./journal');
const memory = require('./memory');
const i18n = require('./i18n');
const { t, tn } = i18n;

const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
const IS_MAC = process.platform === 'darwin';

let win = null;
// Caméra du téléphone (QR code, vidéo par Wi-Fi) : voir phonecam.js.
const phone = require('./phonecam').setup({ app, ipcMain, getWin: () => win });
let pendingFile = null;
let pendingLink = null;

// Liens carnet://entree/<id>?t=<secondes> (dans Journal.md) : ouvrent l'entrée au bon moment.
function linkFromArgv(argv) {
  // carnet:// ; les anciens liens raccord:// marchent aussi.
  const a = argv.find((x) => /^(carnet|raccord):\/\//i.test(x));
  if (!a) return null;
  const m = a.match(/^(?:carnet|raccord):\/\/entree\/([^/?#]+)\/?(?:\?t=(\d+(?:\.\d+)?))?/i);
  return m ? { id: decodeURIComponent(m[1]), t: m[2] ? parseFloat(m[2]) : null } : null;
}
for (const scheme of ['carnet', 'raccord']) {
  if (process.defaultApp) app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1] || '.')]);
  else app.setAsDefaultProtocolClient(scheme);
}

// L'app s'appelait Raccord : au premier lancement de Carnet, on reprend ses réglages
// (dossier du journal, clé Gemini, whisper installé, clips enregistrés).
(function migrateFromRaccord() {
  try {
    const now = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'Raccord');
    if (fs.existsSync(path.join(now, 'settings.json')) || !fs.existsSync(path.join(old, 'settings.json'))) return;
    fs.mkdirSync(now, { recursive: true });
    fs.copyFileSync(path.join(old, 'settings.json'), path.join(now, 'settings.json'));
    for (const d of ['whisper', 'clips']) {
      const from = path.join(old, d), to = path.join(now, d);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        try { fs.renameSync(from, to); } catch (_) { fs.cpSync(from, to, { recursive: true }); }
      }
    }
  } catch (_) {}
})();

// Réglages de l'app (userData/settings.json).
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const settings = readSettings();
// Language of the app (English unless chosen otherwise in Settings).
i18n.setLang(settings.lang || 'en');
ipcMain.on('get-language', (e) => { e.returnValue = i18n.lang; });
// Mode caméra compatible : certaines webcams intégrées ne marchent qu'avec l'ancien pilote Windows (DirectShow).
// Une seule option « disable-features » (une deuxième remplacerait la première) :
// - WebRtcHideLocalIpsWithMdns : la caméra du téléphone a besoin de la vraie adresse de l'ordinateur dans la
//   connexion WebRTC ; masquée derrière un nom « .local », beaucoup de téléphones ne la trouvent pas et la
//   vidéo ne passe jamais (comme dans OmniCam).
// - MediaFoundationVideoCapture : mode compatible pour les webcams (Réglages caméra), sous Windows seulement.
app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns', ...(settings.compatCamera && process.platform === 'win32' ? ['MediaFoundationVideoCapture'] : [])].join(','));

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => {
    const ext = path.extname(a).slice(1).toLowerCase();
    return VIDEO_EXT.includes(ext) && fs.existsSync(a);
  }) || null;
}

// Police utilisée pour la date incrustée dans les clips.
function findFont() {
  const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const candidates = process.platform === 'win32'
    ? [path.join(winFonts, 'segoeuib.ttf'), path.join(winFonts, 'segoeui.ttf'), path.join(winFonts, 'arial.ttf')]
    : [
      // Mac (macOS 10.15 and later keep Arial in Supplemental), then Linux.
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/Library/Fonts/Arial.ttf',
      '/System/Library/Fonts/Helvetica.ttc',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

function clipsDir() {
  const d = path.join(app.getPath('userData'), 'clips');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Cherche un fichier de chapitres à côté de la vidéo : "nom-chapitres.txt" (créé par Carnet à l'export),
// "nom_chapitres.txt", "nom chapitres.txt" ou "nom.txt".
function findChaptersFile(file) {
  const p = path.parse(file);
  const names = [`${p.name}-chapters.txt`, `${p.name}_chapters.txt`, `${p.name} chapters.txt`, `${p.name}-chapitres.txt`, `${p.name}_chapitres.txt`, `${p.name} chapitres.txt`, `${p.name}.txt`];
  let list = [];
  try { list = fs.readdirSync(p.dir); } catch (_) { return null; }
  const lower = new Map(list.map((n) => [n.toLowerCase(), n]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return path.join(p.dir, hit);
  }
  return null;
}

async function loadVideo(file) {
  const info = await render.probe(ffmpeg, file);
  // Chapitres : fichier texte à côté de la vidéo en priorité, sinon ceux intégrés au fichier.
  let chapters = [], chaptersFrom = null;
  const txt = findChaptersFile(file);
  if (txt) {
    try {
      chapters = render.parseChaptersText(fs.readFileSync(txt, 'utf8'));
      if (chapters.length) chaptersFrom = path.basename(txt);
    } catch (_) {}
  }
  if (!chapters.length && info.chapters.length) { chapters = info.chapters; chaptersFrom = t('video file'); }
  return { path: file, url: pathToFileURL(file).href, name: path.basename(file), info, chapters, chaptersFrom };
}

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
function createWindow() {
  // Mac: started at login for the reminder, Carnet was only in the menu bar; its window brings back the Dock icon.
  if (IS_MAC && app.dock && !app.dock.isVisible()) { try { app.dock.show(); } catch (_) {} }
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#1b1c1f',
    icon: ICON,
    title: 'Carnet',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Window closed while Carnet stays in the notification area (daily reminder): a recording in progress is closed
  // the same way as when Carnet quits, so that it is kept on the disk and offered back.
  win.on('closed', () => {
    win = null;
    for (const id of [...openRecs.keys()]) closeRec(id);
  });
}
// Shows the window, or opens it again when it was closed (Carnet in the notification area).
function showWindow(nav) {
  if (!win || win.isDestroyed()) {
    if (nav) pendingNav = nav;
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (nav) send('journal-go', nav);
}
let pendingNav = null;
ipcMain.handle('initial-nav', () => { const n = pendingNav; pendingNav = null; return n; });

// Started with the computer for the daily reminder: no window until the person opens Carnet. Windows passes
// --background; a Mac says whether it opened Carnet at login.
function startedInBackground() {
  if (process.argv.includes('--background')) return true;
  if (!IS_MAC) return false;
  try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { return false; }
}
if (process.platform === 'win32') app.setAppUserModelId('fr.chef.carnet');

// Mac: a video opened from the Finder (Open With, a double click) and a carnet:// link arrive as events, not in the
// command line, sometimes before the app is ready.
function openFromSystem(file, link) {
  if (win && !win.isDestroyed()) {
    const go = () => {
      if (!win || win.isDestroyed()) return;
      if (file) win.webContents.send('open-file', file);
      if (link) win.webContents.send('open-entry', link);
    };
    showWindow();
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go);
    else go();
    return;
  }
  if (file) pendingFile = file;
  if (link) pendingLink = link;
  if (app.isReady()) createWindow();
}
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (VIDEO_EXT.includes(path.extname(file).slice(1).toLowerCase())) openFromSystem(file, null);
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  const l = linkFromArgv([url]);
  if (l) openFromSystem(null, l);
});

// Mac menu bar: the usual menus (copy and paste in the text fields go through the Edit menu), without Reload, which
// would close the recording window.
// The labels are those of macOS in each language ("Mac menu · Edit" in the dictionaries: "Edit" alone is already a
// button of Carnet, translated differently).
function menuT(label) {
  const key = 'Mac menu · ' + label, v = t(key);
  return v === key ? label : v;
}
function appMenu() {
  if (!IS_MAC) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Carnet', submenu: [
      { role: 'about', label: menuT('About Carnet') },
      { type: 'separator' },
      { role: 'hide', label: menuT('Hide Carnet') },
      { role: 'hideOthers', label: menuT('Hide Others') },
      { role: 'unhide', label: menuT('Show All') },
      { type: 'separator' },
      { role: 'quit', label: menuT('Quit Carnet') },
    ] },
    { label: menuT('Edit'), submenu: [
      { role: 'undo', label: menuT('Undo') },
      { role: 'redo', label: menuT('Redo') },
      { type: 'separator' },
      { role: 'cut', label: menuT('Cut') },
      { role: 'copy', label: menuT('Copy') },
      { role: 'paste', label: menuT('Paste') },
      { role: 'selectAll', label: menuT('Select All') },
    ] },
    { label: menuT('View'), submenu: [
      { role: 'resetZoom', label: menuT('Actual Size') },
      { role: 'zoomIn', label: menuT('Zoom In'), accelerator: 'Command+=' },
      { role: 'zoomOut', label: menuT('Zoom Out') },
    ] },
    { label: menuT('Window'), role: 'window', submenu: [
      { role: 'minimize', label: menuT('Minimize') },
      { role: 'zoom', label: menuT('Zoom') },
      { role: 'close', label: menuT('Close Window') },
      { type: 'separator' },
      { role: 'front', label: menuT('Bring All to Front') },
    ] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Clic droit > Ouvrir avec, quand l'app est déjà ouverte.
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    const l = linkFromArgv(argv);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (f) win.webContents.send('open-file', f);
      if (l) win.webContents.send('open-entry', l);
    } else {
      // Carnet was only in the notification area: the window opens on the file or the link.
      pendingFile = f;
      pendingLink = l;
      createWindow();
    }
  });

  app.whenReady().then(() => {
    // Caméra et micro autorisés pour l'app.
    const allowed = ['media', 'mediaKeySystem', 'videoCapture', 'audioCapture'];
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.includes(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.includes(perm));
    // (On a Mac, the file or the link may already have come by open-file or open-url.)
    pendingFile = fileFromArgv(process.argv) || pendingFile;
    pendingLink = linkFromArgv(process.argv) || pendingLink;
    appMenu();
    // Mac: title bar, menus and dialogs dark like the rest of Carnet, whatever the system setting.
    if (IS_MAC) nativeTheme.themeSource = 'dark';
    applyReminder();
    const background = startedInBackground() && reminder().on && !pendingFile && !pendingLink;
    if (!background) createWindow();
    else if (IS_MAC && app.dock) { try { app.dock.hide(); } catch (_) {} }
    // Mac: a click on the Dock icon opens the window again.
    app.on('activate', () => showWindow());
  });

  // With the daily reminder, Carnet stays in the notification area when its window is closed. A Mac app stays open
  // (in the Dock) until it is quit.
  app.on('window-all-closed', () => { if (!IS_MAC && (!reminder().on || quitting)) app.quit(); });
}
let quitting = false;
app.on('before-quit', () => { quitting = true; });

ipcMain.handle('initial-link', () => {
  const l = pendingLink;
  pendingLink = null;
  return l;
});

ipcMain.handle('initial-file', () => {
  const f = pendingFile;
  pendingFile = null;
  return f;
});

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: t('Open a video'),
    properties: ['openFile'],
    filters: [{ name: t('Videos'), extensions: VIDEO_EXT }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('load-video', (_e, file) => loadVideo(file));

// Niveau sonore d'un fichier, gardé en mémoire pour ne pas le recalculer.
const waveCache = new Map();
ipcMain.handle('waveform', async (_e, file) => {
  if (!waveCache.has(file)) {
    const p = render.waveform(ffmpeg, file);
    waveCache.set(file, p);
    // Un échec n'est pas gardé en mémoire : le prochain appel réessaie.
    p.then((w) => { if (!w.levels.length) waveCache.delete(file); }, () => waveCache.delete(file));
  }
  return waveCache.get(file);
});

// État des autorisations du système (Windows ou macOS) pour la caméra et le micro.
ipcMain.handle('media-status', () => {
  const get = (t) => {
    try { return systemPreferences.getMediaAccessStatus(t); } catch (_) { return 'unknown'; }
  };
  return { camera: get('camera'), microphone: get('microphone'), compatCamera: !!settings.compatCamera, platform: process.platform };
});
// Mac: macOS asks the person once whether Carnet may use the camera and the microphone, before the first recording.
// Afterwards, the choice is in System Settings > Privacy & Security.
ipcMain.handle('ask-media-access', async () => {
  if (!IS_MAC) return true;
  for (const m of ['camera', 'microphone']) {
    try { if (systemPreferences.getMediaAccessStatus(m) === 'not-determined') await systemPreferences.askForMediaAccess(m); } catch (_) {}
  }
  return true;
});
ipcMain.handle('open-camera-settings', (_e, what) => shell.openExternal(IS_MAC
  ? `x-apple.systempreferences:com.apple.preference.security?${what === 'microphone' ? 'Privacy_Microphone' : 'Privacy_Camera'}`
  : what === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy-webcam'));
ipcMain.handle('set-compat-camera', (_e, on) => {
  writeSettings({ ...readSettings(), compatCamera: !!on });
  app.relaunch();
  app.exit(0);
});

// Reçoit l'enregistrement de la caméra, l'écrit sur disque et le rend lisible.
// ---------- Export de toutes les données ----------
// Trois formats, chacun en un seul fichier : texte lisible (.md), données brutes (.json),
// ou archive (.zip) avec le texte, les données et, si demandé, les vidéos.
const { ZipWriter } = require('./zipwriter');
const safeSettings = () => { const { geminiKey, geminiKeyEnc, ...rest } = settings; return { ...rest, geminiKey: geminiKey ? 'not exported' : null }; };
const instructionsText = () => { try { return journalDir() ? journal.readInstructions(journalDir(), DEFAULT_INSTRUCTIONS) : ''; } catch (_) { return ''; } };
const fileSize = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
const journalVideoFiles = () => (journalDir() ? data.entries.map((e) => ({ name: e.file, file: path.join(journalDir(), e.file) })).filter((x) => fs.existsSync(x.file)) : []);
const keptRecordingFiles = () => recs().filter((r) => r.status !== 'used').map((r) => [r.file, ...(r.file ? [] : partsOf(r))]).flat().filter((f) => f && fs.existsSync(f)).map((f) => ({ name: path.basename(f), file: f }));
function dataJson() {
  return JSON.stringify({ app: 'Carnet', format: 1, exportedAt: new Date().toISOString(), settings: safeSettings(), instructions: instructionsText(), journal: data, enregistrements: recs() }, null, 1);
}
ipcMain.handle('data-export-info', () => {
  const v = journalVideoFiles(), r = keptRecordingFiles();
  return {
    entries: data.entries.length, sujets: data.sujets.length,
    videos: v.length, videosBytes: v.reduce((t, x) => t + fileSize(x.file), 0),
    recordings: r.length, recordingsBytes: r.reduce((t, x) => t + fileSize(x.file), 0),
  };
});
let dataExportCancelled = false;
ipcMain.handle('data-export-cancel', () => { dataExportCancelled = true; });
ipcMain.handle('data-export', async (_e, { format = 'texte', videos = false, recordings = false } = {}) => {
  const ext = { texte: 'md', json: 'json', zip: 'zip' }[format] || 'md';
  const label = { md: t('Text'), json: t('JSON data'), zip: t('ZIP archive') }[ext];
  const res = await dialog.showSaveDialog(win, {
    title: t('Export all of Carnet’s data'),
    defaultPath: path.join(app.getPath('documents'), `${stampName(Date.now(), t('Carnet - all data'), 'Carnet')}.${ext}`),
    filters: [{ name: label, extensions: ext === 'md' ? ['md', 'txt'] : [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  const out = res.filePath;
  const text = () => journal.fullText(data, { settings, instructions: instructionsText() });
  try {
    if (ext === 'md') { fs.writeFileSync(out, text(), 'utf8'); return out; }
    if (ext === 'json') { fs.writeFileSync(out, dataJson(), 'utf8'); return out; }
    // Archive : texte + données + instructions, puis les vidéos demandées, avec l'avancement.
    dataExportCancelled = false;
    const files = [...(videos ? journalVideoFiles() : []), ...(recordings ? keptRecordingFiles().map((x) => ({ ...x, name: t('Kept recordings') + '/' + x.name })) : [])];
    const total = files.reduce((t, x) => t + fileSize(x.file), 0) || 1;
    let done = 0, lastSent = 0;
    const z = new ZipWriter(out);
    try {
      z.addBuffer(t('Carnet - all data') + '.md', Buffer.from(text(), 'utf8'));
      z.addBuffer(t('Carnet - data') + '.json', Buffer.from(dataJson(), 'utf8'));
      z.addBuffer(journal.INSTRUCTIONS_FILE, Buffer.from(instructionsText(), 'utf8'));
      for (const f of files) {
        await z.addFile(f.name, f.file, (n) => {
          done += n;
          if (Date.now() - lastSent > 200) { lastSent = Date.now(); win && win.webContents.send('data-export-progress', { pct: done / total, file: path.basename(f.name) }); }
        }, () => dataExportCancelled);
      }
      z.close();
    } catch (err) { z.abort(); fs.rmSync(out, { force: true }); if (err.cancelled) return null; throw err; }
    return out;
  } catch (err) { throw new Error(friendlyFsError(err, path.dirname(out))); }
});

// ---------- Enregistrements ----------
// Chaque enregistrement (clip ou nouvelle vidéo) est écrit sur le disque au fur et à mesure, morceau par
// morceau : rien ne reste seulement en mémoire, et une coupure, un plantage ou une erreur ne fait rien perdre.
// Un registre (clips/enregistrements.json) suit chaque enregistrement :
//   recording : en cours (ou interrompu, s'il date d'une session précédente)
//   ready     : prêt (converti), pas encore utilisé dans un export ou le journal
//   error     : la conversion a échoué, le fichier brut est gardé
//   used      : utilisé dans un export ou ajouté au journal
//   deleted   : annulé ou supprimé dans Carnet ; gardé 7 jours avant d'être vraiment effacé
const REC_INDEX = () => path.join(clipsDir(), 'enregistrements.json');
const KEEP_DELETED = 7 * 864e5;
const sessionStart = Date.now();
let recIndex = null;
const openRecs = new Map(); // id -> descripteur du fichier en cours d'écriture
function recs() {
  if (!recIndex) { try { recIndex = JSON.parse(fs.readFileSync(REC_INDEX(), 'utf8')); } catch (_) { recIndex = []; } }
  return recIndex;
}
function saveRecs() {
  try { const tmp = REC_INDEX() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(recs(), null, 1)); fs.renameSync(tmp, REC_INDEX()); } catch (_) {}
}
const recById = (id) => recs().find((r) => r.id === id);
const recByFile = (file) => recs().find((r) => r.file === file || r.raw === file || (r.parts || []).includes(file));

// Message compréhensible pour une erreur d'écriture.
function friendlyFsError(err, where) {
  const code = err && err.code;
  if ((code === 'EPERM' || code === 'EACCES') && IS_MAC) return t('macOS refuses to write to {where}. Allow Carnet in System Settings > Privacy & Security > Files and Folders (or Full Disk Access), or choose another folder.', { where });
  if (code === 'EPERM' || code === 'EACCES') return t('Windows refuses to write to {where}. Most common cause: Windows Security\'s "Controlled folder access" protection, which blocks unknown apps. Allow Carnet in Windows Security > Virus & threat protection > Manage ransomware protection > Allow an app through Controlled folder access, or choose another folder.', { where });
  if (code === 'ENOSPC') return t('The disk is full: cannot write to {where}. Free up some space, then try again.', { where });
  if (code === 'EBUSY') return t('The file is used by another app ({where}). Close it, then try again.', { where });
  return String((err && err.message) || err);
}

// Dossiers de secours, si Windows refuse soudain d'écrire dans le dossier des clips (disque plein,
// antivirus, droits) : la suite de l'enregistrement y est écrite, puis les morceaux sont recollés.
function rescueDirs() {
  const out = [clipsDir()];
  for (const base of [os.tmpdir(), app.getPath('videos'), app.getPath('documents'), os.homedir()]) {
    try { out.push(path.join(base, 'Carnet - rescue')); } catch (_) {}
  }
  return [...new Set(out)];
}
// Écrit tout le tampon ; en cas d'erreur, err.written = ce qui a déjà été écrit.
function writeAll(fd, buf) {
  let off = 0;
  try { while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off); } catch (err) { err.written = off; throw err; }
}
// Ouvre un nouveau morceau d'enregistrement dans le premier dossier qui accepte l'écriture.
function openPart(r, skipDirs) {
  let last = null;
  for (const dir of rescueDirs()) {
    if (skipDirs.has(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ext = r.ext || 'webm';
      const file = path.join(dir, r.parts.length ? `suite-${r.id}-${r.parts.length}.${ext}` : `brut-${r.at}.${ext}`);
      const fd = fs.openSync(file, 'w');
      r.parts.push(file);
      if (!r.raw) r.raw = file;
      return { fd, file, dir };
    } catch (err) { last = err; skipDirs.add(dir); }
  }
  throw new Error(friendlyFsError(last, t('none of the folders tried ({list})', { list: rescueDirs().join(', ') })));
}
// While a recording runs, background work (whisper, sound extraction) gets the processor last, and no new job
// starts: the video encoder must not lose frames. A recording that sent nothing for a minute no longer counts.
const bgProcs = new Set();
const recordingNow = () => [...openRecs.values()].some((c) => Date.now() - c.lastChunk < 60000);
function bgPriority(p) {
  try { os.setPriority(p.pid, recordingNow() ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
}
function trackBg(p) { bgProcs.add(p); bgPriority(p); p.on('close', () => bgProcs.delete(p)); }
const retuneBg = () => { for (const p of bgProcs) bgPriority(p); };
ipcMain.handle('rec-begin', (_e, { startedAt } = {}) => {
  const stamp = Date.now();
  const r = { id: 'r' + stamp.toString(36), raw: null, parts: [], file: null, status: 'recording', startedAt: startedAt || stamp, at: stamp, duration: null };
  const cur = openPart(r, new Set());
  openRecs.set(r.id, { ...cur, failed: new Set(), lastChunk: Date.now() });
  recs().push(r);
  saveRecs();
  retuneBg();
  return r.id;
});
ipcMain.handle('rec-chunk', (_e, id, buffer) => {
  const cur = openRecs.get(id), r = recById(id);
  if (!cur || !r) throw new Error(t('Unknown recording'));
  return writeRec(r, Buffer.from(buffer));
});
// Writes the next bytes of a recording. Writing refused along the way: the rest goes to another folder, nothing lost.
// A recording sent by the phone opens its file at its first piece; after a restart of Carnet, it goes on in a new
// part (the parts are joined at the end), once the bytes written after the last acknowledged piece are cut off.
function writeRec(r, buf) {
  let cur = openRecs.get(r.id);
  if (!cur) {
    if (r.phone && partsOf(r).length) {
      const parts = partsOf(r).filter((f) => fs.existsSync(f));
      let extra = parts.reduce((n, f) => n + fileSize(f), 0) - (r.bytes || 0);
      for (let i = parts.length - 1; i >= 0 && extra > 0; i--) {
        const sz = fileSize(parts[i]), cut = Math.min(sz, extra);
        try { fs.truncateSync(parts[i], sz - cut); extra -= cut; } catch (_) { break; }
      }
    }
    cur = { ...openPart(r, new Set()), failed: new Set(), lastChunk: Date.now() };
    openRecs.set(r.id, cur);
    saveRecs();
    retuneBg();
  }
  cur.lastChunk = Date.now();
  try { writeAll(cur.fd, buf); return { ok: true }; } catch (err) {
    buf = buf.subarray(err.written || 0);
    try { fs.closeSync(cur.fd); } catch (_) {}
    cur.failed.add(cur.dir);
    const next = openPart(r, cur.failed);
    writeAll(next.fd, buf);
    Object.assign(cur, next);
    saveRecs();
    return { ok: true, moved: next.dir, reason: friendlyFsError(err, cur.dir) };
  }
}
function closeRec(id) {
  const cur = openRecs.get(id);
  if (cur) { try { fs.closeSync(cur.fd); } catch (_) {} openRecs.delete(id); }
  retuneBg();
  setTimeout(work, 1000);
}
const partsOf = (r) => (r.parts && r.parts.length ? r.parts : r.raw ? [r.raw] : []);
// Recolle les morceaux (simple mise bout à bout des octets) dans un fichier, dans le premier dossier qui accepte.
function joinParts(parts, dest) {
  const fd = fs.openSync(dest, 'w');
  try {
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (const p of parts) {
      const src = fs.openSync(p, 'r');
      try { let n; while ((n = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) writeAll(fd, chunk.subarray(0, n)); } finally { fs.closeSync(src); }
    }
  } finally { fs.closeSync(fd); }
}
function joinedRaw(r) {
  const parts = partsOf(r).filter((f) => fs.existsSync(f));
  if (parts.length <= 1) return parts[0];
  let last = null;
  for (const dir of rescueDirs()) {
    const dest = path.join(dir, `brut-${r.at}-complet.${r.ext || 'webm'}`);
    try { fs.mkdirSync(dir, { recursive: true }); joinParts(parts, dest); for (const p of parts) if (p !== dest) fs.rmSync(p, { force: true }); r.parts = [dest]; r.raw = dest; saveRecs(); return dest; } catch (err) { last = err; fs.rmSync(dest, { force: true }); }
  }
  throw new Error(friendlyFsError(last, t('the rescue folders')));
}

// Copy of what a recording still being received holds (the phone keeps sending): prepared without touching it.
function snapshotRaw(r) {
  const parts = partsOf(r).filter((f) => fs.existsSync(f));
  if (!parts.length) return null;
  let last = null;
  for (const dir of rescueDirs()) {
    const dest = path.join(dir, `copie-${r.id}-${Date.now()}.${r.ext || 'webm'}`);
    try { fs.mkdirSync(dir, { recursive: true }); joinParts(parts, dest); return dest; } catch (err) { last = err; fs.rmSync(dest, { force: true }); }
  }
  throw new Error(friendlyFsError(last, t('the rescue folders')));
}
// Picture turned (phone held sideways with its rotation lock on, turned in Carnet before recording). MP4: the
// rotation is written in the file, instantly. Other formats: the picture is re-encoded once, turned.
async function rotateClip(file, deg, info) {
  if (/\.mp4$/i.test(file)) {
    try { if (phonerec.setMp4Rotation(file, deg)) return { file, info: await render.probe(ffmpeg, file) }; } catch (_) {}
  }
  const out = file.replace(/\.\w+$/, '') + '-turned.mp4';
  const vf = deg === 90 ? 'transpose=clock' : deg === 270 ? 'transpose=cclock' : 'hflip,vflip';
  const res = await render.run(ffmpeg, ['-hide_banner', '-y', '-i', file, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', out]);
  if (res.code !== 0) { fs.rmSync(out, { force: true }); return null; }
  fs.rmSync(file, { force: true });
  return { file: out, info: await render.probe(ffmpeg, out) };
}

// Fichier brut (écrit par morceaux) -> fichier propre avec une durée. Le brut n'est effacé qu'une fois
// le fichier propre vérifié. Deux essais : copie simple, puis copie qui reconstruit les horodatages
// (utile pour un enregistrement interrompu).
// opts.snapshot: a copy of what has arrived so far is prepared, the raw file stays (the phone is still sending).
// opts.existing: already prepared, only described again.
async function finalizeRec(r, opts = {}) {
  if (opts.existing && r.file && fs.existsSync(r.file)) {
    const info = await render.probe(ffmpeg, r.file);
    return { id: r.id, path: r.file, url: pathToFileURL(r.file).href, info };
  }
  const raw = opts.snapshot ? snapshotRaw(r) : joinedRaw(r);
  if (!raw) throw new Error(t('Recording file not found.'));
  // Vidéo H.264 (encodée par la carte graphique, ou par le téléphone) : le WebM ne l'accepte pas, le clip propre est
  // un MP4 (de même pour le son AAC d'un iPhone).
  let rawInfo = null;
  try { rawInfo = await render.probe(ffmpeg, raw); } catch (_) {}
  const h264 = !!rawInfo && (/^(h264|hevc)$/.test(rawInfo.vcodec) || rawInfo.acodec === 'aac');
  const name = opts.snapshot ? `clip-${r.at}-${Date.now().toString(36)}.${h264 ? 'mp4' : 'webm'}`
    : `clip-${path.basename(raw).replace(/^(brut|raw)-/, '').replace('-complet', '')}`.replace(/\.(webm|mp4)$/i, h264 ? '.mp4' : '.webm');
  let info = null, last = null, fixed = null;
  for (const dir of rescueDirs()) {
    for (const extra of [[], ['-fflags', '+genpts+igndts']]) {
      try {
        fixed = path.join(dir, name);
        fs.mkdirSync(dir, { recursive: true });
        const out = await render.run(ffmpeg, ['-hide_banner', '-y', ...extra, '-i', raw, '-c', 'copy', ...(h264 ? ['-movflags', '+faststart'] : []), fixed]);
      if (out.code !== 0) throw new Error((out.stderr || '').split('\n').filter(Boolean).slice(-3).join(' '));
        info = await render.probe(ffmpeg, fixed);
        if (!info.duration) throw new Error(t('duration not found'));
        break;
      } catch (err) { last = err; info = null; }
    }
    if (info) break;
    // Écriture impossible dans ce dossier : on essaie le suivant ; sinon (fichier abîmé) inutile d'insister.
    if (!/Permission denied|Operation not permitted|No space|Access is denied/i.test(String(last && last.message))) break;
  }
  if (!info) {
    if (opts.snapshot) { fs.rmSync(raw, { force: true }); throw new Error(t('What has arrived from the phone cannot be read yet: {detail}', { detail: String(last && last.message || last).slice(0, 300) })); }
    r.status = 'error';
    r.error = String(last && last.message || last).slice(0, 300);
    saveRecs();
    throw new Error(t('The recording could not be prepared, but it is kept on the disk ({file}). You can save a copy of it, or recover it later in "Recordings".\nDetail: {detail}', { file: raw, detail: r.error }));
  }
  if (r.rotation) {
    const turned = await rotateClip(fixed, r.rotation, info);
    if (turned) { fixed = turned.file; info = turned.info; }
  }
  // Frames really kept in the file (the window compares them with what the camera sent).
  try { Object.assign(info, await render.frameStats(ffmpeg, fixed)); } catch (_) {}
  fs.rmSync(raw, { force: true });
  if (opts.snapshot) Object.assign(r, { file: fixed, status: r.status === 'deleted' ? 'deleted' : 'ready', duration: info.duration, error: null });
  else Object.assign(r, { parts: [], file: fixed, status: r.status === 'deleted' ? 'deleted' : 'ready', duration: info.duration, error: null });
  saveRecs();
  return { id: r.id, path: fixed, url: pathToFileURL(fixed).href, info };
}

// Recordings made by the phone itself (src/phonerec.js): pieces written with writeRec, prepared with finalizeRec.
const phonerec = require('./phonerec');
const phoneRec = phonerec.create({
  t, recs, saveRecs, recById, writeRec, closeRec,
  finalize: (r, opts) => finalizeRec(r, opts),
  toWin: (m) => { if (win && !win.isDestroyed()) win.webContents.send('phone-rec', m); },
  send: (m) => phone.send(m),
  present: () => phone.present(),
});
phone.attach(phoneRec);
ipcMain.handle('phone-rec-start', (_e, o) => phoneRec.start(o || {}));
ipcMain.handle('phone-rec-stop', (_e, id, stopAfter) => phoneRec.stop(id, stopAfter));
ipcMain.handle('phone-rec-finish-now', (_e, id) => phoneRec.finishNow(id));
ipcMain.handle('phone-rec-abandon', (_e, id) => phoneRec.abandon(id));
ipcMain.handle('rec-end', async (_e, id) => {
  closeRec(id);
  const r = recById(id);
  if (!r) throw new Error(t('Unknown recording'));
  return finalizeRec(r);
});

// Ancienne méthode (enregistrement envoyé d'un bloc), gardée en secours si l'écriture par morceaux échoue.
ipcMain.handle('save-recording', async (_e, buffer) => {
  const stamp = Date.now();
  const raw = path.join(clipsDir(), `brut-${stamp}.webm`);
  try { fs.writeFileSync(raw, Buffer.from(buffer)); } catch (err) { throw new Error(friendlyFsError(err, clipsDir())); }
  const r = { id: 'r' + stamp.toString(36), raw, parts: [raw], file: null, status: 'recording', startedAt: stamp, at: stamp, duration: null };
  recs().push(r); saveRecs();
  return finalizeRec(r);
});

// « Supprimer » ne supprime pas tout de suite : l'enregistrement est gardé 7 jours, récupérable.
ipcMain.handle('delete-recording', (_e, file) => {
  const r = file && recByFile(file);
  if (r) { r.status = 'deleted'; r.deletedAt = Date.now(); saveRecs(); }
});
function markUsed(files) {
  let changed = false;
  for (const f of files) { const r = f && recByFile(f); if (r && r.status !== 'used') { r.status = 'used'; r.usedAt = Date.now(); changed = true; } }
  if (changed) saveRecs();
}
// Ménage : enregistrements supprimés ou utilisés depuis plus de 7 jours.
// Les fichiers bruts laissés par les anciennes versions (raw-*.webm : préparation échouée) sont repris
// dans le registre pour pouvoir être récupérés.
function purgeRecs() {
  const now = Date.now();
  for (const f of fs.readdirSync(clipsDir())) {
    const full = path.join(clipsDir(), f);
    if (/^(raw|brut)-\d+\.webm$/.test(f) && !recByFile(full)) {
      const t = Number(f.match(/\d+/)[0]);
      recs().push({ id: 'r' + t.toString(36) + 'x', raw: full, file: null, status: 'recording', startedAt: t, at: t, duration: null });
    }
  }
  const keep = [];
  for (const r of recs()) {
    const old = (r.status === 'deleted' && now - (r.deletedAt || r.at) > KEEP_DELETED) || (r.status === 'used' && now - (r.usedAt || r.at) > KEEP_DELETED);
    const files = [r.file, r.raw, ...(r.parts || [])].filter(Boolean);
    const gone = !files.some((f) => fs.existsSync(f));
    if (old || gone) { if (old) for (const f of files) fs.rmSync(f, { force: true }); } else keep.push(r);
  }
  recIndex = keep;
  saveRecs();
}
// Enregistrements à proposer de récupérer : ceux des sessions précédentes qui n'ont pas été utilisés.
ipcMain.handle('rec-pending', () => recs()
  .filter((r) => r.status !== 'used' && !openRecs.has(r.id) && (r.at < sessionStart || r.status === 'error' || r.status === 'deleted' || (r.rescue && !r.receiving)))
  .filter((r) => [r.file, r.raw, ...(r.parts || [])].some((f) => f && fs.existsSync(f))) // nothing on the disk: nothing to offer
  .map((r) => ({ ...r, size: [...new Set([r.file, r.raw, ...(r.parts || [])].filter(Boolean))].map((f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } }).reduce((a, b) => a + b, 0) }))
  .sort((a, b) => b.at - a.at));
// Récupérer : convertit si besoin, puis renvoie le fichier pour l'ouvrir dans le montage.
ipcMain.handle('rec-recover', async (_e, id) => {
  const r = recById(id);
  if (!r) throw new Error(t('Recording not found'));
  if (r.status === 'deleted') r.status = r.file ? 'ready' : 'recording';
  if (r.file && fs.existsSync(r.file)) { r.status = 'ready'; saveRecs(); return r.file; }
  // Recording the phone is still sending: what has arrived (the rest is still taken when it comes).
  if (r.phone && r.receiving) return (await phoneRec.finishNow(id)).path;
  return (await finalizeRec(r)).path;
});
ipcMain.handle('rec-forget', (_e, id) => {
  const r = recById(id);
  if (r) { r.status = 'deleted'; r.deletedAt = Date.now(); saveRecs(); }
});
// Enregistrer une copie de l'enregistrement où on veut (copie exacte, sans conversion : instantané).
async function askCopyPath(r, src) {
  const ext = /\.mp4$/i.test(src || '') ? 'mp4' : 'webm'; // même format que le fichier copié
  const res = await dialog.showSaveDialog(win, { title: t('Save a copy of the recording'), defaultPath: path.join(app.getPath('videos'), stampName(r ? r.startedAt : Date.now(), t('Recording'), t('Recording')) + '.' + ext), filters: [{ name: ext === 'mp4' ? t('MP4 video') : t('WebM video'), extensions: [ext] }] });
  return res.canceled || !res.filePath ? null : res.filePath;
}
// Enregistrer une copie de l'enregistrement où on veut (copie exacte, sans conversion : instantané).
ipcMain.handle('rec-save-copy', async (_e, idOrFile) => {
  const r = recById(idOrFile) || recByFile(idOrFile);
  const parts = r ? (r.file && fs.existsSync(r.file) ? [r.file] : partsOf(r).filter((f) => fs.existsSync(f))) : (idOrFile && fs.existsSync(idOrFile) ? [idOrFile] : []);
  if (!parts.length) throw new Error(t('Recording file not found.'));
  const dest = await askCopyPath(r, parts[0]);
  if (!dest) return null;
  try { if (parts.length === 1) fs.copyFileSync(parts[0], dest); else joinParts(parts, dest); } catch (err) { throw new Error(friendlyFsError(err, path.dirname(dest))); }
  return dest;
});
// Copie qui inclut aussi ce qui n'a pas pu être écrit sur le disque (resté en mémoire dans la fenêtre) :
// la partie déjà sur le disque, puis les morceaux envoyés un par un.
const copyJobs = new Map();
ipcMain.handle('rec-copy-begin', async (_e, id) => {
  const r = id ? recById(id) : null;
  const dest = await askCopyPath(r);
  if (!dest) return null;
  try {
    fs.closeSync(fs.openSync(dest, 'w'));
    if (r) { closeRec(r.id); const parts = partsOf(r).filter((f) => fs.existsSync(f)); if (parts.length) joinParts(parts, dest); }
    const token = 'c' + Date.now().toString(36);
    copyJobs.set(token, { fd: fs.openSync(dest, 'a'), dest });
    return token;
  } catch (err) { throw new Error(friendlyFsError(err, path.dirname(dest))); }
});
ipcMain.handle('rec-copy-chunk', (_e, token, buffer) => {
  const j = copyJobs.get(token);
  if (!j) throw new Error(t('Unknown copy'));
  try { writeAll(j.fd, Buffer.from(buffer)); } catch (err) { throw new Error(friendlyFsError(err, path.dirname(j.dest))); }
  return true;
});
ipcMain.handle('rec-copy-end', (_e, token) => {
  const j = copyJobs.get(token);
  if (!j) return null;
  try { fs.closeSync(j.fd); } catch (_) {}
  copyJobs.delete(token);
  return j.dest;
});

const cleanName = (t) => String(t || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().replace(/[-. ]+$/, '').slice(0, 80);
// Nom standard des vidéos : JJ-MM-AA HHhMM Titre (Windows interdit le / dans les noms de fichiers).
function stampName(date, title, fallback) {
  const n = new Date(date || Date.now()), p = (x) => String(x).padStart(2, '0');
  return `${p(n.getDate())}-${p(n.getMonth() + 1)}-${p(n.getFullYear() % 100)} ${p(n.getHours())}h${p(n.getMinutes())} ${cleanName(title) || fallback}`;
}
// Export : date et heure de l'export.
const exportName = (title) => stampName(Date.now(), title, 'Carnet');
// Vidéos du journal : date et heure de l'enregistrement.
const journalName = (date, title) => stampName(date, title, 'Journal');
// Le fichier porte déjà ce nom (éventuellement suivi de _1, _2 si deux vidéos ont le même nom).
const hasName = (file, want) => {
  const n = path.parse(file).name;
  return n === want || (n.startsWith(want + '_') && /^\d+$/.test(n.slice(want.length + 1)));
};
// Dossier par défaut des exports (vidéos montées, hors journal).
const exportsDir = () => settings.exportDir || path.join(app.getPath('videos'), 'Carnet - Exports');

function freePath(dir, base, ext) {
  let p = path.join(dir, base + ext), i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base}_${i++}${ext}`);
  return p;
}

// Écrit la liste des chapitres à côté de la vidéo, au format d'une description YouTube.
function writeChaptersTxt(file, chapters) {
  if (!chapters.length) return;
  const txt = [...chapters].sort((a, b) => a.t - b.t).map((c) => `${journal.fmtT(c.t)} ${c.title}`).join('\r\n');
  const p = path.parse(file);
  fs.writeFileSync(path.join(p.dir, `${p.name}-chapters.txt`), txt + '\r\n', 'utf8');
}

// Export en cours (pour pouvoir l'annuler).
let exportJob = null;
ipcMain.handle('export-cancel', () => {
  if (!exportJob) return false;
  exportJob.cancelled = true;
  if (exportJob.kill) exportJob.kill();
  return true;
});

// Export. toJournal : directement dans le dossier du journal, sans fenêtre « Enregistrer sous », puis ajout au journal.
ipcMain.handle('export', async (_e, { source, sourceInfo, segments, chapters = [], title = '', toJournal = false, date = null, intention = null }) => {
  let output;
  if (toJournal) {
    // Vidéos du journal : dans le sous-dossier du journal, nommées « date - titre ».
    if (!journalDir()) throw new Error(t('Choose the journal folder first.'));
    assertWritable();
    try { fs.mkdirSync(journalVideosDir(), { recursive: true }); } catch (err) { throw new Error(friendlyFsError(err, journalVideosDir())); }
    output = freePath(journalVideosDir(), journalName(date, title), '.mp4');
  } else {
    // Exports : dans un dossier à part, jamais mélangés avec le journal.
    try { fs.mkdirSync(exportsDir(), { recursive: true }); } catch (err) { throw new Error(friendlyFsError(err, exportsDir())); }
    const r = await dialog.showSaveDialog(win, { title: t('Export the video'), defaultPath: freePath(exportsDir(), exportName(title), '.mp4'), filters: [{ name: 'MP4', extensions: ['mp4'] }] });
    if (r.canceled || !r.filePath) return null;
    output = r.filePath;
  }
  const signal = { cancelled: false, kill: null };
  exportJob = signal;
  const opts = { source, sourceInfo, segments, chapters, title, output, fontFile: findFont(), onProgress: (p) => send('export-progress', p), signal };
  const cancelled = () => {
    exportJob = null;
    fs.rmSync(output, { force: true });
    return new Error('EXPORT_ANNULE');
  };
  try {
    await render.exportVideo(ffmpeg, opts);
  } catch (first) {
    if (signal.cancelled) throw cancelled();
    // Deuxième essai avec la méthode de découpe classique (plus lente, mais plus tolérante).
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, `export-${Date.now()}.txt`);
    fs.writeFileSync(log, `Attempt 1:\n${first.log || first.message}\n`, 'utf8');
    send('export-progress', 0);
    try {
      await render.exportVideo(ffmpeg, { ...opts, legacy: true });
    } catch (second) {
      if (signal.cancelled) throw cancelled();
      exportJob = null;
      fs.appendFileSync(log, `\nAttempt 2:\n${second.log || second.message}\n`, 'utf8');
      fs.rmSync(output, { force: true });
      const denied = /Permission denied|Operation not permitted|Access is denied/i.test(`${second.log || ''} ${second.message}`);
      throw new Error(`${denied ? friendlyFsError({ code: 'EPERM' }, path.dirname(output)) + '\n\n' : ''}${second.message}\n\n${t('Full log: {file}', { file: log })}`);
    }
  }
  exportJob = null;
  markUsed([source, ...segments.map((x) => x.clip && x.clip.file)]);
  writeChaptersTxt(output, chapters);
  if (toJournal) {
    const dur = segments.reduce((t, x) => t + (x.end - x.start), 0);
    addEntry({ file: output, title, date: date || Date.now(), duration: dur, chapters, intention });
  }
  return output;
});

ipcMain.handle('show-in-folder', (_e, file) => shell.showItemInFolder(file));

// =====================================================================
// Journal
// =====================================================================
const { safeStorage } = require('electron');
const gemini = require('./gemini');
const DEFAULT_INSTRUCTIONS = path.join(__dirname, 'instructions-journal.md');
// Instructions of the journal (editable file in the journal folder) + the language Gemini writes in.
const systemPrompt = () => journal.readInstructions(journalDir(), DEFAULT_INSTRUCTIONS) + '\n' + journal.languageRule(i18n.lang);

const saveSettings = (patch) => { Object.assign(settings, patch); writeSettings({ ...readSettings(), ...patch }); };
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const journalDir = () => settings.journalDir || null;
const fetchFn = (...a) => net.fetch(...a);

// Clé Gemini chiffrée avec le compte Windows de l'utilisateur (sur un Mac : dans son trousseau, le Keychain).
function getKey() {
  if (!settings.geminiKey) return null;
  try {
    return settings.geminiKeyEnc && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(settings.geminiKey, 'base64'))
      : settings.geminiKey;
  } catch (_) { return null; }
}
function setKey(key) {
  if (!key) return saveSettings({ geminiKey: null, geminiKeyEnc: false });
  const enc = safeStorage.isEncryptionAvailable();
  saveSettings({ geminiKey: enc ? safeStorage.encryptString(key).toString('base64') : key, geminiKeyEnc: enc });
}

const emptyJournal = () => ({ version: 3, entries: [], sujets: [], bilans: [], semaines: {}, precisions: [], faits: [], checks: [], profile: journal.normalizeProfile(null), progress: journal.normalizeProgress(null), rebuild: false });
let data = emptyJournal();
const jobs = {}; // id -> { step, pct } : travail en cours, pour l'affichage
function loadJournal() {
  data = journalDir() ? journal.load(journalDir()) : emptyJournal();
  saveError = null;
  if (journalDir() && !data.broken) { journal.ensureInstructions(journalDir(), DEFAULT_INSTRUCTIONS); tidyJournalFolder(); }
  // Journal abîmé et repris depuis une sauvegarde : on réécrit tout de suite un journal.json sain.
  if (journalDir() && data.restoredFrom) persist();
}
// Erreur d'écriture du journal (affichée dans l'app). Le journal en mémoire n'est jamais écrit
// par-dessus un fichier qu'on n'a pas pu lire.
let saveError = null;
let dataVersion = 0; // counts the changes, for what is computed from the whole journal (search memory status)
function persist() {
  dataVersion++;
  // Concluded subjects become steps forward (and reopened ones are put aside) before each save.
  if (!data.broken) { try { journal.syncSettled(data); } catch (_) {} }
  if (journalDir()) {
    try { journal.save(journalDir(), data); saveError = null; } catch (err) { saveError = String(err.message || err); }
  }
  pushState();
}
// Journal illisible : rien ne doit y être ajouté ni analysé (les appels Gemini seraient perdus).
function assertWritable() {
  if (data.broken) throw new Error(t('The journal cannot be read: {why}', { why: data.broken }));
}
// Videos of the journal: in a subfolder. Journals started with an earlier version keep their French-named folder.
const videosSubdir = () => (journalDir() && fs.existsSync(path.join(journalDir(), 'Vidéos du journal')) ? 'Vidéos du journal' : 'Journal videos');
const journalVideosDir = () => path.join(journalDir(), videosSubdir());
const entryPath = (e) => path.join(journalDir(), e.file);
const relFile = (abs) => path.relative(journalDir(), abs).split(path.sep).join('/');
function videoUrl(e) { return pathToFileURL(entryPath(e)).href; }

// Déplace / renomme la vidéo d'une entrée (et son fichier de chapitres). Renvoie false si Windows bloque
// le fichier (par exemple pendant sa lecture) : on réessaiera plus tard.
function moveEntryVideo(e, targetBase) {
  const from = entryPath(e);
  if (!fs.existsSync(from)) return false;
  const ext = path.extname(from);
  fs.mkdirSync(journalVideosDir(), { recursive: true });
  const cur = path.parse(from);
  if (path.dirname(from) === journalVideosDir() && cur.name === targetBase) return true;
  const to = freePath(journalVideosDir(), targetBase, ext);
  try {
    fs.renameSync(from, to);
  } catch (_) {
    return false;
  }
  for (const suffix of ['-chapters.txt', '-chapitres.txt']) {
    const chFrom = path.join(cur.dir, cur.name + suffix);
    if (fs.existsSync(chFrom)) { try { fs.renameSync(chFrom, path.join(path.dirname(to), `${path.parse(to).name}-chapters.txt`)); } catch (_) {} }
  }
  // The old Markdown transcript has the old name: it is written again with the new one.
  for (const dir of [journal.TRANSCRIPTS_DIR, journal.OLD_TRANSCRIPTS_DIR]) {
    const oldTr = path.join(journalDir(), dir, cur.name + '.md');
    if (fs.existsSync(oldTr)) fs.rmSync(oldTr, { force: true });
  }
  e.file = relFile(to);
  return true;
}

// Après l'analyse : la vidéo prend le titre donné par Gemini, précédé de sa date.
function renameFromAnalysis(e) {
  if (!e.analysis || !e.analysis.titre) return;
  const want = journalName(e.date, e.analysis.titre);
  if (hasName(e.file, want) && e.file.startsWith(videosSubdir() + '/')) { e.renamePending = false; return; }
  e.renamePending = !moveEntryVideo(e, want);
}

// Anciennes vidéos rangées à la racine du dossier du journal, ou nommées dans l'ancien format :
// déplacées dans le sous-dossier et renommées au format JJ-MM-AA HHhMM Titre.
function tidyJournalFolder() {
  let changed = false;
  for (const e of data.entries) {
    const base = e.analysis && e.analysis.titre ? journalName(e.date, e.analysis.titre) : journalName(e.date, e.title);
    const misplaced = !e.file.includes('/') || !hasName(e.file, base);
    if (misplaced && !e.renamePending && fs.existsSync(entryPath(e))) {
      if (moveEntryVideo(e, base)) changed = true;
      else e.renamePending = !!(e.analysis && e.analysis.titre);
    } else if (e.renamePending) {
      renameFromAnalysis(e);
      changed = changed || !e.renamePending;
    }
  }
  if (changed) persist();
}

function state() {
  const u = gemini.usage(settings);
  const w = whisper.status(settings);
  return {
    dir: journalDir(),
    entries: data.entries.map((e) => ({ ...e, url: journalDir() ? videoUrl(e) : null, path: journalDir() ? entryPath(e) : null, exists: journalDir() ? fs.existsSync(entryPath(e)) : false })),
    exportDir: exportsDir(),
    sujets: data.sujets,
    bilans: data.bilans.slice(-10),
    semaines: data.semaines || {},
    precisions: data.precisions || [],
    faits: journal.factsOf(data),
    checks: journal.checksOf(data),
    memory: memoryStatus(),
    profile: journal.profileOf(data),
    profileJob: profileJob,
    profileError: data.profileError || null,
    progress: journal.progressOf(data),
    progressFading: journal.fadingSubjects(data),
    monthAgo: journal.monthAgo(data),
    lookback: journal.lookbackState(data),
    progressError: data.progressError || null,
    progressJob,
    reminder: reminder(),
    lang: i18n.lang,
    weekError: data.weekError || null,
    rebuild: data.rebuild,
    rebuildError: data.rebuildError || null,
    broken: data.broken || null,
    restoredFrom: data.restoredFrom || null,
    saveError,
    bilanError: data.bilanError || null,
    bilanPeriod: settings.bilanPeriod || 'jours7',
    jobs,
    gemini: { hasKey: !!getKey(), model: settings.geminiModel || gemini.DEFAULT_MODEL, models: settings.geminiModels || [gemini.DEFAULT_MODEL], usage: u, autoBilan: settings.autoBilan !== false, autoSemaine: settings.autoSemaine !== false,
      tier: keyTier(), tierChecking, wait: geminiWait, pause: geminiPaused() ? geminiPause : null, resetAt: gemini.nextQuotaReset() },
    whisper: w,
    transcriber: transcriber(),
  };
}
let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => send('journal-state', state()), 50);
}

function addEntry({ file, title, date, duration, chapters, intention }) {
  const name = relFile(file);
  const old = data.entries.find((e) => e.file === name);
  const entry = old || { id: journal.newId(), file: name };
  Object.assign(entry, {
    title: title || entry.title || titleFromName(file),
    date: date || entry.date || videoDate(file),
    duration: duration || entry.duration || 0,
    chapters: chapters || entry.chapters || [],
    intention: intention || entry.intention || null,
    transcript: null, analysis: null, transcriptError: null, analysisError: null,
  });
  if (!old) data.entries.push(entry);
  // The video of a look-back: the look-back is done.
  journal.lookbackRecorded(data, entry.intention, entry);
  persist();
  work();
  return entry.id;
}

// Date d'une vidéo : celle du nom standard (JJ-MM-AA HHhMM Titre, ou les anciens formats
// Titre_AAAA-MM-JJ_HHhMM et AAAA-MM-JJ HHhMM - Titre), sinon la date du fichier.
function videoDate(file) {
  const b = path.basename(file);
  let m = b.match(/^(\d{2})-(\d{2})-(\d{2}) (\d{2})h(\d{2})/);
  if (m) return new Date(2000 + +m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
  m = b.match(/_(\d{4})-(\d{2})-(\d{2})_(\d{2})h(\d{2})/) || b.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})h(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  try { return fs.statSync(file).mtimeMs; } catch (_) { return Date.now(); }
}
const titleFromName = (file) => path.parse(file).name
  .replace(/^\d{2}-\d{2}-\d{2} \d{2}h\d{2} /, '')
  .replace(/_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}(_\d+)?$/, '')
  .replace(/^\d{4}-\d{2}-\d{2} \d{2}h\d{2} - /, '')
  .replace(/_\d+$/, '');

// ---------- Travail en arrière-plan ----------
// Transcription : une vidéo à la fois (portable modeste). Analyse : dans la limite du quota Gemini du jour.
let transcribing = false, analysing = false;

// Mode de transcription : 'gemini' (par défaut : le son est envoyé avec la demande de fiche, un seul appel)
// ou 'whisper' (sur l'ordinateur, plus lent, rien ne part en ligne).
const transcriber = () => (settings.transcriber === 'whisper' ? 'whisper' : 'gemini');

async function transcribeNext() {
  if (transcribing || !journalDir() || transcriber() !== 'whisper') return;
  const w = whisper.status(settings);
  if (!w.installed) return;
  const e = data.entries.find((x) => !x.transcript && !x.transcriptError && fs.existsSync(path.join(journalDir(), x.file)));
  if (!e) return;
  transcribing = true;
  jobs[e.id] = { step: 'Transcription', pct: 0 };
  pushState();
  try {
    const json = await whisper.transcribe({
      ffmpeg, video: path.join(journalDir(), e.file), modelKey: w.model, onSpawn: trackBg,
      onProgress: (p) => { jobs[e.id] = p; pushState(); },
    });
    e.transcript = { segments: journal.parseWhisperJson(json), model: w.model, at: Date.now() };
  } catch (err) {
    e.transcriptError = String(err.message || err).slice(0, 500);
  } finally {
    delete jobs[e.id];
    transcribing = false;
    persist();
    work();
  }
}

function countCall() {
  const u = gemini.usage(settings);
  saveSettings({ geminiUsage: { day: u.day, count: u.count + 1, blocked: false } });
}
function blockToday() {
  const u = gemini.usage(settings);
  saveSettings({ geminiUsage: { day: u.day, count: u.count, blocked: true } });
}

// Free or paid key (see gemini.checkTier), remembered for the key it was found with.
const keyHash = (k) => require('crypto').createHash('sha256').update(String(k || '')).digest('hex').slice(0, 16);
function keyTier() {
  const g = settings.geminiTier, k = getKey();
  return g && k && g.key === keyHash(k) ? g.tier : 'unknown';
}
function setTier(tier, how) {
  const k = getKey();
  if (!k || !tier || tier === 'unknown') return;
  if (keyTier() === tier) return;
  saveSettings({ geminiTier: { tier, how, key: keyHash(k), at: Date.now() } });
  pushState();
}
async function checkTier() {
  const k = getKey();
  if (!k) return 'unknown';
  tierChecking = true; pushState();
  try {
    const r = await gemini.checkTier(fetchFn, k);
    if (r.tier !== 'unknown') setTier(r.tier, 'check');
    return r.tier;
  } catch (_) { return keyTier(); }
  finally { tierChecking = false; pushState(); }
}
let tierChecking = false;

// Waiting on Gemini: retry in progress (geminiWait) or analyses paused until a given time (geminiPause).
let geminiWait = null, geminiPause = null, pauseTimer = null;
function pauseGemini(ms, kind) {
  ms *= gemini.SCALE;
  geminiPause = { until: Date.now() + ms, kind };
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => { geminiPause = null; pushState(); work(); }, ms + 500 * gemini.SCALE);
  pushState();
}
const geminiPaused = () => !!geminiPause && Date.now() < geminiPause.until;

// One Gemini call. Temporary failures (overload, per-minute limit) are retried automatically: for up to 20 minutes
// with a free key (free keys are the first to be refused when Gemini is busy), 4 minutes otherwise. If Gemini
// still refuses, analyses pause and resume on their own: 10 minutes later (5 with a paid key), at the time Gemini
// gives, or after the daily reset.
async function callGemini(system, prompt, schema, audio, temperature) {
  const free = keyTier() === 'free';
  try {
    return await gemini.withRetry(async () => {
      try {
        const r = await gemini.generateJson(fetchFn, { key: getKey(), model: settings.geminiModel, system, prompt, schema, audio, temperature });
        countCall();
        return r;
      } catch (err) {
        if (err.freeTier) setTier('free', 'error');
        else if (err.kind === 'rate' || err.kind === 'quota') setTier('paid', 'error');
        if (err.kind !== 'overload') countCall(); // an overload is not counted by Google
        throw err;
      } finally { geminiWait = null; }
    }, {
      // Waits of 4, 8, 16, 32 s, then one a minute: 24 tries fill the 20 minutes, 8 tries the 4 minutes.
      budgetMs: (free ? 20 : 4) * 60e3,
      maxAttempts: free ? 24 : 8,
      onWait: ({ attempt, wait, kind }) => { geminiWait = { until: Date.now() + wait, attempt, kind }; pushState(); },
    });
  } catch (err) {
    if (err.kind === 'daily') { blockToday(); pauseGemini(gemini.nextQuotaReset() - Date.now() + 60e3, 'daily'); }
    else if (err.transient) pauseGemini(err.kind === 'rate' && err.retryMs > 60e3 ? err.retryMs + 5e3 : (free ? 10 : 5) * 60e3, err.kind);
    else if (err.kind === 'quota') pauseGemini(60 * 60e3, 'quota');
    throw err;
  } finally { geminiWait = null; pushState(); }
}
// Failures that resolve on their own: the video is not marked as failed, it is analysed when Gemini answers again.
const waitable = (err) => !!err && (err.transient || err.kind === 'daily' || err.kind === 'quota');

// ---------- Search memory ----------
// When what an analysis would send about the journal goes over journal.MEMORY_BUDGET, the search picks the subjects
// to send in full (memory.js, journal.searchPlan). Vectors are made in the background from 60 % of the limit (or at
// once with "Build now"), with Gemini's embedding model: its quota is separate, the day's calls do not change.
let mem = null; // { dir, idx }
let memBusy = false, memError = null, memWaitUntil = 0, memDone = 0, memTodo = 0;
function memIndex() {
  if (!journalDir()) return null;
  if (!mem || mem.dir !== journalDir()) mem = { dir: journalDir(), idx: memory.load(journalDir(), gemini.EMBED_MODEL) };
  return mem.idx;
}
// Size of the journal context of the next analysis, compared with the limit (computed again after each change).
let memUse = { version: -1, tokens: 0 };
function memoryUse() {
  if (memUse.version !== dataVersion) {
    const probe = { id: '', date: Date.now(), title: '', chapters: [] };
    memUse = { version: dataVersion, tokens: journal.contextTokens(data, probe, 'all') };
  }
  return memUse.tokens;
}
const memoryWanted = () => settings.searchMemory === 'on' || memoryUse() >= 0.6 * journal.MEMORY_BUDGET;
function memoryReady() {
  const idx = memIndex();
  return !!idx && Object.keys(idx.items).length > 0 && memory.coverage(idx, journal.memoryTexts(data)) >= 0.8;
}
async function memorySync() {
  if (memBusy || !journalDir() || data.broken || !getKey() || Date.now() < memWaitUntil || !memoryWanted()) return;
  const idx = memIndex();
  const { todo, gone } = memory.diff(idx, journal.memoryTexts(data));
  if (gone.length) memory.drop(idx, gone);
  if (!todo.length) { if (gone.length) { try { memory.save(mem.dir, idx); } catch (_) {} } return; }
  memBusy = true; memDone = 0; memTodo = todo.length;
  pushState();
  try {
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const vecs = await gemini.embed(fetchFn, { key: getKey(), texts: batch.map((x) => x.text), task: 'RETRIEVAL_DOCUMENT' });
      batch.forEach((x, k) => memory.put(idx, x.key, x.h, vecs[k]));
      idx.model = gemini.EMBED_MODEL;
      idx.updated = Date.now();
      memory.save(mem.dir, idx);
      memDone += batch.length;
      pushState();
    }
    memError = null;
  } catch (err) {
    memError = String(err.message || err).slice(0, 300);
    // Per-minute limit or overload: again a little later; daily quota: after the reset; anything else: in an hour.
    memWaitUntil = Date.now() + (err.kind === 'daily' ? gemini.nextQuotaReset() - Date.now() + 60e3 : err.transient ? Math.max(60e3, err.retryMs || 0) : 60 * 60e3);
  } finally {
    memBusy = false;
    pushState();
    setTimeout(() => memorySync().catch(() => {}), 2000);
  }
}
function memoryStatus() {
  if (!journalDir()) return null;
  const idx = mem && mem.dir === journalDir() ? mem.idx : memIndex();
  const tokens = memoryUse();
  return {
    pct: Math.round((tokens / journal.MEMORY_BUDGET) * 100),
    over: tokens > journal.MEMORY_BUDGET,
    items: idx ? Object.keys(idx.items).length : 0,
    updated: idx ? idx.updated : 0,
    building: memBusy ? { done: memDone, total: memTodo } : null,
    wanted: memoryWanted(),
    error: memError,
    waitUntil: memWaitUntil > Date.now() ? memWaitUntil : 0,
  };
}
// What to send about the journal for this video: everything when it fits, otherwise the search (the video must be
// transcribed), otherwise the most recent.
async function contextFor(e, fallback) {
  if (!e.transcript || !e.transcript.segments.length) return fallback;
  const chunks = journal.queryChunks(e);
  if (!chunks.length) return fallback;
  jobs[e.id] = { step: 'Searching your memory', pct: 0 };
  pushState();
  try {
    const queries = await gemini.embed(fetchFn, { key: getKey(), texts: chunks, task: 'RETRIEVAL_QUERY' });
    return journal.searchPlan(data, e, { scores: memory.scores(memIndex(), queries) });
  } catch (err) {
    memError = String(err.message || err).slice(0, 300);
    return fallback;
  }
}

async function analyseNext() {
  if (analysing || fixQueued || !journalDir() || !getKey()) return;
  if (gemini.usage(settings).left <= 0 || geminiPaused()) return;
  // Ancien journal : les sujets sont construits une fois, avant d'analyser les nouvelles vidéos.
  if (data.rebuild) {
    if (data.entries.some(journal.hasIdeas)) { await rebuildSubjects().catch(() => {}); return; }
    data.rebuild = false;
  }
  const exists = (x) => fs.existsSync(path.join(journalDir(), x.file));
  // Les vidéos les plus anciennes d'abord : chaque sujet se construit dans l'ordre où les choses ont été dites.
  const pending = [...data.entries].sort((a, b) => a.date - b.date);
  const e = pending.find((x) => x.transcript && !x.analysis && !x.analysisError)
    || (transcriber() === 'gemini' ? pending.find((x) => !x.transcript && !x.transcriptError && !x.analysisError && exists(x)) : null);
  if (e) {
    analysing = true;
    jobs[e.id] = { step: e.transcript ? 'Analysis' : 'Transcription and analysis', pct: 0 };
    pushState();
    let tmp = null;
    const model = settings.geminiModel || gemini.DEFAULT_MODEL;
    try {
      const system = systemPrompt();
      // Everything about the journal when it fits; otherwise search memory if it is ready, or the most recent.
      const plan0 = journal.defaultPlan(data, e);
      const search = plan0.mode === 'recent' && memoryReady();
      if (!e.transcript) {
        jobs[e.id] = { step: 'Preparing the sound', pct: 0 }; pushState();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-son-'));
        const voice = await render.extractVoice(ffmpeg, path.join(journalDir(), e.file), path.join(tmp, 'voix'), e.duration || 600, trackBg);
        const audio = { mimeType: voice.mimeType, data: fs.readFileSync(voice.file).toString('base64') };
        if (search) {
          // Search memory: the transcript first (1 call), so the search can read it, then the card (1 call).
          jobs[e.id] = { step: 'Transcription by Gemini', pct: 0 }; pushState();
          const tr = await callGemini(system, journal.transcriptPrompt(data, e), gemini.TRANSCRIPT_SCHEMA, audio);
          e.transcript = { segments: journal.segmentsFromGemini(tr.transcription, e.duration), model: 'gemini:' + model, at: Date.now() };
          persist();
          if (e.transcript.segments.length) {
            const plan = await contextFor(e, plan0);
            const context = journal.planSummary(data, plan);
            jobs[e.id] = { step: 'Analysis', pct: 0 }; pushState();
            const a = await callGemini(system, journal.entryPrompt(data, e, plan), gemini.ENTRY_SCHEMA);
            journal.applyEntryAnalysis(data, e, a, { model, at: Date.now(), context });
          } else e.analysis = journal.emptyAnalysis(e.title);
        } else {
          // Un seul appel : Gemini reçoit le son, transcrit, écrit la fiche et met à jour les sujets.
          const context = journal.planSummary(data, plan0);
          jobs[e.id] = { step: 'Transcription and analysis', pct: 0 }; pushState();
          const a = await callGemini(system, journal.entryAudioPrompt(data, e, plan0), gemini.ENTRY_AUDIO_SCHEMA, audio);
          e.transcript = { segments: journal.segmentsFromGemini(a.transcription, e.duration), model: 'gemini:' + model, at: Date.now() };
          if (e.transcript.segments.length) journal.applyEntryAnalysis(data, e, a, { model, at: Date.now(), context });
          else e.analysis = journal.emptyAnalysis(e.title);
        }
      } else if (!e.transcript.segments.length) {
        // Rien à analyser : pas d'appel, fiche minimale.
        e.analysis = journal.emptyAnalysis(e.title);
      } else {
        const plan = search ? await contextFor(e, plan0) : plan0;
        const context = journal.planSummary(data, plan);
        jobs[e.id] = { step: 'Analysis', pct: 0 }; pushState();
        const a = await callGemini(system, journal.entryPrompt(data, e, plan), gemini.ENTRY_SCHEMA);
        journal.applyEntryAnalysis(data, e, a, { model, at: Date.now(), context });
      }
      if (journal.hasIdeas(e)) data.bilanDue = true;
    } catch (err) {
      // Gemini busy or quota reached: retried automatically later, without marking the video as failed.
      if (!waitable(err)) e.analysisError = String(err.message || err).slice(0, 500);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      if (e.analysis) renameFromAnalysis(e);
      delete jobs[e.id];
      analysing = false;
      persist();
      work();
    }
    return;
  }
  // Plus rien en attente : bilan de chaque semaine terminée (la plus ancienne d'abord), en gardant 3 appels de réserve.
  if (settings.autoSemaine !== false && gemini.usage(settings).left > 3) {
    const k = journal.nextWeekToDo(data);
    if (k && (!weekTried || weekTried.key !== k || weekTried.day !== gemini.quotaDay())) {
      weekTried = { key: k, day: gemini.quotaDay() }; // one try per day and per week if it fails
      await makeWeekly(k).catch((err) => { if (waitable(err)) weekTried = null; }); // Gemini busy: tried again after the pause
      return;
    }
  }
  // Puis bilan de la période choisie s'il y a du nouveau, une fois par jour au plus.
  if (settings.autoBilan === false || !data.bilanDue) return;
  const last = data.bilans[data.bilans.length - 1];
  if (last && last.day === gemini.quotaDay()) return;
  const period = settings.bilanPeriod || 'jours7';
  if (!journal.periodEntries(data, period).some(journal.hasIdeas)) return;
  if (gemini.usage(settings).left > 3) await makeBilan(period).catch(() => {});
}

// Un appel : Gemini refait toute la liste des sujets à partir des idées de toutes les fiches.
async function rebuildSubjects() {
  if (analysing || !getKey()) return;
  if (gemini.usage(settings).left <= 0) throw new Error(t('No Gemini calls left today.'));
  analysing = true;
  jobs.rebuild = { step: 'Organising subjects', pct: 0 };
  pushState();
  try {
    const r = await callGemini(systemPrompt(), journal.rebuildPrompt(data), gemini.REBUILD_SCHEMA);
    journal.applyRebuild(data, r);
    data.rebuildError = null;
    data.bilanDue = true;
  } catch (err) {
    data.rebuildError = String(err.message || err).slice(0, 300);
    // Failure that will not resolve by waiting: no automatic retry ("Reorganise" button to try again).
    if (!waitable(err)) data.rebuild = false;
    throw err;
  } finally {
    delete jobs.rebuild;
    analysing = false;
    persist();
    setTimeout(work, 100);
  }
}

let weekTried = null; // dernier essai automatique (évite de réessayer en boucle une semaine qui échoue)
// Un appel : bilan d'une semaine (lundi à dimanche), comparé au bilan de la semaine précédente.
async function makeWeekly(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) throw new Error(t('Unknown week.'));
  if (analysing || !getKey()) throw new Error(t('An analysis is already running, try again in a moment.'));
  if (gemini.usage(settings).left <= 0) throw new Error(t('No Gemini calls left today.'));
  if (!journal.weekEntries(data, key).some(journal.hasIdeas)) throw new Error(t('No analysed video this week.'));
  analysing = true;
  jobs.semaine = { step: 'Weekly summary', pct: 0, key };
  pushState();
  try {
    const w = await callGemini(systemPrompt(), journal.weeklyPrompt(data, key), gemini.WEEK_SCHEMA);
    data.semaines = data.semaines || {};
    data.semaines[key] = { ...journal.normalizeWeekly(w, data, key), day: gemini.quotaDay() };
    data.weekError = null;
  } catch (err) {
    data.weekError = { key, message: String(err.message || err).slice(0, 300) };
    throw err;
  } finally {
    delete jobs.semaine;
    analysing = false;
    persist();
    setTimeout(work, 100);
  }
}

// Un appel : bilan d'une période (7 derniers jours, 7 dernières vidéos, mois en cours).
async function makeBilan(period) {
  if (!journal.PERIODS[period]) period = 'jours7';
  if (analysing || !getKey()) throw new Error(t('An analysis is already running, try again in a moment.'));
  if (gemini.usage(settings).left <= 0) throw new Error(t('No Gemini calls left today.'));
  if (!journal.periodEntries(data, period).some(journal.hasIdeas)) throw new Error(t('No analysed video in this period.'));
  analysing = true;
  jobs.bilan = { step: 'Summary', pct: 0 };
  pushState();
  try {
    const b = await callGemini(systemPrompt(), journal.bilanPrompt(data, period), gemini.BILAN_SCHEMA);
    data.bilans.push({ ...journal.normalizeBilan(b, data, period), day: gemini.quotaDay() });
    data.bilans = data.bilans.slice(-20);
    data.bilanDue = false;
    data.bilanError = null;
  } catch (err) {
    data.bilanError = String(err.message || err).slice(0, 300);
    throw err;
  } finally {
    delete jobs.bilan;
    analysing = false;
    persist();
    setTimeout(work, 100);
  }
}

function work() {
  if (data.broken || recordingNow()) return;
  transcribeNext();
  analyseNext().catch(() => {});
  memorySync().catch(() => {});
}
// Reprend le travail régulièrement (nouveau jour de quota, ordinateur sorti de veille).
setInterval(() => { work(); pushState(); }, 10 * 60 * 1000);
// Renommages bloqués (vidéo en cours de lecture) : nouvel essai toutes les 30 secondes.
setInterval(() => { if (journalDir() && data.entries.some((e) => e.renamePending)) tidyJournalFolder(); }, 30 * 1000);
app.whenReady().then(() => { loadJournal(); setTimeout(work, 3000); try { purgeRecs(); } catch (_) {} });
// Fermeture ou plantage de la fenêtre pendant un enregistrement : ce qui est déjà écrit reste sur le disque,
// et sera proposé à la récupération au prochain lancement.
app.on('before-quit', () => { for (const id of [...openRecs.keys()]) closeRec(id); });
app.on('web-contents-created', (_e, wc) => wc.on('render-process-gone', () => { for (const id of [...openRecs.keys()]) closeRec(id); }));

// ---------- IPC ----------
ipcMain.handle('journal-state', () => state());
// Search memory: build it now (even when the journal still fits), or make every vector again.
ipcMain.handle('memory-build', (_e, { again } = {}) => {
  if (!journalDir()) return state();
  saveSettings({ searchMemory: 'on' });
  if (again) { const idx = memIndex(); memory.drop(idx, Object.keys(idx.items)); try { memory.save(mem.dir, idx); } catch (_) {} }
  memError = null; memWaitUntil = 0;
  memorySync().catch(() => {});
  return state();
});

ipcMain.handle('journal-choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: t('Journal folder (videos, journal and transcripts)'),
    defaultPath: journalDir() || app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return state();
  saveSettings({ journalDir: r.filePaths[0] });
  loadJournal();
  persist();
  work();
  return state();
});

ipcMain.handle('journal-choose-export-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: t('Exports folder'), defaultPath: exportsDir(), properties: ['openDirectory', 'createDirectory'] });
  if (!r.canceled && r.filePaths[0]) saveSettings({ exportDir: r.filePaths[0] });
  return state();
});
ipcMain.handle('open-exports', () => { fs.mkdirSync(exportsDir(), { recursive: true }); return shell.openPath(exportsDir()); });

ipcMain.handle('journal-set-key', async (_e, key) => {
  key = String(key || '').trim();
  if (!key) { setKey(null); return state(); }
  const models = await gemini.listModels(fetchFn, key); // checks the key (not counted in the generation quota)
  setKey(key);
  saveSettings({ geminiModels: models, geminiModel: settings.geminiModel && models.includes(settings.geminiModel) ? settings.geminiModel : models[0] });
  geminiPause = null;
  checkTier().then(() => work());
  return state();
});
ipcMain.handle('journal-check-tier', async () => { await checkTier(); return state(); });

ipcMain.handle('journal-settings', (_e, patch) => {
  const ok = {};
  if (patch.model) ok.geminiModel = patch.model;
  if (patch.budget) ok.geminiBudget = Math.max(1, Math.min(1000, +patch.budget || 20));
  if (typeof patch.autoBilan === 'boolean') ok.autoBilan = patch.autoBilan;
  if (typeof patch.autoSemaine === 'boolean') ok.autoSemaine = patch.autoSemaine;
  if (patch.reminder && typeof patch.reminder === 'object') {
    const r = reminder();
    ok.reminder = { on: typeof patch.reminder.on === 'boolean' ? patch.reminder.on : r.on, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.reminder.time || '') ? patch.reminder.time : r.time };
  }
  if (journal.PERIODS[patch.bilanPeriod]) ok.bilanPeriod = patch.bilanPeriod;
  if (patch.whisperModel && whisper.MODELS[patch.whisperModel]) ok.whisperModel = patch.whisperModel;
  if (patch.transcriber === 'gemini' || patch.transcriber === 'whisper') ok.transcriber = patch.transcriber;
  saveSettings(ok);
  if (ok.reminder) { reminderChanged(); applyReminder(); }
  work();
  return state();
});

ipcMain.handle('whisper-install', async (_e, model) => {
  await whisper.install(model, (p) => send('whisper-install-progress', p));
  saveSettings({ whisperModel: model });
  work();
  return state();
});

// Importer des vidéos existantes : copiées dans le dossier du journal si elles n'y sont pas.
ipcMain.handle('journal-import', async () => {
  if (!journalDir()) throw new Error(t('Choose the journal folder first.'));
  assertWritable();
  const r = await dialog.showOpenDialog(win, { title: t('Add videos to the journal'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('Videos'), extensions: VIDEO_EXT }] });
  if (r.canceled) return 0;
  for (const f of r.filePaths) {
    let target = f;
    if (path.dirname(f) !== journalVideosDir()) {
      const p = path.parse(f);
      fs.mkdirSync(journalVideosDir(), { recursive: true });
      target = freePath(journalVideosDir(), journalName(videoDate(f), titleFromName(f)), p.ext);
      send('journal-busy', t('Copying {name}…', { name: p.base }));
      await fs.promises.copyFile(f, target);
    }
    const v = await loadVideo(target);
    addEntry({ file: target, date: videoDate(f), duration: v.info.duration, chapters: v.chapters });
  }
  send('journal-busy', null);
  return r.filePaths.length;
});

const findEntry = (id) => data.entries.find((e) => e.id === id);
ipcMain.handle('journal-entry', (_e, { id, action, patch }) => {
  assertWritable();
  const e = findEntry(id);
  if (!e) return state();
  if (action === 'retranscribe') { e.transcript = null; e.transcriptError = null; e.analysis = null; e.analysisError = null; }
  if (action === 'reanalyse') { e.analysis = null; e.analysisError = null; }
  if (action === 'remove') {
    data.entries = data.entries.filter((x) => x !== e);
    journal.pruneSubjects(data);
    data.precisions = (data.precisions || []).filter((p) => p.entry !== e.id);
    data.checks = journal.checksOf(data).filter((c) => c.entry !== e.id).map((c) => (c.beforeEntry === e.id ? { ...c, beforeEntry: null } : c));
    if (!data.entries.length) Object.defineProperty(data, 'emptiedOnPurpose', { value: true, writable: true, enumerable: false });
  }
  if (action === 'edit' && patch) {
    if (patch.title !== undefined && e.analysis) e.analysis.titre = String(patch.title).trim() || e.analysis.titre;
    else if (patch.title !== undefined) e.title = String(patch.title).trim();
  }
  persist();
  work();
  return state();
});

// Sujets : renommer, conclure / rouvrir, épingler, fusionner, supprimer.
ipcMain.handle('journal-sujet', (_e, { id, action, patch = {} }) => {
  assertWritable();
  const s = data.sujets.find((x) => x.id === id);
  if (!s) return state();
  if (action === 'rename' && String(patch.titre || '').trim()) s.titre = String(patch.titre).trim().slice(0, 120);
  // Conclu ou rouvert à la main : l'état d'avant passe dans l'historique du sujet.
  const byHand = () => { journal.remember(s, 'toi'); s.majLe = Date.now(); s.majPar = null; };
  if (action === 'conclude') { byHand(); s.evolution = t('Marked as concluded by hand.'); s.etat = 'conclu'; if (patch.conclusion !== undefined) s.conclusion = String(patch.conclusion).trim(); }
  if (action === 'reopen') { byHand(); s.evolution = t('Reopened by hand.'); s.etat = 'ouvert'; }
  if (action === 'pin') s.epingle = !s.epingle;
  if (action === 'merge') journal.mergeSubjects(data, s.id, patch.into);
  if (action === 'delete') journal.deleteSubject(data, s.id);
  persist();
  return state();
});

ipcMain.handle('journal-bilan', async (_e, period) => {
  assertWritable();
  if (journal.PERIODS[period]) saveSettings({ bilanPeriod: period });
  await makeBilan(period);
  return state();
});

// ---------- Clarifications, permanent facts, checks ----------
// A clarification corrects one video (1 call): its card, the subjects it fed, what came from it. It stays with the
// video (used again only if that video is analysed again). Without Gemini right now, it waits on the video.
async function fixVideo(e) {
  const texts = (data.precisions || []).filter((p) => p.entry === e.id && !p.appliquee).map((p) => p.texte);
  if (!texts.length) throw new Error(t('No clarification to apply.'));
  if (analysing || !getKey()) throw new Error(t('An analysis is already running, try again in a moment.'));
  if (gemini.usage(settings).left <= 0) throw new Error(t('No Gemini calls left today.'));
  analysing = true;
  jobs[e.id] = { step: 'Correcting this video', pct: 0 };
  pushState();
  try {
    const r = await callGemini(systemPrompt(), journal.videoFixPrompt(data, e, texts), gemini.VIDEO_FIX_SCHEMA);
    const summary = journal.applyVideoFix(data, e, r);
    renameFromAnalysis(e);
    e.fixError = null;
    return summary;
  } catch (err) {
    e.fixError = String(err.message || err).slice(0, 300);
    throw err;
  } finally {
    delete jobs[e.id];
    analysing = false;
    persist();
    setTimeout(work, 100);
  }
}
const canFix = (e) => !!(e && e.analysis && getKey() && !analysing && gemini.usage(settings).left > 0 && !geminiPaused());
// The person is waiting for a correction: the analysis in progress finishes, the next ones wait for it.
let fixQueued = 0;
async function whenIdle(e, ms = 120e3) {
  if (!(e && e.analysis && getKey() && gemini.usage(settings).left > 0 && !geminiPaused())) return;
  fixQueued++;
  try { const t0 = Date.now(); while (analysing && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 300)); }
  finally { fixQueued--; }
}
function addClarification(e, texte) {
  const txt = String(texte || '').trim().slice(0, 2000);
  if (!txt) return null;
  data.precisions = data.precisions || [];
  const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), texte: txt, portee: 'video', entry: e.id, at: Date.now(), appliquee: false };
  data.precisions.push(p);
  return p;
}
// Adds a clarification to a video and corrects it now when possible (otherwise it waits on the video, and is used if
// the video is analysed again). Without text: applies what waits.
ipcMain.handle('journal-clarify', async (_e, { entry, texte }) => {
  assertWritable();
  const e = findEntry(entry);
  if (!e) throw new Error(t('Unknown video.'));
  addClarification(e, texte);
  persist();
  if (!e.analysis) return { state: state(), pending: true };
  await whenIdle(e);
  if (!canFix(e)) return { state: state(), pending: true };
  const summary = await fixVideo(e);
  return { state: state(), summary };
});
// Clarifications of a video: edit (to apply again) or delete.
ipcMain.handle('journal-precision', (_e, { action, id, texte }) => {
  assertWritable();
  data.precisions = data.precisions || [];
  const p = data.precisions.find((x) => x.id === id);
  const txt = String(texte || '').trim().slice(0, 2000);
  if (action === 'edit' && p && txt) { p.texte = txt; p.appliquee = false; }
  if (action === 'delete' && p) data.precisions = data.precisions.filter((x) => x !== p);
  persist();
  return state();
});
// Permanent facts: add, edit, delete.
ipcMain.handle('journal-fact', (_e, a) => {
  assertWritable();
  journal.factEdit(data, a || {});
  persist();
  return state();
});
// A check answered: 'before' (the journal was right), 'now' (the video is right) or 'both'. keep: the answer also
// becomes a permanent fact. The video concerned is corrected when there is something to correct (1 call).
ipcMain.handle('journal-check', async (_e, { id, choice, keep }) => {
  assertWritable();
  const r = journal.checkAnswer(data, id, ['before', 'now', 'both'].includes(choice) ? choice : 'both');
  if (!r) return { state: state() };
  if (keep && r.fact) journal.factEdit(data, { action: 'add', text: r.fact, entry: r.check.entry, source: 'check' });
  const e = r.fix && findEntry(r.fix.entry);
  if (e) addClarification(e, r.fix.text);
  persist();
  if (!e) return { state: state() };
  await whenIdle(e);
  if (!canFix(e)) return { state: state(), pending: true, entry: e.id };
  const summary = await fixVideo(e);
  return { state: state(), summary, entry: e.id };
});

ipcMain.handle('journal-semaine', async (_e, key) => {
  assertWritable();
  await makeWeekly(key);
  return state();
});

ipcMain.handle('journal-rebuild', async () => {
  assertWritable();
  data.rebuild = false;
  await rebuildSubjects();
  return state();
});

// ---------- Language ----------
ipcMain.handle('set-language', (_e, code) => {
  const l = i18n.setLang(code);
  saveSettings({ lang: l });
  // Journal.md is written again in the new language.
  if (journalDir() && !data.broken) persist();
  if (tray) trayMenu();
  appMenu();
  return l;
});

// ---------- You: profile, strengths and weaknesses ----------
// Edits by hand (no Gemini call), and "review": one call that says where the person is on each item of their list
// and suggests new ones.
let profileJob = null;
ipcMain.handle('journal-profile', async (_e, a = {}) => {
  assertWritable();
  if (a.action !== 'review') {
    journal.profileEdit(data, a);
    persist();
    return state();
  }
  if (analysing || !getKey()) throw new Error(t('An analysis is already running, try again in a moment.'));
  if (gemini.usage(settings).left <= 0) throw new Error(t('No Gemini calls left today.'));
  if (!data.entries.some(journal.hasIdeas)) throw new Error(t('No analysed video yet.'));
  analysing = true;
  profileJob = 'review';
  jobs.profile = { step: 'Looking at your strengths and weaknesses', pct: 0 };
  pushState();
  try {
    const q = journal.reviewPrompt(data);
    const r = await callGemini(systemPrompt(), q.prompt, gemini.REVIEW_SCHEMA, null, 0.9);
    journal.applyReview(data, r, { angle: q.angle });
    data.profileError = null;
  } catch (err) {
    data.profileError = String(err.message || err).slice(0, 300);
    throw err;
  } finally {
    delete jobs.profile;
    profileJob = null;
    analysing = false;
    persist();
    setTimeout(work, 100);
  }
  return state();
});

ipcMain.handle('journal-open', (_e, what) => {
  const d = journalDir();
  if (!d) return t('No journal folder.');
  if (what === 'md') return shell.openPath(path.join(d, journal.MD_FILE));
  if (what === 'instructions') return shell.openPath(journal.ensureInstructions(d, DEFAULT_INSTRUCTIONS));
  if (what === 'folder') return shell.openPath(d);
  return '';
});

// ---------- Progress: steps forward, look-back, how far you've come ----------
// Edits by hand (no Gemini call); "lookback-questions" and "report" are one Gemini call each.
let progressJob = null;
ipcMain.handle('journal-progress', async (_e, a = {}) => {
  assertWritable();
  if (a.action === 'lookback-open') { journal.lookbackOpen(data); persist(); return state(); }
  if (a.action === 'lookback-questions' || a.action === 'report' || a.action === 'backfill') return progressCall(a);
  journal.progressEdit(data, a);
  persist();
  return state();
});
async function progressCall(a) {
  if (analysing || !getKey()) throw new Error(t('An analysis is already running, try again in a moment.'));
  if (gemini.usage(settings).left <= 0) throw new Error(t('No Gemini calls left today.'));
  if (!data.entries.some(journal.hasIdeas)) throw new Error(t('No analysed video yet.'));
  analysing = true;
  progressJob = a.action === 'report' ? 'report' : a.action === 'backfill' ? 'backfill' : 'lookback';
  jobs.progress = { step: { report: 'Comparing then and now', backfill: 'Looking for steps forward in your videos', lookback: 'Preparing the look-back' }[progressJob], pct: 0 };
  pushState();
  let added = null;
  try {
    if (a.action === 'backfill') {
      const r = await callGemini(systemPrompt(), journal.backfillPrompt(data), gemini.BACKFILL_SCHEMA);
      added = journal.applyBackfill(data, r);
    } else if (a.action === 'report') {
      const months = [3, 6, 12].includes(+a.months) ? +a.months : 3;
      const q = journal.reportPrompt(data, months);
      const r = await callGemini(systemPrompt(), q.prompt, gemini.REPORT_SCHEMA);
      journal.applyReport(data, r, months, q.from);
    } else {
      const l = journal.lookbackOpen(data);
      const r = await callGemini(systemPrompt(), journal.lookbackPrompt(data, l), gemini.LOOKBACK_SCHEMA, null, 0.8);
      journal.applyLookbackQuestions(data, l, r);
    }
    data.progressError = null;
  } catch (err) {
    data.progressError = String(err.message || err).slice(0, 300);
    throw err;
  } finally {
    delete jobs.progress;
    progressJob = null;
    analysing = false;
    persist();
    setTimeout(work, 100);
  }
  return added === null ? state() : { ...state(), backfillAdded: added };
}

// ---------- Progress reel ----------
// The steps forward of a period in one video, in the exports folder: a card with each step, then the moment it
// started ("then") and the moment it was done, understood or left behind ("now"). Ten steps at most.
ipcMain.handle('progress-reel', async (_e, { months = 0 } = {}) => {
  if (!journalDir()) throw new Error(t('Choose the journal folder first.'));
  if (exportJob) throw new Error(t('An export is already running.'));
  const now = Date.now();
  months = [3, 6, 12].includes(+months) ? +months : 0;
  const from = months ? now - months * 30.5 * 864e5 : 0;
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const usable = (m) => !!(m && byId.has(m.entry) && fs.existsSync(entryPath(byId.get(m.entry))));
  const plan = journal.reelPlan(data, from, now, 10).filter((p) => usable(p.now));
  if (!plan.length) throw new Error(t('No step forward with a video moment in this period.'));
  const infos = new Map();
  const clip = async (m, len, label) => {
    const e = byId.get(m.entry);
    if (!infos.has(e.id)) infos.set(e.id, await render.probe(ffmpeg, entryPath(e)).catch(() => null));
    const i = infos.get(e.id);
    if (!i || !i.duration) return null;
    const dur = Math.min(len, i.duration);
    // A second before the moment (Gemini gives the moment an idea is said, often just after it starts).
    const start = Math.max(0, Math.min(Number.isFinite(m.t) ? m.t - 1 : 0, i.duration - dur));
    return { type: 'clip', file: entryPath(e), start, duration: dur, hasAudio: i.hasAudio, label };
  };
  const day = (ts) => new Date(ts).toLocaleDateString(i18n.locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const C = { accent: '0x00b8a9', muted: '0x9a9ca3', text: '0xe6e7ea' };
  const parts = [{ type: 'card', duration: 4, lines: [
    { text: t('Progress'), size: 76, color: C.text },
    { text: months ? t('From {from} to {to}', { from: day(from), to: day(now) }) : t('Until {date}', { date: day(now) }), size: 34, color: C.muted, gap: 10 },
    { text: tn(plan.length, '{n} step forward', '{n} steps forward'), size: 34, color: C.accent, gap: 6 },
  ] }];
  for (const p of plan) {
    const x = p.item;
    const lines = [{ text: journal.kindLabel(x), size: 32, color: C.accent }];
    if (x.situation) render.wrapText(x.situation, 52, 2).forEach((l, k) => lines.push({ text: l, size: 32, color: C.muted, gap: k ? 0 : 8 }));
    render.wrapText(x.text, 36, 5).forEach((l, k) => lines.push({ text: l, size: 50, color: C.text, gap: k ? 0 : 18 }));
    lines.push({ text: [day(x.date), x.subjectTitle].filter(Boolean).join(' · '), size: 28, color: C.muted, gap: 18 });
    parts.push({ type: 'card', lines, duration: Math.max(3.5, Math.min(8, 2.5 + (x.text.length + (x.situation || '').length) / 18)) });
    if (usable(p.then)) { const c = await clip(p.then, 7, t('Then · {date}', { date: day(p.then.date) })); if (c) parts.push(c); }
    const c = await clip(p.now, 10, t('Now · {date}', { date: day(p.now.date) }));
    if (c) parts.push(c);
  }
  try { fs.mkdirSync(exportsDir(), { recursive: true }); } catch (err) { throw new Error(friendlyFsError(err, exportsDir())); }
  const output = freePath(exportsDir(), exportName(t('Progress reel')), '.mp4');
  const signal = { cancelled: false, kill: null };
  exportJob = signal;
  try {
    const r = await render.reel(ffmpeg, { parts, output, fontFile: findFont(), signal, onProgress: (p) => send('reel-progress', p) });
    return { output, skipped: r.skipped.length };
  } catch (err) {
    fs.rmSync(output, { force: true });
    if (signal.cancelled) throw new Error('EXPORT_ANNULE');
    throw err;
  } finally {
    exportJob = null;
  }
});

// ---------- Daily reminder ----------
// Optional: once a day at the chosen time, a notification with what there is to check (realizations, things left
// behind, a look-back), or a step forward to remember. Carnet then starts with the computer, without its window, and
// stays in the notification area (Windows) or the menu bar (Mac) when its window is closed.
function reminder() {
  const r = settings.reminder || {};
  return { on: !!r.on, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '') ? r.time : '20:00' };
}
let tray = null;
function trayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Open Carnet'), click: () => showWindow() },
    { type: 'separator' },
    { label: t('Quit Carnet'), click: () => { quitting = true; app.quit(); } },
  ]));
}
const localDay = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const reminderAt = (r, now) => { const [h, m] = r.time.split(':').map(Number); const at = new Date(now); at.setHours(h, m, 0, 0); return at; };
// Icon in the notification area (Windows), or in the menu bar (Mac: a black and transparent "template" picture, that
// macOS colours like the other icons there; trayTemplate@2x.png is used on Retina screens).
function trayIcon() {
  const dir = path.join(__dirname, '..', 'build');
  if (!IS_MAC) return nativeImage.createFromPath(path.join(dir, process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
  const img = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}
function applyReminder() {
  const r = reminder();
  // Starts with the computer only while the reminder is on (not for the development version). On a Mac, it then
  // appears in System Settings > General > Login Items.
  if (app.isPackaged) {
    try {
      if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: r.on, path: process.execPath, args: ['--background'], name: 'Carnet' });
      else if (IS_MAC && app.getLoginItemSettings().openAtLogin !== r.on) app.setLoginItemSettings({ openAtLogin: r.on });
    } catch (_) {}
  }
  if (r.on && !tray) {
    try {
      tray = new Tray(trayIcon());
      tray.setToolTip('Carnet');
      // On a Mac, a click on a menu bar icon opens its menu (Open Carnet, Quit Carnet).
      if (!IS_MAC) tray.on('click', () => showWindow());
      trayMenu();
    } catch (_) { tray = null; }
  } else if (!r.on && tray) {
    tray.destroy();
    tray = null;
  }
}
let lastNotification = null; // kept: a notification that is no longer referenced loses its click
function notify(msg) {
  if (!msg || !Notification.isSupported()) return false;
  lastNotification = new Notification({ title: msg.title, body: msg.body, icon: nativeImage.createFromPath(ICON) });
  lastNotification.on('click', () => showWindow('prep'));
  lastNotification.show();
  return true;
}
function reminderTick(now = new Date()) {
  const r = reminder();
  if (!r.on || !journalDir() || data.broken) return;
  const at = reminderAt(r, now);
  if (now < at || settings.reminderDay === localDay(now)) return;
  saveSettings({ reminderDay: localDay(now) });
  // Computer asleep or off at that time: shown when it wakes up, up to 6 hours later.
  if (now - at > 6 * 3600e3) return;
  notify(journal.reminderText(data, now.getTime()));
}
setInterval(() => reminderTick(), 60e3);
// Turned on, or its time changed, after the time of today: the first one is tomorrow.
function reminderChanged() {
  const r = reminder(), now = new Date();
  if (r.on && now >= reminderAt(r, now)) saveSettings({ reminderDay: localDay(now) });
}
// "Try it": the notification of today, now.
ipcMain.handle('reminder-test', () => notify(journal.reminderText(data) || { title: 'Carnet', body: t('Nothing to remember today.') }));
