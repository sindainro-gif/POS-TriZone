'use strict';
// Uji mode darurat PC Kasir (cache barang, antrian transaksi, sinkron ke PC Gudang): node test/offline.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { startServer, createRemoteClient, newPairKey } = require('../src/remote');
const { createOfflineStore, QUEUE_FILE } = require('../src/offline');
const { buildReceiptLines } = require('../src/receipt');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

(async () => {
  const gudang = createServices(await Database.open(null));
  const key = newPairKey();
  let server;
  let port = 0;
  const start = async () => {
    server = await startServer({ port, host: '127.0.0.1', getKey: () => key, call: (m, args) => gudang[m](...args) });
    port = server.address().port;
  };
  const stop = () => new Promise((r) => server.close(r));
  await start();
  const kasir = createRemoteClient({ host: '127.0.0.1', port, key, timeout: 3000 });
  const svc = kasir.services;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-offline-'));
  let clock = '2026-10-15 09:00:00';
  const store = createOfflineStore(dir, { now: () => clock });

  gudang.importRows([
    { Barcode: '4006381333931', SKU: 'A-1', Nama_Barang: 'Barang A', Harga_Jual: 5000, Stok_Awal_Toko: 10, Stok_Awal_Gudang: 50 },
    { Barcode: '8991234567890', SKU: 'B-2', Nama_Barang: 'Barang B', Harga_Jual: 2000, Stok_Awal_Toko: 2, Stok_Awal_BS: 9 },
  ]);

  await t('tanpa cache: mode darurat belum siap', () => {
    assert.strictEqual(store.hasCache(), false);
    assert.strictEqual(store.summary().ready, false);
    assert.throws(() => store.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS' }), /belum pernah diunduh/);
  });

  await t('cache tanpa shift aktif: transaksi darurat ditolak', async () => {
    await store.refresh(svc);
    assert.strictEqual(store.summary().products, 2);
    assert.throws(() => store.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS' }), /shift belum dibuka/);
  });

  await t('cache: scan barcode / SKU / cari nama tanpa PC gudang', async () => {
    await svc.openShift({ cashier_name: 'Rina', initial_cash: 0 });
    await store.refresh(svc);
    await stop();
    assert.strictEqual(store.findByCode({ code: '4006381333931' }).sku, 'A-1');
    assert.strictEqual(store.findByCode({ code: 'b-2' }).name, 'Barang B');
    assert.strictEqual(store.findByCode({ code: '000' }), null);
    assert.deepStrictEqual(store.searchProducts({ q: 'barang' }).map((p) => p.sku), ['A-1', 'B-2']);
    assert.strictEqual(store.getShift().cashier_name, 'Rina');
    assert.strictEqual(store.summary().ready, true);
  });

  let first;
  await t('transaksi darurat: nomor OFF-, tersimpan di disk, stok tampilan berkurang', () => {
    first = store.checkout({ items: [{ sku: 'A-1', qty: 2 }, { sku: 'A-1', qty: 1 }], payment_method: 'Tunai', cash_received: 20000 });
    assert.match(first.receipt_no, /^OFF-20261015-[0-9A-F]{4}-0001$/);
    assert.strictEqual(first.total, 15000);
    assert.strictEqual(first.change, 5000);
    assert.strictEqual(first.cashier, 'Rina');
    assert.strictEqual(first.offline, true);
    assert.strictEqual(store.findByCode({ code: '4006381333931' }).floor_stock, 7);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8'));
    assert.strictEqual(onDisk.sales.length, 1);
    assert.strictEqual(onDisk.sales[0].status, 'pending');
  });

  await t('validasi transaksi darurat: uang kurang, SKU tak dikenal, metode salah', () => {
    assert.throws(() => store.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'Tunai', cash_received: 100 }), /kurang/);
    assert.throws(() => store.checkout({ items: [{ sku: 'ZZZ', qty: 1 }], payment_method: 'QRIS' }), /tidak ada di data darurat/);
    assert.throws(() => store.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'Bitcoin' }), /tidak dikenal/);
    assert.throws(() => store.checkout({ items: [{ sku: 'A-1', qty: 0 }], payment_method: 'QRIS' }), /minimal 1/);
    assert.strictEqual(store.pending().length, 1);
  });

  let second;
  await t('stok cache kurang: tetap boleh dijual, diberi peringatan', () => {
    second = store.checkout({ items: [{ sku: 'B-2', qty: 5 }], payment_method: 'QRIS' });
    assert.match(second.receipt_no, /-0002$/);
    assert.strictEqual(second.warnings.length, 1);
    assert.match(second.warnings[0], /Barang B: stok toko terakhir 2, dijual 5/);
  });

  await t('nota darurat diberi tanda MODE DARURAT', () => {
    const lines = buildReceiptLines(first, { store_name: 'Toko' });
    assert.ok(lines.some((l) => l.includes('** MODE DARURAT **')));
    assert.ok(!buildReceiptLines({ ...first, receipt_no: 'INV-20261015-0001' }, {}).some((l) => l.includes('DARURAT')));
  });

  await t('antrian bertahan setelah aplikasi kasir dibuka ulang (nomor lanjut)', () => {
    const again = createOfflineStore(dir, { now: () => clock });
    assert.strictEqual(again.pending().length, 2);
    assert.strictEqual(again.findByCode({ code: '8991234567890' }).floor_stock, -3);
  });

  await t('gudang masih mati: sinkron berhenti, antrian utuh', async () => {
    const r = await store.sync(svc);
    assert.match(r.stopped, /Tidak terhubung/);
    assert.strictEqual(r.sent, 0);
    assert.strictEqual(store.pending().length, 2);
    assert.match(store.summary().errors[0].error, /Tidak terhubung/);
  });

  await t('koneksi kembali: antrian terkirim berurutan, stok minus ditandai perlu dicek', async () => {
    await start();
    const r = await store.sync(svc);
    assert.strictEqual(r.stopped, '');
    assert.strictEqual(r.sent, 2);
    assert.strictEqual(store.pending().length, 0);
    const rows = gudang.shiftSalesRows();
    assert.deepStrictEqual(rows.map((x) => x.receipt_no), [first.receipt_no, second.receipt_no]);
    assert.strictEqual(rows[0].created_at, '2026-10-15 09:00:00'); // waktu jual asli
    assert.strictEqual(gudang.getProduct('A-1').floor_stock, 7);
    const b = gudang.getProduct('B-2');
    assert.strictEqual(b.floor_stock, -3); // barang sudah keluar fisik → stok toko minus
    assert.strictEqual(b.damaged_stock, 9); // Gudang BS tidak tersentuh
    assert.deepStrictEqual(r.checks.map((c) => c.receipt_no), [second.receipt_no]);
    const checks = gudang.offlineChecks();
    assert.strictEqual(checks.length, 1);
    assert.match(checks[0].notes[0], /stok toko 2, terjual 5 → stok toko -3/);
    const sum = gudang.shiftSummary();
    assert.strictEqual(sum.offline.receipts, 2);
    assert.strictEqual(sum.totals.revenue, 25000);
  });

  await t('penjualan online tetap boleh walau stok toko sudah minus', async () => {
    const r = await svc.checkout({ items: [{ sku: 'B-2', qty: 1 }], payment_method: 'QRIS' });
    assert.deepStrictEqual(r.short.map((s) => [s.sku, s.floor_stock]), [['B-2', -4]]);
    assert.strictEqual(gudang.lowStock({})[0].sku, 'B-2'); // paling atas di Saran Restock
  });

  await t('kirim ulang transaksi yang sama tidak dicatat dua kali', async () => {
    const r = await svc.importOfflineSale({ receipt_no: first.receipt_no, payment_method: 'Tunai', lines: [{ sku: 'A-1', qty: 3, unit_price: 5000 }] });
    assert.strictEqual(r.status, 'duplicate');
    assert.strictEqual(gudang.getProduct('A-1').floor_stock, 7);
    assert.strictEqual(gudang.shiftSalesRows().length, 3); // 2 darurat + 1 online B-2
  });

  await t('sudah masuk online (balasan hilang) → antrian darurat tidak menggandakan', async () => {
    const ref = 'ref-uji-123';
    const online = await svc.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS', client_ref: ref });
    await assert.rejects(svc.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS', client_ref: ref }), /sudah tercatat/);
    store.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS', client_ref: ref });
    const r = await store.sync(svc);
    assert.strictEqual(r.duplicates, 1);
    assert.strictEqual(gudang.getProduct('A-1').floor_stock, 6);
    assert.strictEqual(gudang.shiftSalesRows().filter((x) => /^OFF-/.test(x.receipt_no)).length, 2);
    const entry = JSON.parse(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8')).sales.pop();
    assert.strictEqual(entry.online_receipt, online.receipt_no);
  });

  await t('ditolak gudang (data rusak): tetap di antrian, transaksi berikutnya tetap terkirim', async () => {
    const q = JSON.parse(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8'));
    q.sales.push({ receipt_no: 'OFF-RUSAK', status: 'pending', payment_method: 'Cek', total: 0, lines: [{ sku: 'A-1', qty: 1, unit_price: 1 }] });
    fs.writeFileSync(path.join(dir, QUEUE_FILE), JSON.stringify(q));
    const s2 = createOfflineStore(dir, { now: () => clock });
    s2.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS' });
    const r = await s2.sync(svc);
    assert.strictEqual(r.sent, 1);
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0].error, /Metode pembayaran tidak dikenal/);
    assert.deepStrictEqual(s2.pending().map((s) => s.receipt_no), ['OFF-RUSAK']);
  });

  await t('nomor struk darurat mulai dari 0001 lagi di hari berikutnya', () => {
    clock = '2026-10-16 08:00:00';
    const r = store.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'QRIS' });
    assert.match(r.receipt_no, /^OFF-20261016-[0-9A-F]{4}-0001$/);
  });

  await t('tanda perlu dicek bisa diselesaikan', async () => {
    await svc.markOfflineChecked({ receipt_no: second.receipt_no });
    assert.strictEqual(gudang.offlineChecks().length, 0);
    await assert.rejects(svc.markOfflineChecked({ receipt_no: second.receipt_no }), /sudah ditandai/);
  });

  await t('setelah tutup shift, kiriman ulang tetap terdeteksi & dicatat ke shift berikutnya', async () => {
    gudang.purgeShift();
    const again = await svc.importOfflineSale({ receipt_no: first.receipt_no, payment_method: 'Tunai', lines: [{ sku: 'A-1', qty: 3, unit_price: 5000 }] });
    assert.strictEqual(again.status, 'duplicate');
    const late = await svc.importOfflineSale({ receipt_no: 'OFF-20261016-AAAA-0009', payment_method: 'QRIS', created_at: '2026-10-16 08:05:00', lines: [{ sku: 'A-1', qty: 1, unit_price: 5000 }] });
    assert.strictEqual(late.status, 'check');
    assert.match(late.notes.join(' '), /tidak ada shift aktif/);
  });

  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} tes mode darurat lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
