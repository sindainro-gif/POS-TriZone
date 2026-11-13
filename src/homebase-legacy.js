'use strict';
// Riwayat penjualan lama (sebelum ada Homebase): dibaca dari CSV laporan tutup shift di folder laporan
// (Shift_YYYYMMDD_HHMMSS\Penjualan_Shift_*.csv) lalu dijadikan data paket "shift".
// Tanpa Electron agar bisa diuji dengan Node biasa.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSalesCsv } = require('./reports');

// Ditulis di folder laporan setiap tutup shift versi ini: penjualannya sudah ada di paket shift
const MARKER = 'homebase.json';
const FOLDER_RE = /^Shift_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/;
const LEGACY_CASHIER = '(riwayat lama)';

const receiptKey = (r) => `${r.receipt_no}|${r.created_at}`;

/**
 * Tutup shift yang email-nya gagal membuat folder berisi sebagian penjualan; penjualan yang sama muncul lagi
 * di folder tutup shift berikutnya. Karena itu setiap struk hanya dihitung di folder TERAKHIR yang memuatnya.
 * Folder bertanda MARKER (sudah punya paket shift) tidak dijadikan paket lagi, tetapi tetap ikut dipakai untuk
 * menentukan folder terakhir sebuah struk, supaya struknya tidak terhitung dua kali.
 */
function collectLegacyShifts(reportsDir, { storeId }) {
  const out = { shifts: [], errors: [], scanned: 0, covered: 0 };
  let names = [];
  try {
    names = fs.readdirSync(reportsDir).filter((n) => FOLDER_RE.test(n)).sort();
  } catch (_) {
    return out;
  }
  const folders = [];
  for (const name of names) {
    const dir = path.join(reportsDir, name);
    let csv;
    try { csv = fs.readdirSync(dir).find((f) => /^Penjualan_Shift_.*\.csv$/i.test(f)); } catch (_) { continue; }
    if (!csv) continue;
    let rows;
    try {
      rows = parseSalesCsv(fs.readFileSync(path.join(dir, csv), 'utf8'));
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`);
      continue;
    }
    const m = FOLDER_RE.exec(name);
    folders.push({
      name, rows, covered: fs.existsSync(path.join(dir, MARKER)),
      closed_at: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    });
  }
  out.scanned = folders.length;

  const owner = new Map(); // struk → indeks folder terakhir yang memuatnya
  folders.forEach((f, i) => { for (const r of f.rows) owner.set(receiptKey(r), i); });

  folders.forEach((f, i) => {
    if (f.covered) { out.covered++; return; }
    const rows = f.rows.filter((r) => owner.get(receiptKey(r)) === i);
    if (!rows.length) return;
    const seq = new Map();
    const sales = rows.map((r) => {
      const n = (seq.get(r.receipt_no) || 0) + 1;
      seq.set(r.receipt_no, n);
      return { ...r, line_no: n };
    });
    const methods = new Map();
    for (const r of sales) {
      const m = methods.get(r.payment_method) || { method: r.payment_method, receipts: new Set(), total: 0 };
      m.receipts.add(r.receipt_no);
      m.total += r.line_total;
      methods.set(r.payment_method, m);
    }
    const receipts = new Set(sales.map((r) => r.receipt_no));
    const start = sales.reduce((min, r) => (r.created_at < min ? r.created_at : min), sales[0].created_at);
    out.shifts.push({
      folder: f.name,
      shift: {
        // ID tetap per toko + folder: menjalankan ulang tidak membuat shift ganda di Homebase
        shift_uid: `legacy-${crypto.createHash('sha1').update(`${storeId}|${f.name}`).digest('hex').slice(0, 24)}`,
        cashier_name: LEGACY_CASHIER,
        shift_start: start,
        closed_at: f.closed_at,
        notes: `Riwayat lama dari folder laporan ${f.name}`,
        receipts: receipts.size,
        qty: sales.reduce((s, r) => s + r.qty, 0),
        revenue: sales.reduce((s, r) => s + r.line_total, 0),
        cash_sales: sales.filter((r) => r.payment_method === 'Tunai').reduce((s, r) => s + r.line_total, 0),
        by_method: [...methods.values()].map((m) => ({ method: m.method, receipts: m.receipts.size, total: m.total }))
          .sort((a, b) => b.total - a.total),
        offline_receipts: [...receipts].filter((r) => /^OFF-/.test(r)).length,
        legacy: true,
      },
      sales,
    });
  });
  return out;
}

module.exports = { collectLegacyShifts, MARKER, LEGACY_CASHIER };
