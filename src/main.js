'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const { Database } = require('./db');
const { createServices, TEMPLATE_HEADERS, TEMPLATE_SAMPLE, RECEPTION_TEMPLATE_HEADERS, RECEPTION_TEMPLATE_SAMPLE, OPNAME_TEMPLATE_HEADERS, localNow } = require('./services');
const reports = require('./reports');
const { buildReceiptLines, buildReceiptRows, buildShiftRows, buildOrderRows, receiptFragment, receiptPage, FONT_SCALES } = require('./receipt');
const { labelPages, labelPreview } = require('./labels');
const { startServer, createRemoteClient, newPairKey, DEFAULT_PORT } = require('./remote');
const { loadDevice, saveDevice, PRINTER_KEYS, MODES } = require('./device');
const { createOfflineStore } = require('./offline');
const { ROLE_LABEL } = require('./auth');
const crypto = require('crypto');
const { seedDemo, DEMO_ACCOUNTS } = require('./demo');
const { createDraftStore } = require('./drafts');
const { createMotherbase } = require('./motherbase');
const { openDrawer } = require('./drawer');
const reportCrypt = require('./reportcrypt');
// Versi POS dari package.json (sama di aplikasi terpasang, saat dijalankan dari folder, dan saat uji otomatis)
const APP_VERSION = require('../package.json').version;
const { readPdfTable } = require('./pdftable');

// Versi DEMO (Jalankan DEMO.bat): data latihan di folder terpisah; mencetak ke printer sungguhan, tidak mengirim ke mother base
const DEMO = process.argv.includes('--demo') || process.env.POS_DEMO === '1';
if (process.env.POS_DATA_DIR) app.setPath('userData', process.env.POS_DATA_DIR);
else if (DEMO) app.setPath('userData', path.join(app.getPath('appData'), 'POS Tri-Zone DEMO'));
const DATA_DIR = app.getPath('userData');
const DB_FILE = path.join(DATA_DIR, 'pos.db');

let db; // hanya di mode mandiri/server
let localSvc; // layanan dengan database lokal
let svc; // = localSvc, atau proxy ke PC gudang (mode kasir)
let remote; // klien jaringan (mode kasir)
let server; // server HTTP (mode server)
let offline; // cache barang + antrian transaksi darurat (mode kasir)
let online = true; // hasil ping terakhir ke PC gudang (mode kasir)
let serverVersion = ''; // versi aplikasi di PC Server (dari ping terakhir; kosong = versi lama sebelum 1.17.2)
let session = null; // akun yang sedang login di komputer ini: { id, name, role }
let drafts; // draft penjualan yang ditahan (disimpan di komputer ini)
let mb; // pengirim data ke mother base (hanya di PC pemilik database)
let device = loadDevice(DATA_DIR);
let win;
let closingShift = false;

const isClient = () => !DEMO && device.mode === 'client'; // demo selalu Mandiri

// Laporan tutup shift disimpan di folder data aplikasi (%APPDATA%, tersembunyi), bukan di Dokumen.
// Lokasinya hanya terlihat oleh Admin (Pengaturan → Informasi); kasir tidak diberi tahu.
function reportsRoot() {
  if (process.env.POS_REPORTS_DIR) return process.env.POS_REPORTS_DIR;
  return path.join(DATA_DIR, DEMO ? 'Laporan-Demo' : 'Laporan');
}

// Kunci toko mother base dienkripsi dengan kunci akun Windows (DPAPI) bila tersedia.
const secrets = {
  encrypt: (s) => (s && safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s),
  decrypt: (s) => {
    if (s && s.startsWith('enc:')) {
      try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch (_) { return ''; }
    }
    return s || '';
  },
};

// Kunci enkripsi file laporan (file laporan.key di folder data, isinya dienkripsi akun Windows)
let reportKeyCache;
const reportKey = () => (reportKeyCache ||= reportCrypt.loadOrCreateKey(path.join(DATA_DIR, 'laporan.key'), secrets));
// File laporan yang dibuka Admin didekripsi ke sini; dikosongkan saat aplikasi dibuka & ditutup
const OPEN_DIR = path.join(DATA_DIR, 'buka-laporan');
const clearOpenDir = () => { try { fs.rmSync(OPEN_DIR, { recursive: true, force: true }); } catch (_) { /* file masih dibuka program lain */ } };

// Folder laporan tutup shift yang lebih tua dari 7 hari dihapus (data penjualan tetap ada di mother base)
function pruneReportsNow() {
  try {
    const n = reportCrypt.pruneReports(reportsRoot(), { days: reportCrypt.REPORT_DAYS, today: localNow().slice(0, 10) });
    if (n) console.log(`[laporan] ${n} folder laporan lebih dari ${reportCrypt.REPORT_DAYS} hari dihapus`);
  } catch (err) { console.error('[laporan] hapus laporan lama gagal:', err.message); }
}

function userError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

// Pengaturan bersama (database) + pengaturan printer milik komputer ini
async function getSettings() {
  const shared = await viaGudang(() => svc.getSettings(), () => offline.getSettings());
  const own = {};
  for (const k of PRINTER_KEYS) own[k] = device[k];
  return { ...shared, ...own, demo: DEMO };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function htmlToPdf(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
  } finally {
    w.destroy();
  }
}

// ---------------------------------------------------------------- Cetak nota thermal
const SAMPLE_RECEIPT = {
  receipt_no: 'INV-CONTOH-0001', payment_method: 'Tunai', cashier: 'KASIR',
  lines: [
    { name: 'Penebah Lidi @50 PCS Sima', qty: 1, unit_price: 6000, line_total: 6000 },
    { name: 'Air Mineral 600ml', qty: 2, unit_price: 3500, line_total: 7000 },
  ],
  total: 13000, cash_received: 50000, change: 37000,
};

// Cetak HTML tanpa dialog ke printer tertentu dengan ukuran kertas khusus (mikron).
async function printPage(page, { deviceName, pdfName, what }) {
  // page.measure: ukur tinggi isi (mis. nota) agar panjang kertas pas — tidak terpotong, tidak boros kertas.
  // Halaman ini buatan aplikasi sendiri tanpa skrip; JavaScript hanya dipakai untuk mengukur.
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: !!page.measure } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page.html));
    if (page.measure) {
      try {
        const px = await w.webContents.executeJavaScript(`Math.ceil(document.querySelector(${JSON.stringify(page.measure)}).getBoundingClientRect().bottom)`);
        if (px > 0) page = { ...page, heightMicrons: Math.max(40, Math.ceil((px * 25.4) / 96) + 2) * 1000 };
      } catch (_) { /* pakai perkiraan tinggi dari receiptPage */ }
    }
    const pdfDir = process.env.POS_PRINT_TO_PDF;
    if (pdfDir) {
      // Mode uji otomatis: simpan sebagai PDF dengan ukuran kertas yang sama, tanpa printer fisik
      const pdf = await w.webContents.printToPDF({ preferCSSPageSize: true, pageSize: { width: page.widthMicrons / 25400, height: page.heightMicrons / 25400 }, margins: { marginType: 'none' }, printBackground: true });
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, `${pdfName}.pdf`), pdf);
      return true;
    }
    await new Promise((resolve, reject) => {
      w.webContents.print({
        silent: true,
        printBackground: false,
        landscape: false,
        deviceName: deviceName || '',
        margins: { marginType: 'none' },
        pageSize: { width: page.widthMicrons, height: page.heightMicrons },
      }, (ok, reason) => {
        if (ok) resolve();
        else reject(userError(`${what} gagal dicetak${reason ? ` (${reason})` : ''}. Periksa printer: menyala, kertas terpasang, dan sudah dipilih.`));
      });
    });
    return true;
  } finally {
    w.destroy();
  }
}

