'use strict';
// Uji mother base dari ujung ke ujung, memakai kode Trizone asli:
//   1. File Accurate "Rincian Pengiriman Pesanan" (tiruan, tata letak sama) dibaca accurate-do.js.
//   2. Toko Trizone di memori: import penerimaan dari file itu, stok opname, penjualan, mutasi.
//   3. Paket Homebase (snapshot + shift) dibuat dengan src/homebase-package.js.
//   4. Paket dicek oleh Apps Script (Code.gs) lalu dimasukkan ke PostgreSQL lewat ingest_paket.
//   5. Hasil dicek: penjualan, pencocokan surat jalan, stok seharusnya = stok Trizone, hak akses.
//
// Jalankan dari folder repo:
//   node motherbase/test/uji.js                      → langkah 1–4 tanpa database
//   MB_PSQL="psql -h <host> -p <port> -U postgres" node motherbase/test/uji.js
//      → + database: membuat database mb_uji baru, migrasi, seed, lalu semua pengecekan.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..', '..');
const { Database } = require(path.join(ROOT, 'src/db'));
const { createServices } = require(path.join(ROOT, 'src/services'));
const hp = require(path.join(ROOT, 'src/homebase-package'));
const acc = require('../accurate/accurate-do');

// Code.gs dijalankan di sandbox (fungsi Apps Script tidak dipanggil di sini)
const gsMod = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), { module: gsMod });
const GS = gsMod.exports;

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

  // ---------------------------------------------------------------- 2. Toko Trizone
  console.log('Trizone');
  const T = createServices(await Database.open(null));
  T.saveSettings({ store_name: 'Tropodo (uji)' });
  T.importRows([
    { Barcode: '2000000000101', SKU: 'UJ-KESET', Nama_Barang: 'Keset Uji', Harga_Jual: 15000, Satuan_Masuk: 'Pcs', Rasio_Isi_Dus: 1, Stok_Awal_Toko: 5 },
    { Barcode: '2000000000118', SKU: 'UJ-KURSI', Nama_Barang: 'Kursi Uji', Harga_Jual: 85000, Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 6, Stok_Awal_Toko: 2 },
    { Barcode: '2000000000125', SKU: 'UJ-EMBER', Nama_Barang: 'Ember Uji', Harga_Jual: 25000, Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 12, Stok_Awal_Toko: 4 },
  ]);
  const storeId = T.ensureStoreId();

  // DO.UJI.0001 diterima persis; DO.UJI.0004 diterima kurang 1 Biji (dihitung fisik)
  const imp1 = T.importReceptions({ rows: acc.barisImportTrizone({ ...hasil, do: [hasil.do[0]] }) });
  assert.deepStrictEqual(imp1.errors, []);
  assert.strictEqual(imp1.created.length, 1);
  assert.strictEqual(T.getReception({ id: imp1.created[0].id }).total_items_count, 150 + 2 * 6);
  ok('file import penerimaan dari Accurate diterima Trizone (Pcs → Biji, Coly → isi satuan masuk)');
  tidur(1100);
  // Stok opname patokan (Display Toko: keset kurang 1; Gudang Utama sesuai sistem)
  const stok = () => Object.fromEntries(T.listProducts({}).map((p) => [p.sku, p]));
  let s = stok();
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
  T.checkout({ items: [{ sku: 'UJ-EMBER', qty: 1 }], payment_method: 'Kartu Debit' });
  const rows4 = acc.barisImportTrizone({ ...hasil, do: [hasil.do[3]] }).map((r) => ({ ...r, Jumlah: 1, Satuan: 'Dus' }));
  rows4.push({ ...rows4[0], Jumlah: 11, Satuan: 'Biji' });          // 1 Coly + 11 Biji = 23 Biji, dikirim 24
  assert.deepStrictEqual(T.importReceptions({ rows: rows4 }).errors, []);
  ok('penerimaan, SO, mutasi (termasuk Shopee dan retur), dan 3 transaksi tercatat');

  // ---------------------------------------------------------------- 3. Paket Homebase
  const now = () => new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  const pk = (kind, data, at, src = {}) => hp.makePackage({ kind, store: T.storeInfo(), source: { app_version: '1.7.0', ...src }, created_at: at, data });
  const snapLama = pk('snapshot', T.homebaseSnapshotData(), '2026-11-01 08:00:00');
  tidur(1100);
  const tutup = now();
  const paketShift = pk('shift', T.homebaseShiftData({ closed_at: tutup }), tutup);
  const snap = pk('snapshot', T.homebaseSnapshotData(), tutup);
  const demo = pk('snapshot', T.homebaseSnapshotData(), tutup, { demo: true });
  const kemas = (p) => { const buf = hp.encodePackage(p); return { buf, sha: hp.sha256(buf), nama: hp.packageFileName(p) }; };
  const F = { snap: kemas(snap), shift: kemas(paketShift), lama: kemas(snapLama), demo: kemas(demo) };
  for (const f of Object.values(F)) assert.match(f.nama, GS.RE_FILE);
  assert.strictEqual(GS.cekPaket(snap), null);
  assert.strictEqual(GS.cekPaket(paketShift), null);
  assert.match(GS.cekPaket(demo), /DEMO/);
  assert.match(GS.cekPaket({ ...snap, version: 2 }), /lebih baru/);
  assert.match(GS.cekPaket({ format: 'x' }), /Bukan paket/);
  assert.ok(GS.lolosOtentikasi('mx.google.com; dkim=pass header.i=@gmail.com'));
  assert.ok(!GS.lolosOtentikasi('mx.google.com; dkim=fail; spf=fail'));
  ok('paket TRZ dibuat dengan kode Trizone dan lolos cek Apps Script (DEMO/versi baru/bukan paket ditolak)');

  // ---------------------------------------------------------------- 4–5. Database
  const PSQL = process.env.MB_PSQL;
  if (!PSQL) { console.log(`\n${lulus} uji lulus (database dilewati; isi MB_PSQL untuk uji lengkap)`); return; }
  console.log('Database');
  const [bin, ...args] = PSQL.split(' ');
  const run = (db, sqlArgs, input) => execFileSync(bin, [...args, '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-tA', ...sqlArgs],
    { encoding: 'utf8', input, maxBuffer: 64e6 }).trim();
  const DB = 'mb_uji';
  run('postgres', ['-c', `drop database if exists ${DB}`]);
  run('postgres', ['-c', `create database ${DB}`]);
  const dir = path.join(__dirname, '..', 'supabase');
  for (const f of ['tests/stub_supabase.sql', 'migrations/20261116000001_mother_base.sql', 'seed.sql']) run(DB, ['-f', path.join(dir, f)]);
  const q = (sql) => run(DB, [], sql + ';');
  const lit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
  const ingest = (f, sumber = 'DRIVE', extra = {}) =>
    JSON.parse(q(`select public.ingest_paket(${lit({ sha256: f.sha, nama_file: f.nama, sumber, paket: JSON.parse(require('zlib').gunzipSync(f.buf)), ...extra })})`));

  let r = ingest(F.snap);
  assert.strictEqual(r.status, 'MENUNGGU_TOKO');
  assert.strictEqual(ingest(F.shift).status, 'MENUNGGU_TOKO');
  assert.strictEqual(q('select count(*) from penjualan'), '0');
  r = JSON.parse(q(`select public.hubungkan_toko('TRP', '${storeId}')`));
  assert.strictEqual(r.paket_diproses, 2);
  ok('paket dari toko yang belum terhubung ditahan, lalu diproses saat hubungkan_toko');

  assert.strictEqual(ingest(F.snap).status, 'SUDAH_ADA');
  assert.strictEqual(ingest(F.lama).status, 'LAMA');
  r = ingest(F.demo); assert.strictEqual(r.status, 'DITOLAK'); assert.match(r.pesan, /DEMO/);
  r = ingest({ sha: 'a'.repeat(64), nama: 'TRZ_rusak.json.gz', buf: require('zlib').gzipSync('{}') }, 'DRIVE', { alasan_parser: 'File rusak atau belum selesai tersalin.' });
  assert.strictEqual(r.status, 'DITOLAK'); assert.match(r.pesan, /rusak/);
  assert.strictEqual(q(`select string_agg(x, ',') from public.paket_sudah_ada(array['${F.snap.nama}','${F.demo.nama}']) x`), F.snap.nama);
  ok('paket ganda dilewati, snapshot lama hanya menambah riwayat, DEMO dan file rusak ditolak');

  // Penjualan: 3 struk, Kartu Debit masuk kelompok Transfer, shift tertutup (paket shift menang atas shift berjalan)
  const ring = q("select jumlah_transaksi || '|' || omzet || '|' || tunai || '|' || qris || '|' || transfer from v_ringkasan_harian where kode_toko='TRP'");
  assert.strictEqual(ring, `3|${4 * 15000 + 85000 + 30000 + 25000}.00|${4 * 15000 + 85000}.00|30000.00|25000.00`);
  assert.ok(q(`select tutup_at is not null from shift where kode_toko='TRP'`) === 't');
  assert.strictEqual(q(`select qty from v_permintaan_harian where kode_toko='TRP' and sku='UJ-KESET' and kanal='SHOPEE'`), '3.000');
  ok('ringkasan harian: omzet, Tunai/QRIS/Transfer (Kartu Debit lama → Transfer), penjualan Shopee terhitung');

  // Surat jalan
  const imp = JSON.parse(q(`select public.import_surat_jalan(${lit(acc.payloadMotherBase(hasil, 'uji.xlsx'))})`));
  assert.strictEqual(imp.do_baru, 4);
  assert.deepStrictEqual(imp.pelanggan_belum_dipetakan, ['Utama']);
  const status = Object.fromEntries(q('select no_sj, status from v_pencocokan_sj').split('\n').map((l) => l.split('|')));
  assert.deepStrictEqual(status, {
    'DO.UJI.0001': 'COCOK', 'DO.UJI.0002': 'BELUM_DIINPUT', 'DO.UJI.0003': 'PELANGGAN_BELUM_DIPETAKAN', 'DO.UJI.0004': 'SELISIH_QTY',
  });
  assert.strictEqual(q(`select qty_biji from v_sj_baris_biji where no_sj='DO.UJI.0001' and kode='UJ-KURSI'`), '12.000');
  const ulang = JSON.parse(q(`select public.import_surat_jalan(${lit(acc.payloadMotherBase(hasil, 'uji.xlsx'))})`));
  assert.strictEqual(ulang.do_diganti, 4);
  assert.strictEqual(q('select count(*) from surat_jalan_baris'), '5');
  ok('surat jalan: Cocok, Belum diinput, Pelanggan belum dipetakan, Selisih qty; Coly dikali isi; impor ulang tidak dobel');

  // Stok seharusnya vs Trizone setelah SO disetujui
  assert.strictEqual(q("select count(*) from stok_opname_review where status='BARU'"), '2');
  q("update stok_opname_review set status='DISETUJUI'");
  assert.strictEqual(q('select count(*) from v_selisih_snapshot'), '0',
    'stok seharusnya harus sama dengan stok Trizone:\n' + q('select * from v_selisih_snapshot'));
  const disp = q(`select stok_seharusnya from v_stok_seharusnya where kode_toko='TRP' and sku='UJ-KESET' and zona='floor'`);
  assert.strictEqual(disp, String(T.getProduct('UJ-KESET').floor_stock) + '.000');
  assert.strictEqual(q(`select count(*) from v_selisih_so where nilai_selisih is null and selisih <> 0`), '1');   // harga beli belum diisi
  ok('stok seharusnya per zona (SO + penerimaan − jual ± mutasi) sama persis dengan stok Trizone');

  // Hak akses
  q(`insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b')`);
  q(`insert into pengguna values ('00000000-0000-0000-0000-00000000000a','Pemilik Malang','pemilik_toko','MLG',true),
                                 ('00000000-0000-0000-0000-00000000000b','Admin','admin_kantor',null,true)`);
  q('grant select on all tables in schema public to authenticated; grant update on po to authenticated');
  const sebagai = (uid, sql) => q(`set role authenticated; set request.jwt.claim.sub = '${uid}'; ${sql}`);
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000a', 'select count(*) from penjualan'), '0');
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000a', 'select count(*) from paket_impor'), '0');
  assert.notStrictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from penjualan'), '0');
  q(`insert into principal (nama) values ('P'); insert into po (no_po, principal_id) values ('PO-1', 1)`);
  assert.throws(() => sebagai('00000000-0000-0000-0000-00000000000b', "update po set status='DISETUJUI'"), /Hanya owner/);
  ok('pemilik toko lain tidak melihat data Tropodo; admin kantor melihat; hanya owner yang menyetujui PO');

  console.log(`\n${lulus} uji lulus`);
})().catch((e) => { console.error('\n✗', e && (e.stack || e.message) || e, e); process.exit(1); });
