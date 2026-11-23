'use strict';
// Uji pengiriman ke mother base, kunci master barang, dan perubahan tutup shift: node test/motherbase.test.js
// Mother base ditiru dengan fetch palsu; uji dengan database sungguhan ada di motherbase/test/uji.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { createServices, PAYMENT_METHODS, SHIFT_HISTORY_DAYS, localNow } = require('../src/services');
const { createMotherbase } = require('../src/motherbase');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `harus gagal dengan ${re}`);

// Mother base palsu: mencatat kiriman, membalas seperti RPC terima_data / ambil_master
function fakeMotherbase() {
  const fm = { calls: [], down: false, kunci: 'kunci-rahasia', master: [], rejectShifts: false,
    permintaan: { minta: false, opname: [] }, diterapkan: [], ackDown: false };
  fm.fetch = async (url, opt) => {
    if (fm.down) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
    const fn = url.split('/rpc/')[1];
    const p = JSON.parse(opt.body).p;
    fm.calls.push({ fn, p, headers: opt.headers });
    const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });
    if (p.kunci !== fm.kunci) return reply(400, { message: 'Kode toko atau kunci toko salah, atau toko tidak aktif.' });
    if (fn === 'terima_data') {
      const d = p.dokumen || {};
      return reply(200, {
        ok: true, kode_toko: p.kode_toko, shift_diterima: fm.rejectShifts ? [] : (p.shifts || []).map((s) => s.shift.shift_uid),
        snapshot: p.snapshot ? true : null, dokumen: { penerimaan: (d.receptions || []).length, mutasi: (d.transfers || []).length, opname: (d.opnames || []).length },
      });
    }
    if (fn === 'cek_permintaan') return reply(200, { kode_toko: p.kode_toko, ...fm.permintaan });
    if (fn === 'opname_diterapkan') {
      if (fm.ackDown) return reply(503, { message: 'sedang pemeliharaan' });
      fm.diterapkan.push(...p.hasil);
      return reply(200, { ok: true, diterapkan: p.hasil.length });
    }
    if (fn === 'ambil_master') return reply(200, { kode_toko: p.kode_toko, server_at: '2026-11-16T10:00:00Z', produk: p.sejak && p.sejak > '2900' ? [] : fm.master });
    return reply(404, { message: 'not found' });
  };
  return fm;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-mb-test-'));
  const db = await Database.open(null);
  const svc = createServices(db);
  svc.importRows([
    { Barcode: '2000000000017', SKU: 'A-1', Nama_Barang: 'Barang A', Harga_Jual: 1000, Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 6, Stok_Awal_Toko: 50, Stok_Awal_Gudang: 20 },
    { Barcode: '2000000000024', SKU: 'B-2', Nama_Barang: 'Barang B', Harga_Jual: 2500, Stok_Awal_Toko: 20 },
  ]);
  const fm = fakeMotherbase();
  const mb = createMotherbase({ svc, appVersion: 'tes', fetchFn: fm.fetch });

  await t('metode bayar Tunai / QRIS / Transfer; riwayat shift 4 hari', () => {
    assert.deepStrictEqual(PAYMENT_METHODS, ['Tunai', 'QRIS', 'Transfer']);
    assert.strictEqual(SHIFT_HISTORY_DAYS, 4);
    svc.openShift({ cashier_name: 'Rina' });
    throwsMsg(() => svc.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'Kartu Debit' }), /tidak dikenal/);
    svc.checkout({ items: [{ sku: 'A-1', qty: 2 }], payment_method: 'Transfer' });
    svc.checkout({ items: [{ sku: 'B-2', qty: 1 }], payment_method: 'Tunai', cash_received: 5000 });
  });

  await t('transaksi mode darurat lama "Kartu Debit" dari PC kasir versi lama tetap diterima sebagai Transfer', () => {
    const r = svc.importOfflineSale({ receipt_no: 'OFF-20261116-AAAA-0001', payment_method: 'Kartu Debit', lines: [{ sku: 'B-2', qty: 1, unit_price: 2500 }] });
    assert.ok(r);
    const line = db.get("SELECT payment_method FROM shift_sales WHERE receipt_no = 'OFF-20261116-AAAA-0001'");
    assert.strictEqual(line.payment_method, 'Transfer');
  });

  await t('belum diatur: tidak ada kiriman, status jelas', async () => {
    assert.strictEqual(await mb.tick(), null);
    await assert.rejects(mb.kirim(), /belum diatur/);
    const st = svc.mbStatus();
    assert.strictEqual(st.ready, false);
    assert.strictEqual(st.has_kunci, false);
  });

  await t('pengaturan: alamat https, kode 3 huruf, kunci disimpan terenkripsi dan tidak tampil di status', () => {
    throwsMsg(() => svc.mbSaveConfig({ url: 'ftp://x' }), /https/);
    throwsMsg(() => svc.mbSaveConfig({ kode_toko: 'KR' }), /3 huruf/);
    // Kolom tertukar: kunci toko di Anon key, anon key di Kunci toko
    throwsMsg(() => svc.mbSaveConfig({ anon_key: '4a'.repeat(24) }), /adalah kunci toko/);
    throwsMsg(() => svc.mbSaveConfig({ kunci: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc_DEF-123' }), /adalah anon key/);
    const enc = createServices(db, { encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(String(s).slice(4), 'base64').toString() });
    const st = enc.mbSaveConfig({ url: 'https://contoh.supabase.co/', anon_key: 'anon-123', kode_toko: 'trp', kunci: 'kunci-rahasia' });
    assert.strictEqual(db.get("SELECT value FROM settings WHERE key = 'mb_kunci'").value.startsWith('enc:'), true);
    assert.strictEqual(enc.mbConfig().kunci, 'kunci-rahasia');
    assert.strictEqual(st.kode_toko, 'TRP');
    assert.strictEqual(st.url, 'https://contoh.supabase.co');
    assert.ok(!JSON.stringify(st).includes('kunci-rahasia'));
    svc.mbSaveConfig({ kunci: 'kunci-rahasia' }); // svc uji tanpa enkripsi
    assert.strictEqual(svc.mbStatus().ready, true);
  });

  await t('tutup shift: penjualan masuk antrean mother base di transaksi yang sama, status Menunggu di riwayat', () => {
    const uid = svc.getShift().shift_uid;
    // Pakai tanggal hari ini: riwayat shift yang lebih tua dari SHIFT_HISTORY_DAYS hari terhapus otomatis saat tutup shift
    const closedAt = `${localNow().slice(0, 10)} 21:05:00`;
    svc.archiveShift({ closed_at: closedAt, notes: 'uji' });
    const row = db.get('SELECT * FROM mb_outbox_shift WHERE shift_uid = ?', [uid]);
    const p = JSON.parse(row.payload);
    assert.strictEqual(p.shift.closed_at, closedAt);
    assert.strictEqual(p.shift.receipts, 3);
    assert.strictEqual(p.sales.length, 3);
    assert.deepStrictEqual(p.pembatalan, []); // tanpa batal nota: daftar kosong, bentuk kiriman lain tidak berubah
    assert.strictEqual(row.sent_at, null);
    assert.strictEqual(svc.listShiftHistory()[0].mb_terkirim, 0);
  });

  svc.createReception({ reference_no: 'DO.UJI.0001', supplier_name: 'PT Kantor', items: [{ sku: 'A-1', qty: 2, pack_type: 'Dus', destination: 'warehouse' }] });
  svc.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', reason: 'Isi rak', items: [{ sku: 'A-1', qty: 6 }] });
  svc.createOpname({ zone: 'floor', notes: 'SO', items: [{ sku: 'B-2', counted: 18 }] });

  await t('tanpa internet: kiriman gagal, data tetap menunggu, error tersimpan', async () => {
    fm.down = true;
    await assert.rejects(mb.kirim(), /Tidak dapat terhubung/);
    const st = svc.mbStatus();
    assert.strictEqual(st.pending_shifts, 1);
    assert.deepStrictEqual(st.pending_docs, { receptions: 1, transfers: 1, opnames: 1 });
    assert.match(st.last_error, /terhubung/);
    const r = await mb.tick(); // tick tidak melempar
    assert.match(r.kirimError, /terhubung/);
    fm.down = false;
  });

  await t('kunci salah: ditolak dengan pesan yang jelas, data tetap menunggu', async () => {
    fm.kunci = 'lain';
    await assert.rejects(mb.kirim(), /kunci toko salah/);
    assert.strictEqual(svc.mbStatus().pending_shifts, 1);
    fm.kunci = 'kunci-rahasia';
  });

  await t('online: shift, dokumen, dan stok terkirim; ditandai setelah balasan; kiriman berikutnya kosong', async () => {
    fm.calls.length = 0;
    const r = await mb.kirim();
    assert.deepStrictEqual(r, { kiriman: 1, shift: 1, penerimaan: 1, mutasi: 1, opname: 1, snapshot: true });
    const c = fm.calls[0];
    assert.strictEqual(c.fn, 'terima_data');
    assert.strictEqual(c.headers.apikey, 'anon-123');
    assert.deepStrictEqual([c.p.protokol, c.p.kode_toko, c.p.kunci], [1, 'TRP', 'kunci-rahasia']);
    assert.strictEqual(c.p.dokumen.receptions[0].reference_no, 'DO.UJI.0001');
    assert.strictEqual(c.p.dokumen.receptions[0].items[0].qty, 12); // 2 Coly × 6
    assert.strictEqual(c.p.dokumen.transfers[0].lines[0].qty, 6);
    assert.strictEqual(c.p.snapshot.inventory.length, 2);
    assert.strictEqual(c.p.snapshot.current_shift, null);
    for (const secret of ['smtp', 'pin_hash', 'owner_email']) assert.ok(!JSON.stringify(c.p).includes(secret));
    const st = svc.mbStatus();
    assert.strictEqual(st.pending_shifts, 0);
    assert.deepStrictEqual(st.pending_docs, { receptions: 0, transfers: 0, opnames: 0 });
    assert.strictEqual(st.last_error, '');
    fm.calls.length = 0;
    assert.strictEqual((await mb.kirim()).kiriman, 0);
    assert.strictEqual(fm.calls.length, 0);
  });

  await t('stok berubah → hanya keadaan terkini yang dikirim; force mengirim walau tidak berubah', async () => {
    svc.openShift({ cashier_name: 'Budi' });
    svc.checkout({ items: [{ sku: 'B-2', qty: 1 }], payment_method: 'QRIS' });
    fm.calls.length = 0;
    await mb.kirim();
    assert.strictEqual(fm.calls.length, 1);
    assert.strictEqual(fm.calls[0].p.shifts.length, 0);
    assert.strictEqual(fm.calls[0].p.dokumen, null);
    assert.strictEqual(fm.calls[0].p.snapshot.current_shift.sales.length, 1);
    fm.calls.length = 0;
    await mb.kirim({ force: true });
    assert.ok(fm.calls[0].p.snapshot);
  });

  let batal;
  await t('batal nota: nota asal, alasan, peminta, dan Admin penyetuju ikut shift berjalan & data shift (tanpa PIN)', async () => {
    svc.saveUser({ name: 'Bos', role: 'admin', pin: '111111', active: true });
    const nota = svc.checkout({ items: [{ sku: 'A-1', qty: 2 }], payment_method: 'Tunai', cash_received: 5000 });
    const v = svc.voidReceipt({ receipt_no: nota.receipt_no, reason: 'Pelanggan batal beli', items: [{ sku: 'A-1', destination: 'floor' }],
      requested_by: 'Budi', approver_pin: '111111' });
    batal = [{ void_no: v.receipt_no, receipt_no: nota.receipt_no, reason: 'Pelanggan batal beli', requested_by: 'Budi', approved_by: 'Bos',
      total: 2000, created_at: v.created_at }];
    assert.match(v.receipt_no, /^BTL-\d{8}-\d{4}$/);
    fm.calls.length = 0;
    await mb.kirim();
    const cs = fm.calls[0].p.snapshot.current_shift;
    assert.deepStrictEqual(cs.pembatalan, batal);
    assert.deepStrictEqual(cs.sales.filter((l) => l.receipt_no === v.receipt_no).map((l) => [l.qty, l.line_total]), [[-2, -2000]]);
    const data = svc.shiftData({});
    assert.deepStrictEqual(data.pembatalan, batal);
    assert.deepStrictEqual([data.shift.receipts, data.shift.revenue], [2, 2500]); // BTL- bukan struk; omzet bersih
    assert.ok(!/111111|pin_hash|pin_salt/.test(JSON.stringify(fm.calls[0].p)));
  });

  await t('pesanan pelanggan ikut snapshot: baru, diambil, batal + barang; yang selesai > 60 hari tidak dikirim lagi', async () => {
    const hari = localNow().slice(0, 10);
    const o1 = svc.createOrder({ items: [{ sku: 'B-2', qty: 2 }], customer_name: 'Ibu Ani', customer_phone: '0812', pickup_date: hari, deposit: 1000, notes: 'warna merah' });
    const o2 = svc.createOrder({ items: [{ sku: 'A-1', qty: 1 }], customer_name: 'Pak Joko', pickup_date: hari });
    svc.completeOrder({ order_no: o2.order_no, zone: 'floor', cash_received: 1000, done_by: 'Budi' });
    const o3 = svc.createOrder({ items: [{ sku: 'A-1', qty: 3 }], customer_name: 'Mbak Sri', pickup_date: hari, deposit: 500 });
    svc.cancelOrder({ order_no: o3.order_no, reason: 'Tidak jadi', deposit_action: 'hangus', approver_pin: '111111', requested_by: 'Budi' });
    fm.calls.length = 0;
    await mb.kirim();
    const orders = fm.calls[0].p.snapshot.orders;
    assert.deepStrictEqual(orders.map((o) => [o.order_no, o.status]), [[o1.order_no, 'baru'], [o2.order_no, 'diambil'], [o3.order_no, 'batal']]);
    assert.deepStrictEqual([orders[0].customer_name, orders[0].customer_phone, orders[0].deposit, orders[0].total, orders[0].notes], ['Ibu Ani', '0812', 1000, 5000, 'warna merah']);
    assert.deepStrictEqual(orders[0].items, [{ sku: 'B-2', name: 'Barang B', qty: 2, unit_price: 2500, line_total: 5000 }]);
    assert.ok(orders[1].receipt_no && orders[1].pickup_zone === 'floor' && orders[1].done_by === 'Budi');
    assert.deepStrictEqual([orders[2].cancel_reason, orders[2].cancel_deposit, orders[2].cancel_approved_by], ['Tidak jadi', 'hangus', 'Bos']);
    // Pesanan batal yang selesai lebih dari 60 hari lalu tidak dikirim lagi (mother base sudah menyimpannya)
    db.run("UPDATE customer_orders SET created_at = '2020-01-01 10:00:00', done_at = '2020-01-02 10:00:00' WHERE order_no = ?", [o3.order_no]);
    fm.calls.length = 0;
    await mb.kirim();
    assert.deepStrictEqual(fm.calls[0].p.snapshot.orders.map((o) => o.order_no), [o1.order_no, o2.order_no]);
    // Pesanan belum diambil tetap dikirim walau sudah lama
    db.run("UPDATE customer_orders SET created_at = '2020-01-01 10:00:00' WHERE order_no = ?", [o1.order_no]);
    fm.calls.length = 0;
    await mb.kirim();
    assert.ok(fm.calls[0].p.snapshot.orders.some((o) => o.order_no === o1.order_no));
  });

  await t('shift yang tidak dikonfirmasi mother base tetap di antrean', async () => {
    svc.archiveShift({ closed_at: '2026-11-17 21:00:00' });
    fm.rejectShifts = true;
    await mb.kirim();
    assert.deepStrictEqual(fm.calls[fm.calls.length - 1].p.shifts[0].pembatalan, batal);
    assert.strictEqual(svc.mbStatus().pending_shifts, 1);
    fm.rejectShifts = false;
    await mb.kirim();
    assert.strictEqual(svc.mbStatus().pending_shifts, 0);
  });

  await t('banyak dokumen dikirim bertahap (batas per kiriman)', async () => {
    for (let i = 0; i < 5; i++) svc.createTransferDoc({ from_zone: 'floor', to_zone: 'warehouse', reason: `Tarik ${i}`, items: [{ sku: 'A-1', qty: 1 }] });
    const b = svc.mbBatch({ includeSnapshot: false, limits: { transfers: 2 } });
    assert.strictEqual(b.dokumen.transfers.length, 2);
    assert.strictEqual(b.more, true);
    fm.calls.length = 0;
    await mb.kirim();
    assert.strictEqual(svc.mbStatus().pending_docs.transfers, 0);
  });

  await t('database dipulihkan dari cadangan lama (id lebih kecil dari penanda): dokumen dikirim ulang', () => {
    db.tx(() => db.run("UPDATE settings SET value = '9999' WHERE key = 'mb_cursor_transfers'"));
    const b = svc.mbBatch({ includeSnapshot: false });
    assert.ok(b.dokumen.transfers.length >= 6);
  });

  await t('ganti kode toko: semua dokumen dan stok dikirim ulang ke toko baru', () => {
    svc.mbSaveConfig({ kode_toko: 'KRP' });
    assert.deepStrictEqual(svc.mbStatus().pending_docs, { receptions: 1, transfers: 6, opnames: 1 });
    svc.mbSaveConfig({ kode_toko: 'TRP' });
  });

  await t('Riwayat Shift dari sebelum ada mother base dimasukkan ke antrean sekali', () => {
    db.tx(() => {
      db.run(`INSERT INTO shift_history(shift_uid, cashier_name, shift_start, closed_at, receipts, qty, revenue, cash_sales, by_method, email_sent_at)
              VALUES('lama-1', 'Lama', '2026-11-15 08:00:00', '2026-11-15 21:00:00', 1, 2, 2000, 2000, '[]', '2026-11-15 21:00:00')`);
      db.run(`INSERT INTO shift_history_sales(shift_uid, receipt_no, sku, product_name, qty_sold, unit_price, line_total, payment_method, created_at)
              VALUES('lama-1', 'INV-L-1', 'A-1', 'Barang A', 2, 1000, 2000, 'Tunai', '2026-11-15 10:00:00'),
                    ('lama-1', 'INV-L-2', 'B-2', 'Barang B', 1, 2500, 2500, 'Tunai', '2026-11-15 11:00:00'),
                    ('lama-1', 'BTL-L-1', 'B-2', 'Barang B', -1, 2500, -2500, 'Tunai', '2026-11-15 11:05:00')`);
      db.run(`INSERT INTO receipt_voids(void_no, receipt_no, reason, requested_by, approved_by, total, created_at)
              VALUES('BTL-L-1', 'INV-L-2', 'Salah input', 'Lama', 'Bos', 2500, '2026-11-15 11:05:00')`);
    });
    assert.strictEqual(svc.mbQueueHistory(), 1);
    assert.strictEqual(svc.mbQueueHistory(), 0);
    const p = JSON.parse(db.get("SELECT payload FROM mb_outbox_shift WHERE shift_uid = 'lama-1'").payload);
    assert.deepStrictEqual([p.shift.revenue, p.sales[0].qty, p.sales[0].line_no], [2000, 2, 1]);
    assert.deepStrictEqual(p.pembatalan, [{ void_no: 'BTL-L-1', receipt_no: 'INV-L-2', reason: 'Salah input', requested_by: 'Lama', approved_by: 'Bos',
      total: 2500, created_at: '2026-11-15 11:05:00' }]);
  });

  await t('master barang: barang baru & perubahan diambil, stok tidak berubah, barcode bentrok dilewati', async () => {
    const stokA = svc.getProduct('A-1');
    fm.master = [
      { sku: 'A-1', barcode: '2000000000017', name: 'Barang A Baru', brand: 'M', category: 'K', unit_price: 1200, pack_unit: 'Coly', pack_ratio: 6, aktif: true },
      { sku: 'C-3', barcode: '2000000000031', name: 'Barang C', brand: 'M', category: 'K', unit_price: 500, pack_unit: 'Pcs', pack_ratio: 1, aktif: true },
      { sku: 'D-4', barcode: '2000000000024', name: 'Bentrok', brand: 'M', category: 'K', unit_price: 1, pack_unit: 'Pcs', pack_ratio: 1, aktif: true },
      { sku: 'E-5', barcode: '2000000000055', name: 'Nonaktif', unit_price: 1, aktif: false },
    ];
    const r = await mb.ambilMaster({ full: true });
    assert.deepStrictEqual([r.baru, r.diubah, r.sama, r.dilewati.length], [1, 1, 0, 1]);
    const a = svc.getProduct('A-1');
    assert.deepStrictEqual([a.name, a.unit_price, a.floor_stock, a.warehouse_stock, a.min_floor_alert],
      ['Barang A Baru', 1200, stokA.floor_stock, stokA.warehouse_stock, stokA.min_floor_alert]);
    assert.strictEqual(svc.getProduct('C-3').floor_stock, 0);
    assert.strictEqual(svc.getProduct('E-5'), null);
    assert.strictEqual(svc.mbMasterSince(), '2026-11-16T10:00:00Z');
    fm.calls.length = 0;
    await mb.ambilMaster();
    assert.strictEqual(fm.calls[0].p.sejak, '2026-11-16T10:00:00Z');
  });

  await t('daftar barang dikunci: tambah / ubah / hapus / import ditolak, batas minimum display tetap boleh', () => {
    svc.mbSaveConfig({ kunci_master: true });
    assert.strictEqual(svc.meta().master_locked, true);
    const a = svc.getProduct('A-1');
    throwsMsg(() => svc.saveProduct({ product: { ...a, unit_price: 1 } }), /^Daftar barang dikunci \((?!.*mother base)/);
    throwsMsg(() => svc.saveProduct({ product: { ...a, sku: 'BARU', barcode: '2000000000999' }, isNew: true }), /^Daftar barang dikunci \((?!.*mother base)/);
    throwsMsg(() => svc.deleteProduct({ sku: 'C-3' }), /^Daftar barang dikunci \((?!.*mother base)/);
    throwsMsg(() => svc.importRows([{ SKU: 'X', Barcode: '1', Nama_Barang: 'X', Harga_Jual: 1 }]), /^Daftar barang dikunci \((?!.*mother base)/);
    assert.strictEqual(svc.saveProduct({ product: { ...a, min_floor_alert: 9 } }).min_floor_alert, 9);
    svc.mbSaveConfig({ kunci_master: false });
    assert.strictEqual(svc.saveProduct({ product: { ...a, unit_price: 1300 } }).unit_price, 1300);
  });

  await t('permintaan kantor: tanpa permintaan tidak mengirim; "Tarik data terbaru" langsung mengirim; internet putus tidak melempar', async () => {
    fm.calls.length = 0;
    let r = await mb.cekPermintaan();
    assert.deepStrictEqual(fm.calls.map((c) => c.fn), ['cek_permintaan']);
    assert.strictEqual(r.minta, false);
    fm.permintaan.minta = true;
    fm.calls.length = 0;
    r = await mb.cekPermintaan();
    assert.deepStrictEqual(fm.calls.map((c) => c.fn), ['cek_permintaan', 'terima_data']);
    assert.ok(fm.calls[1].p.snapshot && fm.calls[1].p.snapshot.inventory.length, 'stok terkini ikut terkirim walau tidak berubah');
    assert.ok(r.kirim);
    fm.permintaan.minta = false;
    fm.down = true;
    r = await mb.cekPermintaan();
    fm.down = false;
    assert.match(r.error, /internet/i);
  });

  await t('stock opname dari kantor: patokan stok di file (perubahan setelahnya tetap terhitung), sekali saja, SKU tak dikenal dilewati, dilaporkan & stok dikirim', async () => {
    const awal = svc.getProduct('B-2').floor_stock;
    const docsAwal = db.get('SELECT COUNT(*) AS n FROM stock_opname_docs').n;
    // Stok per Tanggal_Stok = awal; kantor menghitung fisik awal − 3. Setelah itu toko menjual 1 sebelum opname masuk.
    db.run("UPDATE inventory SET floor_stock = floor_stock - 1 WHERE sku = 'B-2'");
    fm.permintaan.opname = [{ id: 7, no_dok: 'OPK-20261122-001', zona: 'floor', catatan: 'Hitung ulang rak', stok_per: '2026-11-22 09:00:00',
      baris: [{ sku: 'B-2', patokan: awal, fisik: awal - 3 }, { sku: 'TIDAK-ADA', patokan: 5, fisik: 4 }] }];
    fm.calls.length = 0;
    let r = await mb.cekPermintaan();
    assert.strictEqual(svc.getProduct('B-2').floor_stock, awal - 1 - 3, 'hanya selisih fisik − patokan yang diterapkan');
    const op = db.get('SELECT * FROM stock_opname_docs ORDER BY id DESC LIMIT 1');
    assert.match(op.notes, /^Opname kantor OPK-20261122-001 · Hitung ulang rak$/);
    assert.strictEqual(op.zone, 'floor');
    assert.strictEqual(op.count_at, '2026-11-22 09:00:00');
    assert.deepStrictEqual(fm.diterapkan, [{ id: 7, no_op: op.doc_no, dilewati: ['TIDAK-ADA'] }]);
    assert.deepStrictEqual(fm.calls.map((c) => c.fn), ['cek_permintaan', 'opname_diterapkan', 'terima_data']);
    assert.ok(fm.calls[2].p.dokumen.opnames.some((d) => d.doc_no === op.doc_no), 'dokumen OP langsung dikirim ke kantor');
    assert.strictEqual(r.opname[0].baru, true);

    // Kantor belum mencatat (dikirim ulang): tidak diterapkan dua kali, hanya dilaporkan lagi
    fm.ackDown = true;
    r = await mb.cekPermintaan();
    assert.match(r.laporError, /HTTP 503/);
    fm.ackDown = false;
    fm.diterapkan.length = 0;
    r = await mb.cekPermintaan();
    assert.strictEqual(svc.getProduct('B-2').floor_stock, awal - 4);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM stock_opname_docs').n, docsAwal + 1);
    assert.deepStrictEqual(fm.diterapkan, [{ id: 7, no_op: op.doc_no, dilewati: ['TIDAK-ADA'] }]);
    assert.strictEqual(r.opname[0].baru, false);

    // Semua barang tidak dikenal: tidak ada dokumen OP, tetap dilaporkan
    fm.permintaan.opname = [{ id: 8, no_dok: 'OPK-20261122-002', zona: 'warehouse', stok_per: '2026-11-22 09:00:00', baris: [{ sku: 'X-9', patokan: 1, fisik: 0 }] }];
    fm.diterapkan.length = 0;
    await mb.cekPermintaan();
    assert.deepStrictEqual(fm.diterapkan, [{ id: 8, no_op: null, dilewati: ['X-9'] }]);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM stock_opname_docs').n, docsAwal + 1);
    fm.permintaan.opname = [];
  });

  await t('tes koneksi tidak mengubah data', async () => {
    const before = svc.getProduct('A-1');
    assert.deepStrictEqual(await mb.tes(), { kode_toko: 'TRP', server_at: '2026-11-16T10:00:00Z' });
    assert.deepStrictEqual(svc.getProduct('A-1'), before);
  });

  await t('versi DEMO tidak pernah mengirim', async () => {
    const demo = createMotherbase({ svc, demo: true, fetchFn: fm.fetch });
    assert.strictEqual(await demo.tick(), null);
    await assert.rejects(demo.kirim(), /DEMO/);
  });

  await t('migrasi database lama: riwayat shift lama dianggap sudah ter-email (tidak dikirim ulang)', async () => {
    // Database versi sebelumnya: tanpa kolom email & tabel antrean mother base
    const fresh = await Database.open(null);
    fresh.db.exec(`DROP TABLE mb_outbox_shift; ALTER TABLE shift_history DROP COLUMN email_sent_at; ALTER TABLE shift_history DROP COLUMN email_error;
      INSERT INTO shift_history(shift_uid, closed_at) VALUES ('x', '2026-11-15 21:00:00');`);
    const old = fresh.db;
    const file = path.join(dir, 'lama.db');
    fs.writeFileSync(file, Buffer.from(old.export()));
    const db2 = await Database.open(file);
    assert.deepStrictEqual(db2.get("SELECT email_sent_at FROM shift_history WHERE shift_uid = 'x'"), { email_sent_at: '2026-11-15 21:00:00' });
    assert.ok(db2.get("SELECT name FROM sqlite_master WHERE name = 'mb_outbox_shift'"));
  });

  console.log(`\n${passed} tes mother base lulus.`);
})();
