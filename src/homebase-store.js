'use strict';
// Penyimpanan Homebase: database pusat (homebase.db) yang menampung paket data dari banyak toko.
// Tanpa Electron agar bisa diuji dengan Node biasa. Skema & aturan impor dijelaskan di docs/HOMEBASE.md.
//
// Aturan impor (aman diulang, satu paket = satu savepoint):
// - File yang sama persis (sha256) tidak diimpor dua kali; paket DEMO ditolak.
// - Snapshot: data keadaan terkini (barang, stok, akun, label, draft, pengaturan) DIGANTI per toko;
//   riwayat (penerimaan, mutasi, opname, transaksi darurat) ditambah/diperbarui dan tidak pernah dihapus.
//   Snapshot yang lebih lama dari snapshot terakhir toko itu hanya menambah riwayat (status "old").
// - Penjualan disimpan per shift: data shift dengan paket yang lebih baru menggantikan seluruh baris shift itu.
const fs = require('fs');
const path = require('path');
const { Database } = require('./db');
const { decodePackage, sha256, FILE_RE } = require('./homebase-package');
const { hashPin, checkPin } = require('./auth');
const { localNow, ZONE_LABEL } = require('./services');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stores (
  store_id TEXT PRIMARY KEY,
  store_name TEXT NOT NULL,
  store_address TEXT,
  app_version TEXT,
  settings TEXT,              -- JSON: nama, alamat, header/footer nota (snapshot terakhir)
  first_seen_at TEXT,         -- waktu Homebase pertama kali menerima data toko ini
  last_package_at TEXT,       -- waktu pembuatan paket terbaru (jam di toko)
  last_snapshot_at TEXT,
  last_shift_at TEXT,         -- waktu tutup shift terbaru
  last_import_at TEXT
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT UNIQUE NOT NULL,
  file_name TEXT,
  source TEXT,                -- folder / manual
  kind TEXT,                  -- snapshot / shift
  store_id TEXT,
  store_name TEXT,
  package_id TEXT,
  package_created_at TEXT,
  imported_at TEXT NOT NULL,
  status TEXT NOT NULL,       -- ok / old / error
  message TEXT,
  counts TEXT
);
CREATE TABLE IF NOT EXISTS products (
  store_id TEXT NOT NULL, sku TEXT NOT NULL, barcode TEXT, name TEXT, brand TEXT, category TEXT, unit_price INTEGER,
  base_unit TEXT, pack_unit TEXT, pack_ratio INTEGER, created_at TEXT, PRIMARY KEY (store_id, sku)
);
CREATE TABLE IF NOT EXISTS stock (
  store_id TEXT NOT NULL, sku TEXT NOT NULL, floor_stock INTEGER, warehouse_stock INTEGER, damaged_stock INTEGER, shopee_stock INTEGER,
  min_floor_alert INTEGER, sold_out_at TEXT, as_of TEXT, PRIMARY KEY (store_id, sku)
);
CREATE TABLE IF NOT EXISTS shifts (
  store_id TEXT NOT NULL, shift_uid TEXT NOT NULL, cashier_name TEXT, shift_start TEXT, closed_at TEXT, notes TEXT,
  receipts INTEGER, qty INTEGER, revenue INTEGER, cash_sales INTEGER, by_method TEXT, offline_receipts INTEGER,
  legacy INTEGER DEFAULT 0, package_at TEXT, PRIMARY KEY (store_id, shift_uid)
);
CREATE TABLE IF NOT EXISTS sales (
  store_id TEXT NOT NULL, shift_uid TEXT NOT NULL, receipt_no TEXT NOT NULL, line_no INTEGER NOT NULL, created_at TEXT, sku TEXT,
  product_name TEXT, qty INTEGER, unit_price INTEGER, line_total INTEGER, payment_method TEXT,
  PRIMARY KEY (store_id, shift_uid, receipt_no, line_no)
);
CREATE INDEX IF NOT EXISTS idx_sales_time ON sales(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_sku ON sales(store_id, sku);
CREATE TABLE IF NOT EXISTS receptions (
  store_id TEXT NOT NULL, reference_no TEXT NOT NULL, supplier_name TEXT, notes TEXT, received_at TEXT, total_items_count INTEGER,
  PRIMARY KEY (store_id, reference_no)
);
CREATE TABLE IF NOT EXISTS reception_items (
  store_id TEXT NOT NULL, reference_no TEXT NOT NULL, line_no INTEGER NOT NULL, sku TEXT, qty INTEGER, pack_type TEXT, destination TEXT,
  PRIMARY KEY (store_id, reference_no, line_no)
);
CREATE TABLE IF NOT EXISTS reception_drafts (
  store_id TEXT NOT NULL, draft_id INTEGER NOT NULL, reference_no TEXT, supplier_name TEXT, notes TEXT, code TEXT, name TEXT, qty INTEGER,
  pack_type TEXT, destination TEXT, source TEXT, created_at TEXT, resolved_at TEXT, reception_reference_no TEXT,
  PRIMARY KEY (store_id, draft_id)
);
CREATE TABLE IF NOT EXISTS transfers (
  store_id TEXT NOT NULL, doc_no TEXT NOT NULL, from_zone TEXT, to_zone TEXT, reason TEXT, created_at TEXT, line_count INTEGER, total_qty INTEGER,
  PRIMARY KEY (store_id, doc_no)
);
CREATE TABLE IF NOT EXISTS transfer_lines (
  store_id TEXT NOT NULL, doc_no TEXT NOT NULL, line_no INTEGER NOT NULL, sku TEXT, qty INTEGER, PRIMARY KEY (store_id, doc_no, line_no)
);
CREATE TABLE IF NOT EXISTS opnames (
  store_id TEXT NOT NULL, doc_no TEXT NOT NULL, zone TEXT, notes TEXT, created_at TEXT, count_at TEXT, line_count INTEGER,
  plus_qty INTEGER, minus_qty INTEGER, PRIMARY KEY (store_id, doc_no)
);
CREATE TABLE IF NOT EXISTS opname_lines (
  store_id TEXT NOT NULL, doc_no TEXT NOT NULL, line_no INTEGER NOT NULL, sku TEXT, system_qty INTEGER, counted_qty INTEGER, diff INTEGER,
  before_qty INTEGER, PRIMARY KEY (store_id, doc_no, line_no)
);
CREATE TABLE IF NOT EXISTS offline_sales (
  store_id TEXT NOT NULL, receipt_no TEXT NOT NULL, client_ref TEXT, cashier_name TEXT, created_at TEXT, synced_at TEXT, total INTEGER,
  status TEXT, notes TEXT, checked_at TEXT, PRIMARY KEY (store_id, receipt_no)
);
CREATE TABLE IF NOT EXISTS users (
  store_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT, active INTEGER, created_at TEXT, PRIMARY KEY (store_id, name)
);
CREATE TABLE IF NOT EXISTS label_designs (
  store_id TEXT NOT NULL, name TEXT NOT NULL, config TEXT, is_default INTEGER, updated_at TEXT, PRIMARY KEY (store_id, name)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

// Tabel yang berisi data per toko (urutan = urutan hapus)
const STORE_TABLES = ['sales', 'shifts', 'reception_items', 'receptions', 'reception_drafts', 'transfer_lines', 'transfers',
  'opname_lines', 'opnames', 'offline_sales', 'users', 'label_designs', 'stock', 'products', 'stores'];

const MAX_SHEET_ROWS = 1000000;

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const val = (x) => {
  if (x === undefined || x === null) return null;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'object') return JSON.stringify(x);
  return x;
};
const row = (...xs) => xs.map(val);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(day, n) {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// Penjualan shift berjalan (snapshot) tidak membawa total → dihitung dari barisnya
function summarize(lines) {
  const receipts = new Set();
  const methods = new Map();
  let qty = 0;
  let revenue = 0;
  let cash = 0;
  for (const l of lines) {
    receipts.add(l.receipt_no);
    qty += Number(l.qty) || 0;
    revenue += Number(l.line_total) || 0;
    if (l.payment_method === 'Tunai') cash += Number(l.line_total) || 0;
    const m = methods.get(l.payment_method) || { method: l.payment_method, receipts: new Set(), total: 0 };
    m.receipts.add(l.receipt_no);
    m.total += Number(l.line_total) || 0;
    methods.set(l.payment_method, m);
  }
  return {
    receipts: receipts.size, qty, revenue, cash_sales: cash,
    by_method: [...methods.values()].map((m) => ({ method: m.method, receipts: m.receipts.size, total: m.total })).sort((a, b) => b.total - a.total),
    offline_receipts: [...receipts].filter((r) => /^OFF-/.test(r)).length,
  };
}

async function openHomebase(file, opts = {}) {
  const db = await Database.open(file, { schema: SCHEMA, migrate: null });
  return createHomebase(db, opts);
}

function createHomebase(db, { now = localNow } = {}) {
  // ---------------------------------------------------------------- Utilitas
  function insertMany(sql, rows) {
    if (!rows.length) return;
    const st = db.db.prepare(sql);
    try { for (const r of rows) st.run(r); } finally { st.free(); }
  }
  const getSetting = (key, def = '') => {
    const r = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return r && r.value !== null ? r.value : def;
  };
  const setSetting = (key, value) => db.tx(() => db.run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value ?? '')],
  ));
  function range(from, to) {
    const today = now().slice(0, 10);
    const b = DATE_RE.test(String(to || '')) ? to : today;
    const a = DATE_RE.test(String(from || '')) ? from : addDays(b, -29);
    return a <= b ? [`${a} 00:00:00`, `${b} 23:59:59`] : [`${b} 00:00:00`, `${a} 23:59:59`];
  }

  // ---------------------------------------------------------------- Impor paket
  function upsertStore(pkg, { snapshotAt = null, settings, shiftClosedAt = null } = {}) {
    const sid = pkg.store.id;
    const cur = db.get('SELECT * FROM stores WHERE store_id = ?', [sid]);
    const newer = !cur || !cur.last_package_at || pkg.created_at >= cur.last_package_at;
    const maxOf = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
    db.run(
      `INSERT OR REPLACE INTO stores(store_id, store_name, store_address, app_version, settings, first_seen_at, last_package_at,
         last_snapshot_at, last_shift_at, last_import_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row(
        sid,
        newer ? pkg.store.name || (cur && cur.store_name) || sid : cur.store_name,
        newer ? pkg.store.address : cur.store_address,
        newer ? pkg.source.app_version : cur.app_version,
        settings !== undefined ? settings : cur && cur.settings,
        cur ? cur.first_seen_at : now(),
        newer ? pkg.created_at : cur.last_package_at,
        maxOf(cur && cur.last_snapshot_at, snapshotAt),
        maxOf(cur && cur.last_shift_at, shiftClosedAt),
        now(),
      ),
    );
  }

  // Data shift: paket lebih baru menang (tutup shift yang email-nya gagal lalu diulang tidak membuat data ganda)
  function applyShiftData(sid, sh, lines, packageAt, legacy) {
    const ex = db.get('SELECT package_at FROM shifts WHERE store_id = ? AND shift_uid = ?', [sid, sh.shift_uid]);
    if (ex && ex.package_at && ex.package_at > packageAt) return false;
    const s = sh.receipts === undefined ? summarize(lines) : sh;
    db.run(
      `INSERT OR REPLACE INTO shifts(store_id, shift_uid, cashier_name, shift_start, closed_at, notes, receipts, qty, revenue, cash_sales,
         by_method, offline_receipts, legacy, package_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row(sid, sh.shift_uid, sh.cashier_name, sh.shift_start, sh.closed_at || null, sh.notes || '', s.receipts, s.qty, s.revenue, s.cash_sales,
        s.by_method || [], s.offline_receipts || 0, legacy ? 1 : 0, packageAt),
    );
    db.run('DELETE FROM sales WHERE store_id = ? AND shift_uid = ?', [sid, sh.shift_uid]);
    insertMany(
      `INSERT OR REPLACE INTO sales(store_id, shift_uid, receipt_no, line_no, created_at, sku, product_name, qty, unit_price, line_total, payment_method)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      lines.map((l, i) => row(sid, sh.shift_uid, l.receipt_no, l.line_no || i + 1, l.created_at, l.sku, l.product_name, l.qty, l.unit_price,
        l.line_total, l.payment_method)),
    );
    return true;
  }

  function applyShift(pkg) {
    const sh = pkg.data.shift;
    const applied = applyShiftData(pkg.store.id, sh, arr(pkg.data.sales), pkg.created_at, !!(pkg.source.legacy || sh.legacy));
    upsertStore(pkg, { shiftClosedAt: sh.closed_at || null });
    return applied ? 'ok' : 'old';
  }

  // Riwayat dokumen: dokumen yang sama persis dilewati (snapshot berisi seluruh riwayat setiap kali)
  function upsertDocs({ sid, docs, table, key, sig, insertDoc, lineTable, insertLines, linesOf }) {
    const have = new Map(db.all(`SELECT * FROM ${table} WHERE store_id = ?`, [sid]).map((r) => [r[key], sig(r)]));
    for (const d of docs) {
      if (!d || !d[key]) continue;
      if (have.get(d[key]) === sig(d)) continue;
      db.run(insertDoc.sql, insertDoc.row(d));
      db.run(`DELETE FROM ${lineTable} WHERE store_id = ? AND ${key} = ?`, [sid, d[key]]);
      insertMany(insertLines.sql, arr(linesOf(d)).map((l, i) => insertLines.row(d, l, i)));
    }
  }

  function applySnapshot(pkg) {
    const sid = pkg.store.id;
    const d = pkg.data;
    const at = pkg.created_at;
    const cur = db.get('SELECT last_snapshot_at FROM stores WHERE store_id = ?', [sid]);
    const newest = !cur || !cur.last_snapshot_at || at >= cur.last_snapshot_at;

    upsertDocs({
      sid, docs: arr(d.receptions), table: 'receptions', key: 'reference_no', lineTable: 'reception_items',
      sig: (r) => `${r.received_at}|${r.total_items_count}`,
      insertDoc: {
        sql: 'INSERT OR REPLACE INTO receptions(store_id, reference_no, supplier_name, notes, received_at, total_items_count) VALUES(?, ?, ?, ?, ?, ?)',
        row: (r) => row(sid, r.reference_no, r.supplier_name, r.notes, r.received_at, r.total_items_count),
      },
      linesOf: (r) => r.items,
      insertLines: {
        sql: `INSERT OR REPLACE INTO reception_items(store_id, reference_no, line_no, sku, qty, pack_type, destination)
              VALUES(?, ?, ?, ?, ?, ?, ?)`,
        row: (r, l, i) => row(sid, r.reference_no, l.line_no || i + 1, l.sku, l.qty, l.pack_type, l.destination),
      },
    });
    upsertDocs({
      sid, docs: arr(d.transfers), table: 'transfers', key: 'doc_no', lineTable: 'transfer_lines',
      sig: (r) => `${r.created_at}|${r.line_count}|${r.total_qty}`,
      insertDoc: {
        sql: `INSERT OR REPLACE INTO transfers(store_id, doc_no, from_zone, to_zone, reason, created_at, line_count, total_qty)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        row: (r) => row(sid, r.doc_no, r.from_zone, r.to_zone, r.reason, r.created_at, r.line_count, r.total_qty),
      },
      linesOf: (r) => r.lines,
      insertLines: {
        sql: 'INSERT OR REPLACE INTO transfer_lines(store_id, doc_no, line_no, sku, qty) VALUES(?, ?, ?, ?, ?)',
        row: (r, l, i) => row(sid, r.doc_no, l.line_no || i + 1, l.sku, l.qty),
      },
    });
    upsertDocs({
      sid, docs: arr(d.opnames), table: 'opnames', key: 'doc_no', lineTable: 'opname_lines',
      sig: (r) => `${r.created_at}|${r.line_count}|${r.plus_qty}|${r.minus_qty}`,
      insertDoc: {
        sql: `INSERT OR REPLACE INTO opnames(store_id, doc_no, zone, notes, created_at, count_at, line_count, plus_qty, minus_qty)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row: (r) => row(sid, r.doc_no, r.zone, r.notes, r.created_at, r.count_at, r.line_count, r.plus_qty, r.minus_qty),
      },
      linesOf: (r) => r.lines,
      insertLines: {
        sql: `INSERT OR REPLACE INTO opname_lines(store_id, doc_no, line_no, sku, system_qty, counted_qty, diff, before_qty)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        row: (r, l, i) => row(sid, r.doc_no, l.line_no || i + 1, l.sku, l.system_qty, l.counted_qty, l.diff, l.before_qty),
      },
    });
    insertMany(
      `INSERT OR REPLACE INTO offline_sales(store_id, receipt_no, client_ref, cashier_name, created_at, synced_at, total, status, notes, checked_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      arr(d.offline_sales).map((o) => row(sid, o.receipt_no, o.client_ref, o.cashier_name, o.created_at, o.synced_at, o.total, o.status, o.notes, o.checked_at)),
    );

    if (newest) {
      // Keadaan terkini toko: diganti seluruhnya (barang yang dihapus di toko ikut hilang di sini)
      for (const t of ['products', 'stock', 'users', 'label_designs', 'reception_drafts']) db.run(`DELETE FROM ${t} WHERE store_id = ?`, [sid]);
      insertMany(
        `INSERT OR REPLACE INTO products(store_id, sku, barcode, name, brand, category, unit_price, base_unit, pack_unit, pack_ratio, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        arr(d.products).map((p) => row(sid, p.sku, p.barcode, p.name, p.brand, p.category, p.unit_price, p.base_unit, p.pack_unit, p.pack_ratio, p.created_at)),
      );
      insertMany(
        `INSERT OR REPLACE INTO stock(store_id, sku, floor_stock, warehouse_stock, damaged_stock, shopee_stock, min_floor_alert, sold_out_at, as_of)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        arr(d.inventory).map((i) => row(sid, i.sku, i.floor_stock, i.warehouse_stock, i.damaged_stock, i.shopee_stock, i.min_floor_alert, i.sold_out_at, at)),
      );
      insertMany(
        'INSERT OR REPLACE INTO users(store_id, name, role, active, created_at) VALUES(?, ?, ?, ?, ?)',
        arr(d.users).map((u) => row(sid, u.name, u.role, u.active, u.created_at)),
      );
      insertMany(
        'INSERT OR REPLACE INTO label_designs(store_id, name, config, is_default, updated_at) VALUES(?, ?, ?, ?, ?)',
        arr(d.label_designs).map((l) => row(sid, l.name, l.config, l.is_default, l.updated_at)),
      );
      insertMany(
        `INSERT OR REPLACE INTO reception_drafts(store_id, draft_id, reference_no, supplier_name, notes, code, name, qty, pack_type, destination,
           source, created_at, resolved_at, reception_reference_no) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        arr(d.reception_drafts).map((r) => row(sid, r.draft_id, r.reference_no, r.supplier_name, r.notes, r.code, r.name, r.qty, r.pack_type,
          r.destination, r.source, r.created_at, r.resolved_at, r.reception_reference_no)),
      );
      const cs = d.current_shift;
      if (cs && cs.shift_uid) applyShiftData(sid, { ...cs, closed_at: null }, arr(cs.sales), at, false);
    }
    upsertStore(pkg, { snapshotAt: at, settings: newest && d.settings ? d.settings : undefined });
    return newest ? 'ok' : 'old';
  }

  function recordImport(sha, { file_name, source, pkg, status, message }) {
    db.run('DELETE FROM imports WHERE sha256 = ?', [sha]);
    db.run(
      `INSERT INTO imports(sha256, file_name, source, kind, store_id, store_name, package_id, package_created_at, imported_at, status, message, counts)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row(sha, file_name, source, pkg && pkg.kind, pkg && pkg.store.id, pkg && pkg.store.name, pkg && pkg.package_id, pkg && pkg.created_at,
        now(), status, message || '', pkg ? pkg.counts || {} : null),
    );
  }

  function importOne({ buffer, file_name = '', source = 'manual' }) {
    const sha = sha256(buffer);
    const prev = db.get('SELECT status FROM imports WHERE sha256 = ?', [sha]);
    if (prev && prev.status !== 'error') return { file_name, status: 'skip', message: 'Sudah pernah diimpor.' };
    let pkg;
    try {
      pkg = decodePackage(buffer);
      if (pkg.source && pkg.source.demo) fail('Paket dari versi DEMO (data latihan) tidak diimpor.');
    } catch (e) {
      if (!e.userFacing) throw e;
      recordImport(sha, { file_name, source, pkg: null, status: 'error', message: e.message });
      return { file_name, status: 'error', message: e.message };
    }
    const base = { file_name, kind: pkg.kind, store_id: pkg.store.id, store_name: pkg.store.name, created_at: pkg.created_at };
    db.db.exec('SAVEPOINT paket');
    try {
      const status = pkg.kind === 'shift' ? applyShift(pkg) : applySnapshot(pkg);
      db.db.exec('RELEASE paket');
      const message = status === 'old'
        ? (pkg.kind === 'shift' ? 'Sudah ada data shift ini yang lebih baru; paket ini dilewati.' : 'Snapshot lebih lama dari data yang ada: hanya riwayat yang ditambahkan.')
        : '';
      recordImport(sha, { file_name, source, pkg, status, message });
      return { ...base, status, message };
    } catch (e) {
      db.db.exec('ROLLBACK TO paket');
      db.db.exec('RELEASE paket');
      const message = `Gagal menyimpan isi paket: ${e.message}`;
      recordImport(sha, { file_name, source, pkg, status: 'error', message });
      return { ...base, status: 'error', message };
    }
  }

  // Banyak paket dalam satu transaksi (sekali tulis ke disk); paket yang gagal tidak membatalkan yang lain
  function importMany(items) {
    if (!items.length) return [];
    return db.tx(() => items.map((it) => importOne(it)));
  }

  const importBuffer = (buffer, meta = {}) => importMany([{ buffer, ...meta }])[0];

  function importFiles(files, source = 'manual') {
    const items = [];
    const results = [];
    for (const f of files) {
      try {
        items.push({ buffer: fs.readFileSync(f), file_name: path.basename(f), source });
      } catch (e) {
        results.push({ file_name: path.basename(f), status: 'error', message: `File tidak bisa dibaca: ${e.message}` });
      }
    }
    return results.concat(importMany(items));
  }

  // ---------------------------------------------------------------- Folder masuk (Google Drive)
  const seen = new Map(); // path → "ukuran:waktu ubah" yang sudah diproses
  let lastScan = null;

  function listPackageFiles(dir, depth = 0) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      if (depth === 0) fail(`Folder masuk tidak bisa dibuka: ${dir}`);
      return [];
    }
    let out = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) out = out.concat(listPackageFiles(p, depth + 1));
      else if (e.isFile() && FILE_RE.test(e.name)) out.push(p);
    }
    return out;
  }

  // File yang belum berubah sejak pindai terakhir tidak dibaca lagi; file setengah tersalin dicoba lagi setelah berubah
  function scanFolder(dir) {
    const folder = String(dir || '').trim();
    if (!folder) fail('Folder masuk belum diatur.');
    const files = listPackageFiles(folder).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const items = [];
    for (const f of files) {
      let st;
      try { st = fs.statSync(f); } catch (_) { continue; }
      const sig = `${st.size}:${st.mtimeMs}`;
      if (seen.get(f) === sig) continue;
      try { items.push({ buffer: fs.readFileSync(f), file_name: path.basename(f), source: 'folder', path: f, sig }); } catch (_) { /* dicoba lagi */ }
    }
    const results = importMany(items.map(({ buffer, file_name, source }) => ({ buffer, file_name, source })));
    items.forEach((it) => seen.set(it.path, it.sig));
    const count = (s) => results.filter((r) => r.status === s).length;
    lastScan = { at: now(), dir: folder, files: files.length, imported: count('ok') + count('old'), skipped: count('skip'), errors: count('error') };
    return { ...lastScan, results };
  }

  // ---------------------------------------------------------------- Pengaturan & PIN
  function config() {
    return { inbox_dir: getSetting('inbox_dir'), has_pin: !!getSetting('pin_hash'), last_scan: lastScan, zones: ZONE_LABEL };
  }
  function setInbox(dir) {
    const d = String(dir || '').trim();
    if (d && !(fs.existsSync(d) && fs.statSync(d).isDirectory())) fail(`Folder tidak ditemukan: ${d}`);
    setSetting('inbox_dir', d);
    seen.clear();
    return config();
  }
  function setPin(pin) {
    const p = String(pin ?? '').trim();
    if (!p) {
      db.tx(() => { setSetting('pin_hash', ''); setSetting('pin_salt', ''); });
      return config();
    }
    if (!/^\d{6}$/.test(p)) fail('PIN harus 6 digit angka.');
    const h = hashPin(p);
    db.tx(() => { setSetting('pin_hash', h.hash); setSetting('pin_salt', h.salt); });
    return config();
  }
  const hasPin = () => !!getSetting('pin_hash');
  const verifyPin = (pin) => checkPin(String(pin ?? ''), getSetting('pin_salt'), getSetting('pin_hash'));

  // ---------------------------------------------------------------- Data untuk tampilan
  const stores = () => db.all('SELECT * FROM stores ORDER BY store_name COLLATE NOCASE, store_id');

  function dashboard({ store_id = '' } = {}) {
    const day = now().slice(0, 10);
    const d7 = addDays(day, -6);
    const month = `${day.slice(0, 8)}01`;
    const list = db.all(
      `SELECT s.*,
         (SELECT COUNT(*) FROM products p WHERE p.store_id = s.store_id) AS products,
         (SELECT COUNT(*) FROM stock k WHERE k.store_id = s.store_id AND k.floor_stock <= k.min_floor_alert) AS low_stock,
         (SELECT COUNT(*) FROM shifts h WHERE h.store_id = s.store_id AND h.closed_at IS NULL) AS open_shifts,
         (SELECT COALESCE(SUM(x.line_total), 0) FROM sales x WHERE x.store_id = s.store_id AND x.created_at >= ?) AS rev_today,
         (SELECT COUNT(DISTINCT x.shift_uid || '|' || x.receipt_no) FROM sales x WHERE x.store_id = s.store_id AND x.created_at >= ?) AS receipts_today,
         (SELECT COALESCE(SUM(x.line_total), 0) FROM sales x WHERE x.store_id = s.store_id AND x.created_at >= ?) AS rev_7d,
         (SELECT COALESCE(SUM(x.line_total), 0) FROM sales x WHERE x.store_id = s.store_id AND x.created_at >= ?) AS rev_month
       FROM stores s WHERE (? = '' OR s.store_id = ?) ORDER BY s.store_name COLLATE NOCASE`,
      [`${day} 00:00:00`, `${day} 00:00:00`, `${d7} 00:00:00`, `${month} 00:00:00`, store_id, store_id],
    );
    const sum = (k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    return {
      day, from_7d: d7, month,
      stores: list,
      totals: { rev_today: sum('rev_today'), receipts_today: sum('receipts_today'), rev_7d: sum('rev_7d'), rev_month: sum('rev_month'), low_stock: sum('low_stock'), stores: list.length },
    };
  }

  const RECEIPT_KEY = "x.store_id || '|' || x.shift_uid || '|' || x.receipt_no";
  const GROUPS = {
    day: (w) => `SELECT substr(x.created_at, 1, 10) AS day, x.store_id, s.store_name, COUNT(DISTINCT ${RECEIPT_KEY}) AS receipts,
                  SUM(x.qty) AS qty, SUM(x.line_total) AS total
                FROM sales x JOIN stores s ON s.store_id = x.store_id WHERE ${w}
                GROUP BY day, x.store_id ORDER BY day DESC, s.store_name COLLATE NOCASE`,
    item: (w) => `SELECT x.sku, x.product_name AS name, COUNT(DISTINCT x.store_id) AS stores, COUNT(DISTINCT ${RECEIPT_KEY}) AS receipts,
                  SUM(x.qty) AS qty, SUM(x.line_total) AS total
                FROM sales x WHERE ${w} GROUP BY x.sku, x.product_name ORDER BY total DESC, x.product_name LIMIT 5000`,
    method: (w) => `SELECT x.payment_method AS method, COUNT(DISTINCT ${RECEIPT_KEY}) AS receipts, SUM(x.qty) AS qty, SUM(x.line_total) AS total
                FROM sales x WHERE ${w} GROUP BY x.payment_method ORDER BY total DESC`,
    receipt: (w) => `SELECT x.store_id, s.store_name, x.shift_uid, x.receipt_no, MIN(x.created_at) AS created_at, x.payment_method,
                  COUNT(*) AS lines, SUM(x.qty) AS qty, SUM(x.line_total) AS total
                FROM sales x JOIN stores s ON s.store_id = x.store_id WHERE ${w}
                GROUP BY x.store_id, x.shift_uid, x.receipt_no ORDER BY created_at DESC, x.receipt_no DESC LIMIT 5000`,
  };

  function salesReport({ store_id = '', from, to, group = 'day' } = {}) {
    const [a, b] = range(from, to);
    const where = "x.created_at >= ? AND x.created_at <= ? AND (? = '' OR x.store_id = ?)";
    const p = [a, b, store_id, store_id];
    const totals = db.get(
      `SELECT COUNT(DISTINCT ${RECEIPT_KEY}) AS receipts, COALESCE(SUM(x.qty), 0) AS qty, COALESCE(SUM(x.line_total), 0) AS total FROM sales x WHERE ${where}`, p,
    );
    let rows;
    if (group === 'shift') {
      rows = db.all(
        `SELECT h.*, s.store_name FROM shifts h JOIN stores s ON s.store_id = h.store_id
         WHERE COALESCE(h.closed_at, '9999-12-31 23:59:59') >= ? AND h.shift_start <= ? AND (? = '' OR h.store_id = ?)
         ORDER BY h.shift_start DESC LIMIT 5000`, p,
      ).map((r) => ({ ...r, by_method: JSON.parse(r.by_method || '[]') }));
    } else if (GROUPS[group]) {
      rows = db.all(GROUPS[group](where), p);
    } else {
      fail('Tampilan penjualan tidak dikenal.');
    }
    return { from: a.slice(0, 10), to: b.slice(0, 10), group, store_id, totals, rows };
  }

  function receiptLines({ store_id, shift_uid, receipt_no } = {}) {
    return db.all(
      `SELECT x.*, s.store_name FROM sales x JOIN stores s ON s.store_id = x.store_id
       WHERE x.store_id = ? AND x.shift_uid = ? AND x.receipt_no = ? ORDER BY x.line_no`, [store_id, shift_uid, receipt_no],
    );
  }

  function shiftDetail({ store_id, shift_uid } = {}) {
    const shift = db.get('SELECT h.*, s.store_name FROM shifts h JOIN stores s ON s.store_id = h.store_id WHERE h.store_id = ? AND h.shift_uid = ?', [store_id, shift_uid]);
    if (!shift) fail('Shift tidak ditemukan.');
    shift.by_method = JSON.parse(shift.by_method || '[]');
    const items = db.all(
      `SELECT sku, product_name AS name, SUM(qty) AS qty, SUM(line_total) AS total FROM sales WHERE store_id = ? AND shift_uid = ?
       GROUP BY sku, product_name ORDER BY total DESC`, [store_id, shift_uid],
    );
    return { shift, items };
  }

  function stockList({ store_id = '', q = '', filter = 'all', limit = 20000 } = {}) {
    const where = ["(? = '' OR k.store_id = ?)"];
    const params = [store_id, store_id];
    const s = String(q || '').trim();
    if (s) {
      const l = `%${s}%`;
      where.push('(p.name LIKE ? OR k.sku LIKE ? OR p.barcode LIKE ? OR p.category LIKE ? OR p.brand LIKE ?)');
      params.push(l, l, l, l, l);
    }
    if (filter === 'low') where.push('k.floor_stock <= k.min_floor_alert');
    if (filter === 'empty') where.push('k.floor_stock <= 0');
    if (filter === 'damaged') where.push('k.damaged_stock > 0');
    if (filter === 'shopee') where.push('k.shopee_stock > 0');
    params.push(Math.min(Number(limit) || 20000, 200000));
    const rows = db.all(
      `SELECT k.*, s.store_name, p.barcode, p.name, p.brand, p.category, p.unit_price
       FROM stock k JOIN stores s ON s.store_id = k.store_id LEFT JOIN products p ON p.store_id = k.store_id AND p.sku = k.sku
       WHERE ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE, s.store_name COLLATE NOCASE LIMIT ?`, params,
    );
    const totals = rows.reduce((t, r) => ({
      floor: t.floor + (r.floor_stock || 0), warehouse: t.warehouse + (r.warehouse_stock || 0),
      damaged: t.damaged + (r.damaged_stock || 0), shopee: t.shopee + (r.shopee_stock || 0),
    }), { floor: 0, warehouse: 0, damaged: 0, shopee: 0 });
    return { rows, totals };
  }

  const DOCS = {
    receptions: { table: 'receptions', key: 'reference_no', time: 'received_at', lines: 'reception_items', search: ['d.reference_no', 'd.supplier_name', 'd.notes'] },
    transfers: { table: 'transfers', key: 'doc_no', time: 'created_at', lines: 'transfer_lines', search: ['d.doc_no', 'd.reason'] },
    opnames: { table: 'opnames', key: 'doc_no', time: 'created_at', lines: 'opname_lines', search: ['d.doc_no', 'd.notes'] },
  };

  function docList({ type, store_id = '', from, to, q = '', limit = 5000 } = {}) {
    const T = DOCS[type] || fail('Jenis dokumen tidak dikenal.');
    const [a, b] = range(from, to);
    const params = [a, b, store_id, store_id];
    let search = '';
    const s = String(q || '').trim();
    if (s) {
      const l = `%${s}%`;
      search = ` AND (${T.search.map((c) => `${c} LIKE ?`).join(' OR ')} OR EXISTS (
        SELECT 1 FROM ${T.lines} li LEFT JOIN products p ON p.store_id = li.store_id AND p.sku = li.sku
        WHERE li.store_id = d.store_id AND li.${T.key} = d.${T.key} AND (li.sku LIKE ? OR p.name LIKE ?)))`;
      params.push(...T.search.map(() => l), l, l);
    }
    params.push(Math.min(Number(limit) || 5000, 100000));
    const rows = db.all(
      `SELECT d.*, s.store_name, (SELECT COUNT(*) FROM ${T.lines} li WHERE li.store_id = d.store_id AND li.${T.key} = d.${T.key}) AS lines
       FROM ${T.table} d JOIN stores s ON s.store_id = d.store_id
       WHERE d.${T.time} >= ? AND d.${T.time} <= ? AND (? = '' OR d.store_id = ?)${search}
       ORDER BY d.${T.time} DESC LIMIT ?`, params,
    );
    return { from: a.slice(0, 10), to: b.slice(0, 10), type, rows };
  }

  function docDetail({ type, store_id, key } = {}) {
    const T = DOCS[type] || fail('Jenis dokumen tidak dikenal.');
    const doc = db.get(`SELECT d.*, s.store_name FROM ${T.table} d JOIN stores s ON s.store_id = d.store_id WHERE d.store_id = ? AND d.${T.key} = ?`, [store_id, key]);
    if (!doc) fail('Dokumen tidak ditemukan.');
    doc.items = db.all(
      `SELECT li.*, p.name, p.barcode FROM ${T.lines} li LEFT JOIN products p ON p.store_id = li.store_id AND p.sku = li.sku
       WHERE li.store_id = ? AND li.${T.key} = ? ORDER BY li.line_no`, [store_id, key],
    );
    return doc;
  }

  function importsList({ limit = 300 } = {}) {
    const rows = db.all('SELECT * FROM imports ORDER BY id DESC LIMIT ?', [Math.min(Number(limit) || 300, 5000)]);
    // Error yang belum terselesaikan: belum ada impor sukses berikutnya untuk nama file yang sama
    const unresolved = db.get(
      `SELECT COUNT(*) AS n FROM imports e WHERE e.status = 'error' AND NOT EXISTS (
         SELECT 1 FROM imports o WHERE o.file_name = e.file_name AND o.status IN ('ok', 'old') AND o.id > e.id)`,
    ).n;
    return { rows, unresolved };
  }

  function deleteStore({ store_id } = {}) {
    if (!db.get('SELECT 1 FROM stores WHERE store_id = ?', [store_id])) fail('Toko tidak ditemukan.');
    // Catatan impor tetap disimpan: file lama di folder masuk tidak diimpor ulang otomatis
    db.tx(() => { for (const t of STORE_TABLES) db.run(`DELETE FROM ${t} WHERE store_id = ?`, [store_id]); });
    return true;
  }

  // ---------------------------------------------------------------- Lembar Excel
  const Z = (z) => ZONE_LABEL[z] || z || '';
  function sheet(name, headers, rows) {
    if (rows.length > MAX_SHEET_ROWS) fail(`Data "${name}" terlalu banyak untuk satu file Excel (${rows.length} baris). Persempit rentang tanggal.`);
    return { name, headers, rows };
  }

  const SALES_SHEETS = {
    day: (r) => sheet('Per Hari', ['Tanggal', 'Toko', 'Struk', 'Jumlah_Biji', 'Omset'], r.rows.map((x) => [x.day, x.store_name, x.receipts, x.qty, x.total])),
    shift: (r) => sheet('Per Shift', ['Toko', 'Kasir', 'Mulai', 'Tutup', 'Status', 'Struk', 'Jumlah_Biji', 'Omset', 'Tunai', 'Catatan', 'ID_Shift'],
      r.rows.map((x) => [x.store_name, x.cashier_name, x.shift_start, x.closed_at || '', x.closed_at ? (x.legacy ? 'Riwayat lama' : 'Tutup') : 'Berjalan',
        x.receipts, x.qty, x.revenue, x.cash_sales, x.notes, x.shift_uid])),
    item: (r) => sheet('Per Barang', ['SKU', 'Nama_Barang', 'Jumlah_Toko', 'Struk', 'Jumlah_Biji', 'Omset'], r.rows.map((x) => [x.sku, x.name, x.stores, x.receipts, x.qty, x.total])),
    method: (r) => sheet('Per Metode', ['Metode_Bayar', 'Struk', 'Jumlah_Biji', 'Omset'], r.rows.map((x) => [x.method, x.receipts, x.qty, x.total])),
    receipt: (r) => sheet('Per Struk', ['Toko', 'Waktu', 'No_Struk', 'Metode_Bayar', 'Baris', 'Jumlah_Biji', 'Total', 'ID_Shift'],
      r.rows.map((x) => [x.store_name, x.created_at, x.receipt_no, x.payment_method, x.lines, x.qty, x.total, x.shift_uid])),
  };

  function salesLinesSheet({ store_id = '', from, to }) {
    const [a, b] = range(from, to);
    const rows = db.all(
      `SELECT x.*, s.store_name FROM sales x JOIN stores s ON s.store_id = x.store_id
       WHERE x.created_at >= ? AND x.created_at <= ? AND (? = '' OR x.store_id = ?) ORDER BY x.created_at, x.receipt_no, x.line_no`,
      [a, b, store_id, store_id],
    );
    return sheet('Detail Penjualan', ['Toko', 'Waktu', 'No_Struk', 'Baris', 'SKU', 'Nama_Barang', 'Jumlah_Biji', 'Harga_Satuan', 'Subtotal', 'Metode_Bayar', 'ID_Shift'],
      rows.map((x) => [x.store_name, x.created_at, x.receipt_no, x.line_no, x.sku, x.product_name, x.qty, x.unit_price, x.line_total, x.payment_method, x.shift_uid]));
  }

  function stockSheet(args) {
    return sheet('Stok', ['Toko', 'SKU', 'Barcode', 'Nama_Barang', 'Kategori', 'Harga_Jual', 'Display_Toko', 'Gudang_Utama', 'Gudang_BS', 'Gudang_Shopee', 'Min_Display', 'Per_Waktu'],
      stockList({ ...args, limit: 200000 }).rows.map((x) => [x.store_name, x.sku, x.barcode, x.name, x.category, x.unit_price, x.floor_stock, x.warehouse_stock,
        x.damaged_stock, x.shopee_stock, x.min_floor_alert, x.as_of]));
  }

  function docSheets({ type, store_id = '', from, to, q = '' }) {
    const list = docList({ type, store_id, from, to, q, limit: 100000 }).rows;
    const T = DOCS[type];
    const keys = new Set(list.map((d) => `${d.store_id}|${d[T.key]}`));
    const lines = list.length ? db.all(
      `SELECT li.*, s.store_name, p.name FROM ${T.lines} li JOIN stores s ON s.store_id = li.store_id
       LEFT JOIN products p ON p.store_id = li.store_id AND p.sku = li.sku
       JOIN ${T.table} d ON d.store_id = li.store_id AND d.${T.key} = li.${T.key}
       WHERE d.${T.time} >= ? AND d.${T.time} <= ? AND (? = '' OR d.store_id = ?) ORDER BY d.${T.time}, li.${T.key}, li.line_no`,
      [...range(from, to), store_id, store_id],
    ).filter((l) => keys.has(`${l.store_id}|${l[T.key]}`)) : [];
    if (type === 'receptions') {
      return [
        sheet('Penerimaan', ['Toko', 'Waktu', 'No_Surat_Jalan', 'Supplier', 'Baris', 'Total_Biji', 'Catatan'],
          list.map((d) => [d.store_name, d.received_at, d.reference_no, d.supplier_name, d.lines, d.total_items_count, d.notes])),
        sheet('Penerimaan_Detail', ['Toko', 'No_Surat_Jalan', 'Baris', 'SKU', 'Nama_Barang', 'Jumlah_Biji', 'Satuan_Input', 'Tujuan'],
          lines.map((l) => [l.store_name, l.reference_no, l.line_no, l.sku, l.name, l.qty, l.pack_type, Z(l.destination)])),
      ];
    }
    if (type === 'transfers') {
      return [
        sheet('Mutasi', ['Toko', 'Waktu', 'No_Mutasi', 'Dari', 'Ke', 'Baris', 'Total_Biji', 'Alasan'],
          list.map((d) => [d.store_name, d.created_at, d.doc_no, Z(d.from_zone), Z(d.to_zone), d.line_count, d.total_qty, d.reason])),
        sheet('Mutasi_Detail', ['Toko', 'No_Mutasi', 'Baris', 'SKU', 'Nama_Barang', 'Jumlah_Biji'],
          lines.map((l) => [l.store_name, l.doc_no, l.line_no, l.sku, l.name, l.qty])),
      ];
    }
    return [
      sheet('Opname', ['Toko', 'Waktu', 'No_Opname', 'Zona', 'Baris', 'Lebih', 'Kurang', 'Tanggal_Stok', 'Catatan'],
        list.map((d) => [d.store_name, d.created_at, d.doc_no, Z(d.zone), d.line_count, d.plus_qty, d.minus_qty, d.count_at || '', d.notes])),
      sheet('Opname_Detail', ['Toko', 'No_Opname', 'Baris', 'SKU', 'Nama_Barang', 'Stok_Sistem', 'Fisik', 'Selisih'],
        lines.map((l) => [l.store_name, l.doc_no, l.line_no, l.sku, l.name, l.system_qty, l.counted_qty, l.diff])),
    ];
  }

  function exportSheets({ kind = 'all', store_id = '', from, to, group = 'day', type = 'receptions', q = '', filter = 'all' } = {}) {
    if (kind === 'sales') return [SALES_SHEETS[group](salesReport({ store_id, from, to, group })), salesLinesSheet({ store_id, from, to })];
    if (kind === 'stock') return [stockSheet({ store_id, q, filter })];
    if (kind === 'docs') return docSheets({ type, store_id, from, to, q });
    if (kind !== 'all') fail('Jenis ekspor tidak dikenal.');
    const st = stores().filter((s) => !store_id || s.store_id === store_id);
    const [a, b] = range(from, to);
    const offline = db.all(
      `SELECT o.*, s.store_name FROM offline_sales o JOIN stores s ON s.store_id = o.store_id
       WHERE o.created_at >= ? AND o.created_at <= ? AND (? = '' OR o.store_id = ?) ORDER BY o.created_at`, [a, b, store_id, store_id],
    );
    const products = db.all(
      `SELECT p.*, s.store_name FROM products p JOIN stores s ON s.store_id = p.store_id WHERE (? = '' OR p.store_id = ?)
       ORDER BY s.store_name COLLATE NOCASE, p.name COLLATE NOCASE`, [store_id, store_id],
    );
    return [
      sheet('Toko', ['ID_Toko', 'Nama_Toko', 'Alamat', 'Versi_Aplikasi', 'Data_Terakhir', 'Snapshot_Terakhir', 'Tutup_Shift_Terakhir', 'Pertama_Diterima'],
        st.map((s) => [s.store_id, s.store_name, s.store_address, s.app_version, s.last_package_at, s.last_snapshot_at, s.last_shift_at, s.first_seen_at])),
      SALES_SHEETS.day(salesReport({ store_id, from, to, group: 'day' })),
      SALES_SHEETS.shift(salesReport({ store_id, from, to, group: 'shift' })),
      SALES_SHEETS.item(salesReport({ store_id, from, to, group: 'item' })),
      salesLinesSheet({ store_id, from, to }),
      stockSheet({ store_id }),
      sheet('Barang', ['Toko', 'SKU', 'Barcode', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Satuan_Masuk', 'Isi_per_Satuan', 'Dibuat'],
        products.map((p) => [p.store_name, p.sku, p.barcode, p.name, p.brand, p.category, p.unit_price, p.pack_unit, p.pack_ratio, p.created_at])),
      ...docSheets({ type: 'receptions', store_id, from, to }),
      ...docSheets({ type: 'transfers', store_id, from, to }),
      ...docSheets({ type: 'opnames', store_id, from, to }),
      sheet('Transaksi_Darurat', ['Toko', 'No_Struk', 'Kasir', 'Waktu', 'Diterima_Gudang', 'Total', 'Status', 'Catatan', 'Dicek'],
        offline.map((o) => [o.store_name, o.receipt_no, o.cashier_name, o.created_at, o.synced_at, o.total, o.status, o.notes, o.checked_at || ''])),
    ];
  }

  return {
    db, importBuffer, importFiles, importMany, scanFolder, config, setInbox, setPin, hasPin, verifyPin,
    stores, dashboard, salesReport, receiptLines, shiftDetail, stockList, docList, docDetail, importsList, deleteStore, exportSheets,
  };
}

module.exports = { openHomebase, createHomebase, SCHEMA };
