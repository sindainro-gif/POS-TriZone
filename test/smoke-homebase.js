'use strict';
// Uji asap aplikasi HOMEBASE: electron test/smoke-homebase.js [folder-output]
// Paket dari 2 toko (dibuat dengan logika POS asli) ditaruh di folder masuk sementara; UI harus menampilkan
// ringkasan, penjualan, stok, dokumen, riwayat impor, ekspor Excel, dan kunci PIN dengan benar.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const out = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('smoke-homebase.js')) || path.join(os.tmpdir(), 'pos-smoke-homebase'));
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-homebase-data-'));
const inbox = path.join(dataDir, 'GoogleDrive', 'POS-Homebase');
const excelDir = path.join(out, 'excel');
fs.rmSync(excelDir, { recursive: true, force: true });
process.env.POS_DATA_DIR = path.join(dataDir, 'app');
process.env.POS_HOMEBASE = '1';
process.env.POS_SAVE_DIR = excelDir;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Paket dibuat dengan logika POS yang sama seperti di toko
async function makePackages() {
  const { Database } = require('../src/db');
  const { createServices, localNow } = require('../src/services');
  const { seedDemo } = require('../src/demo');
  const hp = require('../src/homebase-package');
  const put = (sub, pkg) => {
    const d = path.join(inbox, sub);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, hp.packageFileName(pkg)), hp.encodePackage(pkg));
  };
  const pack = (svc, kind, data, at = localNow()) => hp.makePackage({ kind, store: svc.storeInfo(), source: { app_version: '1.4.0', device_mode: 'server' }, created_at: at, data });

  const A = createServices(await Database.open(null));
  seedDemo(A);
  A.saveSettings({ store_name: 'Toko Pusat', store_address: 'Jl. Contoh 1' });
  A.openShift({ cashier_name: 'Rina' });
  const pa = A.listProducts({});
  A.checkout({ items: [{ sku: pa[0].sku, qty: 2 }], payment_method: 'Tunai', cash_received: 100000 });
  A.checkout({ items: [{ sku: pa[1].sku, qty: 1 }, { sku: pa[2].sku, qty: 3 }], payment_method: 'QRIS' });
  A.checkout({ items: [{ sku: pa[3].sku, qty: 1 }], payment_method: 'Kartu Debit' });
  A.createTransfer({ sku: pa[4].sku, from_zone: 'warehouse', to_zone: 'shopee', qty: 2, reason: 'isi stok online' });
  const shiftA = A.homebaseShiftData({ closed_at: localNow(), notes: 'Tutup shift uji' });
  put('Toko Pusat', pack(A, 'shift', shiftA));
  A.purgeShift();
  put('Toko Pusat', pack(A, 'snapshot', A.homebaseSnapshotData({ includeOpenShift: false })));

  const B = createServices(await Database.open(null));
  B.saveSettings({ store_name: 'Toko Cabang Timur' });
  B.importRows([
    { Barcode: '2000000000017', SKU: 'TMR-1', Nama_Barang: 'Gula Pasir 1kg', Harga_Jual: 16000, Stok_Awal_Toko: 4, Stok_Awal_Gudang: 40, Min_Alert_Toko: 6 },
    { Barcode: '2000000000024', SKU: 'TMR-2', Nama_Barang: 'Minyak Goreng 1L', Harga_Jual: 18000, Stok_Awal_Toko: 12, Stok_Awal_Gudang: 24, Stok_Awal_Shopee: 5 },
  ]);
  B.createReception({ reference_no: 'SJ-TMR-01', supplier_name: 'CV Timur', items: [{ sku: 'TMR-1', qty: 1, pack_type: 'Dus', destination: 'warehouse' }] });
  B.openShift({ cashier_name: 'Sari' });
  B.checkout({ items: [{ sku: 'TMR-2', qty: 2 }], payment_method: 'Tunai', cash_received: 50000 });
  put('', pack(B, 'snapshot', B.homebaseSnapshotData())); // shift masih berjalan

  const total = shiftA.sales.reduce((s, l) => s + l.line_total, 0) + 36000;
  return { total, productsA: pa.length, storeA: A.storeInfo().id };
}

