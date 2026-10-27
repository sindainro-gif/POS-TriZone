'use strict';
// Uji draft penjualan (tahan keranjang): node test/drafts.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDraftStore, MAX_DRAFTS } = require('../src/drafts');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-drafts-'));
let clock = '2026-10-27 10:00:00';
const store = createDraftStore(dir, { now: () => clock });
const items = [{ sku: 'A-1', name: 'Barang A', qty: 2, unit_price: 5000 }, { sku: 'B-2', name: 'Barang B', qty: 1, unit_price: 3000 }];

let a;
t('simpan draft: total, jumlah, label, kasir', () => {
  a = store.save({ label: '  Bu Ani  ', cashier: 'Rina', items });
  assert.strictEqual(a.label, 'Bu Ani');
  assert.strictEqual(a.cashier, 'Rina');
  assert.strictEqual(a.total, 13000);
  assert.strictEqual(a.qty, 3);
  assert.strictEqual(a.created_at, '2026-10-27 10:00:00');
  assert.ok(a.id);
});

t('label kosong → nama otomatis; daftar terbaru di atas', () => {
  clock = '2026-10-27 10:05:00';
  const b = store.save({ items: [{ sku: 'A-1', name: 'Barang A', qty: 1, unit_price: 5000 }] });
  assert.strictEqual(b.label, 'Draft #2');
  assert.deepStrictEqual(store.list().map((d) => d.label), ['Draft #2', 'Bu Ani']);
  assert.strictEqual(store.count(), 2);
});

t('validasi: keranjang kosong & jumlah tidak valid ditolak', () => {
  assert.throws(() => store.save({ items: [] }), /kosong/);
  assert.throws(() => store.save({ items: [{ sku: 'A-1', qty: 0 }] }), /tidak valid/);
  assert.throws(() => store.save({ items: [{ sku: 'A-1', qty: 1.5 }] }), /tidak valid/);
  assert.strictEqual(store.count(), 2);
});

t('draft bertahan setelah aplikasi dibuka ulang', () => {
  const again = createDraftStore(dir);
  assert.deepStrictEqual(again.list().map((d) => d.id), store.list().map((d) => d.id));
});

t('lanjutkan (take) mengeluarkan draft dari daftar; tidak bisa diambil dua kali', () => {
  const taken = store.take(a.id);
  assert.deepStrictEqual(taken.items, items);
  assert.ok(!store.list().some((d) => d.id === a.id));
  assert.throws(() => store.take(a.id), /tidak ditemukan/);
  assert.strictEqual(createDraftStore(dir).count(), 1);
});

t('hapus draft', () => {
  store.remove(store.list()[0].id);
  assert.strictEqual(store.count(), 0);
});

t(`batas ${MAX_DRAFTS} draft`, () => {
  for (let i = 0; i < MAX_DRAFTS; i++) store.save({ items: [{ sku: 'A-1', qty: 1 }] });
  assert.throws(() => store.save({ items: [{ sku: 'A-1', qty: 1 }] }), /Maksimal/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} tes draft lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
