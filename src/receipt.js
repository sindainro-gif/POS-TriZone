'use strict';
// Nota thermal. Isi nota dibangun sebagai baris terstruktur (tengah, kiri, kiri–kanan, label = nilai, garis),
// lalu dicetak sebagai HTML dengan font biasa (Segoe UI) yang ukurannya bisa diatur. Versi teks lebar tetap
// (58 mm = 32 kolom, 80 mm = 48 kolom) tetap tersedia untuk ringkasan & uji otomatis.

const COLS = { 58: 32, 80: 48 };
const PRINTABLE_MM = { 58: 48, 80: 72 };
const BASE_FONT_MM = { 58: 2.75, 80: 3.1 }; // ukuran huruf "Normal"
const FONT_SCALES = ['90', '100', '115', '130']; // Kecil, Normal, Besar, Sangat Besar (persen)
const TOP_MM = 5; // jarak atas: baris pertama tidak terpotong di tepi atas kertas
const TEAR_MM = 12; // ruang kosong di bawah untuk menyobek

const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const pad2 = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function center(text, cols) {
  const t = text.slice(0, cols);
  return ' '.repeat(Math.floor((cols - t.length) / 2)) + t;
}

// Teks kiri dan kanan dalam satu baris; jika tidak muat, kanan pindah ke baris berikutnya.
function leftRight(left, right, cols) {
  if (left.length + right.length + 1 <= cols) return [left + ' '.repeat(cols - left.length - right.length) + right];
  return [...wrap(left, cols), right.padStart(cols)];
}

function wrap(text, cols) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (word.length > cols) {
      if (line) { out.push(line); line = ''; }
      for (let i = 0; i < word.length; i += cols) out.push(word.slice(i, i + cols));
      line = out.pop();
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= cols) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

const textRows = (text, extra = {}) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((s) => ({ t: 'c', s, ...extra }));

function parseTime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6] } : null;
}

/**
 * Baris nota terstruktur: { t: 'c' | 'l' | 'lr' | 'kv' | 'hr', ... }
 * receipt: { receipt_no, created_at, cashier, payment_method, lines:[{name, qty, unit_price, line_total}], total, cash_received, change }
 * settings: { receipt_header, receipt_footer, store_name, store_address, paper_width }
 */
// Kepala nota: header nota di Pengaturan, atau nama & alamat toko. Baris pertama (nama toko) sedikit lebih besar.
function headerRows(settings) {
  const header = settings.receipt_header && settings.receipt_header.trim()
    ? settings.receipt_header
    : [settings.store_name, settings.store_address].filter(Boolean).join('\n');
  const head = textRows(header);
  if (head.length) head[0].big = true;
  return head;
}

