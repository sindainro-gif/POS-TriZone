'use strict';
// Uji pencarian barang "mirip" (kata acak, salah ketik): node test/search.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { createOfflineStore } = require('../src/offline');
const { rankProducts, editDistance } = require('../src/search');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

const ROWS = [
  { Barcode: '4006381333931', SKU: 'BRS-001', Nama_Barang: 'Penebah Lidi @50 PCS Sima', Merk: 'Sima', Kategori: 'Alat Rumah', Harga_Jual: 6000 },
  { Barcode: '8991234567890', SKU: 'MNM-001', Nama_Barang: 'Air Mineral 600ml', Merk: 'Segar', Kategori: 'Minuman', Harga_Jual: 3500 },
  { Barcode: '8991234567891', SKU: 'MNM-002', Nama_Barang: 'Air Mineral 1500ml', Merk: 'Segar', Kategori: 'Minuman', Harga_Jual: 6500 },
  { Barcode: '8997654321098', SKU: 'SNK-010', Nama_Barang: 'Keripik Kentang 68g', Merk: 'Renyah', Kategori: 'Makanan Ringan', Harga_Jual: 11500 },
  { Barcode: '8990001112223', SKU: 'SBN-005', Nama_Barang: 'Sabun Mandi 85g', Merk: 'Wangi', Kategori: 'Perawatan', Harga_Jual: 4200 },
  { Barcode: '1234', SKU: 'TEH-1', Nama_Barang: 'Teh Kotak', Merk: 'Ultra', Kategori: 'Minuman', Harga_Jual: 4000 },
];

(async () => {
  const svc = createServices(await Database.open(null));
  svc.importRows(ROWS);
  const all = svc.listProducts({});
  const skus = (list) => list.map((p) => p.sku);
  const search = (q, limit) => skus(svc.searchProducts({ q, limit }));

  await t('jarak salah ketik: ganti, hilang, lebih, tertukar', () => {
    assert.strictEqual(editDistance('mineral', 'mineral'), 0);
    assert.strictEqual(editDistance('minral', 'mineral'), 1);
    assert.strictEqual(editDistance('sabnu', 'sabun'), 1);
    assert.strictEqual(editDistance('kentangg', 'kentang'), 1);
  });

  await t('kata acak urutannya tetap ketemu', () => {
    assert.deepStrictEqual(search('lidi sima'), ['BRS-001']);
    assert.deepStrictEqual(search('mandi sabun'), ['SBN-005']);
    assert.deepStrictEqual(search('kentang keripik'), ['SNK-010']);
  });

  await t('salah ketik kecil tetap ketemu', () => {
    assert.deepStrictEqual(search('penebh'), ['BRS-001']);
    assert.deepStrictEqual(search('minral 600'), ['MNM-001']);
    assert.deepStrictEqual(search('kripik'), ['SNK-010']);
    assert.deepStrictEqual(search('sabnu'), ['SBN-005']);
  });

  await t('tidak terlalu longgar: kata pendek & angka harus tepat', () => {
    assert.deepStrictEqual(search('xyz'), []);
    assert.deepStrictEqual(search('teb'), []); // 3 huruf: tanpa toleransi salah ketik
    assert.deepStrictEqual(search('8992'), []); // barcode tidak di-fuzzy
    assert.deepStrictEqual(search('lidi zzzz'), []); // setiap kata harus cocok
  });

  await t('kode persis selalu nomor 1, lalu awalan kode, lalu awalan nama', () => {
    assert.strictEqual(search('1234')[0], 'TEH-1'); // barcode persis mengalahkan barcode lain yang memuat 1234
    assert.deepStrictEqual(search('8991234567891').slice(0, 1), ['MNM-002']);
    assert.strictEqual(search('mnm-002')[0], 'MNM-002');
    assert.deepStrictEqual(search('8991234'), ['MNM-002', 'MNM-001']); // seri → nama A–Z
    assert.deepStrictEqual(search('air'), ['MNM-002', 'MNM-001']); // seri → nama A–Z
  });

  await t('merk & kategori ikut dicari, nilainya di bawah nama', () => {
    assert.deepStrictEqual(search('segar'), ['MNM-002', 'MNM-001']);
    assert.deepStrictEqual(search('minuman').sort(), ['MNM-001', 'MNM-002', 'TEH-1']);
  });

  await t('batas jumlah saran', () => {
    assert.strictEqual(search('a', 2).length, 2);
    assert.strictEqual(rankProducts(all, 'a', 999).length <= 50, true);
    assert.deepStrictEqual(search('   '), []);
  });

  await t('mode darurat kasir memberi hasil yang sama dengan PC gudang', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-search-'));
    const store = createOfflineStore(dir);
    await store.refresh({ ...svc, authCache: () => [] });
    for (const q of ['lidi sima', 'penebh', 'minral', 'air', '8991234', 'segar']) {
      assert.deepStrictEqual(skus(store.searchProducts({ q })), search(q), q);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} tes pencarian lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
