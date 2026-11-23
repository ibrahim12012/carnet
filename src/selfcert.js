'use strict';
// Certificat HTTPS auto-signé pour la page du téléphone, fabriqué avec le module crypto de Node
// (aucune dépendance). Le téléphone affiche une fois l'avertissement « connexion non privée » :
// c'est inévitable sans certificat public, comme dans OmniCam.
//
// Construction DER d'un certificat X.509 v3 : clé EC P-256, signature ECDSA SHA-256,
// adresses IP et noms dans subjectAltName, usage « serveur TLS ».
const crypto = require('crypto');

// ---------- DER ----------
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);
function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) { b.unshift(0x80 | (x & 0x7f)); x >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function int(buf) {
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
function time(d) {
  // UTCTime jusqu'en 2049, GeneralizedTime ensuite.
  const z = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const rest = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${z(y % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
}
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

// Les iPhone refusent les certificats serveur valables plus de 825 jours : 800 jours, puis on en refait un.
const VALID_DAYS = 800;

function create({ commonName = 'Carnet', ips = [], dns = ['localhost'] } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const now = Date.now();
  const san = seq(
    ...dns.map((d) => ctx(2, Buffer.from(d, 'ascii'), false)),
    ...ips.map((ip) => ctx(7, Buffer.from(ip.split('.').map(Number)), false)),
  );
  const extensions = seq(
    ext('2.5.29.19', true, seq()),                                   // basicConstraints : pas une autorité
    ext('2.5.29.15', true, bits(Buffer.from([0x80]))),               // keyUsage : digitalSignature
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),          // extKeyUsage : serverAuth
    ext('2.5.29.17', false, san),                                    // subjectAltName
  );
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))),                                   // version 3
    int(serial),
    sigAlg,
    name(commonName),
    seq(time(new Date(now - 864e5)), time(new Date(now + VALID_DAYS * 864e5))),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
    ctx(3, extensions),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, sigAlg, bits(signature));
  const pem = (label, b) => `-----BEGIN ${label}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  return {
    cert: pem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    notAfter: now + VALID_DAYS * 864e5,
  };
}

module.exports = { create };