const printedAt = (now) => `JAM CETAK : ${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

function buildReceiptRows(receipt, settings = {}, { reprint = false } = {}) {
  const rows = [];
  rows.push(...headerRows(settings));
  if (reprint) rows.push({ t: 'c', s: '** CETAK ULANG **' });
  if (settings.demo) rows.push({ t: 'c', s: '** DEMO - BUKAN NOTA ASLI **' });
  // Transaksi saat PC gudang tidak terhubung (nomor OFF-...), dikirim ke gudang setelah koneksi kembali
  if (/^OFF-/.test(receipt.receipt_no)) rows.push({ t: 'c', s: '** MODE DARURAT **' });
  // Pembatalan dicetak sebagai nota tersendiri; nota asli yang dicetak ulang diberi tanda sudah dibatalkan
  if (receipt.void_of) rows.push({ t: 'c', s: '** NOTA PEMBATALAN **' });
  if (receipt.voided_by) rows.push({ t: 'c', s: '** NOTA SUDAH DIBATALKAN **' });
  rows.push({ t: 'hr' });

  const tm = parseTime(receipt.created_at);
  // Nomor struk tidak dicetak (tetap tersimpan & tampil di Laporan Shift)
  rows.push({ t: 'lr', l: `Tgl: ${tm ? `${tm.d}-${tm.mo}-${tm.y.slice(2)}` : '-'}`, r: tm ? `${tm.h}:${tm.mi}:${tm.s}` : '' });
  rows.push({ t: 'l', s: `Ksr: ${receipt.cashier || '-'}` });
  if (receipt.order_no) rows.push({ t: 'l', s: `Pesanan: ${receipt.order_no}` });
  if (receipt.void_of) {
    const o = parseTime(receipt.void_of_at);
    rows.push({ t: 'l', s: `Batal nota: ${o ? `${o.d}-${o.mo}-${o.y.slice(2)} ${o.h}:${o.mi}:${o.s}` : '-'}` });
  }
  rows.push({ t: 'hr' });

  for (const l of receipt.lines) {
    rows.push({ t: 'l', s: l.name });
    rows.push({ t: 'lr', l: `${num(l.unit_price)} x ${num(l.qty)} =`, r: num(l.line_total) });
  }
  rows.push({ t: 'hr' });

  const qty = receipt.lines.reduce((s, l) => s + Number(l.qty || 0), 0);
  rows.push({ t: 'l', s: `BRS=${receipt.lines.length} ,QTY ${num(qty)}` });
  rows.push({ t: 'kv', k: 'Total', v: num(receipt.total) });
  const isCash = receipt.payment_method === 'Tunai';
  if (receipt.void_of) {
    rows.push({ t: 'kv', k: 'Dikembalikan', v: num(receipt.total) });
    rows.push({ t: 'hr' });
    rows.push({ t: 'l', s: `Alasan: ${receipt.reason || '-'}` });
    rows.push({ t: 'l', s: `Disetujui: ${receipt.approved_by || '-'}` });
  } else {
    // Pesanan yang diambil: deposit sudah dibayar saat pesan, yang dibayar sekarang = sisa
    const dep = Number(receipt.deposit) || 0;
    if (dep > 0) {
      rows.push({ t: 'kv', k: 'Deposit', v: num(dep) });
      rows.push({ t: 'kv', k: 'Sisa bayar', v: num(receipt.total - dep) });
    }
    if (isCash && !reprint) {
      rows.push({ t: 'kv', k: 'Tunai', v: num(receipt.cash_received) });
      rows.push({ t: 'hr' });
      rows.push({ t: 'kv', k: 'Kembali', v: num(receipt.change) });
    } else {
      rows.push({ t: 'kv', k: `${receipt.payment_method}`, v: num(receipt.total - dep) });
    }
  }
  rows.push({ t: 'hr' });

  // Tanpa "JAM CETAK" di bawah: tanggal & jam transaksi sudah tercetak di atas (Tgl)
  rows.push(...textRows(settings.receipt_footer));
  return rows;
}

/**
 * Rekap tutup shift ringkas untuk printer nota.
 * recap: { cashier, shift_start, closed_at, receipts, qty, revenue, cash_sales, voids: { count, total }, notes }
 */
function buildShiftRows(recap = {}, settings = {}, { reprint = false, now = new Date() } = {}) {
  const fmt = (s) => { const m = parseTime(s); return m ? `${m.d}-${m.mo}-${m.y.slice(2)} ${m.h}:${m.mi}` : '-'; };
  const voids = recap.voids || {};
  const rows = [...headerRows(settings), { t: 'c', s: '** REKAP TUTUP SHIFT **' }];
  if (reprint) rows.push({ t: 'c', s: '** CETAK ULANG **' });
  if (settings.demo) rows.push({ t: 'c', s: '** DEMO - BUKAN NOTA ASLI **' });
  rows.push({ t: 'hr' });
  rows.push({ t: 'lr', l: 'Kasir', r: String(recap.cashier || '-') });
  rows.push({ t: 'lr', l: 'Mulai', r: fmt(recap.shift_start) });
  rows.push({ t: 'lr', l: 'Tutup', r: fmt(recap.closed_at) });
  rows.push({ t: 'hr' });
  rows.push({ t: 'kv', k: 'Transaksi', v: `${num(recap.receipts)} struk` });
  rows.push({ t: 'kv', k: 'Barang', v: `${num(recap.qty)} biji` });
  if (Number(voids.count) > 0) {
    rows.push({ t: 'kv', k: 'Pembatalan', v: `${num(voids.count)} nota` });
    rows.push({ t: 'kv', k: 'Dikembalikan', v: num(voids.total) });
  }
  rows.push({ t: 'hr' });
  rows.push({ t: 'kv', k: 'Total omset', v: num(recap.revenue) });
  rows.push({ t: 'kv', k: 'Tunai', v: num(recap.cash_sales) });
  // Uang pesanan (hanya bila ada): deposit bukan omset, jadi uang tunai di laci dihitung terpisah
  const ord = recap.orders || {};
  if (ord.deposit_in || ord.deposit_used || ord.refunded || ord.forfeited) {
    rows.push({ t: 'hr' });
    if (ord.deposit_in) rows.push({ t: 'kv', k: 'Deposit masuk', v: num(ord.deposit_in) });
    if (ord.deposit_used) rows.push({ t: 'kv', k: 'Deposit pakai', v: num(ord.deposit_used) });
    if (ord.refunded) rows.push({ t: 'kv', k: 'Deposit kembali', v: num(ord.refunded) });
    if (ord.forfeited) rows.push({ t: 'kv', k: 'Deposit hangus', v: num(ord.forfeited) });
    rows.push({ t: 'kv', k: 'Tunai di laci', v: num(ord.cash_total) });
  }
  rows.push({ t: 'hr' });
  if (String(recap.notes || '').trim()) {
    rows.push({ t: 'l', s: `Catatan: ${String(recap.notes).trim()}` });
    rows.push({ t: 'hr' });
  }
  rows.push({ t: 'l', s: printedAt(now), cut: true });
  return rows;
}

// Versi teks lebar tetap dari baris nota (ringkasan & uji otomatis)
function rowsToText(rows, cols) {
  const out = [];
  for (const r of rows) {
    if (r.t === 'hr') out.push('-'.repeat(cols));
    else if (r.t === 'c') out.push(...wrap(r.s, cols).map((l) => center(l, cols)));
    else if (r.t === 'l') out.push(...(r.cut ? [String(r.s).slice(0, cols)] : wrap(r.s, cols)));
    else if (r.t === 'lr') out.push(...leftRight(r.l, r.r, cols));
    else if (r.t === 'kv') out.push(...leftRight(`${r.k}`.padEnd(12) + '=', r.v, cols));
  }
  return out;
}

function buildReceiptLines(receipt, settings = {}, opts = {}) {
  return rowsToText(buildReceiptRows(receipt, settings, opts), COLS[settings.paper_width] || COLS[58]);
}

const normRows = (rows) => rows.map((r) => (typeof r === 'string' ? { t: 'l', s: r } : r));

function rowsToHtml(rows) {
  return normRows(rows).map((r) => {
    if (r.t === 'hr') return '<div class="n-hr"></div>';
    if (r.t === 'c') return `<div class="n-c${r.big ? ' n-big' : ''}">${esc(r.s)}</div>`;
    if (r.t === 'lr') return `<div class="n-lr"><span>${esc(r.l)}</span><span class="n-v">${esc(r.r)}</span></div>`;
    if (r.t === 'kv') return `<div class="n-kv"><span>${esc(r.k)}</span><span>=</span><span class="n-v">${esc(r.v)}</span></div>`;
    return `<div class="n-l">${esc(r.s)}</div>`;
  }).join('');
}

// Tampilan nota (CSS + isi) untuk cetak maupun pratinjau di Pengaturan. Teks dimulai di tepi kiri AREA CETAK:
// driver printer thermal umumnya sudah memulai cetak dari situ (dulu teks di tengah kertas → kanan terpotong).
// offsetMm = geser ke kanan bila sisi kiri terpotong; fontScale = ukuran huruf (persen).
function receiptFragment(rows, paperWidth, { offsetMm = 0, fontScale = 100 } = {}) {
  const width = COLS[paperWidth] ? Number(paperWidth) : 58;
  const offset = Math.min(10, Math.max(0, Number(offsetMm) || 0));
  const scale = FONT_SCALES.includes(String(fontScale)) ? Number(fontScale) : 100;
  const fontMm = (BASE_FONT_MM[width] * scale) / 100;
  const css = `.nota { box-sizing: border-box; width: ${PRINTABLE_MM[width]}mm; margin: 0 0 0 ${offset}mm; padding: ${TOP_MM}mm 0 ${TEAR_MM}mm;
      font-family: "Segoe UI", "Segoe UI Semibold", Arial, sans-serif; font-size: ${fontMm.toFixed(2)}mm; line-height: 1.3;
      color: #000; font-weight: 600; font-variant-numeric: tabular-nums; }
    .nota .n-c { text-align: center; overflow-wrap: anywhere; }
    .nota .n-c.n-big { font-size: 1.15em; font-weight: 700; }
    .nota .n-l { overflow-wrap: anywhere; }
    .nota .n-lr { display: flex; justify-content: space-between; gap: 2mm; }
    .nota .n-kv { display: grid; grid-template-columns: 40% auto 1fr; column-gap: 1.5mm; }
    .nota .n-v { text-align: right; white-space: nowrap; }
    .nota .n-hr { border-top: 0.35mm dashed #000; margin: 1mm 0; }`;
  return { css, html: `<div class="nota">${rowsToHtml(rows)}</div>`, width, fontMm };
}

function receiptPage(rows, paperWidth, opts = {}) {
  const f = receiptFragment(normRows(rows), paperWidth, opts);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    ${f.css}
  </style></head><body>${f.html}</body></html>`;
  // Perkiraan tinggi kertas (dipakai bila tinggi sebenarnya tidak bisa diukur): baris panjang dihitung terbungkus
  const charsPerLine = Math.max(10, Math.floor(PRINTABLE_MM[f.width] / (f.fontMm * 0.55)));
  const lines = normRows(rows).reduce((n, r) => n + (r.t === 'hr' ? 0.6 : Math.ceil(String(r.s || `${r.l || ''} ${r.r || ''} ${r.k || ''} ${r.v || ''}`).length / charsPerLine) || 1), 0);
  const heightMm = Math.ceil(lines * f.fontMm * 1.3 * 1.15 + TOP_MM + TEAR_MM);
  // measure: printPage mengukur tinggi isi sebenarnya (selector) agar kertas tidak terbuang / terpotong
  return { html, widthMicrons: f.width * 1000, heightMicrons: Math.max(heightMm, 40) * 1000, measure: '.nota' };
}

/**
 * Bukti pesanan untuk pelanggan.
 * order: { order_no, created_at, pickup_date, customer_name, customer_phone, items:[{name, qty, unit_price, line_total}], total, deposit, notes, status }
 */
function buildOrderRows(order = {}, settings = {}, { reprint = false } = {}) {
  const tm = parseTime(order.created_at);
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(order.pickup_date || ''));
  const total = Number(order.total) || 0;
  const dep = Number(order.deposit) || 0;
  const rows = [...headerRows(settings), { t: 'c', s: '** BUKTI PESANAN **' }];
  if (reprint) rows.push({ t: 'c', s: '** CETAK ULANG **' });
  if (settings.demo) rows.push({ t: 'c', s: '** DEMO - BUKAN NOTA ASLI **' });
  if (order.status === 'diambil') rows.push({ t: 'c', s: '** SUDAH DIAMBIL **' });
  if (order.status === 'batal') rows.push({ t: 'c', s: '** PESANAN DIBATALKAN **' });
  rows.push({ t: 'hr' });
  rows.push({ t: 'lr', l: 'No. Pesanan', r: String(order.order_no || '-') });
  rows.push({ t: 'lr', l: 'Tgl pesan', r: tm ? `${tm.d}-${tm.mo}-${tm.y.slice(2)} ${tm.h}:${tm.mi}` : '-' });
  rows.push({ t: 'lr', l: 'Ambil tgl', r: d ? `${d[3]}-${d[2]}-${d[1]}` : '-' });
  rows.push({ t: 'l', s: `Pelanggan: ${order.customer_name || '-'}` });
  if (order.customer_phone) rows.push({ t: 'l', s: `HP: ${order.customer_phone}` });
  rows.push({ t: 'hr' });
  for (const l of order.items || []) {
    rows.push({ t: 'l', s: l.name });
    rows.push({ t: 'lr', l: `${num(l.unit_price)} x ${num(l.qty)} =`, r: num(l.line_total) });
  }
  rows.push({ t: 'hr' });
  rows.push({ t: 'kv', k: 'Total', v: num(total) });
  rows.push({ t: 'kv', k: 'Deposit', v: num(dep) });
  rows.push({ t: 'kv', k: 'Sisa bayar', v: num(total - dep) });
  rows.push({ t: 'hr' });
  if (String(order.notes || '').trim()) {
    rows.push({ t: 'l', s: `Catatan: ${String(order.notes).trim()}` });
    rows.push({ t: 'hr' });
  }
  rows.push({ t: 'c', s: 'Tunjukkan bukti ini saat mengambil barang.' });
  rows.push(...textRows(settings.receipt_footer));
  return rows;
}

module.exports = { buildReceiptLines, buildReceiptRows, buildShiftRows, buildOrderRows, rowsToText, receiptFragment, receiptPage, COLS, FONT_SCALES };
