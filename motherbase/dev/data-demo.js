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
const { createServices, localNow } = require(path.join(REPO, 'src/services'));
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
    'supabase/migrations/20261116000002_aplikasi.sql', 'supabase/migrations/20261116000003_import_barang.sql', 'supabase/migrations/20261119000004_satuan_masuk.sql', 'supabase/migrations/20261119000005_tanpa_principal.sql',
    'supabase/migrations/20261119000006_pembatalan_nota.sql', 'supabase/migrations/20261120000007_filter_stok.sql', 'supabase/migrations/20261120000008_pesanan_toko.sql', 'supabase/migrations/20261120000009_minta_update.sql', 'supabase/migrations/20261122000010_opname_kantor.sql', 'supabase/migrations/20261123000011_riwayat_stok.sql', 'supabase/migrations/20261123000012_dokumen_batal.sql', 'supabase/migrations/20261123000013_kata_sandi.sql', 'supabase/migrations/20261123000014_laporan_mutasi.sql', 'supabase/migrations/20261123000015_mutasi_penjualan.sql', 'supabase/migrations/20261124000016_retur_barang.sql', 'supabase/migrations/20261124000017_penjualan_toko_item.sql', 'supabase/migrations/20261124000018_stok_penjualan_toko_item.sql', 'supabase/migrations/20261124000019_omzet_kategori_harian.sql', 'supabase/migrations/20261124000020_omzet_kategori_toko.sql', 'supabase/seed.sql']) {
    await c.query(fs.readFileSync(path.join(MB, f), 'utf8'));
  }
  return c;
}

