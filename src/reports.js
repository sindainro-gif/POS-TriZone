'use strict';
// Pembuat file laporan tutup shift: CSV penjualan, CSV snapshot stok, dan HTML rekap (dicetak ke PDF).

const rp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const num = (n) => (Number(n) || 0).toLocaleString('id-ID');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Excel berlokal Indonesia memakai titik koma sebagai pemisah kolom; BOM agar UTF-8 terbaca benar.
function toCsv(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

function salesCsv(rows) {
  return toCsv(
    ['No_Struk', 'Waktu', 'SKU', 'Nama_Barang', 'Jumlah_Biji', 'Harga_Satuan', 'Subtotal', 'Metode_Bayar'],
    rows.map((r) => [r.receipt_no, r.created_at, r.sku, r.product_name, r.qty_sold, r.unit_price, r.line_total, r.payment_method]),
  );
}

function stockCsv(rows) {
  return toCsv(
    ['SKU', 'Barcode', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Stok_Toko', 'Stok_Gudang_Utama', 'Stok_Gudang_BS', 'Min_Alert_Toko', 'Status_Toko'],
    rows.map((r) => [
      r.sku, r.barcode, r.name, r.brand, r.category, r.unit_price, r.floor_stock, r.warehouse_stock, r.damaged_stock, r.min_floor_alert,
      r.floor_stock <= r.min_floor_alert ? 'MENIPIS' : 'AMAN',
    ]),
  );
}

function summaryHtml({ store, summary, closedAt, notes, lowStock }) {
  const { shift, totals, byMethod, byItem } = summary;
  const off = summary.offline || { receipts: 0, checks: [] };
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Rekap Shift</title>
<style>
  body{font-family:"Segoe UI",Arial,sans-serif;color:#111;font-size:11px;margin:0}
  h1{font-size:18px;margin:0 0 2px} h2{font-size:13px;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}
  .muted{color:#555} table{width:100%;border-collapse:collapse} th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}
  th{background:#f0f0f0} .r{text-align:right} .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:10px}
  .grid div{display:flex;justify-content:space-between;border-bottom:1px dotted #bbb;padding:2px 0}
  .big{font-size:15px;font-weight:700}
</style></head><body>
<h1>Rekap Tutup Shift — ${esc(store.store_name)}</h1>
<div class="muted">${esc(store.store_address || '')}</div>
<div class="grid">
  <div><span>Kasir</span><b>${esc(shift.cashier_name)}</b></div>
  <div><span>Mulai shift</span><b>${esc(shift.shift_start)}</b></div>
  <div><span>Tutup shift</span><b>${esc(closedAt)}</b></div>
  <div><span>Jumlah transaksi</span><b>${num(totals.receipts)} struk</b></div>
  <div><span>Barang terjual</span><b>${num(totals.qty)} Biji</b></div>
  <div><span class="big">Total omset</span><b class="big">${rp(totals.revenue)}</b></div>
</div>
<table style="margin-top:10px">
  <tr><td>Penjualan tunai</td><td class="r">${rp(summary.cashSales)}</td></tr>
</table>
${notes ? `<p><b>Catatan kasir:</b> ${esc(notes)}</p>` : ''}
<h2>Omset per Metode Pembayaran</h2>
<table><tr><th>Metode</th><th class="r">Transaksi</th><th class="r">Total</th></tr>
${byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="r">${num(m.receipts)}</td><td class="r">${rp(m.total)}</td></tr>`).join('') || '<tr><td colspan="3">Tidak ada penjualan.</td></tr>'}
</table>
<h2>Rincian Barang Terjual</h2>
<table><tr><th>SKU</th><th>Nama Barang</th><th class="r">Jumlah (Biji)</th><th class="r">Total</th></tr>
${byItem.map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="r">${num(i.qty)}</td><td class="r">${rp(i.total)}</td></tr>`).join('') || '<tr><td colspan="4">Tidak ada penjualan.</td></tr>'}
</table>
${lowStock.length ? `<h2>Peringatan Display Toko Menipis</h2>
<table><tr><th>SKU</th><th>Nama Barang</th><th class="r">Display Toko</th><th class="r">Min</th><th class="r">Gudang Utama</th><th class="r">Gudang BS</th></tr>
${lowStock.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td class="r">${num(p.floor_stock)}</td><td class="r">${num(p.min_floor_alert)}</td><td class="r">${num(p.warehouse_stock)}</td><td class="r">${num(p.damaged_stock)}</td></tr>`).join('')}
</table>` : ''}
${off.receipts ? `<p>Termasuk <b>${num(off.receipts)} transaksi MODE DARURAT</b> (nomor struk OFF-…) yang dicatat PC kasir saat PC gudang tidak terhubung.</p>` : ''}
${off.checks.length ? `<h2>Transaksi Mode Darurat — Perlu Dicek</h2>
<table><tr><th>No. Struk</th><th>Waktu</th><th class="r">Total</th><th>Catatan</th></tr>
${off.checks.map((c) => `<tr><td>${esc(c.receipt_no)}</td><td>${esc(c.created_at)}</td><td class="r">${rp(c.total)}</td><td>${c.notes.map(esc).join('<br>')}</td></tr>`).join('')}
</table>` : ''}
<p class="muted" style="margin-top:18px">Snapshot stok lengkap (Display Toko, Gudang Utama, Gudang BS) terlampir dalam file CSV terpisah.</p>
</body></html>`;
}

function summaryText({ store, summary, closedAt }) {
  const { shift, totals, byMethod } = summary;
  return [
    `Rekap Tutup Shift — ${store.store_name}`,
    '',
    `Kasir          : ${shift.cashier_name}`,
    `Mulai shift    : ${shift.shift_start}`,
    `Tutup shift    : ${closedAt}`,
    `Transaksi      : ${num(totals.receipts)} struk`,
    `Barang terjual : ${num(totals.qty)} Biji`,
    `TOTAL OMSET    : ${rp(totals.revenue)}`,
    '',
    'Per metode pembayaran:',
    ...(byMethod.length ? byMethod.map((m) => `  - ${m.method}: ${rp(m.total)} (${m.receipts} transaksi)`) : ['  - (tidak ada penjualan)']),
    '',
    `Penjualan tunai : ${rp(summary.cashSales)}`,
    '',
    ...offlineText(summary.offline),
    'Lampiran: Rekap PDF, detail penjualan (CSV), dan snapshot stok Display Toko / Gudang Utama / Gudang BS (CSV).',
    '',
    '— Dikirim otomatis oleh POS Tri-Zone',
  ].join('\n');
}

function offlineText(off) {
  if (!off || (!off.receipts && !off.checks.length)) return [];
  return [
    `Transaksi MODE DARURAT (OFF-...) : ${num(off.receipts)} struk`,
    ...(off.checks.length ? ['PERLU DICEK (display toko tidak cukup saat dikirim ke gudang):', ...off.checks.map((c) => `  - ${c.receipt_no}: ${c.notes.join(' ')}`)] : []),
    '',
  ];
}

module.exports = { salesCsv, stockCsv, summaryHtml, summaryText };
