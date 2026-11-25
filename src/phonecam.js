'use strict';
// Caméra du téléphone, sur le principe d'OmniCam (github.com/Orest-Z/OmniCam, licence MIT) :
//  1. Carnet sert une page web en HTTPS sur le réseau local (certificat auto-signé, port 28451).
//  2. Le QR code affiché dans Carnet contient l'adresse de cette page et un jeton secret (?t=…).
//  3. Le téléphone ouvre la page et sa caméra (vidéo seulement, pas de micro). L'image part tout de suite par
//     un WebSocket sur ce même serveur (/api/ws) : vidéo compressée par le téléphone (H.264 ou VP8), ou images
//     JPEG en dernier recours. Ce chemin passe dès que la page s'ouvre.
//  4. En même temps, le téléphone essaie la vidéo directe WebRTC (offre à /api/session, transmise à la fenêtre
//     qui répond). Il n'y passe que quand la fenêtre confirme qu'elle en reçoit les images. Rien ne sort du
//     réseau local.
// Différence avec OmniCam : pas de caméra virtuelle Windows. La vidéo arrive directement dans la fenêtre
// d'enregistrement de Carnet, et le son vient du micro de l'ordinateur.
//  5. Or the phone records itself ("Recorded by: the phone"): picture and sound at the camera's full quality, sent
//     in pieces of about a second to /api/rec, one request each. Each answer says how many pieces are written to the
//     disk (src/phonerec.js); the phone keeps the others and sends them again after a cut. Orders from Carnet (arm,
//     start, stop) go by the WebSocket, or in the answer to the phone's next request when the WebSocket is down.
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const selfcert = require('./selfcert');
const wslite = require('./wslite');
const qrcode = require('./vendor/qrcode');
const i18n = require('./i18n');
const { t } = i18n;

const PORT = 28451;
const PAGE = path.join(__dirname, 'phone', 'index.html');
const ANSWER_TIMEOUT_MS = 12000;
// Version de la page du téléphone. Une page plus ancienne encore ouverte sur le téléphone est rechargée
// (ou, pour les toutes premières versions qui ne savent pas se recharger, invitée à rescanner le QR code).
const PAGE_VERSION = 7;

// Adresses IPv4 du réseau local que le téléphone peut joindre, la plus probable d'abord (Wi-Fi, adresse privée,
// pas une carte virtuelle).
// On a Mac, Wi-Fi and Ethernet are both "en0", "en1"…; "bridge…", "vmenet…" and "anpi…" are virtual machines and
// USB links, "utun…" the VPNs.
const WIFI = /wi-?fi|wlan|wireless|802\.11|^en\d+$/i;
const VIRTUAL = /vmware|virtualbox|vbox|hyper-v|vethernet|docker|wsl|tailscale|zerotier|hamachi|loopback|bluetooth|npcap|tap-|tun|^bridge\d|^vmenet|^anpi/i;
const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
function lanAddresses() {
  const out = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const i of infos || []) {
      if (i.family !== 'IPv4' || i.internal || /^169\.254\./.test(i.address)) continue;
      out.push({ ip: i.address, name, wifi: WIFI.test(name) });
    }
  }
  const score = (a) => (a.wifi ? 4 : 0) + (isPrivate(a.ip) ? 2 : 0) - (VIRTUAL.test(a.name) ? 8 : 0);
  return out.sort((a, b) => score(b) - score(a));
}

// Remplace les adresses masquées « .local » des candidats ICE par une vraie adresse IPv4.
function unmaskCandidates(sdp, localAddress) {
  const ip = String(localAddress || '').replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return sdp;
  let seen = false;
  const out = sdp.split(/\r?\n/).map((l) => {
    const m = /^(a=candidate:\S+ \d+ \S+ \d+ )(\S+\.local)( .*)$/i.exec(l);
    if (!m) return l;
    seen = true;
    return m[1] + ip + m[3];
  });
  return seen ? out.join('\r\n') : sdp;
}

