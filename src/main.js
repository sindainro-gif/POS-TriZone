'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const { Database } = require('./db');
const { createServices, TEMPLATE_HEADERS, TEMPLATE_SAMPLE, localNow } = require('./services');
const reports = require('./reports');
const { buildReceiptLines, receiptPage } = require('./receipt');
const { labelPages, labelPreview } = require('./labels');
const { startServer, createRemoteClient, newPairKey, DEFAULT_PORT } = require('./remote');
const { loadDevice, saveDevice, PRINTER_KEYS, MODES } = require('./device');
const { createOfflineStore } = require('./offline');
const { ROLE_LABEL } = require('./auth');
const crypto = require('crypto');
const { seedDemo, DEMO_ACCOUNTS } = require('./demo');
const { createDraftStore } = require('./drafts');

// Versi DEMO (Jalankan DEMO.bat): data latihan di folder terpisah; mencetak ke printer sungguhan, email tidak dikirim
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
let session = null; // akun yang sedang login di komputer ini: { id, name, role }
let drafts; // draft penjualan yang ditahan (disimpan di komputer ini)
let device = loadDevice(DATA_DIR);
let win;
let closingShift = false;

const isClient = () => !DEMO && device.mode === 'client'; // demo selalu Mandiri

function reportsRoot() {
  if (process.env.POS_REPORTS_DIR) return process.env.POS_REPORTS_DIR;
  return DEMO ? path.join(DATA_DIR, 'Laporan-Demo') : path.join(app.getPath('documents'), 'POS-Laporan');
}

// Password SMTP dienkripsi dengan kunci akun Windows (DPAPI) bila tersedia.
const secrets = {
  encrypt: (s) => (s && safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s),
  decrypt: (s) => {
    if (s && s.startsWith('enc:')) {
      try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch (_) { return ''; }
    }
    return s || '';
  },
};

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