const prepared = makePackages();
const { getHomebase } = require('../src/main.js');

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  const errors = [];
  win.webContents.on('console-message', (_ev, level, msg) => { if (level >= 3) errors.push(msg); });
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(js);
    const call = (ch, args) => run(`window.posBridge.call(${JSON.stringify(ch)}, ${JSON.stringify(args || {})})`);
    const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); console.log('screenshot', name); };
    const text = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).innerText`);
    const rupiah = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;
    try {
      win.setSize(1366, 820);
      const expected = await prepared;
      await wait(1500);
      if (!/homebase/i.test(win.getTitle())) throw new Error(`judul jendela bukan Homebase: ${win.getTitle()}`);
      const empty = await text('#dashBody');
      if (!/Belum ada data toko/.test(empty)) throw new Error('ringkasan awal seharusnya kosong');
      await shot('hb-01-kosong');

      // Folder masuk diatur → paket 2 toko (termasuk subfolder) diimpor
      const set = await call('hb:setInbox', { dir: inbox });
      if (!set.ok) throw new Error(set.error);
      console.log('pindai pertama:', JSON.stringify({ files: set.data.scan.files, imported: set.data.scan.imported, errors: set.data.scan.errors }));
      if (set.data.scan.imported !== 3 || set.data.scan.errors) throw new Error('paket tidak terimpor semua');
      const again = await call('hb:scan');
      if (again.data.imported !== 0) throw new Error('pindai ulang tidak boleh mengimpor lagi');

      await run(`document.querySelector('#dashRefresh').click()`);
      await wait(800);
      const dash = await text('#dashBody');
      console.log('ringkasan:', dash.replace(/\s+/g, ' ').slice(0, 220));
      if (!/Toko Pusat/.test(dash) || !/Toko Cabang Timur/.test(dash) || !/Berjalan/.test(dash)) throw new Error('ringkasan tidak menampilkan 2 toko / shift berjalan');
      const stats = await text('#dashStats');
      if (!stats.includes(rupiah(expected.total))) throw new Error(`omset hari ini tidak sama (${rupiah(expected.total)}): ${stats}`);
      await shot('hb-02-ringkasan');

      // Penjualan per hari / per barang / per struk + detail
      await run(`document.querySelector('[data-view=sales]').click()`);
      await wait(700);
      const totals = await text('#slTotals');
      console.log('penjualan:', totals);
      if (!totals.includes(rupiah(expected.total)) || !/ 4 struk/.test(totals)) throw new Error('total penjualan tidak sama'); // 3 struk Toko Pusat + 1 Toko Cabang Timur
      await shot('hb-03-penjualan-harian');
      await run(`{ const g = document.querySelector('#slGroup'); g.value = 'receipt'; g.dispatchEvent(new Event('change')); }`);
      await wait(700);
      await run(`document.querySelector('#slBody [data-receipt]').click()`);
      await wait(600);
      const receipt = await text('#modalRoot');
      if (!/Struk INV-/.test(receipt)) throw new Error('detail struk tidak tampil');
      await shot('hb-04-detail-struk');
      await run(`document.querySelector('#modalRoot .modal-foot .btn').click()`);
      await run(`{ const g = document.querySelector('#slGroup'); g.value = 'shift'; g.dispatchEvent(new Event('change')); }`);
      await wait(700);
      const shifts = await text('#slBody');
      if (!/Rina/.test(shifts) || !/Sari/.test(shifts) || !/Tutup/.test(shifts)) throw new Error('daftar shift tidak lengkap');
      await run(`document.querySelector('#slExport').click()`);
      await wait(1500);

      // Stok per toko
      await run(`{ const s = document.querySelector('#hbStore'); s.value = ${JSON.stringify(expected.storeA)}; s.dispatchEvent(new Event('change')); }`);
      await run(`document.querySelector('[data-view=stock]').click()`);
      await wait(800);
      const stockRows = await run(`document.querySelectorAll('#skBody tr').length`);
      console.log('baris stok Toko Pusat:', stockRows);
      if (stockRows !== expected.productsA) throw new Error('jumlah baris stok tidak sama dengan jumlah barang toko');
      await shot('hb-05-stok');

      // Dokumen: mutasi Toko Pusat ke Gudang Shopee + detail
      await run(`document.querySelector('[data-view=docs]').click()`);
      await wait(500);
      await run(`document.querySelector('#dcTabs [data-type=transfers]').click()`);
      await wait(700);
      const docs = await text('#dcBody');
      if (!/Gudang Shopee/.test(docs)) throw new Error('mutasi ke Gudang Shopee tidak tampil');
      await run(`document.querySelector('#dcBody [data-key]').click()`);
      await wait(600);
      await shot('hb-06-dokumen-detail');
      await run(`document.querySelector('#modalRoot .modal-foot .btn').click()`);

      // Semua toko lagi, halaman impor
      await run(`{ const s = document.querySelector('#hbStore'); s.value = ''; s.dispatchEvent(new Event('change')); }`);
      await run(`document.querySelector('[data-view=imports]').click()`);
      await wait(900);
      const imports = await run(`document.querySelectorAll('#imBody tr').length`);
      const storeRows = await run(`document.querySelectorAll('#stBody tr').length`);
      if (imports < 3 || storeRows !== 2) throw new Error(`riwayat impor (${imports}) / toko (${storeRows}) tidak sesuai`);
      await shot('hb-07-impor');

      // Ekspor semua ke Excel (tanpa dialog di tes) lalu baca ulang
      await run(`document.querySelector('#exFrom').value = '2000-01-01'; document.querySelector('#exAll').click();`);
      await wait(2500);
      const files = fs.existsSync(excelDir) ? fs.readdirSync(excelDir) : [];
      console.log('file Excel:', files.join(', '));
      const allFile = files.find((f) => /^Homebase_Semua_/.test(f));
      if (!allFile || !files.some((f) => /^Homebase_Penjualan_/.test(f))) throw new Error('file Excel tidak dibuat');
      const wb = XLSX.readFile(path.join(excelDir, allFile));
      const detail = XLSX.utils.sheet_to_json(wb.Sheets['Detail Penjualan']);
      const sum = detail.reduce((s, r) => s + r.Subtotal, 0);
      console.log('lembar Excel:', wb.SheetNames.join(', '), '· total Detail Penjualan', sum);
      if (sum !== expected.total) throw new Error('total di Excel tidak sama');

      // Tema terang
      await run(`document.querySelector('[data-view=dash]').click(); document.querySelector('#themeSeg [data-theme=light]').click();`);
      await wait(700);
      await shot('hb-08-ringkasan-terang');
      await run(`document.querySelector('#themeSeg [data-theme=dark]').click()`);

      // Kunci PIN
      if (!(await call('hb:setPin', { pin: '246810' })).ok) throw new Error('PIN gagal disimpan');
      await run(`document.querySelector('#hbLockBtn').click()`);
      await wait(600);
      if (await run(`document.querySelector('#lockScreen').classList.contains('hidden')`)) throw new Error('layar kunci tidak tampil');
      const blocked = await call('hb:sales', {});
      if (blocked.ok || !/terkunci/.test(blocked.error)) throw new Error('data harus terkunci tanpa PIN');
      await run(`document.querySelector('#lkPin').value = '111111'; document.querySelector('#lkBtn').click();`);
      await wait(1200);
      if (!/PIN salah/.test(await text('#lkErr'))) throw new Error('PIN salah seharusnya ditolak');
      await shot('hb-09-kunci-pin');
      await run(`document.querySelector('#lkPin').value = '246810'; document.querySelector('#lkBtn').click();`);
      await wait(900);
      if (!(await run(`document.querySelector('#lockScreen').classList.contains('hidden')`))) throw new Error('PIN benar tidak membuka homebase');
      await call('hb:setPin', { pin: '' });
      if (getHomebase().hb.hasPin()) throw new Error('PIN tidak terhapus');
    } catch (e) {
      console.error('SMOKE HOMEBASE GAGAL:', e);
      process.exitCode = 1;
    }
    if (errors.length) { console.error('Error konsol renderer:', errors); process.exitCode = 1; }
    console.log('output:', out);
    app.quit();
  });
});
