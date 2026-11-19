'use strict';
// Logika bisnis POS — tidak bergantung pada Electron agar bisa diuji dengan Node biasa.
const crypto = require('crypto');
const { normalizeDesign, DEFAULT_DESIGN } = require('./labels');
const { ROLES, hashPin, checkPin, matchLogin } = require('./auth');
const { rankProducts } = require('./search');

const PAYMENT_METHODS = ['Tunai', 'QRIS', 'Transfer'];
// Nama metode dari versi lama yang masih bisa datang dari antrean mode darurat PC kasir
const LEGACY_PAYMENT = { 'Kartu Debit': 'Transfer' };

// Riwayat shift yang sudah ditutup disimpan 4 hari kalender: hari ini + 3 hari sebelumnya
// (cadangan bila kiriman ke mother base tertunda, mis. saat akhir pekan)
const SHIFT_HISTORY_DAYS = 4;

const ZONE_COL = { floor: 'floor_stock', warehouse: 'warehouse_stock', damaged: 'damaged_stock', shopee: 'shopee_stock' };

const ZONE_LABEL = {
  floor: 'Display Toko',
  warehouse: 'Gudang Utama',
  damaged: 'Gudang BS',
  shopee: 'Gudang Shopee',
  customer: 'Retur Pelanggan',
  supplier: 'Supplier (Retur Keluar)',
  disposed: 'Dibuang / Dimusnahkan',
  shopee_sold: 'Terjual di Shopee',
};

const DIRECTIONS = [
  { from: 'warehouse', to: 'floor', label: 'Gudang Utama → Display Toko (Restock rak)' },
  { from: 'floor', to: 'damaged', label: 'Display Toko → Gudang BS (Rusak / pecah di rak)' },
  { from: 'warehouse', to: 'damaged', label: 'Gudang Utama → Gudang BS (Cacat bawaan supplier)' },
  { from: 'customer', to: 'damaged', label: 'Retur Pelanggan → Gudang BS' },
  { from: 'damaged', to: 'supplier', label: 'Gudang BS → Supplier (Retur keluar)' },
  { from: 'damaged', to: 'disposed', label: 'Gudang BS → Dibuang / Dimusnahkan' },
  { from: 'floor', to: 'warehouse', label: 'Display Toko → Gudang Utama (Tarik dari rak)' },
  { from: 'warehouse', to: 'shopee', label: 'Gudang Utama → Gudang Shopee (Isi stok online)' },
  { from: 'shopee', to: 'warehouse', label: 'Gudang Shopee → Gudang Utama (Tarik dari stok online)' },
  { from: 'shopee', to: 'shopee_sold', label: 'Gudang Shopee → Terjual di Shopee (Pesanan dikirim)' },
  { from: 'customer', to: 'shopee', label: 'Retur Pelanggan Shopee → Gudang Shopee (Kondisi baik)' },
  { from: 'shopee', to: 'damaged', label: 'Gudang Shopee → Gudang BS (Rusak / retur rusak)' },
];

const DESTINATIONS = ['warehouse', 'floor', 'damaged', 'shopee'];

const TEMPLATE_HEADERS = [
  'Barcode', 'SKU', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Satuan_Masuk',
  'Rasio_Isi_Dus', 'Stok_Awal_Toko', 'Stok_Awal_Gudang', 'Stok_Awal_BS', 'Min_Alert_Toko', 'Stok_Awal_Shopee',
];

const TEMPLATE_SAMPLE = [
  ['8991234567890', 'MNM-001', 'Air Mineral 600ml', 'Segar', 'Minuman', 3500, 'Dus', 24, 24, 96, 0, 12, 48],
  ['8997654321098', 'SNK-010', 'Keripik Kentang 68g', 'Renyah', 'Makanan Ringan', 11500, 'Karton', 40, 20, 80, 0, 10, 0],
];

// Template import penerimaan: satu file boleh berisi beberapa surat jalan (dikelompokkan per No_Surat_Jalan)
// Kolom "Supplier" tidak ada lagi di template; file lama yang masih memilikinya tetap diterima.
const RECEPTION_TEMPLATE_HEADERS = ['No_Surat_Jalan', 'Catatan', 'Kode', 'Nama_Barang', 'Jumlah', 'Satuan', 'Tujuan'];

const RECEPTION_TEMPLATE_SAMPLE = [
  ['SJ-0001', '', 'MNM-001', 'Air Mineral 600ml', 5, 'Dus', 'Gudang Utama'],
  ['SJ-0001', '', '8997654321098', 'Keripik Kentang 68g', 12, 'Biji', 'Display Toko'],
  ['SJ-0002', 'Kiriman sore', 'SNK-010', 'Keripik Kentang 68g', 2, 'Dus', ''],
];

const OPNAME_TEMPLATE_HEADERS = ['Kode', 'Nama_Barang', 'Display Toko', 'Fisik Display Toko', 'Gudang Utama', 'Fisik Gudang Utama', 'Gudang BS', 'Fisik Gudang BS', 'Gudang Shopee', 'Fisik Gudang Shopee', 'Tanggal_Stok'];
// Nama kolom per zona setelah dinormalisasi (huruf kecil, tanpa spasi / garis bawah)
const OPNAME_FISIK = { floor: 'fisikdisplaytoko', warehouse: 'fisikgudangutama', damaged: 'fisikgudangbs', shopee: 'fisikgudangshopee' };
const OPNAME_STOCK = { floor: 'displaytoko', warehouse: 'gudangutama', damaged: 'gudangbs', shopee: 'gudangshopee' };

const SETTING_KEYS = [
  'store_name', 'store_address',
  'receipt_header', 'receipt_footer', 'printer_name', 'paper_width', 'auto_print', 'label_printer_name',
];

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function toInt(v, label, { min = 0, max = 1e12, def } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (def !== undefined) return def;
    fail(`${label} wajib diisi.`);
  }
  let n;
  if (typeof v === 'number') {
    n = v;
  } else {
    const s = String(v).trim().replace(/^rp\.?\s*/i, '').replace(/\s/g, '').replace(/\./g, '').replace(/,0+$/, '');
    if (!/^-?\d+$/.test(s)) fail(`${label} harus berupa angka bulat.`);
    n = Number(s);
  }
  if (!Number.isInteger(n)) fail(`${label} harus berupa angka bulat.`);
  if (n < min) fail(`${label} minimal ${min}.`);
  if (n > max) fail(`${label} terlalu besar.`);
  return n;
}

function toStr(v, label, { required = false, max = 200, def = '' } = {}) {
  let s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) {
    if (required) fail(`${label} wajib diisi.`);
    s = def;
  }
  if (s.length > max) fail(`${label} maksimal ${max} karakter.`);
  return s;
}

function codeStr(v) {
  // Barcode dari Excel bisa terbaca sebagai angka
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return v === undefined || v === null ? '' : String(v).trim();
}

function localNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Tanggal dari Excel: teks "YYYY-MM-DD[ HH:MM[:SS]]" atau angka serial tanggal Excel → "YYYY-MM-DD HH:MM:SS" (null bila tidak terbaca)
function parseStockDate(v) {
  const p = (n) => String(n).padStart(2, '0');
  if (typeof v === 'number' && v > 0) {
    const d = new Date(Math.round((v - 25569) * 86400) * 1000); // serial Excel = hari sejak 1899-12-30, tanpa zona waktu
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [, y, mo, da, h = 0, mi = 0, s = 0] = m;
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || s > 59) return null;
  return `${y}-${p(mo)}-${p(da)} ${p(h)}:${p(mi)}:${p(s)}`;
}

const PRODUCT_SELECT = `
  SELECT p.sku, p.barcode, p.name, p.brand, p.category, p.unit_price, p.base_unit, p.pack_unit, p.pack_ratio, p.created_at,
         COALESCE(i.floor_stock, 0) AS floor_stock,
         COALESCE(i.warehouse_stock, 0) AS warehouse_stock,
         COALESCE(i.damaged_stock, 0) AS damaged_stock,
         COALESCE(i.shopee_stock, 0) AS shopee_stock,
         COALESCE(i.min_floor_alert, 5) AS min_floor_alert
  FROM products p LEFT JOIN inventory i ON i.sku = p.sku`;

