'use strict';
// Uji batal nota (disetujui PIN Admin; nota asli tidak pernah dihapus): node test/void.test.js
const assert = require('assert');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { buildReceiptLines } = require('../src/receipt');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `harus gagal dengan ${re}`);

(async () => {
  const db = await Database.open(null);
  const svc = createServices(db);
  svc.importRows([
    { Barcode: '2000000000017', SKU: 'A-1', Nama_Barang: 'Barang A', Harga_Jual: 1000, Stok_Awal_Toko: 10 },
    { Barcode: '2000000000024', SKU: 'B-2', Nama_Barang: 'Barang B', Harga_Jual: 2500, Stok_Awal_Toko: 1 },
  ]);
  svc.saveUser({ name: 'Bos', role: 'admin', pin: '111111', active: true });
  svc.saveUser({ name: 'Rina', role: 'kasir', pin: '222222', active: true });
  svc.saveUser({ name: 'Budi', role: 'gudang', pin: '333333', active: true });
  svc.openShift({ cashier_name: 'Rina' });
  const sale = svc.checkout({ items: [{ sku: 'A-1', qty: 3 }, { sku: 'B-2', qty: 2 }], payment_method: 'Tunai', cash_received: 10000 });
  const other = svc.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'Tunai', cash_received: 1000 });
  const stock = (sku) => { const p = svc.getProduct(sku); return [p.floor_stock, p.damaged_stock]; };
  const items = [{ sku: 'A-1', destination: 'floor' }, { sku: 'B-2', destination: 'damaged' }];
  const req = (extra = {}) => ({ receipt_no: sale.receipt_no, reason: 'Pelanggan batal beli', items, requested_by: 'Rina', approver_pin: '111111', ...extra });

  await t('ditolak: PIN bukan PIN Admin, alasan kosong, tujuan stok belum dipilih', () => {
    throwsMsg(() => svc.voidReceipt(req({ approver_pin: '222222' })), /PIN Admin \/ PIN Pembatalan salah/); // PIN kasir
    throwsMsg(() => svc.voidReceipt(req({ approver_pin: '333333' })), /PIN Admin \/ PIN Pembatalan salah/); // PIN gudang
    throwsMsg(() => svc.voidReceipt(req({ approver_pin: '' })), /PIN Admin \/ PIN Pembatalan salah/);
    throwsMsg(() => svc.voidReceipt(req({ reason: ' ' })), /Alasan pembatalan wajib/);
    throwsMsg(() => svc.voidReceipt(req({ reason: 'ab' })), /minimal 3/);
    throwsMsg(() => svc.voidReceipt(req({ items: [{ sku: 'A-1', destination: 'floor' }] })), /Pilih stok tujuan untuk "Barang B"/);
    throwsMsg(() => svc.voidReceipt(req({ receipt_no: 'INV-TIDAK-ADA' })), /shift berjalan/);
    assert.deepStrictEqual(stock('A-1'), [6, 0]);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM receipt_voids').n, 0);
  });

  await t('batal sukses: nota asli utuh, baris minus BTL-, stok kembali sesuai pilihan, mutasi ke BS tercatat', () => {
    const before = svc.shiftSummary();
    const original = svc.receiptDetail({ receipt_no: sale.receipt_no });
    const v = svc.voidReceipt(req());
    assert.match(v.receipt_no, /^BTL-\d{8}-0001$/);
    assert.deepStrictEqual([v.void_of, v.total, v.approved_by, v.requested_by, v.reason], [sale.receipt_no, 8000, 'Bos', 'Rina', 'Pelanggan batal beli']);
    assert.deepStrictEqual(v.lines.map((l) => [l.sku, l.qty, l.line_total]), [['A-1', 3, 3000], ['B-2', 2, 5000]]);
    // Nota asli tidak berubah
    assert.deepStrictEqual(svc.receiptDetail({ receipt_no: sale.receipt_no }), original);
    // Barang A kembali ke Display Toko; Barang B (rusak) ke Gudang BS walau display toko sempat minus
    assert.deepStrictEqual(stock('A-1'), [9, 0]);
    assert.deepStrictEqual(stock('B-2'), [-1, 2]);
    const mt = svc.listTransferDocs({}).find((d) => /batal nota/.test(d.reason));
    assert.ok(mt && mt.from_zone === 'floor' && mt.to_zone === 'damaged' && mt.total_qty === 2);
    // Ringkasan shift: omset & tunai bersih, jumlah struk tetap, daftar pembatalan
    const after = svc.shiftSummary();
    assert.strictEqual(after.totals.revenue, before.totals.revenue - 8000);
    assert.strictEqual(after.cashSales, before.cashSales - 8000);
    assert.strictEqual(after.totals.receipts, before.totals.receipts);
    assert.strictEqual(after.byMethod.find((m) => m.method === 'Tunai').receipts, 2);
    assert.deepStrictEqual(after.byItem.map((i) => [i.sku, i.qty]), [['A-1', 1]]);
    assert.deepStrictEqual([after.voids.count, after.voids.total, after.voids.list[0].void_no], [1, 8000, v.receipt_no]);
    const rowOrig = after.receipts.find((r) => r.receipt_no === sale.receipt_no);
    const rowVoid = after.receipts.find((r) => r.receipt_no === v.receipt_no);
    assert.deepStrictEqual([rowOrig.void_no, rowVoid.void_of, rowVoid.total], [v.receipt_no, sale.receipt_no, -8000]);
  });

  await t('tidak bisa dibatalkan dua kali, nota BTL- tidak bisa dibatalkan', () => {
    throwsMsg(() => svc.voidReceipt(req()), /sudah dibatalkan/);
    const btl = svc.shiftSummary().voids.list[0].void_no;
    throwsMsg(() => svc.voidReceipt(req({ receipt_no: btl })), /pembatalan tidak bisa dibatalkan/);
  });

  await t('cetak ulang: nota pembatalan & tanda sudah dibatalkan', () => {
    const btl = svc.shiftSummary().voids.list[0].void_no;
    const slip = svc.receiptForReprint({ receipt_no: btl });
    const txt = buildReceiptLines(slip, { store_name: 'Toko', paper_width: '58' }).join('\n');
    assert.match(txt, /\*\* NOTA PEMBATALAN \*\*/);
    assert.match(txt, /Dikembalikan=\s+8\.000/);
    assert.match(txt, /Alasan: Pelanggan batal beli/);
    assert.match(txt, /Disetujui: Bos/);
    const orig = buildReceiptLines(svc.receiptForReprint({ receipt_no: sale.receipt_no }), { store_name: 'Toko' }, { reprint: true }).join('\n');
    assert.match(orig, /NOTA SUDAH DIBATALKAN/);
    assert.ok(!/SUDAH DIBATALKAN/.test(buildReceiptLines(svc.receiptForReprint({ receipt_no: other.receipt_no }), { store_name: 'Toko' }, { reprint: true }).join('\n')));
  });

  await t('mother base menerima baris minus; tutup shift memindahkan pembatalan ke riwayat; nota shift lama tidak bisa dibatalkan', () => {
    const data = svc.shiftData({});
    const minus = data.sales.filter((l) => /^BTL-/.test(l.receipt_no));
    assert.deepStrictEqual(minus.map((l) => [l.qty, l.line_total]), [[-3, -3000], [-2, -5000]]);
    assert.deepStrictEqual([data.shift.receipts, data.shift.revenue], [2, 1000]);
    svc.archiveShift({});
    assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM shift_history_sales WHERE receipt_no LIKE 'BTL-%'").n, 2);
    svc.openShift({ cashier_name: 'Rina' });
    throwsMsg(() => svc.voidReceipt(req({ receipt_no: other.receipt_no })), /shift berjalan/);
  });

  await t('PIN Pembatalan: diatur Admin, tidak sama dengan PIN login, tersimpan terenkripsi, bisa dilihat, menyetujui batal nota', () => {
    // Tiruan enkripsi akun Windows: nilai tersimpan dibungkus, bukan PIN polos
    const sv = createServices(db, { encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString() : '') });
    assert.deepStrictEqual(sv.voidPinInfo(), { set: false, holder: 'Kepala Toko', updated_at: '' });
    throwsMsg(() => sv.setVoidPin({ pin: '12345' }), /6 digit/);
    throwsMsg(() => sv.setVoidPin({ pin: 'abcdef' }), /6 digit/);
    throwsMsg(() => sv.setVoidPin({ pin: '222222' }), /sama dengan PIN login/); // PIN kasir
    throwsMsg(() => sv.setVoidPin({ pin: '111111' }), /sama dengan PIN login/); // PIN admin
    const info = sv.setVoidPin({ pin: '765432', holder: 'Kepala Toko - Sari' });
    assert.deepStrictEqual([info.set, info.holder, info.pin], [true, 'Kepala Toko - Sari', undefined]);
    assert.ok(info.updated_at);
    assert.strictEqual(sv.voidPinInfo({ reveal: true }).pin, '765432');
    assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM settings WHERE value LIKE '%765432%'").n, 0);
    assert.ok(!JSON.stringify(sv.getSettings()).includes('765432'));
    // PIN login baru tidak boleh sama dengan PIN Pembatalan
    throwsMsg(() => sv.saveUser({ name: 'Dodi', role: 'kasir', pin: '765432', active: true }), /PIN Pembatalan/);
    const sell = () => sv.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'Tunai', cash_received: 1000 }).receipt_no;
    const voidWith = (no, pin) => sv.voidReceipt({ receipt_no: no, reason: 'Salah scan', items: [{ sku: 'A-1', destination: 'floor' }], requested_by: 'Rina', approver_pin: pin });
    assert.strictEqual(voidWith(sell(), '765432').approved_by, 'Kepala Toko - Sari (PIN Pembatalan)');
    assert.strictEqual(voidWith(sell(), '111111').approved_by, 'Bos'); // PIN Admin tetap berlaku
    throwsMsg(() => voidWith(sell(), '222222'), /PIN Admin \/ PIN Pembatalan salah/);
    // Persetujuan cetak ulang nota memakai PIN yang sama
    assert.deepStrictEqual(sv.checkApprover({ approver_pin: '765432' }), { approved_by: 'Kepala Toko - Sari (PIN Pembatalan)' });
    assert.deepStrictEqual(sv.checkApprover({ approver_pin: '111111' }), { approved_by: 'Bos' });
    for (const pin of ['222222', '333333', '', undefined]) throwsMsg(() => sv.checkApprover({ approver_pin: pin }), /PIN Admin \/ PIN Pembatalan salah/);
    // Dihapus → PIN lama tidak berlaku lagi
    assert.strictEqual(sv.clearVoidPin().set, false);
    throwsMsg(() => voidWith(sell(), '765432'), /PIN Admin \/ PIN Pembatalan salah/);
    throwsMsg(() => sv.checkApprover({ approver_pin: '765432' }), /PIN Admin \/ PIN Pembatalan salah/);
  });

  console.log(`\n${passed} tes batal nota lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
