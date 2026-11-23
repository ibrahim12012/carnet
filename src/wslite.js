'use strict';
// WebSocket côté serveur (RFC 6455), sans dépendance : juste ce qu'il faut pour la page du téléphone.
// Une seule connexion longue, sur le même port et le même chemin HTTPS que la page : si la page s'ouvre,
// le WebSocket passe aussi. Messages texte (JSON) et binaires (vidéo), dans les deux sens.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX = 16 * 1024 * 1024; // un message (image clé, JPEG) ne dépasse jamais ça

function frame(op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

// Refus de la connexion avant l'ouverture (mauvais code, ancienne page…).
function reject(socket, status, text) {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_) {}
}

// Ouvre la connexion (réponse 101). Renvoie { send(texte | Buffer), close(), open, onmessage, onclose }.
function accept(req, socket, head) {
  const key = String(req.headers['sec-websocket-key'] || '');
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setTimeout(0);
  socket.setKeepAlive(true, 10000);
  const ws = { open: true, onmessage: null, onclose: null };
  let chunks = [], total = 0, frags = [], fragOp = 0, fragLen = 0;

  const finish = () => {
    if (!ws.open) return;
    ws.open = false;
    if (ws.onclose) try { ws.onclose(); } catch (_) {}
  };
  const end = (code) => {
    if (ws.open) {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code || 1000);
      try { socket.end(frame(0x8, p)); } catch (_) {}
      const t = setTimeout(() => socket.destroy(), 1000);
      if (t.unref) t.unref();
    }
    finish();
  };
  ws.send = (data) => {
    if (!ws.open) return;
    const text = typeof data === 'string';
    try { socket.write(frame(text ? 0x1 : 0x2, text ? Buffer.from(data, 'utf8') : data)); } catch (_) {}
  };
  ws.close = (code) => end(code || 1000);

  // Retire n octets du début des morceaux reçus (une seule copie).
  const take = (n) => {
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const c = chunks[0], k = Math.min(c.length, n - o);
      c.copy(out, o, 0, k);
      o += k;
      if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
    }
    total -= n;
    return out;
  };
  const parse = () => {
    while (ws.open && total >= 2) {
      if (chunks[0].length < 14 && chunks.length > 1) chunks = [Buffer.concat(chunks)];
      const h = chunks[0];
      let len = h[1] & 0x7f, off = 2;
      if (len === 126) { if (h.length < 4) return; len = h.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (h.length < 10) return;
        const big = h.readBigUInt64BE(2);
        if (big > BigInt(MAX)) return end(1009);
        len = Number(big); off = 10;
      }
      if (!(h[1] & 0x80)) return end(1002); // le navigateur masque toujours ses trames
      if (len > MAX) return end(1009);
      const need = off + 4 + len;
      if (total < need) return;
      const fin = (h[0] & 0x80) !== 0, op = h[0] & 0x0f;
      const fr = take(need);
      const payload = fr.subarray(off + 4);
      for (let i = 0; i < len; i++) payload[i] ^= fr[off + (i & 3)];
      if (op === 0x8) return end(1000);
      if (op === 0x9) { try { socket.write(frame(0xA, payload)); } catch (_) {} continue; }
      if (op === 0xA) continue;
      if (op !== 0x0 && op !== 0x1 && op !== 0x2) return end(1002);
      if (op !== 0x0) { fragOp = op; frags = []; fragLen = 0; }
      frags.push(payload);
      fragLen += len;
      if (fragLen > MAX) return end(1009);
      if (!fin) continue;
      const data = frags.length === 1 ? frags[0] : Buffer.concat(frags);
      frags = []; fragLen = 0;
      if (ws.onmessage) try { ws.onmessage(fragOp === 0x1 ? data.toString('utf8') : data); } catch (_) {}
    }
  };
  socket.on('data', (d) => { chunks.push(d); total += d.length; parse(); });
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('error', () => {});
  if (head && head.length) { chunks.push(Buffer.from(head)); total += head.length; parse(); }
  return ws;
}

module.exports = { accept, reject };
