'use strict';
// Uji jaringan PC Gudang (server) ↔ PC Kasir (klien): node test/remote.test.js
const assert = require('assert');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { startServer, createRemoteClient, newPairKey } = require('../src/remote');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const gudang = createServices(await Database.open(null));
  const key = newPairKey();
  const blocked = new Set(['getSettingsRaw', 'purgeShift']);
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    getKey: () => key,
    call: (m, args) => {
      if (blocked.has(m) || typeof gudang[m] !== 'function') { const e = new Error(`Perintah tidak dikenal: ${m}`); e.userFacing = true; throw e; }
      return gudang[m](...args);
    },
    info: () => ({ store_name: 'Toko Uji' }),
  });
  const port = server.address().port;
  const kasir = createRemoteClient({ host: '127.0.0.1', port, key });
  const svc = kasir.services;

  await t('kode pasangan 6 digit', () => assert.match(newPairKey(), /^\d{6}$/));

  await t('ping mengembalikan nama toko', async () => {
    const p = await kasir.ping();
    assert.strictEqual(p.store_name, 'Toko Uji');
  });

  await t('gudang input barang → kasir melihat stok yang sama', async () => {
    gudang.importRows([{ Barcode: '4006381333931', SKU: 'A-1', Nama_Barang: 'Barang A', Harga_Jual: 5000, Stok_Awal_Gudang: 50 }]);
    gudang.createTransfer({ sku: 'A-1', from_zone: 'warehouse', to_zone: 'floor', qty: 10 });
    const p = await svc.findByCode({ code: '4006381333931' });
    assert.strictEqual(p.floor_stock, 10);
    assert.strictEqual(p.warehouse_stock, 40);
  });

  await t('kasir jual → stok di gudang langsung berkurang', async () => {
    await svc.openShift({ cashier_name: 'Rina', initial_cash: 0 });
    const r = await svc.checkout({ items: [{ sku: 'A-1', qty: 3 }], payment_method: 'QRIS' });
    assert.strictEqual(r.total, 15000);
    assert.strictEqual(gudang.getProduct('A-1').floor_stock, 7);
  });

  await t('error bisnis dari server diteruskan apa adanya', async () => {
    await assert.rejects(svc.checkout({ items: [{ sku: 'A-1', qty: 1 }], payment_method: 'Bitcoin' }), /Metode pembayaran tidak dikenal/);
    await assert.rejects(svc.checkout({ items: [{ sku: 'TIDAK-ADA', qty: 1 }], payment_method: 'QRIS' }), /tidak ditemukan/);
  });

  await t('perintah terlarang & tidak dikenal ditolak', async () => {
    await assert.rejects(svc.getSettingsRaw(), /tidak dikenal/);
    await assert.rejects(svc.purgeShift(), /tidak dikenal/);
    await assert.rejects(kasir.rpc('hapusSemua', []), /tidak dikenal/);
    assert.strictEqual(gudang.shiftSalesRows().length, 1);
  });

  await t('kode pasangan salah ditolak', async () => {
    const salah = createRemoteClient({ host: '127.0.0.1', port, key: '000000' === key ? '111111' : '000000' });
    await assert.rejects(salah.services.listProducts({}), /Kode pasangan salah/);
  });

  await t('svc proxy tidak dianggap Promise', async () => {
    const same = await Promise.resolve(svc);
    assert.strictEqual(same, svc);
  });

  await t('server mati → pesan "Tidak terhubung"', async () => {
    await new Promise((r) => server.close(r));
    await assert.rejects(svc.listProducts({}), /Tidak terhubung ke komputer gudang/);
    await assert.rejects(kasir.ping(), /Tidak terhubung/);
  });

  console.log(`\n${passed} tes jaringan lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
