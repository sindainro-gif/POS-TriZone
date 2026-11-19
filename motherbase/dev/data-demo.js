'use strict';
// Data contoh untuk server dev: database baru dari migrasi + seed, 3 toko Trizone sungguhan
// (src/services.js) yang mengirim lewat src/motherbase.js, riwayat penjualan 5 minggu,
// surat jalan Accurate, stok opname, principal, harga beli, dan satu usulan PO.
// Semua nama barang, akun, dan angka di sini contoh.

const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');

const MB = path.join(__dirname, '..');
const REPO = path.join(MB, '..');
const { Database } = require(path.join(REPO, 'src/db'));
const { createServices } = require(path.join(REPO, 'src/services'));
const { createMotherbase } = require(path.join(REPO, 'src/motherbase'));
const acc = require(path.join(MB, 'web/lib/accurate'));

const AKUN = [
  { email: 'owner@contoh.local', password: 'owner123', nama: 'Owner Contoh', peran: 'owner' },
  { email: 'admin@contoh.local', password: 'admin123', nama: 'Admin Kantor', peran: 'admin_kantor' },
  { email: 'tropodo@contoh.local', password: 'toko123', nama: 'Pemilik Tropodo', peran: 'pemilik_toko', kode_toko: 'TRP' },
];

const PRINCIPAL = [
  { nama: 'PT Plastik Jaya (contoh)', lead_time_hari: 5, periode_order_hari: 7, jadwal_order: 'tiap Senin', minimum_order_qty: 24 },
  { nama: 'CV Rotan Indah (contoh)', lead_time_hari: null, periode_order_hari: null, jadwal_order: null, minimum_order_qty: null },
];

// [sku, barcode, nama, kategori, harga jual, satuan masuk, rasio, principal (1/2), bobot laku]
const BARANG = [
  ['PLJ-001', '8990000000017', 'Ember Plastik 20L', 'Plastik', 35000, 'Coly', 6, 1, 6],
  ['PLJ-002', '8990000000024', 'Gayung Bunga', 'Plastik', 7500, 'Coly', 24, 1, 14],
  ['PLJ-003', '8990000000031', 'Keranjang Cucian', 'Plastik', 42000, 'Coly', 6, 1, 4],
  ['PLJ-004', '8990000000048', 'Toples 2 Liter', 'Plastik', 15000, 'Coly', 12, 1, 9],
  ['PLJ-005', '8990000000055', 'Rak Sepatu 4 Susun', 'Plastik', 89000, 'Biji', 1, 1, 2],
  ['RTN-001', '8990000000062', 'Kursi Rotan Olive', 'Rotan', 185000, 'Coly', 2, 2, 1],
  ['RTN-002', '8990000000079', 'Keset Zig Zag', 'Rotan', 25000, 'Biji', 1, 2, 10],
  ['RTN-003', '8990000000086', 'Keranjang Rotan Retro', 'Rotan', 55000, 'Coly', 4, 2, 3],
  ['RTN-004', '8990000000093', 'Pail Ukir 40', 'Rotan', 48000, 'Coly', 3, 2, 2],
  ['RTN-005', '8990000000109', 'Tempat Sampah Rotan', 'Rotan', 65000, 'Coly', 4, 2, 0],
];
const TOKO = [
  { kode: 'TRP', nama: 'Tropodo', pelanggan: 'Tropodo', ramai: 1.0 },
  { kode: 'SDA', nama: 'Sidoarjo', pelanggan: 'Sidoarjo', ramai: 0.7 },
  { kode: 'MLG', nama: 'Malang', pelanggan: 'Malang', ramai: 0.5 },
];

// PRNG tetap supaya data contoh selalu sama
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wibNow = () => new Date(Date.now() + 7 * 3600e3);
const tgl = (d) => d.toISOString().slice(0, 10);
const hariLalu = (n) => { const d = wibNow(); d.setUTCDate(d.getUTCDate() - n); return tgl(d); };

