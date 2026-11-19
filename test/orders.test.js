'use strict';
// Uji pesanan pelanggan (stok belum dipotong, deposit, ambil, batal): node test/orders.test.js
const assert = require('assert');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { buildReceiptLines, buildOrderRows, buildShiftRows, rowsToText, COLS } = require('../src/receipt');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `harus gagal dengan ${re}`);
function ymd(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const db = await Database.open(null);
  const svc = createServices(db);
  svc.importRows([
    { Barcode: '2000000000017', SKU: 'A-1', Nama_Barang: 'Kipas Angin', Harga_Jual: 150000, Stok_Awal_Toko: 2, Stok_Awal_Gudang: 10 },
    { Barcode: '2000000000024', SKU: 'B-2', Nama_Barang: 'Rice Cooker', Harga_Jual: 300000, Stok_Awal_Toko: 0, Stok_Awal_Gudang: 4 },
    { Barcode: '2000000000031', SKU: 'C-3', Nama_Barang: 'Sapu', Harga_Jual: 20000, Stok_Awal_Toko: 5 },
  ]);
  svc.saveUser({ name: 'Bos', role: 'admin', pin: '111111', active: true });
  svc.saveUser({ name: 'Rina', role: 'kasir', pin: '222222', active: true });
  const stock = (sku) => { const p = svc.getProduct(sku); return [p.floor_stock, p.warehouse_stock]; };
  const base = (extra = {}) => ({
    items: [{ sku: 'A-1', qty: 1 }, { sku: 'B-2', qty: 2 }], customer_name: 'Bu Ani', customer_phone: '0812-3456',
    pickup_date: ymd(2), deposit: 200000, notes: 'Warna putih', created_by: 'Rina', ...extra,
  });

  await t('tanpa shift: pesanan ditolak', () => {
    throwsMsg(() => svc.createOrder(base()), /Shift belum dibuka/);
  });

  svc.openShift({ cashier_name: 'Rina' });
  let o1;

  await t('buat pesanan: stok TIDAK dipotong, harga dikunci, deposit masuk laci (bukan omset)', () => {
    o1 = svc.createOrder(base({ items: [{ sku: 'A-1', qty: 1 }, { sku: 'B-2', qty: 1 }, { sku: 'B-2', qty: 1 }] }));
    assert.match(o1.order_no, /^PSN-\d{8}-0001$/);
    assert.deepStrictEqual([o1.status, o1.customer_name, o1.customer_phone, o1.pickup_date, o1.notes, o1.created_by],
      ['baru', 'Bu Ani', '0812-3456', ymd(2), 'Warna putih', 'Rina']);
    assert.deepStrictEqual(o1.items.map((i) => [i.sku, i.qty, i.unit_price, i.line_total]), [['A-1', 1, 150000, 150000], ['B-2', 2, 300000, 600000]]);
    assert.deepStrictEqual([o1.total, o1.deposit, o1.remaining], [750000, 200000, 550000]);
    assert.deepStrictEqual(stock('A-1'), [2, 10]);
    assert.deepStrictEqual(stock('B-2'), [0, 4]);
    const s = svc.shiftSummary();
    assert.deepStrictEqual([s.totals.revenue, s.totals.receipts, s.cashSales], [0, 0, 0]);
    assert.deepStrictEqual(s.orders, { deposit_in: 200000, deposit_used: 0, refunded: 0, forfeited: 0, cash_total: 200000 });
  });

  await t('validasi: nama, tanggal, deposit, barang', () => {
    throwsMsg(() => svc.createOrder(base({ customer_name: '  ' })), /Nama pelanggan wajib/);
    throwsMsg(() => svc.createOrder(base({ pickup_date: '' })), /Tanggal ambil tidak valid/);
    throwsMsg(() => svc.createOrder(base({ pickup_date: '2026-13-45' })), /Tanggal ambil tidak valid/);
    throwsMsg(() => svc.createOrder(base({ pickup_date: ymd(-1) })), /sebelum hari ini/);
    throwsMsg(() => svc.createOrder(base({ deposit: 750001 })), /melebihi total/);
    throwsMsg(() => svc.createOrder(base({ deposit: -5 })), /Deposit/);
    throwsMsg(() => svc.createOrder(base({ items: [] })), /Keranjang masih kosong/);
    throwsMsg(() => svc.createOrder(base({ items: [{ sku: 'X-9', qty: 1 }] })), /tidak ditemukan/);
    throwsMsg(() => svc.createOrder(base({ items: [{ sku: 'A-1', qty: 0 }] })), /Jumlah/);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM customer_orders').n, 1);
  });

  let o2;
  let o3;
  await t('daftar, filter, cari, dan jumlah yang jatuh tempo', () => {
    o2 = svc.createOrder(base({ items: [{ sku: 'C-3', qty: 3 }], customer_name: 'Pak Budi', customer_phone: '0899', pickup_date: ymd(0), deposit: 0, notes: '' }));
    o3 = svc.createOrder(base({ items: [{ sku: 'C-3', qty: 1 }], customer_name: 'Mbak Sari', customer_phone: '', pickup_date: ymd(1), deposit: 10000 }));
    assert.match(o2.order_no, /-0002$/);
    // Belum diambil: urut tanggal ambil terdekat
    assert.deepStrictEqual(svc.listOrders().map((o) => o.order_no), [o2.order_no, o3.order_no, o1.order_no]);
    const row = svc.listOrders().find((o) => o.order_no === o1.order_no);
    assert.deepStrictEqual([row.item_count, row.qty, row.remaining], [2, 3, 550000]);
    assert.deepStrictEqual(svc.listOrders({ q: 'budi' }).map((o) => o.order_no), [o2.order_no]);
    assert.deepStrictEqual(svc.listOrders({ q: '0812' }).map((o) => o.order_no), [o1.order_no]);
    assert.deepStrictEqual(svc.listOrders({ q: o3.order_no }).map((o) => o.customer_name), ['Mbak Sari']);
    assert.strictEqual(svc.listOrders({ status: 'diambil' }).length, 0);
    assert.strictEqual(svc.listOrders({ status: 'semua' }).length, 3);
    assert.strictEqual(svc.ordersDue(), 1); // hanya yang diambil hari ini
    assert.strictEqual(svc.shiftSummary().orders.deposit_in, 210000);
  });

  await t('ambil: pilihan stok & uang kurang ditolak', () => {
    throwsMsg(() => svc.completeOrder({ order_no: o1.order_no, zone: 'damaged', cash_received: 550000 }), /Display Toko atau Gudang Utama/);
    throwsMsg(() => svc.completeOrder({ order_no: o1.order_no, zone: 'warehouse', cash_received: 549999 }), /kurang Rp 1/);
    throwsMsg(() => svc.completeOrder({ order_no: 'PSN-TIDAK-ADA', zone: 'floor', cash_received: 0 }), /tidak ditemukan/);
    assert.strictEqual(svc.getOrder({ order_no: o1.order_no }).status, 'baru');
  });

  await t('ambil dari Gudang Utama: dokumen mutasi, harga terkunci, omset penuh, deposit terpakai', () => {
    // Harga barang naik setelah pesan: pesanan tetap pakai harga lama
    svc.saveProduct({ product: { ...svc.getProduct('A-1'), unit_price: 175000 } });
    const r = svc.completeOrder({ order_no: o1.order_no, zone: 'warehouse', cash_received: 600000, done_by: 'Rina' });
    assert.match(r.receipt.receipt_no, /^INV-/);
    assert.deepStrictEqual([r.receipt.total, r.receipt.deposit, r.receipt.cash_received, r.receipt.change, r.receipt.order_no],
      [750000, 200000, 600000, 50000, o1.order_no]);
    assert.deepStrictEqual(r.receipt.lines.map((l) => [l.sku, l.qty, l.unit_price]), [['A-1', 1, 150000], ['B-2', 2, 300000]]);
    // Gudang Utama → Display Toko (dokumen mutasi), lalu terjual dari Display Toko
    assert.deepStrictEqual(stock('A-1'), [2, 9]);
    assert.deepStrictEqual(stock('B-2'), [0, 2]);
    const mt = svc.listTransferDocs({}).find((d) => d.reason.includes(o1.order_no));
    assert.ok(mt && mt.from_zone === 'warehouse' && mt.to_zone === 'floor' && mt.total_qty === 3, 'dokumen mutasi pesanan');
    const o = svc.getOrder({ order_no: o1.order_no });
    assert.deepStrictEqual([o.status, o.receipt_no, o.pickup_zone, o.done_by], ['diambil', r.receipt.receipt_no, 'warehouse', 'Rina']);
    // Shift: omset penuh, deposit terpakai, uang tunai di laci = deposit + sisa yang dibayar
    const s = svc.shiftSummary();
    assert.deepStrictEqual([s.totals.revenue, s.totals.receipts, s.cashSales], [750000, 1, 750000]);
    assert.deepStrictEqual(s.orders, { deposit_in: 210000, deposit_used: 200000, refunded: 0, forfeited: 0, cash_total: 760000 });
    // Nota memuat nomor pesanan, deposit, sisa bayar
    const txt = buildReceiptLines(r.receipt, { store_name: 'Toko', paper_width: '58' }).join('\n');
    assert.match(txt, new RegExp(`Pesanan: ${o1.order_no}`));
    assert.match(txt, /Deposit\s+=\s+200\.000/);
    assert.match(txt, /Sisa bayar\s+=\s+550\.000/);
    assert.match(txt, /Tunai\s+=\s+600\.000/);
    assert.match(txt, /Kembali\s+=\s+50\.000/);
    // Cetak ulang nota dari Laporan Shift juga membawa deposit
    const re = svc.receiptForReprint({ receipt_no: r.receipt.receipt_no });
    assert.deepStrictEqual([re.order_no, re.deposit], [o1.order_no, 200000]);
    assert.match(buildReceiptLines(re, { paper_width: '80' }, { reprint: true }).join('\n'), /Tunai\s+=\s+550\.000/);
  });

  await t('tidak bisa diambil / dibatalkan lagi setelah diambil', () => {
    throwsMsg(() => svc.completeOrder({ order_no: o1.order_no, zone: 'floor', cash_received: 999999 }), /sudah diambil/);
    throwsMsg(() => svc.cancelOrder({ order_no: o1.order_no, reason: 'Salah', approver_pin: '111111', deposit_action: 'kembali' }), /sudah diambil tidak bisa dibatalkan/);
  });

  await t('ambil dari Display Toko tanpa deposit', () => {
    const r = svc.completeOrder({ order_no: o2.order_no, zone: 'floor', cash_received: 60000 });
    assert.deepStrictEqual([r.receipt.total, r.receipt.deposit, r.receipt.change], [60000, 0, 0]);
    assert.deepStrictEqual(stock('C-3'), [2, 0]);
    assert.strictEqual(svc.ordersDue(), 0);
    const txt = buildReceiptLines(r.receipt, { paper_width: '58' }).join('\n');
    assert.doesNotMatch(txt, /Deposit/);
  });

  await t('batal: PIN kasir ditolak, deposit wajib dipilih, alasan wajib', () => {
    const req = (extra = {}) => ({ order_no: o3.order_no, reason: 'Pelanggan tidak jadi', deposit_action: 'kembali', approver_pin: '111111', requested_by: 'Rina', ...extra });
    throwsMsg(() => svc.cancelOrder(req({ approver_pin: '222222' })), /PIN Admin \/ PIN Pembatalan salah/);
    throwsMsg(() => svc.cancelOrder(req({ approver_pin: '' })), /PIN Admin \/ PIN Pembatalan salah/);
    throwsMsg(() => svc.cancelOrder(req({ deposit_action: '' })), /dikembalikan atau hangus/);
    throwsMsg(() => svc.cancelOrder(req({ reason: 'ab' })), /minimal 3/);
    assert.strictEqual(svc.getOrder({ order_no: o3.order_no }).status, 'baru');
  });

  await t('batal dengan deposit dikembalikan: uang keluar dari laci, stok tetap', () => {
    const before = stock('C-3');
    const o = svc.cancelOrder({ order_no: o3.order_no, reason: 'Pelanggan tidak jadi', deposit_action: 'kembali', approver_pin: '111111', requested_by: 'Rina' });
    assert.deepStrictEqual([o.status, o.cancel_deposit, o.cancel_approved_by, o.done_by, o.cancel_reason], ['batal', 'kembali', 'Bos', 'Rina', 'Pelanggan tidak jadi']);
    assert.deepStrictEqual(stock('C-3'), before);
    assert.deepStrictEqual(svc.shiftSummary().orders, { deposit_in: 210000, deposit_used: 200000, refunded: 10000, forfeited: 0, cash_total: 810000 - 200000 + 210000 - 10000 });
    throwsMsg(() => svc.cancelOrder({ order_no: o3.order_no, reason: 'lagi', deposit_action: 'hangus', approver_pin: '111111' }), /sudah dibatalkan/);
    throwsMsg(() => svc.completeOrder({ order_no: o3.order_no, zone: 'floor', cash_received: 99999 }), /sudah dibatalkan/);
    assert.deepStrictEqual(svc.listOrders({ status: 'batal' }).map((x) => x.order_no), [o3.order_no]);
  });

  await t('deposit lintas shift: masuk di shift lama, terpakai di shift baru; batal hangus; PIN Pembatalan', () => {
    const o4 = svc.createOrder(base({ items: [{ sku: 'C-3', qty: 2 }], deposit: 15000, pickup_date: ymd(3) }));
    const o5 = svc.createOrder(base({ items: [{ sku: 'C-3', qty: 1 }], deposit: 5000, pickup_date: ymd(3) }));
    svc.archiveShift({ notes: 'tutup' });
    // Tanpa shift: tidak bisa diambil / deposit tidak bisa dikembalikan
    throwsMsg(() => svc.completeOrder({ order_no: o4.order_no, zone: 'floor', cash_received: 25000 }), /Shift belum dibuka/);
    throwsMsg(() => svc.cancelOrder({ order_no: o5.order_no, reason: 'Batal beli', deposit_action: 'kembali', approver_pin: '111111' }), /Shift belum dibuka/);
    // Hangus tidak memindahkan uang: boleh tanpa shift; PIN Pembatalan (kepala toko) juga berlaku
    svc.setVoidPin({ pin: '654321' });
    const c = svc.cancelOrder({ order_no: o5.order_no, reason: 'Tidak diambil', deposit_action: 'hangus', approver_pin: '654321' });
    assert.strictEqual(c.cancel_deposit, 'hangus');
    svc.openShift({ cashier_name: 'Rina' });
    svc.completeOrder({ order_no: o4.order_no, zone: 'floor', cash_received: 25000 });
    const s = svc.shiftSummary();
    assert.deepStrictEqual([s.totals.revenue, s.cashSales], [40000, 40000]);
    // Laci shift baru: hanya sisa bayar (40.000 − 15.000 deposit dari shift lama)
    assert.deepStrictEqual(s.orders, { deposit_in: 0, deposit_used: 15000, refunded: 0, forfeited: 0, cash_total: 25000 });
  });

  await t('bukti pesanan: nomor, tanggal ambil, pelanggan, total/deposit/sisa, muat di kertas 58 & 80 mm', () => {
    const o = svc.createOrder(base({ items: [{ sku: 'A-1', qty: 2 }], customer_name: 'Ibu Dewi Lestari Wulandari', deposit: 100000, notes: 'Antar ke rumah' }));
    for (const w of ['58', '80']) {
      const width = COLS[w];
      const lines = rowsToText(buildOrderRows(o, { store_name: 'Toko Maju', paper_width: w }), COLS[w]);
      const txt = lines.join('\n');
      assert.match(txt, /\*\* BUKTI PESANAN \*\*/);
      assert.match(txt, new RegExp(o.order_no));
      const [y, m, d] = o.pickup_date.split('-');
      assert.match(txt, new RegExp(`Ambil tgl\\s+${d}-${m}-${y}`));
      assert.match(txt, /Pelanggan: Ibu Dewi/);
      assert.match(txt, /HP: 0812-3456/);
      assert.match(txt, /Total\s+=\s+350\.000/);
      assert.match(txt, /Deposit\s+=\s+100\.000/);
      assert.match(txt, /Sisa bayar\s+=\s+250\.000/);
      assert.match(txt, /Catatan: Antar ke rumah/);
      assert.match(txt, /Tunjukkan bukti ini/);
      assert.doesNotMatch(txt, /CETAK ULANG/);
      for (const l of lines) assert.ok(l.length <= width, `baris melebihi ${width} kolom: "${l}"`);
    }
    const re = rowsToText(buildOrderRows({ ...o, status: 'batal' }, { paper_width: '58' }, { reprint: true }), COLS[58]).join('\n');
    assert.match(re, /CETAK ULANG/);
    assert.match(re, /PESANAN DIBATALKAN/);
  });

  await t('rekap tutup shift: baris deposit & uang tunai di laci (hanya bila ada), muat di kertas', () => {
    const recap = { cashier: 'Rina', shift_start: '2026-11-19 08:00:00', closed_at: '2026-11-19 16:00:00', receipts: 3, qty: 5, revenue: 810000, cash_sales: 810000 };
    const orders = { deposit_in: 210000, deposit_used: 200000, refunded: 10000, forfeited: 5000, cash_total: 810000 };
    for (const w of ['58', '80']) {
      const lines = rowsToText(buildShiftRows({ ...recap, orders }, { paper_width: w }), COLS[w]);
      const txt = lines.join('\n');
      assert.match(txt, /Deposit masuk\s*=\s+210\.000/);
      assert.match(txt, /Deposit pakai\s*=\s+200\.000/);
      assert.match(txt, /Deposit kembali\s*=\s+10\.000/);
      assert.match(txt, /Deposit hangus\s*=\s+5\.000/);
      assert.match(txt, /Tunai di laci\s*=\s+810\.000/);
      for (const l of lines) assert.ok(l.length <= COLS[w], `baris melebihi ${COLS[w]} kolom: "${l}"`);
    }
    const none = rowsToText(buildShiftRows({ ...recap, orders: { deposit_in: 0, deposit_used: 0, refunded: 0, forfeited: 0, cash_total: 810000 } }, { paper_width: '58' }), COLS[58]).join('\n');
    assert.doesNotMatch(none, /Deposit|di laci/);
  });

  console.log(`\n${passed} tes pesanan lolos${process.exitCode ? ' (ada yang GAGAL)' : ''}`);
})();
