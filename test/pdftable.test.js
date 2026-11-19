'use strict';
// Uji baca stok opname dari PDF hasil "Save as PDF" Microsoft Excel: node test/pdftable.test.js
// test/fixtures/opname-excel.pdf        = susunan bawaan Excel (kolom terbagi ke 3 pita × 2 halaman, Kode hanya di pita pertama)
// test/fixtures/opname-excel-1lebar.pdf = Page Layout "Fit All Columns on One Page" (lanskap)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readPdfTable } = require('../src/pdftable');
const { Database } = require('../src/db');
const { createServices, OPNAME_TEMPLATE_HEADERS } = require('../src/services');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const opt = { headers: OPNAME_TEMPLATE_HEADERS, keyHeader: 'Kode' };

(async () => {
  let rows;
  await t('PDF bawaan Excel: kolom yang terpisah halaman tersambung ke kodenya', async () => {
    rows = await readPdfTable(fixture('opname-excel.pdf'), opt);
    assert.strictEqual(rows.length, 74);
    assert.deepStrictEqual(Object.keys(rows[0]), OPNAME_TEMPLATE_HEADERS);
    assert.deepStrictEqual(rows[0], {
      Kode: '8991234567890', Nama_Barang: 'Air Mineral 600ml', 'Display Toko': '30', 'Fisik Display Toko': '28', 'Gudang Utama': '96',
      'Fisik Gudang Utama': '100', 'Gudang BS': '2', 'Fisik Gudang BS': '', 'Gudang Shopee': '0', 'Fisik Gudang Shopee': '', Tanggal_Stok: '2026-11-19 10:30',
    });
    assert.deepStrictEqual([rows[1].Kode, rows[1]['Fisik Gudang Utama'], rows[1]['Fisik Gudang BS']], ['SNK-010', '75', '1']);
    assert.strictEqual(rows[2].Nama_Barang, 'Beras Premium 5kg Pandan Wangi Kemasan Ekonomis Super Panjang Sekali');
    assert.deepStrictEqual([rows[3].Kode, rows[3]['Gudang Shopee'], rows[3]['Fisik Gudang Shopee']], ['ATK-002', '12', '10']);
    // Baris di halaman ke-2 tiap pita (TST-035 dst.) juga tersambung benar
    for (let i = 1; i <= 70; i++) {
      const r = rows[3 + i];
      assert.strictEqual(r.Kode, `TST-${String(i).padStart(3, '0')}`);
      assert.strictEqual(r['Display Toko'], String(i));
      assert.strictEqual(r['Fisik Display Toko'], i % 3 ? String(i + 1) : '');
      assert.strictEqual(r['Gudang Utama'], String(10 * i));
      assert.strictEqual(r.Tanggal_Stok, '2026-11-19 10:30');
    }
  });

  await t('PDF "1 halaman lebar" memberi hasil yang sama', async () => {
    assert.deepStrictEqual(await readPdfTable(fixture('opname-excel-1lebar.pdf'), opt), rows);
  });

  await t('PDF yang bukan template opname ditolak dengan pesan jelas', async () => {
    await assert.rejects(readPdfTable(fixture('opname-excel.pdf'), { headers: ['No_Surat_Jalan', 'Jumlah'], keyHeader: 'No_Surat_Jalan' }), /Judul kolom template/);
    await assert.rejects(readPdfTable(Buffer.from('bukan pdf'), opt), /PDF/);
  });

  await t('hasil PDF langsung dipakai import opname (ringkasan selisih per zona)', async () => {
    const db = await Database.open(null);
    const svc = createServices(db);
    svc.importRows([
      { Barcode: '8991234567890', SKU: 'MNM-001', Nama_Barang: 'Air Mineral 600ml', Harga_Jual: 3500, Stok_Awal_Toko: 30, Stok_Awal_Gudang: 96, Stok_Awal_BS: 2 },
      { Barcode: '8997654321098', SKU: 'SNK-010', Nama_Barang: 'Keripik Kentang 68g', Harga_Jual: 11500, Stok_Awal_Toko: 4, Stok_Awal_Gudang: 80 },
    ]);
    const plan = svc.importOpname({ rows: rows.slice(0, 2), dry_run: true });
    const z = Object.fromEntries(plan.zones.map((x) => [x.zone, [x.line_count, x.plus_qty, x.minus_qty]]));
    // Patokan = stok di PDF (Tanggal_Stok): Display 30→28, Gudang Utama 96→100 & 80→75, Gudang BS 0→1
    assert.deepStrictEqual(z, { floor: [1, 0, 2], warehouse: [2, 4, 5], damaged: [1, 1, 0] });
    assert.deepStrictEqual(plan.errors, []);
    const done = svc.importOpname({ rows: rows.slice(0, 2), notes: 'Opname dari PDF' });
    assert.strictEqual(done.created.length, 3);
    const mnm = svc.getProduct('MNM-001');
    const snk = svc.getProduct('SNK-010');
    assert.deepStrictEqual([mnm.floor_stock, mnm.warehouse_stock, mnm.damaged_stock], [28, 100, 2]);
    assert.deepStrictEqual([snk.floor_stock, snk.warehouse_stock, snk.damaged_stock], [4, 75, 1]);
  });

  console.log(`\n${passed} tes PDF opname lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
