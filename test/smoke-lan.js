'use strict';
// Uji dua komputer di satu PC: electron test/smoke-lan.js <folder-output>
// Menyiapkan PC Gudang (server) sebagai proses Electron terpisah, lalu proses ini menjadi PC Kasir (klien).
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('smoke-lan.js')) || path.join(os.tmpdir(), 'pos-smoke-lan'));
fs.mkdirSync(out, { recursive: true });
const PORT = 47850 + Math.floor(Math.random() * 100);
const KEY = '246810';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-lan-'));
const gudangDir = path.join(root, 'gudang');
const kasirDir = path.join(root, 'kasir');
fs.mkdirSync(gudangDir, { recursive: true });
fs.mkdirSync(kasirDir, { recursive: true });
fs.writeFileSync(path.join(gudangDir, 'device.json'), JSON.stringify({ mode: 'server', server_port: PORT, server_pair_key: KEY }));
fs.writeFileSync(path.join(kasirDir, 'device.json'), JSON.stringify({ mode: 'client', server_host: '127.0.0.1', server_port: PORT, pair_key: KEY }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedGudang() {
  // Database gudang disiapkan sebelum server dijalankan
  const { Database } = require('../src/db');
  const { createServices } = require('../src/services');
  const db = await Database.open(path.join(gudangDir, 'pos.db'));
  const svc = createServices(db);
  svc.importRows([{ Barcode: '4006381333931', SKU: 'BRS-001', Nama_Barang: 'Penebah Lidi @50 PCS Sima', Harga_Jual: 6000, Stok_Awal_Toko: 20, Stok_Awal_Gudang: 100 }]);
  svc.saveSettings({ store_name: 'Toko Uji LAN' });
  svc.saveUser({ name: 'Admin', role: 'admin', pin: '123456' });
  svc.saveUser({ name: 'Kasir LAN', role: 'kasir', pin: '135790' });
}

async function gudangServices() {
  const { Database } = require('../src/db');
  const { createServices } = require('../src/services');
  return createServices(await Database.open(path.join(gudangDir, 'pos.db')));
}
const readGudangStock = async () => (await gudangServices()).getProduct('BRS-001');

function startGudang() {
  return spawn(process.execPath, [path.join(__dirname, '..')], {
    env: { ...process.env, POS_DATA_DIR: gudangDir, POS_SERVER_HOST: '127.0.0.1', POS_PRINT_TO_PDF: out },
    stdio: 'ignore',
  });
}

let gudang;
process.env.POS_DATA_DIR = kasirDir;
process.env.POS_PRINT_TO_PDF = out;

(async () => {
  await seedGudang();
  gudang = startGudang();
  await wait(4000);
  require('../src/main.js');
})();

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  const errors = [];
  win.webContents.on('console-message', (_ev, level, msg) => { if (level >= 3) errors.push(msg); });
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(js);
    const shot = async (name) => { await wait(600); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); console.log('screenshot', name); };
    try {
      win.setSize(1366, 820);
      await wait(1500);
      // Login kasir: akun diverifikasi di PC gudang
      const login = async () => {
        await run(`document.querySelector('#lgName').value='Kasir LAN'; document.querySelector('#lgPin').value='135790'; document.querySelector('#lgBtn').click();`);
        await wait(2500);
      };
      await login();
      await run(`if (document.querySelector('#osCash')) throw new Error('kolom modal awal laci masih ada'); document.querySelector('#osBtn').click();`);
      await wait(800);
      await run(`document.querySelector('#qtyInput').value = '3'`);
      await run(`(() => { const i = document.querySelector('#scanInput'); i.focus(); i.value = '4006381333931'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(800);
      await run(`document.querySelector('#payMethods [data-m="QRIS"]').click()`);
      await shot('lan-01-kasir-keranjang');
      await run(`document.querySelector('#payBtn').click()`);
      await wait(1200);
      await shot('lan-02-kasir-struk');
      await run(`document.querySelector('#modalRoot .btn.primary') && document.querySelector('#modalRoot .btn.primary').click()`);

      const p = await readGudangStock();
      console.log('stok di DB gudang setelah kasir jual 3:', p.floor_stock, p.warehouse_stock);
      if (p.floor_stock !== 17) throw new Error('stok gudang tidak berkurang');

      // Peran Kasir: menu Pengaturan & Mutasi tersembunyi, perintah admin ditolak
      const nav = await run(`[...document.querySelectorAll('.nav-btn')].filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.view).join(',')`);
      console.log('menu kasir:', nav);
      if (nav !== 'checkout,products,shift') throw new Error('menu kasir tidak sesuai peran');
      const denied = await run(`window.posBridge.call('device:get')`);
      if (denied.ok) throw new Error('kasir bisa membuka pengaturan mode komputer');
      await shot('lan-03-menu-kasir');

      // Matikan PC gudang → kasir keluar lalu login lagi (login darurat dari cache akun)
      gudang.kill();
      await wait(1000);
      await run(`document.querySelector('#logoutBtn').click()`);
      await wait(2000);
      await login();
      const who = await run(`state.user && state.user.name`);
      console.log('login darurat:', who);
      if (who !== 'Kasir LAN') throw new Error('login darurat gagal');
      await run(`refreshConnection()`);
      await wait(4500);
      const badge = await run(`document.querySelector('#connBadge').innerText`);
      console.log('badge setelah gudang mati:', badge.replace(/\n/g, ' | '));
      await shot('lan-04-kasir-terputus');
      if (!/Terputus/.test(badge)) throw new Error('status terputus tidak tampil');

      // MODE DARURAT: scan dari cache, bayar → nota OFF-... tercetak, masuk antrian lokal
      const banner = await run(`document.querySelector('#emergencyBanner').innerText`);
      if (!/MODE DARURAT/.test(banner) || !/MODE DARURAT/.test(badge)) throw new Error('penanda MODE DARURAT tidak tampil');
      await run(`document.querySelector('#qtyInput').value = '2'`);
      await run(`(() => { const i = document.querySelector('#scanInput'); i.focus(); i.value = '4006381333931'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(800);
      await run(`document.querySelector('#payMethods [data-m="QRIS"]').click()`);
      const payDisabled = await run(`document.querySelector('#payBtn').disabled`);
      if (payDisabled) throw new Error('tombol Bayar nonaktif di mode darurat');
      await run(`document.querySelector('#payBtn').click()`);
      await wait(1500);
      const title = await run(`(document.querySelector('#modalRoot .modal-head') || {}).innerText || ''`);
      console.log('transaksi darurat:', title);
      await shot('lan-05-kasir-mode-darurat');
      const offNo = (title.match(/OFF-[\w-]+/) || [])[0];
      if (!offNo || !/MODE DARURAT/.test(title)) throw new Error('struk darurat OFF- tidak dibuat');
      if (!fs.existsSync(path.join(out, `${offNo}.pdf`))) throw new Error('nota darurat tidak tercetak');
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);
      const queued = await run(`api('app:status').then((s) => s.emergency.pending)`);
      if (queued !== 1) throw new Error(`antrian darurat seharusnya 1, tercatat ${queued}`);

      // PC gudang menyala lagi → antrian terkirim otomatis
      gudang = startGudang();
      let st;
      for (let i = 0; i < 30; i++) {
        await wait(1000);
        st = await run(`refreshConnection().then(() => api('app:status'))`);
        if (st.connected && st.emergency.pending === 0) break;
      }
      console.log('setelah gudang menyala lagi:', JSON.stringify({ connected: st.connected, pending: st.emergency.pending }));
      await shot('lan-06-kasir-terhubung-kembali');
      if (!st.connected || st.emergency.pending !== 0) throw new Error('antrian darurat tidak terkirim');
      gudang.kill();
      await wait(1000);
      const g = await gudangServices();
      const sold = g.shiftSalesRows().filter((r) => r.receipt_no === offNo);
      console.log('stok gudang setelah sinkron:', g.getProduct('BRS-001').floor_stock, '· baris', offNo, sold.length);
      if (g.getProduct('BRS-001').floor_stock !== 15 || sold.length !== 1 || sold[0].qty_sold !== 2) throw new Error('transaksi darurat tidak tercatat benar di gudang');
    } catch (e) {
      console.error('SMOKE LAN GAGAL:', e);
      process.exitCode = 1;
    }
    if (errors.length) { console.error('Error konsol renderer:', errors); process.exitCode = 1; }
    if (gudang && !gudang.killed) gudang.kill();
    console.log('output:', out);
    app.quit();
  });
});
