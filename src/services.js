'use strict';
// Logika bisnis POS — tidak bergantung pada Electron agar bisa diuji dengan Node biasa.
const { normalizeDesign, DEFAULT_DESIGN } = require('./labels');
const { ROLES, hashPin, matchLogin } = require('./auth');
const { rankProducts } = require('./search');

const PAYMENT_METHODS = ['Tunai', 'QRIS', 'Kartu Debit'];

const ZONE_COL = { floor: 'floor_stock', warehouse: 'warehouse_stock', damaged: 'damaged_stock' };

const ZONE_LABEL = {
  floor: 'Stok Toko',
  warehouse: 'Gudang Utama',
  damaged: 'Gudang BS',
  customer: 'Retur Pelanggan',
  supplier: 'Supplier (Retur Keluar)',
  disposed: 'Dibuang / Dimusnahkan',
};

const DIRECTIONS = [
  { from: 'warehouse', to: 'floor', label: 'Gudang Utama → Toko (Restock rak)' },
  { from: 'floor', to: 'damaged', label: 'Toko → Gudang BS (Rusak / pecah di rak)' },
  { from: 'warehouse', to: 'damaged', label: 'Gudang Utama → Gudang BS (Cacat bawaan supplier)' },
  { from: 'customer', to: 'damaged', label: 'Retur Pelanggan → Gudang BS' },
  { from: 'damaged', to: 'supplier', label: 'Gudang BS → Supplier (Retur keluar)' },
  { from: 'damaged', to: 'disposed', label: 'Gudang BS → Dibuang / Dimusnahkan' },
  { from: 'floor', to: 'warehouse', label: 'Toko → Gudang Utama (Tarik dari rak)' },
];

const DESTINATIONS = ['warehouse', 'floor', 'damaged'];

const TEMPLATE_HEADERS = [
  'Barcode', 'SKU', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Satuan_Masuk',
  'Rasio_Isi_Dus', 'Stok_Awal_Toko', 'Stok_Awal_Gudang', 'Stok_Awal_BS', 'Min_Alert_Toko',
];

const TEMPLATE_SAMPLE = [
  ['8991234567890', 'MNM-001', 'Air Mineral 600ml', 'Segar', 'Minuman', 3500, 'Dus', 24, 24, 96, 0, 12],
  ['8997654321098', 'SNK-010', 'Keripik Kentang 68g', 'Renyah', 'Makanan Ringan', 11500, 'Karton', 40, 20, 80, 0, 10],
];

