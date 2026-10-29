'use strict';
// Mode darurat PC Kasir: cache daftar barang + antrian transaksi saat PC Gudang tidak terjangkau.
// Disimpan sebagai file JSON di folder data PC kasir. Tanpa Electron agar bisa diuji dengan Node biasa.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { localNow } = require('./services');
const { matchLogin } = require('./auth');
const { rankProducts } = require('./search');

const CACHE_FILE = 'offline-cache.json';
const QUEUE_FILE = 'offline-queue.json';
const KEEP_SYNCED = 1000; // riwayat transaksi darurat yang sudah terkirim (untuk audit)

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Tulis atomik: file lama tetap utuh bila listrik mati saat menyimpan
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

function toQty(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail('Jumlah minimal 1.');
  return n;
}

function createOfflineStore(dir, { now = localNow } = {}) {
  const cacheFile = path.join(dir, CACHE_FILE);
  const queueFile = path.join(dir, QUEUE_FILE);
  let cache = readJson(cacheFile);
  const queue = readJson(queueFile) || {};
  queue.sales = Array.isArray(queue.sales) ? queue.sales : [];
  // Kode pendek per PC kasir agar nomor struk darurat tidak bentrok antar kasir
  if (!/^[0-9A-F]{4}$/.test(queue.device_tag || '')) {
    queue.device_tag = crypto.randomBytes(2).toString('hex').toUpperCase();
    writeJson(queueFile, queue);
  }
  const saveQueue = () => writeJson(queueFile, queue);

  const pending = () => queue.sales.filter((s) => s.status === 'pending');

  // Stok terakhir dari PC gudang dikurangi penjualan darurat yang belum terkirim
  function pendingQty() {
    const m = new Map();
    for (const s of pending()) for (const l of s.lines) m.set(l.sku, (m.get(l.sku) || 0) + l.qty);
    return m;
  }
  function view(list) {
    const q = pendingQty();
    return list.map((p) => ({ ...p, floor_stock: p.floor_stock - (q.get(p.sku) || 0) }));
  }
  const products = () => (cache ? cache.products : []);

  // ---------------------------------------------------------------- Cache dari PC gudang
  async function refresh(svc) {
    const [list, shift, settings, meta, users] = await Promise.all([
      svc.listProducts({ limit: 20000 }), svc.getShift(), svc.getSettings(), svc.meta(), svc.authCache(),
    ]);
    // users: hash PIN (bukan PIN asli) agar kasir tetap bisa login saat MODE DARURAT
    cache = { updated_at: now(), updated_ms: Date.now(), products: list, shift: shift || null, settings, meta, users };
    writeJson(cacheFile, cache);
    return cache;
  }

  function setShift(shift) {
    if (!cache) return;
    cache.shift = shift || null;
    writeJson(cacheFile, cache);
  }

  function getProduct(sku) {
    const p = products().find((x) => x.sku === sku);
    return p ? view([p])[0] : null;
  }

  function findByCode({ code } = {}) {
    const c = String(code ?? '').trim();
    if (!c) return null;
    const lc = c.toLowerCase();
    const p = products().find((x) => x.barcode === c || String(x.sku).toLowerCase() === lc);
    return p ? view([p])[0] : null;
  }

  function searchProducts({ q = '', limit = 8 } = {}) {
    return view(rankProducts(products(), q, limit));
  }

  // ---------------------------------------------------------------- Transaksi darurat
  function nextReceiptNo() {
    const d = now().slice(0, 10).replace(/-/g, '');
    queue.seq = queue.seq_date === d ? (Number(queue.seq) || 0) + 1 : 1;
    queue.seq_date = d;
    return `OFF-${d}-${queue.device_tag}-${String(queue.seq).padStart(4, '0')}`;
  }

  function checkout({ items = [], payment_method, cash_received, client_ref } = {}) {
    if (!cache) fail('Mode darurat belum siap: daftar barang belum pernah diunduh dari PC Gudang.');
    const shift = cache.shift;
    if (!shift) fail('Mode darurat: shift belum dibuka saat terakhir terhubung ke PC Gudang. Transaksi tidak bisa diproses.');
    const methods = (cache.meta && cache.meta.paymentMethods) || ['Tunai'];
    if (!methods.includes(payment_method)) fail('Metode pembayaran tidak dikenal.');
    if (!Array.isArray(items) || !items.length) fail('Keranjang masih kosong.');

    const merged = new Map();
    for (const it of items) merged.set(it.sku, (merged.get(it.sku) || 0) + toQty(it.qty));
    const warnings = [];
    const lines = [...merged].map(([sku, qty]) => {
      const p = getProduct(sku);
      if (!p) fail(`Barang dengan SKU ${sku} tidak ada di data darurat.`);
      if (p.floor_stock < qty) warnings.push(`${p.name}: display toko terakhir ${p.floor_stock}, dijual ${qty}.`);
      return { sku, name: p.name, qty, unit_price: p.unit_price, line_total: p.unit_price * qty };
    });
    const total = lines.reduce((s, l) => s + l.line_total, 0);
    let cash = total;
    if (payment_method === 'Tunai') {
      cash = Number(String(cash_received ?? '').replace(/\D/g, '')) || 0;
      if (cash < total) fail(`Uang diterima kurang Rp ${(total - cash).toLocaleString('id-ID')}.`);
    }
    const sale = {
      receipt_no: nextReceiptNo(),
      client_ref: client_ref || crypto.randomUUID(),
      created_at: now(),
      payment_method, lines, total,
      cash_received: cash, change: cash - total, cashier: shift.cashier_name,
      status: 'pending', attempts: 0, last_error: '',
    };
    queue.sales.push(sale);
    saveQueue(); // tersimpan di disk sebelum nota dicetak
    return {
      receipt_no: sale.receipt_no, created_at: sale.created_at, payment_method, lines, total,
      cash_received: cash, change: sale.change, cashier: sale.cashier, offline: true, warnings,
    };
  }

  // ---------------------------------------------------------------- Kirim antrian ke PC gudang
  // Dikirim berurutan (paling lama dulu). Putus jaringan → berhenti, sisanya dicoba lagi nanti.
  // Ditolak gudang (data rusak) → tetap di antrian dengan pesan error, lanjut ke transaksi berikutnya.
  async function sync(svc) {
    const out = { sent: 0, duplicates: 0, checks: [], errors: [], stopped: '' };
    for (const s of pending()) {
      try {
        const r = await svc.importOfflineSale({
          receipt_no: s.receipt_no, client_ref: s.client_ref, created_at: s.created_at,
          payment_method: s.payment_method, cashier: s.cashier,
          lines: s.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unit_price: l.unit_price })),
        });
        Object.assign(s, { status: 'synced', synced_at: now(), result: r.status, notes: r.notes || [], online_receipt: r.online_receipt || '', last_error: '' });
        saveQueue();
        if (r.status === 'duplicate') out.duplicates++;
        else out.sent++;
        if (r.status === 'check') out.checks.push({ receipt_no: s.receipt_no, notes: r.notes });
      } catch (err) {
        s.attempts = (s.attempts || 0) + 1;
        s.last_error = err.message || String(err);
        saveQueue();
        if (err.network) { out.stopped = s.last_error; break; }
        out.errors.push({ receipt_no: s.receipt_no, error: s.last_error });
      }
    }
    const synced = queue.sales.filter((s) => s.status === 'synced');
    if (synced.length > KEEP_SYNCED) {
      const drop = new Set(synced.slice(0, synced.length - KEEP_SYNCED));
      queue.sales = queue.sales.filter((s) => !drop.has(s));
      saveQueue();
    }
    queue.last_sync = { at: now(), ...out };
    saveQueue();
    return out;
  }

  function summary() {
    const p = pending();
    return {
      pending: p.length,
      pending_total: p.reduce((s, x) => s + x.total, 0),
      errors: p.filter((x) => x.last_error).map((x) => ({ receipt_no: x.receipt_no, error: x.last_error })),
      last_sync: queue.last_sync || null,
      cache_at: cache ? cache.updated_at : '',
      products: products().length,
      shift: cache ? cache.shift : null,
      ready: !!(cache && cache.shift),
    };
  }

  return {
    refresh, setShift, getProduct, findByCode, searchProducts, checkout, sync, summary, pending,
    hasCache: () => !!cache,
    hasUsers: () => !!(cache && Array.isArray(cache.users) && cache.users.length),
    verifyLogin: (a) => {
      if (!(cache && Array.isArray(cache.users) && cache.users.length)) fail('Login darurat belum siap: data akun belum pernah diunduh dari PC Gudang.');
      const u = matchLogin(cache && cache.users, a);
      if (!u) fail('Nama atau PIN salah.');
      return u;
    },
    getShift: () => (cache ? cache.shift : null),
    getSettings: () => (cache ? cache.settings : null),
    meta: () => (cache ? cache.meta : null),
    cacheAgeMs: () => (cache ? Date.now() - (Number(cache.updated_ms) || 0) : Infinity),
  };
}

module.exports = { createOfflineStore, CACHE_FILE, QUEUE_FILE };
