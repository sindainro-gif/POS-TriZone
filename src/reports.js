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

const SALES_HEADERS = ['No_Struk', 'Waktu', 'SKU', 'Nama_Barang', 'Jumlah_Biji', 'Harga_Satuan', 'Subtotal', 'Metode_Bayar'];

function salesCsv(rows) {
  return toCsv(
    SALES_HEADERS,
    rows.map((r) => [r.receipt_no, r.created_at, r.sku, r.product_name, r.qty_sold, r.unit_price, r.line_total, r.payment_method]),
  );
}

function stockCsv(rows) {
  return toCsv(
    ['SKU', 'Barcode', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Stok_Toko', 'Stok_Gudang_Utama', 'Stok_Gudang_BS', 'Min_Alert_Toko', 'Status_Toko', 'Stok_Gudang_Shopee'],
    rows.map((r) => [
      r.sku, r.barcode, r.name, r.brand, r.category, r.unit_price, r.floor_stock, r.warehouse_stock, r.damaged_stock, r.min_floor_alert,
      r.floor_stock <= r.min_floor_alert ? 'MENIPIS' : 'AMAN', r.shopee_stock,
    ]),
  );
}

function summaryHtml({ store, summary, closedAt, notes, lowStock }) {
  const { shift, totals, byMethod, byItem } = summary;
  const off = summary.offline || { receipts: 0, checks: [] };
  const voids = (summary.voids && summary.voids.list) || [];
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
  ${(() => {
    const o = summary.orders || {};
    if (!(o.deposit_in || o.deposit_used || o.refunded || o.forfeited)) return '';
    return [['Deposit pesanan masuk', o.deposit_in], ['Deposit terpakai (pesanan diambil)', o.deposit_used], ['Deposit dikembalikan', o.refunded], ['Deposit hangus', o.forfeited]]
      .filter(([, v]) => v).map(([k, v]) => `<tr><td>${k}</td><td class="r">${rp(v)}</td></tr>`).join('')
      + `<tr><td><b>Uang tunai di laci</b></td><td class="r"><b>${rp(o.cash_total)}</b></td></tr>`;
  })()}
</table>
${notes ? `<p><b>Catatan kasir:</b> ${esc(notes)}</p>` : ''}
<h2>Omset per Metode Pembayaran</h2>
<table><tr><th>Metode</th><th class="r">Transaksi</th><th class="r">Total</th></tr>
${byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="r">${num(m.receipts)}</td><td class="r">${rp(m.total)}</td></tr>`).join('') || '<tr><td colspan="3">Tidak ada penjualan.</td></tr>'}
</table>
${voids.length ? `<h2>Pembatalan Nota (disetujui Admin)</h2>
<p class="muted">Omset di atas sudah dikurangi pembatalan berikut. Nota asli tidak dihapus.</p>
<table><tr><th>No. Pembatalan</th><th>Nota Asal</th><th>Waktu</th><th class="r">Dikembalikan</th><th>Alasan</th><th>Diminta</th><th>Disetujui</th></tr>
${voids.map((v) => `<tr><td>${esc(v.void_no)}</td><td>${esc(v.receipt_no)}</td><td>${esc(v.created_at)}</td><td class="r">${rp(v.total)}</td><td>${esc(v.reason)}</td><td>${esc(v.requested_by)}</td><td>${esc(v.approved_by)}</td></tr>`).join('')}
</table>` : ''}
<h2>Rincian Barang Terjual</h2>
<table><tr><th>SKU</th><th>Nama Barang</th><th class="r">Jumlah (Biji)</th><th class="r">Total</th></tr>
${byItem.map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="r">${num(i.qty)}</td><td class="r">${rp(i.total)}</td></tr>`).join('') || '<tr><td colspan="4">Tidak ada penjualan.</td></tr>'}
</table>
${lowStock.length ? `<h2>Peringatan Display Toko Menipis</h2>
<table><tr><th>SKU</th><th>Nama Barang</th><th class="r">Display Toko</th><th class="r">Min</th><th class="r">Gudang Utama</th><th class="r">Gudang BS</th></tr>
${lowStock.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td class="r">${num(p.floor_stock)}</td><td class="r">${num(p.min_floor_alert)}</td><td class="r">${num(p.warehouse_stock)}</td><td class="r">${num(p.damaged_stock)}</td></tr>`).join('')}
</table>` : ''}
${off.receipts ? `<p>Termasuk <b>${num(off.receipts)} transaksi MODE DARURAT</b> (nomor struk OFF-…) yang dicatat saat PC Server tidak terhubung.</p>` : ''}
${off.checks.length ? `<h2>Transaksi Mode Darurat — Perlu Dicek</h2>
<table><tr><th>No. Struk</th><th>Waktu</th><th class="r">Total</th><th>Catatan</th></tr>
${off.checks.map((c) => `<tr><td>${esc(c.receipt_no)}</td><td>${esc(c.created_at)}</td><td class="r">${rp(c.total)}</td><td>${c.notes.map(esc).join('<br>')}</td></tr>`).join('')}
</table>` : ''}
<p class="muted" style="margin-top:18px">Snapshot stok lengkap (Display Toko, Gudang Utama, Gudang BS, Gudang Shopee) tersimpan dalam file CSV terpisah.</p>
</body></html>`;
}