const SETTING_KEYS = [
  'store_name', 'store_address', 'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_from', 'owner_email',
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

const PRODUCT_SELECT = `
  SELECT p.sku, p.barcode, p.name, p.brand, p.category, p.unit_price, p.base_unit, p.pack_unit, p.pack_ratio, p.created_at,
         COALESCE(i.floor_stock, 0) AS floor_stock,
         COALESCE(i.warehouse_stock, 0) AS warehouse_stock,
         COALESCE(i.damaged_stock, 0) AS damaged_stock,
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
    if (!out.smtp_port) out.smtp_port = '587';
    if (!out.smtp_security) out.smtp_security = 'starttls';
    if (!out.paper_width) out.paper_width = '58';
    if (out.auto_print === '') out.auto_print = '1';
    out.has_smtp_pass = !!getSetting('smtp_pass');
    return out;
  }
  function getSettingsRaw() {
    return { ...getSettings(), smtp_pass: decrypt(getSetting('smtp_pass')) };
  }
  function saveSettings(d = {}) {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const owner = toStr(d.owner_email, 'Email owner', { max: 500 });
    for (const e of owner.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
      if (!emailRe.test(e)) fail(`Email owner tidak valid: ${e}`);
    }
    const from = toStr(d.smtp_from, 'Email pengirim');
    if (from && !emailRe.test(from.replace(/^.*<|>$/g, ''))) fail('Email pengirim tidak valid.');
    if (d.smtp_port !== undefined && d.smtp_port !== '') toInt(d.smtp_port, 'Port SMTP', { min: 1, max: 65535 });
    if (d.smtp_security && !['ssl', 'starttls', 'none'].includes(d.smtp_security)) fail('Jenis keamanan SMTP tidak dikenal.');
    if (d.paper_width !== undefined && !['58', '80'].includes(String(d.paper_width))) fail('Lebar kertas harus 58 mm atau 80 mm.');
    if (d.auto_print !== undefined) d.auto_print = d.auto_print === true || d.auto_print === '1' ? '1' : '0';
    db.tx(() => {
      for (const k of SETTING_KEYS) {
        if (d[k] === undefined) continue;
        // Header/footer nota boleh multi-baris; spasi di tepi tiap baris dipertahankan apa adanya
        const v = k === 'receipt_header' || k === 'receipt_footer' ? String(d[k]).replace(/\r\n/g, '\n').slice(0, 500) : toStr(d[k], k, { max: 500 });
        setSetting(k, v);
      }
      if (d.clear_smtp_pass) setSetting('smtp_pass', '');
      else if (d.smtp_pass) setSetting('smtp_pass', encrypt(String(d.smtp_pass)));
    });
    return getSettings();
  }

  function meta() {
    return { directions: DIRECTIONS, zones: ZONE_LABEL, paymentMethods: PAYMENT_METHODS, destinations: DESTINATIONS };
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
      min_floor_alert: toInt(d.min_floor_alert, 'Batas minimum stok toko', { min: 0, def: 5 }),
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
      'INSERT INTO inventory(sku, floor_stock, warehouse_stock, damaged_stock, min_floor_alert) VALUES(?, ?, ?, ?, ?)',
      [p.sku, stock.floor, stock.warehouse, stock.damaged, p.min_floor_alert],
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
    assertBarcodeFree(p.barcode, p.sku);
    db.tx(() => {
      if (isNew) {
        insertProduct(p, {
          floor: toInt(initial.floor, 'Stok awal toko', { def: 0 }),
          warehouse: toInt(initial.warehouse, 'Stok awal gudang', { def: 0 }),
          damaged: toInt(initial.damaged, 'Stok awal BS', { def: 0 }),
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
    const refs = db.get(
      `SELECT (SELECT COUNT(*) FROM stock_reception_items WHERE sku = ?) +
              (SELECT COUNT(*) FROM stock_transfers WHERE sku = ?) +
              (SELECT COUNT(*) FROM shift_sales WHERE sku = ?) AS n`,
      [sku, sku, sku],
    ).n;
    if (refs > 0) fail(`"${p.name}" tidak bisa dihapus karena sudah memiliki riwayat penerimaan, mutasi, atau penjualan.`);
    db.tx(() => {
      db.run('DELETE FROM inventory WHERE sku = ?', [sku]);
      db.run('DELETE FROM products WHERE sku = ?', [sku]);
    });
    return true;
  }

  function importRows(rows = []) {
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

  // Tandai barang yang stok tokonya habis/minus karena terjual (merah di Saran Restock);
  // tanda hilang begitu stok toko diisi lagi (> 0). Barang yang memang belum pernah dipajang tidak merah.
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
    db.tx(() => db.run('INSERT INTO active_shift(id, cashier_name, shift_start, initial_cash) VALUES(1, ?, ?, 0)', [name, localNow()]));
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
        // Stok toko kurang tetap boleh dijual (barang fisik ada di rak); stok toko jadi 0/minus
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
    const totals = db.get(
      'SELECT COUNT(DISTINCT receipt_no) AS receipts, COALESCE(SUM(line_total),0) AS revenue, COALESCE(SUM(qty_sold),0) AS qty FROM shift_sales',
    );
    const byMethod = db.all(
      `SELECT payment_method AS method, COUNT(DISTINCT receipt_no) AS receipts, SUM(line_total) AS total
       FROM shift_sales GROUP BY payment_method ORDER BY total DESC`,
    );
    const byItem = db.all(
      `SELECT sku, product_name AS name, SUM(qty_sold) AS qty, SUM(line_total) AS total
       FROM shift_sales GROUP BY sku, product_name ORDER BY total DESC`,
    );
    const receipts = db.all(
      `SELECT receipt_no, MIN(created_at) AS created_at, payment_method, SUM(qty_sold) AS qty, SUM(line_total) AS total
       FROM shift_sales GROUP BY receipt_no ORDER BY MIN(id) DESC LIMIT 100`,
    );
    const cashSales = byMethod.filter((m) => m.method === 'Tunai').reduce((s, m) => s + m.total, 0);
    const offline = {
      receipts: db.get("SELECT COUNT(DISTINCT receipt_no) AS n FROM shift_sales WHERE receipt_no LIKE 'OFF-%'").n,
      checks: offlineChecks(),
    };
    return {
      shift, totals, byMethod, byItem, receipts, offline,
      cashSales,
    };
  }

  function receiptDetail({ receipt_no } = {}) {
    return db.all('SELECT * FROM shift_sales WHERE receipt_no = ? ORDER BY id', [receipt_no]);
  }

  // Data nota untuk cetak ulang (uang diterima tidak tersimpan, jadi tanpa kembalian)
  function receiptForReprint({ receipt_no } = {}) {
    const rows = receiptDetail({ receipt_no });
    if (!rows.length) fail('Struk tidak ditemukan.');
    const total = rows.reduce((s, r) => s + r.line_total, 0);
    const shift = getShift();
    return {
      receipt_no, created_at: rows[0].created_at, payment_method: rows[0].payment_method,
      cashier: shift ? shift.cashier_name : '-', total, cash_received: total, change: 0,
      lines: rows.map((r) => ({ sku: r.sku, name: r.product_name, qty: r.qty_sold, unit_price: r.unit_price, line_total: r.line_total })),
    };
  }

  function shiftSalesRows() {
    return db.all('SELECT * FROM shift_sales ORDER BY id');
  }

  function purgeShift() {
    db.tx(() => {
      db.run('DELETE FROM shift_sales');
      db.run('DELETE FROM active_shift');
      db.run("DELETE FROM checkout_refs WHERE created_at < datetime('now','localtime','-60 days')");
    });
    return true;
  }

  // ---------------------------------------------------------------- Transaksi mode darurat (dari PC kasir)
  // Barang sudah keluar fisik dan nota sudah dicetak, jadi transaksi SELALU dicatat dengan harga & waktu
  // saat dijual. Bila stok toko tidak cukup, stok toko dibiarkan minus dan transaksi ditandai "perlu dicek"
  // (bukan ditolak), supaya omset & laci kasir tetap cocok dan selisih stok terlihat jelas oleh owner.
  function importOfflineSale({ receipt_no, client_ref, created_at, payment_method, cashier, lines = [] } = {}) {
    const no = toStr(receipt_no, 'No. struk darurat', { required: true, max: 60 });
    if (!/^OFF-/.test(no)) fail('No. struk darurat harus diawali OFF-.');
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
            notes.push(`${p.name}: stok toko ${p.floor_stock}, terjual ${l.qty} → stok toko ${p.floor_stock - l.qty}. Cek fisik rak / catat mutasi.`);
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
    const id = db.tx(() => {
      for (const { p, qty: n } of lines) {
        db.run('INSERT OR IGNORE INTO inventory(sku) VALUES(?)', [p.sku]);
        if (ZONE_COL[from_zone]) {
          const col = ZONE_COL[from_zone];
          const r = db.run(`UPDATE inventory SET ${col} = ${col} - ? WHERE sku = ? AND ${col} >= ?`, [n, p.sku, n]);
          if (r.changes !== 1) fail(`${ZONE_LABEL[from_zone]} untuk "${p.name}" tidak cukup. Tersedia ${p[col]} Biji.`);
        }
        if (ZONE_COL[to_zone]) {
          const col = ZONE_COL[to_zone];
          db.run(`UPDATE inventory SET ${col} = ${col} + ? WHERE sku = ?`, [n, p.sku]);
          if (to_zone === 'floor') clearSoldOut(p.sku);
        }
      }
      // Nomor urut per hari: MT-YYYYMMDD-001
      const prefix = `MT-${now.slice(0, 10).replace(/-/g, '')}-`;
      const last = db.get('SELECT doc_no FROM stock_transfer_docs WHERE doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1', [`${prefix}%`]);
      const docNo = prefix + String((last ? Number(last.doc_no.slice(prefix.length)) : 0) + 1).padStart(3, '0');
      db.run('INSERT INTO stock_transfer_docs(doc_no, from_zone, to_zone, reason, created_at, line_count, total_qty) VALUES(?, ?, ?, ?, ?, ?, ?)', [
        docNo, from_zone, to_zone, why, now, lines.length, lines.reduce((s, l) => s + l.qty, 0),
      ]);
      const did = db.lastId();
      for (const { p, qty: n } of lines) {
        db.run('INSERT INTO stock_transfers(sku, from_zone, to_zone, qty, reason, created_at, doc_id) VALUES(?, ?, ?, ?, ?, ?, ?)', [p.sku, from_zone, to_zone, n, why, now, did]);
      }
      return did;
    });
    return getTransferDoc({ id });
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

  return {
    needsSetup, listUsers, saveUser, deleteUser, authCache, verifyLogin,
    listLabelDesigns, getLabelDesign, saveLabelDesign, deleteLabelDesign, setDefaultLabelDesign, labelItemsFromReception,
    meta, getSettings, getSettingsRaw, saveSettings,
    getProduct, listProducts, categories, findByCode, searchProducts, saveProduct, deleteProduct, importRows,
    stockSnapshot, lowStock,
    getShift, openShift, checkout, shiftSummary, receiptDetail, receiptForReprint, shiftSalesRows, purgeShift,
    importOfflineSale, offlineChecks, markOfflineChecked,
    createTransfer, listTransfers, createTransferDoc, listTransferDocs, getTransferDoc,
    createReception, listReceptions, getReception,
  };
}

module.exports = {
  createServices, PAYMENT_METHODS, ZONE_LABEL, DIRECTIONS, TEMPLATE_HEADERS, TEMPLATE_SAMPLE, localNow,
};
