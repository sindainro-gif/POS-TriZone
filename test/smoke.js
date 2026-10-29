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
      svc.saveSettings({ store_name: 'Toko Sumber Rejeki', store_address: 'Jl. Merdeka No. 1', owner_email: 'owner@contoh.id',
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
      await scan('8991234567890', 12);
      const qtyAfter = await run(`document.querySelector('#qtyInput').value`);
      if (qtyAfter !== '1') throw new Error(`Jumlah tidak kembali ke 1 (${qtyAfter})`);
      const afterScan = await focusNow();
      if (afterScan !== 'scanInput') throw new Error(`setelah scan kursor seharusnya tetap di kolom scan (${afterScan})`);
      await scan('8997654321098');
      await scan('8997654321098', 10); // melebihi stok toko → peringatan tiga zona
      // F12 dari metode QRIS → pindah ke Tunai & fokus Uang Diterima; ketik uang lalu Enter = bayar
      await run(`document.querySelector('#payMethods [data-m="QRIS"]').click()`);
      const f12 = await run(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }));
        return { focus: document.activeElement.id, method: document.querySelector('#payMethods .active').dataset.m, view: state.view }; })()`);
      console.log('F12:', JSON.stringify(f12));
      if (f12.focus !== 'cashInput' || f12.method !== 'Tunai' || f12.view !== 'checkout') throw new Error('F12 tidak mengisi Uang Diterima');
      // F12 lagi di kolom Uang Diterima = Uang Pas
      const f12Pas = await run(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }));
        return { cash: document.querySelector('#cashInput').value.replace(/\\D/g, ''), pas: document.querySelector('#quickCash [data-v]').dataset.v, focus: document.activeElement.id }; })()`);
      console.log('F12 lagi:', JSON.stringify(f12Pas));
      if (f12Pas.cash !== f12Pas.pas || f12Pas.focus !== 'cashInput') throw new Error('F12 kedua tidak mengisi Uang Pas');
      await run(`(() => { const c = document.querySelector('#cashInput'); c.value = '200.000'; c.dispatchEvent(new Event('input')); })()`);
      await shot('02-kasir-keranjang');
      const alertText = await run(`document.querySelector('#stockAlert').className + ' | ' + document.querySelector('#stockAlert').innerText`);
      console.log('peringatan stok:', alertText);
      // Keripik: stok toko 4, di keranjang 11 → tetap masuk keranjang dengan peringatan kuning
      const keripikQty = await run(`document.querySelector('#cartBody tr[data-sku="SNK-010"] [data-act=qty]').value`);
      if (keripikQty !== '11' || !/warn/.test(alertText) || !/Tetap dijual/.test(alertText)) throw new Error(`kasir seharusnya boleh menjual melebihi stok (qty ${keripikQty})`);
      await run(`document.querySelector('#cashInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await wait(700);
      const receiptTitle = await run(`(document.querySelector('#modalRoot .modal-head') || {}).innerText || ''`);
      if (!/Transaksi Berhasil/.test(receiptTitle)) throw new Error('Enter di Uang Diterima tidak membayar');
      await shot('03-kasir-struk');
      await run(`document.querySelector('#modalRoot .btn.primary').click()`);

      svc.createTransfer({ sku: 'MNM-001', from_zone: 'floor', to_zone: 'damaged', qty: 1, reason: 'Pecah terinjak' });
      if (svc.getProduct('SNK-010').floor_stock !== -7) throw new Error(`stok toko Keripik seharusnya -7: ${svc.getProduct('SNK-010').floor_stock}`);
      await run(`document.querySelector('[data-view=transfers]').click()`);
      await wait(600);
      const restock = await run(`({ first: document.querySelector('#trLowList .low-item').className + ' | ' + document.querySelector('#trLowList .low-item').innerText.replace(/\\s+/g, ' '),
        badge: (document.querySelector('#nav [data-view="transfers"] .nav-badge:not(.hidden)') || {}).textContent || '' })`);
      console.log('saran restock teratas:', JSON.stringify(restock));
      if (!/\bout\b/.test(restock.first) || !/MINUS -7/.test(restock.first) || !/Keripik/.test(restock.first) || !restock.badge) throw new Error('barang minus tidak tampil merah paling atas / badge Mutasi tidak muncul');
      // Form Mutasi: kursor awal di Barang, Enter di Barang kosong → Jumlah, Enter di Jumlah → Barang; tanpa Satuan
      const trNav = await run(`(() => { const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const start = document.activeElement.id; enter(document.querySelector('#trPicker')); const toQty = document.activeElement.id;
        enter(document.querySelector('#trQty')); return { start, toQty, back: document.activeElement.id, unit: !!document.querySelector('#trUnit') }; })()`);
      console.log('navigasi Mutasi:', JSON.stringify(trNav));
      if (trNav.start !== 'trPicker' || trNav.toQty !== 'trQty' || trNav.back !== 'trPicker' || trNav.unit) throw new Error('navigasi Enter Barang/Jumlah di Mutasi salah');
      await shot('04-mutasi');
      const f12View = await run(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })); return state.view + '/' + document.activeElement.id; })()`);
      if (f12View !== 'checkout/cashInput') throw new Error(`F12 dari layar lain seharusnya ke Uang Diterima Kasir, bukan ${f12View}`);
      await run(`document.querySelector('[data-view=receiving]').click()`);
      await shot('05-penerimaan');

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

      // Tutup shift dengan SMTP yang tidak bisa dihubungi: file laporan dibuat, data shift TIDAK dihapus
      svc.saveSettings({ smtp_host: '127.0.0.1', smtp_port: '2', smtp_security: 'none', smtp_from: 'toko@contoh.id' });
      const res = await run(`window.posBridge.call('shift:close', {})`);
      console.log('tutup shift (SMTP mati):', JSON.stringify(res));
      const dirs = fs.readdirSync(process.env.POS_REPORTS_DIR);
      const files = fs.readdirSync(path.join(process.env.POS_REPORTS_DIR, dirs[0]));
      console.log('file laporan:', files.join(', '));
      const pdf = files.find((f) => f.endsWith('.pdf'));
      fs.copyFileSync(path.join(process.env.POS_REPORTS_DIR, dirs[0], pdf), path.join(out, 'rekap.pdf'));
      if (res.ok || svc.shiftSalesRows().length !== 2 || !svc.getShift()) throw new Error('data shift seharusnya tetap ada');
      await shot('09-shift-setelah-gagal-kirim');

      const p = svc.getProduct('MNM-001');
      console.log('stok MNM-001 setelah jual 12 & mutasi 1 ke BS:', p.floor_stock, p.warehouse_stock, p.damaged_stock);
      console.log('ringkasan shift:', JSON.stringify(svc.shiftSummary().totals));
      if (svc.getShift().cashier_name !== 'Pemilik') throw new Error('nama kasir shift tidak diambil dari akun login');

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
      const payQris = async () => {
        await run(`document.querySelector('#payMethods [data-m="QRIS"]').click()`);
        await run(`document.querySelector('#payBtn').click()`);
        await wait(900);
        await run(`document.querySelector('#modalRoot .modal-foot .btn.primary').click()`);
        await wait(300);
      };
      await scan('8991234567890'); // pelanggan B
      await payQris();
      await run(`document.querySelector('#draftListBtn').click()`);
      await wait(600);
      await shot('12-daftar-draft');
      await run(`document.querySelector('#modalRoot [data-resume]').click()`);
      await wait(1200);
      const resumed = await run(`[...document.querySelectorAll('#cartBody tr')].map((r) => r.dataset.sku + ':' + r.querySelector('[data-act=qty]').value).join(',')`);
      console.log('draft dilanjutkan:', resumed);
      if (resumed !== 'SBN-005:3') throw new Error('isi draft tidak kembali ke keranjang');
      await payQris();
      const draftsLeft = await run(`window.posBridge.call('drafts:list').then((r) => r.data.length)`);
      if (draftsLeft !== 0 || svc.shiftSummary().totals.receipts !== receiptsBefore + 2 || svc.getProduct('SBN-005').floor_stock !== sabunBefore - 3) {
        throw new Error('alur draft → bayar tidak sesuai');
      }

      // Akun Gudang & Kasir: menu dibatasi sesuai peran
      svc.saveUser({ name: 'Budi', role: 'gudang', pin: '333333' });
      svc.saveUser({ name: 'Rina', role: 'kasir', pin: '222222' });
      await run(`document.querySelector('[data-view=settings]').click()`);
      await wait(800);
      await shot('10-pengaturan-pengguna');
      const navOf = () => run(`[...document.querySelectorAll('.nav-btn')].filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.view).join(',')`);
      for (const [name, pin, want] of [['Rina', '222222', 'checkout,products,shift'], ['Budi', '333333', 'transfers,receiving,products,barcode']]) {
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
        await run(`go('products')`);
        await wait(800);
        const edits = await run(`document.querySelectorAll('#pdBody [data-edit]').length + (document.querySelector('#pdAdd').classList.contains('hidden') ? 0 : 1)`);
        if ((name === 'Rina') !== (edits === 0)) throw new Error(`hak ubah Daftar Barang untuk ${name} salah`);
        await shot(`11-login-${name.toLowerCase()}`);
      }
    } catch (e) {
      console.error('SMOKE GAGAL:', e);
      process.exitCode = 1;
    }
    if (errors.length) { console.error('Error konsol renderer:', errors); process.exitCode = 1; }
    console.log('output:', out);
    app.quit();
  });
});
