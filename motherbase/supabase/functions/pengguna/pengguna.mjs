// Logika Edge Function `pengguna`: owner menambah pengguna & mereset kata sandi dari homebase.
// Dipakai index.ts (Supabase, Deno) dan server dev / uji (Node).
//
//   admin: { createUser({ email, password }) → id, updateUserById(id, { password }), deleteUser(id) }
//          memakai service role (Supabase Auth admin); hanya dipanggil setelah pemanggil terbukti owner.
//   db:    { rpc(nama, args) → data } dengan token PEMANGGIL, jadi aturan di database (atur_pengguna,
//          wajibkan_ganti_sandi: hanya owner) tetap berlaku.
//
// Permintaan:
//   { aksi: 'buat', email, nama, peran, kode_toko, sandi }   akun baru + data pengguna, wajib ganti sandi
//   { aksi: 'reset_sandi', email, sandi }                    kata sandi sementara baru, wajib ganti sandi
// Tidak ada email yang dikirim: owner memberikan kata sandi sementara secara pribadi.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUPLIKAT = /already|registered|exists|duplicate|unique/i;

export class GalatPengguna extends Error {
  constructor(status, pesan) {
    super(pesan);
    this.status = status;
  }
}

export async function kelolaPengguna({ admin, db, permintaan }) {
  const p = permintaan && typeof permintaan === 'object' ? permintaan : {};
  let saya;
  try {
    saya = await db.rpc('saya');
  } catch (_) {
    throw new GalatPengguna(401, 'Silakan login ulang.');
  }
  if (!saya || saya.peran !== 'owner' || !saya.aktif) {
    throw new GalatPengguna(403, 'Hanya owner yang boleh menambah pengguna atau mereset kata sandi.');
  }
  const email = String(p.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new GalatPengguna(400, 'Email tidak valid.');
  const sandi = String(p.sandi || '');
  if (sandi.length < 8) throw new GalatPengguna(400, 'Kata sandi sementara minimal 8 karakter.');
  const cari = async () => ((await db.rpc('daftar_pengguna')) || []).find((x) => String(x.email).toLowerCase() === email);

  if (p.aksi === 'buat') {
    const nama = String(p.nama || '').trim();
    if (!nama) throw new GalatPengguna(400, 'Nama wajib diisi.');
    const peran = String(p.peran || '');
    const atur = () => db.rpc('atur_pengguna', {
      p_email: email, p_nama: nama, p_peran: peran, p_kode_toko: peran === 'pemilik_toko' ? (p.kode_toko || null) : null, p_aktif: true,
    });
    let idBaru = null;
    try {
      idBaru = await admin.createUser({ email, password: sandi });
    } catch (err) {
      if (!DUPLIKAT.test(err.message)) throw err;
      // Akun Supabase sudah ada. Sudah di daftar Pengguna → tolak; belum (mis. dibuat lewat dashboard) → pakai akun itu.
      if (await cari()) throw new GalatPengguna(409, `Email ${email} sudah terdaftar. Ubah datanya di daftar, atau pakai Reset kata sandi.`);
      try { await atur(); } catch (e) { throw new GalatPengguna(400, e.message); }
      const u = await cari();
      await admin.updateUserById(u.id, { password: sandi });
      await db.rpc('wajibkan_ganti_sandi', { p_email: email });
      return { ok: true, email, akun_lama: true };
    }
    try {
      await atur();
      await db.rpc('wajibkan_ganti_sandi', { p_email: email });
    } catch (err) {
      await Promise.resolve(admin.deleteUser(idBaru)).catch(() => {}); // jangan tinggalkan akun tanpa data pengguna
      throw new GalatPengguna(400, err.message);
    }
    return { ok: true, email };
  }

  if (p.aksi === 'reset_sandi') {
    if (email === String(saya.email || '').toLowerCase()) throw new GalatPengguna(400, 'Untuk akun sendiri pakai Ganti kata sandi.');
    const u = await cari();
    if (!u) throw new GalatPengguna(404, `Pengguna ${email} tidak ditemukan.`);
    await admin.updateUserById(u.id, { password: sandi });
    await db.rpc('wajibkan_ganti_sandi', { p_email: email });
    return { ok: true, email };
  }

  throw new GalatPengguna(400, 'Aksi tidak dikenal.');
}