// ---------------------------------------------------------------- Email
function makeTransport(s) {
  if (!s.smtp_host) throw userError('Server SMTP belum diatur. Buka menu Pengaturan.');
  if (!s.owner_email) throw userError('Email owner belum diatur. Buka menu Pengaturan.');
  const port = Number(s.smtp_port) || 587;
  const sec = s.smtp_security || (port === 465 ? 'ssl' : 'starttls');
  return nodemailer.createTransport({
    host: s.smtp_host,
    port,
    secure: sec === 'ssl',
    requireTLS: sec === 'starttls',
    ignoreTLS: sec === 'none',
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
}

function explainSmtpError(err) {
  const map = {
    EAUTH: 'Login SMTP gagal — periksa username dan password (untuk Gmail gunakan App Password).',
    ECONNECTION: 'Tidak dapat terhubung ke server SMTP — periksa koneksi internet, host, dan port.',
    ETIMEDOUT: 'Koneksi ke server SMTP habis waktu — periksa koneksi internet.',
    ESOCKET: 'Koneksi ke server SMTP terputus — periksa port dan jenis keamanan (SSL/STARTTLS).',
    EDNS: 'Alamat server SMTP tidak ditemukan — periksa host dan koneksi internet.',
    EENVELOPE: 'Alamat email pengirim/penerima ditolak server.',
  };
  return userError(`${map[err.code] || 'Gagal mengirim email.'} (${err.message})`);
}

async function sendMail(s, message) {
  // Demo: email tidak dikirim sungguhan; balasan "250" agar alur tutup shift bisa dilatih sampai selesai
  if (DEMO) return { response: '250 OK (DEMO: email tidak benar-benar dikirim)' };
  const transport = makeTransport(s);
  const from = s.smtp_from || s.smtp_user;
  if (!from) throw userError('Email pengirim belum diatur. Buka menu Pengaturan.');
  try {
    const info = await transport.sendMail({ from: `"POS ${s.store_name}" <${from.replace(/^.*<|>$/g, '')}>`, to: s.owner_email, ...message });
    return info;
  } catch (err) {
    throw explainSmtpError(err);
  } finally {
    transport.close();
  }
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
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page.html));
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

async function printReceipt(receipt, { reprint = false } = {}) {
  const s = await getSettings();
  const page = receiptPage(buildReceiptLines(receipt, s, { reprint }), s.paper_width);
  return printPage(page, { deviceName: s.printer_name, pdfName: receipt.receipt_no, what: 'Nota' });
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

// Tutup shift tanpa menghitung uang laci (tidak ada uang tunai seharusnya / uang fisik / selisih)
async function closeShiftLocal({ notes } = {}) {
  if (closingShift) throw userError('Proses tutup shift sedang berjalan.');
  const settings = localSvc.getSettingsRaw();
  makeTransport(settings); // validasi pengaturan sebelum membuat file
  const summary = localSvc.shiftSummary();
  if (!summary.shift) throw userError('Tidak ada shift aktif.');

  closingShift = true;
  try {
    const closedAt = localNow();
    const stamp = closedAt.replace(/[-:]/g, '').replace(' ', '_');
    const dir = path.join(reportsRoot(), `Shift_${stamp}`);
    fs.mkdirSync(dir, { recursive: true });

    const ctx = { store: settings, summary, closedAt, notes: String(notes || '').trim(), lowStock: localSvc.lowStock({ limit: 100 }) };
    const files = {
      [`Rekap_Shift_${stamp}.pdf`]: await htmlToPdf(reports.summaryHtml(ctx)),
      [`Penjualan_Shift_${stamp}.csv`]: reports.salesCsv(localSvc.shiftSalesRows()),
      [`Snapshot_Stok_${stamp}.csv`]: reports.stockCsv(localSvc.stockSnapshot()),
    };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);

    const info = await sendMail(settings, {
      subject: `[${settings.store_name}] Rekap Shift ${summary.shift.cashier_name} — ${closedAt} — Omset Rp ${summary.totals.revenue.toLocaleString('id-ID')}`,
      text: reports.summaryText(ctx),
      attachments: Object.keys(files).map((name) => ({ filename: name, path: path.join(dir, name) })),
    });
    const response = String(info.response || '');
    if (!/^250\b/.test(response)) {
      throw userError(`Server SMTP tidak membalas "250 OK" (balasan: ${response || '-'}). Data shift TIDAK dihapus.`);
    }
    localSvc.purgeShift();
    return { dir, response, revenue: summary.totals.revenue, receipts: summary.totals.receipts, onServer: device.mode === 'server' };
  } finally {
    closingShift = false;
  }
}

async function testEmailLocal() {
  const s = localSvc.getSettingsRaw();
  const info = await sendMail(s, {
    subject: `[${s.store_name}] Tes email POS Tri-Zone`,
    text: `Email tes dari POS Tri-Zone pada ${localNow()}.\nJika email ini diterima, pengaturan SMTP sudah benar.`,
  });
  return { response: String(info.response || '') };
}

// Perintah yang boleh dipanggil PC kasir lewat jaringan
const SERVER_MAIN = {
  'main.checkout': checkoutLocal,
  'main.closeShift': closeShiftLocal,
  'main.testEmail': testEmailLocal,
};
const REMOTE_BLOCKED = new Set(['getSettingsRaw', 'purgeShift', 'checkout']);

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
  try { await remote.ping(timeout); online = true; } catch (_) { online = false; }
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
    if (left) throw userError(`Masih ada ${left} transaksi MODE DARURAT yang belum terkirim ke PC Gudang. Pastikan PC Gudang terhubung, tunggu sampai terkirim, lalu tutup shift.`);
  }
  const r = await runMain('main.closeShift', a);
  offline.setShift(null);
  return r;
}

// ---------------------------------------------------------------- Import / template Excel
async function importProducts() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pilih file import barang',
    filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const wb = XLSX.readFile(r.filePaths[0], { raw: false, cellText: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: '' });
  return { file: path.basename(r.filePaths[0]), ...(await svc.importRows(rows)) };
}

