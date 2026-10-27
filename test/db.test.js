'use strict';
// Uji cadangkan / pulihkan database: node test/db.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-dbtest-'));

  // Database "lama" dengan 1 barang, tanpa tabel label_designs (meniru versi sebelumnya)
  const old = await Database.open(null);
  createServices(old).importRows([{ Barcode: '111', SKU: 'BK30', Nama_Barang: 'BK 30', Harga_Jual: 5000, Stok_Awal_Toko: 7 }]);
  old.db.exec('DROP TABLE label_designs');
  const backupBuf = old.exportBuffer();

  await t('validateFile menerima cadangan POS & menghitung isinya', async () => {
    const info = await Database.validateFile(backupBuf);
    assert.strictEqual(info.products, 1);
  });

  await t('validateFile menolak file bukan database / database lain', async () => {
    await assert.rejects(Database.validateFile(Buffer.from('bukan database')), /bukan database POS/);
    const other = await Database.open(null);
    other.db.exec('DROP TABLE inventory');
    await assert.rejects(Database.validateFile(other.exportBuffer()), /bukan database POS/);
  });

  await t('replaceWith: cadangan otomatis, data baru tersimpan, tabel baru ditambahkan', async () => {
    const file = path.join(dir, 'pos.db');
    const cur = await Database.open(file);
    createServices(cur).importRows([{ Barcode: '222', SKU: 'LAMA', Nama_Barang: 'Data lama', Harga_Jual: 1 }]);
    const res = await cur.replaceWith(backupBuf, path.join(dir, 'backup'));
    assert.ok(fs.existsSync(res.backupFile), 'cadangan sebelum pulih harus ada');
    const before = await Database.open(res.backupFile);
    assert.ok(createServices(before).getProduct('LAMA'));

    const reopened = createServices(await Database.open(file));
    assert.strictEqual(reopened.getProduct('BK30').floor_stock, 7);
    assert.strictEqual(reopened.getProduct('LAMA'), null);
    assert.strictEqual(reopened.listLabelDesigns().length, 1); // tabel label_designs dibuat ulang
  });

  await t('database versi lama mendapat kolom baru (sold_out_at) saat dibuka & dipulihkan', async () => {
    // Tabel inventory versi lama tanpa kolom sold_out_at
    const legacy = await Database.open(null);
    legacy.db.exec(`CREATE TABLE inv_old AS SELECT sku, floor_stock, warehouse_stock, damaged_stock, min_floor_alert FROM inventory;
      DROP TABLE inventory; ALTER TABLE inv_old RENAME TO inventory;`);
    const file = path.join(dir, 'lama.db');
    fs.writeFileSync(file, legacy.exportBuffer());
    const cols = (d) => d.all('PRAGMA table_info(inventory)').map((c) => c.name);
    assert.ok(!cols(legacy).includes('sold_out_at'));
    const opened = await Database.open(file);
    assert.ok(cols(opened).includes('sold_out_at'));
    createServices(opened).importRows([{ Barcode: '444', SKU: 'MIG', Nama_Barang: 'Migrasi', Harga_Jual: 1 }]);
    assert.strictEqual(createServices(opened).lowStock({}).find((p) => p.sku === 'MIG').sold_out, false);
    const target = await Database.open(path.join(dir, 'pos3.db'));
    await target.replaceWith(legacy.exportBuffer(), null);
    assert.ok(cols(target).includes('sold_out_at'));
  });

  await t('replaceWith menolak file rusak tanpa mengubah data', async () => {
    const file = path.join(dir, 'pos2.db');
    const cur = await Database.open(file);
    createServices(cur).importRows([{ Barcode: '333', SKU: 'TETAP', Nama_Barang: 'Tetap', Harga_Jual: 1 }]);
    await assert.rejects(cur.replaceWith(Buffer.from('rusak'), path.join(dir, 'backup')), /bukan database POS/);
    assert.ok(createServices(await Database.open(file)).getProduct('TETAP'));
  });

  console.log(`\n${passed} tes database lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
  fs.rmSync(dir, { recursive: true, force: true });
})();
