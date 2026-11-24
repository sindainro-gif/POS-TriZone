'use strict';
// Uji mother base dari ujung ke ujung, memakai kode Trizone asli:
//   1. File Accurate "Rincian Pengiriman Pesanan" (tiruan, tata letak sama) dibaca accurate-do.js.
//   2. Database mother base dibuat dari migrasi + seed; kunci toko dibuat.
//   3. Toko Trizone di memori: import penerimaan dari file Accurate, stok opname, mutasi, penjualan, tutup shift.
//      Data dikirim dengan src/motherbase.js ke RPC terima_data (dijalankan sebagai peran anon).
//   4. Hasil dicek: penjualan, pencocokan surat jalan, stok seharusnya = stok Trizone, master barang, hak akses.
//
// Jalankan dari folder repo:
//   node motherbase/test/uji.js                      → langkah 1 saja (tanpa database)
//   MB_PSQL="psql -h <host> -p <port> -U postgres" node motherbase/test/uji.js
//      → + database: membuat database mb_uji baru, migrasi, seed, lalu semua pengecekan.
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..', '..');
const { Database } = require(path.join(ROOT, 'src/db'));
const { createServices } = require(path.join(ROOT, 'src/services'));
const { createMotherbase } = require(path.join(ROOT, 'src/motherbase'));
const acc = require('../accurate/accurate-do');

