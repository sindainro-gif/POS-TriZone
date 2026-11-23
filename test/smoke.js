'use strict';
// Uji asap UI: electron test/smoke.js [folder-output]
// Menjalankan aplikasi dengan database sementara, mengisi data contoh, melakukan transaksi lewat UI,
// lalu menyimpan screenshot tiap layar ke folder output.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('smoke.js')) || path.join(os.tmpdir(), 'pos-smoke'));
fs.mkdirSync(out, { recursive: true });
process.env.POS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-smoke-data-'));
process.env.POS_REPORTS_DIR = path.join(process.env.POS_DATA_DIR, 'laporan');
process.env.POS_PRINT_TO_PDF = out; // nota "dicetak" ke PDF berukuran kertas thermal
process.env.POS_NO_SHELL_OPEN = '1'; // laporan yang dibuka Admin tidak benar-benar dibuka di program lain
// Laporan dari versi lama (belum terenkripsi, bertanggal kemarin): harus dienkripsi saat aplikasi dibuka.
// Laporan tahun 2020 (lebih dari 7 hari): harus terhapus otomatis saat aplikasi dibuka.
const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; })();
const LEGACY_REPORT = `Shift_${yesterday}_080000`;
const OLD_REPORT = 'Shift_20200101_000000';
for (const dirName of [LEGACY_REPORT, OLD_REPORT]) {
  fs.mkdirSync(path.join(process.env.POS_REPORTS_DIR, dirName), { recursive: true });
  fs.writeFileSync(path.join(process.env.POS_REPORTS_DIR, dirName, `Rekap_${dirName}.pdf`), '%PDF-1.4 laporan lama');
  fs.writeFileSync(path.join(process.env.POS_REPORTS_DIR, dirName, `Penjualan_${dirName}.csv`), 'No_Struk;Waktu\nINV-LAMA;2020');
}

