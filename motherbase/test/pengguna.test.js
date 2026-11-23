'use strict';
// Uji logika Edge Function `pengguna` dengan admin & database tiruan: node motherbase/test/pengguna.test.js
const assert = require('assert');
const path = require('path');

let lulus = 0;
async function t(nama, fn) {
  try { await fn(); lulus++; console.log('  ✓', nama); } catch (e) { console.error('  ✗', nama, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

(async () => {
  const { kelolaPengguna } = await import(path.join(__dirname, '../supabase/functions/pengguna/pengguna.mjs'));

  // Tiruan: akun Supabase Auth (admin) dan RPC database dengan aturan yang sama seperti migrasi
  function dunia({ peran = 'owner', aturGagal = null } = {}) {
    const w = { akun: new Map([['owner@x.id', { id: 'u-owner', sandi: 'lama' }]]), pengguna: new Map([['owner@x.id', { peran: 'owner', wajib: false }]]), log: [] };
    let n = 0;
    w.admin = {
      createUser: async ({ email, password }) => {
        w.log.push(['createUser', email]);
        if (w.akun.has(email)) throw new Error('A user with this email address has already been registered');
        const id = `u-${++n}`;
        w.akun.set(email, { id, sandi: password });
        return id;
      },
      updateUserById: async (id, { password }) => {
        w.log.push(['updateUserById', id]);
        for (const a of w.akun.values()) if (a.id === id) a.sandi = password;
      },
      deleteUser: async (id) => {
        w.log.push(['deleteUser', id]);
        for (const [e, a] of w.akun) if (a.id === id) w.akun.delete(e);
      },
    };
    w.db = {
      rpc: async (fn, a = {}) => {
        w.log.push([fn]);
        if (fn === 'saya') return { email: 'owner@x.id', peran, aktif: true };
        if (fn === 'daftar_pengguna') return [...w.pengguna].map(([email, p]) => ({ id: w.akun.get(email).id, email, ...p }));
        if (fn === 'atur_pengguna') {
          if (aturGagal) throw new Error(aturGagal);
          if (!w.akun.has(a.p_email)) throw new Error('Akun belum ada');
          w.pengguna.set(a.p_email, { nama: a.p_nama, peran: a.p_peran, kode_toko: a.p_kode_toko, wajib: false });
          return {};
        }
        if (fn === 'wajibkan_ganti_sandi') { w.pengguna.get(a.p_email).wajib = true; return null; }
        throw new Error(`rpc ${fn}?`);
      },
    };
    w.jalan = (permintaan) => kelolaPengguna({ admin: w.admin, db: w.db, permintaan });
    return w;
  }
  const ditolak = async (p, status, re) => {
    await assert.rejects(p, (e) => e.status === status && re.test(e.message), `harus gagal ${status} ${re}`);
  };

  await t('hanya owner', async () => {
    const w = dunia({ peran: 'admin_kantor' });
    await ditolak(w.jalan({ aksi: 'buat', email: 'a@x.id', nama: 'A', peran: 'gudang', sandi: 'sementara1' }), 403, /Hanya owner/);
    assert.ok(!w.log.some(([f]) => f === 'createUser'));
  });

  await t('tanpa login yang sah → 401', async () => {
    const w = dunia();
    w.db.rpc = async () => { throw new Error('permission denied for function saya'); };
    await ditolak(w.jalan({ aksi: 'buat', email: 'a@x.id', nama: 'A', peran: 'gudang', sandi: 'sementara1' }), 401, /login ulang/);
  });

  await t('buat: akun baru (email dirapikan), data pengguna, wajib ganti sandi', async () => {
    const w = dunia();
    assert.deepStrictEqual(await w.jalan({ aksi: 'buat', email: '  Toko.Baru@X.id ', nama: ' Bu Ani ', peran: 'pemilik_toko', kode_toko: 'MLG', sandi: 'sementara1' }),
      { ok: true, email: 'toko.baru@x.id' });
    assert.strictEqual(w.akun.get('toko.baru@x.id').sandi, 'sementara1');
    assert.deepStrictEqual(w.pengguna.get('toko.baru@x.id'), { nama: 'Bu Ani', peran: 'pemilik_toko', kode_toko: 'MLG', wajib: true });
  });

  await t('buat: email tidak valid / sandi pendek / nama kosong ditolak', async () => {
    const w = dunia();
    await ditolak(w.jalan({ aksi: 'buat', email: 'bukan-email', nama: 'A', peran: 'gudang', sandi: 'sementara1' }), 400, /Email tidak valid/);
    await ditolak(w.jalan({ aksi: 'buat', email: 'a@x.id', nama: 'A', peran: 'gudang', sandi: 'pendek' }), 400, /minimal 8/);
    await ditolak(w.jalan({ aksi: 'buat', email: 'a@x.id', nama: ' ', peran: 'gudang', sandi: 'sementara1' }), 400, /Nama wajib/);
    assert.strictEqual(w.akun.size, 1);
  });

  await t('buat: data pengguna ditolak database → akun yang baru dibuat dihapus lagi', async () => {
    const w = dunia({ aturGagal: 'Kode toko wajib diisi untuk pemilik toko' });
    await ditolak(w.jalan({ aksi: 'buat', email: 'b@x.id', nama: 'B', peran: 'pemilik_toko', sandi: 'sementara1' }), 400, /Kode toko wajib/);
    assert.ok(!w.akun.has('b@x.id'));
    assert.ok(w.log.some(([f]) => f === 'deleteUser'));
  });

  await t('buat: email sudah di daftar → 409; akun Supabase lama tanpa data pengguna → dipakai, sandi diganti', async () => {
    const w = dunia();
    await ditolak(w.jalan({ aksi: 'buat', email: 'owner@x.id', nama: 'X', peran: 'gudang', sandi: 'sementara1' }), 409, /sudah terdaftar/);
    w.akun.set('lama@x.id', { id: 'u-lama', sandi: 'dari-dashboard' });
    assert.deepStrictEqual(await w.jalan({ aksi: 'buat', email: 'lama@x.id', nama: 'Lama', peran: 'gudang', sandi: 'sementara1' }), { ok: true, email: 'lama@x.id', akun_lama: true });
    assert.strictEqual(w.akun.get('lama@x.id').sandi, 'sementara1');
    assert.strictEqual(w.pengguna.get('lama@x.id').wajib, true);
  });

  await t('reset sandi: sandi baru & wajib ganti; bukan untuk diri sendiri; pengguna tak dikenal 404', async () => {
    const w = dunia();
    await w.jalan({ aksi: 'buat', email: 'c@x.id', nama: 'C', peran: 'gudang', sandi: 'sementara1' });
    w.pengguna.get('c@x.id').wajib = false;
    assert.deepStrictEqual(await w.jalan({ aksi: 'reset_sandi', email: 'c@x.id', sandi: 'sementara2' }), { ok: true, email: 'c@x.id' });
    assert.strictEqual(w.akun.get('c@x.id').sandi, 'sementara2');
    assert.strictEqual(w.pengguna.get('c@x.id').wajib, true);
    await ditolak(w.jalan({ aksi: 'reset_sandi', email: 'owner@x.id', sandi: 'sementara2' }), 400, /akun sendiri/);
    await ditolak(w.jalan({ aksi: 'reset_sandi', email: 'z@x.id', sandi: 'sementara2' }), 404, /tidak ditemukan/);
    await ditolak(w.jalan({ aksi: 'hapus', email: 'c@x.id', sandi: 'sementara2' }), 400, /Aksi tidak dikenal/);
  });

  console.log(`\n${lulus} uji pengguna lulus`);
})();
