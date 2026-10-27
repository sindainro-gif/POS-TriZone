'use strict';
// Draft penjualan: keranjang yang ditahan agar kasir bisa melayani pelanggan lain dulu.
// Disimpan di komputer ini saja (drafts.json). Stok TIDAK dipesan; dicek ulang saat dilanjutkan & dibayar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { localNow } = require('./services');

const FILE = 'drafts.json';
const MAX_DRAFTS = 50;

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function createDraftStore(dir, { now = localNow } = {}) {
  const file = path.join(dir, FILE);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = null; }
  if (!data || !Array.isArray(data.drafts)) data = { seq: 0, drafts: [] };

  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  };

  const list = () => [...data.drafts].reverse(); // terbaru di atas

  function add({ label, cashier, items } = {}) {
    if (!Array.isArray(items) || !items.length) fail('Keranjang masih kosong.');
    if (data.drafts.length >= MAX_DRAFTS) fail(`Maksimal ${MAX_DRAFTS} draft. Lanjutkan atau hapus draft lama dulu.`);
    const lines = items.map((it) => {
      const qty = Number(it.qty);
      if (!it.sku || !Number.isInteger(qty) || qty < 1) fail('Jumlah barang di draft tidak valid.');
      return { sku: String(it.sku), name: String(it.name || it.sku), qty, unit_price: Number(it.unit_price) || 0 };
    });
    data.seq = (Number(data.seq) || 0) + 1;
    const draft = {
      id: crypto.randomUUID(),
      label: String(label || '').trim().slice(0, 40) || `Draft #${data.seq}`,
      cashier: String(cashier || ''),
      created_at: now(),
      items: lines,
      qty: lines.reduce((s, l) => s + l.qty, 0),
      total: lines.reduce((s, l) => s + l.qty * l.unit_price, 0),
    };
    data.drafts.push(draft);
    save();
    return draft;
  }

  function remove(id) {
    const i = data.drafts.findIndex((d) => d.id === id);
    if (i < 0) fail('Draft tidak ditemukan (mungkin sudah dilanjutkan).');
    const [draft] = data.drafts.splice(i, 1);
    save();
    return draft;
  }

  // Ambil draft untuk dilanjutkan: dikeluarkan dari daftar
  const take = (id) => remove(id);

  return { list, save: add, take, remove, count: () => data.drafts.length };
}

module.exports = { createDraftStore, MAX_DRAFTS };