// Rekap tutup shift di printer nota komputer ini (tempat shift ditutup)
// Bukti pesanan di printer nota komputer ini
async function printOrder(order, { reprint = false } = {}) {
  if (!order || !order.order_no) throw userError('Pesanan tidak ditemukan.');
  const s = await getSettings();
  const page = receiptPage(buildOrderRows(order, s, { reprint }), s.paper_width, { offsetMm: s.receipt_offset, fontScale: s.receipt_font_scale });
  return printPage(page, { deviceName: s.printer_name, pdfName: order.order_no, what: 'Bukti pesanan' });
}

async function printShiftRecap(recap, { reprint = false } = {}) {
  if (!recap || typeof recap !== 'object') throw userError('Data rekap shift tidak ada.');
  const s = await getSettings();
  const page = receiptPage(buildShiftRows(recap, s, { reprint }), s.paper_width, { offsetMm: s.receipt_offset, fontScale: s.receipt_font_scale });
  return printPage(page, { deviceName: s.printer_name, pdfName: `Rekap_Shift_${String(recap.closed_at || localNow()).replace(/\D/g, '')}`, what: 'Rekap shift' });
}

async function printReceipt(receipt, { reprint = false } = {}) {
  const s = await getSettings();
  const page = receiptPage(buildReceiptRows(receipt, s, { reprint }), s.paper_width, { offsetMm: s.receipt_offset, fontScale: s.receipt_font_scale });
  return printPage(page, { deviceName: s.printer_name, pdfName: receipt.receipt_no, what: 'Nota' });
}

// Nota hanya boleh tercetak SEKALI tanpa izin. Cetak berikutnya = cetak ulang (receipt:reprint) yang perlu
// PIN Admin / PIN Pembatalan. Dicatat di komputer ini sejak aplikasi dibuka; bila cetak gagal (printer mati,
// kertas habis) nota dianggap belum tercetak sehingga boleh dicoba lagi.
const printedReceipts = new Set();
const REPRINT_NEEDS_PIN = 'Nota ini sudah dicetak. Cetak ulang perlu PIN Admin / PIN Pembatalan.';
async function printReceiptOnce(receipt) {
  const no = String((receipt && receipt.receipt_no) || '');
  if (!no) throw userError('Data nota tidak lengkap.');
  if (printedReceipts.has(no)) throw userError(REPRINT_NEEDS_PIN);
  printedReceipts.add(no);
  try {
    return await printReceipt(receipt);
  } catch (err) {
    printedReceipts.delete(no);
    throw err;
  }
}

// Cetak ulang nota: disetujui PIN Admin / PIN Pembatalan (dicek di PC Server), tercetak dengan tanda CETAK ULANG.
// receipt (opsional) = data nota dari layar transaksi berhasil (memuat nota MODE DARURAT yang belum terkirim).
async function reprintReceipt({ receipt_no, approver_pin, receipt } = {}) {
  const no = String(receipt_no || (receipt && receipt.receipt_no) || '').trim();
  if (!no) throw userError('Nomor nota tidak ada.');
  if (isClient() && !online) throw userError('Cetak ulang nota tidak bisa saat MODE DARURAT: PIN persetujuan dicek di PC Server.');
  let approved;
  try {
    approved = await svc.checkApprover({ approver_pin });
  } catch (err) {
    if (/PIN Admin \/ PIN Pembatalan salah/.test(err.message)) await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan PIN
    throw err;
  }
  const data = receipt && String(receipt.receipt_no) === no ? receipt : await svc.receiptForReprint({ receipt_no: no });
  await printReceipt(data, { reprint: true });
  printedReceipts.add(no);
  return { receipt_no: no, approved_by: approved.approved_by };
}

// ---------------------------------------------------------------- Cetak label barcode
const SAMPLE_PRODUCT = { sku: 'MNM-001', barcode: '8991234567890', name: 'Air Mineral 600ml', brand: 'Segar', unit_price: 3500 };

// Ambil data barang terbaru dari database; jumlah label dari antrian
async function resolveLabelItems(items) {
  const out = [];
  for (const it of items || []) {
    const product = await svc.getProduct(it.sku || (it.product && it.product.sku));
    if (!product) throw userError(`Barang ${it.sku} tidak ditemukan.`);
    const copies = Number(it.copies);
    if (!Number.isInteger(copies) || copies < 0 || copies > 5000) throw userError(`Jumlah label "${product.name}" harus angka bulat 0–5000.`);
    out.push({ product, copies });
  }
  return out;
}

async function printLabels({ design_id, items, config }) {
  const design = config || (await svc.getLabelDesign(design_id)).config;
  const page = labelPages(design, await resolveLabelItems(items));
  await printPage(page, { deviceName: device.label_printer_name, pdfName: `Label_${localNow().replace(/\D/g, '')}`, what: 'Label' });
  return { labels: page.labelCount, rows: page.pageCount };
}

// ---------------------------------------------------------------- Operasi yang selalu dijalankan di PC pemilik database
function checkoutLocal(a) {
  if (closingShift) throw userError('Sedang proses tutup shift. Transaksi ditahan.');
  return localSvc.checkout(a);
}

// Tutup shift tanpa menghitung uang laci (tidak ada uang tunai seharusnya / uang fisik / selisih).
// Shift ditutup TANPA menunggu internet: penjualan dipindah ke Riwayat Shift dan masuk antrean mother base
// dalam satu transaksi, lalu langsung dikirim ke mother base. File laporan (PDF/CSV) disimpan di komputer ini.
async function closeShiftLocal({ notes } = {}) {
  if (closingShift) throw userError('Proses tutup shift sedang berjalan.');
  const settings = localSvc.getSettings();
  const summary = localSvc.shiftSummary();
  if (!summary.shift) throw userError('Tidak ada shift aktif.');

  closingShift = true;
  let ctx;
  let dir;
  let uid;
  const closedAt = localNow();
  try {
    const stamp = closedAt.replace(/[-:]/g, '').replace(' ', '_');
    dir = path.join(reportsRoot(), `Shift_${stamp}`);
    fs.mkdirSync(dir, { recursive: true });

    ctx = { store: settings, summary, closedAt, notes: String(notes || '').trim(), lowStock: localSvc.lowStock({ limit: 100 }) };
    const files = {
      [`Rekap_Shift_${stamp}.pdf`]: await htmlToPdf(reports.summaryHtml(ctx)),
      [`Penjualan_Shift_${stamp}.csv`]: reports.salesCsv(localSvc.shiftSalesRows()),
      [`Snapshot_Stok_${stamp}.csv`]: reports.stockCsv(localSvc.stockSnapshot()),
    };
    // Isi asli tidak pernah ditulis ke disk: langsung terenkripsi (hanya Admin yang bisa membuka lewat Pengaturan)
    const key = reportKey();
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name + reportCrypt.EXT), reportCrypt.encrypt(key, content));
    uid = localSvc.archiveShift({ closed_at: closedAt, notes: ctx.notes, report_dir: dir }).shift_uid;
  } finally {
    closingShift = false;
  }
  pruneReportsNow();

  // Kirim ke mother base SEKARANG dan tunggu jawabannya (bukan hanya dijadwalkan). Gagal = shift tetap tertutup,
  // datanya aman di antrean dan dicoba lagi otomatis tiap 3 jam (atau Kirim Sekarang di Pengaturan).
  const motherbase = await sendShiftToMotherbase(uid);

  // Lokasi file laporan sengaja TIDAK dikirim ke layar (tersimpan di shift_history.report_dir)
  // Hasil kiriman tidak ditampilkan ke pegawai (Admin memantaunya di Pengaturan → Mother Base)
  if (!motherbase.sent && motherbase.configured) console.error('[mother base] shift belum terkirim:', motherbase.error);
  // Rekap ringkas untuk dicetak di printer nota komputer yang menutup shift (lihat 'shift:close')
  const recap = {
    cashier: summary.shift.cashier_name, shift_start: summary.shift.shift_start, closed_at: closedAt,
    receipts: summary.totals.receipts, qty: summary.totals.qty, revenue: summary.totals.revenue, cash_sales: summary.cashSales,
    voids: { count: summary.voids ? summary.voids.count : 0, total: summary.voids ? summary.voids.total : 0 }, notes: ctx ? ctx.notes : '',
    orders: summary.orders || null,
  };
  return { revenue: summary.totals.revenue, receipts: summary.totals.receipts, recap };
}

