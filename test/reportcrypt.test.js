'use strict';
// Uji enkripsi file laporan tutup shift: node test/reportcrypt.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const rc = require('../src/reportcrypt');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { process.exitCode = 1; console.error(`  ✗ ${name}\n    ${e.stack}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-rc-'));
const key = crypto.randomBytes(32);
// Tiruan DPAPI: isi file kunci dibungkus sehingga bukan kunci polos
const secrets = { encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString() : '') };

t('enkripsi → dekripsi kembali sama; isi tidak terbaca', () => {
  const pdf = Buffer.from('%PDF-1.4 laporan omset Rp 910.000');
  const enc = rc.encrypt(key, pdf);
  assert.ok(rc.isEncrypted(enc));
  assert.ok(!enc.includes('%PDF') && !enc.includes('910.000'));
  assert.ok(rc.decrypt(key, enc).equals(pdf));
  assert.strictEqual(rc.decrypt(key, rc.encrypt(key, 'SKU;Nama\nA;Air')).toString(), 'SKU;Nama\nA;Air');
  assert.ok(!rc.encrypt(key, pdf).equals(enc), 'iv acak: hasil enkripsi selalu berbeda');
});

t('file diubah / kunci salah / bukan file terenkripsi ditolak', () => {
  const enc = rc.encrypt(key, Buffer.from('rahasia'));
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => rc.decrypt(key, tampered), /rusak/);
  assert.throws(() => rc.decrypt(crypto.randomBytes(32), enc), /rusak|berbeda/);
  assert.throws(() => rc.decrypt(key, Buffer.from('%PDF-1.4 biasa')), /Bukan file laporan/);
  assert.ok(!rc.isEncrypted(Buffer.from('%PDF-1.4 biasa')));
});

t('kunci dibuat sekali, dipakai ulang, dan tidak tersimpan polos', () => {
  const file = path.join(dir, 'laporan.key');
  const k1 = rc.loadOrCreateKey(file, secrets);
  const k2 = rc.loadOrCreateKey(file, secrets);
  assert.strictEqual(k1.length, 32);
  assert.ok(k1.equals(k2));
  assert.ok(!fs.readFileSync(file, 'utf8').includes(k1.toString('hex')));
});

t('file kunci yang tidak bisa dibuka (PC / akun lain) tidak ditimpa: di-rename, kunci baru dibuat', () => {
  const file = path.join(dir, 'rusak.key');
  fs.writeFileSync(file, 'enc:bukan-kunci-akun-ini');
  const k = rc.loadOrCreateKey(file, secrets);
  assert.strictEqual(k.length, 32);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('rusak.key.lama-'));
  assert.strictEqual(old.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, old[0]), 'utf8'), 'enc:bukan-kunci-akun-ini');
});

t('laporan lama (polos) dienkripsi, file asli dihapus, aman dijalankan ulang', () => {
  const root = path.join(dir, 'Laporan');
  const s1 = path.join(root, 'Shift_20261101_210000');
  const s2 = path.join(root, 'Shift_20261117_102544');
  fs.mkdirSync(s1, { recursive: true });
  fs.mkdirSync(s2, { recursive: true });
  fs.mkdirSync(path.join(root, 'bukan-shift'), { recursive: true });
  fs.writeFileSync(path.join(s1, 'Rekap_Shift_20261101_210000.pdf'), '%PDF lama');
  fs.writeFileSync(path.join(s1, 'Penjualan_Shift_20261101_210000.csv'), 'a;b');
  fs.writeFileSync(path.join(s2, 'Rekap_Shift_20261117_102544.pdf.enc'), rc.encrypt(key, '%PDF baru'));
  fs.writeFileSync(path.join(root, 'bukan-shift', 'x.pdf'), 'biarkan');
  assert.strictEqual(rc.encryptExisting(root, key), 2);
  assert.deepStrictEqual(fs.readdirSync(s1).sort(), ['Penjualan_Shift_20261101_210000.csv.enc', 'Rekap_Shift_20261101_210000.pdf.enc']);
  assert.strictEqual(rc.decrypt(key, fs.readFileSync(path.join(s1, 'Rekap_Shift_20261101_210000.pdf.enc'))).toString(), '%PDF lama');
  assert.strictEqual(fs.readFileSync(path.join(root, 'bukan-shift', 'x.pdf'), 'utf8'), 'biarkan');
  assert.strictEqual(rc.encryptExisting(root, key), 0);
  assert.strictEqual(rc.encryptExisting(path.join(dir, 'tidak-ada'), key), 0);
});

t('daftar laporan: per shift, terbaru dulu, hanya file terenkripsi', () => {
  const list = rc.listReports(path.join(dir, 'Laporan'));
  assert.deepStrictEqual(list.map((r) => r.folder), ['Shift_20261117_102544', 'Shift_20261101_210000']);
  assert.deepStrictEqual(list[1].files, ['Penjualan_Shift_20261101_210000.csv.enc', 'Rekap_Shift_20261101_210000.pdf.enc']);
  assert.deepStrictEqual(rc.listReports(path.join(dir, 'tidak-ada')), []);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} tes enkripsi laporan lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
