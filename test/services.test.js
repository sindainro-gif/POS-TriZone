'use strict';
// Uji logika bisnis tanpa Electron: node test/services.test.js
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
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `harus gagal dengan ${re}`);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  const file = path.join(dir, 'pos.db');
  const db = await Database.open(file);
  const svc = createServices(db);

  await t('import produk dari baris template', () => {
    const r = svc.importRows([
      { Barcode: 8991234567890, SKU: 'MNM-001', Nama_Barang: 'Air Mineral 600ml', Merk: 'Segar', Kategori: 'Minuman', Harga_Jual: 3500, Satuan_Masuk: 'Dus', Rasio_Isi_Dus: 24, Stok_Awal_Toko: 10, Stok_Awal_Gudang: 48, Stok_Awal_BS: 1, Min_Alert_Toko: 12 },
      { Barcode: '8997654321098', SKU: 'SNK-010', Nama_Barang: 'Keripik', Harga_Jual: 'Rp 11.500', Rasio_Isi_Dus: 40 },
      { Barcode: '8991234567890', SKU: 'DUP-1', Nama_Barang: 'Duplikat', Harga_Jual: 1 },
      { Barcode: '123', SKU: 'BAD-1', Nama_Barang: 'Harga salah', Harga_Jual: 'abc' },
      { Barcode: '', SKU: '', Nama_Barang: '', Harga_Jual: '' },
    ]);
    assert.strictEqual(r.inserted, 2);
    assert.strictEqual(r.errors.length, 2, r.errors.join('; '));
    const p = svc.findByCode({ code: '8991234567890' });
    assert.strictEqual(p.sku, 'MNM-001');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.damaged_stock, p.min_floor_alert], [10, 48, 1, 12]);
    assert.strictEqual(svc.getProduct('SNK-010').unit_price, 11500);
  });

  await t('import ulang memperbarui master tanpa mengubah stok', () => {
    const r = svc.importRows([{ Barcode: '8991234567890', SKU: 'MNM-001', Nama_Barang: 'Air Mineral 600 ml', Harga_Jual: 4000, Stok_Awal_Toko: 999 }]);
    assert.strictEqual(r.updated, 1);
    const p = svc.getProduct('MNM-001');
    assert.strictEqual(p.unit_price, 4000);
    assert.strictEqual(p.floor_stock, 10);
  });

  await t('kasir tidak bisa jual tanpa shift', () => {
    throwsMsg(() => svc.checkout({ items: [{ sku: 'MNM-001', qty: 1 }], payment_method: 'Tunai', cash_received: 5000 }), /Shift belum dibuka/);
  });

  await t('buka shift & jual memotong hanya display toko', () => {
    svc.openShift({ cashier_name: 'Rina', initial_cash: '200.000' });
    const r = svc.checkout({ items: [{ sku: 'MNM-001', qty: 3 }, { sku: 'MNM-001', qty: 2 }], payment_method: 'Tunai', cash_received: 50000 });
    assert.strictEqual(r.total, 20000);
    assert.deepStrictEqual(r.short, []); // stok cukup → tidak masuk daftar habis
    assert.strictEqual(r.change, 30000);
    assert.match(r.receipt_no, /^INV-\d{8}-0001$/);
    const p = svc.getProduct('MNM-001');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.damaged_stock], [5, 48, 1]);
  });

  await t('display toko kurang tetap boleh dijual: display toko minus, Gudang & BS tidak tersentuh', () => {
    svc.importRows([{ Barcode: '555', SKU: 'BS-ONLY', Nama_Barang: 'Gelas Kaca', Harga_Jual: 1000, Stok_Awal_Gudang: 6, Stok_Awal_BS: 10 }]);
    const r = svc.checkout({ items: [{ sku: 'BS-ONLY', qty: 1 }], payment_method: 'QRIS' });
    assert.deepStrictEqual(r.short, [{ sku: 'BS-ONLY', name: 'Gelas Kaca', floor_stock: -1 }]);
    const p = svc.getProduct('BS-ONLY');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.damaged_stock], [-1, 6, 10]);
  });

  await t('Saran Restock: merah & paling atas hanya untuk barang habis/minus karena terjual', () => {
    svc.importRows([{ Barcode: '556', SKU: 'ZERO', Nama_Barang: 'Aaa Belum Dipajang', Harga_Jual: 500, Stok_Awal_Gudang: 3 }]);
    const low = svc.lowStock({});
    assert.deepStrictEqual([low[0].sku, low[0].floor_stock, low[0].sold_out], ['BS-ONLY', -1, true]);
    const zero = low.find((p) => p.sku === 'ZERO');
    assert.strictEqual(zero.sold_out, false); // display toko 0 dari import, belum pernah terjual → tidak merah
    assert.strictEqual(low.filter((p) => p.sold_out).length, 1);
    // Isi rak → tanda habis hilang
    svc.createTransfer({ sku: 'BS-ONLY', from_zone: 'warehouse', to_zone: 'floor', qty: 3 });
    assert.ok(!svc.lowStock({}).some((p) => p.sold_out));
    // Habis lagi karena terjual (sampai tepat 0) → merah lagi
    svc.checkout({ items: [{ sku: 'BS-ONLY', qty: 2 }], payment_method: 'QRIS' });
    assert.deepStrictEqual(svc.lowStock({}).filter((p) => p.sold_out).map((p) => [p.sku, p.floor_stock]), [['BS-ONLY', 0]]);
  });

  await t('import format "data item": Kode Item = SKU & barcode, Jenis = kategori, Stok → Gudang Utama (boleh minus)', () => {
    const rows = [
      { 'Kode Item': 'YY0312', 'Nama Item': 'Tempat Nasi Yoyo', Jenis: 'SPECIAL', Rak: '', Stok: '10', __EMPTY: '', Satuan: 'PCS', 'Harga Jual': '7500' },
      { 'Kode Item': 'AL0002', 'Nama Item': 'Celengan L AL', Jenis: 'HOUSEWARE', Rak: '', Stok: '-3', __EMPTY: '', Satuan: 'PCS', 'Harga Jual': '0' },
    ];
    const r = svc.importRows(rows);
    assert.deepStrictEqual([r.format, r.inserted, r.updated, r.errors], ['data item', 2, 0, []]);
    const a = svc.getProduct('YY0312');
    assert.deepStrictEqual([a.barcode, a.name, a.category, a.unit_price, a.floor_stock, a.warehouse_stock], ['YY0312', 'Tempat Nasi Yoyo', 'SPECIAL', 7500, 0, 10]);
    const b = svc.getProduct('AL0002');
    assert.deepStrictEqual([b.unit_price, b.warehouse_stock], [0, -3]);
    assert.strictEqual(svc.findByCode({ code: 'YY0312' }).sku, 'YY0312'); // bisa langsung di-scan
    // Import ulang: nama/harga diperbarui, stok & barcode yang sudah diganti tetap
    svc.saveProduct({ product: { ...a, barcode: '8990000000017' } });
    const r2 = svc.importRows([{ ...rows[0], 'Nama Item': 'Tempat Nasi Yoyo Besar', Stok: '99', 'Harga Jual': '8000' }]);
    assert.deepStrictEqual([r2.inserted, r2.updated], [0, 1]);
    const a2 = svc.getProduct('YY0312');
    assert.deepStrictEqual([a2.name, a2.unit_price, a2.warehouse_stock, a2.barcode], ['Tempat Nasi Yoyo Besar', 8000, 10, '8990000000017']);
    throwsMsg(() => svc.importRows([{ Kode: 'X', Nama: 'Y' }]), /Kode Item, Nama Item, dan Harga Jual/);
  });

  await t('uang tunai kurang ditolak', () => {
    throwsMsg(() => svc.checkout({ items: [{ sku: 'MNM-001', qty: 1 }], payment_method: 'Tunai', cash_received: 100 }), /kurang/);
  });

  await t('mutasi gudang → toko, toko → BS, BS → supplier', () => {
    svc.createTransfer({ sku: 'MNM-001', from_zone: 'warehouse', to_zone: 'floor', qty: 24, reason: 'Restock harian' });
    svc.createTransfer({ sku: 'MNM-001', from_zone: 'floor', to_zone: 'damaged', qty: 2, reason: 'Pecah terinjak' });
    svc.createTransfer({ sku: 'MNM-001', from_zone: 'damaged', to_zone: 'supplier', qty: 3, reason: 'Retur pabrik' });
    svc.createTransfer({ sku: 'MNM-001', from_zone: 'customer', to_zone: 'damaged', qty: 1, reason: 'Retur konsumen' });
    const p = svc.getProduct('MNM-001');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.damaged_stock], [27, 24, 1]);
    assert.strictEqual(svc.listTransfers().length, 5); // + 1 mutasi isi rak di tes Saran Restock
  });

  await t('mutasi melebihi stok asal ditolak & arah tidak valid ditolak', () => {
    throwsMsg(() => svc.createTransfer({ sku: 'MNM-001', from_zone: 'damaged', to_zone: 'supplier', qty: 5 }), /tidak cukup/);
    throwsMsg(() => svc.createTransfer({ sku: 'MNM-001', from_zone: 'damaged', to_zone: 'floor', qty: 1 }), /Arah mutasi tidak valid/);
    assert.strictEqual(svc.getProduct('MNM-001').damaged_stock, 1);
  });

  await t('form mutasi multi-barang: satu nomor, SKU sama digabung', () => {
    svc.importRows([
      { Barcode: '7770000000011', SKU: 'TF-A', Nama_Barang: 'Mutasi Uji A', Harga_Jual: 1000, Stok_Awal_Gudang: 20 },
      { Barcode: '7770000000028', SKU: 'TF-B', Nama_Barang: 'Mutasi Uji B', Harga_Jual: 1000, Stok_Awal_Gudang: 5 },
    ]);
    const d = svc.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', reason: 'Restock pagi', items: [
      { sku: 'TF-A', qty: 3 }, { sku: 'TF-B', qty: 2 }, { sku: 'TF-A', qty: 1 },
    ] });
    assert.match(d.doc_no, /^MT-\d{8}-\d{3}$/);
    assert.deepStrictEqual([d.line_count, d.total_qty, d.items.length], [2, 6, 2]);
    assert.deepStrictEqual(d.items.map((i) => [i.sku, i.qty]), [['TF-A', 4], ['TF-B', 2]]);
    const [a, b] = [svc.getProduct('TF-A'), svc.getProduct('TF-B')];
    assert.deepStrictEqual([a.warehouse_stock, a.floor_stock, b.warehouse_stock, b.floor_stock], [16, 4, 3, 2]);
    const d2 = svc.createTransferDoc({ from_zone: 'floor', to_zone: 'damaged', items: [{ sku: 'TF-A', qty: 1 }] });
    assert.strictEqual(Number(d2.doc_no.slice(-3)), Number(d.doc_no.slice(-3)) + 1);
    assert.strictEqual(svc.listTransferDocs({ q: 'Mutasi Uji B' })[0].id, d.id);
    assert.strictEqual(svc.getTransferDoc({ id: d.id }).reason, 'Restock pagi');
  });

  await t('form mutasi: satu barang kurang stok = seluruh form batal', () => {
    const docs = svc.listTransferDocs().length;
    throwsMsg(() => svc.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', items: [{ sku: 'TF-A', qty: 1 }, { sku: 'TF-B', qty: 999 }] }), /Mutasi Uji B.*tidak cukup/);
    assert.strictEqual(svc.getProduct('TF-A').warehouse_stock, 16);
    assert.strictEqual(svc.listTransferDocs().length, docs);
    throwsMsg(() => svc.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', items: [] }), /minimal satu barang/);
  });

  await t('mutasi lama tanpa dokumen dibuatkan dokumen MT-LAMA saat database dibuka', async () => {
    db.tx(() => db.run("INSERT INTO stock_transfers(sku, from_zone, to_zone, qty, reason) VALUES('TF-A', 'floor', 'damaged', 1, 'versi lama')"));
    const db2 = await Database.open(file);
    const row = db2.get("SELECT d.doc_no, d.total_qty FROM stock_transfers t JOIN stock_transfer_docs d ON d.id = t.doc_id WHERE t.reason = 'versi lama'");
    assert.match(row.doc_no, /^MT-LAMA-\d+$/);
    assert.strictEqual(row.total_qty, 1);
    assert.strictEqual(db2.get('SELECT COUNT(*) AS n FROM stock_transfers WHERE doc_id IS NULL').n, 0);
  });

  await t('penerimaan Dus dikalikan rasio, tujuan per baris', () => {
    const r = svc.createReception({
      reference_no: 'SJ-001', supplier_name: 'PT Segar',
      items: [
        { sku: 'MNM-001', qty: 2, pack_type: 'Dus', destination: 'warehouse' },
        { sku: 'MNM-001', qty: 5, pack_type: 'Biji', destination: 'damaged' },
        { sku: 'SNK-010', qty: 1, pack_type: 'Dus', destination: 'floor' },
      ],
    });
    assert.strictEqual(r.total_items_count, 48 + 5 + 40);
    const p = svc.getProduct('MNM-001');
    assert.deepStrictEqual([p.warehouse_stock, p.damaged_stock], [72, 6]);
    assert.strictEqual(svc.getProduct('SNK-010').floor_stock, 40);
    throwsMsg(() => svc.createReception({ reference_no: 'SJ-001', items: [{ sku: 'MNM-001', qty: 1, destination: 'floor' }] }), /sudah pernah dicatat/);
  });

  await t('import penerimaan Excel: per surat jalan, kode tidak dikenal dilewati', () => {
    svc.importRows([
      { Barcode: '7770000000035', SKU: 'RC-A', Nama_Barang: 'Terima Uji A', Harga_Jual: 1000, Satuan_Masuk: 'Karton', Rasio_Isi_Dus: 12 },
      { Barcode: '7770000000042', SKU: 'RC-B', Nama_Barang: 'Terima Uji B', Harga_Jual: 1000, Rasio_Isi_Dus: 6 },
    ]);
    const rows = [
      { 'No Surat Jalan': 'IMP-1', Supplier: 'PT Uji', Kode: 'RC-A', Jumlah: 2, Satuan: 'Karton', Tujuan: '' },
      { 'No Surat Jalan': 'IMP-1', Supplier: '', Kode: 7770000000042, Jumlah: '5', Satuan: 'pcs', Tujuan: 'display toko' },
      { 'No Surat Jalan': 'IMP-1', Kode: 'TIDAK-ADA', Jumlah: 1 },
      { 'No Surat Jalan': 'IMP-2', Catatan: 'sore', Kode: 'RC-B', Jumlah: 1, Satuan: '', Tujuan: 'BS' },
      { 'No Surat Jalan': 'IMP-2', Kode: 'RC-B', Jumlah: 0 },
      { 'No Surat Jalan': 'SJ-001', Kode: 'RC-B', Jumlah: 1 },
      { 'No Surat Jalan': '', Kode: '', Jumlah: '' },
    ];
    const plan = svc.importReceptions({ rows, dry_run: true });
    assert.deepStrictEqual(plan.docs.map((d) => [d.reference_no, d.supplier_name, d.lines, d.total]), [['IMP-1', 'PT Uji', 2, 29], ['IMP-2', '', 1, 6]]);
    assert.strictEqual(plan.errors.length, 3);
    assert.match(plan.errors.join('\n'), /Baris 4: Kode "TIDAK-ADA" tidak ditemukan/);
    assert.match(plan.errors.join('\n'), /Baris 6: Jumlah/);
    assert.match(plan.errors.join('\n'), /SJ-001.*sudah pernah dicatat/);
    assert.strictEqual(svc.getProduct('RC-A').warehouse_stock, 0); // dry run tidak mengubah stok

    const r = svc.importReceptions({ rows });
    assert.deepStrictEqual(r.created.map((c) => [c.reference_no, c.lines, c.total_items_count]), [['IMP-1', 2, 29], ['IMP-2', 1, 6]]);
    const [a, b] = [svc.getProduct('RC-A'), svc.getProduct('RC-B')];
    assert.deepStrictEqual([a.warehouse_stock, b.floor_stock, b.damaged_stock], [24, 5, 6]);
    assert.strictEqual(svc.getReception({ id: r.created[1].id }).notes, 'sore');
    // Import ulang file yang sama: semua surat jalan sudah tercatat
    assert.deepStrictEqual(svc.importReceptions({ rows }).created, []);
    throwsMsg(() => svc.importReceptions({ rows: [{ Kode: 'RC-A', Jumlah: 1 }] }), /No_Surat_Jalan/);
  });

  await t('ringkasan shift & uang laci seharusnya', () => {
    svc.checkout({ items: [{ sku: 'SNK-010', qty: 2 }], payment_method: 'QRIS' });
    const s = svc.shiftSummary();
    assert.strictEqual(s.totals.receipts, 4);
    assert.strictEqual(s.totals.revenue, 20000 + 1000 + 2000 + 23000);
    assert.strictEqual(s.cashSales, 20000);
    assert.strictEqual(s.expectedCash, undefined); // tidak ada hitung uang laci
    assert.strictEqual(s.shift.initial_cash, 0); // initial_cash yang dikirim diabaikan
  });

  await t('hapus barang ber-riwayat ditolak', () => {
    throwsMsg(() => svc.deleteProduct({ sku: 'MNM-001' }), /tidak bisa dihapus/);
  });

  await t('barcode bentrok saat ubah produk ditolak', () => {
    const p = svc.getProduct('SNK-010');
    throwsMsg(() => svc.saveProduct({ product: { ...p, barcode: '8991234567890' } }), /sudah dipakai/);
  });

  await t('purge shift menghapus penjualan, stok & master tetap', () => {
    svc.purgeShift();
    assert.strictEqual(svc.getShift(), null);
    assert.strictEqual(svc.shiftSalesRows().length, 0);
    assert.strictEqual(svc.getProduct('MNM-001').floor_stock, 27);
  });

  await t('data tersimpan ke file & terbaca ulang', async () => {
    const db2 = await Database.open(file);
    const svc2 = createServices(db2);
    assert.strictEqual(svc2.getProduct('MNM-001').warehouse_stock, 72);
    assert.strictEqual(svc2.listReceptions().length, 3); // SJ-001 + IMP-1 + IMP-2
  });

  await t('pengaturan: password terenkripsi tidak bocor ke renderer', () => {
    const s2 = createServices(db, { encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() });
    const pub = s2.saveSettings({ store_name: 'Toko Maju', owner_email: 'a@b.co, c@d.id', smtp_pass: 'rahasia' });
    assert.strictEqual(pub.smtp_pass, undefined);
    assert.strictEqual(pub.has_smtp_pass, true);
    assert.strictEqual(s2.getSettingsRaw().smtp_pass, 'rahasia');
    throwsMsg(() => s2.saveSettings({ owner_email: 'bukan-email' }), /tidak valid/);
  });

  console.log(`\n${passed} tes lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
  fs.rmSync(dir, { recursive: true, force: true });
})();