// Kirim antrean ke mother base sekarang juga dan pastikan shift `uid` (atau semua shift) sudah diterima.
// Tidak pernah melempar: hasilnya { sent, configured, error, pending } (dicatat, tidak ditampilkan ke pegawai).
async function sendShiftToMotherbase(uid) {
  if (!mb || DEMO) return { sent: false, configured: false, error: DEMO ? 'Versi DEMO tidak mengirim ke mother base.' : 'Mother base tidak tersedia.' };
  if (!localSvc.mbConfig().ready) {
    return { sent: false, configured: false, error: 'Mother base belum diatur (Pengaturan → Mother Base). Data shift menunggu di antrean.' };
  }
  try {
    if (mb.isRunning()) await mb.kirim().catch(() => {}); // kiriman berkala yang sedang jalan belum memuat shift ini
    await mb.kirim();
  } catch (err) {
    return { sent: false, configured: true, error: err.message, pending: localSvc.mbStatus().pending_shifts };
  }
  const sent = uid ? localSvc.mbShiftSent(uid) : true;
  return { sent, configured: true, error: sent ? '' : 'Mother base belum mengonfirmasi shift ini.', pending: localSvc.mbStatus().pending_shifts };
}

// Ambil master barang dari mother base sekarang (tombol Perbarui Daftar Barang, semua peran, juga dari PC kasir).
// Pesannya netral: pegawai tidak perlu tahu ada mother base. Detail error tersimpan di status untuk Admin.
const MB_SEND_EVERY_MS = 3 * 60 * 60 * 1000; // kiriman berkala ke mother base: tiap 3 jam

// Buka shift: ambil daftar barang & harga terbaru (yang berubah sejak terakhir) dari mother base di latar,
// kasir tidak menunggu. Hanya bila daftar barang dikunci ke mother base (sama seperti dulu ambil berkala).
function pullMasterOnShiftOpen() {
  if (!mb || DEMO || !localSvc.mbConfig().ready || !localSvc.masterLocked()) return false;
  mb.ambilMaster().catch((err) => console.error('[mother base] ambil master saat buka shift:', err.message));
  return true;
}

async function pullMasterLocal() {
  if (!mb || DEMO) throw userError('Versi DEMO tidak memperbarui daftar barang.');
  if (!localSvc.mbConfig().ready) throw userError('Pembaruan daftar barang belum diatur. Hubungi Admin.');
  try {
    return await mb.ambilMaster({ full: true });
  } catch (err) {
    console.error('[mother base] ambil master:', err.message);
    throw userError('Daftar barang belum bisa diperbarui. Periksa internet, lalu coba lagi.');
  }
}

// Perintah yang boleh dipanggil PC kasir lewat jaringan
// Pesanan: ditahan selama proses tutup shift (deposit & penjualannya masuk laci shift yang sedang ditutup)
function createOrderLocal(a) {
  if (closingShift) throw userError('Sedang proses tutup shift. Pesanan ditahan.');
  return localSvc.createOrder(a);
}
function completeOrderLocal(a) {
  if (closingShift) throw userError('Sedang proses tutup shift. Pengambilan pesanan ditahan.');
  return localSvc.completeOrder(a);
}

const SERVER_MAIN = {
  'main.checkout': checkoutLocal,
  'main.createOrder': createOrderLocal,
  'main.completeOrder': completeOrderLocal,
  'main.voidReceipt': (a) => localSvc.voidReceipt(a),
  'main.closeShift': closeShiftLocal,
  'main.pullMaster': pullMasterLocal,
  'main.masterOnShiftOpen': pullMasterOnShiftOpen,
};
const REMOTE_BLOCKED = new Set([
  'archiveShift', 'pruneShiftHistory', 'checkout', 'shiftData', 'createOrder', 'completeOrder',
  // Mother base: kunci toko & antrean kiriman hanya di PC pemilik database (mbStatus boleh, tanpa rahasia)
  'mbConfig', 'mbSaveConfig', 'mbState', 'mbSetState', 'mbQueueHistory', 'mbBatch', 'mbAck', 'mbApplyMaster', 'mbMasterSince',
]);

function serverCall(method, args) {
  if (SERVER_MAIN[method]) return SERVER_MAIN[method](...args);
  if (!REMOTE_BLOCKED.has(method) && typeof localSvc[method] === 'function') return localSvc[method](...args);
  throw userError(`Perintah tidak dikenal: ${method}`);
}

// Di PC kasir diteruskan ke PC gudang; selain itu dijalankan di sini
const runMain = (name, ...args) => (isClient() ? svc[name](...args) : SERVER_MAIN[name](...args));

// ---------------------------------------------------------------- Mode darurat PC kasir
const CACHE_MAX_AGE = 60 * 1000;
let maintaining = null;

// Mode kasir: ambil dari PC gudang; bila tidak terjangkau pakai data darurat (cache) di komputer ini.
// Saat sudah diketahui terputus, langsung pakai cache agar scan tidak menunggu timeout jaringan.
async function viaGudang(fn, fallback) {
  if (!isClient()) return fn();
  if (!online && offline.hasCache()) return fallback();
  try {
    return await fn();
  } catch (err) {
    if (!err.network || !offline.hasCache()) throw err;
    online = false;
    return fallback();
  }
}

// Kirim antrian darurat (berurutan) lalu perbarui cache barang. Hanya satu proses berjalan sekaligus.
function maintainOffline({ forceRefresh = false } = {}) {
  if (!isClient() || !online) return Promise.resolve();
  if (!maintaining) {
    const run = async () => {
      try {
        if (offline.pending().length) {
          const r = await offline.sync(svc);
          if (r.stopped) { online = false; return; }
        }
        if (forceRefresh || offline.cacheAgeMs() > CACHE_MAX_AGE) await offline.refresh(svc);
      } catch (err) {
        if (err.network) online = false;
        else console.error('[offline]', err);
      }
    };
    // .finally selalu asinkron: penanda tidak tertimpa bila run() selesai tanpa menunggu apa pun
    maintaining = run().finally(() => { maintaining = null; });
  }
  return maintaining;
}

