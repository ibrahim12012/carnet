'use strict';
// Écriture d'une archive .zip sans dépendance. Les fichiers sont lus et écrits par morceaux (une vidéo de
// plusieurs Go ne passe jamais en mémoire). Vidéos stockées telles quelles (déjà compressées), textes
// compressés. ZIP64 au-delà de 4 Go (fichier ou archive), lu par Windows 10/11, macOS et 7-Zip.
const fs = require('fs');
const zlib = require('zlib');
const { t } = require('./i18n');

const LIMIT = Number(process.env.CARNET_ZIP64_LIMIT) || 0xffffffff; // abaissé seulement pour les tests

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

class ZipWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'w+');
    this.pos = 0;
    this.entries = [];
  }
  write(buf) { let off = 0; while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off, this.pos + off); this.pos += buf.length; }

  // En-tête local avec les tailles à 0, réécrit une fois le contenu écrit (CRC et tailles connus).
  begin(name, size, mtime) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const zip64 = size >= LIMIT || this.pos >= LIMIT;
    const { time, date } = dosTime(mtime || new Date());
    const e = { name: nameBuf, offset: this.pos, zip64, time, date, crc: 0, csize: 0, size: 0, method: 0 };
    const extra = zip64 ? Buffer.concat([u16(1), u16(16), u64(0), u64(0)]) : Buffer.alloc(0);
    e.headerLen = 30 + nameBuf.length + extra.length;
    this.write(Buffer.concat([u32(0x04034b50), u16(zip64 ? 45 : 20), u16(0x0800), u16(0), u16(time), u16(date), u32(0), u32(0), u32(0), u16(nameBuf.length), u16(extra.length), nameBuf, extra]));
    return e;
  }
  finish(e) {
    // Réécrit l'en-tête local : méthode, CRC, tailles.
    const head = Buffer.alloc(e.headerLen);
    fs.readSync(this.fd, head, 0, e.headerLen, e.offset);
    head.writeUInt16LE(e.method, 8);
    head.writeUInt32LE(e.crc >>> 0, 14);
    if (e.zip64) {
      head.writeUInt32LE(0xffffffff, 18); head.writeUInt32LE(0xffffffff, 22);
      const x = 30 + e.name.length;
      head.writeBigUInt64LE(BigInt(e.size), x + 4); head.writeBigUInt64LE(BigInt(e.csize), x + 12);
    } else {
      if (e.size >= LIMIT || e.csize >= LIMIT) throw new Error(t('File too big for the archive: {name}', { name: e.name }));
      head.writeUInt32LE(e.csize, 18); head.writeUInt32LE(e.size, 22);
    }
    fs.writeSync(this.fd, head, 0, e.headerLen, e.offset);
    this.entries.push(e);
  }
  addBuffer(name, buf, mtime) {
    const e = this.begin(name, buf.length, mtime);
    const z = zlib.deflateRawSync(buf, { level: 6 });
    const data = z.length < buf.length ? z : buf;
    e.method = data === z ? 8 : 0;
    e.crc = zlib.crc32(buf);
    e.size = buf.length; e.csize = data.length;
    this.write(data);
    this.finish(e);
  }
  // Fichier du disque, stocké sans compression, lu par morceaux de 8 Mo. onBytes(n) : avancement.
  // Lecture asynchrone : l'application reste réactive (avancement, bouton Annuler) pendant une grosse vidéo.
  async addFile(name, file, onBytes, isCancelled) {
    const st = fs.statSync(file);
    const e = this.begin(name, st.size, st.mtime);
    const src = await fs.promises.open(file, 'r');
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let crc = 0, total = 0, n;
    try {
      while ((n = (await src.read(chunk, 0, chunk.length, null)).bytesRead) > 0) {
        if (isCancelled && isCancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
        const part = chunk.subarray(0, n);
        crc = zlib.crc32(part, crc);
        this.write(part);
        total += n;
        if (onBytes) onBytes(n);
      }
    } finally { await src.close(); }
    Object.assign(e, { crc, size: total, csize: total, method: 0 });
    this.finish(e);
  }
  close() {
    const cdStart = this.pos;
    for (const e of this.entries) {
      const big = e.zip64 || e.offset >= LIMIT;
      const extra = big ? Buffer.concat([u16(1), u16(24), u64(e.size), u64(e.csize), u64(e.offset)]) : Buffer.alloc(0);
      this.write(Buffer.concat([
        u32(0x02014b50), u16(big ? 45 : 20), u16(big ? 45 : 20), u16(0x0800), u16(e.method), u16(e.time), u16(e.date), u32(e.crc),
        u32(big ? 0xffffffff : e.csize), u32(big ? 0xffffffff : e.size), u16(e.name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0),
        u32(big ? 0xffffffff : e.offset), e.name, extra,
      ]));
    }
    const cdSize = this.pos - cdStart, n = this.entries.length;
    const need64 = n >= 0xffff || cdStart >= LIMIT || cdSize >= LIMIT || this.entries.some((e) => e.zip64 || e.offset >= LIMIT);
    if (need64) {
      const z64 = this.pos;
      this.write(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(n), u64(n), u64(cdSize), u64(cdStart)]));
      this.write(Buffer.concat([u32(0x07064b50), u32(0), u64(z64), u32(1)]));
    }
    this.write(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(need64 ? 0xffff : n), u16(need64 ? 0xffff : n),
      u32(need64 ? 0xffffffff : cdSize), u32(need64 ? 0xffffffff : cdStart), u16(0)]));
    fs.closeSync(this.fd);
  }
  abort() { try { fs.closeSync(this.fd); } catch (_) {} }
}

module.exports = { ZipWriter };
