'use strict';
// Pembungkus SQLite lokal berbasis sql.js (WebAssembly) — tanpa kompilasi native.
// Seluruh database disimpan ke satu file dan ditulis ulang secara atomik setelah setiap transaksi.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
-- ========================================================
-- PARTISI A: MASTER DATA & INVENTARIS PERMANEN
-- ========================================================
CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY,
    barcode TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    brand TEXT DEFAULT '-',
    category TEXT DEFAULT 'Umum',
    unit_price INTEGER NOT NULL,
    base_unit TEXT DEFAULT 'Biji',
    pack_unit TEXT DEFAULT 'Dus',
    pack_ratio INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inventory (
    sku TEXT PRIMARY KEY,
    floor_stock INTEGER DEFAULT 0,
    warehouse_stock INTEGER DEFAULT 0,
    damaged_stock INTEGER DEFAULT 0,
    min_floor_alert INTEGER DEFAULT 5,
    sold_out_at DATETIME, -- terisi saat stok toko habis/minus karena terjual di kasir (merah di Saran Restock)
    FOREIGN KEY (sku) REFERENCES products(sku) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_receptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_no TEXT UNIQUE NOT NULL,
    supplier_name TEXT,
    notes TEXT,
    received_at DATETIME DEFAULT (datetime('now','localtime')),
    total_items_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_reception_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reception_id INTEGER NOT NULL,
    sku TEXT NOT NULL,
    quantity_received INTEGER NOT NULL,
    pack_type TEXT DEFAULT 'Biji',
    destination TEXT NOT NULL CHECK(destination IN ('warehouse', 'floor', 'damaged')),
    FOREIGN KEY (reception_id) REFERENCES stock_receptions(id) ON DELETE CASCADE,
    FOREIGN KEY (sku) REFERENCES products(sku)
);

-- 'customer' = retur dari pelanggan (sumber eksternal),
-- 'supplier' = retur keluar ke pabrik, 'disposed' = dibuang/dimusnahkan (tujuan eksternal)
CREATE TABLE IF NOT EXISTS stock_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    from_zone TEXT NOT NULL CHECK(from_zone IN ('floor', 'warehouse', 'damaged', 'customer')),
    to_zone TEXT NOT NULL CHECK(to_zone IN ('floor', 'warehouse', 'damaged', 'supplier', 'disposed')),
    qty INTEGER NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (sku) REFERENCES products(sku)
);

-- ========================================================
-- PARTISI B: DATA TRANSAKSI SHIFT KASIR (EPHEMERAL / PURGE VIA EMAIL)
-- ========================================================
CREATE TABLE IF NOT EXISTS shift_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no TEXT NOT NULL,
    sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    qty_sold INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    payment_method TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS active_shift (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cashier_name TEXT,
    shift_start DATETIME DEFAULT (datetime('now','localtime')),
    initial_cash INTEGER DEFAULT 0
);

-- Pengaturan aplikasi (nama toko, SMTP, nomor struk)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Desain label barcode (konfigurasi disimpan sebagai JSON)
CREATE TABLE IF NOT EXISTS label_designs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    config TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- Transaksi mode darurat yang dikirim PC kasir setelah koneksi kembali.
-- Tidak ikut dihapus saat tutup shift: mencegah transaksi tercatat dua kali bila dikirim ulang,
-- dan menyimpan tanda "perlu dicek" (status = 'check') bila stok toko tidak cukup saat diterima.
CREATE TABLE IF NOT EXISTS offline_sales (
    receipt_no TEXT PRIMARY KEY,
    client_ref TEXT,
    cashier_name TEXT,
    created_at DATETIME,
    synced_at DATETIME,
    total INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok', 'check', 'duplicate')),
    notes TEXT,
    checked_at DATETIME
);