// opsi.toko (objek): diisi Trizone contoh per toko ({ svc, db, mb }) agar uji bisa menjawab permintaan homebase;
// koneksi database lalu tetap terbuka sampai opsi.tutup() dipanggil.
async function buatDataDemo(dbUrl, opsi = {}) {
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
      if (!['terima_data', 'ambil_master', 'cek_permintaan', 'opname_diterapkan'].includes(fn)) throw new Error(`fungsi ${fn} tidak dikenal`);
      const r = await client.query(`select public.${fn}($1::jsonb) as v`, [JSON.stringify(p)]);
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
    const dbToko = await Database.open(null);
    const svc = createServices(dbToko);
    svc.saveSettings({ store_name: `${t.nama} (contoh)` });
    svc.importRows(BARANG.map(([sku, barcode, nama, kategori, harga, satuan, rasio]) => ({
      Barcode: barcode, SKU: sku, Nama_Barang: nama, Merk: 'Contoh', Kategori: kategori, Harga_Jual: harga,
      Satuan_Masuk: satuan, Rasio_Isi_Dus: rasio, Stok_Awal_Toko: Math.round(8 + rnd() * 20), Stok_Awal_Gudang: Math.round(rnd() * 30),
      Min_Alert_Toko: 5,
    })));
    svc.mbSaveConfig({ url: 'http://127.0.0.1:1', anon_key: 'dev', kode_toko: t.kode, kunci: k, kunci_master: true });
    tokoSvc[t.kode] = { svc, db: dbToko, mb: createMotherbase({ svc, appVersion: '1.8.0-contoh', fetchFn: anonFetch }) };
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
      // Batal nota (disetujui PIN Admin toko): nota BTL- berisi baris minus + rinciannya, seperti kiriman Trizone
      const pembatalan = [];
      if ((t.kode === 'TRP' && n === 2) || (t.kode === 'MLG' && n === 5)) {
        const asal = sales.filter((l) => l.receipt_no === sales[0].receipt_no);
        const no = `BTL-${tanggal.replace(/-/g, '')}-0001`;
        const waktu = `${tanggal} 20:40:00`;
        asal.forEach((l, i) => sales.push({ ...l, receipt_no: no, line_no: i + 1, created_at: waktu, qty: -l.qty, line_total: -l.line_total }));
        pembatalan.push({ void_no: no, receipt_no: asal[0].receipt_no, reason: 'Pelanggan batal beli, barang dikembalikan', requested_by: 'Rina',
          approved_by: 'Bu Sari', total: asal.reduce((a, l) => a + l.line_total, 0), created_at: waktu });
      }
      shifts.push({ shift: { shift_uid: `contoh-${t.kode}-${tanggal}`, cashier_name: rnd() < 0.5 ? 'Rina' : 'Dewi', shift_start: `${tanggal} 08:00:00`,
        closed_at: `${tanggal} 21:05:00`, notes: '' }, sales, pembatalan });
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
  const terima103 = tokoSvc.SDA.svc.importReceptions({ rows: acc.barisImportTrizone({ ...hasil, do: [doList[2]] }) });
  // Sidoarjo membatalkan penerimaan DO 103 (salah input) dengan PIN Admin: di kantor tampil Dibatalkan, SJ belum diinput
  tokoSvc.SDA.svc.saveUser({ name: 'Pak Budi', role: 'admin', pin: '864200', active: true });
  tokoSvc.SDA.svc.cancelReception({ id: terima103.created[0].id, reason: 'Salah input jumlah, diinput ulang besok',
    requested_by: 'Rina', approver_pin: '864200' });

  // Stok opname Tropodo (zona display), lalu shift hari ini yang masih berjalan
  const trp = tokoSvc.TRP.svc;
  const p = Object.fromEntries(trp.listProducts({}).map((x) => [x.sku, x]));
  trp.createOpname({ zone: 'floor', notes: 'SO bulanan', items: [
    { sku: 'PLJ-001', counted: p['PLJ-001'].floor_stock - 1 }, { sku: 'RTN-002', counted: p['RTN-002'].floor_stock },
    { sku: 'PLJ-002', counted: p['PLJ-002'].floor_stock - 2 }] });
  trp.createTransferDoc({ from_zone: 'warehouse', to_zone: 'shopee', reason: 'Stok online', items: [{ sku: 'RTN-002', qty: 5 }] });
  trp.createTransferDoc({ from_zone: 'shopee', to_zone: 'shopee_sold', reason: 'Pesanan Shopee', items: [{ sku: 'RTN-002', qty: 2 }] });
  // Retur ke supplier (kantor): barang rusak dipindah ke Gudang BS, lalu dikirim balik
  trp.createTransferDoc({ from_zone: 'floor', to_zone: 'damaged', reason: 'Pecah di rak', items: [{ sku: 'RTN-004', qty: 3 }, { sku: 'PLJ-005', qty: 2 }] });
  trp.createTransferDoc({ from_zone: 'damaged', to_zone: 'supplier', reason: 'Retur BS ke kantor', items: [{ sku: 'RTN-004', qty: 3 }, { sku: 'PLJ-005', qty: 2 }] });
  for (const t of TOKO) {
    const svc = tokoSvc[t.kode].svc;
    svc.openShift({ cashier_name: 'Rina' });
    svc.checkout({ items: [{ sku: 'PLJ-002', qty: 2 }, { sku: 'RTN-002', qty: 1 }], payment_method: 'Tunai', cash_received: 100000 });
    const nota = svc.checkout({ items: [{ sku: 'PLJ-004', qty: 1 }], payment_method: 'QRIS' });
    if (t.kode === 'TRP') {
      svc.saveUser({ name: 'Bu Sari', role: 'admin', pin: '135790', active: true });
      svc.voidReceipt({ receipt_no: nota.receipt_no, reason: 'Salah ambil barang', items: [{ sku: 'PLJ-004', destination: 'floor' }],
        requested_by: 'Rina', approver_pin: '135790' });
      // Mutasi yang salah arah dibatalkan dengan PIN Admin (stok dikembalikan; di kantor ditandai Dibatalkan)
      const salah = svc.createTransferDoc({ from_zone: 'floor', to_zone: 'warehouse', reason: 'Tarik dari rak', items: [{ sku: 'PLJ-001', qty: 1 }] });
      svc.cancelTransferDoc({ id: salah.id, reason: 'Salah arah, seharusnya ke Gudang BS', requested_by: 'Rina', approver_pin: '135790' });
    }
    // Pesanan pelanggan: TRP 2 belum diambil (1 lewat tanggal ambil) + 1 batal, MLG 1 sudah diambil
    const hariToko = localNow().slice(0, 10);
    const besok = new Date(`${hariToko}T00:00:00Z`);
    besok.setUTCDate(besok.getUTCDate() + 1);
    if (t.kode === 'TRP') {
      svc.createOrder({ items: [{ sku: 'PLJ-001', qty: 2 }, { sku: 'RTN-003', qty: 1 }], customer_name: 'Ibu Ani', customer_phone: '0812-3456-7890',
        pickup_date: besok.toISOString().slice(0, 10), deposit: 50000, notes: 'Diambil sore' });
      const lewat = svc.createOrder({ items: [{ sku: 'RTN-001', qty: 1 }], customer_name: 'Pak Joko', customer_phone: '0857-1111-2222', pickup_date: hariToko, deposit: 100000 });
      tokoSvc[t.kode].db.run("UPDATE customer_orders SET pickup_date = date(?, '-2 day') WHERE order_no = ?", [hariToko, lewat.order_no]);
      const batalPs = svc.createOrder({ items: [{ sku: 'PLJ-002', qty: 5 }], customer_name: 'Mbak Sri', pickup_date: hariToko, deposit: 10000 });
      svc.cancelOrder({ order_no: batalPs.order_no, reason: 'Tidak jadi beli', deposit_action: 'kembali', approver_pin: '135790', requested_by: 'Rina' });
    }
    if (t.kode === 'MLG') {
      const ps = svc.createOrder({ items: [{ sku: 'PLJ-003', qty: 1 }], customer_name: 'Bu Dewi', pickup_date: hariToko, deposit: 20000 });
      svc.completeOrder({ order_no: ps.order_no, zone: 'floor', cash_received: 50000, done_by: 'Rina' });
    }
    await tokoSvc[t.kode].mb.kirim();
  }

  // Usulan PO untuk semua barang yang perlu dibeli (menunggu persetujuan owner)
  await q('select public.buat_po_dari_usulan()').catch(() => null);

  await c.end();
  if (opsi.toko) {
    Object.assign(opsi.toko, tokoSvc);
    opsi.tutup = () => pool.end();
  } else await pool.end();
  return AKUN;
}

module.exports = { buatDataDemo, AKUN };

if (require.main === module) {
  buatDataDemo(process.env.MB_DATABASE_URL || 'postgresql://postgres@localhost/mb_dev')
    .then((a) => { console.log('Data contoh dibuat. Akun:'); a.forEach((x) => console.log(`  ${x.email} / ${x.password} (${x.peran})`)); })
    .catch((e) => { console.error(e); process.exit(1); });
}