async function saveTemplate() {
  const r = await dialog.showSaveDialog(win, {
    title: 'Simpan template import',
    defaultPath: path.join(app.getPath('documents'), 'Template_Import_Barang.xlsx'),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...TEMPLATE_SAMPLE]);
  // Kolom Barcode & SKU sebagai teks agar angka panjang tidak berubah jadi notasi ilmiah
  for (let row = 1; row <= TEMPLATE_SAMPLE.length; row++) {
    for (const col of ['A', 'B']) {
      const c = ws[`${col}${row + 1}`];
      if (c) { c.t = 's'; c.z = '@'; }
    }
  }
  ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Barang');
  XLSX.writeFile(wb, r.filePath, r.filePath.toLowerCase().endsWith('.csv') ? { bookType: 'csv', FS: ';' } : undefined);
  return r.filePath;
}

// ---------------------------------------------------------------- Cadangkan / pulihkan database
function requireLocalDb() {
  if (isClient()) throw userError('Komputer ini terhubung ke PC gudang. Cadangkan / pulihkan database dilakukan di PC gudang.');
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
    detail: `${path.basename(r.filePaths[0])}\nBerisi ${info.products} barang, ${info.receptions} penerimaan, ${info.sales} baris penjualan shift.\n\nData saat ini akan disimpan dulu ke folder backup sebelum diganti.${device.mode === 'server' ? '\n\nPC kasir yang terhubung akan langsung memakai data ini.' : ''}`,
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
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw userError('Alamat IP PC gudang tidak valid. Contoh: 192.168.1.10');
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
    if (!/^\d{6}$/.test(patch.pair_key)) throw userError('Kode pasangan harus 6 digit (lihat di Pengaturan PC gudang).');
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
  'products:save': GUDANG, 'products:delete': GUDANG, 'products:import': GUDANG, 'products:template': GUDANG,
  'transfers:create': GUDANG, 'transfers:list': GUDANG,
  'receptions:create': GUDANG, 'receptions:list': GUDANG, 'receptions:get': GUDANG,
  'labels:designs': GUDANG, 'labels:saveDesign': GUDANG, 'labels:deleteDesign': GUDANG, 'labels:setDefault': GUDANG,
  'labels:fromReception': GUDANG, 'labels:preview': GUDANG, 'labels:print': GUDANG,
  'drafts:list': KASIR, 'drafts:save': KASIR, 'drafts:take': KASIR, 'drafts:delete': KASIR,
  'shift:open': KASIR, 'shift:summary': KASIR, 'shift:receipt': KASIR, 'shift:close': KASIR,
  'sales:checkout': KASIR, 'receipt:print': KASIR, 'receipt:reprint': KASIR, 'app:openPath': KASIR,
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
    version: app.getVersion(),
    dbFile: isClient() ? `Di PC gudang (${device.server_host}:${device.server_port})` : DB_FILE,
    reportsDir: isClient() ? `Di PC gudang (laporan tutup shift dibuat di sana)` : reportsRoot(),
    mode: device.mode,
  }),
  'app:status': () => connectionStatus(),
  'app:openReports': () => { requireLocalDb(); fs.mkdirSync(reportsRoot(), { recursive: true }); return shell.openPath(reportsRoot()); },
  'app:openPath': ({ dir }) => (isClient() ? null : shell.openPath(dir)),
  'db:backup': () => backupDatabase(),
  'db:restore': () => restoreDatabase(),
  'db:openFolder': () => shell.openPath(DATA_DIR),
  'device:get': () => deviceInfo(),
  'device:test': (a) => testConnection(a),
  'device:save': (a) => saveDeviceMode(a),
  'device:newKey': () => { device = saveDevice(DATA_DIR, { server_pair_key: newPairKey() }); return deviceInfo(); },
  meta: () => viaGudang(() => svc.meta(), () => offline.meta()),

  'settings:get': () => getSettings(),
  'settings:save': async (a) => {
    const own = {};
    for (const k of PRINTER_KEYS) if (a[k] !== undefined) own[k] = k === 'auto_print' ? (a[k] === true || a[k] === '1' ? '1' : '0') : String(a[k]);
    if (own.paper_width && !['58', '80'].includes(own.paper_width)) throw userError('Lebar kertas harus 58 mm atau 80 mm.');
    if (Object.keys(own).length) device = saveDevice(DATA_DIR, own);
    const shared = { ...a };
    for (const k of PRINTER_KEYS) delete shared[k];
    if (Object.keys(shared).length) await svc.saveSettings(shared);
    return getSettings();
  },
  'settings:testEmail': () => runMain('main.testEmail'),

  'products:list': (a) => svc.listProducts(a),
  'products:categories': () => svc.categories(),
  'products:get': ({ sku }) => viaGudang(() => svc.getProduct(sku), () => offline.getProduct(sku)),
  'products:findByCode': (a) => viaGudang(() => svc.findByCode(a), () => offline.findByCode(a)),
  'products:search': (a) => viaGudang(() => svc.searchProducts(a), () => offline.searchProducts(a)),
  'products:save': (a) => svc.saveProduct(a),
  'products:delete': (a) => svc.deleteProduct(a),
  'products:import': () => importProducts(),
  'products:template': () => saveTemplate(),
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
    return shift;
  },
  'shift:summary': () => svc.shiftSummary(),
  'shift:receipt': (a) => svc.receiptDetail(a),
  'shift:close': (a) => (isClient() ? closeShiftClient(a) : runMain('main.closeShift', a)),
  'sales:checkout': (a) => (isClient() ? checkoutClient(a) : runMain('main.checkout', a)),
  'offline:markChecked': (a) => svc.markOfflineChecked(a),

  'printer:list': async () => (await win.webContents.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault })),
  'receipt:print': (receipt) => printReceipt(receipt),
  'receipt:reprint': async (a) => printReceipt(await svc.receiptForReprint(a), { reprint: true }),
  'receipt:test': () => printReceipt({ ...SAMPLE_RECEIPT, created_at: localNow() }),
  'receipt:preview': async ({ settings }) => buildReceiptLines({ ...SAMPLE_RECEIPT, created_at: localNow() }, { ...(await getSettings()), ...(settings || {}) }),

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

  'transfers:create': (a) => svc.createTransfer(a),
  'transfers:list': (a) => svc.listTransfers(a),

  'receptions:create': (a) => svc.createReception(a),
  'receptions:list': (a) => svc.listReceptions(a),
  'receptions:get': (a) => svc.getReception(a),
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
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
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
    remote = createRemoteClient({ host: device.server_host, port: Number(device.server_port) || DEFAULT_PORT, key: device.pair_key });
    svc = remote.services;
    offline = createOfflineStore(DATA_DIR);
    // Cek cepat sebelum jendela dibuka: bila gudang mati, aplikasi langsung memakai data darurat
    await pingGudang(2000);
    setInterval(() => pingGudang(), 15000);
    return;
  }
  await openLocalDatabase();
  if (device.mode === 'server' && !DEMO) {
    if (!device.server_pair_key) device = saveDevice(DATA_DIR, { server_pair_key: newPairKey() });
    const port = Number(process.env.POS_SERVER_PORT || device.server_port) || DEFAULT_PORT;
    try {
      server = await startServer({
        port,
        host: process.env.POS_SERVER_HOST || '0.0.0.0',
        getKey: () => device.server_pair_key,
        call: serverCall,
        info: () => ({ store_name: localSvc.getSettings().store_name }),
      });
    } catch (err) {
      dialog.showErrorBox('Server jaringan gagal dijalankan', `${err.message}\n\nAplikasi tetap berjalan, tetapi PC kasir belum bisa terhubung.`);
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  // Satu file database hanya boleh dibuka oleh satu jendela aplikasi
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
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
  app.on('will-quit', () => { if (server) server.close(); });
}

module.exports = { getServices: () => localSvc || svc };