function createServices(db, { encrypt = (s) => s, decrypt = (s) => s } = {}) {
  // ---------------------------------------------------------------- Pengaturan
  function getSetting(key, def = '') {
    const r = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return r && r.value !== null ? r.value : def;
  }
  function setSetting(key, value) {
    db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
  }
  function getSettings() {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = getSetting(k);
    if (!out.store_name) out.store_name = 'Toko Saya';
    if (!out.paper_width) out.paper_width = '58';
    if (out.auto_print === '') out.auto_print = '1';
    return out;
  }
  function saveSettings(d = {}) {
    if (d.paper_width !== undefined && !['58', '80'].includes(String(d.paper_width))) fail('Lebar kertas harus 58 mm atau 80 mm.');
    if (d.auto_print !== undefined) d.auto_print = d.auto_print === true || d.auto_print === '1' ? '1' : '0';
    db.tx(() => {
      for (const k of SETTING_KEYS) {
        if (d[k] === undefined) continue;
        // Header/footer nota boleh multi-baris; spasi di tepi tiap baris dipertahankan apa adanya
        const v = k === 'receipt_header' || k === 'receipt_footer' ? String(d[k]).replace(/\r\n/g, '\n').slice(0, 500) : toStr(d[k], k, { max: 500 });
        setSetting(k, v);
      }
    });
    return getSettings();
  }

  function meta() {
    return { directions: DIRECTIONS, zones: ZONE_LABEL, paymentMethods: PAYMENT_METHODS, destinations: DESTINATIONS, master_locked: masterLocked() };
  }

  // ---------------------------------------------------------------- Produk
  function getProduct(sku) {
    return db.get(`${PRODUCT_SELECT} WHERE p.sku = ?`, [sku]);
  }

  function listProducts({ q = '', filter = 'all', limit = 5000 } = {}) {
    const where = [];
    const params = [];
    q = String(q || '').trim();
    if (q) {
      const like = `%${q}%`;
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ? OR p.category LIKE ?)');
      params.push(like, like, like, like, like);
    }
    if (filter === 'low') where.push('COALESCE(i.floor_stock,0) <= COALESCE(i.min_floor_alert,5)');
    if (filter === 'damaged') where.push('COALESCE(i.damaged_stock,0) > 0');
    if (filter === 'shopee') where.push('COALESCE(i.shopee_stock,0) > 0');
    if (filter === 'empty') where.push('COALESCE(i.floor_stock,0) = 0');
    const sql = `${PRODUCT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name COLLATE NOCASE LIMIT ?`;
    params.push(Math.min(Number(limit) || 5000, 20000));
    return db.all(sql, params);
  }

  function categories() {
    return db.all('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> \'\' ORDER BY category').map((r) => r.category);
  }

  function findByCode({ code } = {}) {
    const c = codeStr(code);
    if (!c) return null;
    return db.get(`${PRODUCT_SELECT} WHERE p.barcode = ? OR p.sku = ? COLLATE NOCASE LIMIT 1`, [c, c]);
  }

  // Saran dropdown: kata acak & tahan salah ketik (lihat search.js)
  function searchProducts({ q = '', limit = 8 } = {}) {
    if (!String(q || '').trim()) return [];
    return rankProducts(db.all(PRODUCT_SELECT), q, limit);
  }

  function normalizeProduct(d) {
    return {
      sku: toStr(d.sku, 'SKU', { required: true, max: 50 }),
      barcode: toStr(codeStr(d.barcode), 'Barcode', { required: true, max: 64 }),
      name: toStr(d.name, 'Nama barang', { required: true, max: 150 }),
      brand: toStr(d.brand, 'Merk', { def: '-', max: 80 }),
      category: toStr(d.category, 'Kategori', { def: 'Umum', max: 80 }),
      unit_price: toInt(d.unit_price, 'Harga jual', { min: 0 }),
      pack_unit: toStr(d.pack_unit, 'Satuan masuk', { def: 'Dus', max: 30 }),
      pack_ratio: toInt(d.pack_ratio, 'Rasio isi dus', { min: 1, def: 1 }),
      min_floor_alert: toInt(d.min_floor_alert, 'Batas minimum display toko', { min: 0, def: 5 }),
    };
  }

  function assertBarcodeFree(barcode, sku) {
    const other = db.get('SELECT sku, name FROM products WHERE barcode = ? AND sku <> ?', [barcode, sku]);
    if (other) fail(`Barcode ${barcode} sudah dipakai oleh barang "${other.name}" (SKU ${other.sku}).`);
  }

  function insertProduct(p, stock) {
    db.run(
      `INSERT INTO products(sku, barcode, name, brand, category, unit_price, base_unit, pack_unit, pack_ratio)
       VALUES(?, ?, ?, ?, ?, ?, 'Biji', ?, ?)`,
      [p.sku, p.barcode, p.name, p.brand, p.category, p.unit_price, p.pack_unit, p.pack_ratio],
    );
    db.run(
      'INSERT INTO inventory(sku, floor_stock, warehouse_stock, damaged_stock, shopee_stock, min_floor_alert) VALUES(?, ?, ?, ?, ?, ?)',
      [p.sku, stock.floor, stock.warehouse, stock.damaged, stock.shopee || 0, p.min_floor_alert],
    );
  }

  function updateProduct(p) {
    db.run(
      `UPDATE products SET barcode = ?, name = ?, brand = ?, category = ?, unit_price = ?, base_unit = 'Biji', pack_unit = ?, pack_ratio = ?
       WHERE sku = ?`,
      [p.barcode, p.name, p.brand, p.category, p.unit_price, p.pack_unit, p.pack_ratio, p.sku],
    );
    db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [p.sku]);
    db.run('UPDATE inventory SET min_floor_alert = ? WHERE sku = ?', [p.min_floor_alert, p.sku]);
  }

  function saveProduct({ product = {}, isNew = false, initial = {} } = {}) {
    const p = normalizeProduct(product);
    const exists = !!db.get('SELECT 1 FROM products WHERE sku = ?', [p.sku]);
    if (isNew && exists) fail(`SKU ${p.sku} sudah terdaftar.`);
    if (!isNew && !exists) fail(`SKU ${p.sku} tidak ditemukan.`);
    if (masterLocked()) {
      if (isNew) assertMasterUnlocked('barang baru ditambahkan');
      // Saat terkunci hanya batas minimum display toko yang boleh diubah di toko
      const cur = db.get('SELECT * FROM products WHERE sku = ?', [p.sku]);
      const changed = ['barcode', 'name', 'brand', 'category', 'unit_price', 'pack_unit', 'pack_ratio'].filter((k) => String(cur[k]) !== String(p[k]));
      if (changed.length) assertMasterUnlocked('kode, nama, barcode, merk, kategori, harga, dan satuan diubah');
    }
    assertBarcodeFree(p.barcode, p.sku);
    db.tx(() => {
      if (isNew) {
        insertProduct(p, {
          floor: toInt(initial.floor, 'Stok awal toko', { def: 0 }),
          warehouse: toInt(initial.warehouse, 'Stok awal gudang', { def: 0 }),
          damaged: toInt(initial.damaged, 'Stok awal BS', { def: 0 }),
          shopee: toInt(initial.shopee, 'Stok awal Shopee', { def: 0 }),
        });
      } else {
        updateProduct(p);
      }
    });
    return getProduct(p.sku);
  }

  function deleteProduct({ sku } = {}) {
    const p = getProduct(sku);
    if (!p) fail('Barang tidak ditemukan.');
    assertMasterUnlocked('barang dihapus');
    const refs = db.get(
      `SELECT (SELECT COUNT(*) FROM stock_reception_items WHERE sku = ?) +
              (SELECT COUNT(*) FROM stock_transfers WHERE sku = ?) +
              (SELECT COUNT(*) FROM shift_sales WHERE sku = ?) +
              (SELECT COUNT(*) FROM stock_opname_items WHERE sku = ?) AS n`,
      [sku, sku, sku, sku],
    ).n;
    if (refs > 0) fail(`"${p.name}" tidak bisa dihapus karena sudah memiliki riwayat penerimaan, mutasi, opname, atau penjualan.`);
    db.tx(() => {
      db.run('DELETE FROM inventory WHERE sku = ?', [sku]);
      db.run('DELETE FROM products WHERE sku = ?', [sku]);
    });
    return true;
  }

  function importRows(rows = []) {
    assertMasterUnlocked('daftar barang diimpor');
    const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    const data = rows.map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[norm(k)] = v;
      return o;
    });
    const nonEmpty = data.filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''));
    if (!nonEmpty.length) fail('File tidak berisi data barang.');
    // Format "data item" dari program lama: Kode Item, Nama Item, Jenis, Rak, Stok, Satuan, Harga Jual.
    // Kode Item = SKU & barcode (barang baru), Jenis = kategori, Stok = stok awal Gudang Utama (boleh minus).
    const dataItem = 'kodeitem' in data[0] && 'namaitem' in data[0] && 'hargajual' in data[0];
    if (dataItem) {
      for (const r of data) {
        r.sku = r.kodeitem;
        r.namabarang = r.namaitem;
        if (!('kategori' in r)) r.kategori = r.jenis;
        if (!('stokawalgudang' in r)) r.stokawalgudang = r.stok;
      }
    }
    for (const req of dataItem ? ['sku', 'namabarang', 'hargajual'] : ['barcode', 'sku', 'namabarang', 'hargajual']) {
      if (!(req in data[0])) {
        fail(`Kolom wajib "${TEMPLATE_HEADERS.find((h) => norm(h) === req)}" tidak ditemukan. Gunakan template import, atau file "data item" dengan kolom Kode Item, Nama Item, dan Harga Jual.`);
      }
    }
    const result = { inserted: 0, updated: 0, errors: [], format: dataItem ? 'data item' : 'template' };
    const seenSku = new Set();
    const seenBarcode = new Map();
    db.tx(() => {
      data.forEach((r, i) => {
        const line = i + 2; // baris 1 = header
        if (!Object.values(r).some((v) => String(v ?? '').trim() !== '')) return;
        try {
          const fromRow = {
            sku: r.sku, barcode: r.barcode, name: r.namabarang, brand: r.merk, category: r.kategori,
            unit_price: r.hargajual, pack_unit: r.satuanmasuk, pack_ratio: r.rasioisidus, min_floor_alert: r.minalerttoko,
          };
          // Untuk SKU yang sudah ada, kolom kosong mempertahankan nilai lama
          const existing = getProduct(codeStr(r.sku));
          // Format data item tidak punya kolom barcode: barang baru memakai Kode Item, barang lama tetap barcode-nya
          if (dataItem && !('barcode' in r && String(r.barcode ?? '').trim())) fromRow.barcode = existing ? '' : r.kodeitem;
          const merged = { ...(existing || {}) };
          for (const [k, v] of Object.entries(fromRow)) if (!existing || String(v ?? '').trim() !== '') merged[k] = v;
          const p = normalizeProduct(merged);
          if (seenSku.has(p.sku.toLowerCase())) fail(`SKU ${p.sku} muncul lebih dari sekali di file.`);
          if (seenBarcode.has(p.barcode)) fail(`Barcode ${p.barcode} sama dengan baris ${seenBarcode.get(p.barcode)}.`);
          // Stok awal boleh minus (data dari program lama dibawa apa adanya)
          const stock = {
            floor: toInt(r.stokawaltoko, 'Stok_Awal_Toko', { def: 0, min: -1e9 }),
            warehouse: toInt(r.stokawalgudang, 'Stok_Awal_Gudang', { def: 0, min: -1e9 }),
            damaged: toInt(r.stokawalbs, 'Stok_Awal_BS', { def: 0, min: -1e9 }),
            shopee: toInt(r.stokawalshopee, 'Stok_Awal_Shopee', { def: 0, min: -1e9 }),
          };
          assertBarcodeFree(p.barcode, p.sku);
          seenSku.add(p.sku.toLowerCase());
          seenBarcode.set(p.barcode, line);
          if (existing) {
            updateProduct(p); // stok awal diabaikan untuk SKU yang sudah ada
            result.updated++;
          } else {
            insertProduct(p, stock);
            result.inserted++;
          }
        } catch (e) {
          if (!e.userFacing) throw e;
          result.errors.push(`Baris ${line}: ${e.message}`);
        }
      });
    });
    return result;
  }

  function stockSnapshot() {
    return db.all(`${PRODUCT_SELECT} ORDER BY p.category COLLATE NOCASE, p.name COLLATE NOCASE`);
  }

  // Tandai barang yang display tokonya habis/minus karena terjual (merah di Saran Restock);
  // tanda hilang begitu display toko diisi lagi (> 0). Barang yang memang belum pernah dipajang tidak merah.
  function markSoldOut(sku, at) {
    db.run('UPDATE inventory SET sold_out_at = ? WHERE sku = ? AND floor_stock <= 0', [at || localNow(), sku]);
  }
  function clearSoldOut(sku) {
    db.run('UPDATE inventory SET sold_out_at = NULL WHERE sku = ? AND floor_stock > 0', [sku]);
  }

  function lowStock({ limit = 50 } = {}) {
    const soldOut = 'i.sold_out_at IS NOT NULL AND COALESCE(i.floor_stock,0) <= 0';
    return db.all(
      // Habis/minus karena terjual selalu paling atas (paling minus dulu), lalu yang menipis
      `${PRODUCT_SELECT.replace('COALESCE(i.min_floor_alert, 5) AS min_floor_alert', `COALESCE(i.min_floor_alert, 5) AS min_floor_alert, (${soldOut}) AS sold_out`)}
       WHERE COALESCE(i.floor_stock,0) <= COALESCE(i.min_floor_alert,5)
       ORDER BY (${soldOut}) DESC,
                CASE WHEN ${soldOut} THEN COALESCE(i.floor_stock,0) END,
                (COALESCE(i.warehouse_stock,0) > 0) DESC, COALESCE(i.floor_stock,0) - COALESCE(i.min_floor_alert,5), p.name LIMIT ?`,
      [limit],
    ).map((p) => ({ ...p, sold_out: !!p.sold_out }));
  }

  // ---------------------------------------------------------------- Shift & Kasir
  function getShift() {
    return db.get('SELECT * FROM active_shift WHERE id = 1');
  }

  // Tanpa modal awal laci: kolom initial_cash dibiarkan 0 (kompatibel dengan database & cadangan lama)
  function openShift({ cashier_name } = {}) {
    if (getShift()) fail('Shift sudah dibuka.');
    const name = toStr(cashier_name, 'Nama kasir', { required: true, max: 60 });
    db.tx(() => db.run('INSERT INTO active_shift(id, cashier_name, shift_start, initial_cash, shift_uid) VALUES(1, ?, ?, 0, ?)', [name, localNow(), crypto.randomUUID()]));
    return getShift();
  }

  function nextReceiptNo() {
    const d = localNow().slice(0, 10).replace(/-/g, '');
    const seq = getSetting('receipt_date') === d ? Number(getSetting('receipt_seq', '0')) + 1 : 1;
    setSetting('receipt_date', d);
    setSetting('receipt_seq', seq);
    return `INV-${d}-${String(seq).padStart(4, '0')}`;
  }

  // client_ref: penanda unik tiap percobaan bayar dari PC kasir (lihat importOfflineSale)
  function checkout({ items = [], payment_method, cash_received, client_ref } = {}) {
    const shift = getShift();
    if (!shift) fail('Shift belum dibuka. Buka shift terlebih dahulu.');
    if (!PAYMENT_METHODS.includes(payment_method)) fail('Metode pembayaran tidak dikenal.');
    if (!Array.isArray(items) || !items.length) fail('Keranjang masih kosong.');

    const merged = new Map();
    for (const it of items) {
      const qty = toInt(it.qty, 'Jumlah', { min: 1 });
      merged.set(it.sku, (merged.get(it.sku) || 0) + qty);
    }

    return db.tx(() => {
      const lines = [];
      for (const [sku, qty] of merged) {
        const p = getProduct(sku);
        if (!p) fail(`Barang dengan SKU ${sku} tidak ditemukan.`);
        // Display toko kurang tetap boleh dijual (barang fisik ada di rak); display toko jadi 0/minus
        // dan barang muncul merah paling atas di "Saran Restock Rak Toko" untuk gudang.
        lines.push({ sku, name: p.name, qty, unit_price: p.unit_price, line_total: p.unit_price * qty });
      }
      const total = lines.reduce((s, l) => s + l.line_total, 0);
      let cash = total;
      if (payment_method === 'Tunai') {
        cash = toInt(cash_received, 'Uang diterima', { def: 0 });
        if (cash < total) fail(`Uang diterima kurang Rp ${(total - cash).toLocaleString('id-ID')}.`);
      }
      const ref = client_ref ? toStr(client_ref, 'Penanda transaksi', { max: 64 }) : '';
      if (ref) {
        const prev = db.get('SELECT receipt_no FROM checkout_refs WHERE client_ref = ?', [ref]);
        if (prev) fail(`Transaksi ini sudah tercatat dengan nomor struk ${prev.receipt_no}.`);
      }
      const receipt_no = nextReceiptNo();
      const created_at = localNow();
      if (ref) db.run('INSERT INTO checkout_refs(client_ref, receipt_no, created_at) VALUES(?, ?, ?)', [ref, receipt_no, created_at]);
      const short = [];
      for (const l of lines) {
        db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [l.sku]);
        db.run('UPDATE inventory SET floor_stock = floor_stock - ? WHERE sku = ?', [l.qty, l.sku]);
        const after = getProduct(l.sku).floor_stock;
        if (after <= 0) {
          short.push({ sku: l.sku, name: l.name, floor_stock: after });
          markSoldOut(l.sku, created_at);
        }
        db.run(
          `INSERT INTO shift_sales(receipt_no, sku, product_name, qty_sold, unit_price, line_total, payment_method, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [receipt_no, l.sku, l.name, l.qty, l.unit_price, l.line_total, payment_method, created_at],
        );
      }
      return {
        receipt_no, created_at, payment_method, lines, total,
        cash_received: cash, change: cash - total, cashier: shift.cashier_name, short,
      };
    });
  }

  function shiftSummary() {
    const shift = getShift();
    // Nota pembatalan (BTL-...) berisi baris minus: omset, barang, dan tunai otomatis bersih,
    // tetapi tidak dihitung sebagai struk penjualan.
    const totals = db.get(
      `SELECT (SELECT COUNT(DISTINCT receipt_no) FROM shift_sales WHERE receipt_no NOT LIKE 'BTL-%') AS receipts,
              COALESCE(SUM(line_total),0) AS revenue, COALESCE(SUM(qty_sold),0) AS qty FROM shift_sales`,
    );
    const byMethod = db.all(
      `SELECT payment_method AS method, COUNT(DISTINCT CASE WHEN receipt_no NOT LIKE 'BTL-%' THEN receipt_no END) AS receipts, SUM(line_total) AS total
       FROM shift_sales GROUP BY payment_method ORDER BY total DESC`,
    );
    const byItem = db.all(
      `SELECT sku, product_name AS name, SUM(qty_sold) AS qty, SUM(line_total) AS total
       FROM shift_sales GROUP BY sku, product_name HAVING SUM(qty_sold) <> 0 ORDER BY total DESC`,
    );
    const receipts = db.all(
      `SELECT s.receipt_no, MIN(s.created_at) AS created_at, s.payment_method, SUM(s.qty_sold) AS qty, SUM(s.line_total) AS total,
              v.void_no, vo.receipt_no AS void_of
       FROM shift_sales s LEFT JOIN receipt_voids v ON v.receipt_no = s.receipt_no LEFT JOIN receipt_voids vo ON vo.void_no = s.receipt_no
       GROUP BY s.receipt_no ORDER BY MIN(s.id) DESC LIMIT 100`,
    );
    const voidList = db.all('SELECT * FROM receipt_voids WHERE void_no IN (SELECT receipt_no FROM shift_sales) ORDER BY created_at');
    const voids = { count: voidList.length, total: voidList.reduce((s, v) => s + v.total, 0), list: voidList };
    const cashSales = byMethod.filter((m) => m.method === 'Tunai').reduce((s, m) => s + m.total, 0);
    const offline = {
      receipts: db.get("SELECT COUNT(DISTINCT receipt_no) AS n FROM shift_sales WHERE receipt_no LIKE 'OFF-%'").n,
      checks: offlineChecks(),
    };
    return {
      shift, totals, byMethod, byItem, receipts, offline, voids,
      cashSales,
    };
  }

  function receiptDetail({ receipt_no } = {}) {
    return db.all('SELECT * FROM shift_sales WHERE receipt_no = ? ORDER BY id', [receipt_no]);
  }

  // Data nota untuk cetak ulang (uang diterima tidak tersimpan, jadi tanpa kembalian). Hanya struk shift berjalan.
  function receiptForReprint({ receipt_no } = {}) {
    const rows = receiptDetail({ receipt_no });
    if (!rows.length) fail('Struk tidak ditemukan.');
    if (/^BTL-/.test(receipt_no)) return voidSlip(receipt_no);
    const total = rows.reduce((s, r) => s + r.line_total, 0);
    const shift = getShift();
    const v = db.get('SELECT void_no FROM receipt_voids WHERE receipt_no = ?', [receipt_no]);
    return {
      receipt_no, created_at: rows[0].created_at, payment_method: rows[0].payment_method,
      cashier: shift ? shift.cashier_name : '-', total, cash_received: total, change: 0, voided_by: v ? v.void_no : '',
      lines: rows.map((r) => ({ sku: r.sku, name: r.product_name, qty: r.qty_sold, unit_price: r.unit_price, line_total: r.line_total })),
    };
  }

  // ---------------------------------------------------------------- Batal nota (disetujui PIN Admin)
  // Nota asli TIDAK diubah atau dihapus. Pembatalan = nota baru BTL-... berisi baris minus di shift_sales,
  // sehingga omset, uang tunai, stok, Rekap, dan kiriman ke mother base ikut terkoreksi. Hanya nota shift berjalan.
  function nextVoidNo() {
    const d = localNow().slice(0, 10).replace(/-/g, '');
    const seq = getSetting('void_date') === d ? Number(getSetting('void_seq', '0')) + 1 : 1;
    setSetting('void_date', d);
    setSetting('void_seq', seq);
    return `BTL-${d}-${String(seq).padStart(4, '0')}`;
  }

  // Penyetuju batal nota: PIN Pembatalan (kepala toko) atau PIN salah satu Admin aktif. PIN Kasir / Gudang tidak berlaku.
  function approverAdmin(pin) {
    const p = String(pin || '');
    const vp = p && currentVoidPin();
    if (vp && sameText(p, vp)) return `${getSetting('void_pin_holder') || VOID_PIN_HOLDER} (PIN Pembatalan)`;
    const u = p && authCache().find((x) => x.active && x.role === 'admin' && checkPin(p, x.pin_salt, x.pin_hash));
    if (!u) fail('PIN Admin / PIN Pembatalan salah.');
    return u.name;
  }

  // ---------------------------------------------------------------- PIN Pembatalan (kepala toko)
  // Diatur Admin di Pengaturan agar kepala toko bisa menyetujui batal nota tanpa mengetahui PIN Admin.
  // Disimpan terenkripsi akun Windows (Admin bisa menampilkannya lagi). Tidak termasuk SETTING_KEYS,
  // jadi tidak ikut getSettings, cache PC kasir, atau kiriman ke kantor.
  const VOID_PIN_HOLDER = 'Kepala Toko';
  const currentVoidPin = () => decrypt(getSetting('void_pin'));
  const sameText = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  function voidPinInfo({ reveal = false } = {}) {
    const pin = currentVoidPin();
    const out = { set: !!pin, holder: getSetting('void_pin_holder') || VOID_PIN_HOLDER, updated_at: pin ? getSetting('void_pin_updated_at') : '' };
    if (reveal && pin) out.pin = pin;
    return out;
  }

  function setVoidPin({ pin, holder } = {}) {
    const p = String(pin ?? '').trim();
    if (!/^\d{6}$/.test(p)) fail('PIN Pembatalan harus 6 digit angka.');
    if (authCache().some((u) => checkPin(p, u.pin_salt, u.pin_hash))) fail('PIN Pembatalan tidak boleh sama dengan PIN login akun mana pun.');
    const h = toStr(holder, 'Nama pemegang', { max: 40 }) || VOID_PIN_HOLDER;
    db.tx(() => {
      setSetting('void_pin', encrypt(p));
      setSetting('void_pin_holder', h);
      setSetting('void_pin_updated_at', localNow());
    });
    return voidPinInfo();
  }

  function clearVoidPin() {
    db.tx(() => db.run("DELETE FROM settings WHERE key IN ('void_pin', 'void_pin_holder', 'void_pin_updated_at')"));
    return voidPinInfo();
  }

  function voidSlip(void_no) {
    const v = db.get('SELECT * FROM receipt_voids WHERE void_no = ?', [void_no]);
    if (!v) fail('Data pembatalan tidak ditemukan.');
    const rows = receiptDetail({ receipt_no: void_no });
    const orig = receiptDetail({ receipt_no: v.receipt_no });
    return {
      receipt_no: void_no, void_of: v.receipt_no, void_of_at: orig.length ? orig[0].created_at : '', created_at: v.created_at,
      payment_method: rows.length ? rows[0].payment_method : 'Tunai', cashier: v.requested_by,
      reason: v.reason, requested_by: v.requested_by, approved_by: v.approved_by, total: v.total,
      lines: rows.map((r) => ({ sku: r.sku, name: r.product_name, qty: -r.qty_sold, unit_price: r.unit_price, line_total: -r.line_total })),
    };
  }

  function voidReceipt({ receipt_no, reason, items = [], requested_by, approver_pin } = {}) {
    const shift = getShift();
    if (!shift) fail('Shift belum dibuka.');
    const no = toStr(receipt_no, 'No. struk', { required: true, max: 40 });
    if (/^BTL-/.test(no)) fail('Nota pembatalan tidak bisa dibatalkan.');
    const rows = receiptDetail({ receipt_no: no });
    if (!rows.length) fail('Nota tidak ditemukan di shift berjalan. Hanya nota shift yang sedang berjalan yang bisa dibatalkan.');
    const done = db.get('SELECT void_no FROM receipt_voids WHERE receipt_no = ?', [no]);
    if (done) fail(`Nota ini sudah dibatalkan (${done.void_no}).`);
    const why = toStr(reason, 'Alasan pembatalan', { required: true, max: 200 });
    if (why.length < 3) fail('Alasan pembatalan minimal 3 huruf.');
    const dest = new Map((Array.isArray(items) ? items : []).filter(Boolean).map((i) => [i.sku, i.destination]));
    for (const r of rows) {
      if (!['floor', 'damaged'].includes(dest.get(r.sku))) fail(`Pilih stok tujuan untuk "${r.product_name}" (Display Toko / Gudang BS).`);
    }
    const approved_by = approverAdmin(approver_pin);
    const by = toStr(requested_by, 'Diminta oleh', { max: 80 }) || shift.cashier_name;
    return db.tx(() => {
      const void_no = nextVoidNo();
      const now = localNow();
      const toBs = [];
      for (const r of rows) {
        db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [r.sku]);
        db.run('UPDATE inventory SET floor_stock = floor_stock + ? WHERE sku = ?', [r.qty_sold, r.sku]);
        db.run(
          `INSERT INTO shift_sales(receipt_no, sku, product_name, qty_sold, unit_price, line_total, payment_method, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [void_no, r.sku, r.product_name, -r.qty_sold, r.unit_price, -r.line_total, r.payment_method, now],
        );
        if (dest.get(r.sku) === 'damaged') toBs.push({ p: getProduct(r.sku) || { sku: r.sku, name: r.product_name }, qty: r.qty_sold });
        else clearSoldOut(r.sku);
      }
      // Barang rusak: dari Display Toko langsung dipindah ke Gudang BS (tercatat sebagai dokumen mutasi)
      if (toBs.length) writeTransferDoc('floor', 'damaged', `Retur pelanggan (batal nota ${no}, ${void_no})`, toBs, now, { allowShort: true });
      const total = rows.reduce((s, r) => s + r.line_total, 0);
      db.run('INSERT INTO receipt_voids(void_no, receipt_no, reason, requested_by, approved_by, total, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
        [void_no, no, why, by, approved_by, total, now]);
      return voidSlip(void_no);
    });
  }

  function shiftSalesRows() {
    return db.all('SELECT * FROM shift_sales ORDER BY id');
  }

  // ---------------------------------------------------------------- Riwayat shift (cadangan 4 hari)
  // Tutup shift tidak menghapus penjualan: barisnya dipindah ke riwayat. Riwayat yang ditutup sebelum
  // 00:00 tiga hari lalu dihapus otomatis. Penjualan shift juga masuk antrean mother base (mb_outbox_shift),
  // yang tidak ikut dihapus sampai diterima mother base.
  function historyCutoff(today = localNow().slice(0, 10)) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (SHIFT_HISTORY_DAYS - 1));
    return `${d.toISOString().slice(0, 10)} 00:00:00`;
  }

  function pruneShiftHistory({ today } = {}) {
    const cutoff = historyCutoff(today);
    const oldVoids = 'FROM receipt_voids WHERE created_at < ? AND void_no NOT IN (SELECT receipt_no FROM shift_sales)';
    if (db.get(`SELECT COUNT(*) AS n ${oldVoids}`, [cutoff]).n) db.tx(() => db.run(`DELETE ${oldVoids}`, [cutoff]));
    const n = db.get('SELECT COUNT(*) AS n FROM shift_history WHERE closed_at < ?', [cutoff]).n;
    if (!n) return 0;
    db.tx(() => {
      db.run('DELETE FROM shift_history WHERE closed_at < ?', [cutoff]);
      db.run('DELETE FROM shift_history_sales WHERE shift_uid NOT IN (SELECT shift_uid FROM shift_history)');
    });
    return n;
  }

  function archiveShift({ closed_at, notes = '', report_dir = '' } = {}) {
    const shift = getShift();
    if (!shift) fail('Tidak ada shift aktif.');
    const uid = ensureShiftUid();
    const sum = shiftSummary();
    const closedAt = closed_at || localNow();
    const forMb = shiftData({ closed_at: closedAt, notes });
    db.tx(() => {
      db.run('INSERT OR REPLACE INTO mb_outbox_shift(shift_uid, closed_at, payload, created_at, sent_at) VALUES(?, ?, ?, ?, NULL)',
        [uid, closedAt, JSON.stringify(forMb), localNow()]);
      db.run(
        `INSERT OR REPLACE INTO shift_history(shift_uid, cashier_name, shift_start, closed_at, notes, receipts, qty, revenue, cash_sales, by_method, report_dir)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, shift.cashier_name, shift.shift_start, closedAt, String(notes || ''), sum.totals.receipts, sum.totals.qty,
          sum.totals.revenue, sum.cashSales, JSON.stringify(sum.byMethod.map((m) => ({ method: m.method, receipts: m.receipts, total: m.total }))),
          String(report_dir || '')],
      );
      db.run('DELETE FROM shift_history_sales WHERE shift_uid = ?', [uid]);
      db.run(
        `INSERT INTO shift_history_sales(shift_uid, receipt_no, sku, product_name, qty_sold, unit_price, line_total, payment_method, created_at)
         SELECT ?, receipt_no, sku, product_name, qty_sold, unit_price, line_total, payment_method, created_at FROM shift_sales ORDER BY id`,
        [uid],
      );
      db.run('DELETE FROM shift_sales');
      db.run('DELETE FROM active_shift');
      db.run("DELETE FROM checkout_refs WHERE created_at < datetime('now','localtime','-60 days')");
      pruneShiftHistory();
    });
    return { shift_uid: uid };
  }

  // Riwayat shift (cadangan) beserta status kirim ke mother base. Tidak ditampilkan di layar pegawai.
  // daftar ini sengaja tanpa omset, struk, atau barang.
  function listShiftHistory() {
    return db.all(
      `SELECT h.shift_uid, h.cashier_name, h.shift_start, h.closed_at, CASE WHEN o.sent_at IS NULL THEN 0 ELSE 1 END AS mb_terkirim
       FROM shift_history h LEFT JOIN mb_outbox_shift o ON o.shift_uid = h.shift_uid ORDER BY h.closed_at DESC`,
    );
  }

  // ---------------------------------------------------------------- Transaksi mode darurat (dari PC kasir)
  // Barang sudah keluar fisik dan nota sudah dicetak, jadi transaksi SELALU dicatat dengan harga & waktu
  // saat dijual. Bila display toko tidak cukup, display toko dibiarkan minus dan transaksi ditandai "perlu dicek"
  // (bukan ditolak), supaya omset & laci kasir tetap cocok dan selisih stok terlihat jelas oleh owner.
  function importOfflineSale({ receipt_no, client_ref, created_at, payment_method, cashier, lines = [] } = {}) {
    const no = toStr(receipt_no, 'No. struk darurat', { required: true, max: 60 });
    if (!/^OFF-/.test(no)) fail('No. struk darurat harus diawali OFF-.');
    if (LEGACY_PAYMENT[payment_method]) payment_method = LEGACY_PAYMENT[payment_method];
    if (!PAYMENT_METHODS.includes(payment_method)) fail('Metode pembayaran tidak dikenal.');
    if (!Array.isArray(lines) || !lines.length) fail(`Struk ${no} tidak berisi barang.`);
    const items = lines.map((l) => ({
      sku: toStr(l.sku, 'SKU', { required: true, max: 50 }),
      name: toStr(l.name, 'Nama barang', { def: String(l.sku), max: 150 }),
      qty: toInt(l.qty, 'Jumlah', { min: 1 }),
      unit_price: toInt(l.unit_price, 'Harga', { min: 0 }),
    }));
    const when = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(created_at || '')) ? created_at : localNow();
    const ref = client_ref ? toStr(client_ref, 'Penanda transaksi', { max: 64 }) : '';
    const total = items.reduce((s, l) => s + l.unit_price * l.qty, 0);

    return db.tx(() => {
      if (db.get('SELECT 1 FROM offline_sales WHERE receipt_no = ?', [no])) {
        return { receipt_no: no, status: 'duplicate', notes: ['Sudah pernah diterima sebelumnya.'] };
      }
      const record = (status, notes) => db.run(
        `INSERT INTO offline_sales(receipt_no, client_ref, cashier_name, created_at, synced_at, total, status, notes)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [no, ref, toStr(cashier, 'Kasir', { def: '-', max: 60 }), when, localNow(), total, status, notes.join('\n')],
      );
      const online = ref && db.get('SELECT receipt_no FROM checkout_refs WHERE client_ref = ?', [ref]);
      if (online) {
        const notes = [`Sudah tercatat online sebagai ${online.receipt_no}; tidak dicatat dua kali.`];
        record('duplicate', notes);
        return { receipt_no: no, status: 'duplicate', online_receipt: online.receipt_no, notes };
      }
      const notes = [];
      for (const l of items) {
        const p = getProduct(l.sku);
        if (!p) {
          notes.push(`${l.name} (SKU ${l.sku}) tidak ada di database gudang — penjualan dicatat, stok tidak dipotong.`);
        } else {
          db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [l.sku]);
          db.run('UPDATE inventory SET floor_stock = floor_stock - ? WHERE sku = ?', [l.qty, l.sku]);
          if (p.floor_stock - l.qty <= 0) markSoldOut(l.sku, when);
          if (p.floor_stock < l.qty) {
            notes.push(`${p.name}: display toko ${p.floor_stock}, terjual ${l.qty} → display toko ${p.floor_stock - l.qty}. Cek fisik rak / catat mutasi.`);
          }
        }
        db.run(
          `INSERT INTO shift_sales(receipt_no, sku, product_name, qty_sold, unit_price, line_total, payment_method, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [no, l.sku, p ? p.name : l.name, l.qty, l.unit_price, l.unit_price * l.qty, payment_method, when],
        );
      }
      if (!getShift()) notes.push('Diterima saat tidak ada shift aktif — masuk ke laporan shift berikutnya.');
      const status = notes.length ? 'check' : 'ok';
      record(status, notes);
      return { receipt_no: no, status, notes };
    });
  }

  function offlineChecks() {
    return db.all("SELECT * FROM offline_sales WHERE status = 'check' AND checked_at IS NULL ORDER BY created_at")
      .map((r) => ({ ...r, notes: r.notes ? r.notes.split('\n') : [] }));
  }

  function markOfflineChecked({ receipt_no } = {}) {
    const r = db.tx(() => db.run("UPDATE offline_sales SET checked_at = ? WHERE receipt_no = ? AND status = 'check' AND checked_at IS NULL", [localNow(), receipt_no]));
    if (r.changes !== 1) fail('Transaksi darurat tidak ditemukan atau sudah ditandai.');
    return true;
  }

  // ---------------------------------------------------------------- Mutasi
  // Satu form mutasi: satu arah + satu alasan untuk beberapa barang; gagal satu = batal semua
  // Nomor urut per hari: MT-YYYYMMDD-001 / OP-YYYYMMDD-001
  function nextDocNo(code, table, now) {
    const prefix = `${code}-${now.slice(0, 10).replace(/-/g, '')}-`;
    const last = db.get(`SELECT doc_no FROM ${table} WHERE doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1`, [`${prefix}%`]);
    return prefix + String((last ? Number(last.doc_no.slice(prefix.length)) : 0) + 1).padStart(3, '0');
  }

  function createTransferDoc({ from_zone, to_zone, reason, items = [] } = {}) {
    const dir = DIRECTIONS.find((d) => d.from === from_zone && d.to === to_zone);
    if (!dir) fail('Arah mutasi tidak valid.');
    const why = toStr(reason, 'Alasan', { max: 200 });
    if (!Array.isArray(items) || !items.length) fail('Tambahkan minimal satu barang.');
    const lines = [];
    items.forEach((it, idx) => {
      const p = getProduct(it && it.sku);
      if (!p) fail(`Barang baris ${idx + 1} tidak ditemukan.`);
      const n = toInt(it.qty, `Jumlah "${p.name}"`, { min: 1 });
      const same = lines.find((l) => l.p.sku === p.sku);
      if (same) same.qty += n;
      else lines.push({ p, qty: n });
    });
    const now = localNow();
    const id = db.tx(() => writeTransferDoc(from_zone, to_zone, why, lines, now));
    return getTransferDoc({ id });
  }

  // Tulis dokumen mutasi (dipanggil di dalam transaksi). allowShort hanya untuk proses internal
  // (batal nota → barang rusak ke Gudang BS) yang boleh membuat display toko minus.
  function writeTransferDoc(from_zone, to_zone, why, lines, now, { allowShort = false } = {}) {
    for (const { p, qty: n } of lines) {
      db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [p.sku]);
      if (ZONE_COL[from_zone]) {
        const col = ZONE_COL[from_zone];
        const r = db.run(`UPDATE inventory SET ${col} = ${col} - ? WHERE sku = ?${allowShort ? '' : ` AND ${col} >= ?`}`, allowShort ? [n, p.sku] : [n, p.sku, n]);
        if (r.changes !== 1) fail(`${ZONE_LABEL[from_zone]} untuk "${p.name}" tidak cukup. Tersedia ${p[col]} Biji.`);
      }
      if (ZONE_COL[to_zone]) {
        const col = ZONE_COL[to_zone];
        db.run(`UPDATE inventory SET ${col} = ${col} + ? WHERE sku = ?`, [n, p.sku]);
        if (to_zone === 'floor') clearSoldOut(p.sku);
      }
    }
    const docNo = nextDocNo('MT', 'stock_transfer_docs', now);
    db.run('INSERT INTO stock_transfer_docs(doc_no, from_zone, to_zone, reason, created_at, line_count, total_qty) VALUES(?, ?, ?, ?, ?, ?, ?)', [
      docNo, from_zone, to_zone, String(why).slice(0, 200), now, lines.length, lines.reduce((s, l) => s + l.qty, 0),
    ]);
    const did = db.lastId();
    for (const { p, qty: n } of lines) {
      db.run('INSERT INTO stock_transfers(sku, from_zone, to_zone, qty, reason, created_at, doc_id) VALUES(?, ?, ?, ?, ?, ?, ?)', [p.sku, from_zone, to_zone, n, String(why).slice(0, 200), now, did]);
    }
    return did;
  }

  // Mutasi satu barang (dipakai demo/tes): satu dokumen berisi satu baris
  function createTransfer({ sku, from_zone, to_zone, qty, reason } = {}) {
    if (!getProduct(sku)) fail('Pilih barang terlebih dahulu.');
    createTransferDoc({ from_zone, to_zone, reason, items: [{ sku, qty: toInt(qty, 'Jumlah mutasi', { min: 1 }) }] });
    return getProduct(sku);
  }

  function listTransferDocs({ limit = 200, q = '' } = {}) {
    const like = `%${String(q || '').trim()}%`;
    return db.all(
      `SELECT d.* FROM stock_transfer_docs d
       WHERE (? = '%%' OR d.doc_no LIKE ? OR d.reason LIKE ? OR EXISTS (
         SELECT 1 FROM stock_transfers t LEFT JOIN products p ON p.sku = t.sku WHERE t.doc_id = d.id AND (p.name LIKE ? OR t.sku LIKE ?)))
       ORDER BY d.id DESC LIMIT ?`,
      [like, like, like, like, like, Math.min(Number(limit) || 200, 2000)],
    );
  }

  function getTransferDoc({ id } = {}) {
    const d = db.get('SELECT * FROM stock_transfer_docs WHERE id = ?', [id]);
    if (!d) fail('Dokumen mutasi tidak ditemukan.');
    d.items = db.all(
      `SELECT t.sku, t.qty, p.name, p.barcode FROM stock_transfers t
       LEFT JOIN products p ON p.sku = t.sku WHERE t.doc_id = ? ORDER BY t.id`,
      [id],
    );
    return d;
  }

  function listTransfers({ limit = 200, q = '' } = {}) {
    const like = `%${String(q || '').trim()}%`;
    return db.all(
      `SELECT t.*, p.name, p.barcode FROM stock_transfers t LEFT JOIN products p ON p.sku = t.sku
       WHERE (? = '%%' OR p.name LIKE ? OR t.sku LIKE ? OR t.reason LIKE ?)
       ORDER BY t.id DESC LIMIT ?`,
      [like, like, like, like, Math.min(Number(limit) || 200, 2000)],
    );
  }

  // ---------------------------------------------------------------- Stok Opname
  // Tanpa baseline: stok zona di-set ke hasil hitung fisik (hitungan per saat simpan).
  // Dengan baseline (stok di file template per Tanggal_Stok): hanya selisih fisik − baseline yang ditambahkan ke stok
  // sekarang, jadi penjualan / mutasi / penerimaan setelah tanggal itu tetap terhitung.
  // Barang yang tidak ada di list tidak diubah (opname boleh sebagian).
  function createOpname({ zone, notes, items = [], count_at } = {}) {
    const col = ZONE_COL[zone];
    if (!col) fail('Zona opname tidak valid.');
    const why = toStr(notes, 'Catatan', { max: 200 });
    if (!Array.isArray(items) || !items.length) fail('Tambahkan minimal satu barang.');
    const lines = [];
    items.forEach((it, idx) => {
      const p = getProduct(it && it.sku);
      if (!p) fail(`Barang baris ${idx + 1} tidak ditemukan.`);
      const n = toInt(it.counted, `Jumlah fisik "${p.name}"`, { min: 0 });
      const baseline = it.baseline === undefined || it.baseline === null ? null : toInt(it.baseline, `Stok patokan "${p.name}"`, { min: -1e12 });
      const same = lines.find((l) => l.sku === p.sku);
      if (same) same.counted += n;
      else lines.push({ sku: p.sku, counted: n, baseline });
    });
    const countAt = parseStockDate(count_at);
    const now = localNow();
    const id = db.tx(() => {
      let plus = 0;
      let minus = 0;
      for (const l of lines) {
        db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [l.sku]);
        // Stok sistem dibaca saat simpan, bukan saat barang di-scan (penjualan bisa terjadi di tengah hitungan)
        l.before = db.get(`SELECT ${col} AS q FROM inventory WHERE sku = ?`, [l.sku]).q;
        l.system = l.baseline === null ? l.before : l.baseline;
        l.diff = l.counted - l.system;
        const after = l.before + l.diff;
        if (l.diff > 0) plus += l.diff;
        else minus -= l.diff;
        db.run(`UPDATE inventory SET ${col} = ? WHERE sku = ?`, [after, l.sku]);
        if (zone === 'floor' && after > 0) clearSoldOut(l.sku);
      }
      db.run('INSERT INTO stock_opname_docs(doc_no, zone, notes, created_at, line_count, plus_qty, minus_qty, count_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)', [
        nextDocNo('OP', 'stock_opname_docs', now), zone, why, now, lines.length, plus, minus, countAt,
      ]);
      const did = db.lastId();
      for (const l of lines) {
        db.run('INSERT INTO stock_opname_items(doc_id, sku, system_qty, counted_qty, diff, before_qty) VALUES(?, ?, ?, ?, ?, ?)', [did, l.sku, l.system, l.counted, l.diff, l.before]);
      }
      return did;
    });
    return getOpname({ id });
  }

  function listOpnames({ limit = 200, q = '' } = {}) {
    const like = `%${String(q || '').trim()}%`;
    return db.all(
      `SELECT d.* FROM stock_opname_docs d
       WHERE (? = '%%' OR d.doc_no LIKE ? OR d.notes LIKE ? OR EXISTS (
         SELECT 1 FROM stock_opname_items t LEFT JOIN products p ON p.sku = t.sku WHERE t.doc_id = d.id AND (p.name LIKE ? OR t.sku LIKE ?)))
       ORDER BY d.id DESC LIMIT ?`,
      [like, like, like, like, like, Math.min(Number(limit) || 200, 2000)],
    );
  }

  function getOpname({ id } = {}) {
    const d = db.get('SELECT * FROM stock_opname_docs WHERE id = ?', [id]);
    if (!d) fail('Dokumen opname tidak ditemukan.');
    d.items = db.all(
      `SELECT t.sku, t.system_qty, t.counted_qty, t.diff, t.before_qty, p.name, p.barcode FROM stock_opname_items t
       LEFT JOIN products p ON p.sku = t.sku WHERE t.doc_id = ? ORDER BY t.id`,
      [id],
    );
    return d;
  }

  // Baris template opname: semua barang + stok sistem 4 zona, kolom Fisik tiap zona dikosongkan untuk diisi
  function opnameSheet() {
    const stamp = localNow().slice(0, 16); // Tanggal_Stok: stok di file ini per kapan
    return db.all(
      `SELECT p.sku, p.name, COALESCE(i.floor_stock, 0) AS f, COALESCE(i.warehouse_stock, 0) AS w, COALESCE(i.damaged_stock, 0) AS d, COALESCE(i.shopee_stock, 0) AS s
       FROM products p LEFT JOIN inventory i ON i.sku = p.sku ORDER BY p.name COLLATE NOCASE`,
    ).map((r) => [r.sku, r.name, r.f, '', r.w, '', r.d, '', r.s, '', stamp]);
  }

  // Hasil hitung dari Excel per zona. Kolom Fisik yang kosong = zona itu tidak dihitung untuk barang tersebut.
  function planOpnameImport(rows = []) {
    const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    const data = (Array.isArray(rows) ? rows : []).map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r || {})) o[norm(k)] = v;
      return o;
    });
    if (!data.length) fail('File tidak berisi data opname.');
    if (!('kode' in data[0]) || !Object.values(OPNAME_FISIK).some((c) => c in data[0])) {
      fail('Kolom "Kode" dan "Fisik Display Toko / Fisik Gudang Utama / Fisik Gudang BS / Fisik Gudang Shopee" tidak ditemukan. Gunakan template opname terbaru.');
    }
    // Ada Tanggal_Stok → kolom stok di file jadi patokan selisih (lihat createOpname)
    const dated = 'tanggalstok' in data[0];
    const now = localNow();
    const errors = [];
    const zones = {};
    const countAt = {}; // zona → Tanggal_Stok paling awal
    data.forEach((r, i) => {
      const filled = Object.entries(OPNAME_FISIK).filter(([, c]) => String(r[c] ?? '').trim() !== '');
      if (!filled.length) return;
      let p;
      let at = null;
      try {
        const code = codeStr(r.kode);
        if (!code) fail('Kode barang wajib diisi.');
        p = findByCode({ code });
        if (!p) fail(`Kode "${code}" tidak ditemukan di Daftar Barang.`);
        if (dated) {
          at = parseStockDate(r.tanggalstok);
          if (!at) fail(`Tanggal_Stok "${r.tanggalstok}" tidak terbaca (format YYYY-MM-DD HH:MM).`);
          if (at > now) fail(`Tanggal_Stok ${at.slice(0, 16)} belum terjadi.`);
        }
      } catch (e) {
        errors.push(`Baris ${i + 2}: ${e.message}`);
        return;
      }
      for (const [zone, c] of filled) {
        try {
          const counted = toInt(r[c], `Fisik ${ZONE_LABEL[zone]} "${p.name}"`, { min: 0 });
          const baseline = dated ? toInt(r[OPNAME_STOCK[zone]], `Stok ${ZONE_LABEL[zone]} di file untuk "${p.name}"`, { min: -1e12 }) : null;
          const list = zones[zone] || (zones[zone] = []);
          const same = list.find((it) => it.sku === p.sku);
          if (same) same.counted += counted;
          else list.push({ sku: p.sku, name: p.name, counted, baseline });
          if (at && (!countAt[zone] || at < countAt[zone])) countAt[zone] = at;
        } catch (e) {
          errors.push(`Baris ${i + 2}: ${e.message}`);
        }
      }
    });
    return { zones, count_at: countAt, dated, errors };
  }

  // Import hasil opname: dry run = ringkasan selisih per zona; simpan = satu dokumen OP per zona
  function importOpname({ rows, notes, dry_run = false } = {}) {
    const { zones, count_at: countAt, dated, errors } = planOpnameImport(rows);
    const order = Object.keys(ZONE_COL).filter((z) => zones[z]);
    if (dry_run) {
      return {
        dated,
        zones: order.map((zone) => {
          let plus = 0;
          let minus = 0;
          for (const it of zones[zone]) {
            const base = it.baseline === null ? Number(getProduct(it.sku)[ZONE_COL[zone]]) || 0 : it.baseline;
            const d = it.counted - base;
            if (d > 0) plus += d;
            else minus -= d;
          }
          return { zone, line_count: zones[zone].length, plus_qty: plus, minus_qty: minus, count_at: countAt[zone] || null };
        }),
        errors,
      };
    }
    const created = order.map((zone) => createOpname({ zone, notes, items: zones[zone], count_at: countAt[zone] }));
    return { created, errors };
  }

  // ---------------------------------------------------------------- Penerimaan
  function createReception({ reference_no, supplier_name, notes, items = [] } = {}) {
    const ref = toStr(reference_no, 'No. Surat Jalan / Nota', { required: true, max: 60 });
    if (db.get('SELECT 1 FROM stock_receptions WHERE reference_no = ?', [ref])) fail(`No. Surat Jalan "${ref}" sudah pernah dicatat.`);
    if (!Array.isArray(items) || !items.length) fail('Tambahkan minimal satu barang.');
    const lines = items.map((it, idx) => {
      const p = getProduct(it.sku);
      if (!p) fail(`Barang baris ${idx + 1} tidak ditemukan.`);
      const pack_type = it.pack_type === 'Dus' ? 'Dus' : 'Biji';
      const qty = toInt(it.qty, `Jumlah "${p.name}"`, { min: 1 });
      const destination = DESTINATIONS.includes(it.destination) ? it.destination : fail(`Tujuan "${p.name}" tidak valid.`);
      return { sku: p.sku, pack_type, destination, pieces: pack_type === 'Dus' ? qty * p.pack_ratio : qty };
    });
    const total = lines.reduce((s, l) => s + l.pieces, 0);
    const id = db.tx(() => {
      db.run('INSERT INTO stock_receptions(reference_no, supplier_name, notes, received_at, total_items_count) VALUES(?, ?, ?, ?, ?)', [
        ref, toStr(supplier_name, 'Nama supplier', { max: 100 }), toStr(notes, 'Catatan', { max: 500 }), localNow(), total,
      ]);
      const rid = db.lastId();
      for (const l of lines) {
        db.run('INSERT INTO stock_reception_items(reception_id, sku, quantity_received, pack_type, destination) VALUES(?, ?, ?, ?, ?)', [
          rid, l.sku, l.pieces, l.pack_type, l.destination,
        ]);
        db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [l.sku]);
        const col = ZONE_COL[l.destination];
        db.run(`UPDATE inventory SET ${col} = ${col} + ? WHERE sku = ?`, [l.pieces, l.sku]);
        if (l.destination === 'floor') clearSoldOut(l.sku);
      }
      return rid;
    });
    return getReception({ id });
  }

  function listReceptions({ limit = 200, q = '' } = {}) {
    const like = `%${String(q || '').trim()}%`;
    return db.all(
      `SELECT r.*, (SELECT COUNT(*) FROM stock_reception_items i WHERE i.reception_id = r.id) AS line_count
       FROM stock_receptions r WHERE (? = '%%' OR r.reference_no LIKE ? OR r.supplier_name LIKE ?)
       ORDER BY r.id DESC LIMIT ?`,
      [like, like, like, Math.min(Number(limit) || 200, 2000)],
    );
  }

  function planReceptionImport(rows = []) {
    const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    const data = (Array.isArray(rows) ? rows : []).map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r || {})) o[norm(k)] = v;
      return o;
    });
    const filled = (r) => Object.values(r).some((v) => String(v ?? '').trim() !== '');
    if (!data.some(filled)) fail('File tidak berisi data penerimaan.');
    for (const req of ['nosuratjalan', 'kode', 'jumlah']) {
      if (!(req in data[0])) {
        fail(`Kolom wajib "${RECEPTION_TEMPLATE_HEADERS.find((h) => norm(h) === req)}" tidak ditemukan. Gunakan template import penerimaan.`);
      }
    }
    const errors = [];
    const groups = new Map(); // No SJ (huruf kecil) -> dokumen
    const heads = new Map(); // No SJ (huruf kecil) -> supplier & catatan pertama yang terisi
    const unknown = []; // kode belum terdaftar → jadi draft
    data.forEach((r, i) => {
      const line = i + 2; // baris 1 = header
      if (!filled(r)) return;
      try {
        const ref = toStr(codeStr(r.nosuratjalan), 'No_Surat_Jalan', { required: true, max: 60 });
        const key = ref.toLowerCase();
        if (!heads.has(key)) heads.set(key, { supplier_name: '', notes: '' });
        const h = heads.get(key);
        if (!h.supplier_name) h.supplier_name = String(r.supplier ?? '').trim();
        if (!h.notes) h.notes = String(r.catatan ?? '').trim();
        const code = codeStr(r.kode);
        if (!code) fail('Kode barang wajib diisi.');
        const p = findByCode({ code });
        const label = p ? p.name : code;
        const qty = toInt(r.jumlah, `Jumlah "${label}"`, { min: 1 });
        const unit = String(r.satuan ?? '').trim().toLowerCase();
        let pack_type;
        if (['biji', 'pcs', 'pc'].includes(unit)) pack_type = 'Biji';
        else if (!p || !unit || unit === 'dus' || unit === String(p.pack_unit || '').toLowerCase()) pack_type = 'Dus';
        else fail(`Satuan "${r.satuan}" tidak dikenal (pakai Dus / ${p.pack_unit} atau Biji).`);
        const dest = String(r.tujuan ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        const destination = { '': 'warehouse', 'gudang utama': 'warehouse', gudang: 'warehouse', 'display toko': 'floor', toko: 'floor', 'gudang bs': 'damaged', bs: 'damaged', 'gudang shopee': 'shopee', shopee: 'shopee' }[dest];
        if (!destination) fail(`Tujuan "${r.tujuan}" tidak dikenal (pakai Gudang Utama, Display Toko, Gudang BS, atau Gudang Shopee).`);
        if (!p) {
          unknown.push({ key, reference_no: ref, code, name: String(r.namabarang ?? '').trim(), qty, pack_type, destination });
          fail(`Kode "${code}" tidak ditemukan di Daftar Barang — dicatat ke Draft Barang Belum Terdaftar.`);
        }
        if (!groups.has(key)) groups.set(key, { reference_no: ref, supplier_name: '', notes: '', line, items: [] });
        groups.get(key).items.push({ sku: p.sku, name: p.name, qty, pack_type, destination, pieces: pack_type === 'Dus' ? qty * p.pack_ratio : qty });
      } catch (e) {
        if (!e.userFacing) throw e;
        errors.push(`Baris ${line}: ${e.message}`);
      }
    });
    const docs = [];
    for (const [key, g] of groups) {
      Object.assign(g, heads.get(key));
      if (db.get('SELECT 1 FROM stock_receptions WHERE reference_no = ?', [g.reference_no])) {
        errors.push(`No. Surat Jalan "${g.reference_no}" sudah pernah dicatat — ${g.items.length} baris dilewati.`);
      } else {
        docs.push(g);
      }
    }
    // Draft yang sama (No SJ + kode) dari import sebelumnya tidak dicatat dua kali
    const drafts = unknown
      .map(({ key, ...u }) => ({ ...u, ...heads.get(key) }))
      .filter((u) => !db.get('SELECT 1 FROM reception_drafts WHERE reference_no = ? AND code = ?', [u.reference_no, u.code]));
    return { docs, errors, drafts };
  }

  function insertReceptionDraft(d, source) {
    db.run(
      `INSERT INTO reception_drafts(reference_no, supplier_name, notes, code, name, qty, pack_type, destination, source, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.reference_no, d.supplier_name || '', d.notes || '', d.code, d.name || '', d.qty, d.pack_type, d.destination, source, localNow()],
    );
    return db.lastId();
  }

  function createReceptionDraft({ reference_no, supplier_name, notes, code, name, qty, pack_type, destination } = {}) {
    const d = {
      reference_no: toStr(reference_no, 'No. Surat Jalan / Nota', { required: true, max: 60 }),
      supplier_name: toStr(supplier_name, 'Nama supplier', { max: 100 }),
      notes: toStr(notes, 'Catatan', { max: 500 }),
      code: toStr(codeStr(code), 'Kode barang', { required: true, max: 60 }),
      name: toStr(name, 'Nama barang', { max: 120 }),
      qty: toInt(qty, 'Jumlah', { min: 1 }),
      pack_type: pack_type === 'Biji' ? 'Biji' : 'Dus',
      destination: DESTINATIONS.includes(destination) ? destination : fail('Tujuan tidak valid.'),
    };
    const p = findByCode({ code: d.code });
    if (p) fail(`Barang "${p.name}" sudah terdaftar — tambahkan langsung ke form penerimaan.`);
    const id = db.tx(() => insertReceptionDraft(d, 'manual'));
    return db.get('SELECT * FROM reception_drafts WHERE id = ?', [id]);
  }

  function listReceptionDrafts() {
    return db.all('SELECT * FROM reception_drafts WHERE resolved_at IS NULL ORDER BY id DESC').map((d) => {
      const p = findByCode({ code: d.code });
      return { ...d, product: p ? { sku: p.sku, name: p.name, pack_unit: p.pack_unit, pack_ratio: p.pack_ratio } : null };
    });
  }

  function countReceptionDrafts() {
    return db.get('SELECT COUNT(*) AS n FROM reception_drafts WHERE resolved_at IS NULL').n;
  }

  // Barang draft sudah didaftarkan → stok masuk sebagai penerimaan (No SJ asli, atau <No SJ>-S<id> bila sudah dipakai)
  function processReceptionDraft({ id } = {}) {
    const d = db.get('SELECT * FROM reception_drafts WHERE id = ? AND resolved_at IS NULL', [id]);
    if (!d) fail('Draft tidak ditemukan atau sudah diproses.');
    const p = findByCode({ code: d.code });
    if (!p) fail(`Kode "${d.code}" belum terdaftar di Daftar Barang. Daftarkan barangnya dulu.`);
    const ref = db.get('SELECT 1 FROM stock_receptions WHERE reference_no = ?', [d.reference_no]) ? `${d.reference_no}-S${d.id}`.slice(-60) : d.reference_no;
    const r = createReception({
      reference_no: ref, supplier_name: d.supplier_name,
      notes: [d.notes, `Dari draft barang belum terdaftar (${d.code})`].filter(Boolean).join(' · ').slice(0, 500),
      items: [{ sku: p.sku, qty: d.qty, pack_type: d.pack_type, destination: d.destination }],
    });
    db.tx(() => db.run('UPDATE reception_drafts SET resolved_at = ?, reception_id = ? WHERE id = ?', [localNow(), r.id, d.id]));
    return r;
  }

  function deleteReceptionDraft({ id } = {}) {
    db.tx(() => db.run('DELETE FROM reception_drafts WHERE id = ? AND resolved_at IS NULL', [id]));
    return true;
  }

  // rows = baris dari file Excel/CSV. dry_run = hanya ringkasan, stok belum berubah.
  function importReceptions({ rows, dry_run = false } = {}) {
    const { docs, errors, drafts } = planReceptionImport(rows);
    const summary = (g) => ({ reference_no: g.reference_no, supplier_name: g.supplier_name, lines: g.items.length, total: g.items.reduce((s, i) => s + i.pieces, 0) });
    if (dry_run) return { docs: docs.map(summary), errors, drafts: drafts.length };
    if (drafts.length) db.tx(() => drafts.forEach((d) => insertReceptionDraft(d, 'import')));
    const created = [];
    for (const g of docs) {
      try {
        const r = createReception({ reference_no: g.reference_no, supplier_name: g.supplier_name, notes: g.notes, items: g.items });
        created.push({ id: r.id, reference_no: r.reference_no, total_items_count: r.total_items_count, lines: r.items.length });
      } catch (e) {
        if (!e.userFacing) throw e;
        errors.push(`${g.reference_no}: ${e.message}`);
      }
    }
    return { created, errors, drafts: drafts.length };
  }

  function getReception({ id } = {}) {
    const r = db.get('SELECT * FROM stock_receptions WHERE id = ?', [id]);
    if (!r) fail('Dokumen penerimaan tidak ditemukan.');
    r.items = db.all(
      `SELECT i.*, p.name, p.barcode, p.pack_unit, p.pack_ratio FROM stock_reception_items i
       LEFT JOIN products p ON p.sku = i.sku WHERE i.reception_id = ? ORDER BY i.id`,
      [id],
    );
    return r;
  }

  // ---------------------------------------------------------------- Desain label barcode
  function listLabelDesigns() {
    if (!db.get('SELECT 1 FROM label_designs LIMIT 1')) {
      db.tx(() => db.run('INSERT INTO label_designs(name, config, is_default, updated_at) VALUES(?, ?, 1, ?)', [
        'Label Rol 106x20 2 Kolom', JSON.stringify(normalizeDesign(DEFAULT_DESIGN)), localNow(),
      ]));
    }
    return db.all('SELECT * FROM label_designs ORDER BY is_default DESC, name COLLATE NOCASE')
      .map((r) => ({ ...r, config: normalizeDesign(JSON.parse(r.config)) }));
  }

  function getLabelDesign(id) {
    const list = listLabelDesigns();
    return list.find((r) => r.id === Number(id)) || list.find((r) => r.is_default) || list[0];
  }

  function saveLabelDesign({ id, name, config } = {}) {
    const n = toStr(name, 'Nama desain', { required: true, max: 60 });
    const cfg = normalizeDesign(config);
    const clash = db.get('SELECT id FROM label_designs WHERE name = ? COLLATE NOCASE AND id <> ?', [n, Number(id) || 0]);
    if (clash) fail(`Nama desain "${n}" sudah dipakai.`);
    return db.tx(() => {
      if (id) {
        const r = db.run('UPDATE label_designs SET name = ?, config = ?, updated_at = ? WHERE id = ?', [n, JSON.stringify(cfg), localNow(), Number(id)]);
        if (r.changes !== 1) fail('Desain tidak ditemukan.');
        return Number(id);
      }
      const first = !db.get('SELECT 1 FROM label_designs LIMIT 1');
      db.run('INSERT INTO label_designs(name, config, is_default, updated_at) VALUES(?, ?, ?, ?)', [n, JSON.stringify(cfg), first ? 1 : 0, localNow()]);
      return db.lastId();
    });
  }

  function deleteLabelDesign({ id } = {}) {
    if (db.get('SELECT COUNT(*) AS n FROM label_designs').n <= 1) fail('Minimal harus ada satu desain label.');
    db.tx(() => {
      const wasDefault = db.get('SELECT is_default FROM label_designs WHERE id = ?', [Number(id)]);
      db.run('DELETE FROM label_designs WHERE id = ?', [Number(id)]);
      if (wasDefault && wasDefault.is_default) db.run('UPDATE label_designs SET is_default = 1 WHERE id = (SELECT MIN(id) FROM label_designs)');
    });
    return true;
  }

  function setDefaultLabelDesign({ id } = {}) {
    if (!db.get('SELECT 1 FROM label_designs WHERE id = ?', [Number(id)])) fail('Desain tidak ditemukan.');
    db.tx(() => {
      db.run('UPDATE label_designs SET is_default = 0');
      db.run('UPDATE label_designs SET is_default = 1 WHERE id = ?', [Number(id)]);
    });
    return true;
  }

  // Antrian cetak dari dokumen penerimaan: jumlah label = Biji diterima per barang
  function labelItemsFromReception({ id } = {}) {
    const r = getReception({ id });
    const bySku = new Map();
    for (const it of r.items) bySku.set(it.sku, (bySku.get(it.sku) || 0) + it.quantity_received);
    return {
      reference_no: r.reference_no,
      items: [...bySku].map(([sku, copies]) => ({ product: getProduct(sku), copies })).filter((x) => x.product),
    };
  }

  // ---------------------------------------------------------------- Akun login
  const USER_SELECT = 'SELECT id, name, role, active, created_at FROM users';

  function needsSetup() {
    return !db.get('SELECT 1 FROM users LIMIT 1');
  }

  function listUsers() {
    return db.all(`${USER_SELECT} ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'gudang' THEN 1 ELSE 2 END, name COLLATE NOCASE`);
  }

  function activeAdmins(exceptId = 0) {
    return db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [exceptId]).n;
  }

  function saveUser({ id, name, role, pin, active = true } = {}) {
    const n = toStr(name, 'Nama pengguna', { required: true, max: 40 });
    if (!ROLES.includes(role)) fail('Peran harus Admin, Gudang, atau Kasir.');
    const p = String(pin ?? '').trim();
    if ((!id || p) && !/^\d{6}$/.test(p)) fail('PIN harus 6 digit angka.');
    const vp = p && currentVoidPin();
    if (vp && sameText(p, vp)) fail('PIN ini sudah dipakai sebagai PIN Pembatalan. Pilih PIN lain.');
    const on = active === true || active === 1 || active === '1' ? 1 : 0;
    const clash = db.get('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id <> ?', [n, Number(id) || 0]);
    if (clash) fail(`Nama "${n}" sudah dipakai akun lain.`);
    return db.tx(() => {
      if (id) {
        const cur = db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
        if (!cur) fail('Akun tidak ditemukan.');
        if (cur.role === 'admin' && cur.active && (role !== 'admin' || !on) && !activeAdmins(cur.id)) fail('Harus ada minimal satu Admin aktif.');
        db.run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', [n, role, on, cur.id]);
        if (p) { const h = hashPin(p); db.run('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?', [h.hash, h.salt, cur.id]); }
        return db.get(`${USER_SELECT} WHERE id = ?`, [cur.id]);
      }
      if (needsSetup() && (role !== 'admin' || !on)) fail('Akun pertama harus Admin aktif.');
      const h = hashPin(p);
      db.run('INSERT INTO users(name, role, pin_hash, pin_salt, active, created_at) VALUES(?, ?, ?, ?, ?, ?)', [n, role, h.hash, h.salt, on, localNow()]);
      return db.get(`${USER_SELECT} WHERE id = ?`, [db.lastId()]);
    });
  }

  function deleteUser({ id } = {}) {
    const cur = db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
    if (!cur) fail('Akun tidak ditemukan.');
    if (cur.role === 'admin' && cur.active && !activeAdmins(cur.id)) fail('Harus ada minimal satu Admin aktif.');
    db.tx(() => db.run('DELETE FROM users WHERE id = ?', [cur.id]));
    return true;
  }

  function authCache() {
    return db.all('SELECT id, name, role, pin_hash, pin_salt, active FROM users');
  }

  function verifyLogin({ name, pin } = {}) {
    const u = matchLogin(authCache(), { name, pin });
    if (!u) fail('Nama atau PIN salah.');
    return u;
  }

  // ---------------------------------------------------------------- Mother base (pusat data kantor)
  // Data dikirim oleh PC pemilik database (src/motherbase.js). Fungsi di sini hanya menyiapkan dan
  // menandai data; tidak ada koneksi jaringan. Rahasia toko tidak ikut: kunci toko mother base,
  // hash PIN, kode pasangan, dan penanda teknis.
  const MB_DOCS = {
    receptions: { table: 'stock_receptions', cursor: 'mb_cursor_receptions' },
    transfers: { table: 'stock_transfer_docs', cursor: 'mb_cursor_transfers' },
    opnames: { table: 'stock_opname_docs', cursor: 'mb_cursor_opnames' },
  };
  const MB_LIMITS = { shifts: 10, receptions: 100, transfers: 200, opnames: 50 };
  const MB_STATE_KEYS = ['last_attempt_at', 'last_ok_at', 'last_error', 'last_result', 'master_at', 'master_server_at', 'master_error', 'master_result'];

  function masterLocked() {
    return getSetting('mb_kunci_master') === '1';
  }
  function assertMasterUnlocked(what) {
    if (masterLocked()) {
      fail(`Daftar barang dikunci (${what} tidak diizinkan). Tekan Perbarui Daftar Barang untuk mengambil data terbaru.`);
    }
  }

  // Konfigurasi lengkap (termasuk kunci toko) — hanya untuk proses utama PC pemilik database
  function mbConfig() {
    const cfg = {
      url: getSetting('mb_url').replace(/\/+$/, ''),
      anon_key: getSetting('mb_anon_key'),
      kode_toko: getSetting('mb_kode_toko'),
      kunci: decrypt(getSetting('mb_kunci')),
      master_locked: masterLocked(),
    };
    cfg.ready = !!(cfg.url && cfg.anon_key && cfg.kode_toko && cfg.kunci);
    return cfg;
  }

  function mbSaveConfig({ url, anon_key, kode_toko, kunci, clear_kunci, kunci_master } = {}) {
    const u = url === undefined ? undefined : toStr(url, 'Alamat mother base', { max: 200 }).replace(/\/+$/, '');
    if (u && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(u)) {
      fail('Alamat mother base harus berbentuk https://<project>.supabase.co');
    }
    const k = kode_toko === undefined ? undefined : toStr(kode_toko, 'Kode toko', { max: 3 }).toUpperCase();
    if (k && !/^[A-Z]{3}$/.test(k)) fail('Kode toko harus 3 huruf, mis. KRP.');
    // Spasi / baris baru ikut tersalin dari chat atau email: buang. Tolak bila dua kolom tertukar.
    const key = anon_key === undefined ? undefined : toStr(anon_key, 'Anon key', { max: 1000 }).replace(/\s+/g, '');
    if (key && /^[0-9a-f]{48}$/i.test(key)) {
      fail('Yang diisi di Anon key adalah kunci toko. Anon key berupa teks panjang yang diawali "eyJ"; kunci toko (48 karakter) diisi di kolom Kunci toko.');
    }
    const kn = kunci ? String(kunci).replace(/\s+/g, '') : kunci;
    if (kn && (/^eyJ[\w-]*\.[\w-]*\.[\w-]*$/.test(kn) || /^sb_(publishable|secret)_/.test(kn))) {
      fail('Yang diisi di Kunci toko adalah anon key. Kunci toko (48 karakter) dibuat di aplikasi mother base: Toko → Buat kunci.');
    }
    db.tx(() => {
      if (u !== undefined) setSetting('mb_url', u);
      if (key !== undefined) setSetting('mb_anon_key', key);
      if (k !== undefined && k !== getSetting('mb_kode_toko')) {
        setSetting('mb_kode_toko', k);
        // Toko lain di mother base: kirim ulang semua dokumen & keadaan terkini
        for (const d of Object.values(MB_DOCS)) setSetting(d.cursor, '0');
        setSetting('mb_snapshot_hash', '');
        setSetting('mb_master_at', '');
      }
      if (clear_kunci) setSetting('mb_kunci', '');
      else if (kn) setSetting('mb_kunci', encrypt(kn));
      if (kunci_master !== undefined) setSetting('mb_kunci_master', kunci_master === true || kunci_master === '1' ? '1' : '0');
    });
    return mbStatus();
  }

  function mbState() {
    let st = {};
    try { st = JSON.parse(getSetting('mb_state', '{}')) || {}; } catch (_) { st = {}; }
    return st;
  }
  function mbSetState(patch = {}) {
    const st = { ...mbState() };
    for (const [k, v] of Object.entries(patch)) if (MB_STATE_KEYS.includes(k)) st[k] = v;
    db.tx(() => setSetting('mb_state', JSON.stringify(st)));
    return st;
  }

  // Ringkasan untuk layar Pengaturan (tanpa kunci toko); boleh dipanggil PC kasir
  function mbStatus() {
    const cfg = mbConfig();
    const pending = db.get('SELECT COUNT(*) AS n, MIN(closed_at) AS oldest FROM mb_outbox_shift WHERE sent_at IS NULL');
    const docsPending = {};
    for (const [k, d] of Object.entries(MB_DOCS)) {
      const cur = Number(getSetting(d.cursor, '0')) || 0;
      docsPending[k] = db.get(`SELECT COUNT(*) AS n FROM ${d.table} WHERE id > ?`, [cur]).n;
    }
    return {
      url: cfg.url, anon_key_set: !!cfg.anon_key, kode_toko: cfg.kode_toko, has_kunci: !!cfg.kunci, ready: cfg.ready,
      master_locked: cfg.master_locked, pending_shifts: pending.n, oldest_pending: pending.oldest, pending_docs: docsPending,
      ...mbState(),
    };
  }

  // Sudah diterima mother base? (dipakai saat tutup shift untuk memastikan kiriman sampai)
  function mbShiftSent(shiftUid) {
    const r = db.get('SELECT sent_at FROM mb_outbox_shift WHERE shift_uid = ?', [shiftUid]);
    return !!(r && r.sent_at);
  }

  // Shift yang ditutup sebelum ada mother base, tapi masih di Riwayat Shift: masukkan ke antrean (sekali, aman diulang)
  function mbQueueHistory() {
    const rows = db.all(
      `SELECT h.* FROM shift_history h LEFT JOIN mb_outbox_shift o ON o.shift_uid = h.shift_uid
       WHERE o.shift_uid IS NULL ORDER BY h.closed_at`,
    );
    if (!rows.length) return 0;
    db.tx(() => {
      for (const h of rows) {
        const seq = new Map();
        const sales = db.all('SELECT * FROM shift_history_sales WHERE shift_uid = ? ORDER BY id', [h.shift_uid]).map((r) => {
          const n = (seq.get(r.receipt_no) || 0) + 1;
          seq.set(r.receipt_no, n);
          return {
            receipt_no: r.receipt_no, line_no: n, created_at: r.created_at, sku: r.sku, product_name: r.product_name,
            qty: r.qty_sold, unit_price: r.unit_price, line_total: r.line_total, payment_method: r.payment_method,
          };
        });
        const shift = {
          shift_uid: h.shift_uid, cashier_name: h.cashier_name, shift_start: h.shift_start, closed_at: h.closed_at, notes: h.notes || '',
          receipts: h.receipts, qty: h.qty, revenue: h.revenue, cash_sales: h.cash_sales,
          by_method: JSON.parse(h.by_method || '[]'), offline_receipts: new Set(sales.filter((l) => /^OFF-/.test(l.receipt_no)).map((l) => l.receipt_no)).size,
        };
        const pembatalan = voidLines(db.all(
          'SELECT * FROM receipt_voids WHERE void_no IN (SELECT receipt_no FROM shift_history_sales WHERE shift_uid = ?) ORDER BY created_at', [h.shift_uid],
        ));
        db.run('INSERT OR IGNORE INTO mb_outbox_shift(shift_uid, closed_at, payload, created_at) VALUES(?, ?, ?, ?)',
          [h.shift_uid, h.closed_at, JSON.stringify({ shift, sales, pembatalan }), localNow()]);
      }
    });
    return rows.length;
  }

  function snapshotData() {
    const shift = getShift();
    return {
      products: db.all(
        'SELECT sku, barcode, name, brand, category, unit_price, base_unit, pack_unit, pack_ratio, created_at FROM products ORDER BY sku',
      ),
      // Semua barang punya baris stok (barang tanpa baris inventory = 0, sama seperti di layar POS)
      inventory: db.all(
        `SELECT p.sku, COALESCE(i.floor_stock, 0) AS floor_stock, COALESCE(i.warehouse_stock, 0) AS warehouse_stock,
                COALESCE(i.damaged_stock, 0) AS damaged_stock, COALESCE(i.shopee_stock, 0) AS shopee_stock,
                COALESCE(i.min_floor_alert, 5) AS min_floor_alert, i.sold_out_at
         FROM products p LEFT JOIN inventory i ON i.sku = p.sku ORDER BY p.sku`,
      ),
      reception_drafts: db.all(
        `SELECT d.id AS draft_id, d.reference_no, d.supplier_name, d.notes, d.code, d.name, d.qty, d.pack_type, d.destination, d.source,
                d.created_at, d.resolved_at, r.reference_no AS reception_reference_no
         FROM reception_drafts d LEFT JOIN stock_receptions r ON r.id = d.reception_id ORDER BY d.id`,
      ),
      offline_sales: db.all(
        'SELECT receipt_no, client_ref, cashier_name, created_at, synced_at, total, status, notes, checked_at FROM offline_sales ORDER BY created_at, receipt_no',
      ),
      // Shift yang masih berjalan: omset hari ini sudah terlihat di mother base sebelum tutup shift
      current_shift: shift ? {
        shift_uid: ensureShiftUid(), cashier_name: shift.cashier_name, shift_start: shift.shift_start, sales: salesLines(),
        pembatalan: voidLines(db.all('SELECT * FROM receipt_voids WHERE void_no IN (SELECT receipt_no FROM shift_sales) ORDER BY created_at')),
      } : null,
    };
  }

  // Dokumen dengan id > penanda terakhir yang sudah diterima mother base
  function docsSince(kind, limit) {
    const d = MB_DOCS[kind];
    let cur = Number(getSetting(d.cursor, '0')) || 0;
    // Database dipulihkan dari cadangan lama (id lebih kecil dari penanda): kirim ulang semuanya
    const max = db.get(`SELECT COALESCE(MAX(id), 0) AS m FROM ${d.table}`).m;
    if (cur > max) cur = 0;
    if (kind === 'receptions') {
      const docs = db.all('SELECT id, reference_no, supplier_name, notes, received_at, total_items_count FROM stock_receptions WHERE id > ? ORDER BY id LIMIT ?', [cur, limit]);
      const items = docs.length ? groupBy(db.all(
        `SELECT reception_id, sku, quantity_received AS qty, pack_type, destination FROM stock_reception_items
         WHERE reception_id BETWEEN ? AND ? ORDER BY id`, [docs[0].id, docs[docs.length - 1].id],
      ), 'reception_id') : new Map();
      return { docs: docs.map(({ id, ...r }) => ({ ...r, items: numbered(items.get(id), 'reception_id') })), last: docs.length ? docs[docs.length - 1].id : cur, full: docs.length === limit };
    }
    if (kind === 'transfers') {
      const docs = db.all('SELECT id, doc_no, from_zone, to_zone, reason, created_at, line_count, total_qty FROM stock_transfer_docs WHERE id > ? ORDER BY id LIMIT ?', [cur, limit]);
      const lines = docs.length ? groupBy(db.all('SELECT doc_id, sku, qty FROM stock_transfers WHERE doc_id BETWEEN ? AND ? ORDER BY id',
        [docs[0].id, docs[docs.length - 1].id]), 'doc_id') : new Map();
      return { docs: docs.map(({ id, ...r }) => ({ ...r, lines: numbered(lines.get(id), 'doc_id') })), last: docs.length ? docs[docs.length - 1].id : cur, full: docs.length === limit };
    }
    const docs = db.all('SELECT id, doc_no, zone, notes, created_at, count_at, line_count, plus_qty, minus_qty FROM stock_opname_docs WHERE id > ? ORDER BY id LIMIT ?', [cur, limit]);
    const lines = docs.length ? groupBy(db.all(
      'SELECT doc_id, sku, system_qty, counted_qty, diff, before_qty FROM stock_opname_items WHERE doc_id BETWEEN ? AND ? ORDER BY id',
      [docs[0].id, docs[docs.length - 1].id],
    ), 'doc_id') : new Map();
    return { docs: docs.map(({ id, ...r }) => ({ ...r, lines: numbered(lines.get(id), 'doc_id') })), last: docs.length ? docs[docs.length - 1].id : cur, full: docs.length === limit };
  }

  // Satu kiriman: shift tertutup yang belum diterima, dokumen baru, dan keadaan terkini bila berubah.
  // Belum ada yang ditandai terkirim sampai mbAck dipanggil dengan balasan mother base.
  function mbBatch({ includeSnapshot = true, force = false, limits = MB_LIMITS } = {}) {
    const lim = { ...MB_LIMITS, ...limits };
    const shiftRows = db.all('SELECT shift_uid, payload FROM mb_outbox_shift WHERE sent_at IS NULL ORDER BY closed_at LIMIT ?', [lim.shifts]);
    const dokumen = {};
    const cursors = {};
    let more = shiftRows.length === lim.shifts;
    for (const kind of Object.keys(MB_DOCS)) {
      const r = docsSince(kind, lim[kind]);
      if (r.docs.length) { dokumen[kind] = r.docs; cursors[kind] = r.last; }
      if (r.full) more = true;
    }
    let snapshot = null;
    let snapshotHash = null;
    if (includeSnapshot) {
      const data = snapshotData();
      snapshotHash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (force || snapshotHash !== getSetting('mb_snapshot_hash')) snapshot = { created_at: localNow(), ...data };
    }
    const empty = !shiftRows.length && !Object.keys(dokumen).length && !snapshot;
    return {
      empty, more,
      shifts: shiftRows.map((r) => JSON.parse(r.payload)),
      dokumen: Object.keys(dokumen).length ? dokumen : null,
      snapshot,
      ack: { shift_uids: shiftRows.map((r) => r.shift_uid), cursors, snapshot_hash: snapshot ? snapshotHash : null },
    };
  }

  // Tandai yang sudah diterima mother base (balasan terima_data)
  function mbAck(ack = {}, reply = {}) {
    const accepted = new Set(Array.isArray(reply.shift_diterima) ? reply.shift_diterima : []);
    const at = localNow();
    db.tx(() => {
      for (const uid of ack.shift_uids || []) {
        if (accepted.has(uid)) db.run('UPDATE mb_outbox_shift SET sent_at = ? WHERE shift_uid = ? AND sent_at IS NULL', [at, uid]);
      }
      if (reply.ok) {
        for (const [kind, last] of Object.entries(ack.cursors || {})) if (MB_DOCS[kind]) setSetting(MB_DOCS[kind].cursor, String(last));
        if (ack.snapshot_hash) setSetting('mb_snapshot_hash', ack.snapshot_hash);
      }
    });
    return { shifts: [...accepted].length };
  }

  // Master barang & harga dari mother base. Stok tidak diubah. Barang yang tidak ada di master dibiarkan.
  function mbApplyMaster({ produk = [], server_at } = {}) {
    const out = { baru: 0, diubah: 0, sama: 0, dilewati: [] };
    db.tx(() => {
      for (const m of produk) {
        if (m.aktif === false) continue;
        let p;
        try {
          p = normalizeProduct({ ...m, min_floor_alert: undefined });
        } catch (e) {
          out.dilewati.push(`${m.sku || '?'}: ${e.message}`);
          continue;
        }
        const other = db.get('SELECT sku FROM products WHERE barcode = ? AND sku <> ?', [p.barcode, p.sku]);
        if (other) { out.dilewati.push(`${p.sku}: barcode ${p.barcode} dipakai barang ${other.sku} di toko ini`); continue; }
        const cur = db.get('SELECT p.*, COALESCE(i.min_floor_alert, 5) AS min_floor_alert FROM products p LEFT JOIN inventory i ON i.sku = p.sku WHERE p.sku = ?', [p.sku]);
        if (!cur) {
          insertProduct(p, { floor: 0, warehouse: 0, damaged: 0, shopee: 0 });
          out.baru++;
          continue;
        }
        const same = ['barcode', 'name', 'brand', 'category', 'unit_price', 'pack_unit', 'pack_ratio'].every((k) => String(cur[k]) === String(p[k]));
        if (same) { out.sama++; continue; }
        updateProduct({ ...p, min_floor_alert: cur.min_floor_alert });
        out.diubah++;
      }
      if (server_at) setSetting('mb_master_at', String(server_at));
    });
    return out;
  }
  function mbMasterSince() {
    return getSetting('mb_master_at');
  }

  // Shift yang dibuka sebelum versi ini belum punya ID → dibuatkan sekali
  function ensureShiftUid() {
    const s = getShift();
    if (!s) return null;
    if (s.shift_uid) return s.shift_uid;
    const uid = crypto.randomUUID();
    db.tx(() => db.run('UPDATE active_shift SET shift_uid = ? WHERE id = 1', [uid]));
    return uid;
  }

  // Baris penjualan shift berjalan; line_no = urutan baris di dalam satu struk
  function salesLines() {
    const seq = new Map();
    return db.all('SELECT * FROM shift_sales ORDER BY id').map((r) => {
      const n = (seq.get(r.receipt_no) || 0) + 1;
      seq.set(r.receipt_no, n);
      return {
        receipt_no: r.receipt_no, line_no: n, created_at: r.created_at, sku: r.sku, product_name: r.product_name,
        qty: r.qty_sold, unit_price: r.unit_price, line_total: r.line_total, payment_method: r.payment_method,
      };
    });
  }

  // Rincian batal nota untuk mother base: nota asal, alasan, yang meminta, yang menyetujui dengan PIN (tanpa PIN-nya)
  const voidLines = (rows) => rows.map((v) => ({
    void_no: v.void_no, receipt_no: v.receipt_no, reason: v.reason, requested_by: v.requested_by,
    approved_by: v.approved_by, total: v.total, created_at: v.created_at,
  }));

  const groupBy = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const numbered = (rows, drop) => (rows || []).map((r, i) => {
    const o = { line_no: i + 1, ...r };
    delete o[drop];
    return o;
  });

  // Data satu shift untuk mother base: dibuat saat tutup shift, sebelum penjualan shift dipindah ke riwayat
  function shiftData({ closed_at, notes = '' } = {}) {
    const shift = getShift();
    if (!shift) fail('Tidak ada shift aktif.');
    const sum = shiftSummary();
    return {
      shift: {
        shift_uid: ensureShiftUid(),
        cashier_name: shift.cashier_name,
        shift_start: shift.shift_start,
        closed_at: closed_at || localNow(),
        notes: String(notes || ''),
        receipts: sum.totals.receipts,
        qty: sum.totals.qty,
        revenue: sum.totals.revenue,
        cash_sales: sum.cashSales,
        by_method: sum.byMethod.map((m) => ({ method: m.method, receipts: m.receipts, total: m.total })),
        offline_receipts: sum.offline.receipts,
      },
      sales: salesLines(),
      pembatalan: voidLines(sum.voids.list),
    };
  }

  return {
    ensureShiftUid, shiftData, masterLocked,
    mbConfig, mbSaveConfig, mbStatus, mbShiftSent, mbState, mbSetState, mbQueueHistory, mbBatch, mbAck, mbApplyMaster, mbMasterSince,
    needsSetup, listUsers, saveUser, deleteUser, authCache, verifyLogin,
    listLabelDesigns, getLabelDesign, saveLabelDesign, deleteLabelDesign, setDefaultLabelDesign, labelItemsFromReception,
    meta, getSettings, saveSettings,
    getProduct, listProducts, categories, findByCode, searchProducts, saveProduct, deleteProduct, importRows,
    stockSnapshot, lowStock,
    getShift, openShift, checkout, shiftSummary, receiptDetail, receiptForReprint, voidReceipt, voidPinInfo, setVoidPin, clearVoidPin, shiftSalesRows,
    archiveShift, pruneShiftHistory, listShiftHistory,
    importOfflineSale, offlineChecks, markOfflineChecked,
    createTransfer, listTransfers, createTransferDoc, listTransferDocs, getTransferDoc,
    createReception, listReceptions, getReception, importReceptions,
    createOpname, listOpnames, getOpname, opnameSheet, planOpnameImport, importOpname,
    createReceptionDraft, listReceptionDrafts, countReceptionDrafts, processReceptionDraft, deleteReceptionDraft,
  };
}

module.exports = {
  createServices, PAYMENT_METHODS, SHIFT_HISTORY_DAYS, ZONE_LABEL, DIRECTIONS, TEMPLATE_HEADERS, TEMPLATE_SAMPLE, RECEPTION_TEMPLATE_HEADERS, RECEPTION_TEMPLATE_SAMPLE, OPNAME_TEMPLATE_HEADERS, localNow,
};
