'use strict';
// Uji asap versi DEMO: electron test/smoke-demo.js [folder-output]
// Data demo di folder sementara; memastikan data contoh, akun latihan, nota PDF, tutup shift tanpa email, dan reset.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('smoke-demo.js')) || path.join(os.tmpdir(), 'pos-smoke-demo'));
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (f.endsWith('.pdf')) fs.unlinkSync(path.join(out, f)); // hasil cetak tes sebelumnya
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-demo-data-'));
process.env.POS_DATA_DIR = dataDir;
process.env.POS_DEMO = '1';
process.env.POS_PRINT_TO_PDF = out; // demo mencetak ke printer sungguhan; di tes dialihkan ke PDF

const { getServices } = require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  const errors = [];
  win.webContents.on('console-message', (_ev, level, msg) => { if (level >= 3) errors.push(msg); });
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(js);
    const shot = async (name) => { await wait(500); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); console.log('screenshot', name); };
    try {
      win.setSize(1366, 820);
      await wait(1200);
      const ribbon = await run(`document.querySelector('#demoRibbon').classList.contains('hidden') ? '' : document.querySelector('#demoRibbon').innerText`);
      if (!/DEMO/.test(ribbon)) throw new Error('pita DEMO tidak tampil');
      const accounts = await run(`document.querySelector('#lgDemo').innerText`);
      console.log('akun latihan di layar login:', accounts.replace(/\s+/g, ' '));
      if (!/Kasir/.test(accounts) || !/333333/.test(accounts)) throw new Error('daftar akun latihan tidak tampil');
      await shot('demo-01-login');

      // Klik akun Kasir → nama & PIN terisi → masuk
      await run(`document.querySelector('#lgDemo [data-name="Kasir"]').click(); document.querySelector('#lgBtn').click();`);
      await wait(2000);
      const svc = getServices();
      const mnm = svc.getProduct('MNM-001');
      await run(`if (document.querySelector('#osCash')) throw new Error('kolom modal awal laci masih ada'); document.querySelector('#osBtn').click();`);
      await wait(700);
      await run(`document.querySelector('#qtyInput').value = '2'`);
      await run(`(() => { const i = document.querySelector('#scanInput'); i.focus(); i.value = '${mnm.barcode}'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(600);
      await run(`document.querySelector('#payMethods [data-m="QRIS"]').click()`);
      await shot('demo-02-kasir');
      await run(`document.querySelector('#payBtn').click()`);
      await wait(2500);
      await shot('demo-03-struk');
      await run(`document.querySelector('#modalRoot .btn.primary') && document.querySelector('#modalRoot .btn.primary').click()`);
      const prints = fs.readdirSync(out);
      console.log('nota demo (PDF tes):', prints.filter((f) => f.endsWith('.pdf')).join(', '));
      if (!prints.some((f) => /^INV-.*\.pdf$/.test(f))) throw new Error('nota demo tidak tercetak');
      if (svc.getProduct('MNM-001').floor_stock !== mnm.floor_stock - 2) throw new Error('stok demo tidak berkurang');

      // Tutup shift: laporan dibuat, email tidak dikirim sungguhan
      const close = await run(`window.posBridge.call('shift:close', {})`);
      console.log('tutup shift demo:', JSON.stringify(close.data && close.data.response || close.error));
      if (!close.ok || !/DEMO/.test(close.data.response)) throw new Error('tutup shift demo gagal');
      if (!fs.readdirSync(path.join(dataDir, 'Laporan-Demo')).length) throw new Error('laporan demo tidak dibuat');

      // Reset → data contoh kembali ke awal, harus login lagi
      const reset = await run(`window.posBridge.call('demo:reset')`);
      if (!reset.ok) throw new Error(`reset gagal: ${reset.error}`);
      await wait(2000);
      const after = getServices();
      console.log('setelah reset: stok MNM-001', after.getProduct('MNM-001').floor_stock, '· barang', after.listProducts({}).length, '· shift', after.getShift());
      if (after.getProduct('MNM-001').floor_stock !== mnm.floor_stock || after.listProducts({}).length !== 30 || after.getShift()) throw new Error('reset demo tidak mengembalikan data');
      const loginShown = await run(`!document.querySelector('#loginScreen').classList.contains('hidden')`);
      if (!loginShown) throw new Error('setelah reset seharusnya kembali ke layar login');
      await shot('demo-04-setelah-reset');
    } catch (e) {
      console.error('SMOKE DEMO GAGAL:', e);
      process.exitCode = 1;
    }
    if (errors.length) { console.error('Error konsol renderer:', errors); process.exitCode = 1; }
    console.log('output:', out);
    app.quit();
  });
});
