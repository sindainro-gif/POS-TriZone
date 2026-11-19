'use strict';
// Uji aplikasi web mother base di browser (Playwright + Chromium) terhadap server dev
// dengan database contoh baru. Tidak memakai internet: supabase-js & SheetJS dilayani lokal,
// asisten AI memakai Claude tiruan.
//
//   MB_DATABASE_URL=postgres://.../mb_web_uji node motherbase/test/web.test.js [folder-tangkapan-layar]
// Database di MB_DATABASE_URL DIBUAT ULANG.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const { chromium } = require('playwright');
const { createServer, signJwt } = require('../dev/server');
const { buatDataDemo } = require('../dev/data-demo');
const ROOT = path.join(__dirname, '..', '..');
const { Database } = require(path.join(ROOT, 'src/db'));
const { createServices, OPNAME_TEMPLATE_HEADERS } = require(path.join(ROOT, 'src/services'));
const { createMotherbase } = require(path.join(ROOT, 'src/motherbase'));

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'mb-web-uji'));
fs.mkdirSync(OUT, { recursive: true });
let lulus = 0;
const ok = (n) => { lulus++; console.log('  ✓', n); };

function fileAccurate() {
  const W = 20;
  const baris = (isi) => { const r = new Array(W).fill(null); for (const [i, v] of Object.entries(isi)) r[i] = v; return r; };
  const tgl = (d) => (Date.UTC(...d.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) - Date.UTC(1899, 11, 30)) / 864e5;
  const h = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const rows = [
    baris({ 1: 'PT CONTOH KANTOR' }), baris({ 1: 'Rincian Pengiriman Pesanan' }), baris({ 1: 'Dari 01 Nov 2026 s/d 16 Nov 2026' }), baris({ 1: 'Cabang : [Semua Cabang]' }),
    baris({ 2: 'Nomor #', 4: ':', 5: 'DO.UJI.WEB.1', 9: 'Pelanggan', 11: ':', 13: 'Malang Special' }), baris({ 2: 'Tanggal', 4: ':', 5: tgl(h) }),
    baris({ 3: 'Kode #', 7: 'Nama Barang', 12: 'Kuantitas', 15: 'Satuan' }),
    baris({ 3: 'PLJ-003', 7: 'Keranjang Cucian', 12: 1, 15: 'Coly' }), baris({ 3: 'RTN-002', 7: 'Keset Zig Zag', 12: 10, 15: 'Pcs' }), baris({ 12: 11 }),
    baris({}), baris({ 1: 'ACCURATE Accounting System Report' }), baris({ 1: 'Halaman 1', 17: ' dari 1' }),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Rincian');
  const f = path.join(OUT, 'Rincian_Pengiriman_uji.xlsx');
  XLSX.writeFile(wb, f);
  return f;
}

(async () => {
  const dbUrl = process.env.MB_DATABASE_URL;
  if (!dbUrl) { console.log('Isi MB_DATABASE_URL (database ini dibuat ulang).'); process.exit(2); }
  await buatDataDemo(dbUrl);
  const pool = new Pool({ connectionString: dbUrl });
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const anonKey = signJwt({ role: 'anon' }, jwtSecret);
  const Anthropic = require('@anthropic-ai/sdk');
  const server = createServer({ pool, jwtSecret, anonKey, anthropicFactory: () => new Anthropic({ apiKey: 'tiruan', fetch: require('../dev/claude-tiruan').fetchTiruan }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const kesalahan = [];
  let page;
  const baru = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, ...opts });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') kesalahan.push(`${m.text()}`); });
    p.on('pageerror', (e) => kesalahan.push(`pageerror: ${e.message}`));
    p.on('response', async (r) => {
      if (r.status() >= 400 && !/favicon/.test(r.url())) kesalahan.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    });
    return p;
  };
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true });
  const tunggu = (ms) => page.waitForTimeout(ms);
  const db = (sql, p) => pool.query(sql, p).then((r) => r.rows);
  const masuk = async (email, pass) => {
    await page.goto(BASE);
    await page.fill('#lgEmail', email);
    await page.fill('#lgPass', pass);
    await page.click('#lgBtn');
    await page.waitForSelector('#isi .page-head', { timeout: 10000 });
  };
  const buka = async (hal) => {
    await page.click(`.nav a[data-h="${hal}"]`);
    await page.waitForFunction(() => !document.querySelector('#isi > .kosong'));
    await tunggu(400);
  };
  // Tunggu notifikasi yang cocok (notifikasi lama bisa masih tampil)
  const toastCocok = async (re) => {
    await page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 10000 })
      .catch(async () => { throw new Error(`Notifikasi /${re.source}/ tidak muncul. Ada: ${await page.$$eval('.toast', (x) => x.map((e) => e.textContent).join(' | '))}`); });
  };

  try {
    page = await baru();
    await page.goto(BASE);
    await page.fill('#lgEmail', 'owner@contoh.local');
    await page.fill('#lgPass', 'salah');
    await page.click('#lgBtn');
    await page.waitForSelector('#lgErr:not(.hidden)');
    assert.match(await page.textContent('#lgErr'), /salah/);
    await shot('00-login-salah');
    ok('login dengan kata sandi salah ditolak dengan pesan jelas');

    await masuk('owner@contoh.local', 'owner123');
    await page.waitForSelector('#rkStat .stat');
    await page.waitForSelector('#rkPerhatian li a');
    const stat = await page.$$eval('#rkStat .nilai', (x) => x.map((e) => e.textContent));
    assert.match(stat[0], /^Rp [\d.]+$/);
    assert.ok(await page.$('#rkChart svg rect.bar'));
    const perhatian = await page.textContent('#rkPerhatian');
    assert.match(perhatian, /surat jalan perlu dicek/);
    assert.match(perhatian, /stok opname menunggu review/);
    assert.match(perhatian, /usulan PO menunggu persetujuan Anda/);
    assert.match(perhatian, /3 nota dibatalkan dalam 7 hari terakhir/);
    assert.strictEqual((await page.$$('#rkToko tbody tr')).length, 9);
    await shot('01-ringkasan');
    await page.selectOption('#perPilih', '30');
    await page.waitForTimeout(600);
    await shot('01b-ringkasan-30-hari');
    ok('ringkasan: omzet, grafik harian, perlu perhatian (SJ, SO, PO), 9 toko');

    await buka('penjualan');
    for (const t of ['produk', 'tren', 'abc', 'kasir', 'harian', 'batal']) {
      await page.click(`#pjTab [data-t="${t}"]`);
      await page.waitForFunction(() => !document.querySelector('#pjIsi .kosong') || /Tidak ada/.test(document.querySelector('#pjIsi').textContent));
      await tunggu(250);
      assert.ok((await page.$$('#pjIsi tbody tr')).length > 0, `tab ${t} kosong`);
      if (t === 'tren') await shot('02-penjualan-tren');
      if (t === 'harian') assert.match(await page.textContent('#pjIsi'), /Pembatalan[\s\S]*1 nota/);
    }
    // Pembatalan: Malang (5 hari lalu), Tropodo (2 hari lalu, shift tertutup) dan hari ini (shift berjalan)
    const batal = await page.$$eval('#pjIsi tbody tr', (x) => x.map((tr) => tr.textContent));
    assert.strictEqual(batal.length, 3);
    assert.ok(batal.every((b) => /BTL-\d{8}-\d{4}/.test(b) && /Rina/.test(b) && /Bu Sari/.test(b)), batal.join('\n'));
    assert.ok(batal.some((b) => /Salah ambil barang/.test(b)) && batal.some((b) => /Pelanggan batal beli/.test(b)));
    await shot('02b-penjualan-pembatalan');
    await page.click('#pjIsi tbody tr.klik');
    await page.waitForSelector('.modal');
    const rinci = await page.textContent('.modal');
    assert.match(rinci, /Disetujui oleh \(PIN\)\s*Bu Sari/);
    assert.match(rinci, /Diminta oleh\s*Rina/);
    assert.match(rinci, /Toples 2 Liter/);
    await shot('02c-rincian-pembatalan');
    await page.click('.modal-kaki .btn.primary');
    assert.strictEqual(await page.$('.modal'), null);
    await page.selectOption('#pjToko', 'TRP');
    await tunggu(500);
    assert.strictEqual((await page.$$('#pjIsi tbody tr')).length, 2);
    const [{ n: struk }] = await db("select count(distinct no_struk)::int n from penjualan where no_struk like 'BTL-%'");
    assert.strictEqual(struk, 3);
    ok('penjualan: per produk, naik/turun, ABC, per kasir, per hari, pembatalan (rincian & penyetuju); filter toko');

    await buka('stok');
    await page.waitForSelector('[data-so] [data-aksi="DISETUJUI"]');
    await shot('03-review-so');
    await page.click('[data-so] [data-aksi="DISETUJUI"]');
    await page.fill('#soCat', 'Sudah dicek ulang');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/disetujui/);
    await tunggu(500);
    assert.strictEqual((await db("select count(*)::int n from stok_opname_review where status = 'DISETUJUI' and catatan = 'Sudah dicek ulang' and direview_oleh is not null"))[0].n, 1);
    await page.click('#stTab [data-t="selisih"]');
    await tunggu(500);
    await shot('03b-selisih-trizone');
    await page.click('#stTab [data-t="cari"]');
    await page.fill('#stCari', 'keset');
    await tunggu(700);
    assert.ok((await page.$$('#stHasil tbody tr')).length >= 3);
    await page.click('#stTab [data-t="lambat"]');
    await tunggu(500);
    ok('stok: SO disetujui dengan catatan (tercatat penyetujunya), selisih, cari stok, stok lambat');

    // Opname dari kantor: daftar (contoh: Tropodo sudah menerapkan, Sidoarjo belum), buat dari template toko Malang, toko menerapkan
    await page.click('#stTab [data-t="kantor"]');
    await page.waitForSelector('#okDaftar tbody tr');
    const daftarOk = await page.$$eval('#okDaftar tbody tr', (x) => x.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
    assert.ok(daftarOk.some((r) => /TRP/.test(r) && /Diterapkan/.test(r) && /OP-\d{8}-\d{3}/.test(r) && /Budi/.test(r)), daftarOk.join('\n'));
    assert.ok(daftarOk.some((r) => /SDA/.test(r) && /Menunggu toko/.test(r)), daftarOk.join('\n'));
    await shot('03c-opname-dari-kantor');
    await page.click('#okBuat');
    await page.waitForSelector('#okTemplate');
    await page.selectOption('#okBuatToko', 'MLG');
    const [dlOk] = await Promise.all([page.waitForEvent('download'), page.click('#okTemplate')]);
    const fOkTpl = path.join(OUT, dlOk.suggestedFilename());
    await dlOk.saveAs(fOkTpl);
    const tplOk = XLSX.utils.sheet_to_json(XLSX.readFile(fOkTpl).Sheets.Opname, { header: 1, defval: '' });
    assert.deepStrictEqual(tplOk[0], OPNAME_TEMPLATE_HEADERS);
    const baris1 = tplOk.find((r) => r[0] === 'PLJ-001');
    const baris2 = tplOk.find((r) => r[0] === 'RTN-002');
    assert.match(String(baris1[10]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    baris1[3] = Number(baris1[2]) + 2; // Fisik Display Toko
    baris2[5] = 4; // Fisik Gudang Utama
    const fOkIsi = path.join(OUT, 'Opname_MLG_diisi.xlsx');
    const wbOk = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOk, XLSX.utils.aoa_to_sheet(tplOk), 'Opname');
    XLSX.writeFile(wbOk, fOkIsi);
    await page.setInputFiles('#okFile', fOkIsi);
    await page.waitForSelector('#okHasil .alert.ok');
    const cekOk = await page.textContent('#okHasil');
    assert.match(cekOk, /dengan Tanggal_Stok/);
    assert.match(cekOk, /Siap disimpan: 2 opname/);
    assert.match(cekOk, /Display Toko/);
    assert.match(cekOk, /Gudang Utama/);
    await shot('03d-buat-opname-kantor');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/2 opname dibuat untuk MLG/);
    const okBaru = await db("select id, zona, status from opname_kantor where kode_toko = 'MLG' and status = 'baru' order by id");
    assert.deepStrictEqual(okBaru.map((o) => o.zona), ['floor', 'warehouse']);
    // Toko (Trizone sungguhan, lewat RPC server dev dengan anon key) mengambil & menerapkan apa adanya
    const [{ k: kunciMlg }] = await db("select public.buat_kunci_toko('MLG') as k");
    const T2 = createServices(await Database.open(null));
    T2.importRows([{ Barcode: '8990000000017', SKU: 'PLJ-001', Nama_Barang: 'Ember Plastik 20L', Harga_Jual: 35000, Stok_Awal_Toko: 50 },
      { Barcode: '8990000000079', SKU: 'RTN-002', Nama_Barang: 'Keset Zig Zag', Harga_Jual: 25000, Stok_Awal_Gudang: 30 }]);
    T2.mbSaveConfig({ url: BASE, anon_key: anonKey, kode_toko: 'MLG', kunci: kunciMlg });
    const mb2 = createMotherbase({ svc: T2, appVersion: 'uji-web', fetchFn: fetch });
    assert.strictEqual((await mb2.opnameKantor()).baru, 2);
    for (const o of T2.listOfficeOpnames()) T2.applyOfficeOpname({ id: o.id, applied_by: 'Budi Gudang' });
    assert.deepStrictEqual([T2.getProduct('PLJ-001').floor_stock, T2.getProduct('RTN-002').warehouse_stock],
      [50 + 2, 30 + (4 - Number(baris2[4]))]); // hanya selisih fisik − stok di template yang ditambahkan
    assert.strictEqual((await mb2.opnameKantor()).dilaporkan, 2);
    await mb2.kirim(); // dokumen OP- toko ikut kiriman biasa → kantor melihat stok sistem toko & selisihnya
    await page.selectOption('#okStatus', 'diterapkan');
    await tunggu(600);
    await page.click(`#okDaftar tr.klik:has-text("#${okBaru[0].id}")`);
    await page.waitForSelector('.modal');
    const rinciOk = await page.textContent('.modal');
    assert.match(rinciOk, /Diterapkan di toko sebagai\s*OP-\d{8}-\d{3}/);
    assert.match(rinciOk, /Budi Gudang/);
    assert.match(rinciOk, /PLJ-001/);
    assert.match(rinciOk, /Sistem toko/);
    assert.deepStrictEqual(await page.$$eval('.modal tbody tr td:last-child', (x) => x.map((e) => e.textContent.trim())), ['+2']);
    await shot('03e-opname-kantor-diterapkan');
    await page.click('.modal .tutup');
    // Isi baris: kode salah ditolak (simpan mati); lalu dibuat & dibatalkan kantor
    await page.selectOption('#okStatus', '');
    await page.click('#okBuat');
    await page.selectOption('#okBuatToko', 'SDA');
    await page.click('#okMode [data-t="manual"]');
    await page.fill('#okBaris tr:nth-child(1) [data-k]', 'TIDAK-ADA-99');
    await page.fill('#okBaris tr:nth-child(1) [data-f]', '3');
    await page.click('#okPeriksa');
    await page.waitForSelector('#okHasil .alert.bad');
    assert.match(await page.textContent('#okHasil'), /Kode TIDAK-ADA-99 tidak ada di daftar barang toko SDA/);
    assert.strictEqual(await page.$eval('.modal-kaki .btn.primary', (b) => b.disabled), true);
    await page.fill('#okBaris tr:nth-child(1) [data-k]', 'RTN-002');
    await page.fill('#okCatatan', 'Hitung ulang keset');
    await page.click('#okPeriksa');
    await page.waitForSelector('#okHasil .alert.ok');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/1 opname dibuat untuk SDA/);
    const [okSda] = await db("select id from opname_kantor where kode_toko = 'SDA' and catatan = 'Hitung ulang keset'");
    await tunggu(500);
    await page.click(`#okDaftar tr.klik:has-text("#${okSda.id}")`);
    await page.click('.modal-kaki button:has-text("Batalkan opname")');
    await page.click('.modal-latar:last-child .modal-kaki .btn.danger');
    await toastCocok(/dibatalkan/);
    assert.strictEqual((await db('select status from opname_kantor where id = $1', [okSda.id]))[0].status, 'dibatalkan');
    ok('opname dari kantor: daftar & status, unduh template toko, upload → pratinjau → simpan per zona; toko menerapkan → Diterapkan + nomor OP-; isi baris, kode salah ditolak, dibatalkan');

    await buka('kiriman');
    await page.setInputFiles('#kjFile', fileAccurate());
    await page.waitForSelector('#kjSimpan');
    assert.match(await page.textContent('#kjPratinjau'), /1 DO, 2 baris/);
    assert.match(await page.textContent('#kjPratinjau'), /MLG/);
    const [unduh] = await Promise.all([page.waitForEvent('download'), page.click('[data-unduh="0"]')]);
    const fImport = path.join(OUT, unduh.suggestedFilename());
    await unduh.saveAs(fImport);
    const isiImport = XLSX.utils.sheet_to_json(XLSX.readFile(fImport).Sheets.Penerimaan);
    assert.deepStrictEqual(isiImport.map((r) => [r.No_Surat_Jalan, r.Kode, r.Jumlah, r.Satuan]), [['DO.UJI.WEB.1', 'PLJ-003', 1, 'Dus'], ['DO.UJI.WEB.1', 'RTN-002', 10, 'Biji']]);
    await shot('04-upload-accurate');
    await page.click('#kjSimpan');
    await toastCocok(/1 surat jalan baru/);
    await page.selectOption('#kjStatus', '');
    await tunggu(600);
    assert.match(await page.textContent('#kjDaftar'), /DO\.UJI\.WEB\.1/);
    await page.click('#kjDaftar tr.klik:has-text("DO.2026.11.00102")');
    await page.waitForSelector('.modal');
    assert.match(await page.textContent('.modal'), /Selisih qty/);
    await shot('04b-detail-surat-jalan');
    await page.click('.modal .tutup');
    ok('surat jalan: upload Accurate di browser, unduh file import Trizone (Coly→Dus, Pcs→Biji), simpan, detail selisih');

    await buka('pembelian');
    await page.click('#pbIsi tr.klik');
    await page.waitForSelector('.modal [data-qty]');
    await shot('05-po-usulan');
    const qtyInput = await page.$('.modal [data-qty]');
    const sku = await qtyInput.getAttribute('data-qty');
    await qtyInput.fill('48');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/disetujui/);
    await tunggu(500);
    const [po] = await db('select no_po, status, disetujui_oleh from po');
    assert.strictEqual(po.status, 'DISETUJUI');
    assert.ok(po.disetujui_oleh);
    assert.strictEqual(Number((await db('select qty_disetujui from po_baris where no_po = $1 and sku = $2', [po.no_po, sku]))[0].qty_disetujui), 48);
    await page.click('#pbIsi tr.klik');
    await page.waitForSelector('#poAcc');
    await page.fill('#poAcc', 'PO/ACC/2026/0001');
    await page.click('.modal-kaki button:has-text("Tandai sudah dikirim")');
    await tunggu(600);
    await page.click('#pbIsi tr.klik');
    await page.click('.modal-kaki button:has-text("Terima barang")');
    await page.waitForSelector('#trNo');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/Selesai/);
    await tunggu(500);
    const [po2] = await db('select status, no_po_accurate from po');
    assert.deepStrictEqual([po2.status, po2.no_po_accurate], ['SELESAI', 'PO/ACC/2026/0001']);
    const masuk1 = await db("select sum(qty)::int n from gudang_mutasi where jenis = 'TERIMA_PRINCIPAL' and referensi like 'TR-%'");
    assert.ok(masuk1[0].n > 0);
    await page.click('#pbTab [data-t="usulan"]');
    await tunggu(600);
    assert.strictEqual((await page.locator('#pbIsi .card').count()), 1, 'usulan beli satu daftar, tidak per principal');
    await page.click('#pbAtur');
    await page.fill('#atLead', '10');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/Pengaturan usulan disimpan/);
    await tunggu(600);
    assert.match(await page.textContent('#pbAturTeks'), /Lead time 10 hari/);
    assert.strictEqual(Number((await db("select nilai from pengaturan where kunci = 'usulan_lead_time_hari'"))[0].nilai), 10);
    await shot('05b-usulan-beli');
    ok('pembelian: owner mengubah qty & menyetujui PO, ditandai dikirim (no. Accurate), barang diterima → stok gudang & status Selesai; usulan beli satu daftar, lead time diatur owner');

    await buka('barang');
    await page.click('#brIsiTabel tr.klik:has-text("RTN-001")');
    assert.deepStrictEqual(await page.$$eval('#fSatuan option', (o) => o.map((x) => x.value)), ['Coly', 'Biji']);
    assert.strictEqual(await page.inputValue('#fSatuan'), 'Coly');
    await page.selectOption('#fSatuan', 'Biji');
    assert.deepStrictEqual([await page.inputValue('#fRasio'), await page.$eval('#fRasio', (e) => e.disabled)], ['1', true]);
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/disimpan/);
    assert.deepStrictEqual(Object.values((await db("select satuan_masuk, rasio_isi from produk where sku = 'RTN-001'"))[0]), ['Biji', 1]);
    await tunggu(400);
    await page.click('#brIsiTabel tr.klik:has-text("RTN-001")');
    await page.selectOption('#fSatuan', 'Coly');
    assert.strictEqual(await page.$eval('#fRasio', (e) => e.disabled), false);
    await page.fill('#fRasio', '2');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/disimpan/);
    assert.deepStrictEqual(Object.values((await db("select satuan_masuk, rasio_isi from produk where sku = 'RTN-001'"))[0]), ['Coly', 2]);
    await tunggu(400);
    await page.click('#brIsiTabel tr.klik:has-text("RTN-002")');
    await page.fill('#fHarga', '27500');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/disimpan/);
    assert.strictEqual(Number((await db("select harga_jual_konsumen from produk where sku = 'RTN-002'"))[0].harga_jual_konsumen), 27500);
    await page.click('#brMarkup');
    await page.fill('#mkNilai', '7');
    await page.click('.modal-kaki .btn.primary');
    await tunggu(600);
    assert.strictEqual(Number((await db("select nilai from pengaturan where kunci = 'markup_jual_ke_toko'"))[0].nilai), 0.07);
    await shot('06-master-barang');
    ok('master barang: satuan masuk pilihan Coly / Biji (Biji → isi 1 dikunci), ubah harga jual, markup 7% (owner)');

    // Import Excel: unduh master → ubah di "Excel" → import → pratinjau → simpan
    await page.click('#brImport');
    await page.waitForSelector('#imFile');
    const [dlTpl] = await Promise.all([page.waitForEvent('download'), page.click('#imTemplate')]);
    const fTpl = path.join(OUT, dlTpl.suggestedFilename());
    await dlTpl.saveAs(fTpl);
    assert.deepStrictEqual(XLSX.utils.sheet_to_json(XLSX.readFile(fTpl).Sheets.Barang, { header: 1 })[0].slice(0, 8),
      ['Barcode', 'SKU', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Satuan_Masuk', 'Rasio_Isi_Dus']);
    const [dlMaster] = await Promise.all([page.waitForEvent('download'), page.click('#imMaster')]);
    const fMaster = path.join(OUT, dlMaster.suggestedFilename());
    await dlMaster.saveAs(fMaster);
    const master = XLSX.utils.sheet_to_json(XLSX.readFile(fMaster).Sheets.Barang, { defval: '' });
    assert.strictEqual(master.length, Number((await db('select count(*) n from produk'))[0].n));
    const rtn = master.find((r) => r.SKU === 'RTN-002');
    assert.strictEqual(rtn.Harga_Jual, 27500);
    rtn.Harga_Jual = 28000;
    assert.ok(!('Principal' in master[0]), 'file master tanpa kolom principal');
    master.push({ Barcode: '2999000000017', SKU: 'IMP-WEB-1', Nama_Barang: 'Barang Import Web', Merk: 'Uji', Kategori: 'Uji', Harga_Jual: 15000,
      Satuan_Masuk: 'Dus', Rasio_Isi_Dus: 6, Harga_Beli: 9000, Aktif: 'Ya' });
    const fUbah = path.join(OUT, 'Master_diubah.xlsx');
    const wbUbah = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbUbah, XLSX.utils.json_to_sheet(master), 'Barang');
    XLSX.writeFile(wbUbah, fUbah);
    await page.setInputFiles('#imFile', fUbah);
    await page.waitForSelector('#imHasil .alert.ok');
    const ringkas = await page.textContent('#imHasil');
    assert.match(ringkas, /1 baru/);
    assert.match(ringkas, /1 diubah/);
    assert.match(ringkas, /harga jual: 27\.500 → 28\.000/);
    assert.match(ringkas, /harga jual 15\.000 · 1 Coly = 6 Biji · harga beli 9\.000/);
    await shot('06b-import-barang-pratinjau');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/Import selesai: 1 barang baru, 1 diubah/);
    assert.strictEqual(Number((await db("select harga_jual_konsumen from produk where sku = 'RTN-002'"))[0].harga_jual_konsumen), 28000);
    const [impBaru] = await db(`select rasio_isi, satuan_masuk from produk where sku = 'IMP-WEB-1'`);
    assert.deepStrictEqual([impBaru.rasio_isi, impBaru.satuan_masuk], [6, 'Coly']);
    // File bermasalah: pratinjau menampilkan kesalahan per baris, tombol simpan mati
    const fSalah = path.join(OUT, 'Import_salah.xlsx');
    const wbSalah = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbSalah, XLSX.utils.aoa_to_sheet([['SKU', 'Nama_Barang', 'Barcode', 'Harga_Jual'],
      ['IMP-WEB-2', '', '2999000000024', 1000], ['IMP-WEB-3', 'Barcode dobel', '2999000000017', 'seribu']]), 'Barang');
    XLSX.writeFile(wbSalah, fSalah);
    await page.click('#brImport');
    await page.setInputFiles('#imFile', fSalah);
    await page.waitForSelector('#imHasil .alert.bad');
    const teksSalah = await page.textContent('#imHasil');
    assert.match(teksSalah, /wajib ada nama/);
    assert.match(teksSalah, /sudah dipakai SKU IMP-WEB-1/);
    assert.match(teksSalah, /bukan angka/);
    assert.strictEqual(await page.$eval('.modal-kaki .btn.primary', (b) => b.disabled), true);
    await shot('06c-import-barang-salah');
    await page.click('.modal .tutup');
    ok('master barang: import Excel (unduh template & master, ubah, pratinjau, simpan; kesalahan per baris menahan simpan)');

    assert.strictEqual(await page.locator('.nav a[data-h="principal"]').count(), 0, 'menu Principal sudah dihapus');
    await buka('asisten');
    await page.click('#aiBaru');
    await page.click('#aiSaran button:first-child');
    await page.waitForFunction(() => document.querySelectorAll('.msg.asisten:not(#aiTunggu)').length >= 1 && !document.querySelector('#aiTunggu'), null, { timeout: 15000 });
    assert.ok(await page.$('.msg.asisten table'));
    assert.match(await page.textContent('.msg.asisten .alat'), /tren produk/);
    assert.strictEqual(await page.locator('#aiList [data-id]').count(), 1);
    await shot('08-asisten');
    ok('asisten: pertanyaan contoh dijawab dengan tabel dari data; percakapan tersimpan');

    await buka('toko');
    await page.click('[data-kunci="KRP"]');
    await page.waitForSelector('#kunciBox');
    assert.match(await page.textContent('#kunciBox'), /^[0-9a-f]{48}$/);
    await shot('09-kunci-toko');
    await page.click('.modal-kaki .btn.primary');
    await page.selectOption('[data-pel="Utama"]', 'KRP');
    await toastCocok(/Utama → KRP/);
    assert.strictEqual((await db("select kode_toko from pelanggan_accurate where nama = 'Utama'"))[0].kode_toko, 'KRP');
    await shot('09b-toko');
    ok('toko: owner membuat kunci (tampil sekali), memetakan pelanggan Accurate');

    await buka('pengguna');
    assert.strictEqual((await page.$$('#pgDaftar tbody tr')).length, 3);
    await page.click('#pgDaftar tr.klik:has-text("admin@contoh.local")');
    await page.fill('#uNama', 'Admin Kantor Pusat');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/disimpan/);
    ok('pengguna: owner mengubah nama pengguna');

    await page.setViewportSize({ width: 390, height: 844 });
    await buka('ringkasan').catch(async () => { await page.click('#btnMenu'); await buka('ringkasan'); });
    await tunggu(500);
    const lebarBody = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(lebarBody <= 392, `halaman melebar ${lebarBody}px di HP`);
    await shot('10-hp-ringkasan');
    ok('tampilan HP: tanpa geser horizontal');

    // Pemilik toko: hanya tokonya, menu terbatas
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.click('#btnKeluar');
    await page.waitForSelector('#lgEmail');
    await masuk('tropodo@contoh.local', 'toko123');
    const menu = await page.$$eval('.nav a', (x) => x.map((a) => a.dataset.h));
    assert.deepStrictEqual(menu, ['ringkasan', 'penjualan', 'stok', 'asisten']);
    await page.waitForSelector('#rkToko tbody tr');
    assert.deepStrictEqual(await page.$$eval('#rkToko tbody tr td:first-child b', (x) => x.map((e) => e.textContent)), ['TRP']);
    // Opname dari kantor: pemilik toko hanya melihat opname tokonya, tidak bisa membuat
    await buka('stok');
    await page.click('#stTab [data-t="kantor"]');
    await page.waitForSelector('#okDaftar tbody tr');
    const okPemilik = await page.$$eval('#okDaftar tbody tr', (x) => x.map((tr) => tr.children[1].textContent));
    assert.ok(okPemilik.length >= 1 && okPemilik.every((k) => k === 'TRP'), okPemilik.join(','));
    assert.strictEqual(await page.$('#okBuat'), null);
    await page.goto(`${BASE}/#pembelian`);
    await page.waitForSelector('#isi .page-head');
    assert.match(await page.textContent('#isi h1'), /Ringkasan/);
    await shot('11-pemilik-toko');
    ok('pemilik toko: menu terbatas, hanya data TRP, halaman kantor tidak bisa dibuka');

    // Login dengan kata sandi salah memang dibalas 400 (disengaja di awal uji)
    const nyata = kesalahan.filter((k) => !/favicon/.test(k) && !/invalid_credentials/.test(k) && !/status of 400/.test(k));
    assert.deepStrictEqual(nyata, [], `error di konsol browser:\n${nyata.join('\n')}`);
    ok('tidak ada error JavaScript di konsol browser');
    console.log(`\n${lulus} uji browser lulus · tangkapan layar: ${OUT}`);
  } catch (e) {
    if (page) await page.screenshot({ path: path.join(OUT, 'GAGAL.png'), fullPage: true }).catch(() => {});
    console.error('\n✗', e.stack || e.message);
    if (kesalahan.length) console.error('Konsol browser:\n' + kesalahan.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    await pool.end();
  }
})();
