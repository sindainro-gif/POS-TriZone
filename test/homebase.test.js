'use strict';
// Uji paket data & penyimpanan Homebase: node test/homebase.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Database } = require('../src/db');
const { createServices, localNow } = require('../src/services');
const { seedDemo } = require('../src/demo');
const hp = require('../src/homebase-package');
const { createOutbox } = require('../src/homebase-outbox');
const { collectLegacyShifts, MARKER } = require('../src/homebase-legacy');
const { openHomebase } = require('../src/homebase-store');
const reports = require('../src/reports');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `harus gagal dengan ${re}`);
const pack = (svc, kind, created_at, data, source = {}) => hp.makePackage({ kind, store: svc.storeInfo(), source: { app_version: 'tes', ...source }, created_at, data });
const enc = (pkg) => hp.encodePackage(pkg);
const today = localNow().slice(0, 10);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-hb-test-'));

  // Toko A: data demo lengkap (30 barang, penerimaan, mutasi, 3 akun ber-PIN) + pengaturan rahasia
  const A = createServices(await Database.open(null));
  seedDemo(A);
  A.saveSettings({ store_name: 'Toko A Pusat', smtp_host: 'smtp.contoh.id', smtp_user: 'kasir@contoh.id', smtp_pass: 'RAHASIA-SMTP', owner_email: 'owner@contoh.id' });
  // Toko B: dua barang saja
  const B = createServices(await Database.open(null));
  B.saveSettings({ store_name: 'Toko B Cabang' });
  B.importRows([
    { Barcode: '2000000000017', SKU: 'B-1', Nama_Barang: 'Barang B Satu', Harga_Jual: 1000, Stok_Awal_Toko: 3, Stok_Awal_Gudang: 10, Min_Alert_Toko: 5 },
    { Barcode: '2000000000024', SKU: 'B-2', Nama_Barang: 'Barang B Dua', Harga_Jual: 2500, Stok_Awal_Toko: 20 },
  ]);
  const hb = await openHomebase(path.join(dir, 'homebase.db'));

  await t('snapshot berisi semua data toko dan TIDAK berisi rahasia', () => {
    const d = A.homebaseSnapshotData();
    assert.strictEqual(d.products.length, A.listProducts({}).length);
    assert.strictEqual(d.inventory.length, d.products.length);
    assert.strictEqual(d.receptions.length, A.listReceptions({}).length);
    assert.strictEqual(d.transfers.length, A.listTransferDocs({}).length);
    assert.ok(d.receptions[0].items.length > 0 && d.receptions[0].items[0].line_no === 1);
    assert.ok(d.transfers[0].lines.length > 0);
    assert.strictEqual(d.users.length, 3);
    assert.deepStrictEqual(Object.keys(d.users[0]).sort(), ['active', 'created_at', 'name', 'role']);
    assert.strictEqual(d.settings.store_name, 'Toko A Pusat');
    assert.strictEqual(d.current_shift, null);
    const json = JSON.stringify(pack(A, 'snapshot', '2026-11-01 08:00:00', d));
    for (const secret of ['RAHASIA-SMTP', 'pin_hash', 'pin_salt', 'smtp', 'owner@contoh.id', 'kasir@contoh.id', 'pair_key', 'receipt_seq']) {
      assert.ok(!json.includes(secret), `"${secret}" tidak boleh ada di paket`);
    }
  });

  await t('ID toko tetap, bisa diganti; shift punya ID (shift lama dibuatkan sekali)', async () => {
    const id = A.ensureStoreId();
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(A.storeInfo().id, id);
    const C = createServices(await Database.open(null));
    const c1 = C.ensureStoreId();
    assert.notStrictEqual(C.regenerateStoreId(), c1);
    // Shift yang dibuka sebelum versi ini (tanpa shift_uid)
    const db = await Database.open(null);
    db.tx(() => db.run("INSERT INTO active_shift(id, cashier_name, shift_start) VALUES(1, 'Lama', '2026-11-01 07:00:00')"));
    const L = createServices(db);
    const uid = L.ensureShiftUid();
    assert.match(uid, /^[0-9a-f-]{36}$/);
    assert.strictEqual(L.ensureShiftUid(), uid);
    assert.strictEqual(L.getShift().shift_uid, uid);
  });

  await t('paket: encode/decode bolak-balik, nama file, dan pesan untuk file rusak / versi baru / bukan paket', () => {
    const pkg = pack(A, 'snapshot', '2026-11-01 08:00:00', A.homebaseSnapshotData());
    const name = hp.packageFileName(pkg);
    assert.match(name, hp.FILE_RE);
    assert.match(name, /_20261101-080000_snapshot\.json\.gz$/);
    const buf = enc(pkg);
    assert.deepStrictEqual(hp.decodePackage(buf), pkg);
    throwsMsg(() => hp.decodePackage(buf.subarray(0, Math.floor(buf.length / 2))), /belum selesai tersalin/);
    throwsMsg(() => hp.decodePackage(Buffer.from('bukan gzip')), /rusak/);
    throwsMsg(() => hp.decodePackage(zlib.gzipSync(Buffer.from('{"format":"lain"}'))), /Bukan paket/);
    throwsMsg(() => hp.decodePackage(zlib.gzipSync(Buffer.from(JSON.stringify({ ...pkg, version: 99 })))), /Perbarui aplikasi Homebase/);
    throwsMsg(() => hp.decodePackage(zlib.gzipSync(Buffer.from(JSON.stringify({ ...pkg, kind: 'shift', data: {} })))), /tidak lengkap/);
  });

  await t('Homebase: snapshot 2 toko tersimpan berdampingan; file sama tidak diimpor dua kali', () => {
    const a = enc(pack(A, 'snapshot', '2026-11-01 08:00:00', A.homebaseSnapshotData()));
    const b = enc(pack(B, 'snapshot', '2026-11-01 08:05:00', B.homebaseSnapshotData()));
    assert.strictEqual(hb.importBuffer(a, { file_name: 'a.json.gz' }).status, 'ok');
    assert.strictEqual(hb.importBuffer(b, { file_name: 'b.json.gz' }).status, 'ok');
    assert.strictEqual(hb.importBuffer(a, { file_name: 'a.json.gz' }).status, 'skip');
    const stores = hb.stores();
    assert.deepStrictEqual(stores.map((s) => s.store_name), ['Toko A Pusat', 'Toko B Cabang']);
    assert.strictEqual(hb.stockList({ store_id: B.storeInfo().id }).rows.length, 2);
    assert.strictEqual(hb.stockList({}).rows.length, A.listProducts({}).length + 2);
    const low = hb.stockList({ store_id: B.storeInfo().id, filter: 'low' }).rows.map((r) => r.sku);
    assert.deepStrictEqual(low, ['B-1']);
    assert.strictEqual(hb.docList({ type: 'receptions', store_id: A.storeInfo().id, from: '2000-01-01', to: '2100-01-01' }).rows.length, A.listReceptions({}).length);
  });

  let shiftUid;
  await t('paket shift: penjualan tersimpan; paket lebih baru menggantikan (tidak dobel); paket lama dilewati', () => {
    A.openShift({ cashier_name: 'Rina' });
    shiftUid = A.getShift().shift_uid;
    const [p1, p2] = A.listProducts({});
    A.checkout({ items: [{ sku: p1.sku, qty: 2 }], payment_method: 'QRIS' });
    A.checkout({ items: [{ sku: p2.sku, qty: 1 }, { sku: p1.sku, qty: 1 }], payment_method: 'Tunai', cash_received: 100000 });
    // Tutup shift pertama gagal kirim email → paket shift sebagian
    const first = pack(A, 'shift', `${today} 22:00:00`, A.homebaseShiftData({ closed_at: `${today} 22:00:00` }));
    assert.strictEqual(hb.importBuffer(enc(first)).status, 'ok');
    assert.strictEqual(hb.receiptLines({ store_id: A.storeInfo().id, shift_uid: shiftUid, receipt_no: hb.salesReport({ group: 'receipt', from: today, to: today }).rows[0].receipt_no }).length > 0, true);
    A.checkout({ items: [{ sku: p2.sku, qty: 3 }], payment_method: 'QRIS' });
    const full = A.homebaseShiftData({ closed_at: `${today} 23:00:00`, notes: 'tutup ulang' });
    assert.strictEqual(hb.importBuffer(enc(pack(A, 'shift', `${today} 23:00:00`, full))).status, 'ok');
    const sum = (s) => s.sales.reduce((n, l) => n + l.line_total, 0);
    let r = hb.salesReport({ store_id: A.storeInfo().id, from: today, to: today, group: 'day' });
    assert.strictEqual(r.totals.total, sum(full));
    assert.strictEqual(r.totals.receipts, 3);
    // Paket pertama dikirim ulang (lewat email, isi sama tapi paket baru) → lebih lama → dilewati
    const again = hb.importBuffer(enc(pack(A, 'shift', `${today} 22:00:00`, first.data)));
    assert.strictEqual(again.status, 'old');
    r = hb.salesReport({ store_id: A.storeInfo().id, from: today, to: today, group: 'shift' });
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].revenue, sum(full));
    assert.strictEqual(r.rows[0].closed_at, `${today} 23:00:00`);
    assert.strictEqual(r.rows[0].notes, 'tutup ulang');
    assert.strictEqual(hb.shiftDetail({ store_id: A.storeInfo().id, shift_uid: shiftUid }).items.length, 2);
    A.archiveShift();
  });

  await t('shift berjalan di snapshot tampil di Homebase, lalu ditutup oleh paket shift; snapshot lama tidak membukanya lagi', () => {
    A.openShift({ cashier_name: 'Budi' });
    const uid = A.getShift().shift_uid;
    A.checkout({ items: [{ sku: A.listProducts({})[0].sku, qty: 1 }], payment_method: 'Tunai', cash_received: 50000 });
    const snapOpen = pack(A, 'snapshot', '2026-11-02 10:00:00', A.homebaseSnapshotData());
    assert.strictEqual(snapOpen.data.current_shift.shift_uid, uid);
    hb.importBuffer(enc(snapOpen));
    const sid = A.storeInfo().id;
    let sh = hb.shiftDetail({ store_id: sid, shift_uid: uid }).shift;
    assert.strictEqual(sh.closed_at, null);
    assert.strictEqual(sh.receipts, 1);
    assert.strictEqual(hb.dashboard({ store_id: sid }).stores[0].open_shifts, 1);
    hb.importBuffer(enc(pack(A, 'shift', '2026-11-02 12:00:00', A.homebaseShiftData({ closed_at: '2026-11-02 12:00:00' }))));
    sh = hb.shiftDetail({ store_id: sid, shift_uid: uid }).shift;
    assert.strictEqual(sh.closed_at, '2026-11-02 12:00:00');
    // Snapshot 10:00 dikirim ulang (mis. lewat email) setelah paket tutup shift 12:00: shift tetap tertutup
    assert.strictEqual(hb.importBuffer(enc(pack(A, 'snapshot', '2026-11-02 10:00:00', snapOpen.data))).status, 'ok');
    assert.strictEqual(hb.shiftDetail({ store_id: sid, shift_uid: uid }).shift.closed_at, '2026-11-02 12:00:00');
    assert.strictEqual(hb.dashboard({ store_id: sid }).stores[0].open_shifts, 0);
    A.archiveShift();
  });

  await t('snapshot yang lebih lama tidak memundurkan stok, tetapi riwayatnya tetap ditambahkan', () => {
    const sid = A.storeInfo().id;
    const p = A.listProducts({}).find((x) => x.warehouse_stock >= 5);
    const oldSnap = pack(A, 'snapshot', '2026-11-03 08:00:00', A.homebaseSnapshotData());
    A.createTransfer({ sku: p.sku, from_zone: 'warehouse', to_zone: 'shopee', qty: 5, reason: 'isi Shopee' });
    const newSnap = pack(A, 'snapshot', '2026-11-03 09:00:00', A.homebaseSnapshotData());
    assert.strictEqual(hb.importBuffer(enc(newSnap)).status, 'ok');
    assert.strictEqual(hb.importBuffer(enc(oldSnap)).status, 'old');
    const row = hb.stockList({ store_id: sid, q: p.sku }).rows.find((r) => r.sku === p.sku);
    assert.strictEqual(row.shopee_stock, A.getProduct(p.sku).shopee_stock);
    assert.strictEqual(row.as_of, '2026-11-03 09:00:00');
    const docs = hb.docList({ type: 'transfers', store_id: sid, from: '2000-01-01', to: '2100-01-01' }).rows;
    assert.strictEqual(docs.length, A.listTransferDocs({}).length);
    const d = hb.docDetail({ type: 'transfers', store_id: sid, key: docs.find((x) => x.to_zone === 'shopee').doc_no });
    assert.strictEqual(d.to_zone, 'shopee');
    assert.strictEqual(d.items[0].name, p.name);
  });

  await t('folder masuk: file setengah tersalin error lalu sukses setelah lengkap; paket DEMO ditolak', () => {
    const inbox = path.join(dir, 'inbox');
    fs.mkdirSync(path.join(inbox, 'toko-b'), { recursive: true });
    const pkg = pack(B, 'snapshot', '2026-11-04 08:00:00', B.homebaseSnapshotData());
    const full = enc(pkg);
    const file = path.join(inbox, 'toko-b', hp.packageFileName(pkg));
    fs.writeFileSync(file, full.subarray(0, 20));
    let r = hb.scanFolder(inbox);
    assert.strictEqual(r.errors, 1);
    assert.match(r.results[0].message, /belum selesai tersalin/);
    assert.strictEqual(hb.scanFolder(inbox).results.length, 0); // belum berubah → tidak dibaca lagi
    assert.ok(hb.importsList().unresolved >= 1);
    fs.writeFileSync(file, full);
    const t0 = Date.now() / 1000 + 5;
    fs.utimesSync(file, t0, t0);
    r = hb.scanFolder(inbox);
    assert.strictEqual(r.imported, 1);
    assert.strictEqual(hb.importsList().unresolved, 0);
    const demo = pack(B, 'snapshot', '2026-11-04 09:00:00', B.homebaseSnapshotData(), { demo: true });
    const res = hb.importBuffer(enc(demo), { file_name: hp.packageFileName(demo) });
    assert.strictEqual(res.status, 'error');
    assert.match(res.message, /DEMO/);
  });

  await t('riwayat lama: CSV bolak-balik; struk di beberapa folder dihitung sekali; folder bertanda dilewati', () => {
    const line = (receipt_no, created_at, total, extra = {}) => ({
      receipt_no, created_at, sku: 'MNM-001', product_name: 'Air "Segar"; 600ml', qty_sold: 1, unit_price: total, line_total: total, payment_method: 'Tunai', ...extra,
    });
    const back = reports.parseSalesCsv(reports.salesCsv([line('INV-1', '2026-10-01 09:00:00', 3500)]));
    assert.deepStrictEqual(back, [{ receipt_no: 'INV-1', created_at: '2026-10-01 09:00:00', sku: 'MNM-001', product_name: 'Air "Segar"; 600ml', qty: 1, unit_price: 3500, line_total: 3500, payment_method: 'Tunai' }]);
    const rep = path.join(dir, 'POS-Laporan');
    const put = (folder, rows, marked) => {
      fs.mkdirSync(path.join(rep, folder), { recursive: true });
      fs.writeFileSync(path.join(rep, folder, `Penjualan_${folder}.csv`), reports.salesCsv(rows));
      if (marked) fs.writeFileSync(path.join(rep, folder, MARKER), '{}');
    };
    const r1 = line('INV-20261001-0001', '2026-10-01 09:00:00', 1000);
    const r2 = line('INV-20261001-0002', '2026-10-01 10:00:00', 2000, { payment_method: 'QRIS' });
    const r3 = line('INV-20261001-0003', '2026-10-01 11:00:00', 3000);
    const r4 = line('INV-20261002-0001', '2026-10-02 09:00:00', 4000);
    put('Shift_20261001_200000', [r1, r2]); // email gagal → data shift tidak dihapus
    put('Shift_20261001_220000', [r1, r2, r3]); // tutup ulang berhasil
    put('Shift_20261002_180000', [r4]); // gagal, lalu ditutup ulang oleh versi baru (bertanda)
    put('Shift_20261002_200000', [r4], true);
    fs.mkdirSync(path.join(rep, 'Folder Lain'));
    const out = collectLegacyShifts(rep, { storeId: A.storeInfo().id });
    assert.strictEqual(out.scanned, 4);
    assert.strictEqual(out.covered, 1);
    assert.strictEqual(out.shifts.length, 1);
    const s = out.shifts[0];
    assert.strictEqual(s.folder, 'Shift_20261001_220000');
    assert.deepStrictEqual([s.shift.receipts, s.shift.revenue, s.shift.cash_sales], [3, 6000, 4000]);
    assert.strictEqual(s.shift.closed_at, '2026-10-01 22:00:00');
    assert.strictEqual(s.shift.shift_start, '2026-10-01 09:00:00');
    assert.strictEqual(collectLegacyShifts(rep, { storeId: A.storeInfo().id }).shifts[0].shift.shift_uid, s.shift.shift_uid);
    // Diimpor dua kali (tombol ditekan ulang) → tetap satu shift
    for (const at of ['2026-11-05 08:00:00', '2026-11-05 09:00:00']) {
      const pkg = pack(A, 'shift', at, { shift: s.shift, sales: s.sales }, { legacy: true });
      assert.match(hp.packageFileName(pkg), hp.FILE_RE);
      assert.strictEqual(hb.importBuffer(enc(pkg)).status, 'ok');
    }
    const rows = hb.salesReport({ store_id: A.storeInfo().id, from: '2026-10-01', to: '2026-10-31', group: 'shift' }).rows;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].legacy, 1);
    assert.strictEqual(hb.salesReport({ store_id: A.storeInfo().id, from: '2026-10-01', to: '2026-10-31' }).totals.total, 6000);
  });

  await t('outbox: tulis lokal, salin ke folder sinkron, pangkas snapshot lama, folder hilang lalu dicoba ulang', async () => {
    const out = path.join(dir, 'paket');
    const sync = path.join(dir, 'gdrive');
    const ob = createOutbox(out, { stateFile: path.join(dir, 'hb-status.json'), keepSnapshots: 3 });
    for (let i = 1; i <= 5; i++) ob.write(pack(B, 'snapshot', `2026-11-06 0${i}:00:00`, B.homebaseSnapshotData()), { hash: `h${i}` });
    B.openShift({ cashier_name: 'Sari' });
    B.checkout({ items: [{ sku: 'B-1', qty: 1 }], payment_method: 'QRIS' });
    ob.write(pack(B, 'shift', '2026-11-06 06:00:00', B.homebaseShiftData({ closed_at: '2026-11-06 06:00:00' })));
    B.archiveShift();
    assert.strictEqual(ob.files().length, 4); // 3 snapshot terakhir + 1 shift
    assert.strictEqual(ob.lastSnapshotHash(), 'h5');
    let r = await ob.syncTo(sync);
    assert.match(r.error, /tidak bisa dibuka/);
    assert.strictEqual(r.pending, 2); // shift + snapshot terbaru (snapshot lama tidak perlu dikirim)
    fs.mkdirSync(sync);
    r = await ob.syncTo(sync);
    assert.deepStrictEqual([r.copied, r.pending, r.error], [2, 0, '']);
    assert.strictEqual(fs.readdirSync(sync).filter((n) => /snapshot/.test(n)).length, 1);
    ob.write(pack(B, 'snapshot', '2026-11-06 07:00:00', B.homebaseSnapshotData()));
    assert.strictEqual(ob.status(sync).pending, 1);
    r = await ob.syncTo(sync);
    assert.deepStrictEqual([r.copied, r.removed], [1, 1]);
    const left = fs.readdirSync(sync).sort();
    assert.strictEqual(left.length, 2);
    assert.ok(left.some((n) => /07000+_snapshot/.test(n.replace('-', ''))));
    assert.strictEqual(ob.status(sync).pending, 0);
    // Folder sinkron dibaca Homebase: kedua paket masuk
    const res = hb.scanFolder(sync);
    assert.strictEqual(res.errors, 0);
    // Outbox baru (aplikasi dibuka ulang) mengingat yang sudah terkirim
    const ob2 = createOutbox(out, { stateFile: path.join(dir, 'hb-status.json') });
    assert.strictEqual(ob2.status(sync).pending, 0);
  });

  await t('ringkasan, ekspor Excel, hapus data toko, PIN, dan homebase.db terbaca ulang', async () => {
    const dash = hb.dashboard({});
    assert.strictEqual(dash.stores.length, 2);
    assert.strictEqual(dash.totals.stores, 2);
    const sheets = hb.exportSheets({ kind: 'all', from: '2026-10-01', to: today });
    const names = sheets.map((s) => s.name);
    for (const n of ['Toko', 'Per Hari', 'Per Shift', 'Detail Penjualan', 'Stok', 'Barang', 'Penerimaan', 'Mutasi_Detail', 'Opname', 'Transaksi_Darurat']) {
      assert.ok(names.includes(n), `lembar ${n}`);
    }
    for (const s of sheets) assert.ok(s.rows.every((r) => r.length === s.headers.length), `kolom lembar ${s.name}`);
    assert.ok(sheets.find((s) => s.name === 'Detail Penjualan').rows.length >= 5);
    assert.strictEqual(hb.exportSheets({ kind: 'sales', group: 'item', from: today, to: today })[0].name, 'Per Barang');
    assert.strictEqual(hb.exportSheets({ kind: 'docs', type: 'transfers', from: '2000-01-01', to: '2100-01-01' })[1].name, 'Mutasi_Detail');

    const sidB = B.storeInfo().id;
    hb.deleteStore({ store_id: sidB });
    assert.deepStrictEqual(hb.stores().map((s) => s.store_name), ['Toko A Pusat']);
    assert.strictEqual(hb.stockList({ store_id: sidB }).rows.length, 0);

    hb.setPin('123456');
    assert.ok(hb.hasPin());
    assert.ok(hb.verifyPin('123456'));
    assert.ok(!hb.verifyPin('654321'));
    throwsMsg(() => hb.setPin('12'), /6 digit/);
    hb.setPin('');
    assert.ok(!hb.hasPin());

    const again = await openHomebase(path.join(dir, 'homebase.db'));
    assert.strictEqual(again.stores().length, 1);
    assert.ok(again.salesReport({ from: '2026-10-01', to: today }).totals.total > 0);
  });

  console.log(`\n${passed} tes homebase lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
  fs.rmSync(dir, { recursive: true, force: true });
})();
