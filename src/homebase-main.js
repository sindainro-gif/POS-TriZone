'use strict';
// Mode HOMEBASE (Jalankan HOMEBASE.bat / --homebase): pusat data yang membaca paket dari banyak toko.
// Bagian proses utama Electron: pindai folder masuk berkala, dialog file, ekspor Excel, cadangan, dan kunci PIN.
const fs = require('fs');
const path = require('path');
const { openHomebase } = require('./homebase-store');
const { localNow } = require('./services');

const SCAN_MS = 60 * 1000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function userError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

const EXPORT_LABEL = { all: 'Semua', sales: 'Penjualan', stock: 'Stok', docs: 'Dokumen' };

async function createHomebaseApp({ dataDir, dialog, shell, getWin, saveWorkbook, appVersion = '', documentsDir = dataDir }) {
  const dbFile = path.join(dataDir, 'homebase.db');
  const hb = await openHomebase(dbFile);
  hb.db.backup(path.join(dataDir, 'backup'), 14, 'homebase');
  let unlocked = !hb.hasPin();
  let scanError = '';
  let timer = null;

  // Pindai folder masuk (folder Google Drive). Gagal membuka folder dicatat, dicoba lagi di pindai berikutnya.
  function scan() {
    const dir = hb.config().inbox_dir;
    if (!dir) return null;
    try {
      const r = hb.scanFolder(dir);
      scanError = '';
      return r;
    } catch (e) {
      scanError = e.message;
      if (!e.userFacing) console.error('[homebase]', e);
      return { error: e.message };
    }
  }

  function status() {
    const c = hb.config();
    return {
      locked: !unlocked, has_pin: c.has_pin, inbox_dir: c.inbox_dir, last_scan: c.last_scan, scan_error: scanError,
      zones: c.zones, version: appVersion, data_dir: dataDir, db_file: dbFile, stores: unlocked ? hb.stores() : [],
    };
  }

  async function pickFolder() {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Pilih folder Google Drive berisi paket dari toko', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  }

  async function backup() {
    const name = `Homebase-Cadangan-${localNow().slice(0, 16).replace(/[-: ]/g, '')}.db`;
    let target;
    if (process.env.POS_SAVE_DIR) {
      fs.mkdirSync(process.env.POS_SAVE_DIR, { recursive: true });
      target = path.join(process.env.POS_SAVE_DIR, name);
    } else {
      const r = await dialog.showSaveDialog(getWin(), {
        title: 'Cadangkan database Homebase', defaultPath: path.join(documentsDir, name), filters: [{ name: 'Database Homebase', extensions: ['db'] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, hb.db.exportBuffer());
    return target;
  }

  function exportName({ kind = 'all', from = '', to = '' } = {}) {
    const range = kind === 'stock' ? localNow().slice(0, 10) : `${from || 'awal'}_${to || localNow().slice(0, 10)}`;
    return `Homebase_${EXPORT_LABEL[kind] || 'Data'}_${range}.xlsx`;
  }

  const handlers = {
    'hb:status': () => status(),
    'hb:unlock': async ({ pin } = {}) => {
      if (!hb.verifyPin(pin)) {
        await delay(800); // memperlambat tebak-tebakan PIN
        throw userError('PIN salah.');
      }
      unlocked = true;
      return status();
    },
    'hb:lock': () => {
      unlocked = !hb.hasPin();
      return status();
    },
    'hb:setPin': ({ pin } = {}) => {
      hb.setPin(pin);
      return status();
    },
    'hb:dashboard': (a) => hb.dashboard(a),
    'hb:sales': (a) => hb.salesReport(a),
    'hb:receipt': (a) => hb.receiptLines(a),
    'hb:shift': (a) => hb.shiftDetail(a),
    'hb:stock': (a) => hb.stockList(a),
    'hb:docs': (a) => hb.docList(a),
    'hb:doc': (a) => hb.docDetail(a),
    'hb:imports': (a) => hb.importsList(a),
    'hb:stores': () => hb.stores(),
    'hb:deleteStore': (a) => hb.deleteStore(a),
    'hb:pickInbox': async () => {
      const dir = await pickFolder();
      if (!dir) return null;
      hb.setInbox(dir);
      return { status: status(), scan: scan() };
    },
    'hb:setInbox': ({ dir } = {}) => {
      hb.setInbox(dir);
      return { status: status(), scan: dir ? scan() : null };
    },
    'hb:scan': () => {
      if (!hb.config().inbox_dir) throw userError('Folder masuk belum diatur. Pilih folder Google Drive dulu.');
      const r = scan();
      if (r && r.error) throw userError(r.error);
      return r;
    },
    'hb:importFiles': async () => {
      const r = await dialog.showOpenDialog(getWin(), {
        title: 'Pilih file paket dari toko (TRZ_….json.gz)',
        filters: [{ name: 'Paket POS Tri-Zone', extensions: ['gz'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) return null;
      return hb.importFiles(r.filePaths, 'manual');
    },
    'hb:export': async (a = {}) => saveWorkbook({
      title: 'Simpan ekspor Excel Homebase', fileName: exportName(a), sheets: hb.exportSheets(a), csv: false,
    }),
    'hb:backup': () => backup(),
    'hb:openData': () => shell.openPath(dataDir),
  };

  const PUBLIC = new Set(['hb:status', 'hb:unlock']);
  function checkAccess(channel) {
    if (!PUBLIC.has(channel) && !unlocked) throw userError('Homebase terkunci. Masukkan PIN.');
  }

  return {
    hb,
    handlers,
    checkAccess,
    scan,
    start() {
      setTimeout(scan, 1500);
      timer = setInterval(scan, SCAN_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = { createHomebaseApp };