// Surat Retur Barang (A4) untuk dicetak toko dan diserahkan ke supplier bersama barangnya.
// doc = dokumen retur (getTransferDoc): doc_no, created_at, supplier_name, ref_no, from_zone, reason, items, cancelled_at
const RETURN_FROM_LABEL = { damaged: 'Gudang BS', warehouse: 'Gudang Utama' };
function returnDocHtml({ store = {}, doc, printedAt = '' }) {
  const items = doc.items || [];
  const totalQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const unit = (i) => (i.pack_type === 'Coly' && i.pack_qty
    ? `${num(i.pack_qty)} Coly <span class="muted">(isi ${num(i.qty / i.pack_qty)})</span>` : `${num(i.qty)} Biji`);
  const tgl = String(doc.created_at || '').replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}).*$/, '$3-$2-$1 $4');
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Surat Retur ${esc(doc.doc_no)}</title>
<style>
  body{font-family:"Segoe UI",Arial,sans-serif;color:#111;font-size:12px;margin:0}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px}
  .store b{font-size:16px} .title{text-align:right} .title h1{font-size:20px;margin:0;letter-spacing:.5px} .title .no{font-size:14px;font-weight:700;margin-top:2px}
  .muted{color:#555} .info{display:grid;grid-template-columns:1fr 1fr;gap:4px 28px;margin:12px 0}
  .info div{display:flex;gap:8px;border-bottom:1px dotted #bbb;padding:3px 0} .info span{min-width:120px;color:#444}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #999;padding:5px 6px;text-align:left;vertical-align:top}
  th{background:#eee} .r{text-align:right} .c{text-align:center} .mono{font-family:Consolas,monospace}
  .tot td{font-weight:700;background:#f6f6f6}
  .sign{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:36px;text-align:center}
  .sign .line{margin-top:64px;border-top:1px solid #111;padding-top:3px}
  .batal{border:3px solid #c00;color:#c00;font-size:20px;font-weight:800;text-align:center;padding:6px;margin:10px 0}
  .foot{margin-top:24px;font-size:10px;color:#666}
</style></head><body>
<div class="head">
  <div class="store"><b>${esc(store.store_name || 'Toko')}</b><div class="muted">${esc(store.store_address || '').replace(/\n/g, '<br>')}</div></div>
  <div class="title"><h1>SURAT RETUR BARANG</h1><div class="no mono">${esc(doc.doc_no)}</div></div>
</div>
${doc.cancelled_at ? `<div class="batal">DIBATALKAN — retur ini tidak berlaku${doc.cancel_reason ? ` (${esc(doc.cancel_reason)})` : ''}</div>` : ''}
<div class="info">
  <div><span>Tanggal</span><b>${esc(tgl)}</b></div>
  <div><span>Kepada (Supplier)</span><b>${esc(doc.supplier_name || '-')}</b></div>
  <div><span>No. Dokumen Retur</span><b>${esc(doc.ref_no || '-')}</b></div>
  <div><span>Diambil dari</span><b>${esc(RETURN_FROM_LABEL[doc.from_zone] || doc.from_zone || '-')}</b></div>
  <div style="grid-column:1 / span 2"><span>Alasan retur</span><b>${esc(doc.reason || '-')}</b></div>
  ${doc.shipped_at && !doc.cancelled_at ? `<div style="grid-column:1 / span 2"><span>Status</span><b>Sudah dimuat / dikirim ${esc(String(doc.shipped_at).replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}).*$/, '$3-$2-$1 $4'))}${doc.shipped_by ? ` (${esc(doc.shipped_by)})` : ''}</b></div>` : ''}
</div>
<table>
  <tr><th class="c" style="width:32px">No</th><th style="width:110px">Kode Item</th><th style="width:120px">Barcode</th><th>Nama Barang</th><th class="r" style="width:120px">Jumlah</th><th class="r" style="width:80px">Total Biji</th></tr>
  ${items.map((i, n) => `<tr><td class="c">${n + 1}</td><td class="mono">${esc(i.sku)}</td><td class="mono">${esc(i.barcode || '')}</td><td>${esc(i.name || i.sku)}</td>
    <td class="r">${unit(i)}</td><td class="r">${num(i.qty)}</td></tr>`).join('')}
  <tr class="tot"><td colspan="5">${num(items.length)} jenis barang</td><td class="r">${num(totalQty)}</td></tr>
</table>
<div class="sign">
  <div>Dibuat oleh<div class="line">Nama &amp; tanda tangan</div></div>
  <div>Diserahkan oleh<div class="line">Nama &amp; tanda tangan</div></div>
  <div>Diterima oleh (Supplier)<div class="line">Nama, tanda tangan &amp; cap</div></div>
</div>
<div class="foot">Dicetak ${esc(printedAt)} · POS Tri-Zone</div>
</body></html>`;
}

module.exports = { salesCsv, stockCsv, summaryHtml, returnDocHtml, SALES_HEADERS };
