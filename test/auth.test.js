'use strict';
// Uji akun login & hak akses (Admin / Gudang / Kasir): node test/auth.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { startServer, createRemoteClient, newPairKey } = require('../src/remote');
const { createOfflineStore } = require('../src/offline');
const { hashPin, checkPin } = require('../src/auth');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

(async () => {
  const gudang = createServices(await Database.open(null));

  await t('hash PIN: benar cocok, salah tidak, salt berbeda tiap akun', () => {
    const a = hashPin('123456');
    const b = hashPin('123456');
    assert.notStrictEqual(a.hash, b.hash);
    assert.ok(checkPin('123456', a.salt, a.hash));
    assert.ok(!checkPin('654321', a.salt, a.hash));
    assert.ok(!checkPin('123456', '', ''));
  });

  await t('database baru: perlu buat akun, akun pertama wajib Admin', () => {
    assert.strictEqual(gudang.needsSetup(), true);
    assert.throws(() => gudang.saveUser({ name: 'Rina', role: 'kasir', pin: '111111' }), /Akun pertama harus Admin/);
    gudang.saveUser({ name: 'Pemilik', role: 'admin', pin: '123456' });
    assert.strictEqual(gudang.needsSetup(), false);
  });

  await t('validasi: PIN 6 digit, peran dikenal, nama unik (tanpa beda huruf besar)', () => {
    assert.throws(() => gudang.saveUser({ name: 'Rina', role: 'kasir', pin: '12345' }), /6 digit/);
    assert.throws(() => gudang.saveUser({ name: 'Rina', role: 'kasir', pin: '12a456' }), /6 digit/);
    assert.throws(() => gudang.saveUser({ name: 'Rina', role: 'bos', pin: '111111' }), /Peran/);
    gudang.saveUser({ name: 'Rina', role: 'kasir', pin: '111111' });
    gudang.saveUser({ name: 'Budi', role: 'gudang', pin: '222222' });
    assert.throws(() => gudang.saveUser({ name: 'rina', role: 'gudang', pin: '333333' }), /sudah dipakai/);
  });

  await t('daftar akun tidak memuat hash PIN', () => {
    const list = gudang.listUsers();
    assert.deepStrictEqual(list.map((u) => u.name), ['Pemilik', 'Budi', 'Rina']);
    for (const u of list) { assert.ok(!('pin_hash' in u)); assert.ok(!('pin_salt' in u)); }
  });

  await t('login: nama tidak peka huruf besar, PIN salah / akun nonaktif ditolak', () => {
    assert.deepStrictEqual(gudang.verifyLogin({ name: ' rina ', pin: '111111' }).role, 'kasir');
    assert.throws(() => gudang.verifyLogin({ name: 'Rina', pin: '000000' }), /Nama atau PIN salah/);
    assert.throws(() => gudang.verifyLogin({ name: 'Siapa', pin: '111111' }), /Nama atau PIN salah/);
    const budi = gudang.listUsers().find((u) => u.name === 'Budi');
    gudang.saveUser({ id: budi.id, name: 'Budi', role: 'gudang', active: false });
    assert.throws(() => gudang.verifyLogin({ name: 'Budi', pin: '222222' }), /Nama atau PIN salah/);
    gudang.saveUser({ id: budi.id, name: 'Budi', role: 'gudang', active: true });
  });

  await t('ubah akun tanpa PIN mempertahankan PIN lama; PIN baru berlaku', () => {
    const rina = gudang.listUsers().find((u) => u.name === 'Rina');
    gudang.saveUser({ id: rina.id, name: 'Rina Kasir', role: 'kasir', pin: '' });
    assert.strictEqual(gudang.verifyLogin({ name: 'Rina Kasir', pin: '111111' }).name, 'Rina Kasir');
    gudang.saveUser({ id: rina.id, name: 'Rina', role: 'kasir', pin: '444444' });
    assert.throws(() => gudang.verifyLogin({ name: 'Rina', pin: '111111' }));
    assert.ok(gudang.verifyLogin({ name: 'Rina', pin: '444444' }));
  });

  await t('Admin aktif terakhir tidak bisa dihapus, dinonaktifkan, atau diturunkan', () => {
    const admin = gudang.listUsers().find((u) => u.role === 'admin');
    assert.throws(() => gudang.deleteUser({ id: admin.id }), /minimal satu Admin/);
    assert.throws(() => gudang.saveUser({ id: admin.id, name: admin.name, role: 'kasir' }), /minimal satu Admin/);
    assert.throws(() => gudang.saveUser({ id: admin.id, name: admin.name, role: 'admin', active: false }), /minimal satu Admin/);
    gudang.saveUser({ name: 'Wakil', role: 'admin', pin: '555555' });
    gudang.deleteUser({ id: admin.id });
    assert.strictEqual(gudang.listUsers().filter((u) => u.role === 'admin').length, 1);
  });

  // PC kasir: login lewat jaringan, dan login darurat dari cache saat PC gudang mati
  const key = newPairKey();
  const server = await startServer({ port: 0, host: '127.0.0.1', getKey: () => key, call: (m, args) => gudang[m](...args) });
  const kasir = createRemoteClient({ host: '127.0.0.1', port: server.address().port, key, timeout: 3000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-auth-'));
  const store = createOfflineStore(dir);

  await t('PC kasir login lewat jaringan', async () => {
    const u = await kasir.services.verifyLogin({ name: 'Rina', pin: '444444' });
    assert.deepStrictEqual(u.role, 'kasir');
    await assert.rejects(kasir.services.verifyLogin({ name: 'Rina', pin: '000000' }), /Nama atau PIN salah/);
  });

  await t('login darurat belum siap sebelum data akun diunduh', () => {
    assert.throws(() => store.verifyLogin({ name: 'Rina', pin: '444444' }), /belum siap/);
  });

  await t('PC gudang mati: login darurat memakai cache akun (hash, bukan PIN asli)', async () => {
    await store.refresh(kasir.services);
    await new Promise((r) => server.close(r));
    await assert.rejects(kasir.services.verifyLogin({ name: 'Rina', pin: '444444' }), /Tidak terhubung/);
    assert.strictEqual(store.verifyLogin({ name: 'rina', pin: '444444' }).role, 'kasir');
    assert.throws(() => store.verifyLogin({ name: 'Rina', pin: '111111' }), /Nama atau PIN salah/);
    const raw = fs.readFileSync(path.join(dir, 'offline-cache.json'), 'utf8');
    assert.ok(!raw.includes('444444'));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} tes login lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