let lulus = 0;
const ok = (nama) => { lulus++; console.log('  ✓', nama); };
const tidur = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------------------------------------------------------------- 1. File Accurate tiruan
function fileAccurate() {
  const W = 20;
  const baris = (isi) => { const r = new Array(W).fill(null); for (const [i, v] of Object.entries(isi)) r[i] = v; return r; };
  const kepala = () => [baris({ 1: 'PT CONTOH KANTOR' }), baris({ 1: 'Rincian Pengiriman Pesanan' }),
    baris({ 1: 'Dari 01 Nov 2026 s/d 16 Nov 2026' }), baris({ 1: 'Cabang : [Semua Cabang]' })];
  const kaki = (h) => [baris({}), baris({ 1: 'ACCURATE Accounting System Report' }), baris({}),
    baris({ 1: 'Tercetak pada 16 November 2026 - 12:11' }), baris({ 1: `Halaman ${h}`, 17: ' dari 4' })];
  const tgl = (s) => { const [y, m, d] = s.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
  const blok = (no, tanggal, pelanggan, items) => [
    baris({ 2: 'Nomor #', 4: ':', 5: no, 9: 'Pelanggan', 11: ':', 13: pelanggan }),
    baris({ 2: 'Tanggal', 4: ':', 5: tgl(tanggal) }),
    baris({ 3: 'Kode #', 7: 'Nama Barang', 12: 'Kuantitas', 15: 'Satuan' }),
    ...items.map(([k, n, q, s]) => baris({ 3: k, 7: n, 12: q, 15: s })),
    baris({ 12: items.reduce((a, i) => a + i[2], 0) }),
  ];
  const kemarin3 = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const hariIni = new Date().toISOString().slice(0, 10);
  const rows = [
    ...kepala(), ...blok('DO.UJI.0001', kemarin3, 'Tropodo', [['UJ-KESET', 'Keset Uji', 150, 'Pcs'], ['UJ-KURSI', 'Kursi Uji', 2, 'Coly']]), ...kaki(1),
    ...kepala(), ...blok('DO.UJI.0002', kemarin3, 'Tropodo Special', [['UJ-EMBER', 'Ember Uji', 1, 'Coly']]), ...kaki(2),
    ...kepala(), ...blok('DO.UJI.0003', hariIni, 'Utama', [['UJ-KESET', 'Keset Uji', 10, 'Pcs']]), ...kaki(3),
    ...kepala(), ...blok('DO.UJI.0004', hariIni, 'Tropodo', [['UJ-EMBER', 'Ember Uji', 2, 'Coly']]), ...kaki(4),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Rincian Pengiriman Pesanan');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  console.log('Accurate');
  const hasil = acc.bacaFile(fileAccurate());
  assert.deepStrictEqual(hasil.masalah, []);
  assert.strictEqual(hasil.do.length, 4);
  assert.strictEqual(hasil.perusahaan, 'PT CONTOH KANTOR');
  assert.deepStrictEqual(hasil.do[0].items[1], { kode: 'UJ-KURSI', nama: 'Kursi Uji', qty: 2, satuan: 'Coly' });
  assert.match(hasil.do[0].tanggal, /^\d{4}-\d{2}-\d{2}$/);
  ok('laporan Accurate terbaca: 4 DO, total cocok, tanggal dari nomor seri Excel');
  assert.strictEqual(acc.keTanggal('02/11/2026'), '2026-11-02');
  assert.strictEqual(acc.keTanggal('2 Nov 2026'), '2026-11-02');
  assert.strictEqual(acc.satuanTrizone('Pcs'), 'Biji');
  assert.strictEqual(acc.satuanTrizone('Coly'), 'Dus');
  const rusak = acc.bacaRincianPengiriman([[null, 'PT X'], [null, null, 'Nomor #', null, ':', 'DO.1', null, null, null, 'Pelanggan', null, ':', null, 'A'],
    [null, null, null, 'Kode #', null, null, null, 'Nama Barang', null, null, null, null, 'Kuantitas', null, null, 'Satuan'],
    [null, null, null, 'K1', null, null, null, 'B', null, null, null, null, 3, null, null, 'Pcs'], [null, null, null, null, null, null, null, null, null, null, null, null, 4]]);
  assert.ok(rusak.masalah.some((m) => /total 4/.test(m)));
  ok('total DO yang tidak cocok dilaporkan');

  const PSQL = process.env.MB_PSQL;
  if (!PSQL) { console.log(`\n${lulus} uji lulus (database dilewati; isi MB_PSQL untuk uji lengkap)`); return; }

  // ---------------------------------------------------------------- 2. Database mother base
  console.log('Database');
  const [bin, ...args] = PSQL.split(' ');
  const DB = 'mb_uji';
  const run = (db, sqlArgs, input) => execFileSync(bin, [...args, '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-tA', ...sqlArgs],
    { encoding: 'utf8', input, maxBuffer: 64e6, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  run('postgres', ['-c', `drop database if exists ${DB}`]);
  run('postgres', ['-c', `create database ${DB}`]);
  const dir = path.join(__dirname, '..', 'supabase');
  for (const f of ['tests/stub_supabase.sql', 'migrations/20261116000001_mother_base.sql', 'migrations/20261116000002_aplikasi.sql', 'migrations/20261116000003_import_barang.sql', 'migrations/20261119000004_satuan_masuk.sql', 'migrations/20261119000005_tanpa_principal.sql', 'migrations/20261119000006_pembatalan_nota.sql', 'migrations/20261120000007_filter_stok.sql', 'migrations/20261120000008_pesanan_toko.sql', 'migrations/20261120000009_minta_update.sql', 'migrations/20261122000010_opname_kantor.sql', 'migrations/20261123000011_riwayat_stok.sql', 'migrations/20261123000012_dokumen_batal.sql', 'migrations/20261123000013_kata_sandi.sql', 'migrations/20261123000014_laporan_mutasi.sql', 'migrations/20261123000015_mutasi_penjualan.sql', 'migrations/20261124000016_retur_barang.sql', 'migrations/20261124000017_penjualan_toko_item.sql', 'migrations/20261124000018_stok_penjualan_toko_item.sql', 'migrations/20261124000019_omzet_kategori_harian.sql', 'seed.sql']) run(DB, ['-f', path.join(dir, f)]);
  const q = (sql) => run(DB, [], sql + ';');
  const lit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
  // Seperti Supabase: anon & authenticated punya hak tabel, RLS yang membatasi
  q('grant select on all tables in schema public to anon, authenticated; grant update on po, stok_opname_review to authenticated');

  const kunci = q(`select public.buat_kunci_toko('TRP')`);
  assert.match(kunci, /^[0-9a-f]{48}$/);
  assert.strictEqual(q('select count(*) from toko_kunci where kunci_hash = $$' + kunci + '$$'), '0'); // hanya hash yang disimpan

  // fetch tiruan: RPC PostgREST dijalankan sebagai peran anon, error SQL → HTTP 400 {message}
  const fetchFn = async (url, opt) => {
    const fn = url.split('/rest/v1/rpc/')[1];
    const p = JSON.parse(opt.body).p;
    try {
      const out = run(DB, [], `set role anon; select public.${fn}(${lit(p)});`);
      return { ok: true, status: 200, text: async () => out };
    } catch (e) {
      const m = /ERROR:\s+(.*)/.exec(String(e.stderr || e.message));
      return { ok: false, status: 400, text: async () => JSON.stringify({ message: m ? m[1] : String(e.message) }) };
    }
  };
  ok('kunci toko dibuat (hanya hash yang disimpan)');

  // ---------------------------------------------------------------- 3. Toko Trizone
  console.log('Trizone → mother base');
  const T = createServices(await Database.open(null));
  T.saveSettings({ store_name: 'Tropodo (uji)' });
  T.importRows([
    { Barcode: '2000000000101', SKU: 'UJ-KESET', Nama_Barang: 'Keset Uji', Harga_Jual: 15000, Satuan_Masuk: 'Pcs', Rasio_Isi_Dus: 1, Stok_Awal_Toko: 5 },
    { Barcode: '2000000000118', SKU: 'UJ-KURSI', Nama_Barang: 'Kursi Uji', Harga_Jual: 85000, Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 6, Stok_Awal_Toko: 2 },
    { Barcode: '2000000000125', SKU: 'UJ-EMBER', Nama_Barang: 'Ember Uji', Harga_Jual: 25000, Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 12, Stok_Awal_Toko: 4 },
  ]);
  T.mbSaveConfig({ url: 'http://127.0.0.1:54321', anon_key: 'anon-uji', kode_toko: 'TRP', kunci });
  const mb = createMotherbase({ svc: T, appVersion: 'uji', fetchFn });

  // DO.UJI.0001 diterima persis lewat file import buatan accurate-do.js
  const imp1 = T.importReceptions({ rows: acc.barisImportTrizone({ ...hasil, do: [hasil.do[0]] }) });
  assert.deepStrictEqual(imp1.errors, []);
  assert.strictEqual(T.getReception({ id: imp1.created[0].id }).total_items_count, 150 + 2 * 6);
  tidur(1100);
  const stok = () => Object.fromEntries(T.listProducts({}).map((p) => [p.sku, p]));
  const s = stok();
  T.createOpname({ zone: 'floor', notes: 'SO awal', items: [{ sku: 'UJ-KESET', counted: s['UJ-KESET'].floor_stock - 1 },
    { sku: 'UJ-KURSI', counted: s['UJ-KURSI'].floor_stock }, { sku: 'UJ-EMBER', counted: s['UJ-EMBER'].floor_stock }] });
  T.createOpname({ zone: 'warehouse', notes: 'SO awal', items: Object.values(s).map((p) => ({ sku: p.sku, counted: p.warehouse_stock })) });
  tidur(1100);
  T.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', reason: 'Isi rak', items: [{ sku: 'UJ-KESET', qty: 20 }, { sku: 'UJ-KURSI', qty: 6 }] });
  T.createTransferDoc({ from_zone: 'warehouse', to_zone: 'shopee', reason: 'Stok online', items: [{ sku: 'UJ-KESET', qty: 10 }] });
  T.createTransferDoc({ from_zone: 'shopee', to_zone: 'shopee_sold', reason: 'Pesanan', items: [{ sku: 'UJ-KESET', qty: 3 }] });
  T.createTransferDoc({ from_zone: 'customer', to_zone: 'damaged', reason: 'Retur rusak', items: [{ sku: 'UJ-KURSI', qty: 1 }] });
  T.openShift({ cashier_name: 'Rina' });
  T.checkout({ items: [{ sku: 'UJ-KESET', qty: 4 }, { sku: 'UJ-KURSI', qty: 1 }], payment_method: 'Tunai', cash_received: 1e6 });
  T.checkout({ items: [{ sku: 'UJ-KESET', qty: 2 }], payment_method: 'QRIS' });
  T.checkout({ items: [{ sku: 'UJ-EMBER', qty: 1 }], payment_method: 'Transfer' });
  const rows4 = acc.barisImportTrizone({ ...hasil, do: [hasil.do[3]] }).map((r) => ({ ...r, Jumlah: 1, Satuan: 'Dus' }));
  rows4.push({ ...rows4[0], Jumlah: 11, Satuan: 'Biji' });          // 1 Coly + 11 Biji = 23 Biji, dikirim 24
  assert.deepStrictEqual(T.importReceptions({ rows: rows4 }).errors, []);

  // Kunci salah ditolak; data tetap menunggu
  T.mbSaveConfig({ kunci: 'salah' });
  await assert.rejects(mb.kirim(), /kunci toko salah/);
  T.mbSaveConfig({ kunci });
  ok('kunci salah ditolak mother base; data tetap menunggu di toko');

  // Shift masih berjalan: omzet sudah terlihat di mother base
  let r = await mb.kirim();
  assert.deepStrictEqual([r.shift, r.penerimaan, r.mutasi, r.opname, r.snapshot], [0, 2, 4, 2, true]);
  const ring = () => q("select jumlah_transaksi || '|' || omzet || '|' || tunai || '|' || qris || '|' || transfer from v_ringkasan_harian where kode_toko='TRP'");
  const harap = `3|${4 * 15000 + 85000 + 30000 + 25000}.00|${4 * 15000 + 85000}.00|30000.00|25000.00`;
  assert.strictEqual(ring(), harap);
  assert.strictEqual(q("select tutup_at is null from shift where kode_toko='TRP'"), 't');
  ok('dikirim langsung lewat RPC (peran anon): dokumen, stok, dan shift berjalan; omzet Tunai/QRIS/Transfer');

  // Tutup shift → antrean → terkirim; shift tertutup menggantikan potongan shift berjalan
  tidur(1100);
  T.archiveShift({ notes: 'tutup uji' });
  r = await mb.kirim();
  assert.strictEqual(r.shift, 1);
  assert.strictEqual(q("select tutup_at is not null from shift where kode_toko='TRP'"), 't');
  assert.strictEqual(ring(), harap);
  assert.strictEqual(T.mbStatus().pending_shifts, 0);
  assert.strictEqual(q(`select qty from v_permintaan_harian where kode_toko='TRP' and sku='UJ-KESET' and kanal='SHOPEE'`), '3.000');
  ok('tutup shift terkirim; shift berjalan diganti data tutup shift, tidak dobel');

  // Kirim ulang semuanya (mis. database toko dipulihkan): tidak ada yang dobel
  const db0 = q('select (select count(*) from penjualan) || ' + "'|'" + ' || (select count(*) from penerimaan_toko_baris) || ' + "'|'" + ' || (select count(*) from mutasi_toko_baris)');
  T.mbSaveConfig({ kode_toko: 'KRP' }); T.mbSaveConfig({ kode_toko: 'TRP' }); // reset penanda → kirim ulang semua dokumen & stok
  T.mbQueueHistory();
  r = await mb.kirim();
  assert.ok(r.mutasi === 4 && r.snapshot);
  assert.strictEqual(q('select (select count(*) from penjualan) || ' + "'|'" + ' || (select count(*) from penerimaan_toko_baris) || ' + "'|'" + ' || (select count(*) from mutasi_toko_baris)'), db0);
  assert.strictEqual(ring(), harap);
  ok('kiriman ulang aman: tidak ada penjualan, penerimaan, atau mutasi yang dobel');

  // Batal nota (PIN Admin): nota asli tetap, nota BTL- berisi barang minus; rinciannya ikut shift ke pembatalan_nota
  T.saveUser({ name: 'Bu Admin', role: 'admin', pin: '246810', active: true });
  T.openShift({ cashier_name: 'Dewi' });
  const notaBatal = T.checkout({ items: [{ sku: 'UJ-KESET', qty: 2 }, { sku: 'UJ-EMBER', qty: 1 }], payment_method: 'Tunai', cash_received: 1e5 });
  T.checkout({ items: [{ sku: 'UJ-KESET', qty: 1 }], payment_method: 'Tunai', cash_received: 1e5 });
  const vb = T.voidReceipt({ receipt_no: notaBatal.receipt_no, reason: 'Pelanggan batal beli', requested_by: 'Dewi', approver_pin: '246810',
    items: [{ sku: 'UJ-KESET', destination: 'floor' }, { sku: 'UJ-EMBER', destination: 'damaged' }] });
  const uidBatal = T.getShift().shift_uid;
  await mb.kirim();
  const batalRow = () => q("select no_batal || '|' || no_struk_asal || '|' || alasan || '|' || diminta_oleh || '|' || disetujui_oleh || '|' || total from pembatalan_nota where kode_toko = 'TRP'");
  const harapBatal = `${vb.receipt_no}|${notaBatal.receipt_no}|Pelanggan batal beli|Dewi|Bu Admin|55000.00`;
  assert.strictEqual(batalRow(), harapBatal); // dari shift berjalan (snapshot)
  // Nota BTL- bukan transaksi (nota asal tetap dihitung, sama seperti Trizone); omzet bersih; nilai pembatalan terpisah
  const omzetBatal = 4 * 15000 + 85000 + 30000 + 25000 + 15000;
  assert.strictEqual(q("select jumlah_transaksi || '|' || omzet || '|' || pembatalan || '|' || jumlah_pembatalan from v_ringkasan_harian where kode_toko='TRP'"),
    `5|${omzetBatal}.00|55000.00|1`);
  assert.strictEqual(q("select jumlah_transaksi || '|' || pembatalan || '|' || jumlah_pembatalan from public.laporan_harian(mb.tgl_wib(now()), mb.tgl_wib(now()), 'TRP')"), '5|55000.00|1');
  // Omzet per kategori: SPECIAL + HOUSEWARE + lainnya = omzet (bersih)
  const katAsli = q("select coalesce(json_agg(json_build_object('t', 'produk_toko', 'k', kode_toko, 's', sku, 'v', kategori)), '[]') from produk_toko where sku in ('UJ-KESET', 'UJ-EMBER')");
  const katProduk = q("select coalesce(json_agg(json_build_object('s', sku, 'v', kategori)), '[]') from produk where sku in ('UJ-KESET', 'UJ-EMBER')");
  for (const t of ['produk', 'produk_toko']) {
    q(`update ${t} set kategori = 'special' where sku = 'UJ-KESET'`);
    q(`update ${t} set kategori = 'HOUSEWARE' where sku = 'UJ-EMBER'`);
  }
  const [oTotal, oSp, oHw, oLain] = q("select omzet || '|' || omzet_special || '|' || omzet_houseware || '|' || omzet_lain from public.laporan_harian(mb.tgl_wib(now()), mb.tgl_wib(now()), 'TRP')").split('|').map(Number);
  const omzetSku = (sku) => Number(q(`select coalesce(sum(subtotal), 0) from penjualan where kode_toko = 'TRP' and sku = '${sku}' and tanggal = mb.tgl_wib(now())`));
  assert.deepStrictEqual([oSp, oHw, oSp + oHw + oLain], [omzetSku('UJ-KESET'), omzetSku('UJ-EMBER'), oTotal]);
  for (const x of JSON.parse(katAsli)) q(`update produk_toko set kategori = ${x.v === null ? 'null' : `'${x.v}'`} where kode_toko = '${x.k}' and sku = '${x.s}'`);
  for (const x of JSON.parse(katProduk)) q(`update produk set kategori = ${x.v === null ? 'null' : `'${x.v}'`} where sku = '${x.s}'`);
  assert.strictEqual(q("select jumlah_transaksi || '|' || pembatalan from public.laporan_ringkasan(mb.tgl_wib(now()), mb.tgl_wib(now())) where kode_toko = 'TRP'"), '5|55000.00');
  assert.strictEqual(q("select jumlah_struk || '|' || nilai || '|' || pembatalan || '|' || jumlah_pembatalan from v_penjualan_kasir where kode_toko='TRP' and kasir='Dewi'"), '2|15000.00|55000.00|1');

  tidur(1100);
  T.archiveShift({ notes: 'tutup uji batal' });
  r = await mb.kirim();
  assert.strictEqual(r.shift, 1);
  assert.strictEqual(batalRow(), harapBatal); // diganti data tutup shift, tidak dobel
  const lap = JSON.parse(q("select json_agg(x) from public.laporan_pembatalan(mb.tgl_wib(now()) - 1, mb.tgl_wib(now()), 'TRP') x"));
  assert.deepStrictEqual([lap.length, lap[0].no_batal, lap[0].no_struk_asal, lap[0].kasir, lap[0].qty, lap[0].total, lap[0].alasan, lap[0].diminta_oleh, lap[0].disetujui_oleh],
    [1, vb.receipt_no, notaBatal.receipt_no, 'Dewi', 3, 55000, 'Pelanggan batal beli', 'Dewi', 'Bu Admin']);
  assert.ok(lap[0].waktu_struk_asal && lap[0].waktu_struk_asal <= lap[0].waktu);
  // Kiriman ulang dari Trizone versi lama (tanpa daftar pembatalan) tidak menghapus rincian; daftar kosong mengganti (dicoba lalu rollback)
  const kirimLama = (extra) => q(`begin;
    select public.terima_data(${lit({ protokol: 1, kode_toko: 'TRP', kunci, shifts: [{ shift: { shift_uid: uidBatal, cashier_name: 'Dewi', closed_at: '2099-12-31 23:59:59' }, sales: [], ...extra }] })})->>'ok';
    select count(*) from pembatalan_nota where shift_uid = '${uidBatal}'; rollback`).split('\n');
  assert.deepStrictEqual(kirimLama({}), ['true', '1']);
  assert.deepStrictEqual(kirimLama({ pembatalan: [] }), ['true', '0']);
  assert.strictEqual(batalRow(), harapBatal);
  assert.strictEqual(q("select max((jumlah->>'pembatalan')::int) from kiriman_log where kode_toko = 'TRP'"), '1');
  ok('batal nota: rincian (nota asal, alasan, peminta, Admin penyetuju) masuk mother base; BTL- bukan transaksi, tampil sebagai pembatalan');

  // Pesanan pelanggan: dibuat, diambil, dibatalkan di Trizone → ikut snapshot → tersimpan di mother base
  T.openShift({ cashier_name: 'Dewi' });
  const besok = new Date(Date.now() + 31 * 3600e3).toISOString().slice(0, 10);
  const ps1 = T.createOrder({ items: [{ sku: 'UJ-KESET', qty: 2 }, { sku: 'UJ-EMBER', qty: 1 }], customer_name: 'Ibu Ani', customer_phone: '081234', pickup_date: besok, deposit: 10000, notes: 'warna biru' });
  const ps2 = T.createOrder({ items: [{ sku: 'UJ-KESET', qty: 1 }], customer_name: 'Pak Joko', pickup_date: besok });
  const ambil = T.completeOrder({ order_no: ps2.order_no, zone: 'floor', cash_received: 50000, done_by: 'Dewi' });
  const ps3 = T.createOrder({ items: [{ sku: 'UJ-EMBER', qty: 2 }], customer_name: 'Mbak Sri', pickup_date: besok, deposit: 5000 });
  T.cancelOrder({ order_no: ps3.order_no, reason: 'Tidak jadi beli', deposit_action: 'kembali', approver_pin: '246810', requested_by: 'Dewi' });
  await mb.kirim();
  const pesanan = () => JSON.parse(q(`select json_agg(x order by x.no_pesanan) from public.laporan_pesanan(null, 'TRP') x`));
  let ps = pesanan();
  assert.deepStrictEqual(ps.map((p) => [p.no_pesanan, p.status]), [[ps1.order_no, 'baru'], [ps2.order_no, 'diambil'], [ps3.order_no, 'batal']]);
  assert.deepStrictEqual([ps[0].nama_pelanggan, ps[0].hp, ps[0].catatan, ps[0].deposit, ps[0].sisa, ps[0].jumlah_barang, ps[0].lewat, ps[0].tanggal_ambil],
    ['Ibu Ani', '081234', 'warna biru', 10000, ps1.total - 10000, 2, false, besok]);
  assert.deepStrictEqual([ps[1].no_nota, ps[1].zona_ambil, ps[1].selesai_oleh, ps[1].sisa], [ambil.receipt.receipt_no, 'floor', 'Dewi', 0]);
  assert.deepStrictEqual([ps[2].alasan_batal, ps[2].deposit_batal, ps[2].batal_disetujui_oleh], ['Tidak jadi beli', 'kembali', 'Bu Admin']);
  assert.strictEqual(q(`select string_agg(sku || 'x' || qty::int, ',' order by baris_ke) from pesanan_toko_baris where no_pesanan = '${ps1.order_no}'`), 'UJ-KESETx2,UJ-EMBERx1');
  // Kiriman ulang (force) tidak dobel; pesanan yang diambil belakangan ikut berubah
  T.completeOrder({ order_no: ps1.order_no, zone: 'floor', cash_received: ps1.total, done_by: 'Dewi' });
  await mb.kirim({ force: true });
  ps = pesanan();
  assert.deepStrictEqual(ps.map((p) => p.status), ['diambil', 'diambil', 'batal']);
  assert.strictEqual(q(`select count(*) from pesanan_toko_baris where no_pesanan = '${ps1.order_no}'`), '2');
  assert.strictEqual(q("select count(*) from public.laporan_pesanan('baru', 'TRP')"), '0');
  T.archiveShift({ notes: 'tutup uji pesanan' });
  await mb.kirim();
  ok('pesanan pelanggan: baru / diambil / batal dengan deposit, nota, alasan & penyetuju, dan barangnya masuk mother base; kiriman ulang tidak dobel');

  // Surat jalan Accurate
  const imp = JSON.parse(q(`select public.import_surat_jalan(${lit(acc.payloadMotherBase(hasil, 'uji.xlsx'))})`));
  assert.strictEqual(imp.do_baru, 4);
  assert.deepStrictEqual(imp.pelanggan_belum_dipetakan, ['Utama']);
  const status = Object.fromEntries(q('select no_sj, status from v_pencocokan_sj').split('\n').map((l) => l.split('|')));
  assert.deepStrictEqual(status, {
    'DO.UJI.0001': 'COCOK', 'DO.UJI.0002': 'BELUM_DIINPUT', 'DO.UJI.0003': 'PELANGGAN_BELUM_DIPETAKAN', 'DO.UJI.0004': 'SELISIH_QTY',
  });
  assert.strictEqual(q(`select qty_biji from v_sj_baris_biji where no_sj='DO.UJI.0001' and kode='UJ-KURSI'`), '12.000');
  assert.strictEqual(JSON.parse(q(`select public.import_surat_jalan(${lit(acc.payloadMotherBase(hasil, 'uji.xlsx'))})`)).do_diganti, 4);
  assert.strictEqual(q('select count(*) from surat_jalan_baris'), '5');
  ok('surat jalan: Cocok, Belum diinput, Pelanggan belum dipetakan, Selisih qty; Coly dikali isi; impor ulang tidak dobel');

  // Stok seharusnya vs Trizone setelah SO disetujui
  assert.strictEqual(q("select count(*) from stok_opname_review where status='BARU'"), '2');
  q("update stok_opname_review set status='DISETUJUI'");
  assert.strictEqual(q('select count(*) from v_selisih_snapshot'), '0', 'selisih:\n' + q('select * from v_selisih_snapshot'));
  assert.strictEqual(q(`select stok_seharusnya from v_stok_seharusnya where kode_toko='TRP' and sku='UJ-KESET' and zona='floor'`),
    `${T.getProduct('UJ-KESET').floor_stock}.000`);
  ok('stok seharusnya per zona (SO + penerimaan − jual ± mutasi) sama persis dengan stok Trizone');

  // Batal mutasi & penerimaan di toko (PIN Admin): dokumen tetap, ditandai batal, stok dikembalikan saat dibatalkan.
  // Dokumen yang dibuat sesudah SO patokan: dokumen + pembaliknya = nol.
  const docMt = (alasan) => T.listTransferDocs({}).find((d) => d.reason === alasan);
  const batalMt = (alasan, why) => T.cancelTransferDoc({ id: docMt(alasan).id, reason: why, requested_by: 'Dewi', approver_pin: '246810' });
  batalMt('Pesanan', 'Pesanan Shopee dibatalkan pembeli');
  batalMt('Stok online', 'Salah pilih zona');
  const rc4 = T.listReceptions({}).find((x) => x.reference_no === 'DO.UJI.0004');
  T.cancelReception({ id: rc4.id, reason: 'Barang dikembalikan ke kantor', requested_by: 'Dewi', approver_pin: '246810' });
  assert.deepStrictEqual(T.mbBatch({ force: true }).snapshot.dokumen_batal.map((d) => [d.jenis, d.no_dokumen]),
    [['mutasi', docMt('Stok online').doc_no], ['mutasi', docMt('Pesanan').doc_no], ['penerimaan', 'DO.UJI.0004']]);
  tidur(1100);
  r = await mb.kirim();
  assert.ok(r.snapshot);
  const batalDb = () => q(`select string_agg(no_dok || '|' || alasan_batal || '|' || batal_diminta_oleh || '|' || batal_disetujui_oleh, ';' order by no_dok)
    from mutasi_toko where kode_toko = 'TRP' and dibatalkan_at is not null`);
  assert.strictEqual(batalDb(), [docMt('Stok online'), docMt('Pesanan')].sort((a, b) => a.doc_no.localeCompare(b.doc_no))
    .map((d) => `${d.doc_no}|${d.cancel_reason}|Dewi|Bu Admin`).join(';'));
  assert.strictEqual(q("select alasan_batal || '|' || batal_disetujui_oleh || '|' || (dibatalkan_at > diterima_at) from penerimaan_toko where no_sj = 'DO.UJI.0004'"),
    'Barang dikembalikan ke kantor|Bu Admin|true');
  assert.strictEqual(q("select count(*) from penerimaan_toko where kode_toko = 'TRP' and dibatalkan_at is null"), '1');
  const stokSama = (pesan) => {
    assert.strictEqual(q('select count(*) from v_selisih_snapshot'), '0', `${pesan}:\n` + q('select * from v_selisih_snapshot'));
    for (const [zona, kolom] of [['floor', 'floor_stock'], ['warehouse', 'warehouse_stock'], ['shopee', 'shopee_stock']]) {
      assert.strictEqual(q(`select stok_seharusnya from v_stok_seharusnya where kode_toko='TRP' and sku='UJ-KESET' and zona='${zona}'`),
        `${T.getProduct('UJ-KESET')[kolom]}.000`, `${pesan} (${zona})`);
    }
  };
  stokSama('selisih setelah batal');
  // Laporan: Shopee terjual tidak dihitung; SJ DO.UJI.0004 kembali belum diinput; daftar dokumen bertanda batal
  assert.strictEqual(q(`select count(*) from v_permintaan_harian where kode_toko='TRP' and kanal='SHOPEE'`), '0');
  assert.match(q("select status from v_pencocokan_sj where no_sj = 'DO.UJI.0004'"), /^(BELUM_DIINPUT|MENUNGGU)$/);
  assert.strictEqual(q("select status from v_pencocokan_sj where no_sj = 'DO.UJI.0001'"), 'COCOK');
  assert.strictEqual(q("select count(*) from v_sj_banding where no_sj = 'DO.UJI.0004' and terima_biji is not null"), '0');
  const dokLap = JSON.parse(q("select json_agg(x) from public.laporan_dokumen_toko(mb.tgl_wib(now()) - 1, mb.tgl_wib(now()), 'TRP') x"));
  assert.strictEqual(dokLap.filter((d) => d.dibatalkan_at).length, 3);
  assert.deepStrictEqual(dokLap.filter((d) => d.jenis === 'penerimaan').map((d) => [d.no_dokumen, !!d.dibatalkan_at]).sort(),
    [['DO.UJI.0001', false], ['DO.UJI.0004', true]]);
  assert.strictEqual(q("select count(*) from public.laporan_dokumen_toko(mb.tgl_wib(now()) - 1, mb.tgl_wib(now()), 'TRP', 'mutasi')"), q("select count(*) from mutasi_toko where kode_toko = 'TRP'"));
  // SO disetujui DI ANTARA mutasi dan pembatalannya: mutasinya sudah termasuk di SO, hanya pembaliknya yang dihitung
  T.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', reason: 'Antara SO', items: [{ sku: 'UJ-KESET', qty: 1 }] });
  tidur(1100);
  T.createOpname({ zone: 'floor', notes: 'SO antara', items: [{ sku: 'UJ-KESET', counted: T.getProduct('UJ-KESET').floor_stock }] });
  tidur(1100);
  await mb.kirim();
  q("update stok_opname_review set status='DISETUJUI'");
  stokSama('selisih sebelum batal (SO antara)');
  tidur(1100);
  batalMt('Antara SO', 'Uji SO di antara');
  await mb.kirim();
  stokSama('selisih setelah batal (SO antara)');
  // Kiriman ulang (semua dokumen + snapshot) tidak dobel dan tidak menghapus tanda batal
  const tandaBatal = () => q("select string_agg(no_dok || dibatalkan_at, ',' order by no_dok) from mutasi_toko where dibatalkan_at is not null")
    + q("select string_agg(no_sj || dibatalkan_at, ',') from penerimaan_toko where dibatalkan_at is not null");
  const tanda0 = tandaBatal();
  const nDok = () => q('select (select count(*) from mutasi_toko) || \'|\' || (select count(*) from mutasi_toko_baris) || \'|\' || (select count(*) from penerimaan_toko_baris)');
  const nDok0 = nDok();
  T.mbSaveConfig({ kode_toko: 'KRP' }); T.mbSaveConfig({ kode_toko: 'TRP' });
  r = await mb.kirim({ force: true });
  assert.ok(r.mutasi >= 4 && r.snapshot);
  assert.deepStrictEqual([tandaBatal(), nDok()], [tanda0, nDok0]);
  assert.strictEqual(q("select mb.terapkan_dokumen_batal('TRP', " + lit(T.mbBatch({ force: true }).snapshot.dokumen_batal) + ')'), '0'); // isi sama → tidak ditulis ulang
  // Pembatalan yang sampai sebelum dokumennya dilewati; dokumen tidak dikenal tidak membuat baris baru
  assert.strictEqual(q(`select mb.terapkan_dokumen_batal('TRP', ${lit([{ jenis: 'mutasi', no_dokumen: 'MT-TIDAK-ADA', cancelled_at: '2026-11-20 10:00:00' }])})`), '0');
  ok('batal mutasi & penerimaan (PIN): ditandai batal dengan alasan/peminta/penyetuju, stok seharusnya tetap = Trizone, Shopee & SJ tidak menghitungnya, kiriman ulang tidak dobel');

  // Master barang: kantor mengisi dari toko, mengubah harga & menambah barang; toko yang terkunci mengambilnya
  assert.strictEqual(q(`select public.isi_master_dari_toko('TRP')`), '3');
  q(`update produk set harga_jual_konsumen = 16000 where sku = 'UJ-KESET'`);
  q(`insert into produk (sku, nama, barcode, merk, kategori, harga_jual_konsumen, satuan_masuk, rasio_isi)
     values ('UJ-BARU', 'Barang Baru Uji', '2000000000132', 'M', 'K', 7000, 'Coly', 4)`);
  T.mbSaveConfig({ kunci_master: true });
  assert.throws(() => T.saveProduct({ product: { ...T.getProduct('UJ-KESET'), unit_price: 1 } }), /dikunci/);
  const m = await mb.ambilMaster({ full: true });
  assert.deepStrictEqual([m.baru, m.diubah, m.dilewati.length], [1, 1, 0]);
  assert.strictEqual(T.getProduct('UJ-KESET').unit_price, 16000);
  assert.deepStrictEqual([T.getProduct('UJ-BARU').pack_unit, T.getProduct('UJ-BARU').pack_ratio, T.getProduct('UJ-BARU').floor_stock], ['Coly', 4, 0]);
  const m2 = await mb.ambilMaster();
  assert.strictEqual(m2.jumlah, 0); // tidak ada perubahan sejak pengambilan terakhir
  assert.strictEqual((await mb.tes()).kode_toko, 'TRP');
  ok('master barang & harga diambil toko yang terkunci; hanya perubahan yang diambil berikutnya');

  // Hak akses
  q(`insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b')`);
  q(`insert into pengguna values ('00000000-0000-0000-0000-00000000000a','Pemilik Malang','pemilik_toko','MLG',true),
                                 ('00000000-0000-0000-0000-00000000000b','Admin','admin_kantor',null,true)`);
  const sebagai = (uid, sql) => q(`set role authenticated; set request.jwt.claim.sub = '${uid}'; ${sql}`);
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000a', 'select count(*) from penjualan'), '0');
  assert.notStrictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from penjualan'), '0');
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from toko_kunci'), '0');
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000a', 'select count(*) from pembatalan_nota'), '0');
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000a', 'select count(*) from public.laporan_dokumen_toko(current_date - 30, current_date + 1)'), '0');
  assert.notStrictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from public.laporan_dokumen_toko(current_date - 30, current_date + 1)'), '0');
  assert.throws(() => q('set role anon; select count(*) from public.laporan_dokumen_toko(current_date, current_date)'), /permission denied/);
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from public.laporan_pembatalan(mb.tgl_wib(now()) - 30, mb.tgl_wib(now()))'), '1');
  assert.strictEqual(q('set role anon; select count(*) from pembatalan_nota'), '0');
  assert.throws(() => q('set role anon; select count(*) from public.laporan_pembatalan(current_date, current_date)'), /permission denied/);
  assert.strictEqual(q('set role anon; select count(*) from penjualan'), '0');
  assert.strictEqual(q('set role anon; select count(*) from toko_kunci'), '0');
  assert.throws(() => q("set role anon; select public.buat_kunci_toko('TRP')"), /permission denied/);
  q(`insert into principal (nama) values ('P'); insert into po (no_po, principal_id) values ('PO-1', 1)`);
  assert.throws(() => sebagai('00000000-0000-0000-0000-00000000000b', "update po set status='DISETUJUI'"), /Hanya owner/);
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000a', 'select count(*) from pesanan_toko'), '0');
  assert.notStrictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from pesanan_toko'), '0');
  assert.strictEqual(q('set role anon; select count(*) from pesanan_toko'), '0');
  ok('anon hanya bisa memanggil RPC toko; pemilik toko lain tidak melihat data Tropodo (termasuk pesanan); kunci tidak terbaca; hanya owner menyetujui PO');

  // Import master barang dari Excel: dibaca seperti di browser, diperiksa & disimpan oleh import_produk
  const IB = require('../web/lib/import-barang');
  const buku = (aoa) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Data'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
  const ADMIN = '00000000-0000-0000-0000-00000000000b';
  const impor = (baris, simpan, uid = ADMIN) => JSON.parse(sebagai(uid, `select public.import_produk(${lit(baris)}, ${simpan}, '2026-11-10')`));
  const barisBaru = q("select barcode from produk where sku = 'UJ-BARU'");
  const diubahLama = q("select diubah_at from produk where sku = 'UJ-BARU'");
  const kesetLama = q("select nama, satuan_masuk, barcode from produk where sku = 'UJ-KESET'").split('|');
  const f1 = IB.bacaFile(buku([
    ['DAFTAR BARANG KANTOR'], [],
    ['sku', 'Nama Barang', 'BARCODE', 'Harga Jual', 'Satuan_Masuk', 'Rasio Isi Dus', 'Principal', 'Isi_Dus_Principal', 'Harga_Beli', 'Aktif', 'Stok_Awal_Toko'],
    ['UJ-KESET', null, null, 'Rp 17.500', null, null, null, null, null, null, 5],
    ['UJ-BARU', 'Barang Baru Uji', Number(barisBaru), 7000, 'Coly', 4, null, null, null, 'Ya', null],
    ['UJ-IMP1', 'Barang Import Satu', '2000000000200', 12500, 'Dus', 12, 'PT Uji Principal', 24, '9.250', 'ya', null],
    ['UJ-IMP2', null, '2000000000217', 5000, null, null, null, null, null, null, null],
    ['UJ-IMP3', 'Barcode Bentrok', barisBaru, 5000, null, null, null, null, null, null, null],
    ['UJ-IMP4', 'Harga Salah', '2000000000231', 'tiga ribu', null, null, null, null, null, 'mungkin', null],
    [null, 'Baris tanpa SKU', null, 1000],
  ]));
  assert.strictEqual(f1.format, 'template');
  assert.strictEqual(f1.barisJudul, 3);
  assert.deepStrictEqual(f1.tanpaSku, [10]);
  assert.deepStrictEqual(f1.masalah.map((m) => m.baris), [9, 9]);
  assert.strictEqual(f1.baris.find((r) => r.sku === 'UJ-KESET').harga_jual, 17500);
  assert.strictEqual(f1.baris.find((r) => r.sku === 'UJ-BARU').barcode, barisBaru);
  const cek1 = impor(f1.baris, false);
  assert.strictEqual(cek1.ok, false);
  assert.deepStrictEqual(cek1.error.map((e) => [e.baris, e.pesan.replace(/\d{13}/, 'B')]), [
    [5, 'Barcode B ada di lebih dari satu baris (5, 8)'], [7, 'Barang baru wajib ada nama'],
    [8, 'Barcode B ada di lebih dari satu baris (5, 8)'], [8, 'Barcode B sudah dipakai SKU UJ-BARU']]);
  assert.strictEqual(q("select count(*) from produk where sku like 'UJ-IMP%'"), '0');
  // Gagal disimpan bila masih ada kesalahan
  assert.strictEqual(impor(f1.baris, true).disimpan, false);
  assert.strictEqual(q("select count(*) from principal where nama = 'PT Uji Principal'"), '0');

  const bersih = f1.baris.filter((r) => ['UJ-KESET', 'UJ-BARU', 'UJ-IMP1'].includes(r.sku));
  const cek2 = impor(bersih, false);
  assert.deepStrictEqual([cek2.ok, cek2.jumlah, cek2.baru, cek2.diubah, cek2.sama, cek2.harga_beli], [true, 3, 1, 1, 1, 1]);
  assert.deepStrictEqual(cek2.principal_baru, []); // kolom Principal di file lama diabaikan
  assert.match(cek2.perubahan.find((x) => x.sku === 'UJ-KESET').detail, /harga jual: 16\.000 → 17\.500|harga jual: 16000 → 17500/);
  assert.throws(() => impor(bersih, true, '00000000-0000-0000-0000-00000000000a'), /Hanya pengguna kantor/);
  const simpan = impor(bersih, true);
  assert.strictEqual(simpan.disimpan, true);
  assert.deepStrictEqual(q("select harga_jual_konsumen, nama, satuan_masuk, barcode from produk where sku = 'UJ-KESET'").split('|'), ['17500.00', ...kesetLama]);
  assert.strictEqual(q("select diubah_at from produk where sku = 'UJ-BARU'"), diubahLama); // tidak berubah → tidak disentuh
  assert.deepStrictEqual(q(`select p.barcode, p.rasio_isi, p.principal_id is null, h.harga, h.berlaku_at, h.sumber from produk p
    join harga_beli h on h.sku = p.sku where p.sku = 'UJ-IMP1'`).split('|'),
    ['2000000000200', '12', 't', '9250.00', '2026-11-10', 'PRICELIST']);
  // Import ulang file yang sama: tidak ada perubahan, harga beli tidak dicatat dobel
  const ulang = impor(bersih, true);
  assert.deepStrictEqual([ulang.baru, ulang.diubah, ulang.sama, ulang.harga_beli], [0, 0, 3, 0]);
  assert.strictEqual(q("select count(*) from harga_beli where sku = 'UJ-IMP1'"), '1');
  // Toko yang terkunci hanya mengambil barang yang berubah
  const m3 = await mb.ambilMaster();
  assert.deepStrictEqual([m3.baru, m3.diubah], [1, 1]);
  assert.strictEqual(T.getProduct('UJ-KESET').unit_price, 17500);
  assert.strictEqual(T.getProduct('UJ-IMP1').pack_ratio, 12);

  // Format "data item" program lama: Kode Item jadi barcode barang baru
  const f2 = IB.bacaFile(buku([['Kode Item', 'Nama Item', 'Jenis', 'Rak', 'Stok', 'Satuan', 'Harga Jual'],
    ['UJ-DI1', 'Barang Data Item', 'Plastik', 'A1', 10, 'Pcs', 4500], ['UJ-KESET', '', '', '', 0, 'Pcs', 17500]]));
  assert.strictEqual(f2.format, 'data item');
  const s2 = impor(f2.baris, true);
  assert.deepStrictEqual([s2.disimpan, s2.baru, s2.sama], [true, 1, 1]);
  assert.deepStrictEqual(q("select barcode, kategori, harga_jual_konsumen from produk where sku = 'UJ-DI1'").split('|'), ['UJ-DI1', 'Plastik', '4500.00']);
  assert.strictEqual(q("select barcode from produk where sku = 'UJ-KESET'"), kesetLama[2]); // barang lama tetap barcode-nya
  ok('import barang Excel: template Trizone & data item, pratinjau, kesalahan per baris, simpan semua-atau-tidak, sel kosong = nilai lama, toko mengambil yang berubah saja');

  // Satuan masuk hanya Coly / Biji
  const f3 = IB.bacaFile(buku([['SKU', 'Nama_Barang', 'Barcode', 'Harga_Jual', 'Satuan_Masuk', 'Rasio_Isi_Dus'],
    ['UJ-SAT1', 'Satuan Karton', '2000000000301', 1000, 'karton', 6], ['UJ-SAT2', 'Satuan Pcs', '2000000000318', 1000, 'PCS', 1],
    ['UJ-SAT3', 'Satuan Aneh', '2000000000325', 1000, 'Bal', 10], ['UJ-SAT4', 'Biji Isi 12', '2000000000332', 1000, 'Biji', 12]]));
  const c3 = impor(f3.baris, false);
  assert.deepStrictEqual(c3.error.map((e) => e.baris), [4, 5]);
  assert.match(c3.error[0].pesan, /"Bal" tidak dikenal/);
  assert.match(c3.error[1].pesan, /Biji: isi per satuan masuk harus 1/);
  assert.strictEqual(impor(f3.baris.slice(0, 2), true).disimpan, true);
  assert.strictEqual(q("select string_agg(sku || '=' || satuan_masuk || '/' || rasio_isi, ',' order by sku) from produk where sku like 'UJ-SAT%'"), 'UJ-SAT1=Coly/6,UJ-SAT2=Biji/1');
  assert.throws(() => q("insert into produk (sku, nama, satuan_masuk) values ('UJ-SALAH', 'x', 'Dus')"), /produk_satuan_masuk_cek/);
  assert.throws(() => q("update produk set rasio_isi = 5 where sku = 'UJ-SAT2'"), /produk_satuan_masuk_cek/);
  assert.strictEqual(q("select count(*) from produk where satuan_masuk not in ('Coly', 'Biji')"), '0');
  ok('satuan masuk hanya Coly / Biji: Karton → Coly, Pcs → Biji, sebutan lain ditolak, Biji wajib isi 1');

  // Usulan beli tanpa principal: semua barang aktif, dibulatkan ke isi 1 Coly, lead time dari pengaturan
  q(`insert into shift (kode_toko, shift_uid, kasir, mulai_at, data_at) values ('MLG', 'UJI-USULAN', 'Uji', now(), now());
     insert into penjualan (kode_toko, shift_uid, no_struk, baris_ke, waktu, tanggal, sku, nama, qty, harga, subtotal, metode_bayar)
     values ('MLG', 'UJI-USULAN', 'U1', 1, now() - interval '1 day', current_date - 1, 'UJ-SAT1', 'Satuan Karton', 28, 1000, 28000, 'Tunai')`);
  const usul = (sku) => q(`select usulan_qty || '/' || isi_kemasan from public.laporan_usulan_beli() where sku = '${sku}'`);
  // 1 Biji/hari × (7 + 7) + 3 = 17 → dibulatkan ke isi 1 Coly (6) = 18
  assert.strictEqual(usul('UJ-SAT1'), '18/6');
  q(`update pengaturan set nilai = '10' where kunci = 'usulan_lead_time_hari'`);
  assert.strictEqual(usul('UJ-SAT1'), '24/6'); // 1 × (10 + 7) + 3 = 20 → 24
  const noPo = sebagai(ADMIN, 'select public.buat_po_dari_usulan()');
  assert.deepStrictEqual(q(`select coalesce(principal_id::text, '-'), status from po where no_po = '${noPo}'`).split('|'), ['-', 'USULAN']);
  assert.match(q(`select qty_usulan || ' ' || alasan from po_baris where no_po = '${noPo}' and sku = 'UJ-SAT1'`), /^24\.000 .*lead time 10 \+ periode 7 hari.*dibulatkan ke isi 1 Coly \(6 Biji\)/);
  assert.strictEqual(usul('UJ-SAT1'), '24/6'); // PO usulan belum dihitung sampai disetujui owner
  q(`update po set status = 'DISETUJUI' where no_po = '${noPo}'`);
  assert.strictEqual(usul('UJ-SAT1'), ''); // PO yang disetujui & belum datang mengurangi kebutuhan
  assert.throws(() => sebagai('00000000-0000-0000-0000-00000000000a', 'select public.buat_po_dari_usulan()'), /Hanya pengguna kantor/);
  ok('usulan beli tanpa principal: semua barang, lead time dari pengaturan, dibulatkan ke isi 1 Coly, satu PO');

  // ---------------------------------------------------------------- Tarik data & stock opname dari kantor
  const OWNER = '00000000-0000-0000-0000-00000000000c';
  const PURCH = '00000000-0000-0000-0000-00000000000d';
  const PTRP = '00000000-0000-0000-0000-00000000000e';
  const PMLG = '00000000-0000-0000-0000-00000000000a';
  q(`insert into auth.users values ('${OWNER}'), ('${PURCH}'), ('${PTRP}')`);
  q(`insert into pengguna values ('${OWNER}','Owner Uji','owner',null,true), ('${PURCH}','Purchasing Uji','purchasing',null,true),
                                 ('${PTRP}','Pemilik Tropodo','pemilik_toko','TRP',true)`);
  await mb.kirim({ force: true });
  const cek = (p) => JSON.parse(q(`set role anon; select public.cek_permintaan(${lit(p)})`));
  assert.throws(() => sebagai(PMLG, "select public.minta_update_toko('TRP')"), /hanya untuk toko Anda/);
  assert.throws(() => q("set role anon; select public.minta_update_toko('TRP')"), /permission denied/);
  assert.strictEqual(sebagai(ADMIN, 'select public.minta_update_toko()'), q('select count(*) from toko where aktif'));
  assert.strictEqual(sebagai(PTRP, 'select public.minta_update_toko()'), '1'); // pemilik toko: tokonya sendiri
  assert.strictEqual(sebagai(PTRP, "select minta_update_oleh from public.status_koneksi_toko() where kode = 'TRP'"), 'Pemilik Tropodo');
  assert.strictEqual(cek({ kode_toko: 'TRP', kunci }).minta, true);
  assert.throws(() => cek({ kode_toko: 'TRP', kunci: 'salah' }), /kunci toko salah/);
  tidur(1100);
  let jawab = await mb.cekPermintaan();
  assert.ok(jawab.minta && jawab.kirim, JSON.stringify(jawab));
  assert.strictEqual(cek({ kode_toko: 'TRP', kunci }).minta, false); // terjawab oleh kiriman yang lebih baru
  assert.strictEqual(sebagai(ADMIN, "select coalesce(minta_update_at::text, '-') from public.status_koneksi_toko() where kode = 'TRP'"), '-');

  const stokPer = q("select to_char(max(per_waktu) at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') from stok_toko where kode_toko = 'TRP'");
  const kesetDisplay = Number(q("select display from stok_toko where kode_toko = 'TRP' and sku = 'UJ-KESET'"));
  const kursiDisplay = Number(q("select display from stok_toko where kode_toko = 'TRP' and sku = 'UJ-KURSI'"));
  assert.strictEqual(kesetDisplay, T.getProduct('UJ-KESET').floor_stock);
  const dok = [{ zona: 'floor', stok_per: stokPer, baris: [{ sku: 'UJ-KESET', patokan: kesetDisplay, fisik: kesetDisplay - 3 }, { sku: 'UJ-KURSI', patokan: kursiDisplay, fisik: kursiDisplay }] }];
  const buatOpk = (uid, d, cat = 'Uji kantor') => JSON.parse(sebagai(uid, `select public.buat_opname_kantor('TRP', '${cat}', ${lit(d)})`));
  assert.throws(() => buatOpk(PURCH, dok), /hanya owner dan admin kantor/);
  assert.throws(() => buatOpk(PTRP, dok), /hanya owner dan admin kantor/);
  assert.throws(() => buatOpk(OWNER, [{ ...dok[0], baris: [{ sku: 'TIDAK-ADA', patokan: 1, fisik: 1 }] }]), /tidak ada di Daftar Barang toko TRP: TIDAK-ADA/);
  assert.throws(() => buatOpk(OWNER, [{ ...dok[0], baris: [{ sku: 'UJ-KESET', patokan: 1, fisik: 1.5 }] }]), /bilangan bulat/);
  assert.throws(() => buatOpk(OWNER, [{ ...dok[0], zona: 'kasir' }]), /Zona opname "kasir" tidak dikenal/);
  const dibuat = buatOpk(OWNER, dok);
  assert.strictEqual(dibuat.length, 1);
  assert.match(dibuat[0].no_dok, /^OPK-\d{8}-001$/);
  assert.throws(() => buatOpk(ADMIN, dok), /masih menunggu toko: OPK-\d{8}-001 \(UJ-KESET\)/);
  assert.strictEqual(sebagai(PTRP, 'select count(*) from opname_kantor'), '0');
  assert.strictEqual(cek({ kode_toko: 'TRP', kunci }).opname[0].baris.length, 2);
  // Toko memindah 1 Keset dari display setelah stok ditarik, sebelum opname masuk: tetap terhitung
  T.createTransferDoc({ from_zone: 'floor', to_zone: 'warehouse', reason: 'Uji', items: [{ sku: 'UJ-KESET', qty: 1 }] });
  const kesetSebelum = T.getProduct('UJ-KESET').floor_stock;
  tidur(1100);
  jawab = await mb.cekPermintaan();
  assert.strictEqual(jawab.opname.length, 1, JSON.stringify(jawab));
  assert.strictEqual(T.getProduct('UJ-KESET').floor_stock, kesetSebelum - 3);
  const opk = q(`select o.status || '|' || o.no_op_toko || '|' || r.status || '|' || r.catatan || '|' || (r.direview_oleh = '${OWNER}')
                 from opname_kantor o join stok_opname_review r on r.kode_toko = o.kode_toko and r.no_op = o.no_op_toko`).split('|');
  assert.deepStrictEqual([opk[0], opk[2], opk[4]], ['diterapkan', 'DISETUJUI', 'true']);
  assert.match(opk[1], /^OP-/);
  assert.strictEqual(opk[3], `Opname dari kantor ${dibuat[0].no_dok}`);
  assert.strictEqual(T.listOpnames({}).find((d) => d.doc_no === opk[1]).notes, `Opname kantor ${dibuat[0].no_dok} · Uji kantor`);
  assert.deepStrictEqual(sebagai(ADMIN, 'select jumlah_barang || \'|\' || jumlah_selisih || \'|\' || minus_qty || \'|\' || status from public.laporan_opname_kantor()').split('|'), ['2', '1', '3.000', 'diterapkan']);
  assert.throws(() => buatOpk(OWNER, dok), /sudah diopname kantor setelah stok di file/); // file lama dikirim lagi
  jawab = await mb.cekPermintaan();
  assert.strictEqual(jawab.opname.length, 0);
  assert.strictEqual(T.getProduct('UJ-KESET').floor_stock, kesetSebelum - 3);
  // Batal sebelum toko menerapkan
  const per2 = q("select to_char(max(per_waktu) at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') from stok_toko where kode_toko = 'TRP'");
  const dok2 = buatOpk(ADMIN, [{ zona: 'warehouse', stok_per: per2, baris: [{ sku: 'UJ-EMBER', patokan: 0, fisik: 5 }] }], 'Salah');
  assert.throws(() => sebagai(PURCH, `select public.batal_opname_kantor(${dok2[0].id}, 'salah hitung')`), /hanya owner dan admin kantor/);
  assert.throws(() => sebagai(ADMIN, `select public.batal_opname_kantor(${dok2[0].id}, 'x')`), /minimal 3 huruf/);
  sebagai(ADMIN, `select public.batal_opname_kantor(${dok2[0].id}, 'salah hitung')`);
  assert.throws(() => sebagai(ADMIN, `select public.batal_opname_kantor(${dok2[0].id}, 'salah hitung')`), /sudah dibatalkan/);
  assert.strictEqual(cek({ kode_toko: 'TRP', kunci }).opname.length, 0);
  assert.strictEqual(q('set role anon; select count(*) from opname_kantor'), '0');
  assert.throws(() => q("set role anon; select public.buat_opname_kantor('TRP', null, '[]')"), /permission denied/);
  assert.throws(() => sebagai(ADMIN, `select public.opname_diterapkan(${lit({ kode_toko: 'TRP', kunci, hasil: [] })})`), /permission denied/);
  ok('tarik data: kantor semua toko / pemilik hanya tokonya, toko menjawab lalu permintaan selesai; opname kantor: hanya owner & admin, diterapkan dengan patokan, review SO otomatis, tidak dobel, batal');

  // ---------------------------------------------------------------- Riwayat stok 7 hari (stok per jam untuk opname kantor)
  const snapTerakhir = () => q("select max(per_waktu) from toko_snapshot_waktu where kode_toko = 'TRP'");
  const snap1 = snapTerakhir();
  const kesetS1 = Number(q("select display from stok_toko where kode_toko = 'TRP' and sku = 'UJ-KESET'"));
  T.createTransferDoc({ from_zone: 'floor', to_zone: 'warehouse', reason: 'Uji riwayat', items: [{ sku: 'UJ-KESET', qty: 2 }] });
  tidur(1100);
  await mb.kirim({ force: true });
  const snap2 = snapTerakhir();
  assert.notStrictEqual(snap2, snap1);
  assert.strictEqual(q(`select string_agg(sku, ',' order by sku) from stok_toko_riwayat where kode_toko = 'TRP' and per_waktu = '${snap2}'`), 'UJ-KESET'); // hanya yang berubah
  const stokPada = (uid, w) => JSON.parse(sebagai(uid, `select public.stok_toko_per('TRP', ${w ? `'${w}'` : 'null'})`));
  const barisSku = (r, sku) => r.baris.find((b) => b.sku === sku);
  const lamaS1 = stokPada(ADMIN, snap1);
  assert.strictEqual(Date.parse(lamaS1.per_waktu), Date.parse(snap1.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')));
  assert.strictEqual(Number(barisSku(lamaS1, 'UJ-KESET').display), kesetS1);
  const kini = stokPada(ADMIN, null);
  assert.strictEqual(Number(barisSku(kini, 'UJ-KESET').display), kesetS1 - 2);
  assert.strictEqual(Number(barisSku(kini, 'UJ-KESET').gudang), T.getProduct('UJ-KESET').warehouse_stock);
  assert.deepStrictEqual([barisSku(kini, 'UJ-KURSI').satuan_masuk, barisSku(kini, 'UJ-KURSI').isi], ['Coly', 6]);
  assert.deepStrictEqual([barisSku(kini, 'UJ-KESET').satuan_masuk, barisSku(kini, 'UJ-KESET').isi], ['Biji', 1]);
  const sebelumRiwayat = stokPada(ADMIN, '2000-01-01T00:00:00Z');
  assert.deepStrictEqual([sebelumRiwayat.per_waktu, sebelumRiwayat.baris.length, !!sebelumRiwayat.paling_awal], [null, 0, true]);
  assert.strictEqual(sebagai(PMLG, "select count(*) from stok_toko_riwayat where kode_toko = 'TRP'"), '0');
  assert.strictEqual(stokPada(PMLG, null).baris.length, 0);
  assert.throws(() => q("set role anon; select public.stok_toko_per('TRP', null)"), /permission denied/);

  // Stok lama sebagai patokan ditolak bila toko sudah membuat SO barang itu sesudahnya
  T.createOpname({ zone: 'floor', notes: 'Opname toko', items: [{ sku: 'UJ-EMBER', counted: T.getProduct('UJ-EMBER').floor_stock + 1 }] });
  tidur(1100);
  await mb.kirim();
  const s1Teks = q(`select to_char('${snap1}'::timestamptz at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS')`);
  const emberS1 = Number(barisSku(lamaS1, 'UJ-EMBER').display);
  assert.throws(() => buatOpk(OWNER, [{ zona: 'floor', stok_per: s1Teks, baris: [{ sku: 'UJ-EMBER', patokan: emberS1, fisik: emberS1 }] }]),
    /Toko sudah membuat stok opname untuk barang ini setelah stok di file: OP-\d{8}-\d{3} \(UJ-EMBER\)/);
  const baruS1 = Number(barisSku(lamaS1, 'UJ-BARU').display);
  const opkLama = buatOpk(OWNER, [{ zona: 'floor', stok_per: s1Teks, baris: [{ sku: 'UJ-BARU', patokan: baruS1, fisik: baruS1 }] }]);
  assert.strictEqual(q(`select to_char(stok_per at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') from opname_kantor where id = ${opkLama[0].id}`), s1Teks);
  sebagai(OWNER, `select public.batal_opname_kantor(${opkLama[0].id}, 'uji selesai')`);

  // Lebih dari 7 hari: waktu snapshot lama dihapus; tiap barang tetap punya satu baris dasar sebelum batas
  q(`update toko_snapshot_waktu set per_waktu = per_waktu - interval '8 days' where kode_toko = 'TRP';
     update stok_toko_riwayat set per_waktu = per_waktu - interval '8 days' where kode_toko = 'TRP'`);
  assert.ok(Number(q("select count(*) from stok_toko_riwayat where kode_toko = 'TRP' and sku = 'UJ-KESET'")) >= 3);
  T.createTransferDoc({ from_zone: 'warehouse', to_zone: 'floor', reason: 'Uji riwayat', items: [{ sku: 'UJ-KESET', qty: 1 }] });
  tidur(1100);
  await mb.kirim({ force: true });
  assert.strictEqual(q("select count(*) from toko_snapshot_waktu where kode_toko = 'TRP'"), '1');
  assert.strictEqual(q("select max(n) from (select count(*) n from stok_toko_riwayat where kode_toko = 'TRP' and per_waktu < now() - interval '7 days' group by sku) x"), '1');
  const setelahBersih = stokPada(ADMIN, null);
  for (const sku of ['UJ-KESET', 'UJ-KURSI', 'UJ-EMBER']) {
    assert.deepStrictEqual([Number(barisSku(setelahBersih, sku).display), Number(barisSku(setelahBersih, sku).gudang)],
      [T.getProduct(sku).floor_stock, T.getProduct(sku).warehouse_stock], sku);
  }
  ok('riwayat stok 7 hari: hanya barang yang berubah dicatat, stok per jam dipilih (Coly & isi), sebelum riwayat kosong, hak akses, SO toko sesudahnya menolak stok lama, pembersihan > 7 hari');

  // ---------------------------------------------------------------- Pengguna: kata sandi sementara, wajib ganti
  const BARU = '00000000-0000-0000-0000-00000000000f';
  q(`insert into auth.users (id, email) values ('${BARU}', 'baru@uji.local')`);
  sebagai(OWNER, "select public.atur_pengguna('baru@uji.local', 'Gudang Baru', 'gudang', null, true)");
  assert.strictEqual(JSON.parse(sebagai(BARU, 'select public.saya()')).wajib_ganti_sandi, false);
  assert.throws(() => sebagai(ADMIN, "select public.wajibkan_ganti_sandi('baru@uji.local')"), /Hanya owner/);
  assert.throws(() => sebagai(OWNER, "select public.wajibkan_ganti_sandi('tidak@ada.local')"), /tidak ditemukan/);
  sebagai(OWNER, "select public.wajibkan_ganti_sandi('BARU@uji.local')");
  assert.strictEqual(JSON.parse(sebagai(BARU, 'select public.saya()')).wajib_ganti_sandi, true);
  assert.strictEqual(sebagai(OWNER, "select wajib_ganti_sandi from public.daftar_pengguna() where email = 'baru@uji.local'"), 't');
  assert.strictEqual(sebagai(ADMIN, 'select count(*) from public.daftar_pengguna()'), '0'); // hanya owner
  sebagai(BARU, 'select public.selesai_ganti_sandi()');
  assert.strictEqual(JSON.parse(sebagai(BARU, 'select public.saya()')).wajib_ganti_sandi, false);
  q(`update auth.users set email = 'owner@uji.local' where id = '${OWNER}'`);
  assert.throws(() => sebagai(OWNER, "select public.wajibkan_ganti_sandi('owner@uji.local')"), /akun sendiri/);
  assert.throws(() => q("set role anon; select public.selesai_ganti_sandi()"), /permission denied/);
  ok('pengguna: wajib ganti sandi hanya diatur owner (bukan untuk diri sendiri), tampil di saya() & daftar, selesai oleh pengguna sendiri');

  // ---------------------------------------------------------------- Laporan Mutasi Item
  await mb.kirim({ force: true });
  const mutasiItem = (uid, dari, sampai, zona) =>
    JSON.parse(sebagai(uid, `select public.laporan_mutasi_item('TRP', '${dari}', '${sampai}', ${zona ? `'${zona}'` : 'null'})`));
  const KOLOM_ZONA = { floor: 'floor_stock', warehouse: 'warehouse_stock', damaged: 'damaged_stock', shopee: 'shopee_stock' };
  const awalImport = { 'UJ-KESET': 5, 'UJ-KURSI': 2, 'UJ-EMBER': 4, 'UJ-BARU': 0 }; // Stok_Awal_Toko saat import (Display Toko)
  const angkaMutasi = (r, sku) => {
    const b = r.baris.find((x) => x.kode === sku) || { awal: 0, masuk: 0, penjualan: 0, keluar: 0, akhir: 0 };
    return { awal: Number(b.awal), masuk: Number(b.masuk), penjualan: Number(b.penjualan), keluar: Number(b.keluar), akhir: Number(b.akhir) };
  };
  // Sejak awal riwayat: Awal = stok import, Akhir = stok Trizone (semua alur di atas: penerimaan, jual, batal nota,
  // mutasi, opname toko & kantor, pesanan, batal mutasi / penerimaan)
  for (const zona of [null, 'floor', 'warehouse', 'damaged', 'shopee']) {
    const r = mutasiItem(ADMIN, '2000-01-01', '2100-12-31', zona);
    for (const sku of Object.keys(awalImport)) {
      const p = T.getProduct(sku);
      const akhir = zona ? p[KOLOM_ZONA[zona]] : Object.values(KOLOM_ZONA).reduce((a, k) => a + p[k], 0);
      const awal = !zona || zona === 'floor' ? awalImport[sku] : 0;
      const m = angkaMutasi(r, sku);
      assert.deepStrictEqual([m.awal, m.akhir], [awal, akhir], `${sku} ${zona || 'semua zona'}`);
      assert.strictEqual(m.awal + m.masuk - m.penjualan - m.keluar, m.akhir);
      // Penjualan = jual di kasir dikurangi pembatalan (+ Shopee terjual); hanya di Display Toko / Shopee
      const jualKasir = Number(q(`select coalesce(sum(qty), 0) from penjualan where kode_toko = 'TRP' and sku = '${sku}'`));
      const jualShopee = Number(q(`select coalesce(sum(b.qty), 0) from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
                                   where m.kode_toko = 'TRP' and b.sku = '${sku}' and m.ke = 'shopee_sold' and m.dibatalkan_at is null`));
      const jualHarap = !zona ? jualKasir + jualShopee : zona === 'floor' ? jualKasir : zona === 'shopee' ? jualShopee : 0;
      assert.strictEqual(m.penjualan, jualHarap, `penjualan ${sku} ${zona || 'semua zona'}`);
    }
  }
  // Mutasi antar zona: tidak dihitung di semua zona, tercatat keluar / masuk di zona masing-masing
  const hariDb = q('select mb.tgl_wib(now())');
  const kemarinDb = q("select mb.tgl_wib(now()) - 1");
  const sebelumSemua = angkaMutasi(mutasiItem(ADMIN, kemarinDb, hariDb, null), 'UJ-KESET');
  const sebelumFloor = angkaMutasi(mutasiItem(ADMIN, kemarinDb, hariDb, 'floor'), 'UJ-KESET');
  const sebelumGudang = angkaMutasi(mutasiItem(ADMIN, kemarinDb, hariDb, 'warehouse'), 'UJ-KESET');
  T.createTransferDoc({ from_zone: 'floor', to_zone: 'warehouse', reason: 'Uji laporan', items: [{ sku: 'UJ-KESET', qty: 1 }] });
  tidur(1100);
  await mb.kirim({ force: true });
  const sesudahSemua = angkaMutasi(mutasiItem(ADMIN, kemarinDb, hariDb, null), 'UJ-KESET');
  assert.deepStrictEqual([sesudahSemua.masuk, sesudahSemua.penjualan, sesudahSemua.keluar, sesudahSemua.akhir],
    [sebelumSemua.masuk, sebelumSemua.penjualan, sebelumSemua.keluar, sebelumSemua.akhir]);
  assert.strictEqual(angkaMutasi(mutasiItem(ADMIN, kemarinDb, hariDb, 'floor'), 'UJ-KESET').keluar, sebelumFloor.keluar + 1);
  assert.strictEqual(angkaMutasi(mutasiItem(ADMIN, kemarinDb, hariDb, 'warehouse'), 'UJ-KESET').masuk, sebelumGudang.masuk + 1);
  // Periode lampau (sebelum ada gerak): Awal = Akhir, tanpa masuk / keluar
  const lampau = angkaMutasi(mutasiItem(ADMIN, '2001-01-01', '2001-01-31', null), 'UJ-KESET');
  assert.deepStrictEqual([lampau.awal, lampau.masuk, lampau.penjualan, lampau.keluar, lampau.akhir], [5, 0, 0, 0, 5]);
  assert.strictEqual(mutasiItem(PMLG, '2000-01-01', '2100-12-31', null).baris.length, 0);
  assert.strictEqual(mutasiItem(PTRP, '2000-01-01', '2100-12-31', null).baris.length > 0, true);
  assert.throws(() => mutasiItem(ADMIN, '2026-11-10', '2026-11-01', null), /Periode tidak valid/);
  assert.throws(() => mutasiItem(ADMIN, '2026-11-01', '2026-11-10', 'kasir'), /tidak dikenal/);
  assert.throws(() => q("set role anon; select public.laporan_mutasi_item('TRP', '2026-11-01', '2026-11-10', null)"), /permission denied/);
  ok('laporan mutasi item: Awal = stok import & Akhir = stok Trizone per zona dan semua zona, penjualan (kasir − batal + Shopee) terpisah dari barang keluar, mutasi antar zona tidak dihitung di semua zona, hak akses');

  // ---------------------------------------------------------------- Laporan Penjualan per Toko per Item
  const jualTokoItem = (uid, dari, sampai, kat) =>
    JSON.parse(sebagai(uid, `select public.laporan_penjualan_toko_item('${dari}', '${sampai}', ${kat ? `'${kat}'` : 'null'})`));
  const pti = jualTokoItem(ADMIN, '2000-01-01', '2100-12-31', null);
  assert.deepStrictEqual(pti.toko.map((x) => x.kode), ['KRP', 'MNK', 'SDA', 'TRP', 'MLG', 'SPJ', 'BKS', 'DPK', 'CLD', 'PAM']);
  assert.ok(pti.baris.length > 0);
  for (const b of pti.baris) {
    for (const kode of ['KRP', 'TRP']) {
      const harap = Number(q(`select coalesce(sum(qty), 0) from penjualan where kode_toko = '${kode}' and sku = '${b.sku}'`))
        + Number(q(`select coalesce(sum(b.qty), 0) from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
                    where m.kode_toko = '${kode}' and b.sku = '${b.sku}' and m.ke = 'shopee_sold' and m.dibatalkan_at is null`));
      assert.strictEqual(Number(b.toko[kode] || 0), harap, `${b.sku} ${kode}`);
    }
    assert.strictEqual(Number(b.total), Object.values(b.toko).reduce((a, v) => a + Number(v), 0), `total ${b.sku}`);
  }
  for (let i = 1; i < pti.baris.length; i++) assert.ok(Number(pti.baris[i - 1].total) >= Number(pti.baris[i].total), 'urut dari yang paling laku');
  // Periode di luar penjualan → kosong; filter kategori (huruf besar/kecil sama)
  assert.strictEqual(jualTokoItem(ADMIN, '2000-01-01', '2000-01-31', null).baris.length, 0);
  const katUji = pti.baris.find((b) => b.kategori).kategori;
  const ptiKat = jualTokoItem(ADMIN, '2000-01-01', '2100-12-31', katUji.toLowerCase());
  assert.deepStrictEqual(ptiKat.baris.map((b) => b.sku), pti.baris.filter((b) => (b.kategori || '').toUpperCase() === katUji.toUpperCase()).map((b) => b.sku));
  assert.strictEqual(jualTokoItem(ADMIN, '2000-01-01', '2100-12-31', 'TIDAK-ADA').baris.length, 0);
  // Stok bisa dijual per toko (Display + Gudang Utama + Gudang Shopee) & waktu stok
  for (const b of pti.baris) {
    for (const kode of ['KRP', 'TRP']) {
      const s = q(`select display + gudang + shopee from stok_toko where kode_toko = '${kode}' and sku = '${b.sku}'`);
      assert.strictEqual(b.stok[kode] === undefined ? '' : String(Number(b.stok[kode])), s === '' ? '' : String(Number(s)), `stok ${b.sku} ${kode}`);
    }
  }
  assert.ok(pti.toko.find((x) => x.kode === 'TRP').stok_per);
  assert.strictEqual(pti.toko.find((x) => x.kode === 'MNK').stok_per, null);
  // Pemilik toko: hanya tokonya
  const ptiP = jualTokoItem(PTRP, '2000-01-01', '2100-12-31', null);
  assert.deepStrictEqual(ptiP.toko.map((x) => x.kode), ['TRP']);
  assert.ok(ptiP.baris.every((b) => Object.keys(b.toko).every((k) => k === 'TRP')));
  assert.throws(() => jualTokoItem(ADMIN, '2026-11-10', '2026-11-01', null), /Periode tidak valid/);
  assert.throws(() => q("set role anon; select public.laporan_penjualan_toko_item('2026-11-01', '2026-11-10', null)"), /permission denied/);
  // Urutan toko juga dipakai daftar toko
  assert.deepStrictEqual(JSON.parse(sebagai(ADMIN, 'select json_agg(kode) from public.status_koneksi_toko()')).slice(0, 4), ['KRP', 'MNK', 'SDA', 'TRP']);
  ok('laporan penjualan per toko per item: terjual = kasir − batal + Shopee per toko, total, urutan toko, filter kategori, pemilik toko hanya tokonya, hak akses');

  // ---------------------------------------------------------------- Retur barang ke supplier vs Retur Penjualan Accurate
  const AR = require('../web/lib/accurate.js');
  // File tiruan "Rincian Retur Penjualan" (tata letak sama dengan ekspor Accurate; kepala tabel berulang di halaman 2)
  const fileRetur = (dari, sampai, baris) => {
    const W = 19;
    const r = (isi) => { const x = new Array(W).fill(''); for (const [i, v] of Object.entries(isi)) x[i] = v; return x; };
    const kepalaTabel = r({ 1: 'Nomor #', 3: 'Kode #', 5: 'Nama Barang', 7: 'Kuantitas', 9: '@Harga', 11: 'Total Harga', 13: 'Pelanggan', 15: 'Keterangan Retur Penjualan' });
    const isi = baris.map(([no, kode, qty, pel, ket]) => r({ 1: no, 3: kode, 5: `Barang ${kode}`, 7: qty, 9: 1000, 11: qty * 1000, 13: pel, 15: ket || 'BS' }));
    const aoa = [r({ 1: 'PT CONTOH KANTOR' }), r({ 1: 'Rincian Retur Penjualan' }), r({ 1: `Dari ${dari} s/d ${sampai}` }), r({ 1: 'Cabang : [Semua Cabang]' }),
      kepalaTabel, ...isi.slice(0, 2), r({}), r({ 1: 'ACCURATE Accounting System Report' }), r({ 1: 'Halaman 1', 2: ' dari 2' }), kepalaTabel, ...isi.slice(2),
      r({}), r({ 1: 'ACCURATE Accounting System Report' }), r({}), r({ 1: 'Tercetak pada 24 November 2026 - 13:08' }), r({ 1: 'Halaman 2', 2: ' dari 2' })];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Rincian Retur Penjualan');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const tglId = (iso) => { const [y, m, d] = iso.split('-'); return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][Number(m) - 1]} ${y}`; };
  const awalRetur = q('select mb.tgl_wib(now()) - 10');
  const akhirRetur = q('select mb.tgl_wib(now())');

  // Toko: BS diisi lewat opname, lalu 3 retur ke supplier (yang ketiga dibatalkan)
  T.createOpname({ zone: 'damaged', notes: 'Hitung BS', items: [{ sku: 'UJ-KESET', counted: 10 }, { sku: 'UJ-EMBER', counted: 5 }] });
  T.createTransferDoc({ from_zone: 'damaged', to_zone: 'supplier', reason: 'Retur BS 1', items: [{ sku: 'UJ-KESET', qty: 2 }, { sku: 'UJ-EMBER', qty: 2 }] });
  tidur(1100);
  T.createTransferDoc({ from_zone: 'damaged', to_zone: 'supplier', reason: 'Retur BS 2', items: [{ sku: 'UJ-KESET', qty: 1 }] });
  tidur(1100);
  T.createTransferDoc({ from_zone: 'damaged', to_zone: 'supplier', reason: 'Retur BS salah', items: [{ sku: 'UJ-KESET', qty: 1 }] });
  batalMt('Retur BS salah', 'Salah catat');
  await mb.kirim({ force: true });

  const retur1 = AR.bacaFileRetur(fileRetur(tglId(awalRetur), tglId(akhirRetur), [
    ['SRT.UJI.0001', 'UJ-KESET', 2, 'Tropodo'], ['SRT.UJI.0002', 'UJ-KURSI', 1, 'Tropodo Special'],
    ['SRT.UJI.0001', 'UJ-EMBER', 1, 'Tropodo'], ['SRT.UJI.0002', 'TIDAK-ADA', 3, 'Tropodo Special'], ['SRT.UJI.0003', 'UJ-KESET', 1, 'Pelanggan Baru Uji'],
  ]));
  assert.deepStrictEqual([retur1.dari, retur1.sampai, retur1.dokumen.length, retur1.baris, retur1.masalah], [awalRetur, akhirRetur, 3, 5, []]);
  assert.strictEqual(retur1.perusahaan, 'PT CONTOH KANTOR');
  assert.deepStrictEqual(AR.bacaFileRetur(fileAccurate()).masalah.slice(0, 1), ['Bukan laporan "Rincian Retur Penjualan" Accurate.']);
  const imporRetur = (uid, h) => JSON.parse(sebagai(uid, `select public.import_retur_accurate(${lit(AR.payloadRetur(h, 'retur.xlsx'))})`));
  assert.throws(() => imporRetur(PMLG, retur1), /Hanya pengguna kantor/);
  const hasilImpor = imporRetur(ADMIN, retur1);
  assert.deepStrictEqual([hasilImpor.dokumen_baru, hasilImpor.dokumen_diganti, hasilImpor.baris, hasilImpor.pelanggan_belum_dipetakan, hasilImpor.mulai],
    [3, 0, 5, ['Pelanggan Baru Uji'], awalRetur]);
  const cocokRetur = (uid = ADMIN, toko = null) => JSON.parse(sebagai(uid, `select coalesce(json_agg(r), '[]') from public.laporan_pencocokan_retur(${toko ? `'${toko}'` : 'null'}) r`));
  const ringkasCocok = (rows) => Object.fromEntries(rows.map((r) => [`${r.kode_toko || '-'}:${r.sku}`, [Number(r.qty_toko), Number(r.qty_accurate), r.status]]));
  assert.deepStrictEqual(ringkasCocok(cocokRetur()), {
    '-:UJ-KESET': [0, 1, 'PELANGGAN_BELUM_DIPETAKAN'],
    'TRP:UJ-KESET': [3, 2, 'BELUM_DI_ACCURATE'], // retur yang dibatalkan tidak dihitung
    'TRP:UJ-EMBER': [2, 1, 'BELUM_DI_ACCURATE'],
    'TRP:UJ-KURSI': [0, 1, 'LEBIH_DI_ACCURATE'],
    'TRP:TIDAK-ADA': [0, 3, 'BARANG_TIDAK_DIKENAL'],
  });
  const dokRetur = () => Object.fromEntries(JSON.parse(sebagai(ADMIN, "select coalesce(json_agg(r), '[]') from public.laporan_retur_toko(null, null) r"))
    .map((r) => [r.alasan, [Number(r.qty), Number(r.qty_accurate), r.status]]));
  assert.deepStrictEqual(dokRetur(), { 'Retur BS 1': [4, 3, 'SEBAGIAN'], 'Retur BS 2': [1, 0, 'BELUM'] }); // FIFO: yang lama dulu
  assert.strictEqual(sebagai(ADMIN, "select count(*) from public.laporan_retur_toko('TRP', 'BELUM')"), '1');

  // Kantor menginput sisanya; impor ulang file yang sama tidak dobel
  const retur2 = AR.bacaFileRetur(fileRetur(tglId(awalRetur), tglId(akhirRetur), [
    ['SRT.UJI.0001', 'UJ-KESET', 2, 'Tropodo'], ['SRT.UJI.0001', 'UJ-EMBER', 1, 'Tropodo'], ['SRT.UJI.0004', 'UJ-KESET', 1, 'Tropodo'],
    ['SRT.UJI.0004', 'UJ-EMBER', 1, 'Tropodo'],
  ]));
  assert.deepStrictEqual([imporRetur(ADMIN, retur2).dokumen_diganti, imporRetur(ADMIN, retur2).dokumen_diganti], [1, 2]);
  const cocok2 = ringkasCocok(cocokRetur(ADMIN, 'TRP'));
  assert.deepStrictEqual([cocok2['TRP:UJ-KESET'], cocok2['TRP:UJ-EMBER']], [[3, 3, 'COCOK'], [2, 2, 'COCOK']]);
  assert.deepStrictEqual(dokRetur(), { 'Retur BS 1': [4, 4, 'SUDAH'], 'Retur BS 2': [1, 1, 'SUDAH'] });
  // Tanggal mulai: retur toko sebelum tanggal itu tidak dihitung
  sebagai(ADMIN, `select public.atur_mulai_pencocokan_retur('${q('select mb.tgl_wib(now()) + 1')}')`);
  assert.deepStrictEqual(dokRetur(), {});
  sebagai(ADMIN, `select public.atur_mulai_pencocokan_retur('${awalRetur}')`);
  assert.throws(() => sebagai(PMLG, `select public.atur_mulai_pencocokan_retur('${awalRetur}')`), /Hanya pengguna kantor/);
  assert.strictEqual(cocokRetur(PMLG).length, 0);
  assert.strictEqual(sebagai(PMLG, 'select count(*) from retur_accurate'), '0');
  assert.throws(() => q("set role anon; select count(*) from public.laporan_pencocokan_retur(null)"), /permission denied/);
  ok('retur barang: retur toko (BS → Supplier) vs Retur Penjualan Accurate per barang (cocok, belum diinput, lebih, barang tak dikenal, pelanggan belum dipetakan), status dokumen FIFO, retur batal tidak dihitung, impor ulang tidak dobel, tanggal mulai, hak akses');

  console.log(`\n${lulus} uji lulus`);
})().catch((e) => { console.error('\n✗', e && (e.stack || e.message)); process.exit(1); });
