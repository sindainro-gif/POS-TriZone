'use strict';
// Formatter nota thermal: teks lebar tetap (58 mm = 32 kolom, 80 mm = 48 kolom).

const COLS = { 58: 32, 80: 48 };
const PRINTABLE_MM = { 58: 48, 80: 72 };

const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const pad2 = (n) => String(n).padStart(2, '0');

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

function textLines(text, cols) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).flatMap((l) => wrap(l, cols)).map((l) => center(l, cols));
}

function parseTime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6] } : null;
}

/**
 * receipt: { receipt_no, created_at, cashier, payment_method, lines:[{name, qty, unit_price, line_total}], total, cash_received, change }
 * settings: { receipt_header, receipt_footer, store_name, store_address, paper_width }
 */
function buildReceiptLines(receipt, settings = {}, { reprint = false, now = new Date() } = {}) {
  const cols = COLS[settings.paper_width] || COLS[58];
  const dash = '-'.repeat(cols);
  const out = [];

  const header = settings.receipt_header && settings.receipt_header.trim()
    ? settings.receipt_header
    : [settings.store_name, settings.store_address].filter(Boolean).join('\n');
  out.push(...textLines(header, cols));
  if (reprint) out.push(center('** CETAK ULANG **', cols));
  if (settings.demo) out.push(center('** DEMO - BUKAN NOTA ASLI **', cols));
  // Transaksi saat PC gudang tidak terhubung (nomor OFF-...), dikirim ke gudang setelah koneksi kembali
  if (/^OFF-/.test(receipt.receipt_no)) out.push(center('** MODE DARURAT **', cols));
  out.push(dash);

  const t = parseTime(receipt.created_at);
  // Nomor struk tidak dicetak (tetap tersimpan & tampil di Laporan Shift)
  out.push(...leftRight(`Tgl: ${t ? `${t.d}-${t.mo}-${t.y.slice(2)}` : '-'}`, t ? `${t.h}:${t.mi}:${t.s}` : '', cols));
  out.push(...wrap(`Ksr: ${receipt.cashier || '-'}`, cols));
  out.push(dash);

  for (const l of receipt.lines) {
    out.push(...wrap(l.name, cols));
    out.push(...leftRight(`${num(l.unit_price)} x ${num(l.qty)} =`, num(l.line_total), cols));
  }
  out.push(dash);

  const qty = receipt.lines.reduce((s, l) => s + Number(l.qty || 0), 0);
  out.push(`BRS=${receipt.lines.length} ,QTY ${num(qty)}`);
  out.push(...leftRight('Total       =', num(receipt.total), cols));
  const isCash = receipt.payment_method === 'Tunai';
  if (isCash && !reprint) {
    out.push(...leftRight('Tunai       =', num(receipt.cash_received), cols));
    out.push(dash);
    out.push(...leftRight('Kembali     =', num(receipt.change), cols));
  } else {
    out.push(...leftRight(`${receipt.payment_method}`.padEnd(12) + '=', num(receipt.total), cols));
  }
  out.push(dash);

  out.push(...textLines(settings.receipt_footer, cols));
  const p = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  out.push(`JAM CETAK : ${p}`.slice(0, cols));
  return out;
}

function receiptPage(lines, paperWidth) {
  const width = COLS[paperWidth] ? Number(paperWidth) : 58;
  const cols = COLS[width];
  // Lebar karakter monospace ≈ 0,6 em → ukuran font agar `cols` karakter pas di area cetak
  const fontMm = (PRINTABLE_MM[width] / cols / 0.6).toFixed(2);
  const lineMm = fontMm * 1.2;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    pre { margin: 2mm auto 0; width: ${PRINTABLE_MM[width]}mm; font-family: "Courier New", Consolas, monospace;
          font-size: ${fontMm}mm; line-height: ${lineMm.toFixed(2)}mm; color: #000; font-weight: 600; white-space: pre; }
  </style></head><body><pre>${esc(lines.join('\n'))}\n\n\n</pre></body></html>`;
  // Tinggi kertas mengikuti panjang nota (+ ruang sobek)
  const heightMm = Math.ceil((lines.length + 4) * lineMm + 6);
  return { html, widthMicrons: width * 1000, heightMicrons: Math.max(heightMm, 40) * 1000 };
}

module.exports = { buildReceiptLines, receiptPage, COLS };