// Comparaison du jeton en temps constant.
function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8'), b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setup({ app, ipcMain, getWin }) {
  // Code secret du QR code, gardé d'un lancement à l'autre : un onglet resté ouvert sur le téléphone se
  // reconnecte tout seul après un redémarrage de Carnet. Il ne change qu'avec « Nouveau QR code ».
  const tokenFile = () => path.join(app.getPath('userData'), 'tls', 'code.txt');
  const newToken = () => {
    const t = crypto.randomBytes(16).toString('base64url');
    try { fs.mkdirSync(path.dirname(tokenFile()), { recursive: true }); fs.writeFileSync(tokenFile(), t, { mode: 0o600 }); } catch (_) {}
    return t;
  };
  let token = null;
  try { token = fs.readFileSync(tokenFile(), 'utf8').trim(); } catch (_) {}
  if (!token || token.length < 16) token = newToken();
  // La fenêtre dit si elle reçoit vraiment la vidéo directe (WebRTC) : le téléphone n'arrête d'envoyer les
  // images de secours que quand c'est confirmé.
  let directStatus = { direct: false, at: 0 };
  ipcMain.on('phone-direct-status', (_e, ok) => { directStatus = { direct: !!ok, at: Date.now() }; });
  const directNow = () => directStatus.direct && Date.now() - directStatus.at < 2500;
  // Version de la page qui parle : trop ancienne pour se recharger seule -> « rescanne » ; ancienne -> rechargement.
  const pageCheck = (req, res, v) => {
    const n = Number(v) || 0;
    if (n < 3) { contact(req.socket.remoteAddress, 'old-page'); json(res, 403, { ok: false, error: 'bad-token', reason: 'old-page' }); return false; }
    if (n < PAGE_VERSION) { json(res, 409, { ok: false, error: 'reload' }); return false; }
    return true;
  };
  // Dernier contact du téléphone, affiché dans Carnet pour savoir où ça bloque.
  let lastContact = null;
  const contact = (ip, kind, detail) => {
    lastContact = { at: Date.now(), ip, kind, detail: detail || null };
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send('phone-contact', lastContact);
  };
  // Flux du téléphone par WebSocket. Un seul téléphone à la fois : une nouvelle connexion remplace l'ancienne
  // quand celle-ci n'envoie plus rien.
  let phoneWs = null, phoneWsSeen = 0;
  const toWin = (m) => { const win = getWin(); if (win && !win.isDestroyed()) win.webContents.send('phone-stream', m); };
  // Messages for the phone: by the WebSocket, or kept and given in the answer to its next request (status, picture,
  // recording piece) while the WebSocket is down. Only the last "arm" is kept: it says the current state.
  const outbox = [];
  let armedNow = false;
  function send(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'arm') armedNow = !!msg.on;
    if (phoneWs && phoneWs.open) { phoneWs.send(JSON.stringify(msg)); return; }
    if (msg.type === 'arm') { const i = outbox.findIndex((m) => m.type === 'arm'); if (i >= 0) outbox.splice(i, 1); }
    outbox.push(msg);
    if (outbox.length > 40) outbox.shift();
  }
  const takeOutbox = () => outbox.splice(0, outbox.length);
  ipcMain.on('phone-stream-send', (_e, msg) => send(msg));
  // The phone is there: WebSocket open, or a request in the last 4 seconds.
  const present = () => !!(phoneWs && phoneWs.open) || !!(lastContact && Date.now() - lastContact.at < 4000);
  let recHooks = null;
  function upgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'https://localhost');
    const ip = req.socket.remoteAddress;
    if (url.pathname !== '/api/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) return wslite.reject(socket, 400, 'Bad Request');
    if (!tokenMatches(url.searchParams.get('t'), token)) { contact(ip, 'bad-token'); return wslite.reject(socket, 403, 'Forbidden'); }
    const v = Number(url.searchParams.get('v')) || 0;
    if (v < 3) { contact(ip, 'old-page'); return wslite.reject(socket, 403, 'Forbidden'); }
    if (v < PAGE_VERSION) return wslite.reject(socket, 409, 'Conflict');
    const ws = wslite.accept(req, socket, head);
    // Une page envoie déjà l'image (autre onglet, autre téléphone) : la nouvelle attend son tour au lieu de
    // lui couper la connexion, sinon les deux se la voleraient sans fin.
    if (phoneWs && phoneWs.open && Date.now() - phoneWsSeen < 1500) { ws.close(4001); return; }
    if (phoneWs) phoneWs.close();
    phoneWs = ws;
    toWin({ kind: 'open' });
    let seen = 0;
    ws.onmessage = (m) => {
      if (phoneWs !== ws) return;
      if (typeof m === 'string') {
        let msg;
        try { msg = JSON.parse(m); } catch (_) { return; }
        if (msg.type === 'config') toWin({ kind: 'config', codec: String(msg.codec || '').slice(0, 64), width: msg.width | 0, height: msg.height | 0, description: typeof msg.description === 'string' ? msg.description.slice(0, 8192) : null });
        else if (msg.type === 'facing') toWin({ kind: 'facing', facing: msg.facing === 'environment' ? 'environment' : 'user', width: Math.min(8192, msg.width | 0), height: Math.min(8192, msg.height | 0) });
        // Sound level of the phone's microphone (Carnet's meter), state of that microphone, recording started or refused.
        else if (msg.type === 'level') toWin({ kind: 'level', v: Math.max(0, Math.min(1, Number(msg.v) || 0)) });
        else if (msg.type === 'mic') toWin({ kind: 'mic', ok: !!msg.ok, error: msg.error ? String(msg.error).slice(0, 60) : null });
        else if ((msg.type === 'started' || msg.type === 'error') && recHooks) { try { Promise.resolve(recHooks.event(msg)).catch(() => {}); } catch (_) {} }
        return;
      }
      // Binaire : 1 octet de type (1 image clé, 2 image suivante, 3 JPEG), 8 octets d'horodatage, puis les données.
      if (m.length < 10) return;
      const t = m[0];
      const ts = m.readDoubleBE(1);
      phoneWsSeen = Date.now();
      if (t === 1 || t === 2) toWin({ kind: 'chunk', key: t === 1, ts, data: m.subarray(9) });
      else if (t === 3) toWin({ kind: 'jpeg', data: m.subarray(9) });
      // Accusé de réception : le téléphone mesure ainsi le retard du Wi-Fi et allège la vidéo s'il s'accumule.
      ws.send(JSON.stringify({ type: 'ack', ts }));
      const now = Date.now();
      if (now - seen > 2000) { seen = now; contact(ip, 'frame'); }
    };
    ws.onclose = () => { if (phoneWs === ws) { phoneWs = null; toWin({ kind: 'close' }); } };
  }
  let server = null, port = null, starting = null;
  let negotiating = false;
  const pending = new Map(); // id d'offre -> { resolve, reject, timer }
  const attempts = new Map(); // ip -> horodatages (20 essais par minute au plus)

  // Certificat gardé d'une fois sur l'autre : l'avertissement du téléphone n'apparaît qu'une fois.
  // Refait seulement si une nouvelle adresse apparaît (en gardant les anciennes) ou s'il expire bientôt.
  function loadCert() {
    const dir = path.join(app.getPath('userData'), 'tls');
    const files = { key: path.join(dir, 'server.key'), cert: path.join(dir, 'server.crt'), meta: path.join(dir, 'meta.json') };
    const current = lanAddresses().map((a) => a.ip);
    let covered = [];
    try {
      const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
      covered = meta.ips || [];
      if (current.every((ip) => covered.includes(ip)) && meta.notAfter - Date.now() > 30 * 864e5) {
        return { key: fs.readFileSync(files.key, 'utf8'), cert: fs.readFileSync(files.cert, 'utf8') };
      }
    } catch (_) {}
    const ips = [...new Set([...current, ...covered, '127.0.0.1'])].slice(0, 32);
    const c = selfcert.create({ commonName: 'Carnet', ips, dns: ['localhost'] });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(files.key, c.key, { mode: 0o600 });
    fs.writeFileSync(files.cert, c.cert);
    fs.writeFileSync(files.meta, JSON.stringify({ ips, notAfter: c.notAfter }));
    return c;
  }

  const withOutbox = () => (outbox.length ? { msgs: takeOutbox() } : {});
  const json = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
    res.end(data);
  };
  async function readJson(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > limit) throw new Error('trop gros'); chunks.push(c); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function allow(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 60000);
    if (list.length >= 20) return false;
    list.push(now);
    attempts.set(ip, list);
    return true;
  }

  // L'offre du téléphone est envoyée à la fenêtre, qui crée la connexion et renvoie sa réponse.
  function askWindow(offer) {
    const win = getWin();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('window closed'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timed out')); }, ANSWER_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      win.webContents.send('phone-offer', { id, ...offer });
    });
  }
  ipcMain.handle('phone-answer', (_e, { id, sdp, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (error || !sdp) p.reject(new Error(error || 'no answer')); else p.resolve(sdp);
  });

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'https://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'carnet' });
    if (req.method === 'POST' && url.pathname === '/api/session') {
      let body;
      try {
        body = await readJson(req);
        if (typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) throw new Error('offre invalide');
      } catch (_) { return json(res, 400, { ok: false, error: 'bad-request' }); }
      if (!tokenMatches(body.token, token)) { contact(req.socket.remoteAddress, 'bad-token'); return json(res, 403, { ok: false, error: 'bad-token' }); }
      if (!pageCheck(req, res, body.v)) return;
      contact(req.socket.remoteAddress, 'offer');
      const ip = req.socket.remoteAddress || '?';
      if (negotiating || !allow(ip)) {
        res.setHeader('retry-after', '3');
        return json(res, 429, { ok: false, error: 'busy', retryAfterSeconds: 3 });
      }
      negotiating = true;
      try {
        const answer = await askWindow({ sdp: body.sdp, device: String((body.device && body.device.platform) || '').slice(0, 40) });
        // Sécurité en plus : si l'adresse de l'ordinateur est encore masquée (« xxxx.local »), on met à la place
        // l'adresse par laquelle le téléphone vient de joindre l'ordinateur.
        const sdp = unmaskCandidates(answer, req.socket.localAddress);
        contact(req.socket.remoteAddress, 'answered');
        return json(res, 200, { ok: true, sdp });
      } catch (err) {
        contact(req.socket.remoteAddress, 'no-answer', err.message);
        return json(res, 503, { ok: false, error: 'unavailable', message: t('Carnet did not answer. Check that Carnet is open, then try again.') });
      } finally { negotiating = false; }
    }
    // Le téléphone vérifie que Carnet reçoit toujours la vidéo directe (une fois par seconde).
    if (req.method === 'POST' && url.pathname === '/api/status') {
      if (!tokenMatches(req.headers['x-carnet-code'], token)) { contact(req.socket.remoteAddress, 'bad-token'); return json(res, 403, { ok: false, error: 'bad-token' }); }
      if (!pageCheck(req, res, req.headers['x-carnet-v'])) return;
      for await (const _c of req) { /* corps vide */ }
      if (!lastContact || lastContact.kind !== 'direct' || Date.now() - lastContact.at > 5000) contact(req.socket.remoteAddress, 'direct');
      return json(res, 200, { ok: true, direct: directNow(), ...withOutbox() });
    }
    // Chemin de secours : une image JPEG par requête, transmise à la fenêtre. La réponse dit si Carnet reçoit
    // aussi la vidéo directe.
    if (req.method === 'POST' && url.pathname === '/api/frame') {
      if (!tokenMatches(req.headers['x-carnet-code'], token)) { contact(req.socket.remoteAddress, 'bad-token'); return json(res, 403, { ok: false, error: 'bad-token' }); }
      if (!pageCheck(req, res, req.headers['x-carnet-v'])) return;
      const chunks = [];
      let size = 0;
      try { for await (const c of req) { size += c.length; if (size > 4 * 1024 * 1024) throw new Error('trop gros'); chunks.push(c); } }
      catch (_) { return json(res, 413, { ok: false }); }
      const win = getWin();
      if (!win || win.isDestroyed()) return json(res, 503, { ok: false });
      const facing = req.headers['x-carnet-facing'] === 'environment' ? 'environment' : 'user';
      win.webContents.send('phone-frame', { data: Buffer.concat(chunks), facing });
      if (!lastContact || lastContact.kind !== 'frame' || Date.now() - lastContact.at > 2000) contact(req.socket.remoteAddress, 'frame');
      return json(res, 200, { ok: true, direct: directNow(), ...withOutbox() });
    }
    // Recording made by the phone: one piece per request (body), or an event (JSON). The answer says how many pieces
    // are on the disk; nothing is acknowledged before it is written.
    if (req.method === 'POST' && (url.pathname === '/api/rec' || url.pathname === '/api/rec-event')) {
      if (!tokenMatches(req.headers['x-carnet-code'], token)) { contact(req.socket.remoteAddress, 'bad-token'); return json(res, 403, { ok: false, error: 'bad-token' }); }
      if (!pageCheck(req, res, req.headers['x-carnet-v'])) return;
      if (!recHooks) { for await (const _c of req) { /* ignoré */ } return json(res, 503, { ok: false }); }
      const chunks = [];
      let size = 0;
      const limit = url.pathname === '/api/rec' ? 16 * 1024 * 1024 : 64 * 1024;
      try { for await (const c of req) { size += c.length; if (size > limit) throw new Error('trop gros'); chunks.push(c); } }
      catch (_) { return json(res, 413, { ok: false }); }
      if (!lastContact || Date.now() - lastContact.at > 2000) contact(req.socket.remoteAddress, 'rec');
      try {
        let a;
        if (url.pathname === '/api/rec') {
          const seq = Number(url.searchParams.get('seq'));
          const id = String(url.searchParams.get('id') || '');
          if (!/^[\w-]{1,40}$/.test(id) || !Number.isInteger(seq) || seq < 0) return json(res, 400, { ok: false });
          a = await recHooks.chunk(id, seq, Buffer.concat(chunks), { mime: String(req.headers['x-carnet-mime'] || '').slice(0, 100), total: Number(req.headers['x-carnet-total']) || 0 });
        } else {
          let msg;
          try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return json(res, 400, { ok: false }); }
          if (!msg || typeof msg.type !== 'string') return json(res, 400, { ok: false });
          if (msg.type === 'mic') { toWin({ kind: 'mic', ok: !!msg.ok, error: msg.error ? String(msg.error).slice(0, 60) : null }); a = {}; }
          else a = await recHooks.event(msg);
        }
        return json(res, 200, { ok: true, ...(a || {}), ...withOutbox() });
      } catch (err) {
        // Not written (disk refused everywhere): the phone keeps the piece and tries again.
        return json(res, 500, { ok: false, error: String(err && err.message || err).slice(0, 200) });
      }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
      // The page is written in English; the strings of the app's language are added to it (only those it uses).
      const html = fs.readFileSync(PAGE, 'utf8');
      const strings = JSON.stringify({ lang: i18n.lang, dict: i18n.subset(i18n.lang, html), armed: armedNow }).replace(/</g, '\\u003c');
      const page = Buffer.from(html.replace('/*I18N*/', `const I18N = ${strings};`), 'utf8');
      contact(req.socket.remoteAddress, 'page');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length, 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : page);
    }
    res.writeHead(404).end('not found');
  }

  async function start() {
    if (server) return;
    if (starting) return starting;
    starting = (async () => {
      const tls = loadCert();
      const s = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => {
        handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      });
      s.keepAliveTimeout = 15000;
      s.on('upgrade', (req, socket, head) => { try { upgrade(req, socket, head); } catch (_) { socket.destroy(); } });
      const listen = (p) => new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(p, '0.0.0.0', () => { s.off('error', reject); resolve(s.address().port); });
      });
      try { port = await listen(PORT); } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
        port = await listen(0);
      }
      server = s;
    })();
    try { await starting; } finally { starting = null; }
  }

  // Ce que la fenêtre affiche : adresse, QR code (SVG), autres adresses possibles.
  function pairing() {
    const addrs = lanAddresses();
    const ip = addrs[0] ? addrs[0].ip : null;
    const url = ip ? `https://${ip}:${port}/?t=${token}` : null;
    let svg = null;
    if (url) {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }
    return { url, ip, port, svg, addresses: addrs.map((a) => a.ip), lastContact };
  }

  ipcMain.handle('phone-start', async () => {
    try { await start(); } catch (err) {
      return { error: t('The server for the phone could not start: {why}', { why: err.message }) };
    }
    return pairing();
  });
  // Nouveau QR code : l'ancien ne marche plus (utile si quelqu'un d'autre l'a vu).
  ipcMain.handle('phone-new-code', () => { token = newToken(); return server ? pairing() : null; });
  // Règle du pare-feu Windows pour Carnet (tous les profils réseau, y compris « Public »), avec la demande
  // d'autorisation administrateur de Windows. Sert quand le téléphone n'arrive pas à joindre l'ordinateur.
  ipcMain.handle('phone-allow-firewall', () => new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ ok: false, error: t('Only on Windows.') }); return; }
    const exe = process.execPath.replace(/'/g, "''");
    const args = `advfirewall firewall delete rule name="Carnet" & netsh advfirewall firewall add rule name="Carnet" dir=in action=allow program="${exe}" enable=yes profile=any`;
    const ps = `Start-Process -FilePath cmd.exe -ArgumentList '/c netsh ${args.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: /cancel|annul/i.test(err) ? t('Permission refused.') : (err.trim() || `code ${code}`).slice(0, 200) }));
  }));

  app.on('before-quit', () => {
    if (phoneWs) phoneWs.close();
    if (server) { server.close(); server.closeAllConnections && server.closeAllConnections(); }
  });
  return {
    lanAddresses,
    send,
    present,
    // Where the pieces of a recording made by the phone go (src/phonerec.js).
    attach(hooks) { recHooks = hooks; },
  };
}

module.exports = { setup, lanAddresses, tokenMatches, unmaskCandidates };