async function pingGudang(timeout = 3000) {
  try {
    const r = await remote.ping(timeout);
    serverVersion = String(r.version || '');
    online = true;
  } catch (_) { online = false; }
  if (online) maintainOffline();
  return online;
}

async function checkoutClient(a) {
  // Antrian lama dikirim dulu supaya urutan transaksi di PC gudang tetap
  if (online && offline.pending().length) await maintainOffline();
  const req = { ...a, client_ref: crypto.randomUUID() };
  if (online || !offline.hasCache()) {
    try {
      return await svc['main.checkout'](req);
    } catch (err) {
      if (!err.network || !offline.hasCache()) throw err;
      online = false;
    }
  }
  // client_ref yang sama: bila ternyata sudah masuk di gudang, tidak tercatat dua kali saat sinkron
  return offline.checkout(req);
}

async function closeShiftClient(a) {
  const n = offline.pending().length;
  if (n) {
    await pingGudang();
    await maintainOffline();
    const left = offline.pending().length;
    if (left) throw userError(`Masih ada ${left} transaksi MODE DARURAT yang belum terkirim ke PC Server. Pastikan PC Server terhubung, tunggu sampai terkirim, lalu tutup shift.`);
  }
  const r = await runMain('main.closeShift', a);
  offline.setShift(null);
  return r;
}