async function buatDatabase(dbUrl) {
  const u = new URL(dbUrl);
  const nama = u.pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(nama)) throw new Error(`Nama database tidak valid: ${nama}`);
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [nama]);
  await admin.query(`drop database if exists ${nama}`);
  await admin.query(`create database ${nama}`);
  await admin.end();
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  for (const f of ['supabase/tests/stub_supabase.sql', 'supabase/migrations/20261116000001_mother_base.sql',
    'supabase/migrations/20261116000002_aplikasi.sql', 'supabase/migrations/20261116000003_import_barang.sql', 'supabase/migrations/20261119000004_satuan_masuk.sql', 'supabase/seed.sql']) {
    await c.query(fs.readFileSync(path.join(MB, f), 'utf8'));
  }
  return c;
}

async function buatDataDemo(dbUrl) {
  const c = await buatDatabase(dbUrl);
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  const q = (sql, params) => c.query(sql, params).then((r) => r.rows);
  const rnd = prng(20261116);

  // Akun & pengguna
  for (const a of AKUN) {
    const [u] = await q(`insert into auth.users (email, encrypted_password) values ($1, crypt($2, gen_salt('bf'))) returning id`, [a.email, a.password]);
    await q('insert into pengguna (id, nama, peran, kode_toko) values ($1, $2, $3, $4)', [u.id, a.nama, a.peran, a.kode_toko || null]);
  }
  await q(`insert into pengaturan values ('markup_jual_ke_toko', '0.06') on conflict (kunci) do update set nilai = excluded.nilai`);

  // Principal & master barang kantor
  const prId = [];
  for (const p of PRINCIPAL) {
    const [r] = await q(`insert into principal (nama, lead_time_hari, periode_order_hari, jadwal_order, minimum_order_qty, stok_pengaman_hari)
                         values ($1, $2, $3, $4, $5, 3) returning id`, [p.nama, p.lead_time_hari, p.periode_order_hari, p.jadwal_order, p.minimum_order_qty]);
    prId.push(r.id);
  }
  for (const [sku, barcode, nama, kategori, harga, satuan, rasio, pr] of BARANG) {
    await q(`insert into produk (sku, nama, principal_id, isi_dus, barcode, merk, kategori, harga_jual_konsumen, satuan_masuk, rasio_isi)
             values ($1, $2, $3, $4, $5, 'Contoh', $6, $7, $8, $4)`, [sku, nama, prId[pr - 1], rasio, barcode, kategori, harga, satuan]);
    await q(`insert into harga_beli (sku, berlaku_at, harga, sumber, referensi) values ($1, $2, $3, 'PEMBELIAN', 'saldo awal')`,
      [sku, hariLalu(40), Math.round(harga * 0.68 / 100) * 100]);
    await q(`insert into gudang_mutasi (waktu, jenis, sku, qty, referensi) values (now() - interval '40 days', 'TERIMA_PRINCIPAL', $1, $2, 'SALDO-AWAL')`,
      [sku, sku === 'PLJ-002' ? 48 : 24]);
  }

  // Toko Trizone sungguhan, terhubung lewat kunci toko
  const anonFetch = async (url, init) => {
    const fn = url.split('/rpc/')[1];
    const p = JSON.parse(init.body).p;
    const client = await pool.connect();
    try {
      await client.query('begin; set local role anon');
      const r = await client.query(`select public.${fn === 'terima_data' ? 'terima_data' : 'ambil_master'}($1::jsonb) as v`, [JSON.stringify(p)]);
      await client.query('commit');
      return new Response(JSON.stringify(r.rows[0].v), { status: 200 });
    } catch (e) {
      await client.query('rollback');
      return new Response(JSON.stringify({ message: e.message }), { status: 400 });
    } finally {
      client.release();
    }
  };

  const tokoSvc = {};
  for (const t of TOKO) {
    const [{ k }] = await q('select public.buat_kunci_toko($1) as k', [t.kode]);
    const svc = createServices(await Database.open(null));
    svc.saveSettings({ store_name: `${t.nama} (contoh)` });
    svc.importRows(BARANG.map(([sku, barcode, nama, kategori, harga, satuan, rasio]) => ({
      Barcode: barcode, SKU: sku, Nama_Barang: nama, Merk: 'Contoh', Kategori: kategori, Harga_Jual: harga,
      Satuan_Masuk: satuan, Rasio_Isi_Dus: rasio, Stok_Awal_Toko: Math.round(8 + rnd() * 20), Stok_Awal_Gudang: Math.round(rnd() * 30),
      Min_Alert_Toko: 5,
    })));
    svc.mbSaveConfig({ url: 'http://127.0.0.1:1', anon_key: 'dev', kode_toko: t.kode, kunci: k, kunci_master: true });
    tokoSvc[t.kode] = { svc, mb: createMotherbase({ svc, appVersion: '1.8.0-contoh', fetchFn: anonFetch }) };
  }

  // Riwayat penjualan 35 hari (dikirim seperti data tutup shift dari Trizone)
  const metode = ['Tunai', 'Tunai', 'Tunai', 'QRIS', 'QRIS', 'Transfer'];
  for (const t of TOKO) {
    const shifts = [];
    for (let n = 35; n >= 1; n--) {
      const tanggal = hariLalu(n);
      const akhirPekan = [0, 6].includes(new Date(`${tanggal}T00:00:00Z`).getUTCDay());
      const struk = Math.round((14 + rnd() * 14) * t.ramai * (akhirPekan ? 1.4 : 1));
      const sales = [];
      for (let s = 1; s <= struk; s++) {
        const no = `INV-${tanggal.replace(/-/g, '')}-${String(s).padStart(4, '0')}`;
        const jam = `${String(9 + Math.floor(rnd() * 11)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`;
        const m = metode[Math.floor(rnd() * metode.length)];
        const nBaris = 1 + Math.floor(rnd() * 3);
        const dipakai = new Set();
        for (let b = 0; b < nBaris; b++) {
          // Bobot laku; Keset & Gayung naik di minggu terakhir, Kursi Rotan turun
          const bobot = BARANG.map((x) => x[8] * (n <= 7 && ['RTN-002', 'PLJ-002'].includes(x[0]) ? 1.8 : n <= 7 && x[0] === 'RTN-001' ? 0.3 : 1));
          let r = rnd() * bobot.reduce((a2, x) => a2 + x, 0);
          let i = 0;
          while (r > bobot[i]) { r -= bobot[i]; i++; }
          const x = BARANG[Math.min(i, BARANG.length - 1)];
          if (dipakai.has(x[0])) continue;
          dipakai.add(x[0]);
          const qty = 1 + Math.floor(rnd() * (x[4] < 20000 ? 4 : 2));
          sales.push({ receipt_no: no, line_no: dipakai.size, created_at: `${tanggal} ${jam}`, sku: x[0], product_name: x[2],
            qty, unit_price: x[4], line_total: qty * x[4], payment_method: m });
        }
      }
      shifts.push({ shift: { shift_uid: `contoh-${t.kode}-${tanggal}`, cashier_name: rnd() < 0.5 ? 'Rina' : 'Dewi', shift_start: `${tanggal} 08:00:00`,
        closed_at: `${tanggal} 21:05:00`, notes: '' }, sales });
    }
    const [{ k }] = await q('select 1 as k'); // jaga koneksi
    void k;
    for (let i = 0; i < shifts.length; i += 10) {
      const res = await anonFetch('x/rpc/terima_data', { body: JSON.stringify({ p: {
        protokol: 1, kode_toko: t.kode, kunci: tokoSvc[t.kode].svc.mbConfig().kunci, app_version: '1.8.0-contoh',
        shifts: shifts.slice(i, i + 10), dokumen: null, snapshot: null } }) });
      if (!res.ok) throw new Error(`Riwayat ${t.kode}: ${await res.text()}`);
    }
  }

  // Surat jalan dari Accurate (format laporan Rincian Pengiriman Pesanan)
  const doList = [
    { no: 'DO.2026.11.00101', tanggal: hariLalu(4), pelanggan: 'Tropodo', items: [{ kode: 'PLJ-001', nama: 'Ember Plastik 20L', qty: 2, satuan: 'Coly' }, { kode: 'RTN-002', nama: 'Keset Zig Zag', qty: 20, satuan: 'Pcs' }] },
    { no: 'DO.2026.11.00102', tanggal: hariLalu(3), pelanggan: 'Tropodo Special', items: [{ kode: 'RTN-003', nama: 'Keranjang Rotan Retro', qty: 2, satuan: 'Coly' }] },
    { no: 'DO.2026.11.00103', tanggal: hariLalu(5), pelanggan: 'Sidoarjo', items: [{ kode: 'PLJ-002', nama: 'Gayung Bunga', qty: 1, satuan: 'Coly' }] },
    { no: 'DO.2026.11.00104', tanggal: hariLalu(2), pelanggan: 'Malang', items: [{ kode: 'PLJ-004', nama: 'Toples 2 Liter', qty: 1, satuan: 'Coly' }] },
    { no: 'DO.2026.11.00105', tanggal: hariLalu(1), pelanggan: 'Utama', items: [{ kode: 'PLJ-005', nama: 'Rak Sepatu 4 Susun', qty: 3, satuan: 'Pcs' }] },
  ];
  await q('select public.import_surat_jalan($1::jsonb)', [JSON.stringify({ file: 'contoh.xlsx', do: doList })]);
  const hasil = { perusahaan: 'PT Contoh Kantor', do: doList };
  // Tropodo: DO 101 diterima persis, DO 102 diterima kurang 1 Biji; Sidoarjo: DO 103 diterima persis
  tokoSvc.TRP.svc.importReceptions({ rows: acc.barisImportTrizone({ ...hasil, do: [doList[0]] }) });
  const rows102 = acc.barisImportTrizone({ ...hasil, do: [doList[1]] }).map((r) => ({ ...r, Jumlah: 1 }));
  rows102.push({ ...rows102[0], Jumlah: 3, Satuan: 'Biji' });
  tokoSvc.TRP.svc.importReceptions({ rows: rows102 });
  tokoSvc.SDA.svc.importReceptions({ rows: acc.barisImportTrizone({ ...hasil, do: [doList[2]] }) });

  // Stok opname Tropodo (zona display), lalu shift hari ini yang masih berjalan
  const trp = tokoSvc.TRP.svc;
  const p = Object.fromEntries(trp.listProducts({}).map((x) => [x.sku, x]));
  trp.createOpname({ zone: 'floor', notes: 'SO bulanan', items: [
    { sku: 'PLJ-001', counted: p['PLJ-001'].floor_stock - 1 }, { sku: 'RTN-002', counted: p['RTN-002'].floor_stock },
    { sku: 'PLJ-002', counted: p['PLJ-002'].floor_stock - 2 }] });
  trp.createTransferDoc({ from_zone: 'warehouse', to_zone: 'shopee', reason: 'Stok online', items: [{ sku: 'RTN-002', qty: 5 }] });
  trp.createTransferDoc({ from_zone: 'shopee', to_zone: 'shopee_sold', reason: 'Pesanan Shopee', items: [{ sku: 'RTN-002', qty: 2 }] });
  for (const t of TOKO) {
    const svc = tokoSvc[t.kode].svc;
    svc.openShift({ cashier_name: 'Rina' });
    svc.checkout({ items: [{ sku: 'PLJ-002', qty: 2 }, { sku: 'RTN-002', qty: 1 }], payment_method: 'Tunai', cash_received: 100000 });
    svc.checkout({ items: [{ sku: 'PLJ-004', qty: 1 }], payment_method: 'QRIS' });
    await tokoSvc[t.kode].mb.kirim();
  }

  // Usulan PO untuk principal pertama (menunggu persetujuan owner)
  await q('select public.buat_po_dari_usulan($1)', [prId[0]]).catch(() => null);

  await c.end();
  await pool.end();
  return AKUN;
}

module.exports = { buatDataDemo, AKUN };

if (require.main === module) {
  buatDataDemo(process.env.MB_DATABASE_URL || 'postgresql://postgres@localhost/mb_dev')
    .then((a) => { console.log('Data contoh dibuat. Akun:'); a.forEach((x) => console.log(`  ${x.email} / ${x.password} (${x.peran})`)); })
    .catch((e) => { console.error(e); process.exit(1); });
}
