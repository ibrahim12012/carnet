'use strict';
// Recordings made by the phone itself ("Recorded by: the phone"; see src/phone/index.html and src/phonecam.js).
// The phone sends its file in numbered pieces. Each piece is written to the disk in order, then acknowledged: the
// answer always says how many pieces are on the disk, and the phone keeps every other one. A piece that arrives twice
// is acknowledged again without being written; a piece ahead of the expected one is not written, and the answer says
// which one is expected. The recording is complete when the phone has said which piece is the last one and all of
// them are on the disk; it is then prepared like a recording made by the computer (finalizeRec in main.js).
// If the window needs the recording before it is complete (phone gone), a copy of what has arrived is prepared and
// the rest is still taken when the phone comes back: the complete version then becomes a recording of its own,
// listed in "Recordings". Nothing that arrives is thrown away.
const fs = require('fs');

// Turns the video track of an MP4 file by `deg` (clockwise), written in place in its header, the way phones mark a
// video filmed upright: nothing is re-encoded. A rotation already marked (an iPhone may write one) is added to.
// Returns false when the file is not an MP4 it can read.
function setMp4Rotation(file, deg) {
  const add = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    // Top-level boxes, up to "moov".
    let pos = 0, moov = null;
    while (pos + 8 <= size) {
      const h = read(pos, 16);
      let len = h.readUInt32BE(0), hdr = 8;
      const type = h.toString('latin1', 4, 8);
      if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr) return false;
      if (type === 'moov') { moov = { pos, len }; break; }
      pos += len;
    }
    if (!moov || moov.len > 64 * 1024 * 1024) return false;
    const buf = read(moov.pos, moov.len);
    const boxes = (start, end) => {
      const out = [];
      let p = start;
      while (p + 8 <= end) {
        let len = buf.readUInt32BE(p), hdr = 8;
        const type = buf.toString('latin1', p + 4, p + 8);
        if (len === 1) { len = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (len === 0) len = end - p;
        if (len < hdr || p + len > end) break;
        out.push({ type, body: p + hdr, end: p + len });
        p += len;
      }
      return out;
    };
    let done = false;
    for (const trak of boxes(8, buf.length).filter((b) => b.type === 'trak')) {
      const kids = boxes(trak.body, trak.end);
      const tkhd = kids.find((b) => b.type === 'tkhd'), mdia = kids.find((b) => b.type === 'mdia');
      if (!tkhd || !mdia) continue;
      const hdlr = boxes(mdia.body, mdia.end).find((b) => b.type === 'hdlr');
      if (!hdlr || buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
      // tkhd: version and flags (4), times, track and duration (20 or 32), reserved, layer, group, volume (16),
      // then the matrix (9 x 4 bytes), the width and the height (16.16).
      const m = tkhd.body + 4 + (buf[tkhd.body] === 1 ? 32 : 20) + 16;
      if (m + 44 > tkhd.end) continue;
      const w = buf.readUInt32BE(m + 36) >>> 16, h = buf.readUInt32BE(m + 40) >>> 16;
      const a0 = buf.readInt32BE(m) / 65536, b0 = buf.readInt32BE(m + 4) / 65536;
      const had = a0 > 0.5 ? 0 : a0 < -0.5 ? 180 : b0 > 0.5 ? 90 : b0 < -0.5 ? 270 : 0;
      const turn = (had + add) % 360;
      const [a, b, c, dd, tx, ty] = turn === 90 ? [0, 1, -1, 0, h, 0] : turn === 180 ? [-1, 0, 0, -1, w, h] : turn === 270 ? [0, -1, 1, 0, 0, w] : [1, 0, 0, 1, 0, 0];
      const vals = [a * 65536, b * 65536, 0, c * 65536, dd * 65536, 0, tx * 65536, ty * 65536, 0x40000000];
      const out = Buffer.alloc(36);
      vals.forEach((v, i) => out.writeInt32BE(v | 0, i * 4));
      fs.writeSync(fd, out, 0, 36, moov.pos + m);
      done = true;
    }
    return done;
  } finally { fs.closeSync(fd); }
}

