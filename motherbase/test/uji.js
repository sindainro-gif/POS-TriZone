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
  for (const f of ['tests/stub_supabase.sql', 'migrations/20261116000001_mother_base.sql', 'migrations/20261116000002_aplikasi.sql', 'seed.sql']) run(DB, ['-f', path.join(dir, f)]);
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

  // Master barang: kantor mengisi dari toko, mengubah harga & menambah barang; toko yang terkunci mengambilnya
  assert.strictEqual(q(`select public.isi_master_dari_toko('TRP')`), '3');
  q(`update produk set harga_jual_konsumen = 16000 where sku = 'UJ-KESET'`);
  q(`insert into produk (sku, nama, barcode, merk, kategori, harga_jual_konsumen, satuan_masuk, rasio_isi)
     values ('UJ-BARU', 'Barang Baru Uji', '2000000000132', 'M', 'K', 7000, 'Coly', 4)`);
  T.mbSaveConfig({ kunci_master: true });
  assert.throws(() => T.saveProduct({ product: { ...T.getProduct('UJ-KESET'), unit_price: 1 } }), /dikunci mother base/);
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
  assert.strictEqual(q('set role anon; select count(*) from penjualan'), '0');
  assert.strictEqual(q('set role anon; select count(*) from toko_kunci'), '0');
  assert.throws(() => q("set role anon; select public.buat_kunci_toko('TRP')"), /permission denied/);
  q(`insert into principal (nama) values ('P'); insert into po (no_po, principal_id) values ('PO-1', 1)`);
  assert.throws(() => sebagai('00000000-0000-0000-0000-00000000000b', "update po set status='DISETUJUI'"), /Hanya owner/);
  ok('anon hanya bisa memanggil RPC toko; pemilik toko lain tidak melihat data Tropodo; kunci tidak terbaca; hanya owner menyetujui PO');

  console.log(`\n${lulus} uji lulus`);
})().catch((e) => { console.error('\n✗', e && (e.stack || e.message)); process.exit(1); });