-- Penanda unik tiap percobaan bayar dari PC kasir, agar transaksi yang sudah masuk online
-- tidak tercatat lagi lewat antrian darurat (mis. koneksi putus tepat saat menunggu balasan).
CREATE TABLE IF NOT EXISTS checkout_refs (
    client_ref TEXT PRIMARY KEY,
    receipt_no TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- Akun login: admin (semua menu), gudang, kasir. PIN disimpan sebagai hash scrypt.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK(role IN ('admin', 'gudang', 'kasir')),
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_transfers_created ON stock_transfers(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_receipt ON shift_sales(receipt_no);
`;

let sqlPromise;
function loadSql() {
  sqlPromise = sqlPromise || initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  return sqlPromise;
}

const REQUIRED_TABLES = ['products', 'inventory', 'settings'];

// Kolom yang ditambahkan setelah versi pertama: CREATE TABLE IF NOT EXISTS tidak menambah kolom ke tabel lama
const ADDED_COLUMNS = [['inventory', 'sold_out_at', 'DATETIME']];

function migrate(sqlDb) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const cols = (sqlDb.exec(`PRAGMA table_info(${table})`)[0]?.values || []).map((r) => r[1]);
    if (!cols.includes(col)) sqlDb.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

function posError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

class Database {
  static async open(file) {
    const SQL = await loadSql();
    const db = file && fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
    const inst = new Database(db, file);
    inst.db.exec(SCHEMA);
    migrate(inst.db);
    inst.db.exec('PRAGMA foreign_keys = ON');
    inst.persist();
    return inst;
  }

  // Pastikan buffer adalah database POS Tri-Zone; kembalikan ringkasan isinya
  static async validateFile(buffer) {
    const SQL = await loadSql();
    let db;
    try {
      db = new SQL.Database(buffer);
      const tables = (db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values || []).map((r) => r[0]);
      if (!REQUIRED_TABLES.every((t) => tables.includes(t))) throw posError('File bukan database POS Tri-Zone.');
      const count = (t) => (tables.includes(t) ? db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0] : 0);
      return { products: count('products'), receptions: count('stock_receptions'), sales: count('shift_sales') };
    } catch (e) {
      if (e.userFacing) throw e;
      throw posError('File bukan database POS Tri-Zone atau rusak.');
    } finally {
      if (db) db.close();
    }
  }

  constructor(db, file) {
    this.db = db;
    this.file = file;
    this.inTx = false;
  }

  // Ganti seluruh isi database dengan file cadangan; database lama disimpan dulu ke backupDir
  async replaceWith(buffer, backupDir) {
    await Database.validateFile(buffer);
    let saved = null;
    if (backupDir) {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      saved = path.join(backupDir, `sebelum-pulih-${stamp}.db`);
      fs.writeFileSync(saved, Buffer.from(this.db.export()));
    }
    const SQL = await loadSql();
    const next = new SQL.Database(buffer);
    next.exec(SCHEMA); // tambahkan tabel baru bila cadangan berasal dari versi lama
    migrate(next);
    next.exec('PRAGMA foreign_keys = ON');
    this.db.close();
    this.db = next;
    this.persist();
    return { backupFile: saved };
  }

  exportBuffer() {
    const data = Buffer.from(this.db.export());
    this.db.exec('PRAGMA foreign_keys = ON');
    return data;
  }

  all(sql, params = []) {
    const st = this.db.prepare(sql);
    try {
      st.bind(params);
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally {
      st.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    return { changes: this.db.getRowsModified() };
  }

  lastId() {
    return this.get('SELECT last_insert_rowid() AS id').id;
  }

  // Jalankan fn di dalam satu transaksi; simpan ke disk hanya jika COMMIT berhasil.
  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN');
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.inTx = false;
      this.persist();
      return result;
    } catch (err) {
      this.inTx = false;
      try { this.db.exec('ROLLBACK'); } catch (_) { /* sudah di-rollback */ }
      throw err;
    }
  }

  persist() {
    if (!this.file) return;
    const data = this.db.export();
    // export() membuka ulang database sehingga PRAGMA kembali default
    this.db.exec('PRAGMA foreign_keys = ON');
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.file);
  }

  // Salinan harian database, disimpan maksimal `keep` file terakhir.
  backup(dir, keep = 14) {
    if (!this.file || !fs.existsSync(this.file)) return;
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const target = path.join(dir, `pos-${stamp}.db`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const files = fs.readdirSync(dir).filter((f) => /^pos-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (files.length > keep) fs.unlinkSync(path.join(dir, files.shift()));
  }
}

module.exports = { Database };