// d: what main.js gives: recs(), saveRecs(), recById(id), writeRec(r, buf), closeRec(id), finalize(r, opts),
// toWin(payload), send(msg), present(), t().
function create(d) {
  const { t } = d;
  const num = (x, dflt) => (Number.isFinite(Number(x)) ? Number(x) : dflt);
  const msgOf = (err) => String((err && err.message) || err);
  const completing = new Map(); // id -> preparation in progress (normal end)
  const results = new Map();    // id -> prepared recording, for a window that asks after the end
  const sent = new Map();       // id -> last progress sent

  function progress(r, force) {
    const now = Date.now();
    if (!force && now - (sent.get(r.id) || 0) < 300) return;
    sent.set(r.id, now);
    d.toWin({ kind: 'progress', id: r.id, received: r.bytes, total: Math.max(r.total || 0, r.bytes), ended: r.last !== null });
  }
  const checkComplete = (r) => { if (r.receiving && r.last !== null && r.nextSeq > r.last) complete(r); };

  function complete(r) {
    r.receiving = false;
    d.saveRecs();
    d.closeRec(r.id);
    if (!r.bytes) {
      // Nothing was recorded (stopped at once, camera refused): nothing to keep.
      Object.assign(r, { status: 'deleted', deletedAt: Date.now() });
      d.saveRecs();
      d.toWin({ kind: 'empty', id: r.id });
      return null;
    }
    if (r.partial) {
      // The beginning was already given to the window: the complete recording becomes a recording of its own.
      const stamp = Date.now();
      const c = { id: r.id + 'c', phone: true, raw: r.raw, parts: r.parts, file: null, status: 'recording', receiving: false, startedAt: r.startedAt, at: stamp, duration: null,
        rotation: r.rotation, lead: r.lead, ext: r.ext, mime: r.mime, bytes: r.bytes, nextSeq: r.nextSeq, last: r.last, rescue: true };
      r.parts = []; r.raw = null;
      d.recs().push(c);
      d.saveRecs();
      const p = d.finalize(c)
        .then((res) => { d.toWin({ kind: 'complete', id: r.id, recId: c.id, result: res }); return res; })
        .catch((err) => { d.toWin({ kind: 'complete-failed', id: r.id, recId: c.id, error: msgOf(err) }); return null; });
      return p;
    }
    const p = d.finalize(r)
      .then((res) => {
        Object.assign(res.info, { lead: r.lead, stopAfter: r.stopAfter });
        res.reason = r.reason;
        if (r.abandoned) { Object.assign(r, { status: 'deleted', deletedAt: Date.now() }); d.saveRecs(); }
        results.set(r.id, res);
        d.toWin({ kind: 'done', id: r.id, result: res, abandoned: !!r.abandoned, rescue: !!r.rescue });
        return res;
      })
      .catch((err) => { d.toWin({ kind: 'failed', id: r.id, error: msgOf(err) }); throw err; })
      .finally(() => completing.delete(r.id));
    p.catch(() => {});
    completing.set(r.id, p);
    return p;
  }

  // A recording this computer does not know (Carnet's list lost, or one sent to another computer at the same
  // address): taken in anyway, from the first piece the phone still has, and listed in "Recordings".
  function adopt(id, m) {
    const stamp = Date.now();
    const mime = String(m.mime || '').slice(0, 100);
    const r = { id, phone: true, raw: null, parts: [], file: null, status: 'recording', receiving: true, startedAt: stamp, at: stamp, duration: null,
      rotation: 0, lead: 0, nextSeq: Math.max(0, num(m.first, 0) | 0), bytes: 0, total: 0, last: null, ext: mime ? (/mp4/i.test(mime) ? 'mp4' : 'webm') : null, mime, rescue: true, adopted: true };
    if (r.nextSeq > 0) r.gap = true;
    d.recs().push(r);
    d.saveRecs();
    return r;
  }

  return {
    // The window starts a recording: Carnet notes it, then tells the phone.
    start({ lead = 3, rotation = 0, startedAt } = {}) {
      if (!d.present()) throw new Error(t('The phone is not connected. Check that the Carnet page is open and on screen on the phone.'));
      const stamp = Date.now();
      const r = { id: 'p' + stamp.toString(36), phone: true, raw: null, parts: [], file: null, status: 'recording', receiving: true, startedAt: startedAt || stamp, at: stamp, duration: null,
        rotation: ((Math.round(num(rotation, 0) / 90) * 90) % 360 + 360) % 360, lead: num(lead, 3), nextSeq: 0, bytes: 0, total: 0, last: null, ext: null, mime: '' };
      d.recs().push(r);
      d.saveRecs();
      d.send({ type: 'rec-start', id: r.id, lead: r.lead });
      return r.id;
    },
    // Stop asked in the window. Kept: if the phone does not get it now, it gets it with its next request.
    stop(id, stopAfter) {
      const r = d.recById(id);
      if (!r || !r.phone) return;
      r.stopRequested = true;
      if (Number.isFinite(stopAfter)) r.stopAfter = stopAfter;
      d.saveRecs();
      d.send({ type: 'rec-stop', id });
    },
    // Window closed during the recording: the recording ends and goes to the deleted ones (kept 7 days), like a
    // recording made by the computer.
    abandon(id) {
      const r = d.recById(id);
      if (!r || !r.phone) return;
      r.abandoned = true;
      this.stop(id);
      // Still taken if pieces arrive after all (the phone started late): kept with the deleted ones.
      if (r.receiving || r.file) { Object.assign(r, { status: 'deleted', deletedAt: Date.now() }); d.saveRecs(); }
    },
    // The window does not wait any longer: what has arrived, prepared now. The rest is still taken later.
    async finishNow(id) {
      const r = d.recById(id);
      if (!r) throw new Error(t('Recording not found'));
      if (completing.has(id)) return completing.get(id);
      if (results.has(id)) return results.get(id);
      if (!r.receiving && r.file && fs.existsSync(r.file)) return d.finalize(r, { existing: true });
      if (!r.bytes) throw new Error(t('Nothing from this recording has reached the computer yet.'));
      const res = await d.finalize(r, { snapshot: true });
      r.partial = true;
      d.saveRecs();
      Object.assign(res.info, { lead: r.lead, stopAfter: r.stopAfter });
      res.partial = true;
      return res;
    },
    receiving: (id) => { const r = d.recById(id); return !!(r && r.phone && r.receiving); },

    // One piece from the phone.
    async chunk(id, seq, buf, meta = {}) {
      const r = d.recById(id);
      if (!r || !r.phone) return { resume: true };
      if (!r.receiving) return { next: Math.max(r.nextSeq, seq + 1), end: r.last !== null };
      if (meta.total) r.total = Math.max(r.total || 0, meta.total);
      if (!r.ext && meta.mime) { r.mime = meta.mime; r.ext = /mp4/i.test(meta.mime) ? 'mp4' : 'webm'; }
      if (!r.ext) r.ext = 'webm';
      if (seq === r.nextSeq) {
        d.writeRec(r, buf); // throws if no folder accepts it: not acknowledged, the phone sends it again
        r.nextSeq++;
        r.bytes += buf.length;
        r.lastAt = Date.now();
        if (!r.startedSeen) { r.startedSeen = true; d.toWin({ kind: 'started', id }); }
        d.saveRecs();
        progress(r);
        checkComplete(r);
      }
      return { next: r.nextSeq, ...(r.stopRequested && r.receiving ? { stop: true } : {}) };
    },

    // An event from the phone: started, refused, end, piece lost on the phone, or "which piece next?" after a cut.
    async event(m) {
      const id = String(m.id || '');
      if (!/^[\w-]{1,40}$/.test(id)) return { ok: false };
      let r = d.recById(id);
      if (r && !r.phone) return { ok: false };
      switch (m.type) {
        case 'started':
          if (r) {
            r.lead = num(m.lead, r.lead);
            r.sound = m.sound !== false;
            if (!r.ext && m.mime) { r.mime = String(m.mime).slice(0, 100); r.ext = /mp4/i.test(r.mime) ? 'mp4' : 'webm'; }
            const first = !r.startedSeen;
            r.startedSeen = true;
            d.saveRecs();
            d.toWin({ kind: 'started', id, sound: r.sound, lead: r.lead, first });
          }
          return { ok: true };
        case 'error':
          if (r) {
            d.toWin({ kind: 'error', id, error: String(m.error || '').slice(0, 60) });
            if (!r.bytes && r.receiving) { Object.assign(r, { receiving: false, status: 'deleted', deletedAt: Date.now() }); d.saveRecs(); }
          }
          return { ok: true };
        case 'resume': {
          if (!r) r = adopt(id, m);
          if (!r.receiving) return { next: Math.max(r.nextSeq, num(m.seq, 0) | 0), end: true };
          const first = Math.max(0, num(m.first, 0) | 0);
          if (first > r.nextSeq) { r.nextSeq = first; r.gap = true; d.saveRecs(); checkComplete(r); }
          return { next: r.nextSeq, ...(r.stopRequested && r.receiving ? { stop: true } : {}) };
        }
        case 'skip':
          if (!r) return { resume: true };
          if (r.receiving && num(m.to, 0) > r.nextSeq) { r.nextSeq = num(m.to, 0) | 0; r.gap = true; d.saveRecs(); checkComplete(r); }
          return { next: r.nextSeq };
        case 'end':
          if (!r) return { resume: true };
          if (r.receiving) {
            r.last = Math.floor(num(m.last, -1));
            r.total = Math.max(r.total || 0, num(m.total, 0));
            if (m.lead !== undefined) r.lead = num(m.lead, r.lead);
            r.reason = String(m.reason || 'stopped').slice(0, 30);
            d.saveRecs();
            d.toWin({ kind: 'ended', id, reason: r.reason });
            progress(r, true);
            checkComplete(r);
          }
          return { next: r.nextSeq, end: true };
        default:
          return { ok: true };
      }
    },
  };
}

module.exports = { create, setMp4Rotation };
