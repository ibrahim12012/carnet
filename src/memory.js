'use strict';
// Search memory: a vector for each subject, video card and step forward of the journal, so that an analysis can pick
// the older ones close in meaning when the whole journal no longer fits in one request (journal.searchPlan).
// The vectors are only an index: journal.json keeps all the text. They are kept in search-memory.json, next to it;
// a missing or damaged file, or one made with another model, is simply made again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'search-memory.json';
const hash = (txt) => crypto.createHash('sha256').update(txt).digest('hex').slice(0, 16);
const empty = (model) => ({ version: 1, model: model || null, items: {}, updated: 0 });

// Vectors are stored as base64 of their float32 values.
const pack = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
function unpack(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const ab = new ArrayBuffer(buf.length - (buf.length % 4));
  new Uint8Array(ab).set(buf.subarray(0, ab.byteLength));
  return new Float32Array(ab);
}

function load(dir, model) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    if (d && d.items && typeof d.items === 'object' && (!model || d.model === model)) return { ...empty(model), ...d, cache: new Map() };
  } catch (_) {}
  return { ...empty(model), cache: new Map() };
}
function save(dir, idx) {
  const file = path.join(dir, FILE), tmp = file + '.tmp';
  const { cache, ...out } = idx;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, file);
}

// What to do to match the journal: texts to turn into vectors (new or changed) and keys to drop.
// texts: Map key -> text (journal.memoryTexts).
function diff(idx, texts) {
  const todo = [];
  for (const [key, text] of texts) {
    const h = hash(text);
    if (!idx.items[key] || idx.items[key].h !== h) todo.push({ key, text, h });
  }
  const gone = Object.keys(idx.items).filter((k) => !texts.has(k));
  return { todo, gone };
}
function put(idx, key, h, vector) {
  idx.items[key] = { h, v: pack(vector) };
  idx.cache.delete(key);
}
function drop(idx, keys) {
  for (const k of keys) { delete idx.items[k]; idx.cache.delete(k); }
}
const vectorOf = (idx, key) => {
  if (!idx.cache.has(key)) idx.cache.set(key, unpack(idx.items[key].v));
  return idx.cache.get(key);
};
// Share of the journal that has an up-to-date vector (0 to 1).
function coverage(idx, texts) {
  if (!texts.size) return 1;
  let ok = 0;
  for (const [key, text] of texts) if (idx.items[key] && idx.items[key].h === hash(text)) ok++;
  return ok / texts.size;
}
// Similarity of each item with what is searched (several passages: the best one counts). Vectors are unit length,
// so the dot product is the cosine.
function scores(idx, queries) {
  const out = new Map();
  for (const key of Object.keys(idx.items)) {
    const v = vectorOf(idx, key);
    let best = -1;
    for (const q of queries) {
      if (q.length !== v.length) continue;
      let d = 0;
      for (let i = 0; i < v.length; i++) d += v[i] * q[i];
      if (d > best) best = d;
    }
    if (best > -1) out.set(key, best);
  }
  return out;
}

module.exports = { FILE, hash, pack, unpack, load, save, diff, put, drop, coverage, scores };
