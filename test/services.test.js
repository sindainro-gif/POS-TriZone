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

  await t('draft barang belum terdaftar: dari import & manual, proses setelah didaftarkan', () => {
    // Import sebelumnya mencatat TIDAK-ADA (IMP-1) sebagai draft; import ulang tidak membuat draft ganda
    let drafts = svc.listReceptionDrafts();
    assert.deepStrictEqual(drafts.map((d) => [d.reference_no, d.supplier_name, d.code, d.qty, d.pack_type, d.source, d.product]), [['IMP-1', 'PT Uji', 'TIDAK-ADA', 1, 'Dus', 'import', null]]);
    assert.strictEqual(svc.importReceptions({ rows: [{ No_Surat_Jalan: 'IMP-1', Kode: 'TIDAK-ADA', Jumlah: 1 }], dry_run: true }).drafts, 0);

    const m = svc.createReceptionDraft({ reference_no: 'SJ-BARU', supplier_name: 'CV Baru', code: 'BARU-1', name: 'Sabun Baru', qty: 4, pack_type: 'Biji', destination: 'floor' });
    assert.strictEqual(m.source, 'manual');
    throwsMsg(() => svc.createReceptionDraft({ reference_no: 'SJ-X', code: 'RC-A', qty: 1, destination: 'warehouse' }), /sudah terdaftar/);
    assert.strictEqual(svc.countReceptionDrafts(), 2);
    throwsMsg(() => svc.processReceptionDraft({ id: m.id }), /belum terdaftar/);

    // Barang didaftarkan → status berubah, Proses menambah stok
    svc.importRows([
      { Barcode: '7770000000066', SKU: 'BARU-1', Nama_Barang: 'Sabun Baru', Harga_Jual: 3000, Rasio_Isi_Dus: 24 },
      { Barcode: '7770000000073', SKU: 'TIDAK-ADA', Nama_Barang: 'Sudah Ada Sekarang', Harga_Jual: 3000, Rasio_Isi_Dus: 10 },
    ]);
    drafts = svc.listReceptionDrafts();
    assert.ok(drafts.every((d) => d.product));
    const r1 = svc.processReceptionDraft({ id: m.id });
    assert.deepStrictEqual([r1.reference_no, r1.total_items_count], ['SJ-BARU', 4]);
    assert.strictEqual(svc.getProduct('BARU-1').floor_stock, 4);
    const old = drafts.find((d) => d.code === 'TIDAK-ADA');
    const r2 = svc.processReceptionDraft({ id: old.id }); // IMP-1 sudah ada → No SJ diberi akhiran -S<id>
    assert.strictEqual(r2.reference_no, `IMP-1-S${old.id}`);
    assert.strictEqual(svc.getProduct('TIDAK-ADA').warehouse_stock, 10);
    assert.strictEqual(svc.countReceptionDrafts(), 0);
    throwsMsg(() => svc.processReceptionDraft({ id: m.id }), /sudah diproses/);

    const d3 = svc.createReceptionDraft({ reference_no: 'SJ-HAPUS', code: 'HAPUS-1', qty: 1, destination: 'warehouse' });
    svc.deleteReceptionDraft({ id: d3.id });
    assert.strictEqual(svc.countReceptionDrafts(), 0);
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
    assert.strictEqual(svc2.listReceptions().length, 5); // SJ-001 + IMP-1 + IMP-2 + 2 dari draft
    assert.strictEqual(svc2.countReceptionDrafts(), 0);
  });

  await t('stok opname: set stok ke hitungan fisik, catat selisih, zona & barang lain tidak berubah', () => {
    svc.importRows([
      { Barcode: '7001', SKU: 'OP-A', Nama_Barang: 'Opname A', Harga_Jual: 1000, Stok_Awal_Toko: 10, Stok_Awal_Gudang: 20 },
      { Barcode: '7002', SKU: 'OP-B', Nama_Barang: 'Opname B', Harga_Jual: 1000, Stok_Awal_Toko: 5 },
      { Barcode: '7003', SKU: 'OP-C', Nama_Barang: 'Opname C', Harga_Jual: 1000, Stok_Awal_Toko: 7 },
    ]);
    // Display toko minus karena terjual → ditandai habis
    db.run("UPDATE inventory SET floor_stock = -2, sold_out_at = '2026-01-01 10:00:00' WHERE sku = 'OP-B'");
    const d = svc.createOpname({ zone: 'floor', notes: 'Rak 1', items: [{ sku: 'OP-A', counted: 4 }, { sku: 'OP-A', counted: 4 }, { sku: 'OP-B', counted: 3 }] });
    assert.match(d.doc_no, /^OP-\d{8}-001$/);
    assert.deepStrictEqual([d.zone, d.line_count, d.plus_qty, d.minus_qty], ['floor', 2, 5, 2]);
    assert.deepStrictEqual(d.items.map((i) => [i.sku, i.system_qty, i.counted_qty, i.diff]), [['OP-A', 10, 8, -2], ['OP-B', -2, 3, 5]]);
    const a = svc.getProduct('OP-A');
    assert.deepStrictEqual([a.floor_stock, a.warehouse_stock], [8, 20]);
    assert.strictEqual(svc.getProduct('OP-C').floor_stock, 7);
    assert.ok(!svc.lowStock({ limit: 500 }).some((p) => p.sku === 'OP-B' && p.sold_out));
    // Gudang Utama, nomor berurutan, fisik 0 boleh
    const d2 = svc.createOpname({ zone: 'warehouse', items: [{ sku: 'OP-A', counted: 0 }] });
    assert.match(d2.doc_no, /^OP-\d{8}-002$/);
    assert.strictEqual(svc.getProduct('OP-A').warehouse_stock, 0);
    throwsMsg(() => svc.createOpname({ zone: 'customer', items: [{ sku: 'OP-A', counted: 1 }] }), /Zona opname tidak valid/);
    throwsMsg(() => svc.createOpname({ zone: 'floor', items: [{ sku: 'OP-A', counted: -1 }] }), /minimal 0/);
    throwsMsg(() => svc.createOpname({ zone: 'floor', items: [] }), /minimal satu barang/);
    assert.deepStrictEqual(svc.listOpnames({ q: 'Opname B' }).map((x) => x.doc_no), [d.doc_no]);
    throwsMsg(() => svc.deleteProduct({ sku: 'OP-A' }), /opname/);
  });

  await t('stok opname: template & import hasil hitung 3 zona', () => {
    const sheet = svc.opnameSheet();
    assert.deepStrictEqual(sheet.find((r) => r[0] === 'OP-A').slice(0, 8), ['OP-A', 'Opname A', 8, '', 0, '', 0, '']);
    assert.match(sheet[0][10], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/); // Tanggal_Stok = waktu unduh
    // Seperti sheet_to_json(defval ''): semua kolom ada di tiap baris
    const row = (Kode, fd, fg, fb) => ({ Kode, Nama_Barang: '', 'Display Toko': 0, 'Fisik Display Toko': fd, 'Gudang Utama': 0, 'Fisik Gudang Utama': fg, 'Gudang BS': 0, 'Fisik Gudang BS': fb });
    const rows = [
      row('OP-A', 9, '', 2),
      row('7002', '', '', ''), // tidak dihitung → dilewati
      row('KODE-ASING-OP', 1, '', ''),
      row('op-a', 1, '', ''), // kode sama di zona sama → dijumlahkan
      row('OP-C', 'x', '', 1),
    ];
    const plan = svc.importOpname({ rows, dry_run: true });
    assert.deepStrictEqual(plan.zones, [
      { zone: 'floor', line_count: 1, plus_qty: 2, minus_qty: 0, count_at: null },
      { zone: 'damaged', line_count: 2, plus_qty: 3, minus_qty: 0, count_at: null },
    ]);
    assert.strictEqual(plan.errors.length, 2);
    assert.match(plan.errors[0], /Baris 4: .*KODE-ASING-OP/);
    assert.match(plan.errors[1], /Baris 6: Fisik Display Toko "Opname C"/);
    assert.strictEqual(svc.getProduct('OP-A').floor_stock, 8); // dry run tidak mengubah stok
    const r = svc.importOpname({ rows, notes: 'Import tes.xlsx' });
    assert.deepStrictEqual(r.created.map((d) => [d.zone, d.line_count, d.notes]), [['floor', 1, 'Import tes.xlsx'], ['damaged', 2, 'Import tes.xlsx']]);
    const a = svc.getProduct('OP-A');
    assert.deepStrictEqual([a.floor_stock, a.warehouse_stock, a.damaged_stock], [10, 0, 2]);
    const c = svc.getProduct('OP-C');
    assert.deepStrictEqual([c.floor_stock, c.damaged_stock], [7, 1]);
    throwsMsg(() => svc.planOpnameImport([{ Kode: 'OP-A', Stok_Sistem: 8, Fisik: 1 }]), /template opname terbaru/);
  });

  await t('stok opname: Tanggal_Stok → selisih terhadap stok di file, diterapkan ke stok sekarang', () => {
    // Template diunduh: OP-A Display Toko 10 / BS 2, OP-C Display Toko 7, OP-B Display Toko 3
    const sheet = svc.opnameSheet();
    const stamp = sheet[0][10];
    const at = (sku, zoneIdx) => sheet.find((r) => r[0] === sku)[zoneIdx];
    assert.deepStrictEqual([at('OP-A', 2), at('OP-A', 6), at('OP-C', 2), at('OP-B', 2)], [10, 2, 7, 3]);
    // Setelah unduh: OP-A diterima 5 ke Display Toko (→ 15), OP-C pindah 3 ke BS (→ 4)
    svc.createReception({ reference_no: 'SJ-OPNAME', items: [{ sku: 'OP-A', qty: 5, pack_type: 'Biji', destination: 'floor' }] });
    svc.createTransfer({ sku: 'OP-C', from_zone: 'floor', to_zone: 'damaged', qty: 3 });
    const excelSerial = Date.UTC(2026, 0, 1, 8, 30) / 86400000 + 25569; // 2026-01-01 08:30 sebagai tanggal Excel
    const row = (Kode, stockFloor, fisikFloor, tgl, extra = {}) => ({
      Kode, Nama_Barang: '', 'Display Toko': stockFloor, 'Fisik Display Toko': fisikFloor, 'Gudang Utama': 0, 'Fisik Gudang Utama': '', 'Gudang BS': 2, 'Fisik Gudang BS': '', Tanggal_Stok: tgl, ...extra,
    });
    const rows = [
      row('OP-A', 10, 8, stamp, { 'Fisik Gudang BS': 2 }), // −2 di toko, BS cocok
      row('OP-C', 7, 0, stamp), // −7 → hasil 4 − 7 = −3 (boleh minus)
      row('OP-B', 3, 3, excelSerial), // tanggal Excel diterima, selisih 0
      row('OP-A', 10, 1, '2999-01-01 00:00'), // tanggal belum terjadi
      row('OP-A', 10, 1, 'kemarin'), // tanggal tidak terbaca
      row('OP-C', '', 1, stamp), // stok di file kosong
    ];
    const plan = svc.importOpname({ rows, dry_run: true });
    assert.strictEqual(plan.dated, true);
    assert.deepStrictEqual(plan.zones, [
      { zone: 'floor', line_count: 3, plus_qty: 0, minus_qty: 9, count_at: '2026-01-01 08:30:00' },
      { zone: 'damaged', line_count: 1, plus_qty: 0, minus_qty: 0, count_at: `${stamp}:00` },
    ]);
    assert.strictEqual(plan.errors.length, 3);
    assert.match(plan.errors[0], /Baris 5: .*belum terjadi/);
    assert.match(plan.errors[1], /Baris 6: .*tidak terbaca/);
    assert.match(plan.errors[2], /Baris 7: Stok Display Toko di file/);
    const r = svc.importOpname({ rows, notes: 'Import tanggal' });
    const floor = r.created.find((d) => d.zone === 'floor');
    assert.strictEqual(floor.count_at, '2026-01-01 08:30:00');
    assert.deepStrictEqual(floor.items.map((i) => [i.sku, i.system_qty, i.before_qty, i.counted_qty, i.diff]), [
      ['OP-A', 10, 15, 8, -2], ['OP-C', 7, 4, 0, -7], ['OP-B', 3, 3, 3, 0],
    ]);
    assert.deepStrictEqual([svc.getProduct('OP-A').floor_stock, svc.getProduct('OP-A').damaged_stock], [13, 2]);
    assert.deepStrictEqual([svc.getProduct('OP-C').floor_stock, svc.getProduct('OP-C').damaged_stock], [-3, 4]);
    assert.strictEqual(svc.getProduct('OP-B').floor_stock, 3);
  });

  await t('Gudang Shopee: stok terpisah, penerimaan, mutasi, terjual, opname; kasir tidak menyentuh', () => {
    svc.saveProduct({ isNew: true, product: { sku: 'SHP-1', barcode: 'SHP-1', name: 'Barang Online', unit_price: 1000 }, initial: { floor: 5, warehouse: 20, shopee: 3 } });
    let p = svc.getProduct('SHP-1');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.shopee_stock], [5, 20, 3]);
    svc.createReception({ reference_no: 'SJ-SHP', items: [{ sku: 'SHP-1', qty: 4, pack_type: 'Biji', destination: 'shopee' }] });
    svc.createTransfer({ sku: 'SHP-1', from_zone: 'warehouse', to_zone: 'shopee', qty: 10, reason: 'isi stok online' });
    svc.createTransfer({ sku: 'SHP-1', from_zone: 'shopee', to_zone: 'shopee_sold', qty: 6, reason: 'pesanan' });
    throwsMsg(() => svc.createTransfer({ sku: 'SHP-1', from_zone: 'shopee', to_zone: 'shopee_sold', qty: 99 }), /Gudang Shopee untuk .* tidak cukup/);
    if (!svc.getShift()) svc.openShift({ cashier_name: 'Rina', initial_cash: 0 });
    svc.checkout({ items: [{ sku: 'SHP-1', qty: 2 }], payment_method: 'Tunai', cash_received: 2000 });
    p = svc.getProduct('SHP-1');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.shopee_stock], [3, 10, 11]);
    svc.createOpname({ zone: 'shopee', items: [{ sku: 'SHP-1', counted: 9 }] });
    assert.strictEqual(svc.getProduct('SHP-1').shopee_stock, 9);
    assert.strictEqual(svc.listProducts({ filter: 'shopee' }).map((x) => x.sku).join(), 'SHP-1');
    const row = svc.opnameSheet().find((r) => r[0] === 'SHP-1');
    assert.deepStrictEqual(row.slice(8, 10), [9, '']);
    const plan = svc.importOpname({ dry_run: true, rows: [{ Kode: 'SHP-1', 'Fisik Gudang Shopee': 7 }] });
    assert.deepStrictEqual(plan.zones.map((z) => [z.zone, z.minus_qty]), [['shopee', 2]]);
  });

  await t('database versi lama (tanpa zona Shopee) dimigrasi tanpa kehilangan data', async () => {
    const SQL = await require('sql.js')({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
    const old = new SQL.Database();
    old.exec(`CREATE TABLE products (sku TEXT PRIMARY KEY, barcode TEXT UNIQUE NOT NULL, name TEXT NOT NULL, brand TEXT DEFAULT '-', category TEXT DEFAULT 'Umum',
        unit_price INTEGER NOT NULL, base_unit TEXT DEFAULT 'Biji', pack_unit TEXT DEFAULT 'Dus', pack_ratio INTEGER DEFAULT 1, created_at DATETIME);
      CREATE TABLE inventory (sku TEXT PRIMARY KEY, floor_stock INTEGER DEFAULT 0, warehouse_stock INTEGER DEFAULT 0, damaged_stock INTEGER DEFAULT 0, min_floor_alert INTEGER DEFAULT 5);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE stock_transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
        from_zone TEXT NOT NULL CHECK(from_zone IN ('floor', 'warehouse', 'damaged', 'customer')),
        to_zone TEXT NOT NULL CHECK(to_zone IN ('floor', 'warehouse', 'damaged', 'supplier', 'disposed')),
        qty INTEGER NOT NULL, reason TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')));
      INSERT INTO products(sku, barcode, name, unit_price) VALUES('OLD-1', 'OLD-1', 'Barang Lama', 500);
      INSERT INTO inventory(sku, floor_stock, warehouse_stock) VALUES('OLD-1', 2, 30);
      INSERT INTO stock_transfers(sku, from_zone, to_zone, qty, reason) VALUES('OLD-1', 'warehouse', 'floor', 2, 'lama');`);
    const oldFile = path.join(dir, 'lama.db');
    fs.writeFileSync(oldFile, Buffer.from(old.export()));
    const db3 = await Database.open(oldFile);
    const s3 = createServices(db3);
    assert.strictEqual(db3.get("SELECT COUNT(*) AS n FROM stock_transfers WHERE reason = 'lama' AND doc_id IS NOT NULL").n, 1);
    s3.createTransfer({ sku: 'OLD-1', from_zone: 'warehouse', to_zone: 'shopee', qty: 5 });
    s3.createTransfer({ sku: 'OLD-1', from_zone: 'shopee', to_zone: 'shopee_sold', qty: 1 });
    const p = s3.getProduct('OLD-1');
    assert.deepStrictEqual([p.floor_stock, p.warehouse_stock, p.shopee_stock], [2, 25, 4]);
    // Dibuka ulang: tidak dimigrasi dua kali
    const db4 = await Database.open(oldFile);
    assert.strictEqual(db4.get('SELECT COUNT(*) AS n FROM stock_transfers').n, 3);
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