const { getServices } = require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let started = false;
app.on('browser-window-created', (_e, win) => {
  // Hanya jendela utama; jendela tersembunyi untuk PDF/cetak diabaikan
  if (started) return;
  started = true;
  const errors = [];
  win.webContents.on('console-message', (_ev, level, msg, line, src) => { if (level >= 2) errors.push(`${msg} (${path.basename(src || '')}:${line})`); });
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(js);
    const shot = async (name) => {
      await wait(500);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
      console.log('screenshot', name);
    };
    try {
      win.setSize(1366, 820);
      const svc = getServices();
      svc.importRows([
        { Barcode: '8991234567890', SKU: 'MNM-001', Nama_Barang: 'Air Mineral 600ml', Merk: 'Segar', Kategori: 'Minuman', Harga_Jual: 3500, Satuan_Masuk: 'Dus', Rasio_Isi_Dus: 24, Stok_Awal_Toko: 30, Stok_Awal_Gudang: 96, Stok_Awal_BS: 2, Min_Alert_Toko: 12 },
        { Barcode: '8997654321098', SKU: 'SNK-010', Nama_Barang: 'Keripik Kentang 68g', Merk: 'Renyah', Kategori: 'Makanan Ringan', Harga_Jual: 11500, Satuan_Masuk: 'Karton', Rasio_Isi_Dus: 40, Stok_Awal_Toko: 4, Stok_Awal_Gudang: 80, Min_Alert_Toko: 10 },
        { Barcode: '8990001112223', SKU: 'SBN-005', Nama_Barang: 'Sabun Mandi 85g', Merk: 'Wangi', Kategori: 'Perawatan', Harga_Jual: 4200, Rasio_Isi_Dus: 72, Stok_Awal_Toko: 15, Stok_Awal_Gudang: 0, Stok_Awal_BS: 3, Min_Alert_Toko: 5 },
      ]);
      svc.saveSettings({ store_name: 'Toko Sumber Rejeki', store_address: 'Jl. Merdeka No. 1',
        receipt_header: 'KANO 5000 SEPANJANG\nJl. Raya Wonocolo No. 48\nTelp:085111328510', receipt_footer: 'KUMPULKAN HINGGA 200 BIJI\nDAN TUKARKAN SOUVENIR' });
      await wait(800);
      // Database baru tanpa akun → layar "Buat Akun Admin"
      const sub = await run(`document.querySelector('#lgSub').textContent`);
      if (!/ADMIN/.test(sub)) throw new Error('layar buat akun admin tidak tampil');
      await shot('00-buat-akun-admin');
      const login = async (name, pin, pin2) => {
        await run(`document.querySelector('#lgName').value=${JSON.stringify(name)}; document.querySelector('#lgPin').value=${JSON.stringify(pin)};
          document.querySelector('#lgPin2').value=${JSON.stringify(pin2 || '')}; document.querySelector('#lgBtn').click();`);
        await wait(2000); // halaman dimuat ulang setelah login
      };
      await login('Pemilik', '111111', '111111');
      await shot('01-kasir-belum-shift');

      // Ukuran tampilan: A+ dua kali → 125%; Ctrl+0 → 100%; Ctrl+= → 110% dan tetap berlaku setelah muat ulang
      const zoomOf = () => run(`({ f: window.posBridge.getZoom(), lbl: document.querySelector('#zoomCtl [data-zoom="0"]').textContent, saved: localStorage.getItem('pos-zoom'), w: window.innerWidth })`);
      const z100 = await zoomOf();
      await run(`document.querySelector('#zoomCtl [data-zoom="1"]').click(); document.querySelector('#zoomCtl [data-zoom="1"]').click();`);
      await wait(400);
      const z125 = await zoomOf();
      console.log('ukuran tampilan:', JSON.stringify({ awal: z100, besar: z125 }));
      if (Math.abs(z100.f - 1) > 0.001 || Math.abs(z125.f - 1.25) > 0.001 || z125.lbl !== '125%' || z125.saved !== '1.25' || !(z125.w < z100.w)) {
        throw new Error('tombol A+ tidak memperbesar tampilan');
      }
      await shot('01b-tampilan-125');
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
      if (Math.abs((await zoomOf()).f - 1) > 0.001) throw new Error('Ctrl+0 tidak mengembalikan tampilan ke 100%');
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }))`);
      win.webContents.reload();
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      await wait(1500);
      const zReload = await zoomOf();
      if (Math.abs(zReload.f - 1.1) > 0.001 || zReload.lbl !== '110%') throw new Error(`ukuran tampilan tidak bertahan setelah muat ulang: ${JSON.stringify(zReload)}`);
      if (!win.isVisible()) throw new Error('jendela aplikasi tidak tampil (ready-to-show tidak terpicu?)');
      await run(`document.querySelector('#zoomCtl [data-zoom="0"]').click()`); // kembali 100% untuk langkah berikutnya
      await wait(300);

      // Lebar menu samping: geser garis batas (180–400 px), klik dua kali = 248, ciutkan jadi ikon; tersimpan per komputer
      const sbOf = () => run(`({ w: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), saved: localStorage.getItem('pos-sidebar-w'),
        col: document.body.classList.contains('sb-collapsed'), savedCol: localStorage.getItem('pos-sidebar-collapsed') })`);
      const sbDrag = (x) => run(`(() => { const r = document.querySelector('#sbResizer'); const o = { bubbles: true, pointerId: 1, button: 0, clientY: 300 };
        r.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 248 })); r.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: ${x} }));
        r.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: ${x} })); })()`);
      const sbDbl = () => run(`document.querySelector('#sbResizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sbDrag(320);
      const sb320 = await sbOf();
      await sbDrag(50);
      const sbMin = await sbOf();
      await sbDrag(900);
      const sbMax = await sbOf();
      await sbDbl();
      const sbDef = await sbOf();
      console.log('lebar menu:', JSON.stringify({ geser: sb320, min: sbMin, max: sbMax, klikDua: sbDef }));
      if (sb320.w !== 320 || sb320.saved !== '320' || sbMin.w !== 180 || sbMax.w !== 400 || sbDef.w !== 248 || sbDef.saved !== '248') throw new Error('geser lebar menu tidak sesuai');
      await sbDrag(300);
      await run(`document.querySelector('#sbToggle').click()`);
      await wait(300);
      const sbCol = await run(`({ w: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
        label: getComputedStyle(document.querySelector('#nav [data-view="checkout"] span:nth-child(2)')).display,
        tip: document.querySelector('#nav [data-view="checkout"]').title, saved: localStorage.getItem('pos-sidebar-collapsed'),
        resizer: getComputedStyle(document.querySelector('#sbResizer')).display, theme: getComputedStyle(document.querySelector('#themeSeg')).display,
        toggle: getComputedStyle(document.querySelector('#sbToggle')).display, settings: getComputedStyle(document.querySelector('.sidebar-foot [data-view="settings"]')).display })`);
      await run(`document.querySelector('#nav [data-view="products"]').click()`);
      await wait(400);
      const sbNav = await run('state.view');
      await run(`document.querySelector('#nav [data-view="checkout"]').click()`);
      await wait(400);
      console.log('menu ciut:', JSON.stringify({ ...sbCol, klikMenu: sbNav }));
      if (sbCol.w > 72 || sbCol.label !== 'none' || sbCol.tip !== 'Kasir / Pembayaran' || sbCol.saved !== '1' || sbCol.resizer !== 'none' || sbCol.theme !== 'none'
        || sbCol.toggle === 'none' || sbCol.settings === 'none' || sbNav !== 'products') {
        throw new Error('tombol ciutkan menu tidak sesuai');
      }
      await shot('01c-menu-ciut');
      // Bertahan setelah aplikasi dimuat ulang; dilebarkan lagi kembali ke lebar sebelumnya
      win.webContents.reload();
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      await wait(1500);
      const sbReload = await sbOf();
      await run(`document.querySelector('#sbToggle').click()`);
      await wait(300);
      const sbBack = await sbOf();
      await sbDbl(); // kembali ke ukuran awal untuk langkah berikutnya
      const sbEnd = await sbOf();
      console.log('menu setelah muat ulang:', JSON.stringify({ muatUlang: sbReload, dilebarkan: sbBack, akhir: sbEnd }));
      if (!sbReload.col || sbReload.w > 72 || sbBack.col || sbBack.w !== 300 || sbEnd.w !== 248 || sbEnd.savedCol !== '0') throw new Error('pilihan lebar menu tidak bertahan / tidak kembali');

      await run(`if (document.querySelector('#osCash')) throw new Error('kolom modal awal laci masih ada'); document.querySelector('#osBtn').click();`);
      await wait(600);
      // Dropdown saran: salah ketik "minral" tetap menemukan Air Mineral
      await run(`(() => { const i = document.querySelector('#scanInput'); i.focus(); i.value = 'minral'; i.dispatchEvent(new Event('input')); })()`);
      await wait(700);
      const suggest = await run(`[...document.querySelectorAll('.picker-list:not(.hidden) .picker-item .pname')].map((e) => e.textContent).join(' | ')`);
      console.log('saran untuk "minral":', suggest);
      await shot('02a-dropdown-mirip');
      if (!/Air Mineral 600ml/.test(suggest)) throw new Error('dropdown pencarian mirip tidak muncul');
      await run(`(() => { const i = document.querySelector('#scanInput'); i.value = ''; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
      // Kursor default di kolom scan. Enter di scan kosong → Jumlah; isi jumlah, Enter → kembali ke scan → scan barang
      const focusNow = () => run(`document.activeElement.id`);
      const scan = async (code, qty) => {
        if (qty) {
          const toQty = await run(`(() => { const i = document.querySelector('#scanInput'); i.focus(); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return document.activeElement.id; })()`);
          if (toQty !== 'qtyInput') throw new Error(`Enter di scan kosong tidak pindah ke Jumlah (${toQty})`);
          const back = await run(`(() => { const q = document.querySelector('#qtyInput'); q.value = '${qty}'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return document.activeElement.id; })()`);
          if (back !== 'scanInput') throw new Error(`Enter di Jumlah tidak kembali ke kolom scan (${back})`);
        }
        await run(`(() => { const i = document.querySelector('#scanInput'); i.focus(); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await wait(400);
      };
      const firstFocus = await focusNow();
      if (firstFocus !== 'scanInput') throw new Error(`kursor awal seharusnya di kolom scan (${firstFocus})`);
      // Suara kasir: tombol 🔊 menyalakan (bawaan mati); teks yang dibacakan ditangkap, tanpa suara sungguhan
      const voiceOff = await run(`document.querySelector('#voiceBtn').classList.contains('on')`);
      if (voiceOff) throw new Error('suara kasir seharusnya mati secara bawaan');
      await run(`window.__spoken = []; window.speechSynthesis.speak = (u) => window.__spoken.push(u.text); document.querySelector('#voiceBtn').click();`);
      const voiceOn = await run(`({ on: document.querySelector('#voiceBtn').classList.contains('on'), saved: JSON.parse(localStorage.getItem('pos-voice')).enabled, focus: document.activeElement.id })`);
      if (!voiceOn.on || !voiceOn.saved || voiceOn.focus !== 'scanInput') throw new Error(`tombol suara tidak aktif: ${JSON.stringify(voiceOn)}`);
      await scan('8991234567890', 12);
      const qtyAfter = await run(`document.querySelector('#qtyInput').value`);
      if (qtyAfter !== '1') throw new Error(`Jumlah tidak kembali ke 1 (${qtyAfter})`);
      const afterScan = await focusNow();
      if (afterScan !== 'scanInput') throw new Error(`setelah scan kursor seharusnya tetap di kolom scan (${afterScan})`);
      // Pengaturan suara: ganti ke "Nama + harga" lewat modal
      await run(`document.querySelector('#voiceCfg').click()`);
      await wait(400);
      await shot('02b-suara-kasir');
      await run(`(() => { const m = document.querySelector('#modalRoot'); m.querySelector('#vcMode').value = 'name_price';
        [...m.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Simpan').click(); })()`);
      await wait(300);
      await scan('8997654321098');
      await scan('8997654321098', 10); // melebihi display toko → peringatan tiga zona
      const spoken = await run(`window.__spoken`);
      console.log('suara kasir:', JSON.stringify(spoken));
      if (JSON.stringify(spoken) !== JSON.stringify(['Air Mineral 600ml', 'Keripik Kentang 68g, sebelas ribu lima ratus', 'sepuluh Keripik Kentang 68g, seratus lima belas ribu'])) {
        throw new Error('teks suara kasir tidak sesuai');
      }
      // Dimatikan lagi → tidak ada yang dibacakan
      await run(`document.querySelector('#voiceBtn').click()`);
      const silent = await run(`(() => { voice.announce({ name: 'Tes' }, 1); return { n: window.__spoken.length, on: document.querySelector('#voiceBtn').classList.contains('on') }; })()`);
      if (silent.n !== 3 || silent.on) throw new Error(`suara seharusnya mati: ${JSON.stringify(silent)}`);
      // Hanya metode Tunai: tidak ada pilihan metode; F12 = fokus Uang Diterima; ketik uang lalu Enter = bayar
      if (await run(`!!document.querySelector('#payMethods') || /QRIS|Transfer/.test(document.querySelector('#view-checkout').innerText)`)) throw new Error('pilihan metode pembayaran seharusnya sudah dihapus');
      const f12 = await run(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }));
        return { focus: document.activeElement.id, view: state.view }; })()`);
      console.log('F12:', JSON.stringify(f12));
      if (f12.focus !== 'cashInput' || f12.view !== 'checkout') throw new Error('F12 tidak mengisi Uang Diterima');
      // F12 lagi di kolom Uang Diterima = Uang Pas
      const f12Pas = await run(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }));
        return { cash: document.querySelector('#cashInput').value.replace(/\\D/g, ''), pas: document.querySelector('#quickCash [data-v]').dataset.v, focus: document.activeElement.id }; })()`);
      console.log('F12 lagi:', JSON.stringify(f12Pas));
      if (f12Pas.cash !== f12Pas.pas || f12Pas.focus !== 'cashInput') throw new Error('F12 kedua tidak mengisi Uang Pas');
      await run(`(() => { const c = document.querySelector('#cashInput'); c.value = '200.000'; c.dispatchEvent(new Event('input')); })()`);
      await shot('02-kasir-keranjang');
      // Jumlah barang (biji) & jenis barang terlihat jelas sebelum Bayar: 11 Keripik + 12 Air Mineral
      const counts = await run(`({ qty: document.querySelector('#coQty').textContent, kinds: document.querySelector('#coKinds').textContent, text: document.querySelector('.co-counts').innerText.replace(/\\s+/g, ' ') })`);
      console.log('jumlah di kasir:', JSON.stringify(counts));
      if (counts.qty !== '23' || counts.kinds !== '2' || !/Jumlah Barang 23 Biji/.test(counts.text) || !/Jenis Barang 2 jenis/.test(counts.text)) throw new Error('jumlah barang / jenis barang di kasir tidak sesuai');
      // Buka laci (tombol & F2): perintah ESC/POS ke printer nota (mode uji = file Laci_*.bin); tekan berulang < 1 detik diabaikan
      const laciFiles = () => fs.readdirSync(out).filter((f) => /^Laci_.*\.bin$/.test(f)).sort();
      const laci0 = laciFiles().length;
      await run(`document.querySelector('#drawerBtn').click()`);
      await wait(500);
      const laciToast = await run(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText).join(' | ')`);
      await wait(700);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));`);
      await wait(500);
      const laci = laciFiles();
      const laciState = await run(`({ focus: document.activeElement.id, cash: document.querySelector('#cashInput').value, cart: document.querySelectorAll('#cartBody tr').length })`);
      console.log('buka laci:', laci.length - laci0, 'kali ·', JSON.stringify(laciState));
      if (laci.length - laci0 !== 2 || !/Laci dibuka/.test(laciToast) || !fs.readFileSync(path.join(out, laci[laci.length - 1])).equals(require('../src/drawer').KICK)
        || laciState.focus !== 'scanInput' || laciState.cash !== '200.000' || laciState.cart !== 2) {
        throw new Error('tombol / F2 buka laci tidak bekerja');
      }
      const alertText = await run(`document.querySelector('#stockAlert').className + ' | ' + document.querySelector('#stockAlert').innerText`);
      console.log('peringatan stok:', alertText);
      // Keripik: display toko 4, di keranjang 11 → tetap masuk keranjang dengan peringatan kuning
      const keripikQty = await run(`document.querySelector('#cartBody tr[data-sku="SNK-010"] [data-act=qty]').value`);
      if (keripikQty !== '11' || !/warn/.test(alertText) || !/Tetap dijual/.test(alertText)) throw new Error(`kasir seharusnya boleh menjual melebihi stok (qty ${keripikQty})`);
      const laciBayar = laciFiles().length;
      await run(`document.querySelector('#cashInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await wait(700);
      if (laciFiles().length !== laciBayar + 1) throw new Error('laci tidak terbuka otomatis saat Bayar');
      const receiptTitle = await run(`(document.querySelector('#modalRoot .modal-head') || {}).innerText || ''`);
      if (!/Transaksi Berhasil/.test(receiptTitle)) throw new Error('Enter di Uang Diterima tidak membayar');
      if (await run(`document.querySelector('#coQty').textContent + '/' + document.querySelector('#coKinds').textContent`) !== '0/0') throw new Error('jumlah barang tidak kembali 0 setelah bayar');
      await shot('03-kasir-struk');
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);

      svc.createTransfer({ sku: 'MNM-001', from_zone: 'floor', to_zone: 'damaged', qty: 1, reason: 'Pecah terinjak' });
      if (svc.getProduct('SNK-010').floor_stock !== -7) throw new Error(`display toko Keripik seharusnya -7: ${svc.getProduct('SNK-010').floor_stock}`);
      await run(`document.querySelector('[data-view=transfers]').click()`);
      await wait(600);
      const restock = await run(`({ first: document.querySelector('#trLowList .low-item').className + ' | ' + document.querySelector('#trLowList .low-item').innerText.replace(/\\s+/g, ' '),
        badge: (document.querySelector('#nav [data-view="transfers"] .nav-badge:not(.hidden)') || {}).textContent || '' })`);
      console.log('saran restock teratas:', JSON.stringify(restock));
      if (!/\bout\b/.test(restock.first) || !/MINUS -7/.test(restock.first) || !/Keripik/.test(restock.first) || !restock.badge) throw new Error('barang minus tidak tampil merah paling atas / badge Mutasi tidak muncul');
      // Form Mutasi: kursor awal di Barang, Enter di Barang kosong → Jumlah, Enter di Jumlah → Barang; Satuan bawaan Biji
      const trNav = await run(`(() => { const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const start = document.activeElement.id; enter(document.querySelector('#trPicker')); const toQty = document.activeElement.id;
        enter(document.querySelector('#trQty')); return { start, toQty, back: document.activeElement.id, unit: document.querySelector('#trUnit').value }; })()`);
      console.log('navigasi Mutasi:', JSON.stringify(trNav));
      if (trNav.start !== 'trPicker' || trNav.toQty !== 'trQty' || trNav.back !== 'trPicker' || trNav.unit !== 'Biji') throw new Error('navigasi Enter Barang/Jumlah di Mutasi salah');
      // Form Mutasi multi-barang: scan → Jumlah → Enter = masuk list; Simpan = satu nomor mutasi
      const bsBefore = svc.getProduct('SNK-010').damaged_stock;
      await run(`(() => { const d = document.querySelector('#trDirection'); d.value = 'customer>damaged'; d.dispatchEvent(new Event('change')); })()`);
      const trAdd = async (code, n) => {
        await run(`(() => { const i = document.querySelector('#trPicker'); i.focus(); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await wait(400);
        await run(`(() => { const q = document.querySelector('#trQty'); q.value = '${n}'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      };
      await trAdd('8997654321098', 2);
      await trAdd('8990001112223', 1);
      await trAdd('8997654321098', 1); // barang sama → jumlah digabung
      const trList = await run(`({ rows: [...document.querySelectorAll('#trItems tr[data-i]')].map((r) => r.children[1].textContent + ':' + r.querySelector('[data-act=qty]').value), focus: document.activeElement.id, total: document.querySelector('#trTotal').textContent })`);
      console.log('list Mutasi:', JSON.stringify(trList));
      if (trList.rows.join(',') !== 'SNK-010:3,SBN-005:1' || trList.focus !== 'trPicker') throw new Error('barang tidak masuk list Mutasi dengan benar');
      await shot('04-mutasi');
      await run(`document.querySelector('#trSubmit').click()`);
      await wait(300);
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);
      await wait(700);
      const trDoc = await run(`({ first: document.querySelector('#trHistory tr').innerText.replace(/\\s+/g, ' '), left: document.querySelectorAll('#trItems tr[data-i]').length })`);
      console.log('riwayat Mutasi teratas:', JSON.stringify(trDoc));
      if (!/MT-\d{8}-\d{3}/.test(trDoc.first) || !/\b2 4\b/.test(trDoc.first) || trDoc.left !== 0) throw new Error('form Mutasi tidak tersimpan sebagai satu dokumen');
      if (svc.getProduct('SNK-010').damaged_stock !== bsBefore + 3) throw new Error('stok BS Keripik tidak bertambah 3');
      await run(`document.querySelector('#trHistory [data-id]').click()`);
      await wait(400);
      const trDetail = await run(`document.querySelectorAll('#modalRoot tbody tr').length`);
      if (trDetail !== 2) throw new Error(`detail mutasi seharusnya 2 baris, bukan ${trDetail}`);
      await shot('04b-mutasi-detail');
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);
      await wait(200);
      // Satuan Coly: tekan C di Jumlah → 2 Coly isi 24 = 48 Biji; satuan kembali ke Biji setelah masuk list
      const whMnm = svc.getProduct('MNM-001').warehouse_stock;
      const flMnm = svc.getProduct('MNM-001').floor_stock;
      await run(`(() => { const d = document.querySelector('#trDirection'); d.value = 'warehouse>floor'; d.dispatchEvent(new Event('change')); })()`);
      await run(`(() => { const i = document.querySelector('#trPicker'); i.focus(); i.value = '8991234567890'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(400);
      const colyPick = await run(`(() => { const q = document.querySelector('#trQty'); q.value = '2'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        return { unit: document.querySelector('#trUnit').value, opt: document.querySelector('#trUnit option[value="Coly"]').textContent,
          hl: document.querySelector('.unit-field').classList.contains('coly'), qty: q.value, focus: document.activeElement.id }; })()`);
      await shot('04c-mutasi-coly-pilih');
      await run(`document.querySelector('#trQty').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await wait(200);
      const colyList = await run(`({ row: document.querySelector('#trItems tr[data-i]').innerText.replace(/\\s+/g, ' '), total: document.querySelector('#trTotal').textContent,
        unit: document.querySelector('#trUnit').value, hl: document.querySelector('.unit-field').classList.contains('coly') })`);
      console.log('mutasi coly:', JSON.stringify({ pilih: colyPick, list: colyList }));
      if (colyPick.unit !== 'Coly' || colyPick.opt !== 'Coly (isi 24)' || !colyPick.hl || colyPick.qty !== '2' || colyPick.focus !== 'trQty'
        || !/Coly \(isi 24\) = 48 Biji/.test(colyList.row) || colyList.total !== '1 baris · 48 Biji' || colyList.unit !== 'Biji' || colyList.hl) {
        throw new Error('pilihan satuan Coly di Mutasi tidak sesuai');
      }
      await run(`document.querySelector('#trSubmit').click()`);
      await wait(300);
      const colyConfirm = await run(`document.querySelector('#modalRoot').innerText`);
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);
      await wait(700);
      if (!/48 Biji/.test(colyConfirm) || svc.getProduct('MNM-001').warehouse_stock !== whMnm - 48 || svc.getProduct('MNM-001').floor_stock !== flMnm + 48) {
        throw new Error('mutasi 2 Coly tidak memindahkan 48 Biji');
      }
      await run(`document.querySelector('#trHistory [data-id]').click()`);
      await wait(400);
      const colyDetail = await run(`document.querySelector('#modalRoot tbody').innerText.replace(/\\s+/g, ' ')`);
      console.log('detail mutasi coly:', colyDetail);
      if (!/2 Coly \(isi 24\) = 48 Biji/.test(colyDetail)) throw new Error('detail mutasi tidak menampilkan Coly');
      await shot('04c-mutasi-coly-detail');
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);
      await wait(200);
      const f12View = await run(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })); return state.view + '/' + document.activeElement.id; })()`);
      if (f12View !== 'checkout/cashInput') throw new Error(`F12 dari layar lain seharusnya ke Uang Diterima Kasir, bukan ${f12View}`);
      await run(`document.querySelector('[data-view=receiving]').click()`);
      await shot('05-penerimaan');

      // Import penerimaan via Excel: tombol tampil, baris file → penerimaan baru di riwayat
      const rcBtns = await run(`['#rcTemplate', '#rcImport'].every((s) => document.querySelector(s).offsetParent !== null)`);
      if (!rcBtns) throw new Error('Tombol Unduh Template / Import Excel di Penerimaan tidak tampil');
      svc.importRows([{ Barcode: '7770000000059', SKU: 'IMP-SMK', Nama_Barang: 'Barang Import Smoke', Harga_Jual: 2000, Rasio_Isi_Dus: 10 }]);
      const rcImp = await run(`window.posBridge.call('receptions:import', { rows: [
        { No_Surat_Jalan: 'SJ-IMPORT', Supplier: 'PT Excel', Kode: 'IMP-SMK', Jumlah: 2, Satuan: 'Dus', Tujuan: 'Gudang Utama' },
        { No_Surat_Jalan: 'SJ-IMPORT', Kode: 'BELUM-ADA', Jumlah: 1 },
      ] }).then((r) => r.data)`);
      console.log('import penerimaan:', JSON.stringify(rcImp));
      if (rcImp.created.length !== 1 || rcImp.created[0].total_items_count !== 20 || rcImp.errors.length !== 1) throw new Error('hasil import penerimaan salah');
      await run(`document.querySelector('#rcSearch').dispatchEvent(new Event('input'))`);
      await wait(500);
      const rcHist = await run(`document.querySelector('#rcHistory').innerText`);
      if (!/SJ-IMPORT/.test(rcHist)) throw new Error('SJ-IMPORT tidak tampil di Riwayat Penerimaan');

      // Kode BELUM-ADA masuk Draft Barang Belum Terdaftar + angka merah di menu Penerimaan
      await run(`document.querySelector('[data-view=checkout]').click()`);
      await run(`document.querySelector('[data-view=receiving]').click()`);
      await wait(600);
      const dr1 = await run(`({ card: !document.querySelector('#rcDraftCard').classList.contains('hidden'), rows: document.querySelectorAll('#rcDrafts tr').length,
        badge: document.querySelector('#nav [data-view=receiving] .nav-badge')?.textContent, text: document.querySelector('#rcDrafts').innerText })`);
      console.log('draft penerimaan:', JSON.stringify(dr1));
      if (!dr1.card || dr1.rows !== 1 || dr1.badge !== '1' || !/Belum terdaftar/.test(dr1.text)) throw new Error('Draft barang belum terdaftar tidak tampil');
      await shot('05a-draft-belum-terdaftar');

      // Scan kode tidak dikenal di form manual → modal Catat sebagai Draft
      await run(`(() => { document.querySelector('#rcRef').value = 'SJ-MANUAL'; const p = document.querySelector('#rcPicker'); p.value = 'KODE-ASING-9'; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(800);
      const dfTitle = await run(`document.querySelector('#modalRoot .modal-head')?.textContent`);
      if (dfTitle !== 'Barang Belum Terdaftar') throw new Error(`modal draft tidak muncul untuk kode tidak dikenal (${dfTitle})`);
      await run(`document.querySelector('#dfName').value = 'Barang Asing'; document.querySelector('#modalRoot .btn.primary').click()`);
      await wait(600);
      const badge2 = await run(`document.querySelector('#nav [data-view=receiving] .nav-badge').textContent`);
      if (badge2 !== '2') throw new Error(`badge draft seharusnya 2 (${badge2})`);
      await run(`document.querySelector('#rcRef').value = ''`);

      // Form Penerimaan: tanpa Nama Supplier; Enter = pindah ke kolom berikutnya, Enter di Tujuan = Tambah
      if (await run(`!!document.querySelector('#rcSupplier')`)) throw new Error('kolom Nama Supplier seharusnya sudah dihapus');
      const enterOn = (sel) => run(`(() => { const el = document.querySelector('${sel}'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return document.activeElement.id; })()`);
      const flow = [];
      await run(`document.querySelector('#rcRef').value = 'SJ-ENTER'`);
      flow.push(await enterOn('#rcRef'));
      flow.push(await enterOn('#rcNotes'));
      await run(`document.querySelector('#rcPicker').value = ${JSON.stringify(svc.getProduct('SBN-005').barcode)}`);
      await enterOn('#rcPicker');
      await wait(700);
      flow.push(await run('document.activeElement.id'));
      await run(`document.querySelector('#rcQty').value = '3'`);
      flow.push(await enterOn('#rcQty'));
      await run(`document.querySelector('#rcUnit').value = 'Biji'`);
      flow.push(await enterOn('#rcUnit'));
      await run(`document.querySelector('#rcDest').value = 'floor'`);
      flow.push(await enterOn('#rcDest'));
      const enterItems = await run(`document.querySelector('#rcItems').innerText`);
      console.log('Enter di form penerimaan:', flow.join(' → '), '·', enterItems.replace(/\s+/g, ' '));
      if (flow.join(',') !== 'rcNotes,rcPicker,rcQty,rcUnit,rcDest,rcPicker' || !/Sabun Mandi 85g/.test(enterItems) || !/Display Toko/.test(enterItems) || !/\b3\b/.test(enterItems)) {
        throw new Error('Enter di form Penerimaan tidak berpindah kolom / tidak menambah barang');
      }
      await shot('05b-penerimaan-enter');
      await run(`(() => { document.querySelector('#rcDest').value = 'warehouse'; document.querySelector('#rcUnit').value = 'Dus'; document.querySelector('#rcReset').click(); })()`);
      await wait(400);
      await run(`document.querySelector('#modalRoot .modal-foot .btn.danger').click()`); // konfirmasi Ya, Batalkan
      if (await run(`document.querySelector('#modalRoot').children.length + document.querySelectorAll('#rcItems [data-i]').length`)) throw new Error('form penerimaan tidak kosong setelah Batal');
      await wait(300);

      // Barang didaftarkan → Proses → stok masuk, draft hilang
      svc.importRows([{ Barcode: '7770000000080', SKU: 'BELUM-ADA', Nama_Barang: 'Barang Susulan', Harga_Jual: 2500, Rasio_Isi_Dus: 6 }]);
      await run(`document.querySelector('[data-view=checkout]').click()`);
      await run(`document.querySelector('[data-view=receiving]').click()`);
      await wait(600);
      await run(`[...document.querySelectorAll('#rcDrafts tr')].find((r) => /BELUM-ADA/.test(r.innerText)).querySelector('[data-act=process]').click()`);
      await wait(600);
      await run(`document.querySelector('#modalRoot .btn.primary').click()`); // konfirmasi Proses
      await wait(800);
      await run(`document.querySelector('#modalRoot .btn.ghost')?.click()`); // tawaran cetak barcode → Batal
      await wait(400);
      const dr2 = await run(`({ rows: document.querySelectorAll('#rcDrafts tr').length, badge: document.querySelector('#nav [data-view=receiving] .nav-badge').textContent, hist: document.querySelector('#rcHistory').innerText })`);
      if (dr2.rows !== 1 || dr2.badge !== '1' || !/SJ-IMPORT-S\d+/.test(dr2.hist)) throw new Error(`proses draft gagal: ${JSON.stringify(dr2)}`);
      if (svc.getProduct('BELUM-ADA').warehouse_stock !== 6) throw new Error('stok draft yang diproses tidak masuk');
      const asing = svc.listReceptionDrafts()[0];
      svc.deleteReceptionDraft({ id: asing.id });

      // Tombol F untuk pindah menu sudah dihapus: F1/F3/F4/F5/F6/F7/F10 tidak memindah layar, label F di menu tidak ada
      const fKeys = await run(`(() => { const before = state.view;
        for (const key of ['F1', 'F3', 'F4', 'F5', 'F6', 'F7', 'F10']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        return { before, after: state.view, kbd: document.querySelectorAll('#nav kbd').length }; })()`);
      console.log('tombol F menu:', JSON.stringify(fKeys));
      if (fKeys.after !== fKeys.before || fKeys.kbd !== 0) throw new Error('tombol F pindah menu seharusnya sudah tidak ada');
      // Stok Opname (klik menu): scan barang + jumlah fisik → Simpan → stok zona = hitungan fisik
      await run(`document.querySelector('#nav [data-view=opname]').click()`);
      await wait(500);
      const opView = await run(`state.view + '/' + document.activeElement.id + (document.querySelector('#view-opname').offsetParent && document.querySelector('#nav [data-view=opname]').classList.contains('active') ? '' : '/tersembunyi')`);
      if (opView !== 'opname/opPicker') throw new Error(`menu Stok Opname seharusnya terbuka dengan kursor di Barang (${opView})`);
      await run(`(() => { const d = document.querySelector('#opZone'); d.value = 'warehouse'; d.dispatchEvent(new Event('change')); })()`);
      await wait(200);
      const opAdd = async (code, n) => {
        await run(`(() => { const i = document.querySelector('#opPicker'); i.focus(); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await wait(400);
        await run(`(() => { const q = document.querySelector('#opQty'); q.value = '${n}'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      };
      const whBefore = svc.getProduct('IMP-SMK').warehouse_stock;
      await opAdd('7770000000059', 5);
      await opAdd('7770000000059', 2); // hitung dua tumpukan → dijumlahkan
      await opAdd('7770000000080', -2); // hitungan minus boleh
      const opList = await run(`({ rows: [...document.querySelectorAll('#opItems tr[data-i]')].map((r) => r.children[1].textContent + ':' + r.querySelector('[data-act=qty]').value + ':' + r.children[5].textContent), total: document.querySelector('#opTotal').textContent })`);
      console.log('list Opname:', JSON.stringify(opList));
      if (opList.rows.join(',') !== `IMP-SMK:7:${7 - whBefore > 0 ? '+' : '−'}${Math.abs(7 - whBefore)},BELUM-ADA:-2:−8`) throw new Error('list Stok Opname salah');
      await shot('05d-stok-opname');
      await run(`document.querySelector('#opSubmit').click()`);
      await wait(300);
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);
      await wait(700);
      const opDoc = await run(`({ first: document.querySelector('#opHistory tr').innerText.replace(/\\s+/g, ' '), left: document.querySelectorAll('#opItems tr[data-i]').length })`);
      console.log('riwayat Opname teratas:', JSON.stringify(opDoc));
      if (!/OP-\d{8}-001/.test(opDoc.first) || !/Gudang Utama/.test(opDoc.first) || opDoc.left !== 0) throw new Error('Stok Opname tidak tersimpan');
      if (svc.getProduct('IMP-SMK').warehouse_stock !== 7 || svc.getProduct('BELUM-ADA').warehouse_stock !== -2) throw new Error('stok Gudang Utama tidak sesuai hitungan fisik');
      // Import Excel 3 zona: Fisik Display Toko & Gudang BS terisi → dua dokumen OP
      const opImp = await run(`window.posBridge.call('opname:import', { notes: 'Import smoke', rows: [
        { Kode: 'IMP-SMK', 'Fisik Display Toko': 4, 'Fisik Gudang Utama': '', 'Fisik Gudang BS': 1 },
      ] }).then((r) => r.data.created.map((d) => d.zone + ':' + d.doc_no))`);
      console.log('import Opname:', JSON.stringify(opImp));
      const imp = svc.getProduct('IMP-SMK');
      if (opImp.length !== 2 || imp.floor_stock !== 4 || imp.warehouse_stock !== 7 || imp.damaged_stock !== 1) throw new Error('import opname 3 zona salah');
      // Tanggal_Stok: template diunduh (Gudang Utama 7), lalu diterima 3 lagi (→ 10); fisik 5 → selisih −2 → stok 8
      const tpl = svc.opnameSheet().find((r) => r[0] === 'IMP-SMK');
      svc.createReception({ reference_no: 'SJ-SETELAH-OPNAME', items: [{ sku: 'IMP-SMK', qty: 3, pack_type: 'Biji', destination: 'warehouse' }] });
      const opDated = await run(`window.posBridge.call('opname:import', { rows: [
        { Kode: 'IMP-SMK', 'Display Toko': ${tpl[2]}, 'Fisik Display Toko': '', 'Gudang Utama': ${tpl[4]}, 'Fisik Gudang Utama': 5, 'Gudang BS': ${tpl[6]}, 'Fisik Gudang BS': '', Tanggal_Stok: '${tpl[10]}' },
      ] }).then((r) => r.data.created[0])`);
      console.log('import Opname bertanggal:', JSON.stringify({ doc: opDated.doc_no, count_at: opDated.count_at, items: opDated.items }));
      if (svc.getProduct('IMP-SMK').warehouse_stock !== 8 || opDated.items[0].diff !== -2 || !opDated.count_at) throw new Error('selisih opname bertanggal tidak diterapkan ke stok sekarang');

      // Barang masuk → antrian label → cetak (PDF ukuran 106×20 mm)
      svc.importRows([{ Barcode: '4006381333931', SKU: 'BRS-001', Nama_Barang: 'Penebah Lidi @50 PCS Sima', Merk: 'Sima', Harga_Jual: 6000, Rasio_Isi_Dus: 50 }]);
      const rec = svc.createReception({ reference_no: 'SJ-SMOKE', supplier_name: 'PT Sima', items: [
        { sku: 'BRS-001', qty: 3, pack_type: 'Biji', destination: 'warehouse' },
        { sku: 'MNM-001', qty: 2, pack_type: 'Biji', destination: 'warehouse' },
      ] });
      await run(`views.barcode.openWith({ receptionId: ${rec.id} })`);
      await wait(1200);
      const lbFirst = await run(`document.activeElement.id`);
      if (lbFirst !== 'lbQty') throw new Error(`kursor awal Cetak Barcode seharusnya di Jumlah label (${lbFirst})`);
      // Kolom Jumlah label: Enter di scan kosong → Jumlah; isi 5, Enter → scan; scan Air Mineral → +5 label
      const lbFlow = await run(`(() => {
        const p = document.querySelector('#lbPicker'); const q = document.querySelector('#lbQty');
        p.focus(); p.value = ''; p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const toQty = document.activeElement.id;
        q.value = '5'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return toQty + '>' + document.activeElement.id; })()`);
      if (lbFlow !== 'lbQty>lbPicker') throw new Error(`Enter Jumlah ⇄ scan di Cetak Barcode salah (${lbFlow})`);
      await run(`(() => { const p = document.querySelector('#lbPicker'); p.value = '8991234567890'; p.dispatchEvent(new Event('input')); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await wait(800);
      const lbAfter = await run(`({ copies: [...document.querySelectorAll('#lbQueue tr, #lbBody tr')].map((r) => r.innerText.replace(/\\s+/g, ' ')).join(' | '), qty: document.querySelector('#lbQty').value, focus: document.activeElement.id })`);
      console.log('antrian label setelah scan ×5:', JSON.stringify(lbAfter));
      if (lbAfter.qty !== '1' || lbAfter.focus !== 'lbQty') throw new Error('Jumlah label tidak kembali ke 1 / kursor tidak kembali ke Jumlah label');
      await shot('05b-cetak-barcode');
      const queueText = await run(`document.querySelector('#lbTotal').textContent`);
      console.log('antrian label:', queueText);
      if (!/10 label/.test(queueText)) throw new Error(`total label seharusnya 5 (penerimaan) + 5 (manual) = 10: ${queueText}`);

      // Designer tersembunyi sampai tombol "Buka Designer Label" ditekan
      const dzHidden = await run(`document.querySelector('#lbDesigner').classList.contains('hidden')`);
      if (!dzHidden) throw new Error('Designer Label seharusnya tersembunyi saat layar dibuka');
      await run(`document.querySelector('#lbDesignerToggle').click()`);
      await wait(900);
      const dzOpen = await run(`({ open: !document.querySelector('#lbDesigner').classList.contains('hidden'), btn: document.querySelector('#lbDesignerToggle').textContent, boxes: document.querySelectorAll('#dzOverlay .dz-el').length })`);
      console.log('buka designer:', JSON.stringify(dzOpen));
      if (!dzOpen.open || !dzOpen.boxes) throw new Error('Designer Label tidak tampil setelah tombol ditekan');
      // Designer label: pilih Harga di kanvas → 14 pt, tarik sisi kiri 10 mm, tambah Kotak, simpan
      const dz = await run(`(() => {
        const boxes = [...document.querySelectorAll('#dzOverlay .dz-el')];
        const price = boxes.find((b) => b.querySelector('.tag').textContent === 'Harga');
        const r = price.getBoundingClientRect();
        const opt = (x, y) => ({ bubbles: true, pointerId: 1, clientX: x, clientY: y });
        price.dispatchEvent(new PointerEvent('pointerdown', opt(r.left + r.width / 2, r.top + r.height / 2)));
        document.querySelector('#dzOverlay').dispatchEvent(new PointerEvent('pointerup', opt(r.left + r.width / 2, r.top + r.height / 2)));
        const size = document.querySelector('#dzProps [data-p="size"]');
        size.value = '14'; size.dispatchEvent(new Event('input', { bubbles: true }));
        return { types: boxes.map((b) => b.querySelector('.tag').textContent), title: document.querySelector('#dzProps h3').textContent };
      })()`);
      console.log('designer:', JSON.stringify(dz));
      if (dz.title !== 'Harga') throw new Error('elemen Harga tidak terpilih di kanvas');
      await wait(700);
      const big = await run(`({ canvas: document.querySelector('#dzRender').innerHTML.includes('font-size:14pt'), row: document.querySelector('#lbPreviewPaper').innerHTML.includes('font-size:14pt') })`);
      if (!big.canvas || !big.row) throw new Error(`ukuran harga 14 pt tidak tampil di kanvas/pratinjau: ${JSON.stringify(big)}`);
      const dragged = await run(`(() => {
        const S = views.barcode.designerScale;
        const h = document.querySelector('#dzOverlay .dz-el.sel .dz-h[data-h="w"]');
        const r = h.getBoundingClientRect();
        const x0 = r.left + 4; const y0 = r.top + 4;
        const ov = document.querySelector('#dzOverlay');
        const opt = (x, y) => ({ bubbles: true, pointerId: 1, clientX: x, clientY: y });
        h.dispatchEvent(new PointerEvent('pointerdown', opt(x0, y0)));
        ov.dispatchEvent(new PointerEvent('pointermove', opt(x0 + 10 * S, y0)));
        ov.dispatchEvent(new PointerEvent('pointerup', opt(x0 + 10 * S, y0)));
        return { x: document.querySelector('#dzProps [data-p="x"]').value, w: document.querySelector('#dzProps [data-p="w"]').value };
      })()`);
      console.log('setelah tarik sisi kiri 10 mm:', JSON.stringify(dragged));
      if (Number(dragged.x) !== 10) throw new Error('drag di designer tidak menggeser sisi kiri 10 mm');
      await run(`document.querySelector('#dzAdd [data-add="box"]').click()`);
      await wait(700);
      await run(`document.querySelector('#lbDesigner').scrollIntoView()`);
      await shot('05c-designer-label');
      await run(`document.querySelector('#lbSave').click()`);
      await wait(900);
      const saved = svc.listLabelDesigns().find((x) => x.is_default).config.elements;
      const savedPrice = saved.find((e) => e.type === 'price');
      console.log('desain tersimpan:', saved.map((e) => e.type).join(','), '· harga', savedPrice.size, 'pt di x', savedPrice.x);
      if (savedPrice.size !== 14 || savedPrice.x !== 10 || !saved.some((e) => e.type === 'box')) throw new Error('desain dari designer tidak tersimpan');
      await run(`document.querySelector('#lbPrint').click()`);
      await wait(2500);
      const labelPdf = fs.readdirSync(out).find((f) => f.startsWith('Label_'));
      if (!labelPdf) throw new Error('PDF label tidak terbentuk');
      console.log('pdf label:', labelPdf);
      await run(`document.querySelector('[data-view=products]').click()`);
      await shot('06-daftar-barang');
      await run(`document.querySelector('[data-view=shift]').click()`);
      await wait(400);
      await shot('07-shift');
      await run(`document.querySelector('[data-view=settings]').click()`);
      await wait(600);
      await run(`document.querySelector('#stPreview').scrollIntoView()`);
      await shot('08-pengaturan');
      const printers = await run(`window.posBridge.call('printer:list')`);
      console.log('printer terdeteksi:', JSON.stringify(printers.data && printers.data.map((p) => p.name)));
      if (!fs.existsSync(path.join(out, 'INV-' + require('../src/services').localNow().slice(0, 10).replace(/-/g, '') + '-0001.pdf'))) throw new Error('nota otomatis tidak tercetak');

      // Tutup shift saat mother base belum diatur: shift TETAP ditutup, file laporan dibuat di komputer ini,
      // penjualan masuk Riwayat Shift dan antrean mother base (dikirim otomatis setelah diatur / internet tersambung)
      const salesBefore = svc.shiftSalesRows().length;
      const res = await run(`window.posBridge.call('shift:close', {})`);
      console.log('tutup shift (mother base belum diatur):', JSON.stringify(res));
      // Rekap tutup shift tercetak otomatis di printer nota (uji: PDF di folder output)
      const recapPdf = fs.readdirSync(out).filter((f) => /^Rekap_Shift_\d+\.pdf$/.test(f));
      console.log('rekap shift tercetak:', recapPdf.join(', '), '·', JSON.stringify(res.data.recap));
      if (!recapPdf.length || !res.data.recap || res.data.recap.cashier !== 'Pemilik' || res.data.recap_print_error) throw new Error('rekap tutup shift tidak tercetak');
      const dirs = fs.readdirSync(process.env.POS_REPORTS_DIR).filter((d) => d !== LEGACY_REPORT);
      const files = fs.readdirSync(path.join(process.env.POS_REPORTS_DIR, dirs[0]));
      console.log('file laporan:', files.join(', '));
      if (!res.ok || 'emailed' in res.data || svc.getShift() || svc.shiftSalesRows().length) throw new Error('shift seharusnya tetap ditutup walau mother base belum diatur');
      // Laporan disimpan terenkripsi: nama .enc, isinya bukan PDF / CSV yang terbaca
      if (!files.some((f) => /^Rekap_Shift_.*\.pdf\.enc$/.test(f)) || files.filter((f) => f.endsWith('.csv.enc')).length !== 2 || files.some((f) => !f.endsWith('.enc'))) {
        throw new Error('file laporan tidak terenkripsi / tidak lengkap');
      }
      for (const f of files) {
        const head = fs.readFileSync(path.join(process.env.POS_REPORTS_DIR, dirs[0], f)).toString('latin1');
        if (!head.startsWith('POSTZ-LAP1') || /%PDF|No_Struk|Nama_Barang/.test(head)) throw new Error(`isi ${f} masih bisa dibaca`);
      }
      if (fs.existsSync(path.join(process.env.POS_REPORTS_DIR, OLD_REPORT))) throw new Error('laporan lebih dari 7 hari seharusnya terhapus otomatis');
      const legacy = fs.readdirSync(path.join(process.env.POS_REPORTS_DIR, LEGACY_REPORT));
      console.log('laporan lama setelah aplikasi dibuka:', legacy.join(', '));
      if (legacy.length !== 2 || legacy.some((f) => !f.endsWith('.enc'))) throw new Error('laporan lama belum dienkripsi saat aplikasi dibuka');
      // Admin membuka laporan lewat Pengaturan: didekripsi ke folder sementara
      const repList = await run(`window.posBridge.call('reports:list')`);
      if (!repList.ok || repList.data.length !== 2 || repList.data[0].folder !== dirs[0] || repList.data[0].files.length !== 3) throw new Error(`daftar laporan salah: ${JSON.stringify(repList)}`);
      const openRep = (file) => run(`window.posBridge.call('reports:open', ${JSON.stringify({ folder: dirs[0], file })})`);
      const openedPdf = await openRep(files.find((f) => f.endsWith('.pdf.enc')));
      const openedCsv = await openRep(files.find((f) => f.startsWith('Penjualan_')));
      if (!openedPdf.ok || fs.readFileSync(openedPdf.data.path).subarray(0, 5).toString() !== '%PDF-') throw new Error(`Rekap PDF tidak bisa dibuka Admin: ${JSON.stringify(openedPdf)}`);
      if (!openedCsv.ok || !fs.readFileSync(openedCsv.data.path, 'utf8').includes('No_Struk')) throw new Error('CSV penjualan tidak bisa dibuka Admin');
      fs.copyFileSync(openedPdf.data.path, path.join(out, 'rekap.pdf'));
      const badOpen = await Promise.all([
        run(`window.posBridge.call('reports:open', { folder: '..', file: 'pos.db.enc' })`),
        run(`window.posBridge.call('reports:open', ${JSON.stringify({ folder: dirs[0], file: '..\\..\\pos.db.enc' })})`),
        run(`window.posBridge.call('reports:open', ${JSON.stringify({ folder: dirs[0], file: files[0].replace(/\.enc$/, '') })})`),
      ]);
      if (badOpen.some((r) => r.ok)) throw new Error('nama laporan yang aneh seharusnya ditolak');
      await run(`document.querySelector('[data-view=settings]').click()`);
      await wait(600);
      await run(`document.querySelector('#stOpenReports').scrollIntoView(); document.querySelector('#stOpenReports').click()`);
      await wait(700);
      const repModal = await run(`document.querySelector('#modalRoot').innerText`);
      if (!/Laporan Tutup Shift/.test(repModal) || !/Rekap PDF/.test(repModal) || !/Stok CSV/.test(repModal)) throw new Error('modal Lihat Laporan tidak sesuai');
      await shot('08b-lihat-laporan-terenkripsi');
      await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
      await wait(300);
      const outbox = svc.mbStatus();
      const hist = svc.listShiftHistory();
      console.log('antrean mother base:', outbox.pending_shifts, '· baris riwayat:', salesBefore);
      if (outbox.pending_shifts !== 1 || hist[0].mb_terkirim !== 0) throw new Error('antrean mother base tidak tercatat');
      if ('motherbase' in res.data) throw new Error('status mother base seharusnya tidak dikirim ke layar');
      if (hist[0].cashier_name !== 'Pemilik') throw new Error('nama kasir shift tidak diambil dari akun login');
      await wait(800);
      await shot('09-shift-ditutup-mother-base-menunggu');
      // Lokasi file laporan tidak boleh tampil di layar tutup shift; hanya Admin yang bisa melihatnya di Pengaturan
      const doneText = await run(`document.querySelector('#modalRoot').innerText`);
      if ('dir' in res.data || doneText.includes(dirs[0]) || /Buka Folder|tersimpan di/.test(doneText)) throw new Error('lokasi file laporan masih tampil setelah tutup shift');
      const adminDir = await run(`window.posBridge.call('app:reportsDir')`);
      const pubInfo = await run(`window.posBridge.call('app:info')`);
      if (!adminDir.ok || adminDir.data !== process.env.POS_REPORTS_DIR || 'reportsDir' in pubInfo.data) throw new Error('lokasi laporan untuk Admin salah / bocor lewat app:info');
      await run(`document.querySelector('#modalRoot .modal-foot .btn.primary') && document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
      await wait(600);
      await run(`document.querySelector('[data-view=shift]').click()`);
      await wait(800);
      // Laporan Shift tidak menyebut mother base / cadangan dan tidak ada kartu kiriman
      const shiftPage = await run(`document.querySelector('#view-shift').innerText`);
      if (/mother base|cadangan|4 hari/i.test(shiftPage) || await run(`!!document.querySelector('#shMbCard')`)) throw new Error('halaman Laporan Shift masih menyebut mother base / cadangan');
      await shot('09b-laporan-shift-netral');
      const hidden = await run(`Promise.all(['shift:history', 'shift:sendMotherbase'].map((c) => window.posBridge.call(c).then((r) => r.ok)))`);
      if (hidden.some(Boolean)) throw new Error('perintah riwayat / kirim mother base seharusnya sudah dihapus');
      const gone = await run(`window.posBridge.call('shift:resendReport', { shift_uid: 'x' })`);
      if (gone.ok) throw new Error('kirim ulang email seharusnya sudah dihapus');
      const opened = await run(`window.posBridge.call('shift:open', {})`);
      if (!opened.ok) throw new Error(`buka shift lagi gagal: ${JSON.stringify(opened)}`);
      await run('refreshShift()');
      await wait(300);

      const p = svc.getProduct('MNM-001');
      console.log('stok MNM-001 setelah jual 12 & mutasi 1 ke BS:', p.floor_stock, p.warehouse_stock, p.damaged_stock);
      console.log('ringkasan shift:', JSON.stringify(svc.shiftSummary().totals));

      // Draft penjualan: tahan pelanggan A, layani pelanggan B, lanjutkan A lalu bayar
      const receiptsBefore = svc.shiftSummary().totals.receipts;
      const sabunBefore = svc.getProduct('SBN-005').floor_stock;
      await run(`go('checkout')`);
      await wait(500);
      await scan('8990001112223', 3); // Sabun Mandi × 3 (pelanggan A)
      await run(`document.querySelector('#draftHoldBtn').click()`);
      await wait(300);
      await run(`document.querySelector('#drLabel').value = 'Bu Ani'; document.querySelector('#modalRoot .modal-foot .btn.primary').click();`);
      await wait(800);
      const afterHold = await run(`({ rows: document.querySelectorAll('#cartBody tr').length, btn: document.querySelector('#draftListBtn').innerText, focus: document.activeElement.id })`);
      console.log('setelah tahan draft:', JSON.stringify(afterHold));
      if (afterHold.rows !== 0 || !/1/.test(afterHold.btn)) throw new Error('keranjang tidak ditahan sebagai draft');
      if (svc.getProduct('SBN-005').floor_stock !== sabunBefore) throw new Error('draft tidak boleh mengurangi stok');
      const payCash = async () => {
        await run(`document.querySelector('#quickCash [data-v]').click()`);
        await run(`document.querySelector('#payBtn').click()`);
        await wait(900);
        await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
        await wait(300);
      };
      await scan('8991234567890'); // pelanggan B
      await payCash();
      await run(`document.querySelector('#draftListBtn').click()`);
      await wait(600);
      await shot('12-daftar-draft');
      await run(`document.querySelector('#modalRoot [data-resume]').click()`);
      await wait(1200);
      const resumed = await run(`[...document.querySelectorAll('#cartBody tr')].map((r) => r.dataset.sku + ':' + r.querySelector('[data-act=qty]').value).join(',')`);
      console.log('draft dilanjutkan:', resumed);
      if (resumed !== 'SBN-005:3') throw new Error('isi draft tidak kembali ke keranjang');
      await payCash();
      const draftsLeft = await run(`window.posBridge.call('drafts:list').then((r) => r.data.length)`);
      if (draftsLeft !== 0 || svc.shiftSummary().totals.receipts !== receiptsBefore + 2 || svc.getProduct('SBN-005').floor_stock !== sabunBefore - 3) {
        throw new Error('alur draft → bayar tidak sesuai');
      }

      // Tutup shift dengan mother base (tiruan lokal): data langsung dikirim, ditunggu, dan layar menyatakan terkirim
      const received = [];
      let fakeProduk = []; // master barang yang dikirim mother base tiruan
      const fakeMb = require('http').createServer((req, resp) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const p = JSON.parse(body || '{}').p || {};
          if (req.url.endsWith('/rpc/terima_data')) received.push(...(p.shifts || []).map((s) => s.shift.shift_uid));
          const reply = req.url.endsWith('/rpc/terima_data')
            ? { ok: true, kode_toko: p.kode_toko, shift_diterima: (p.shifts || []).map((s) => s.shift.shift_uid), dokumen: {} }
            : { ok: true, kode_toko: p.kode_toko, produk: p.sejak && p.sejak.startsWith('2999') ? [] : fakeProduk, server_at: new Date().toISOString() };
          resp.writeHead(200, { 'Content-Type': 'application/json' });
          resp.end(JSON.stringify(reply));
        });
      });
      await new Promise((r) => fakeMb.listen(0, '127.0.0.1', r));
      svc.mbSaveConfig({ url: `http://127.0.0.1:${fakeMb.address().port}`, anon_key: 'eyJuji.uji.uji', kode_toko: 'UJI', kunci: 'kunci-toko-uji' });
      const closingUid = svc.getShift().shift_uid;
      await run(`go('shift')`);
      await wait(800);
      if (await run(`document.querySelector('#shClose').innerText`) !== 'Tutup Shift') throw new Error('tombol tutup shift masih menyebut mother base');
      await run(`document.querySelector('#shClose').click()`);
      await wait(400);
      const confirmText = await run(`document.querySelector('#modalRoot').innerText`);
      if (/mother base|cadangan|4 hari/i.test(confirmText)) throw new Error(`konfirmasi tutup shift masih menyebut mother base / cadangan: ${confirmText}`);
      await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`); // konfirmasi Tutup Shift
      await wait(4000);
      // Data tetap langsung terkirim & dikonfirmasi, tetapi layar tidak menyebutnya
      const doneShown = await run(`document.querySelector('#modalRoot').innerText`);
      console.log('tutup shift (layar):', doneShown.replace(/\s+/g, ' '), '· diterima mother base:', received.length, 'shift');
      if (!/Shift Berhasil Ditutup/.test(doneShown) || !/Cetak Ulang Rekap/.test(doneShown) || /mother base|cadangan|4 hari/i.test(doneShown)) throw new Error('layar hasil tutup shift tidak netral');
      if (svc.mbStatus().pending_shifts !== 0 || !received.includes(closingUid) || svc.listShiftHistory().some((h) => !h.mb_terkirim)) {
        throw new Error('tutup shift tidak langsung mengirim ke mother base');
      }
      await shot('09c-tutup-shift-netral');
      await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
      await wait(1000);
      // Perbarui Daftar Barang: barang baru dari kantor langsung masuk, pesannya tidak menyebut mother base
      fakeProduk = [{ sku: 'MB-001', barcode: '2000000000017', name: 'Barang Dari Kantor', brand: 'Pusat', category: 'Kantor', unit_price: 9900, pack_unit: 'Dus', pack_ratio: 12, aktif: true }];
      await run(`go('products')`);
      await wait(800);
      await run(`document.querySelector('#pdPull').click()`);
      await wait(2500);
      const pullToast = await run(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText).join(' | ')`);
      if (!/Daftar barang diperbarui/.test(pullToast) || /mother base/i.test(pullToast)) throw new Error(`pesan Perbarui Daftar Barang tidak netral: ${pullToast}`);
      const pulled = svc.getProduct('MB-001');
      const pdText = await run(`document.querySelector('#pdBody').innerText`);
      console.log('ambil master barang (Daftar Barang):', pulled && pulled.name, pulled && pulled.unit_price, '· tampil di tabel:', /Barang Dari Kantor/.test(pdText));
      if (!pulled || pulled.unit_price !== 9900 || !/Barang Dari Kantor/.test(pdText)) throw new Error('Ambil Master Barang di Daftar Barang tidak memasukkan barang baru');
      await shot('09e-ambil-master-barang');
      // Buka shift (daftar barang dikunci): harga terbaru dari kantor diambil otomatis di latar
      svc.mbSaveConfig({ kunci_master: true });
      fakeProduk = [{ ...fakeProduk[0], unit_price: 12500 }];
      await run(`window.posBridge.call('shift:open', {})`);
      for (let i = 0; i < 20 && svc.getProduct('MB-001').unit_price !== 12500; i++) await wait(250);
      console.log('buka shift → harga dari kantor:', svc.getProduct('MB-001').unit_price);
      if (svc.getProduct('MB-001').unit_price !== 12500) throw new Error('buka shift tidak mengambil daftar barang terbaru');
      svc.mbSaveConfig({ kunci_master: false });
      fakeMb.close();
      svc.mbSaveConfig({ url: '' });
      await run('refreshShift()');
      await wait(300);

      // Tema Terang: tombol di sidebar, disimpan di komputer ini, lalu kembali ke Gelap
      await run(`document.querySelector('#themeSeg [data-theme=light]').click()`);
      const lightState = await run(`({ theme: document.documentElement.dataset.theme, saved: localStorage.getItem('pos-theme'), bg: getComputedStyle(document.body).backgroundColor })`);
      console.log('tema terang:', JSON.stringify(lightState));
      if (lightState.theme !== 'light' || lightState.saved !== 'light' || lightState.bg !== 'rgb(243, 245, 249)') throw new Error('tema terang tidak diterapkan');
      for (const [view, name] of [['checkout', '13a-terang-kasir'], ['transfers', '13b-terang-mutasi'], ['products', '13c-terang-daftar-barang']]) {
        await run(`go('${view}')`);
        await shot(name);
      }
      await run(`document.querySelector('#themeSeg [data-theme=dark]').click()`);
      if ((await run(`document.documentElement.dataset.theme + ':' + localStorage.getItem('pos-theme')`)) !== 'dark:dark') throw new Error('tema gelap tidak kembali');

      // Akun Gudang & Kasir: menu dibatasi sesuai peran
      svc.saveUser({ name: 'Budi', role: 'gudang', pin: '333333' });
      svc.saveUser({ name: 'Rina', role: 'kasir', pin: '222222' });
      await run(`document.querySelector('[data-view=settings]').click()`);
      await wait(800);
      await shot('10-pengaturan-pengguna');
      // PIN Pembatalan untuk kepala toko: diisi Admin di Pengaturan, bisa ditampilkan lagi
      await run(`(() => { document.querySelector('#vpCard').scrollIntoView(); document.querySelector('#vpHolder').value = 'Kepala Toko'; document.querySelector('#vpPin').value = '765432'; document.querySelector('#vpPin2').value = '765432'; document.querySelector('#vpSave').click(); })()`);
      await wait(800);
      await run(`document.querySelector('#vpReveal').click()`);
      await wait(600);
      const vp = await run(`({ shown: document.querySelector('#vpShown').textContent, status: document.querySelector('#vpStatus').textContent, badge: document.querySelector('#vpBadge').textContent })`);
      console.log('PIN Pembatalan:', JSON.stringify(vp));
      if (vp.shown !== '765432' || !/Kepala Toko/.test(vp.status) || vp.badge !== 'Aktif') throw new Error('PIN Pembatalan tidak tersimpan / tidak bisa ditampilkan');
      await shot('10c-pin-pembatalan');
      await run(`document.querySelector('#vpReveal').click()`);
      // Kartu Mother Base: belum diatur → isi lewat layar → tersimpan (kunci tidak tampil); kirim gagal tanpa server
      const mb0 = await run(`({ badge: document.querySelector('#mbBadge').textContent, pending: document.querySelector('#mbPending').innerText })`);
      console.log('kartu mother base:', JSON.stringify(mb0));
      if (mb0.badge !== 'Belum diatur' || !/0 shift/.test(mb0.pending)) throw new Error('kartu Mother Base tidak menampilkan status');
      await run(`document.querySelector('#mbUrl').value = 'http://127.0.0.1:9'; document.querySelector('#mbKode').value = 'krp';
        document.querySelector('#mbAnon').value = 'anon-uji'; document.querySelector('#mbKunci').value = 'kunci-uji'; document.querySelector('#mbSave').click();`);
      await wait(800);
      const cfg = svc.mbStatus();
      if (!cfg.ready || cfg.kode_toko !== 'KRP' || JSON.stringify(cfg).includes('kunci-uji')) throw new Error(`pengaturan mother base tidak tersimpan: ${JSON.stringify(cfg)}`);
      const sent = await run(`window.posBridge.call('mb:sendNow')`);
      console.log('kirim tanpa server:', JSON.stringify(sent.error));
      if (sent.ok || !/terhubung|habis waktu/.test(sent.error) || svc.mbStatus().pending_shifts !== 0) throw new Error('kirim tanpa server seharusnya gagal dan data tetap menunggu');
      await run(`document.querySelector('[data-view=settings]').click()`);
      await wait(800);
      await run(`document.querySelector('#mbCard').scrollIntoView()`);
      await shot('10b-pengaturan-mother-base');
      const navOf = () => run(`[...document.querySelectorAll('.nav-btn')].filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.view).join(',')`);
      for (const [name, pin, want] of [['Rina', '222222', 'checkout,orders,products,shift'], ['Budi', '333333', 'orders,transfers,receiving,opname,products,barcode']]) {
        await run(`document.querySelector('#logoutBtn').click()`);
        await wait(1500);
        await run(`document.querySelector('#lgPin').value='999999'; document.querySelector('#lgName').value=${JSON.stringify(name)}; document.querySelector('#lgBtn').click();`);
        await wait(1500);
        const errText = await run(`document.querySelector('#lgErr').innerText`);
        if (!/PIN salah/.test(errText)) throw new Error('PIN salah tidak ditolak');
        await login(name, pin);
        const nav = await navOf();
        console.log(`menu ${name}:`, nav);
        if (nav !== want) throw new Error(`menu ${name} seharusnya ${want}`);
        const denied = await run(`window.posBridge.call('settings:save', { store_name: 'X' })`);
        if (denied.ok || !/Akses ditolak/.test(denied.error)) throw new Error('pengaturan tidak terlindungi');
        // Lokasi file laporan hanya untuk Admin; membuka folder sembarang sudah tidak bisa
        const repDir = await run(`window.posBridge.call('app:reportsDir')`);
        const openPath = await run(`window.posBridge.call('app:openPath', { dir: '.' })`);
        if (repDir.ok || openPath.ok) throw new Error(`lokasi laporan bisa dilihat / dibuka oleh ${name}`);
        const repL = await run(`window.posBridge.call('reports:list')`);
        const repO = await run(`window.posBridge.call('reports:open', { folder: 'Shift_x', file: 'a.enc' })`);
        if (repL.ok || repO.ok || !/Akses ditolak/.test(repL.error) || !/Akses ditolak/.test(repO.error)) throw new Error(`laporan bisa dibuka oleh ${name}`);
        // Buka laci: Kasir & Admin saja
        const drw = await run(`window.posBridge.call('drawer:open')`);
        if ((name === 'Budi') !== (!drw.ok && /Akses ditolak/.test(drw.error))) throw new Error(`akses buka laci untuk ${name} salah: ${JSON.stringify(drw)}`);
        // Pesanan: semua peran boleh melihat; membuat / mengambil / membatalkan hanya Kasir & Admin
        const orList = await run(`window.posBridge.call('orders:list', {})`);
        const orMake = await run(`window.posBridge.call('orders:create', { items: [{ sku: 'MNM-001', qty: 1 }], customer_name: 'X', pickup_date: '2099-01-01' })`);
        if (!orList.ok || (name === 'Budi') !== (!orMake.ok && /Akses ditolak/.test(orMake.error))) throw new Error(`akses Pesanan untuk ${name} salah: ${JSON.stringify(orMake)}`);
        if (orMake.ok) svc.cancelOrder({ order_no: orMake.data.order_no, reason: 'uji akses', deposit_action: null, approver_pin: '111111' });
        if (name === 'Budi') {
          // Gudang: stok opname hanya lewat Excel — form manual tersembunyi & ditolak, import tetap bisa
          await run(`go('opname')`);
          await wait(600);
          const opUi = await run(`({ form: document.querySelector('#opFormCard').offsetParent !== null, note: document.querySelector('#opGudangNote').offsetParent !== null, imp: document.querySelector('#opImport').offsetParent !== null, tpl: document.querySelector('#opTemplate').offsetParent !== null })`);
          const opManual = await run(`window.posBridge.call('opname:create', { zone: 'warehouse', items: [{ sku: 'IMP-SMK', counted: 1 }] })`);
          const whBefore = svc.getProduct('IMP-SMK').warehouse_stock;
          const opExcel = await run(`window.posBridge.call('opname:import', { notes: 'Opname gudang', rows: [{ Kode: 'IMP-SMK', 'Fisik Gudang Utama': ${whBefore + 1} }] })`);
          console.log('opname akun Gudang:', JSON.stringify({ ...opUi, manual: opManual.error, excel: opExcel.ok }));
          if (opUi.form || !opUi.note || !opUi.imp || !opUi.tpl || opManual.ok || !/Akses ditolak/.test(opManual.error) || !opExcel.ok || svc.getProduct('IMP-SMK').warehouse_stock !== whBefore + 1) {
            throw new Error('akses stok opname Gudang tidak sesuai (seharusnya hanya lewat Excel)');
          }
          await shot('11c-opname-gudang-excel');
          // Gudang juga bisa memilih PDF hasil "Save as PDF" Excel dari template opname
          process.env.POS_OPEN_FILE = path.join(__dirname, 'fixtures', 'opname-excel.pdf');
          const opPdf = await run(`window.posBridge.call('opname:importFile')`);
          process.env.POS_OPEN_FILE = path.join(__dirname, 'fixtures', 'tidak-ada.txt.pdf');
          const opPdfBad = await run(`window.posBridge.call('opname:importFile')`);
          delete process.env.POS_OPEN_FILE;
          console.log('opname PDF (Gudang):', JSON.stringify(opPdf.ok ? [opPdf.data.file, opPdf.data.rows.length, opPdf.data.rows[1]] : opPdf.error), '· PDF rusak:', opPdfBad.error);
          if (!opPdf.ok || opPdf.data.rows.length !== 74 || opPdf.data.rows[1].Kode !== 'SNK-010' || opPdf.data.rows[1]['Fisik Gudang Utama'] !== '75' || opPdfBad.ok) {
            throw new Error('import opname PDF tidak terbaca');
          }
        }
        const vpSeen = await run(`window.posBridge.call('settings:voidPin', { reveal: true })`);
        if (vpSeen.ok || !/Akses ditolak/.test(vpSeen.error)) throw new Error(`PIN Pembatalan bisa dilihat oleh ${name}`);
        // Perbarui Daftar Barang boleh untuk semua peran (mother base sengaja tidak terjangkau → pesan netral, bukan Akses ditolak)
        const pull = await run(`window.posBridge.call('products:pullMaster')`);
        if (pull.ok || /Akses ditolak|mother base/i.test(pull.error) || !/belum bisa diperbarui/.test(pull.error)) throw new Error(`Ambil Master Barang untuk ${name} salah: ${JSON.stringify(pull)}`);
        await run(`go('products')`);
        await wait(800);
        const pullShown = await run(`(() => { const b = document.querySelector('#pdPull'); return !!b && b.offsetParent !== null; })()`);
        if (!pullShown) throw new Error(`tombol Perbarui Daftar Barang tidak terlihat oleh ${name}`);
        if (/mother base/i.test(await run(`document.querySelector('#view-products').innerText`))) throw new Error(`Daftar Barang menyebut mother base untuk ${name}`);
        const edits = await run(`document.querySelectorAll('#pdBody [data-edit]').length`);
        // Tambah Barang & Unduh Template hanya Admin; Import untuk Gudang
        const pdBtns = await run(`['#pdAdd', '#pdTemplate', '#pdImport'].map((s) => document.querySelector(s).classList.contains('hidden') ? 0 : 1).join('')`);
        const addNew = await run(`window.posBridge.call('products:save', { isNew: true, product: { sku: 'X-BARU', barcode: '1234', name: 'Baru', unit_price: 1000 } })`);
        const editOld = await run(`window.posBridge.call('products:save', { product: { sku: 'MNM-001', name: 'Ubah' } })`);
        const delOld = await run(`window.posBridge.call('products:delete', { sku: 'MNM-001' })`);
        if (editOld.ok || !/Akses ditolak/.test(editOld.error) || delOld.ok || !/Akses ditolak/.test(delOld.error)) throw new Error(`ubah / hapus barang untuk ${name} seharusnya ditolak`);
        const tpl = await run(`window.posBridge.call('products:template')`);
        if (pdBtns !== (name === 'Budi' ? '001' : '000') || addNew.ok || !/Akses ditolak/.test(addNew.error) || tpl.ok || !/Akses ditolak/.test(tpl.error)) throw new Error(`tambah barang / template untuk ${name} salah: ${pdBtns} ${addNew.error} ${tpl.error}`);
        if (edits !== 0) throw new Error(`tombol Ubah barang seharusnya tidak tampil untuk ${name}`);
        await shot(`11-login-${name.toLowerCase()}`);
        if (name === 'Rina') {
          // Batal nota: kasir meminta, Admin menyetujui dengan PIN; nota asli tidak hilang
          const sale = svc.checkout({ items: [{ sku: 'MNM-001', qty: 2 }], payment_method: 'Tunai', cash_received: 10000 });
          const floorBefore = svc.getProduct('MNM-001').floor_stock;
          await run(`go('shift')`);
          await wait(900);
          await run(`[...document.querySelectorAll('#shReceipts [data-r]')].find((b) => b.dataset.r === ${JSON.stringify(sale.receipt_no)}).click()`);
          await wait(600);
          await run(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].find((b) => b.textContent === 'Batalkan Nota').click()`);
          await wait(500);
          // PIN kasir sendiri ditolak
          await run(`(() => { document.querySelector('#vdReason').value = 'Salah input barang'; document.querySelector('#vdPin').value = '222222'; document.querySelector('#modalRoot .modal-foot .btn.danger').click(); })()`);
          await wait(1600);
          const wrongPin = await run(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText).join(' | ')`);
          if (!/PIN Admin \/ PIN Pembatalan salah/.test(wrongPin) || svc.shiftSummary().voids.count !== 0) throw new Error(`PIN kasir seharusnya tidak bisa menyetujui pembatalan: ${wrongPin}`);
          await shot('11a-batal-nota-pin-admin');
          // Disetujui kepala toko dengan PIN Pembatalan (tanpa mengetahui PIN Admin)
          await run(`(() => { document.querySelector('#vdPin').value = '765432'; document.querySelector('#modalRoot .modal-foot .btn.danger').click(); })()`);
          await wait(1500);
          const vsum = svc.shiftSummary();
          const listText = await run(`document.querySelector('#shReceipts').innerText`);
          console.log('batal nota:', JSON.stringify(vsum.voids.list.map((v) => [v.void_no, v.receipt_no, v.requested_by, v.approved_by, v.total])));
          if (vsum.voids.count !== 1 || vsum.voids.list[0].receipt_no !== sale.receipt_no || vsum.voids.list[0].requested_by !== 'Rina'
            || vsum.voids.list[0].approved_by !== 'Kepala Toko (PIN Pembatalan)' || svc.getProduct('MNM-001').floor_stock !== floorBefore + 2
            || svc.receiptDetail({ receipt_no: sale.receipt_no }).length !== 1 || !/Dibatalkan/.test(listText) || !/Pembatalan/.test(listText)) {
            throw new Error('batal nota tidak tercatat dengan benar');
          }
          await shot('11b-nota-dibatalkan');

          // Pesanan: keranjang → Jadikan Pesanan (stok BELUM dipotong, bukti tercetak) → menu Pesanan → Ambil dari Gudang Utama → nota
          const today = require('../src/services').localNow().slice(0, 10);
          const st0 = { fl: svc.getProduct('SNK-010').floor_stock, wh: svc.getProduct('SNK-010').warehouse_stock };
          await run(`go('checkout')`);
          await wait(800);
          await scan('8997654321098', 3);
          if (await run(`document.querySelector('#orderBtn').disabled`)) throw new Error('tombol Jadikan Pesanan tidak aktif');
          await run(`document.querySelector('#orderBtn').click()`);
          await wait(500);
          await run(`(() => { const m = document.querySelector('#modalRoot');
            m.querySelector('#odName').value = 'Bu Ani'; m.querySelector('#odPhone').value = '0812-1111';
            [...m.querySelectorAll('#odQuick [data-v]')].find((b) => b.textContent === '50%').click();
            m.querySelector('#odNotes').value = 'Rasa balado'; })()`);
          const odForm = await run(`({ date: document.querySelector('#odDate').value, rest: document.querySelector('#odRest').innerText })`);
          await shot('13a-jadikan-pesanan');
          await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
          await wait(1500);
          const ordTitle = await run(`(document.querySelector('#modalRoot .modal-head') || {}).innerText || ''`);
          const ord = svc.listOrders().find((o) => o.customer_name === 'Bu Ani');
          console.log('pesanan:', ordTitle, JSON.stringify(odForm), JSON.stringify(ord && [ord.order_no, ord.total, ord.deposit, ord.pickup_date, ord.notes]));
          if (!/Pesanan Tersimpan/.test(ordTitle) || !ord || ord.total !== 34500 || ord.deposit !== 18000 || ord.pickup_date <= today || ord.notes !== 'Rasa balado'
            || !/16\.500/.test(odForm.rest) || svc.getProduct('SNK-010').floor_stock !== st0.fl || svc.getProduct('SNK-010').warehouse_stock !== st0.wh) {
            throw new Error('pesanan tidak tersimpan dengan benar / stok ikut terpotong');
          }
          if (!fs.existsSync(path.join(out, `${ord.order_no}.pdf`))) throw new Error('bukti pesanan tidak tercetak');
          if (await run(`document.querySelectorAll('#cartBody tr').length`)) throw new Error('keranjang tidak dikosongkan setelah pesanan');
          await shot('13b-pesanan-tersimpan');
          await run(`document.querySelector('#modalRoot .btn.primary').click()`);
          // Pesanan lain jatuh tempo hari ini → angka di menu Pesanan
          const ord2 = svc.createOrder({ items: [{ sku: 'MNM-001', qty: 6 }], customer_name: 'Pak Joko', customer_phone: '0899', pickup_date: today, deposit: 10000, created_by: 'Rina' });
          await run(`go('orders')`);
          await wait(1000);
          const orText = await run(`document.querySelector('#orBody').innerText`);
          const badge = await run(`(document.querySelector('#nav [data-view="orders"] .nav-badge') || {}).textContent || ''`);
          if (!orText.includes(ord.order_no) || !orText.includes(ord2.order_no) || !/Hari ini/.test(orText) || badge !== '1') throw new Error(`menu Pesanan tidak sesuai (badge ${badge})`);
          await shot('13c-menu-pesanan');
          await run(`document.querySelector('#orBody tr[data-no="${ord.order_no}"] [data-act=take]').click()`);
          await wait(1200);
          await run(`(() => { const m = document.querySelector('#modalRoot'); const z = m.querySelector('#tkZone'); z.value = 'warehouse'; z.dispatchEvent(new Event('change'));
            m.querySelector('#tkQuick [data-v]').click(); })()`);
          await shot('13d-ambil-pesanan');
          await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
          await wait(1500);
          const takeTitle = await run(`(document.querySelector('#modalRoot .modal-head') || {}).innerText || ''`);
          const done = svc.getOrder({ order_no: ord.order_no });
          console.log('ambil pesanan:', takeTitle, JSON.stringify([done.status, done.pickup_zone, done.receipt_no]));
          if (!/Pesanan Diambil/.test(takeTitle) || done.status !== 'diambil' || done.pickup_zone !== 'warehouse'
            || svc.getProduct('SNK-010').warehouse_stock !== st0.wh - 3 || svc.getProduct('SNK-010').floor_stock !== st0.fl) {
            throw new Error('pengambilan pesanan dari Gudang Utama tidak sesuai');
          }
          if (!fs.existsSync(path.join(out, `${done.receipt_no}.pdf`))) throw new Error('nota pengambilan pesanan tidak tercetak');
          // Cetak ulang nota perlu PIN: tombol di layar → kotak PIN; PIN kasir ditolak; PIN Pembatalan menyetujui
          const notaPdf = path.join(out, `${done.receipt_no}.pdf`);
          const mt0 = fs.statSync(notaPdf).mtimeMs;
          await run(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].find((b) => b.textContent === 'Cetak Ulang Nota').click()`);
          await wait(800);
          const rpTitle = await run(`(document.querySelector('#modalRoot .modal-head') || {}).innerText || ''`);
          if (!/Cetak Ulang Nota/.test(rpTitle) || !(await run(`!!document.querySelector('#rpPin')`)) || fs.statSync(notaPdf).mtimeMs !== mt0) {
            throw new Error(`cetak ulang nota tidak meminta PIN (${rpTitle})`);
          }
          await run(`(() => { document.querySelector('#rpPin').value = '222222'; document.querySelector('#modalRoot .modal-foot .btn.primary').click(); })()`);
          await wait(1600);
          const rpWrong = await run(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.innerText).join(' | ')`);
          if (fs.statSync(notaPdf).mtimeMs !== mt0 || !/PIN Admin \/ PIN Pembatalan salah/.test(rpWrong)) throw new Error('PIN kasir seharusnya tidak bisa menyetujui cetak ulang');
          await shot('13d2-cetak-ulang-perlu-pin');
          await run(`(() => { document.querySelector('#rpPin').value = '765432'; document.querySelector('#modalRoot .modal-foot .btn.primary').click(); })()`);
          await wait(1500);
          if (fs.statSync(notaPdf).mtimeMs === mt0 || await run(`!!document.querySelector('#rpPin')`)) throw new Error('cetak ulang dengan PIN Pembatalan gagal');
          // Perintah langsung juga ditolak tanpa PIN: cetak kedua lewat receipt:print, atau cetak ulang tanpa / dengan PIN salah
          const again = await run(`window.posBridge.call('receipt:print', { receipt_no: ${JSON.stringify(done.receipt_no)}, lines: [], total: 0 })`);
          const noPin = await run(`window.posBridge.call('receipt:reprint', { receipt_no: ${JSON.stringify(done.receipt_no)} })`);
          console.log('cetak ulang tanpa PIN:', again.error, '·', noPin.error);
          if (again.ok || !/sudah dicetak/.test(again.error) || noPin.ok || !/PIN Admin \/ PIN Pembatalan salah/.test(noPin.error)) throw new Error('nota bisa dicetak ulang tanpa PIN');
          await wait(300);
          // Batalkan pesanan kedua: PIN kasir ditolak; PIN Pembatalan menyetujui; deposit dikembalikan dari laci
          await run(`document.querySelector('#orBody tr[data-no="${ord2.order_no}"] [data-act=detail]').click()`);
          await wait(800);
          await run(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].find((b) => b.textContent === 'Batalkan Pesanan').click()`);
          await wait(500);
          await run(`(() => { const m = document.querySelector('#modalRoot'); m.querySelector('#ocDep').value = 'kembali'; m.querySelector('#ocReason').value = 'Pelanggan tidak jadi';
            m.querySelector('#ocPin').value = '222222'; m.querySelector('.modal-foot .btn.danger').click(); })()`);
          await wait(1600);
          if (svc.getOrder({ order_no: ord2.order_no }).status !== 'baru') throw new Error('PIN kasir seharusnya tidak bisa membatalkan pesanan');
          await shot('13e-batal-pesanan');
          await run(`(() => { const m = document.querySelector('#modalRoot'); m.querySelector('#ocPin').value = '765432'; m.querySelector('.modal-foot .btn.danger').click(); })()`);
          await wait(1500);
          const c2 = svc.getOrder({ order_no: ord2.order_no });
          const oSum = svc.shiftSummary().orders;
          console.log('batal pesanan:', JSON.stringify([c2.status, c2.cancel_deposit, c2.cancel_approved_by]), 'uang pesanan shift:', JSON.stringify(oSum));
          if (c2.status !== 'batal' || c2.cancel_deposit !== 'kembali' || oSum.deposit_in !== 28000 || oSum.deposit_used !== 18000 || oSum.refunded !== 10000) {
            throw new Error('pembatalan pesanan tidak sesuai');
          }
          // Tab daftar pesanan: Dibatalkan / Sudah diambil / Semua / Belum diambil
          const tabRows = async (st) => {
            await run(`document.querySelector('#orTabs [data-st="${st}"]').click()`);
            await wait(700);
            return run(`({ rows: [...document.querySelectorAll('#orBody tr[data-no]')].map((r) => r.dataset.no), active: document.querySelector('#orTabs .active').dataset.st })`);
          };
          const tabs = { batal: await tabRows('batal'), diambil: await tabRows('diambil'), semua: await tabRows('semua'), baru: await tabRows('baru') };
          console.log('tab pesanan:', JSON.stringify(tabs));
          if (!tabs.batal.rows.includes(ord2.order_no) || tabs.batal.rows.includes(ord.order_no) || tabs.batal.active !== 'batal'
            || !tabs.diambil.rows.includes(ord.order_no) || tabs.diambil.rows.includes(ord2.order_no)
            || !tabs.semua.rows.includes(ord.order_no) || !tabs.semua.rows.includes(ord2.order_no)
            || tabs.baru.rows.includes(ord.order_no) || tabs.baru.rows.includes(ord2.order_no) || tabs.baru.active !== 'baru') {
            throw new Error('tab daftar pesanan tidak berfungsi');
          }
          await run(`go('shift')`);
          await wait(1000);
          const shText = await run(`document.querySelector('#shiftContent').innerText`);
          if (!/Deposit pesanan masuk/.test(shText) || !/Uang tunai di laci/.test(shText)) throw new Error('kartu Tutup Shift tidak menampilkan uang pesanan');
          await shot('13f-shift-uang-pesanan');
        }
      }

      // Reset Program (Admin): pengaman dulu, lalu semua data toko terhapus & dicadangkan; kembali ke Buat Akun Admin
      await run(`document.querySelector('#logoutBtn').click()`);
      await wait(1500);
      await login('Pemilik', '111111');
      const reset = (a) => run(`window.posBridge.call('app:reset', ${JSON.stringify(a)})`);
      const rShift = await reset({ confirm: 'RESET', pin: '111111' });
      svc.archiveShift({});
      const rPending = await reset({ confirm: 'RESET', pin: '111111' }); // mother base diatur (alamat uji) & ada data belum terkirim
      svc.mbSaveConfig({ url: '' });
      const rWord = await reset({ confirm: 'hapus', pin: '111111' });
      const rPin = await reset({ confirm: 'RESET', pin: '222222' });
      console.log('reset ditolak:', JSON.stringify([rShift.error, rPending.error, rWord.error, rPin.error]));
      if (rShift.ok || !/Shift masih berjalan/.test(rShift.error) || rPending.ok || !/belum terkirim/.test(rPending.error)
        || rWord.ok || !/Ketik RESET/.test(rWord.error) || rPin.ok || !/PIN Admin salah/.test(rPin.error) || svc.needsSetup()) {
        throw new Error('pengaman Reset Program tidak bekerja');
      }
      await run(`document.querySelector('[data-view=settings]').click()`);
      await wait(700);
      await run(`(() => { document.querySelector('#stReset').scrollIntoView(); document.querySelector('#stReset').click(); })()`);
      await wait(500);
      await shot('12-reset-program');
      await run(`(() => { document.querySelector('#rsConfirm').value = 'RESET'; document.querySelector('#rsPin').value = '111111'; document.querySelector('#modalRoot .modal-foot .btn.danger').click(); })()`);
      await wait(3000);
      const backups = fs.readdirSync(path.join(process.env.POS_DATA_DIR, 'backup')).filter((f) => /^sebelum-reset-\d{14}\.db$/.test(f));
      const repLeft = fs.readdirSync(process.env.POS_REPORTS_DIR).filter((d) => /^Shift_/.test(d));
      const afterSub = await run(`document.querySelector('#lgSub').textContent`);
      const fresh = getServices();
      console.log('setelah reset:', JSON.stringify({ setup: fresh.needsSetup(), barang: fresh.listProducts({}).length, backup: backups.length, laporan: repLeft.length, layar: afterSub }));
      if (!fresh.needsSetup() || fresh.listProducts({}).length || backups.length !== 1 || repLeft.length || !/ADMIN/.test(afterSub)
        || fs.existsSync(path.join(process.env.POS_DATA_DIR, 'drafts.json'))) {
        throw new Error('Reset Program tidak menghapus semua data / tidak membuat cadangan');
      }
      await shot('12b-setelah-reset');
    } catch (e) {
      console.error('SMOKE GAGAL:', e);
      process.exitCode = 1;
    }
    if (errors.length) { console.error('Error konsol renderer:', errors); process.exitCode = 1; }
    console.log('output:', out);
    app.quit();
  });
});