// ---------------------------------------------------------------- Import / template Excel
// Dialog buka file Excel/CSV → baris sheet pertama (null bila dibatalkan)
// pdf = { headers, keyHeader }: juga menerima PDF hasil "Save as PDF" Excel dari template (lihat src/pdftable.js).
// POS_OPEN_FILE = uji otomatis tanpa dialog.
async function pickSheetRows(title, { pdf = null } = {}) {
  let file = process.env.POS_OPEN_FILE || '';
  if (!file) {
    const r = await dialog.showOpenDialog(win, {
      title,
      filters: [pdf ? { name: 'Excel / CSV / PDF', extensions: ['xlsx', 'xls', 'csv', 'pdf'] } : { name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    file = r.filePaths[0];
  }
  if (/\.pdf$/i.test(file)) {
    if (!pdf) throw userError('File PDF tidak didukung di sini. Gunakan Excel / CSV.');
    try {
      return { file: path.basename(file), rows: await readPdfTable(fs.readFileSync(file), pdf) };
    } catch (err) { throw userError(err.message); }
  }
  const wb = XLSX.readFile(file, { raw: false, cellText: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return { file: path.basename(file), rows: XLSX.utils.sheet_to_json(sheet, { raw: true, defval: '' }) };
}

async function importProducts() {
  const f = await pickSheetRows('Pilih file import barang');
  if (!f) return null;
  return { file: f.file, ...(await svc.importRows(f.rows)) };
}

// Simpan beberapa lembar ke satu file Excel (CSV: hanya lembar pertama). POS_SAVE_DIR = uji otomatis tanpa dialog.
async function saveWorkbook({ title, fileName, sheets, csv = true }) {
  let filePath;
  if (process.env.POS_SAVE_DIR) {
    fs.mkdirSync(process.env.POS_SAVE_DIR, { recursive: true });
    filePath = path.join(process.env.POS_SAVE_DIR, fileName);
  } else {
    const r = await dialog.showSaveDialog(win, {
      title,
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }, ...(csv ? [{ name: 'CSV', extensions: ['csv'] }] : [])],
    });
    if (r.canceled || !r.filePath) return null;
    filePath = r.filePath;
  }
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
    // Kolom kode (barcode, SKU, no. surat jalan) sebagai teks agar angka panjang tidak berubah jadi notasi ilmiah
    for (let row = 1; row <= s.rows.length; row++) {
      for (const col of s.textCols || []) {
        const c = ws[`${col}${row + 1}`];
        if (c) { c.t = 's'; c.z = '@'; }
      }
    }
    ws['!cols'] = s.headers.map((h) => ({ wch: Math.max(12, String(h).length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, String(s.name).slice(0, 31));
  }
  XLSX.writeFile(wb, filePath, filePath.toLowerCase().endsWith('.csv') ? { bookType: 'csv', FS: ';' } : undefined);
  return filePath;
}

function saveTemplate({ title, fileName, sheet, headers, sample, textCols }) {
  return saveWorkbook({ title, fileName, sheets: [{ name: sheet, headers, rows: sample, textCols }] });
}

// ---------------------------------------------------------------- Cadangkan / pulihkan database
function requireLocalReports() {
  if (isClient()) throw userError('Laporan tutup shift ada di PC Server. Buka dari Pengaturan di PC Server.');
}

// Buka satu file laporan: didekripsi ke folder sementara lalu dibuka dengan program bawaan Windows
async function openReport({ folder, file } = {}) {
  requireLocalReports();
  const plainName = (s) => typeof s === 'string' && s !== '' && !/[\\/]|\.\./.test(s);
  if (!plainName(folder) || !plainName(file) || !/^Shift_/.test(folder) || !file.endsWith(reportCrypt.EXT)) throw userError('Nama laporan tidak valid.');
  const src = path.join(reportsRoot(), folder, file);
  if (!fs.existsSync(src)) throw userError('File laporan tidak ditemukan.');
  let data;
  try { data = reportCrypt.decrypt(reportKey(), fs.readFileSync(src)); } catch (err) { throw userError(err.message); }
  const out = path.join(OPEN_DIR, folder, file.slice(0, -reportCrypt.EXT.length));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  if (process.env.POS_NO_SHELL_OPEN !== '1') {
    const err = await shell.openPath(out);
    if (err) throw userError(`Tidak bisa membuka laporan: ${err}`);
  }
  return { path: out };
}

function requireLocalDb() {
  if (isClient()) throw userError('Komputer ini terhubung ke PC Server. Cadangkan / pulihkan database dilakukan di PC Server.');
}

async function backupDatabase() {
  requireLocalDb();
  const d = localNow().slice(0, 16).replace(/[-: ]/g, '');
  const r = await dialog.showSaveDialog(win, {
    title: 'Cadangkan database POS',
    defaultPath: path.join(app.getPath('documents'), `POS-Cadangan-${d}.db`),
    filters: [{ name: 'Database POS', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, db.exportBuffer());
  return r.filePath;
}

async function restoreDatabase() {
  requireLocalDb();
  const r = await dialog.showOpenDialog(win, {
    title: 'Pilih file cadangan database POS',
    filters: [{ name: 'Database POS', extensions: ['db'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const buffer = fs.readFileSync(r.filePaths[0]);
  const info = await Database.validateFile(buffer);
  const ok = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Pulihkan Database',
    message: 'Ganti seluruh data aplikasi dengan isi file cadangan ini?',
    detail: `${path.basename(r.filePaths[0])}\nBerisi ${info.products} barang, ${info.receptions} penerimaan, ${info.sales} baris penjualan shift.\n\nData saat ini akan disimpan dulu ke folder backup sebelum diganti.${device.mode === 'server' ? '\n\nKomputer yang terhubung ke server ini akan langsung memakai data ini.' : ''}`,
    buttons: ['Batal', 'Ya, Pulihkan'],
    defaultId: 0,
    cancelId: 0,
  });
  if (ok.response !== 1) return null;
  const res = await db.replaceWith(buffer, path.join(DATA_DIR, 'backup'));
  localSvc = createServices(db, secrets);
  svc = localSvc;
  session = null; // akun di data cadangan bisa berbeda → login ulang
  setTimeout(() => win.reload(), 300);
  return { file: r.filePaths[0], ...info, ...res };
}

// ---------------------------------------------------------------- Versi DEMO
function requireDemo() {
  if (!DEMO) throw userError('Hanya tersedia di versi DEMO.');
}

// Kembalikan data latihan ke kondisi awal (database dibuat ulang lalu diisi data contoh)
// Reset Program (hanya Admin, di PC Server / Mandiri): semua data toko dihapus seperti baru dipasang —
// barang, stok, transaksi, akun, pengaturan toko, mother base, draft penjualan, dan file laporan.
// Database dicadangkan dulu ke backup\sebelum-reset-*.db (bisa dipulihkan lewat "Pulihkan dari Cadangan").
// Pengaturan komputer ini (mode jaringan & printer di device.json) tetap.
async function resetProgram({ confirm, pin } = {}) {
  if (isClient()) throw userError('Komputer ini terhubung ke PC Server. Reset program dilakukan di PC Server.');
  if (DEMO) throw userError('Versi DEMO: gunakan tombol Reset Data Demo di layar login.');
  if (String(confirm || '').trim().toUpperCase() !== 'RESET') throw userError('Ketik RESET untuk melanjutkan.');
  let u = null;
  try { u = localSvc.verifyLogin({ name: session && session.name, pin }); } catch (_) { u = null; }
  if (!u || u.role !== 'admin') {
    await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan PIN
    throw userError('PIN Admin salah.');
  }
  if (localSvc.getShift()) throw userError('Shift masih berjalan. Tutup shift dulu agar penjualannya tersimpan dan terkirim.');
  const st = localSvc.mbStatus();
  const docs = Object.values(st.pending_docs || {}).reduce((a, b) => a + Number(b || 0), 0);
  if (st.ready && (st.pending_shifts || docs)) {
    throw userError(`Masih ada data yang belum terkirim ke kantor (${st.pending_shifts} shift, ${docs} dokumen). Tekan Kirim Sekarang di kartu Mother Base, lalu coba lagi.`);
  }
  const fresh = await Database.open(null);
  const res = await db.replaceWith(fresh.exportBuffer(), path.join(DATA_DIR, 'backup'), { prefix: 'sebelum-reset' });
  localSvc = createServices(db, secrets);
  svc = localSvc;
  // Data toko lain di komputer ini: draft penjualan & file laporan tutup shift
  try { fs.rmSync(path.join(DATA_DIR, 'drafts.json'), { force: true }); } catch (_) { /* dibiarkan */ }
  drafts = createDraftStore(DATA_DIR);
  const repRoot = reportsRoot();
  for (const d of fs.existsSync(repRoot) ? fs.readdirSync(repRoot) : []) {
    if (/^Shift_/.test(d)) { try { fs.rmSync(path.join(repRoot, d), { recursive: true, force: true }); } catch (_) { /* dicoba lagi saat pembersihan 7 hari */ } }
  }
  clearOpenDir();
  session = null;
  setTimeout(() => win && win.reload(), 300);
  return { backupFile: res.backupFile };
}

async function resetDemo() {
  requireDemo();
  const fresh = await Database.open(null);
  seedDemo(createServices(fresh));
  await db.replaceWith(fresh.exportBuffer(), null);
  localSvc = createServices(db, secrets);
  svc = localSvc;
  session = null;
  setTimeout(() => win.reload(), 300);
  return true;
}

// ---------------------------------------------------------------- Mode komputer & jaringan
async function connectionStatus() {
  const base = {
    mode: device.mode,
    port: Number(device.server_port) || DEFAULT_PORT,
    addresses: device.mode === 'server' ? lanAddresses() : [],
    server: device.mode === 'client' ? `${device.server_host}:${device.server_port}` : '',
    connected: true,
  };
  if (isClient()) {
    base.connected = await pingGudang();
    base.emergency = offline.summary();
    // Setelah update, PC Server & PC Kasir harus memakai versi yang sama
    base.version = APP_VERSION;
    base.server_version = serverVersion;
    base.version_mismatch = base.connected && serverVersion !== APP_VERSION;
  }
  return base;
}

function deviceInfo() {
  return {
    mode: device.mode,
    server_host: device.server_host,
    server_port: Number(device.server_port) || DEFAULT_PORT,
    pair_key: device.pair_key,
    server_pair_key: device.server_pair_key,
    addresses: lanAddresses(),
  };
}

function normalizeHost(h) {
  const host = String(h || '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw userError('Alamat IP PC Server tidak valid. Contoh: 192.168.1.10');
  return host;
}

function normalizePort(p) {
  const port = Number(p || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw userError('Port harus angka 1024–65535.');
  return port;
}

async function testConnection({ host, port, key }) {
  const c = createRemoteClient({ host: normalizeHost(host), port: normalizePort(port), key: String(key || '').trim(), timeout: 5000 });
  const p = await c.ping();
  await c.rpc('meta', []); // memastikan kode pasangan benar
  return { store_name: p.store_name || '-' };
}

async function saveDeviceMode({ mode, host, port, key }) {
  if (DEMO) throw userError('Versi DEMO selalu berjalan Mandiri. Mode komputer diatur di aplikasi asli.');
  if (!MODES.includes(mode)) throw userError('Mode tidak dikenal.');
  const patch = { mode };
  if (mode === 'client') {
    patch.server_host = normalizeHost(host);
    patch.server_port = normalizePort(port);
    patch.pair_key = String(key || '').trim();
    if (!/^\d{6}$/.test(patch.pair_key)) throw userError('Kode pasangan harus 6 digit (lihat di Pengaturan PC Server).');
    await testConnection({ host: patch.server_host, port: patch.server_port, key: patch.pair_key });
  }
  if (mode === 'server') {
    patch.server_port = normalizePort(port);
    if (!device.server_pair_key) patch.server_pair_key = newPairKey();
  }
  device = saveDevice(DATA_DIR, patch);
  setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
  return true;
}

// ---------------------------------------------------------------- Login & hak akses
async function authStatus() {
  const needsSetup = isClient()
    ? await viaGudang(() => svc.needsSetup(), () => false).catch(() => false)
    : svc.needsSetup();
  return { user: session, needsSetup, roles: ROLE_LABEL, demo: DEMO ? { accounts: DEMO_ACCOUNTS } : null };
}

async function login(a) {
  let u;
  try {
    u = isClient() ? await viaGudang(() => svc.verifyLogin(a), () => offline.verifyLogin(a)) : svc.verifyLogin(a);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan PIN
    throw err;
  }
  session = { id: u.id, name: u.name, role: u.role };
  return session;
}

// Akun pertama (database belum punya akun) selalu Admin
async function setupAdmin({ name, pin }) {
  if (!(await svc.needsSetup())) throw userError('Akun admin sudah dibuat. Silakan login.');
  await svc.saveUser({ name, pin, role: 'admin', active: true });
  if (isClient()) maintainOffline({ forceRefresh: true });
  return login({ name, pin });
}

async function saveUser(a) {
  const u = await svc.saveUser(a);
  if (isClient()) maintainOffline({ forceRefresh: true }); // PIN baru juga berlaku saat MODE DARURAT
  if (session && session.id === u.id) session = { id: u.id, name: u.name, role: u.role };
  return u;
}

const ALL = ['admin', 'gudang', 'kasir'];
const GUDANG = ['admin', 'gudang'];
const KASIR = ['admin', 'kasir'];
// Bisa dipanggil tanpa login
const PUBLIC = new Set(['auth:status', 'auth:setup', 'auth:login', 'auth:logout', 'meta', 'app:status', 'app:info', 'demo:reset']);
// Perintah yang tidak tercantum hanya untuk Admin
const ACCESS = {
  'settings:get': ALL, 'printer:list': ALL, 'stock:low': ALL, 'shift:get': ALL,
  'products:list': ALL, 'products:categories': ALL, 'products:get': ALL, 'products:findByCode': ALL, 'products:search': ALL,
  'products:pullMaster': ALL,
  'products:save': GUDANG, 'products:delete': GUDANG, 'products:import': GUDANG, 'products:template': GUDANG,
  'transfers:create': GUDANG, 'transfers:list': GUDANG, 'transfers:get': GUDANG,
  'receptions:create': GUDANG, 'receptions:list': GUDANG, 'receptions:get': GUDANG,
  'receptions:template': GUDANG, 'receptions:importFile': GUDANG, 'receptions:import': GUDANG,
  // Stok opname manual (form scan) hanya Admin; Gudang hanya lewat template Excel (unduh → isi Fisik → import)
  'opname:list': GUDANG, 'opname:get': GUDANG, 'opname:template': GUDANG, 'opname:importFile': GUDANG, 'opname:import': GUDANG,
  'rcDrafts:list': GUDANG, 'rcDrafts:count': GUDANG, 'rcDrafts:create': GUDANG, 'rcDrafts:process': GUDANG, 'rcDrafts:delete': GUDANG,
  'labels:designs': GUDANG, 'labels:saveDesign': GUDANG, 'labels:deleteDesign': GUDANG, 'labels:setDefault': GUDANG,
  'labels:fromReception': GUDANG, 'labels:preview': GUDANG, 'labels:print': GUDANG,
  'drafts:list': KASIR, 'drafts:save': KASIR, 'drafts:take': KASIR, 'drafts:delete': KASIR,
  'shift:open': KASIR, 'shift:summary': KASIR, 'shift:receipt': KASIR, 'shift:close': KASIR, 'shift:printRecap': KASIR,
  // Pesanan: semua peran boleh melihat (Gudang tahu barang yang perlu dipesan); membuat/mengambil/membatalkan = Kasir & Admin
  'orders:list': ALL, 'orders:get': ALL, 'orders:due': ALL,
  'orders:create': KASIR, 'orders:complete': KASIR, 'orders:cancel': KASIR, 'orders:print': KASIR,
  'sales:checkout': KASIR, 'receipt:print': KASIR, 'receipt:reprint': KASIR, 'receipt:void': KASIR,
  'drawer:open': KASIR, // buka laci kasir (tanpa transaksi, tidak dicatat)
};

function checkAccess(channel) {
  if (PUBLIC.has(channel)) return;
  if (!session) throw userError('Silakan login terlebih dahulu.');
  const allowed = ACCESS[channel] || ['admin'];
  if (!allowed.includes(session.role)) throw userError(`Akses ditolak untuk peran ${ROLE_LABEL[session.role]}.`);
}

// ---------------------------------------------------------------- IPC
const handlers = {
  'auth:status': () => authStatus(),
  'demo:reset': () => resetDemo(),
  'auth:setup': (a) => setupAdmin(a),
  'auth:login': (a) => login(a),
  'auth:logout': () => { session = null; return true; },
  'users:list': () => svc.listUsers(),
  'users:save': (a) => saveUser(a),
  'users:delete': (a) => svc.deleteUser(a),
  'drafts:list': () => drafts.list(),
  'drafts:save': (a) => drafts.save({ ...a, cashier: session.name }),
  'drafts:take': ({ id }) => drafts.take(id),
  'drafts:delete': ({ id }) => drafts.remove(id),

  'app:info': () => ({
    version: APP_VERSION,
    dbFile: isClient() ? `Di PC Server (${device.server_host}:${device.server_port})` : DB_FILE,
    mode: device.mode,
  }),
  // Hanya Admin (tidak tercantum di ACCESS): lokasi file laporan tidak boleh diketahui kasir
  'app:reportsDir': () => (isClient() ? 'Di PC Server (laporan tutup shift dibuat di sana)' : reportsRoot()),
  'app:status': () => connectionStatus(),
  // Laporan tutup shift terenkripsi: hanya Admin (tidak tercantum di ACCESS), hanya di PC pemilik database
  'reports:list': () => { requireLocalReports(); return reportCrypt.listReports(reportsRoot()); },
  'reports:open': (a) => openReport(a),
  'db:backup': () => backupDatabase(),
  'db:restore': () => restoreDatabase(),
  'app:reset': (a) => resetProgram(a), // hanya Admin (tidak tercantum di ACCESS)
  'db:openFolder': () => shell.openPath(DATA_DIR),

  // Mother base (hanya Admin; pengiriman berjalan di PC pemilik database)
  'mb:status': async () => ({ ...(await svc.mbStatus()), client: isClient(), demo: DEMO }),
  'mb:save': (a) => { requireLocalDb(); return { ...localSvc.mbSaveConfig(a), client: false, demo: DEMO }; },
  'mb:test': () => { requireLocalDb(); return mb.tes(); },
  'mb:sendNow': async () => {
    requireLocalDb();
    const result = await mb.kirim({ force: true });
    return { result, status: { ...localSvc.mbStatus(), client: false, demo: DEMO } };
  },
  'mb:pullMaster': async () => {
    requireLocalDb();
    const result = await mb.ambilMaster({ full: true });
    return { result, status: { ...localSvc.mbStatus(), client: false, demo: DEMO } };
  },
  'device:get': () => deviceInfo(),
  'device:test': (a) => testConnection(a),
  'device:save': (a) => saveDeviceMode(a),
  'device:newKey': () => { device = saveDevice(DATA_DIR, { server_pair_key: newPairKey() }); return deviceInfo(); },
  meta: () => viaGudang(() => svc.meta(), () => offline.meta()),

  'settings:get': () => getSettings(),
  // PIN Pembatalan (hanya Admin): PIN untuk kepala toko menyetujui batal nota tanpa mengetahui PIN Admin
  'settings:voidPin': (a = {}) => svc.voidPinInfo({ reveal: !!a.reveal }),
  'settings:setVoidPin': (a) => svc.setVoidPin(a),
  'settings:clearVoidPin': () => svc.clearVoidPin(),
  'settings:save': async (a) => {
    const own = {};
    for (const k of PRINTER_KEYS) if (a[k] !== undefined) own[k] = k === 'auto_print' ? (a[k] === true || a[k] === '1' ? '1' : '0') : String(a[k]);
    if (own.paper_width && !['58', '80'].includes(own.paper_width)) throw userError('Lebar kertas harus 58 mm atau 80 mm.');
    if (own.receipt_font_scale !== undefined && !FONT_SCALES.includes(own.receipt_font_scale)) throw userError('Ukuran huruf nota tidak dikenal.');
    if (own.receipt_offset !== undefined) {
      const o = Number(String(own.receipt_offset).replace(',', '.'));
      if (!Number.isFinite(o) || o < 0 || o > 10) throw userError('Geser cetakan nota harus 0–10 mm.');
      own.receipt_offset = String(o);
    }
    if (Object.keys(own).length) device = saveDevice(DATA_DIR, own);
    const shared = { ...a };
    for (const k of PRINTER_KEYS) delete shared[k];
    if (Object.keys(shared).length) await svc.saveSettings(shared);
    return getSettings();
  },

  'products:list': (a) => svc.listProducts(a),
  'products:categories': () => svc.categories(),
  'products:get': ({ sku }) => viaGudang(() => svc.getProduct(sku), () => offline.getProduct(sku)),
  'products:findByCode': (a) => viaGudang(() => svc.findByCode(a), () => offline.findByCode(a)),
  'products:search': (a) => viaGudang(() => svc.searchProducts(a), () => offline.searchProducts(a)),
  'products:save': (a) => svc.saveProduct(a),
  'products:delete': (a) => svc.deleteProduct(a),
  'products:import': () => importProducts(),
  'products:template': () => saveTemplate({
    title: 'Simpan template import', fileName: 'Template_Import_Barang.xlsx', sheet: 'Barang',
    headers: TEMPLATE_HEADERS, sample: TEMPLATE_SAMPLE, textCols: ['A', 'B'],
  }),
  'receptions:template': () => saveTemplate({
    title: 'Simpan template import penerimaan', fileName: 'Template_Import_Penerimaan.xlsx', sheet: 'Penerimaan',
    headers: RECEPTION_TEMPLATE_HEADERS, sample: RECEPTION_TEMPLATE_SAMPLE, textCols: ['A', 'C'],
  }),
  'receptions:importFile': () => pickSheetRows('Pilih file import penerimaan'),
  'receptions:import': (a) => svc.importReceptions(a),
  'rcDrafts:list': () => svc.listReceptionDrafts(),
  'rcDrafts:count': () => svc.countReceptionDrafts(),
  'rcDrafts:create': (a) => svc.createReceptionDraft(a),
  'rcDrafts:process': (a) => svc.processReceptionDraft(a),
  'rcDrafts:delete': (a) => svc.deleteReceptionDraft(a),
  'stock:low': (a) => svc.lowStock(a),

  'shift:get': async () => {
    if (!isClient()) return svc.getShift();
    if (!online && offline.hasCache()) return offline.getShift();
    const shift = await viaGudang(() => svc.getShift(), () => offline.getShift());
    if (online) offline.setShift(shift);
    return shift;
  },
  'shift:open': async (a) => {
    // Nama kasir di shift & nota = akun yang sedang login
    const shift = await svc.openShift({ ...a, cashier_name: session.name });
    if (isClient()) { offline.setShift(shift); maintainOffline({ forceRefresh: true }); }
    // Daftar barang & harga terbaru diambil di PC Server (tanpa menunggu; PC Server versi lama = dilewati)
    Promise.resolve().then(() => runMain('main.masterOnShiftOpen')).catch(() => {});
    return shift;
  },
  'shift:summary': () => svc.shiftSummary(),
  'shift:receipt': (a) => svc.receiptDetail(a),
  'shift:close': async (a) => {
    const r = await (isClient() ? closeShiftClient(a) : runMain('main.closeShift', a));
    // Rekap tercetak otomatis (ikut "Cetak nota otomatis"); gagal cetak tidak membatalkan tutup shift
    if (r && r.recap && (await getSettings()).auto_print !== '0') {
      try { await printShiftRecap(r.recap); } catch (err) { r.recap_print_error = err.message; }
    }
    return r;
  },
  'shift:printRecap': ({ recap } = {}) => printShiftRecap(recap, { reprint: true }),

  // Pesanan pelanggan (data di PC Server; cetak di printer komputer ini)
  'orders:list': (a) => svc.listOrders(a),
  'orders:get': (a) => svc.getOrder(a),
  'orders:due': () => svc.ordersDue(),
  'orders:create': async (a = {}) => {
    const o = await runMain('main.createOrder', { ...a, created_by: session.name });
    if ((await getSettings()).auto_print !== '0') {
      try { await printOrder(o); } catch (err) { o.print_error = err.message; }
    }
    return o;
  },
  'orders:complete': async (a = {}) => {
    const r = await runMain('main.completeOrder', { ...a, done_by: session.name });
    if ((await getSettings()).auto_print !== '0') {
      try { await printReceiptOnce(r.receipt); } catch (err) { r.print_error = err.message; }
    }
    return r;
  },
  'orders:cancel': async (a = {}) => {
    try {
      return await svc.cancelOrder({ ...a, requested_by: session.name });
    } catch (err) {
      if (/PIN Admin \/ PIN Pembatalan salah/.test(err.message)) await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan PIN
      throw err;
    }
  },
  'orders:print': async ({ order_no, reprint = true } = {}) => printOrder(await svc.getOrder({ order_no }), { reprint: reprint !== false }),
  'products:pullMaster': () => runMain('main.pullMaster'),
  'sales:checkout': (a) => (isClient() ? checkoutClient(a) : runMain('main.checkout', a)),
  'offline:markChecked': (a) => svc.markOfflineChecked(a),

  'printer:list': async () => (await win.webContents.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault })),
  'receipt:print': (receipt) => printReceiptOnce(receipt), // cetak pertama; berikutnya harus lewat receipt:reprint
  'receipt:reprint': (a) => reprintReceipt(a),
  // Batal nota: kasir meminta, Admin menyetujui dengan PIN. Peminta diambil dari akun yang login, bukan dari layar.
  'receipt:void': async (a = {}) => {
    try {
      return await runMain('main.voidReceipt', { ...a, requested_by: session.name });
    } catch (err) {
      if (/PIN Admin \/ PIN Pembatalan salah/.test(err.message)) await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan PIN
      throw err;
    }
  },
  'receipt:test': () => printReceipt({ ...SAMPLE_RECEIPT, created_at: localNow() }),
  // Buka laci lewat printer nota KOMPUTER INI (PC Kasir tidak lewat PC Server, jadi tetap jalan saat MODE DARURAT).
  // Printer nota kosong = printer default Windows. Mode uji (POS_PRINT_TO_PDF): perintahnya ditulis ke file.
  'drawer:open': async () => {
    const testDir = process.env.POS_PRINT_TO_PDF || '';
    let printerName = (await getSettings()).printer_name;
    if (!printerName && !testDir) {
      const def = (await win.webContents.getPrintersAsync()).find((p) => p.isDefault);
      printerName = def ? def.name : '';
    }
    return openDrawer({ printerName, dataDir: DATA_DIR, testDir });
  },
  // Pratinjau nota di Pengaturan: tampilan sama dengan hasil cetak (font, ukuran huruf, geser)
  'receipt:preview': async ({ settings }) => {
    const s = { ...(await getSettings()), ...(settings || {}) };
    const rows = buildReceiptRows({ ...SAMPLE_RECEIPT, created_at: localNow() }, s);
    return { lines: buildReceiptLines({ ...SAMPLE_RECEIPT, created_at: localNow() }, s), ...receiptFragment(rows, s.paper_width, { offsetMm: s.receipt_offset, fontScale: s.receipt_font_scale }) };
  },

  'labels:designs': () => svc.listLabelDesigns(),
  'labels:saveDesign': (a) => svc.saveLabelDesign(a),
  'labels:deleteDesign': (a) => svc.deleteLabelDesign(a),
  'labels:setDefault': (a) => svc.setDefaultLabelDesign(a),
  'labels:fromReception': (a) => svc.labelItemsFromReception(a),
  'labels:preview': async ({ config, items, single }) => {
    const products = (await resolveLabelItems((items || []).map((i) => ({ ...i, copies: 1 })))).map((i) => i.product);
    return labelPreview(config, products.length ? products : [SAMPLE_PRODUCT], { single: !!single });
  },
  'labels:print': (a) => printLabels(a),

  'transfers:create': (a) => svc.createTransferDoc(a),
  'transfers:list': (a) => svc.listTransferDocs(a),
  'transfers:get': (a) => svc.getTransferDoc(a),

  'receptions:create': (a) => svc.createReception(a),
  'receptions:list': (a) => svc.listReceptions(a),
  'receptions:get': (a) => svc.getReception(a),

  'opname:create': (a) => svc.createOpname(a),
  'opname:list': (a) => svc.listOpnames(a),
  'opname:get': (a) => svc.getOpname(a),
  'opname:template': async () => saveTemplate({
    title: 'Simpan template stok opname', fileName: `Opname_${localNow().slice(0, 10)}.xlsx`,
    sheet: 'Opname', headers: OPNAME_TEMPLATE_HEADERS, sample: await svc.opnameSheet(), textCols: ['A'],
  }),
  // Hasil opname boleh Excel / CSV, atau PDF hasil "Save as PDF" Excel dari template opname
  'opname:importFile': () => pickSheetRows('Pilih file hasil stok opname (Excel / CSV / PDF)', { pdf: { headers: OPNAME_TEMPLATE_HEADERS, keyHeader: 'Kode' } }),
  'opname:import': (a) => svc.importOpname(a),
};

ipcMain.handle('api', async (_e, channel, args) => {
  const h = handlers[channel];
  if (!h) return { ok: false, error: `Perintah tidak dikenal: ${channel}` };
  try {
    checkAccess(channel);
    return { ok: true, data: await h(args || {}) };
  } catch (err) {
    if (!err.userFacing) console.error(`[${channel}]`, err);
    let msg = err.message || String(err);
    if (/UNIQUE constraint failed: products\.barcode/.test(msg)) msg = 'Barcode sudah dipakai barang lain.';
    else if (/UNIQUE constraint failed/.test(msg)) msg = 'Data sudah ada (duplikat).';
    return { ok: false, error: msg, network: !!err.network };
  }
});

// ---------------------------------------------------------------- Jendela
function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0f1115',
    title: DEMO ? 'POS Tri-Zone — DEMO (data latihan)' : 'POS Tri-Zone',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Tampilkan jendela sekali saja. Cadangan bila ready-to-show tidak terpicu (mis. zoom halaman diubah sebelum
  // gambar pertama): setelah halaman selesai dimuat, atau paling lambat 5 detik setelah dibuat.
  let shown = false;
  const showWindow = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.maximize();
    win.show();
  };
  win.once('ready-to-show', showWindow);
  win.webContents.once('did-finish-load', () => setTimeout(showWindow, 300));
  setTimeout(showWindow, 5000);
  win.webContents.on('before-input-event', (_e, input) => {
    // Alat pengembang: Ctrl+Shift+I (F12 dipakai kasir untuk Uang Diterima)
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Hanya muat ulang halaman aplikasi sendiri (setelah login / keluar) yang diizinkan
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function openLocalDatabase() {
  db = await Database.open(DB_FILE);
  db.backup(path.join(DATA_DIR, 'backup'));
  localSvc = createServices(db, secrets);
  svc = localSvc;
  if (DEMO && localSvc.needsSetup()) seedDemo(localSvc);
  mb = createMotherbase({ svc: localSvc, appVersion: APP_VERSION, demo: DEMO });
  localSvc.mbQueueHistory(); // shift di Riwayat Shift yang ditutup sebelum ada mother base
  // Migrasi sekali: pengaturan printer lama di database → device.json komputer ini
  if (!device._exists) {
    const old = localSvc.getSettings();
    const patch = {};
    for (const k of PRINTER_KEYS) if (old[k] !== undefined && old[k] !== '') patch[k] = old[k];
    device = saveDevice(DATA_DIR, patch);
  }
}

async function startup() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  drafts = createDraftStore(DATA_DIR);
  if (isClient()) {
    remote = createRemoteClient({ host: device.server_host, port: Number(device.server_port) || DEFAULT_PORT, key: device.pair_key, version: APP_VERSION });
    svc = remote.services;
    offline = createOfflineStore(DATA_DIR);
    // Cek cepat sebelum jendela dibuka: bila gudang mati, aplikasi langsung memakai data darurat
    await pingGudang(2000);
    setInterval(() => pingGudang(), 15000);
    return;
  }
  await openLocalDatabase();
  clearOpenDir();
  // Laporan tutup shift disimpan 7 hari terakhir; yang lebih lama dihapus (saat start, tiap jam, dan setiap tutup shift)
  pruneReportsNow();
  // Laporan dari versi sebelumnya (belum terenkripsi) ikut diamankan
  try {
    const n = reportCrypt.encryptExisting(reportsRoot(), reportKey());
    if (n) console.log(`[laporan] ${n} file laporan lama dienkripsi`);
  } catch (err) { console.error('[laporan] enkripsi file lama gagal:', err.message); }
  // Riwayat shift lebih lama dari 4 hari dihapus saat start & tiap jam (juga setiap tutup shift).
  const pruneHistory = () => {
    try { localSvc.pruneShiftHistory(); } catch (err) { console.error('[riwayat shift]', err); }
    pruneReportsNow();
  };
  pruneHistory();
  setInterval(pruneHistory, 60 * 60 * 1000);
  // Mother base: kirim data yang menunggu / berubah sekali setelah aplikasi dibuka, lalu tiap 3 jam
  // (tutup shift mengirim langsung). Master barang TIDAK diambil berkala: hanya saat buka shift
  // (pullMasterOnShiftOpen) atau tombol manual. Semua berjalan di latar dan tidak menghentikan kasir.
  const mbTick = () => mb.tick({ pullMaster: false }).catch((err) => console.error('[mother base]', err));
  setTimeout(mbTick, 20 * 1000);
  setInterval(mbTick, MB_SEND_EVERY_MS);
  if (device.mode === 'server' && !DEMO) {
    if (!device.server_pair_key) device = saveDevice(DATA_DIR, { server_pair_key: newPairKey() });
    const port = Number(process.env.POS_SERVER_PORT || device.server_port) || DEFAULT_PORT;
    try {
      server = await startServer({
        port,
        host: process.env.POS_SERVER_HOST || '0.0.0.0',
        getKey: () => device.server_pair_key,
        call: serverCall,
        info: () => ({ store_name: localSvc.getSettings().store_name, version: APP_VERSION }),
      });
    } catch (err) {
      dialog.showErrorBox('Server jaringan gagal dijalankan', `${err.message}\n\nAplikasi tetap berjalan, tetapi komputer lain belum bisa terhubung.`);
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  // Satu file database hanya boleh dibuka oleh satu jendela aplikasi
  app.quit();
} else {
  app.on('second-instance', () => {
    // Dibuka lagi saat sudah berjalan: tampilkan jendela yang ada (juga bila masih tersembunyi)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) { win.maximize(); win.show(); }
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      await startup();
    } catch (err) {
      dialog.showErrorBox('Database gagal dibuka', `${DB_FILE}\n\n${err.message}`);
      app.quit();
      return;
    }
    Menu.setApplicationMenu(null);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    if (server) server.close();
    clearOpenDir();
  });
}

module.exports = { getServices: () => localSvc || svc, getMotherbase: () => mb };
