'use strict';
// Enkripsi file laporan tutup shift (PDF / CSV) dengan AES-256-GCM.
// File di disk teracak; hanya Admin yang bisa membukanya lewat Pengaturan → Lihat Laporan.
// Tanpa Electron agar bisa diuji dengan Node biasa.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('POSTZ-LAP1');
const IV_LEN = 12;
const TAG_LEN = 16;
const EXT = '.enc';
const PLAIN_RE = /\.(pdf|csv)$/i;

function encrypt(key, data) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

const isEncrypted = (buf) => Buffer.isBuffer(buf) && buf.length >= MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);

function decrypt(key, buf) {
  if (!isEncrypted(buf)) throw new Error('Bukan file laporan terenkripsi POS Tri-Zone.');
  let at = MAGIC.length;
  const iv = buf.subarray(at, (at += IV_LEN));
  const tag = buf.subarray(at, (at += TAG_LEN));
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.subarray(at)), d.final()]);
  } catch (_) {
    throw new Error('File laporan rusak atau kunci laporan di komputer ini berbeda (mis. Windows diinstal ulang).');
  }
}

// Kunci 32 byte di file terpisah (bukan di pos.db, supaya Pulihkan dari Cadangan tidak menggantinya).
// Isinya dienkripsi akun Windows lewat `secrets` (DPAPI). Kunci yang tidak bisa dibuka tidak ditimpa: di-rename.
function loadOrCreateKey(file, { encrypt: seal = (s) => s, decrypt: unseal = (s) => s } = {}) {
  if (fs.existsSync(file)) {
    const hex = unseal(fs.readFileSync(file, 'utf8').trim());
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    fs.renameSync(file, `${file}.lama-${Date.now()}`);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, seal(key.toString('hex')));
  return key;
}

const shiftDirs = (root) => (fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [])
  .filter((d) => d.isDirectory() && /^Shift_/.test(d.name))
  .map((d) => d.name);

// Migrasi sekali: file laporan biasa dari versi lama dienkripsi; file asli baru dihapus setelah hasilnya terbukti bisa dibuka.
function encryptExisting(root, key) {
  let n = 0;
  for (const dir of shiftDirs(root)) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!PLAIN_RE.test(name)) continue;
      const src = path.join(root, dir, name);
      const plain = fs.readFileSync(src);
      const enc = encrypt(key, plain);
      if (!decrypt(key, enc).equals(plain)) throw new Error(`Gagal mengenkripsi ${name}`);
      fs.writeFileSync(src + EXT, enc);
      fs.unlinkSync(src);
      n++;
    }
  }
  return n;
}

// Daftar laporan per shift, terbaru dulu: [{ folder, files: [nama .enc] }]
function listReports(root) {
  return shiftDirs(root).sort().reverse().map((folder) => ({
    folder,
    files: fs.readdirSync(path.join(root, folder)).filter((f) => f.endsWith(EXT)).sort(),
  })).filter((r) => r.files.length);
}

module.exports = { encrypt, decrypt, isEncrypted, loadOrCreateKey, encryptExisting, listReports, EXT };
