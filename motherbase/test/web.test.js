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

    // Laporan riwayat pembatalan: per toko & per nota
    await buka('pembatalan');
    await page.selectOption('#btRentang', 'semua');
    await page.waitForFunction(() => document.querySelectorAll('#btPerNota tbody tr').length === 3);
    const perToko = await page.$$eval('#btPerToko tbody tr', (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.deepStrictEqual(perToko.map((r) => [r[0].slice(0, 3), r[1]]).sort(), [['MLG', '1'], ['TRP', '2']]);
    assert.ok(perToko.every((r) => /%/.test(r[4]) && r[5] !== '-'), JSON.stringify(perToko));
    assert.match(await page.textContent('#btRingkas'), /3 nota dibatalkan/);
    await shot('02d-laporan-pembatalan');
    const [csvToko] = await Promise.all([page.waitForEvent('download'), page.click('#btCsvToko')]);
    assert.match(csvToko.suggestedFilename(), /^pembatalan_per_toko_/);
    await page.click('#btPerToko tr.klik:has-text("TRP")');
    await page.waitForFunction(() => document.querySelectorAll('#btPerNota tbody tr').length === 2);
    assert.match(await page.textContent('#btJudulNota'), /TRP \(2\)/);
    const [csvNota] = await Promise.all([page.waitForEvent('download'), page.click('#btCsvNota')]);
    const fNota = path.join(OUT, csvNota.suggestedFilename());
    await csvNota.saveAs(fNota);
    const isiCsv = fs.readFileSync(fNota, 'utf8');
    assert.match(isiCsv, /Nota asal;.*Diminta oleh;Disetujui oleh/);
    assert.strictEqual(isiCsv.trim().split(/\r?\n/).length, 3);
    await page.click('#btPerNota tr.klik');
    await page.waitForSelector('.modal');
    assert.match(await page.textContent('.modal'), /Disetujui oleh \(PIN\)/);
    await page.click('.modal .tutup');
    ok('pembatalan nota: riwayat per toko (jumlah, nilai, % batal) & per nota, filter toko, CSV, rincian');

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
    assert.ok(menuKantor.includes('stok') && menuKantor.includes('opname'), 'menu Stok dan Stock Opname terpisah');
    assert.strictEqual(menuKantor.indexOf('opname'), menuKantor.indexOf('stok') + 1);
    await buka('opname');
    assert.deepStrictEqual(await page.$$eval('#stTab [data-t]', (b) => b.map((x) => x.dataset.t)), ['kantor', 'so', 'selisih']);
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

    await buka('stok');
    assert.deepStrictEqual(await page.$$eval('#stTab [data-t]', (b) => b.map((x) => x.dataset.t)), ['cari', 'lambat', 'dok']);
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

    await buka('barang');
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
    assert.deepStrictEqual(menu, ['ringkasan', 'penjualan', 'pembatalan', 'pesanan', 'stok', 'asisten']);
    await page.waitForSelector('#rkToko tbody tr');
    assert.deepStrictEqual(await page.$$eval('#rkToko tbody tr td:first-child b', (x) => x.map((e) => e.textContent)), ['TRP']);
    await page.goto(`${BASE}/#pembelian`);
    await page.waitForSelector('#isi .page-head');
    assert.match(await page.textContent('#isi h1'), /Ringkasan/);
    await shot('11-pemilik-toko');
    ok('pemilik toko: menu terbatas, hanya data TRP, halaman kantor tidak bisa dibuka');

    // Login dengan kata sandi salah memang dibalas 400 (disengaja di awal uji)
    const nyata = kesalahan.filter((k) => !/favicon/.test(k) && !/invalid_credentials/.test(k) && !/status of 400/.test(k) && !/sudah diopname kantor/.test(k));
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
