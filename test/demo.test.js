'use strict';
// Uji data contoh versi DEMO: node test/demo.test.js
const assert = require('assert');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { seedDemo, DEMO_ACCOUNTS, ean13 } = require('../src/demo');
const { buildReceiptLines } = require('../src/receipt');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

(async () => {
  const svc = createServices(await Database.open(null));
  const res = seedDemo(svc);
  const products = svc.listProducts({});

  await t('digit cek EAN-13 benar', () => {
    assert.strictEqual(ean13('400638133393'), '4006381333931');
    assert.strictEqual(ean13('899123456789'), '8991234567891');
  });

  await t('barang contoh: 30 barang, barcode EAN-13 unik & valid', () => {
    assert.strictEqual(res.products, 30);
    assert.strictEqual(products.length, 30);
    assert.strictEqual(new Set(products.map((p) => p.barcode)).size, 30);
    for (const p of products) assert.strictEqual(ean13(p.barcode.slice(0, 12)), p.barcode, p.sku);
  });

  await t('stok contoh mencakup kasus latihan: menipis, habis, ada BS', () => {
    assert.ok(svc.lowStock({}).length >= 5);
    assert.ok(products.some((p) => p.floor_stock === 0));
    assert.ok(products.some((p) => p.damaged_stock > 0));
  });

  await t('akun latihan Admin / Gudang / Kasir bisa login dengan PIN yang ditampilkan', () => {
    assert.strictEqual(svc.needsSetup(), false);
    for (const a of DEMO_ACCOUNTS) assert.strictEqual(svc.verifyLogin({ name: a.name, pin: a.pin }).role, a.role);
  });

  await t('riwayat contoh: penerimaan, mutasi, desain label', () => {
    assert.strictEqual(svc.listReceptions({}).length, 2);
    assert.strictEqual(svc.listTransfers({}).length, 3);
    assert.ok(svc.listLabelDesigns().length >= 1);
    assert.strictEqual(svc.getShift(), null); // shift dibuka sendiri saat latihan
  });

  await t('nota demo diberi tanda DEMO, nota asli tidak', () => {
    const r = { receipt_no: 'INV-1', created_at: '2026-10-27 10:00:00', cashier: 'Kasir', payment_method: 'QRIS', lines: [{ name: 'X', qty: 1, unit_price: 1000, line_total: 1000 }], total: 1000 };
    assert.ok(buildReceiptLines(r, { demo: true }).some((l) => l.includes('DEMO - BUKAN NOTA ASLI')));
    assert.ok(!buildReceiptLines(r, {}).some((l) => l.includes('DEMO')));
  });

  console.log(`\n${passed} tes demo lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
