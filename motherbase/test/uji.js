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
  for (const f of ['tests/stub_supabase.sql', 'migrations/20261116000001_mother_base.sql', 'migrations/20261116000002_aplikasi.sql', 'migrations/20261116000003_import_barang.sql', 'migrations/20261119000004_satuan_masuk.sql', 'migrations/20261119000005_tanpa_principal.sql', 'migrations/20261119000006_pembatalan_nota.sql', 'migrations/20261120000007_filter_stok.sql', 'seed.sql']) run(DB, ['-f', path.join(dir, f)]);
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
  assert.strictEqual(sebagai('00000000-0000-0000-0000-00000000000b', 'select count(*) from public.laporan_pembatalan(mb.tgl_wib(now()) - 30, mb.tgl_wib(now()))'), '1');
  assert.strictEqual(q('set role anon; select count(*) from pembatalan_nota'), '0');
  assert.throws(() => q('set role anon; select count(*) from public.laporan_pembatalan(current_date, current_date)'), /permission denied/);
  assert.strictEqual(q('set role anon; select count(*) from penjualan'), '0');
  assert.strictEqual(q('set role anon; select count(*) from toko_kunci'), '0');
  assert.throws(() => q("set role anon; select public.buat_kunci_toko('TRP')"), /permission denied/);
  q(`insert into principal (nama) values ('P'); insert into po (no_po, principal_id) values ('PO-1', 1)`);
  assert.throws(() => sebagai('00000000-0000-0000-0000-00000000000b', "update po set status='DISETUJUI'"), /Hanya owner/);
  ok('anon hanya bisa memanggil RPC toko; pemilik toko lain tidak melihat data Tropodo; kunci tidak terbaca; hanya owner menyetujui PO');

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

  console.log(`\n${lulus} uji lulus`);
})().catch((e) => { console.error('\n✗', e && (e.stack || e.message)); process.exit(1); });
