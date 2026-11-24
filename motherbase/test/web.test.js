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
  const demo = { toko: {} }; // Trizone contoh per toko: dipakai untuk menjawab permintaan homebase
  await buatDataDemo(dbUrl, demo);
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
  // Tunggu sampai satu baris di database berisi nilai yang diharapkan (notifikasi lama bisa masih tampil)
  const tungguDb = async (sql, harap, ms = 10000) => {
    const akhir = Date.now() + ms;
    let isi;
    while (Date.now() < akhir) {
      isi = Object.values((await db(sql))[0] || {});
      if (JSON.stringify(isi) === JSON.stringify(harap)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepStrictEqual(isi, harap);
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
    assert.match(perhatian, /1 pesanan pelanggan lewat tanggal ambil/);
    assert.strictEqual((await page.$$('#rkToko tbody tr')).length, 10);
    // Per toko: tanpa QRIS & Transfer; Omzet Special + Houseware (+ Lainnya) = Total Omzet
    const kepalaToko = await page.$$eval('#rkToko thead th', (x) => x.map((th) => th.textContent.trim()));
    assert.deepStrictEqual(kepalaToko, ['Toko', 'Transaksi', 'Tunai', 'Pembatalan', 'Omzet Special', 'Omzet Houseware', 'Omzet Lainnya', 'Total Omzet', 'Data terakhir masuk']);
    const rpAngka = (x) => Number(x.replace(/[^0-9-]/g, '') || 0);
    const barisToko = await page.$$eval('#rkToko tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.ok(barisToko.every((r) => rpAngka(r[4]) + rpAngka(r[5]) + rpAngka(r[6]) === rpAngka(r[7])), barisToko.map((r) => r.join('|')).join('; '));
    await shot('01-ringkasan');
    await page.selectOption('#perPilih', '30');
    await page.waitForTimeout(600);
    await shot('01b-ringkasan-30-hari');
    ok('ringkasan: omzet, grafik harian, perlu perhatian (SJ, SO, PO), 10 toko');

    await buka('penjualan');
    for (const t of ['produk', 'tren', 'abc', 'kasir', 'harian', 'batal']) {
      await page.click(`#pjTab [data-t="${t}"]`);
      await page.waitForFunction(() => !document.querySelector('#pjIsi .kosong') || /Tidak ada/.test(document.querySelector('#pjIsi').textContent));
      await tunggu(250);
      assert.ok((await page.$$('#pjIsi tbody tr')).length > 0, `tab ${t} kosong`);
      if (t === 'tren') await shot('02-penjualan-tren');
      if (t === 'harian') {
        assert.match(await page.textContent('#pjIsi'), /Pembatalan[\s\S]*1 nota/);
        // Demo: kategori Plastik / Rotan → semua masuk Omzet Lainnya; Special + Houseware + Lainnya = Total Omzet
        const kepalaHari = await page.$$eval('#pjIsi thead th', (x) => x.map((th) => th.textContent.trim()));
        assert.deepStrictEqual(kepalaHari, ['Tanggal', 'Transaksi', 'Pembatalan', 'Omzet Special', 'Omzet Houseware', 'Omzet Lainnya', 'Total Omzet']);
        const angkaRp = (x) => Number(x.replace(/[^\d-]/g, '') || 0);
        const barisHari = await page.$$eval('#pjIsi tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
        assert.ok(barisHari.every((r) => angkaRp(r[3]) + angkaRp(r[4]) + angkaRp(r[5]) === angkaRp(r[6])), barisHari.map((r) => r.join('|')).join('\n'));
        await shot('02c-penjualan-per-hari');
      }
    }
    // Pembatalan: Malang (5 hari lalu), Tropodo (2 hari lalu, shift tertutup) dan hari ini (shift berjalan)
    const batal = await page.$$eval('#pjBatalNota tbody tr', (x) => x.map((tr) => tr.textContent));
    assert.strictEqual(batal.length, 3);
    assert.ok(batal.every((b) => /BTL-\d{8}-\d{4}/.test(b) && /Rina/.test(b) && /Bu Sari/.test(b)), batal.join('\n'));
    assert.ok(batal.some((b) => /Salah ambil barang/.test(b)) && batal.some((b) => /Pelanggan batal beli/.test(b)));
    await shot('02b-penjualan-pembatalan');
    await page.click('#pjBatalNota tbody tr.klik');
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
    assert.strictEqual((await page.$$('#pjBatalNota tbody tr')).length, 2);
    const [{ n: struk }] = await db("select count(distinct no_struk)::int n from penjualan where no_struk like 'BTL-%'");
    assert.strictEqual(struk, 3);
    ok('penjualan: per produk, naik/turun, ABC, per kasir, per hari, pembatalan (rincian & penyetuju); filter toko');

    // Pembatalan per toko & per nota di Penjualan → Pembatalan (menu Pembatalan Nota sudah dihapus)
    assert.ok(!(await page.$$eval('.nav a[data-h]', (a) => a.map((x) => x.dataset.h))).includes('pembatalan'), 'menu Pembatalan Nota dihapus');
    await page.selectOption('#pjToko', '');
    await page.waitForFunction(() => document.querySelectorAll('#pjBatalNota tbody tr').length === 3);
    const perToko = await page.$$eval('#pjBatalToko tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.deepStrictEqual(perToko.map((r) => [r[0].slice(0, 3), r[1]]).sort(), [['MLG', '1'], ['TRP', '2']]);
    assert.ok(perToko.every((r) => /%/.test(r[4]) && r[5] !== '-'), JSON.stringify(perToko));
    assert.match(await page.textContent('#pjBatalRingkas'), /3 nota dibatalkan/);
    await shot('02d-penjualan-pembatalan-per-toko');
    const [csvToko] = await Promise.all([page.waitForEvent('download'), page.click('#pjCsvBatalToko')]);
    assert.match(csvToko.suggestedFilename(), /^pembatalan_per_toko_/);
    await page.click('#pjBatalToko tr.klik:has-text("TRP")');
    await page.waitForFunction(() => document.querySelectorAll('#pjBatalNota tbody tr').length === 2);
    assert.strictEqual(await page.$eval('#pjToko', (x) => x.value), 'TRP');
    assert.match(await page.textContent('#pjBatalJudulNota'), /TRP \(2\)/);
    const [csvNota] = await Promise.all([page.waitForEvent('download'), page.click('#pjCsv')]);
    const fNota = path.join(OUT, csvNota.suggestedFilename());
    await csvNota.saveAs(fNota);
    const isiCsv = fs.readFileSync(fNota, 'utf8');
    assert.match(isiCsv, /Nota asal;.*Diminta oleh;Disetujui oleh/);
    assert.strictEqual(isiCsv.trim().split(/\r?\n/).length, 3);
    await page.selectOption('#pjToko', '');
    // Alamat lama #pembatalan membuka Penjualan → Pembatalan
    await page.click('.nav a[data-h="ringkasan"]');
    await page.waitForSelector('#rkToko tbody tr');
    await page.evaluate(() => { S.tabPenjualan = 'produk'; location.hash = 'pembatalan'; });
    await page.waitForSelector('#pjBatalNota');
    assert.strictEqual(await page.$eval('.nav a.aktif', (a) => a.dataset.h), 'penjualan');
    assert.strictEqual(await page.$eval('#pjTab .aktif', (b) => b.dataset.t), 'batal');
    await page.evaluate(() => { S.tabPenjualan = 'produk'; });
    ok('pembatalan nota di Penjualan: per toko (jumlah, nilai, % batal) & per nota, klik toko = filter, CSV per toko & per nota; menu Pembatalan Nota dihapus, #pembatalan diarahkan');

    // Pesanan pelanggan dari toko
    await buka('pesanan');
    await page.waitForFunction(() => document.querySelectorAll('#psIsi tbody tr').length === 2);
    const belumDiambil = await page.$$eval('#psIsi tbody tr', (x) => x.map((tr) => tr.textContent));
    assert.ok(belumDiambil.every((r) => /TRP/.test(r)) && belumDiambil.some((r) => /Pak Joko/.test(r) && /lewat/.test(r)), belumDiambil.join('|'));
    assert.match(await page.textContent('#psRingkas'), /2 belum diambil, 1 lewat tanggal ambil · deposit tertahan Rp 150\.000/);
    await shot('02e-pesanan-pelanggan');
    await page.selectOption('#psStatus', '');
    await page.waitForFunction(() => document.querySelectorAll('#psIsi tbody tr').length === 4);
    await page.selectOption('#psToko', 'MLG');
    await page.waitForFunction(() => document.querySelectorAll('#psIsi tbody tr').length === 1);
    assert.match(await page.textContent('#psIsi'), /Bu Dewi[\s\S]*Diambil/);
    await page.selectOption('#psToko', '');
    await page.fill('#psCari', 'sri');
    await page.waitForFunction(() => document.querySelectorAll('#psIsi tbody tr').length === 1);
    await page.click('#psIsi tr.klik');
    await page.waitForSelector('.modal');
    const rincianPs = await page.textContent('.modal');
    assert.match(rincianPs, /Tidak jadi beli/);
    assert.match(rincianPs, /Dikembalikan ke pelanggan/);
    assert.match(rincianPs, /Bu Sari/);
    assert.match(rincianPs, /PLJ-002/);
    await page.click('.modal .tutup');
    const [csvPs] = await Promise.all([page.waitForEvent('download'), page.click('#psCsv')]);
    assert.match(csvPs.suggestedFilename(), /^pesanan_semua_/);
    await page.fill('#psCari', '');
    await page.selectOption('#psStatus', 'baru');
    ok('pesanan pelanggan: belum diambil (tanda lewat, deposit tertahan), semua status, filter toko & cari, rincian batal, CSV');

    const menuKantor = await page.$$eval('.nav a[data-h]', (a) => a.map((x) => x.dataset.h));
    assert.ok(menuKantor.includes('stok') && !menuKantor.includes('opname'), 'Stock Opname digabung ke menu Stok & Barang');
    // Alamat lama #opname membuka tab Opname dari kantor di Stok & Barang
    await page.evaluate(() => { location.hash = 'opname'; });
    await page.waitForSelector('#okToko');
    assert.strictEqual(await page.$eval('.nav a.aktif', (a) => a.dataset.h), 'stok');
    assert.strictEqual(await page.$eval('#stTab .aktif', (b) => b.dataset.t), 'kantor');
    assert.deepStrictEqual(await page.$$eval('#stTab [data-t]', (b) => b.map((x) => x.dataset.t)), ['cari', 'lambat', 'dok', 'kantor', 'so', 'selisih', 'barang']);
    await shot('03-stok-tab-opname');
    await page.click('#stTab [data-t="so"]');
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
    ok('stock opname: SO disetujui dengan catatan (tercatat penyetujunya), selisih vs Trizone');

    // Opname dari kantor: tarik stok → unduh template → hitung → upload → kirim → toko menerapkan
    const trp = demo.toko.TRP;
    await page.evaluate(() => { PANTAU.ms = 300; });
    await page.click('#stTab [data-t="kantor"]');
    await page.waitForSelector('#okToko');
    await page.selectOption('#okToko', 'TRP');
    await page.waitForFunction(() => /Stok di template/.test(document.querySelector('#okStokPer').textContent));
    await page.click('#okTarik');
    await toastCocok(/Permintaan dikirim ke TRP/);
    await tungguDb("select minta_update_at is not null from toko_status where kode_toko = 'TRP'", [true]);
    assert.match(await page.textContent('#okTarik'), /Menunggu toko/);
    const tarik = await trp.mb.cekPermintaan(); // Trizone TRP memeriksa permintaan (tiap 5 menit di toko)
    assert.ok(tarik.minta && tarik.kirim, JSON.stringify(tarik));
    await toastCocok(/Data terbaru TRP sudah masuk/);
    await page.waitForFunction(() => /Tarik stok terbaru/.test(document.querySelector('#okTarik').textContent));
    await page.waitForFunction(() => /Stok di template/.test(document.querySelector('#okStokPer').textContent));

    await page.selectOption('#okKategori', 'Plastik');
    const [tpl] = await Promise.all([page.waitForEvent('download'), page.click('#okUnduh')]);
    assert.match(tpl.suggestedFilename(), /^Opname_TRP_\d{12}_Plastik\.xlsx$/);
    const isiTpl = XLSX.utils.sheet_to_json(XLSX.readFile(await tpl.path()).Sheets.Opname, { defval: '' });
    assert.deepStrictEqual(Object.keys(isiTpl[0]), ['Kode', 'Nama_Barang', 'Kategori', 'Satuan_Masuk', 'Isi_Coly', 'Display Toko', 'Display Toko (Coly)', 'Fisik Display Toko',
      'Gudang Utama', 'Gudang Utama (Coly)', 'Fisik Gudang Utama', 'Gudang BS', 'Gudang BS (Coly)', 'Fisik Gudang BS',
      'Gudang Shopee', 'Gudang Shopee (Coly)', 'Fisik Gudang Shopee', 'Tanggal_Stok', 'Toko']);
    assert.ok(isiTpl.every((r) => /^PLJ-/.test(r.Kode) && r.Toko === 'TRP' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r.Tanggal_Stok)), 'hanya kategori Plastik');
    const pTrp = (sku) => trp.svc.getProduct(sku);
    const ember = isiTpl.find((r) => r.Kode === 'PLJ-001');
    const gayung = isiTpl.find((r) => r.Kode === 'PLJ-002');
    assert.strictEqual(ember['Display Toko'], pTrp('PLJ-001').floor_stock);
    const { teksColy } = require('../web/lib/opname-kantor');
    assert.deepStrictEqual([ember.Kategori, ember.Satuan_Masuk, ember.Isi_Coly], ['Plastik', 'Coly', 6]);
    assert.strictEqual(ember['Display Toko (Coly)'], teksColy(ember['Display Toko'], 6));
    assert.strictEqual(gayung['Gudang Utama (Coly)'], teksColy(gayung['Gudang Utama'], 24));
    const tulisHasil = (rows, nama) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Opname');
      const f = path.join(OUT, nama);
      XLSX.writeFile(wb, f);
      return f;
    };
    // File salah: kode yang tidak ada di toko → ditahan
    const salah = isiTpl.map((r) => ({ ...r }));
    salah[0]['Fisik Display Toko'] = 1;
    salah.push({ ...salah[0], Kode: 'TIDAK-ADA', 'Fisik Display Toko': 3 });
    await page.setInputFiles('#okFile', tulisHasil(salah, 'opname_salah.xlsx'));
    await page.waitForSelector('#okPratinjau .alert.bad');
    assert.match(await page.textContent('#okPratinjau'), /TIDAK-ADA tidak ada di Daftar Barang toko TRP/);
    assert.strictEqual(await page.$('#okKirim'), null);
    // Hasil hitung: Ember di display kurang 2, Gayung di gudang lebih 1
    const hasilHitung = isiTpl.map((r) => ({ ...r }));
    hasilHitung.find((r) => r.Kode === 'PLJ-001')['Fisik Display Toko'] = ember['Display Toko'] - 2;
    hasilHitung.find((r) => r.Kode === 'PLJ-002')['Fisik Gudang Utama'] = gayung['Gudang Utama'] + 1;
    const fileHasil = tulisHasil(hasilHitung, 'opname_hasil.xlsx');
    await page.setInputFiles('#okFile', fileHasil);
    await page.waitForSelector('#okKirim');
    const pratinjau = await page.textContent('#okPratinjau');
    assert.match(pratinjau, /Display Toko[\s\S]*Gudang Utama/);
    assert.match(pratinjau, /PLJ-001[\s\S]*-2/);
    await shot('03c-opname-kantor-pratinjau');
    await page.fill('#okCatatan', 'Opname rak plastik');
    await page.click('#okKirim');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/OPK-\d{8}-\d{3}, OPK-\d{8}-\d{3} dikirim ke TRP/);
    const dokOpk = await db("select no_dok, zona, status from opname_kantor where kode_toko = 'TRP' order by id");
    assert.deepStrictEqual(dokOpk.map((d) => [d.zona, d.status]), [['floor', 'dikirim'], ['warehouse', 'dikirim']]);
    // Toko menjual 1 Ember setelah stok ditarik, sebelum opname masuk: tetap terhitung
    const sebelum = pTrp('PLJ-001').floor_stock;
    trp.svc.checkout({ items: [{ sku: 'PLJ-001', qty: 1 }], payment_method: 'QRIS' });
    const gudangGayung = pTrp('PLJ-002').warehouse_stock;
    const jawab = await trp.mb.cekPermintaan();
    assert.strictEqual(jawab.opname.length, 2, JSON.stringify(jawab));
    assert.strictEqual(pTrp('PLJ-001').floor_stock, sebelum - 1 - 2);
    assert.strictEqual(pTrp('PLJ-002').warehouse_stock, gudangGayung + 1);
    const terapan = await db("select o.status, o.no_op_toko, r.status as review, r.catatan from opname_kantor o join stok_opname_review r on r.kode_toko = o.kode_toko and r.no_op = o.no_op_toko where o.kode_toko = 'TRP' order by o.id");
    assert.strictEqual(terapan.length, 2);
    assert.ok(terapan.every((x) => x.status === 'diterapkan' && x.review === 'DISETUJUI' && /^Opname dari kantor OPK-/.test(x.catatan)), JSON.stringify(terapan));
    await page.waitForFunction(() => [...document.querySelectorAll('#okDaftar tbody tr')].filter((tr) => /Diterapkan/.test(tr.textContent)).length === 2, null, { timeout: 15000 });
    await shot('03d-opname-kantor-diterapkan');
    await page.click('#okDaftar tr.klik');
    await page.waitForSelector('.modal');
    assert.match(await page.textContent('.modal'), /Diterapkan di toko[\s\S]*OP-/);
    await page.click('.modal .tutup');
    // File yang sama dikirim lagi: ditolak (selisih tidak boleh dihitung dua kali)
    await page.setInputFiles('#okFile', fileHasil);
    await page.waitForSelector('#okKirim');
    await page.click('#okKirim');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/sudah diopname kantor setelah stok di file/);

    // Stok per jam yang dipilih (riwayat 7 hari): mis. lupa unduh saat menghitung pagi tadi
    const lama = (await db(`insert into toko_snapshot_waktu values ('TRP', date_trunc('second', now() - interval '2 days')) returning
      to_char(per_waktu at time zone 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS') as jam, to_char(per_waktu at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') as teks`))[0];
    await db(`insert into stok_toko_riwayat values ('TRP', 'PLJ-001', (select min(per_waktu) from toko_snapshot_waktu where kode_toko = 'TRP'), 99, 5, 0, 0)`);
    await page.click('#stTab [data-t="kantor"]'); // muat ulang pilihan Stok per
    await page.waitForFunction(() => document.querySelectorAll('#okWaktu option').length >= 2);
    const pilihanWaktu = await page.$$eval('#okWaktu option', (o) => o.map((x) => ({ v: x.value, t: x.textContent })));
    assert.match(pilihanWaktu[0].t, /^Stok terbaru \(update /);
    const opsiLama = pilihanWaktu[pilihanWaktu.length - 1];
    assert.match(opsiLama.t, /update terakhir \d\d\.\d\d$/);
    await page.selectOption('#okWaktu', opsiLama.v);
    await page.waitForFunction(() => /stok akhir hari itu/.test(document.querySelector('#okStokPer').textContent));
    await page.selectOption('#okKategori', 'Plastik');
    const [tplLama] = await Promise.all([page.waitForEvent('download'), page.click('#okUnduh')]);
    const isiLama = XLSX.utils.sheet_to_json(XLSX.readFile(await tplLama.path()).Sheets.Opname, { defval: '' });
    const emberLama = isiLama.find((r) => r.Kode === 'PLJ-001');
    assert.deepStrictEqual([emberLama['Display Toko'], emberLama['Display Toko (Coly)'], emberLama['Gudang Utama'], emberLama.Tanggal_Stok], [99, '16 Coly 3 Biji', 5, lama.teks]);
    await shot('03e-opname-kantor-stok-lama');
    await page.selectOption('#okWaktu', '');
    await page.waitForFunction(() => /update terakhir toko/.test(document.querySelector('#okStokPer').textContent));
    ok('opname dari kantor: tarik stok, template per kategori (stok Coly & isi), upload (kode salah ditahan), kirim, toko menerapkan dengan patokan, review SO otomatis, kirim ulang ditolak, stok per jam yang dipilih');

    // Laporan → Mutasi Item (lihat & unduh Excel)
    await buka('laporan');
    await page.selectOption('#lmToko', 'TRP');
    await page.fill('#lmDari', '2000-01-01');
    await page.click('#lmLihat');
    await page.waitForSelector('#lmRingkas');
    const barisMutasi = await page.$$eval('#lmIsi tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    const emberMutasi = barisMutasi.find((r) => r[0] === 'PLJ-001');
    const pEmber = trp.svc.getProduct('PLJ-001');
    assert.strictEqual(emberMutasi[7], String(pEmber.floor_stock + pEmber.warehouse_stock + pEmber.damaged_stock + pEmber.shopee_stock), emberMutasi.join('|'));
    assert.strictEqual(barisMutasi[barisMutasi.length - 1][1], 'Total');
    await shot('03f-laporan-mutasi-item');
    const [xlsMutasi] = await Promise.all([page.waitForEvent('download'), page.click('#lmUnduh')]);
    assert.match(xlsMutasi.suggestedFilename(), /^Mutasi_Item_TRP_2000-01-01_\d{4}-\d\d-\d\d\.xlsx$/);
    const bukuMutasi = XLSX.readFile(await xlsMutasi.path());
    assert.deepStrictEqual(bukuMutasi.SheetNames, ['TRP']);
    const aoaMutasi = XLSX.utils.sheet_to_json(bukuMutasi.Sheets.TRP, { header: 1, defval: '' });
    assert.strictEqual(aoaMutasi[0][0], 'Laporan Mutasi Item');
    assert.deepStrictEqual(aoaMutasi[6], ['Kode Item', 'Nama Item', 'Satuan', 'Awal', 'Masuk', 'Penjualan', 'Barang Keluar', 'Akhir']);
    const isiMutasi = aoaMutasi.slice(7, -1);
    const totalMutasi = aoaMutasi[aoaMutasi.length - 1];
    assert.strictEqual(totalMutasi[0], 'Total');
    assert.strictEqual(isiMutasi.length, barisMutasi.length - 1);
    assert.strictEqual(totalMutasi[7], isiMutasi.reduce((a, r) => a + r[7], 0));
    assert.ok(isiMutasi.every((r) => r[3] + r[4] - r[5] - r[6] === r[7]), 'Awal + Masuk − Penjualan − Barang Keluar = Akhir');
    assert.ok(isiMutasi.some((r) => r[5] > 0), 'ada penjualan');
    await page.selectOption('#lmToko', '');
    const [xlsSemua] = await Promise.all([page.waitForEvent('download'), page.click('#lmUnduh')]);
    assert.match(xlsSemua.suggestedFilename(), /^Mutasi_Item_Semua_/);
    const sheetSemua = XLSX.readFile(await xlsSemua.path()).SheetNames;
    assert.ok(sheetSemua.includes('TRP') && sheetSemua.includes('MLG') && sheetSemua.length > 2, sheetSemua.join(','));
    ok('laporan: menu Laporan, Mutasi Item per toko (akhir = stok Trizone, total), unduh Excel satu toko & semua toko (sheet per toko)');

    // Laporan → Penjualan (omzet per toko: Houseware, Special, Total, %)
    await db("update produk set kategori = case kategori when 'Plastik' then 'HOUSEWARE' when 'Rotan' then 'SPECIAL' else kategori end");
    try {
      await page.fill('#loDari', '2000-01-01');
      await page.click('#loLihat');
      await page.waitForSelector('#loRingkas');
      const kepalaLo = await page.$$eval('#loIsi thead th', (x) => x.map((th) => th.textContent.trim()));
      assert.deepStrictEqual(kepalaLo, ['TOKO', 'Houseware', 'Special', 'Total', '%']);
      const barisLo = await page.$$eval('#loIsi tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
      const angkaLo = (x) => Number(x.replace(/[^0-9-]/g, '') || 0);
      assert.deepStrictEqual(barisLo.map((r) => r[0]), ['Krampung', 'Manukan', 'Sidoarjo', 'Tropodo', 'Malang', 'Sepanjang', 'Bekasi', 'Depok', 'Ciledug', 'Pamulang', 'Total']);
      assert.ok(barisLo.every((r) => angkaLo(r[1]) + angkaLo(r[2]) === angkaLo(r[3])), barisLo.map((r) => r.join('|')).join('; '));
      const totalLo = barisLo[barisLo.length - 1];
      assert.strictEqual(angkaLo(totalLo[3]), barisLo.slice(0, -1).reduce((a, r) => a + angkaLo(r[3]), 0));
      assert.strictEqual(totalLo[4], '100%');
      const omzetDb = Number((await db('select coalesce(sum(subtotal), 0) as n from penjualan'))[0].n);
      assert.strictEqual(angkaLo(totalLo[3]), omzetDb);
      await shot('03f2-laporan-penjualan-omzet-toko');
      const [xlsLo] = await Promise.all([page.waitForEvent('download'), page.click('#loUnduh')]);
      assert.match(xlsLo.suggestedFilename(), /^Penjualan_2000-01-01_\d{4}-\d\d-\d\d\.xlsx$/);
      const bukuLo = XLSX.readFile(await xlsLo.path(), { cellNF: true });
      const wsLo = bukuLo.Sheets.Penjualan;
      const aoaLo = XLSX.utils.sheet_to_json(wsLo, { header: 1, defval: '' });
      assert.strictEqual(aoaLo[0][0], 'Laporan Penjualan');
      assert.deepStrictEqual(aoaLo[3], ['TOKO', 'Houseware', 'Special', 'Total', '%']);
      const akhirLo = aoaLo[aoaLo.length - 1];
      assert.deepStrictEqual([akhirLo[0], akhirLo[3], akhirLo[4]], ['Total', omzetDb, 1]);
      assert.ok(aoaLo.slice(4, -1).every((r) => r[1] + r[2] === r[3]));
      assert.strictEqual(wsLo.D5.z, '#,##0');
      assert.strictEqual(wsLo.E5.z, '0%');
    } finally {
      await db("update produk set kategori = case kategori when 'HOUSEWARE' then 'Plastik' when 'SPECIAL' then 'Rotan' else kategori end");
    }
    ok('laporan: Penjualan per toko (Houseware, Special, Total, %), urutan toko, total = omzet bersih, unduh Excel (format angka & persen)');

    // Laporan → Penjualan per Toko per Item (periode & kategori)
    await page.fill('#lpDari', '2000-01-01');
    await page.waitForFunction(() => document.querySelectorAll('#lpKategori option').length > 1);
    await page.click('#lpLihat');
    await page.waitForSelector('#lpRingkas');
    const kepalaPti = await page.$$eval('#lpIsi thead th', (x) => x.map((th) => th.textContent.trim()));
    assert.deepStrictEqual(kepalaPti.slice(0, 7), ['SKU', 'Nama Barang', 'Total Terjual', 'Krampung', 'Manukan', 'Sidoarjo', 'Tropodo']);
    const barisPti = await page.$$eval('#lpIsi tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    const iTrp = kepalaPti.indexOf('Tropodo');
    const harapPti = async (sku, kode) => Number((await db(`select coalesce(sum(qty), 0) as n from penjualan where kode_toko = '${kode}' and sku = '${sku}'`))[0].n)
      + Number((await db(`select coalesce(sum(b.qty), 0) as n from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
                          where m.kode_toko = '${kode}' and b.sku = '${sku}' and m.ke = 'shopee_sold' and m.dibatalkan_at is null`))[0].n);
    const isiPti = barisPti.slice(0, -1);
    assert.ok(isiPti.length > 0);
    for (const r of isiPti.slice(0, 3)) assert.strictEqual(r[iTrp], String(await harapPti(r[0], 'TRP')), r.join('|'));
    assert.strictEqual(barisPti[barisPti.length - 1][1], 'Total');
    await shot('03g-laporan-penjualan-toko-item');
    const katPti = await page.$$eval('#lpKategori option', (x) => x.map((o) => o.value).filter(Boolean));
    await page.selectOption('#lpKategori', katPti[0]);
    const [xlsPti] = await Promise.all([page.waitForEvent('download'), page.click('#lpUnduh')]);
    assert.match(xlsPti.suggestedFilename(), /^Penjualan_per_Toko_per_Item_.+_2000-01-01_\d{4}-\d\d-\d\d\.xlsx$/);
    const bukuPti = XLSX.readFile(await xlsPti.path());
    const aoaPti = XLSX.utils.sheet_to_json(bukuPti.Sheets[bukuPti.SheetNames[0]], { header: 1, defval: '' });
    assert.strictEqual(aoaPti[0][0], 'Laporan Penjualan per Toko per Item');
    assert.deepStrictEqual(aoaPti[2], ['Kategori', katPti[0], ...Array(aoaPti[2].length - 2).fill('')]);
    assert.deepStrictEqual(aoaPti[4].slice(0, 4), ['SKU', 'Nama Barang', 'Total Terjual', 'Toko']);
    assert.deepStrictEqual(aoaPti[5].slice(3, 7), ['Krampung', 'Manukan', 'Sidoarjo', 'Tropodo']);
    const dataPti = aoaPti.slice(6, -1);
    assert.ok(dataPti.length > 0);
    assert.ok(dataPti.every((r) => r[2] === r.slice(3).reduce((a, v) => a + Number(v || 0), 0)), 'Total Terjual = jumlah semua toko');
    const katDb = await db(`select p.sku from produk p where upper(p.kategori) = upper('${katPti[0]}')`);
    assert.ok(dataPti.every((r) => katDb.some((x) => x.sku === r[0])), 'hanya kategori terpilih');
    assert.strictEqual(aoaPti[aoaPti.length - 1][2], dataPti.reduce((a, r) => a + r[2], 0));
    ok('laporan: Penjualan per Toko per Item (kolom toko berurutan, jumlah per toko = kasir − batal + Shopee), filter kategori, unduh Excel');

    // Stok menipis: angka merah bila stok bisa dijual di toko < 10 (HOUSEWARE) / < 5 (SPECIAL)
    await db("update produk set kategori = case kategori when 'Plastik' then 'HOUSEWARE' when 'Rotan' then 'SPECIAL' else kategori end");
    const stokAsli = await db("select kode_toko, sku, display, gudang, shopee from stok_toko where kode_toko = 'MLG' and sku in ('PLJ-002', 'RTN-002')");
    await db("update stok_toko set display = case sku when 'PLJ-002' then 6 else 3 end, gudang = 2, shopee = 1 where kode_toko = 'MLG' and sku in ('PLJ-002', 'RTN-002')");
    try {
      await page.selectOption('#lpKategori', '');
      await page.click('#lpLihat');
      await page.waitForFunction(() => /semua kategori/i.test(document.querySelector('#lpRingkas')?.textContent || ''));
      const sel = await page.$$eval('#lpIsi tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => ({ t: td.textContent.trim(), merah: !!td.querySelector('.stok-menipis') }))));
      const kepala = await page.$$eval('#lpIsi thead th', (x) => x.map((th) => th.textContent.trim()));
      const stokDb = Object.fromEntries((await db("select kode_toko || '|' || sku as k, display + gudang + shopee as n from stok_toko")).map((x) => [x.k, Number(x.n)]));
      const adaStok = new Set((await db('select distinct kode_toko from stok_toko')).map((x) => x.kode_toko));
      const kodeToko = Object.fromEntries((await db('select kode, nama from toko')).map((x) => [x.nama, x.kode]));
      const katSku = Object.fromEntries((await db('select sku, kategori from produk')).map((x) => [x.sku, x.kategori]));
      let merah = 0;
      for (const baris of sel.slice(0, -1)) {
        for (let c = 3; c < kepala.length; c++) {
          const kode = kodeToko[kepala[c]];
          const batas = { HOUSEWARE: 10, SPECIAL: 5 }[katSku[baris[0].t]];
          const harap = adaStok.has(kode) && (stokDb[`${kode}|${baris[0].t}`] || 0) < batas;
          assert.strictEqual(baris[c].merah, harap, `${baris[0].t} ${kode} stok ${stokDb[`${kode}|${baris[0].t}`]}`);
          if (harap) merah++;
        }
      }
      assert.ok(merah >= 1, 'ada angka merah');
      assert.ok(sel.find((b) => b[0].t === 'PLJ-002')[kepala.indexOf('Malang')].merah, 'PLJ-002 Malang stok 9 < 10');
      assert.ok(!sel.find((b) => b[0].t === 'RTN-002')[kepala.indexOf('Malang')].merah, 'RTN-002 Malang stok 6 ≥ 5');
      assert.ok(sel[sel.length - 1].every((x) => !x.merah), 'baris Total tidak merah');
      await shot('03h-laporan-penjualan-stok-menipis');
      const [xlsMerah] = await Promise.all([page.waitForEvent('download'), page.click('#lpUnduh')]);
      const fileMerah = await xlsMerah.path();
      const bukuMerah = XLSX.readFile(fileMerah);
      assert.deepStrictEqual(bukuMerah.SheetNames, ['Penjualan per Toko', 'Keterangan']);
      const { execFileSync } = require('child_process');
      const gaya = execFileSync('unzip', ['-p', fileMerah, 'xl/styles.xml']).toString();
      const lembar = execFileSync('unzip', ['-p', fileMerah, 'xl/worksheets/sheet1.xml']).toString();
      // Indeks font merah → indeks gaya sel (cellXfs) → jumlah sel dengan gaya itu = jumlah angka merah di layar
      const fonts = [...gaya.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)[1].matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)].map((m) => m[0]);
      const fontMerah = fonts.findIndex((f) => /FF0000/i.test(f));
      assert.ok(fontMerah >= 0, 'font merah ada di styles.xml');
      const xfs = [...gaya.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf [^>]*>/g)].map((m) => m[0]);
      const xfMerah = new Set(xfs.map((x, i) => (new RegExp(`fontId="${fontMerah}"`).test(x) ? i : -1)).filter((i) => i >= 0));
      const selMerah = [...lembar.matchAll(/<c r="[A-Z]+\d+"[^>]* s="(\d+)"/g)].filter((m) => xfMerah.has(Number(m[1]))).length;
      assert.strictEqual(selMerah, merah, 'jumlah sel merah di Excel = di layar');
    } finally {
      await db("update produk set kategori = case kategori when 'HOUSEWARE' then 'Plastik' when 'SPECIAL' then 'Rotan' else kategori end");
      for (const x of stokAsli) await db('update stok_toko set display = $3, gudang = $4, shopee = $5 where kode_toko = $1 and sku = $2', [x.kode_toko, x.sku, x.display, x.gudang, x.shopee]);
    }
    ok('laporan: Penjualan per Toko per Item — angka merah bila stok bisa dijual di toko < 10 (HOUSEWARE) / < 5 (SPECIAL), di layar & Excel');

    // Retur barang: retur toko (BS → Supplier) vs Retur Penjualan Accurate
    await buka('retur');
    await page.waitForSelector('#rtDaftar tbody tr');
    assert.match(await page.textContent('#rtDaftar'), /TRP[\s\S]*Retur BS ke kantor[\s\S]*Belum di Accurate/);
    await page.click('#rtTab [data-t="cocok"]');
    await page.waitForSelector('#rtFile');
    const fileReturWeb = (() => {
      const r = (isi) => { const x = new Array(19).fill(''); for (const [k, v] of Object.entries(isi)) x[k] = v; return x; };
      const aoa = [r({ 1: 'PT CONTOH KANTOR' }), r({ 1: 'Rincian Retur Penjualan' }), r({ 1: 'Dari 01 Nov 2026 s/d 30 Nov 2026' }), r({ 1: 'Cabang : [Semua Cabang]' }),
        r({ 1: 'Nomor #', 3: 'Kode #', 5: 'Nama Barang', 7: 'Kuantitas', 9: '@Harga', 11: 'Total Harga', 13: 'Pelanggan', 15: 'Keterangan Retur Penjualan' }),
        r({ 1: 'SRT.WEB.0001', 3: 'RTN-004', 5: 'Pail Ukir 40', 7: 3, 9: 1000, 11: 3000, 13: 'Tropodo', 15: 'BS rotan' }),
        r({ 1: 'SRT.WEB.0001', 3: 'PLJ-005', 5: 'Rak Sepatu', 7: 1, 9: 1000, 11: 1000, 13: 'Tropodo', 15: 'BS rotan' }),
        r({ 1: 'SRT.WEB.0002', 3: 'RTN-001', 5: 'Kursi Rotan', 7: 2, 9: 1000, 11: 2000, 13: 'Malang', 15: 'BS' }),
        r({}), r({ 1: 'ACCURATE Accounting System Report' }), r({ 1: 'Halaman 1', 2: ' dari 1' })];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Rincian Retur Penjualan');
      const f = path.join(OUT, 'Rincian_Retur_uji.xlsx');
      XLSX.writeFile(wb, f);
      return f;
    })();
    await page.setInputFiles('#rtFile', fileReturWeb);
    await page.waitForSelector('#rtSimpan');
    assert.match(await page.textContent('#rtPratinjau'), /2 retur, 3 baris barang/);
    await shot('04c-retur-pratinjau');
    await page.click('#rtSimpan');
    await toastCocok(/2 retur baru/);
    await page.waitForFunction(() => /Rak Sepatu|PLJ-005/.test(document.querySelector('#rtCocok')?.textContent || ''));
    const cocokRows = await page.$$eval('#rtCocok tbody tr', (x) => x.map((tr) => tr.textContent));
    assert.ok(cocokRows.some((t) => /PLJ-005/.test(t) && /Belum diinput Accurate/.test(t)), cocokRows.join('|'));
    assert.ok(cocokRows.some((t) => /RTN-001/.test(t) && /Lebih di Accurate/.test(t)), cocokRows.join('|'));
    assert.ok(!cocokRows.some((t) => /RTN-004/.test(t)), 'yang cocok tidak tampil di Perlu dicek');
    await page.selectOption('#rtStatusC', 'COCOK');
    await page.waitForFunction(() => /RTN-004/.test(document.querySelector('#rtCocok')?.textContent || ''));
    await shot('04d-retur-pencocokan');
    const [xlsRetur] = await Promise.all([page.waitForEvent('download'), page.click('#rtExcel')]);
    assert.match(xlsRetur.suggestedFilename(), /^Pencocokan_Retur_Semua_/);
    await page.selectOption('#rtStatusC', 'masalah');
    await page.click('#rtTab [data-t="toko"]');
    await page.waitForFunction(() => /Sebagian di Accurate/.test(document.querySelector('#rtDaftar')?.textContent || ''));
    await page.click('#rtDaftar tr.klik');
    await page.waitForSelector('.modal');
    assert.match(await page.textContent('.modal'), /PLJ-005[\s\S]*2[\s\S]*1[\s\S]*1/);
    await page.click('.modal .tutup');
    assert.strictEqual((await db("select count(*)::int n from retur_accurate"))[0].n, 2);
    ok('retur barang: daftar retur toko, upload Rincian Retur Penjualan Accurate, pencocokan per barang (cocok, belum diinput, lebih), status dokumen, Excel');

    await buka('stok');
    assert.deepStrictEqual(await page.$$eval('#stTab [data-t]', (b) => b.map((x) => x.dataset.t)), ['cari', 'lambat', 'dok', 'kantor', 'so', 'selisih', 'barang']);
    assert.ok(!(await page.$$eval('.nav a[data-h]', (a) => a.map((x) => x.dataset.h))).includes('barang'), 'Master Barang digabung ke Stok & Barang');
    await page.click('#stTab [data-t="cari"]');
    await page.fill('#stCari', 'keset');
    await tunggu(700);
    assert.ok((await page.$$('#stHasil tbody tr')).length >= 3);
    // Filter: kondisi stok, kategori, merk, toko; jumlah barang; reset
    await page.fill('#stCari', '');
    await page.selectOption('#stToko', 'TRP');
    await tunggu(700);
    const semuaTrp = await page.$$eval('#stHasil tbody tr', (x) => x.length);
    assert.match(await page.textContent('#stJumlah'), new RegExp(`^${semuaTrp} barang`));
    const kategori = await page.$$eval('#stKategori option', (o) => o.map((x) => x.value).filter(Boolean));
    assert.ok(kategori.includes('Rotan') && kategori.includes('Plastik'), kategori.join(','));
    await page.selectOption('#stKategori', 'Rotan');
    await tunggu(700);
    const rotan = await page.$$eval('#stHasil tbody tr', (x) => x.map((tr) => tr.textContent));
    assert.ok(rotan.length > 0 && rotan.length < semuaTrp && rotan.every((r) => /RTN-/.test(r) && /TRP/.test(r)), rotan.join('|'));
    await page.selectOption('#stKondisi', 'habis');
    await tunggu(700);
    const habis = await db(`select count(*)::int n from stok_toko s join produk_toko p using (kode_toko, sku)
      where s.kode_toko = 'TRP' and p.kategori = 'Rotan' and s.display + s.gudang + s.shopee <= 0`);
    assert.strictEqual(await page.locator('#stHasil tbody tr').count(), habis[0].n);
    await shot('03c-filter-stok');
    await page.click('#stReset');
    await tunggu(700);
    assert.deepStrictEqual(await page.$$eval('#stKondisi, #stKategori, #stMerk', (x) => x.map((e) => e.value)), ['', '', '']);
    await page.click('#stTab [data-t="lambat"]');
    await tunggu(500);
    ok('stok: cari stok dengan filter kondisi / kategori / merk / toko, stok lambat (menu terpisah dari Stock Opname)');

    // Mutasi & penerimaan: dokumen yang dibatalkan di toko (PIN) bertanda Dibatalkan dan tidak dihitung di total
    await page.click('#stTab [data-t="dok"]');
    await page.waitForSelector('#dkHasil tbody tr');
    await page.selectOption('#perPilih', '30');
    await tunggu(700);
    const dokBatal = await page.$$eval('#dkHasil tbody tr', (x) => x.map((tr) => tr.textContent).filter((t) => /Dibatalkan/.test(t)));
    assert.strictEqual(dokBatal.length, 2, dokBatal.join('\n'));
    assert.ok(dokBatal.some((t) => /SDA/.test(t) && /DO\.2026\.11\.00103/.test(t) && /Salah input jumlah/.test(t) && /disetujui Pak Budi/.test(t)), dokBatal.join('\n'));
    assert.ok(dokBatal.some((t) => /TRP/.test(t) && /MT-/.test(t) && /Display Toko → Gudang Utama/.test(t) && /Salah arah/.test(t) && /disetujui Bu Sari/.test(t)), dokBatal.join('\n'));
    const dokDb = await db(`select coalesce(sum(total_biji) filter (where dibatalkan_at is null), 0)::int sah, count(*) filter (where dibatalkan_at is not null)::int batal
      from penerimaan_toko where diterima_at >= now() - interval '30 days'`);
    assert.strictEqual(dokDb[0].batal, 1);
    assert.match(await page.textContent('#dkJumlah'), new RegExp(`penerimaan ${dokDb[0].sah.toLocaleString('id-ID')} Biji · 2 dibatalkan tidak dihitung`));
    await shot('03d-mutasi-penerimaan');
    await page.selectOption('#dkStatus', 'batal');
    await tunggu(600);
    assert.strictEqual(await page.locator('#dkHasil tbody tr').count(), 2);
    await page.selectOption('#dkJenis', 'penerimaan');
    await tunggu(600);
    assert.strictEqual(await page.locator('#dkHasil tbody tr').count(), 1);
    assert.match(await page.textContent('#dkJumlah'), /penerimaan 0 Biji · 1 dibatalkan/);
    await page.selectOption('#dkJenis', '');
    await page.selectOption('#dkStatus', '');
    await tunggu(600);
    ok('stok: mutasi & penerimaan toko; yang dibatalkan dengan PIN bertanda Dibatalkan (alasan, penyetuju) dan tidak dihitung di total');

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

    // Master Barang = tab di menu Stok & Barang; alamat lama #barang membuka tab itu
    await page.evaluate(() => { location.hash = 'barang'; });
    await page.waitForSelector('#brIsiTabel tbody tr');
    assert.strictEqual(await page.$eval('.nav a.aktif', (a) => a.dataset.h), 'stok');
    assert.strictEqual(await page.$eval('#stTab .aktif', (b) => b.dataset.t), 'barang');
    await shot('06-stok-barang-master');
    await page.click('#brIsiTabel tr.klik:has-text("RTN-001")');
    assert.deepStrictEqual(await page.$$eval('#fSatuan option', (o) => o.map((x) => x.value)), ['Coly', 'Biji']);
    assert.strictEqual(await page.inputValue('#fSatuan'), 'Coly');
    await page.selectOption('#fSatuan', 'Biji');
    assert.deepStrictEqual([await page.inputValue('#fRasio'), await page.$eval('#fRasio', (e) => e.disabled)], ['1', true]);
    await page.click('.modal-kaki .btn.primary');
    await tungguDb("select satuan_masuk, rasio_isi from produk where sku = 'RTN-001'", ['Biji', 1]);
    await tunggu(400);
    await page.click('#brIsiTabel tr.klik:has-text("RTN-001")');
    await page.selectOption('#fSatuan', 'Coly');
    assert.strictEqual(await page.$eval('#fRasio', (e) => e.disabled), false);
    await page.fill('#fRasio', '2');
    await page.click('.modal-kaki .btn.primary');
    await tungguDb("select satuan_masuk, rasio_isi from produk where sku = 'RTN-001'", ['Coly', 2]);
    await tunggu(400);
    await page.click('#brIsiTabel tr.klik:has-text("RTN-002")');
    await page.fill('#fHarga', '27500');
    await page.click('.modal-kaki .btn.primary');
    await tungguDb("select harga_jual_konsumen::int as h from produk where sku = 'RTN-002'", [27500]);
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

    // Tambah pengguna dengan kata sandi sementara → login pertama wajib membuat kata sandi sendiri
    const loginSebagai = async (email, sandi) => {
      await page.fill('#lgEmail', email);
      await page.fill('#lgPass', sandi);
      await page.click('#lgBtn');
    };
    // Tunggu daftar "perlu perhatian" di Ringkasan selesai dimuat, supaya tidak ada permintaan yang terkirim setelah keluar
    const keluar = async () => {
      await page.waitForFunction(() => !/Memuat/.test(document.querySelector('#rkPerhatian')?.textContent || ''));
      await page.click('#btnKeluar');
      await page.waitForSelector('#lgEmail');
    };
    await page.click('#pgTambah');
    assert.match(await page.inputValue('#uSandi'), /^[a-z2-9]{10}$/);
    await page.fill('#uEmail', 'Gudang.Baru@contoh.local');
    await page.fill('#uNama', 'Gudang Baru');
    await page.selectOption('#uPeran', 'gudang');
    await page.fill('#uSandi', 'sementara123');
    await page.click('.modal-kaki .btn.primary');
    await page.waitForSelector('#infoLogin');
    const info = await page.textContent('#infoLogin');
    assert.match(info, /Email: gudang\.baru@contoh\.local/);
    assert.match(info, /Kata sandi sementara: sementara123/);
    await shot('09c-pengguna-baru');
    await page.click('.modal-kaki .btn.primary');
    await page.waitForFunction(() => /gudang\.baru@contoh\.local[\s\S]*Belum ganti sandi/.test(document.querySelector('#pgDaftar').textContent));
    await page.click('#pgTambah');
    await page.fill('#uEmail', 'gudang.baru@contoh.local');
    await page.fill('#uNama', 'Dobel');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/sudah terdaftar/);
    await page.click('.modal .tutup');
    assert.strictEqual((await db("select count(*)::int n from auth.users where email = 'gudang.baru@contoh.local'"))[0].n, 1);

    await keluar();
    await loginSebagai('gudang.baru@contoh.local', 'sementara123');
    await page.waitForSelector('#sbForm');
    await shot('09d-buat-kata-sandi');
    await page.fill('#sbBaru1', 'rahasia-baru-1');
    await page.fill('#sbBaru2', 'beda-sekali');
    await page.click('#sbBtn');
    await page.waitForFunction(() => /tidak sama/.test(document.querySelector('#sbErr').textContent));
    await page.fill('#sbBaru2', 'rahasia-baru-1');
    await page.click('#sbBtn');
    await page.waitForSelector('#isi .page-head');
    assert.ok((await page.$$eval('.nav a', (x) => x.map((a) => a.dataset.h))).includes('stok'));
    await keluar();
    await loginSebagai('gudang.baru@contoh.local', 'sementara123');
    await page.waitForFunction(() => /salah/.test(document.querySelector('#lgErr').textContent));
    await masuk('gudang.baru@contoh.local', 'rahasia-baru-1');
    await page.click('#btnSandi');
    await page.fill('#gsBaru1', 'rahasia-baru-2');
    await page.fill('#gsBaru2', 'rahasia-baru-2');
    await page.click('.modal-kaki .btn.primary');
    await toastCocok(/Kata sandi diganti/);
    await keluar();
    await masuk('gudang.baru@contoh.local', 'rahasia-baru-2');
    await keluar();

    // Owner mereset kata sandi yang lupa → wajib membuat kata sandi lagi
    await masuk('owner@contoh.local', 'owner123');
    await buka('pengguna');
    await page.click('#pgDaftar tr.klik:has-text("gudang.baru@contoh.local")');
    await page.click('.modal-kaki button:has-text("Reset kata sandi")');
    await page.fill('#rsSandi', 'reset12345');
    await page.click('.modal-kaki .btn.danger');
    await page.waitForSelector('#infoLogin');
    assert.match(await page.textContent('#infoLogin'), /Kata sandi sementara: reset12345/);
    await page.click('.modal-kaki .btn.primary');
    await keluar();
    await loginSebagai('gudang.baru@contoh.local', 'reset12345');
    await page.waitForSelector('#sbForm');
    await page.click('#sbKeluar');
    await page.waitForSelector('#lgEmail');
    await masuk('owner@contoh.local', 'owner123');
    ok('pengguna: owner menambah pengguna dengan kata sandi sementara (sekali tampil), email dobel ditolak, login pertama wajib membuat kata sandi, ganti kata sandi, reset oleh owner');

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
    assert.deepStrictEqual(menu, ['ringkasan', 'penjualan', 'pesanan', 'stok', 'laporan', 'asisten']);
    await page.click('.nav a[data-h="stok"]');
    await page.waitForSelector('#stTab');
    assert.deepStrictEqual(await page.$$eval('#stTab [data-t]', (b) => b.map((x) => x.dataset.t)), ['cari', 'lambat', 'dok'], 'pemilik toko tanpa stock opname & Master Barang');
    await page.click('.nav a[data-h="ringkasan"]');
    await page.waitForSelector('#rkToko tbody tr');
    assert.deepStrictEqual(await page.$$eval('#rkToko tbody tr td:first-child b', (x) => x.map((e) => e.textContent)), ['TRP']);
    await page.goto(`${BASE}/#pembelian`);
    await page.waitForSelector('#isi .page-head');
    assert.match(await page.textContent('#isi h1'), /Ringkasan/);
    await shot('11-pemilik-toko');
    ok('pemilik toko: menu terbatas, hanya data TRP, halaman kantor tidak bisa dibuka');

    // Login dengan kata sandi salah memang dibalas 400 (disengaja di awal uji)
    const nyata = kesalahan.filter((k) => !/favicon/.test(k) && !/invalid_credentials/.test(k) && !/status of 400/.test(k) && !/sudah diopname kantor/.test(k) && !/sudah terdaftar|status of 409/.test(k));
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
    if (demo.tutup) await demo.tutup();
  }
})();
