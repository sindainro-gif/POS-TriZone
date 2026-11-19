'use strict';
// Uji formatter nota thermal: node test/receipt.test.js
const assert = require('assert');
const { buildReceiptLines, buildReceiptRows, buildShiftRows, rowsToText, receiptFragment, receiptPage } = require('../src/receipt');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const receipt = {
  receipt_no: 'INV-20261015-0001', created_at: '2026-10-15 14:53:30', cashier: 'SPJKASIR', payment_method: 'Tunai',
  lines: [
    { name: 'Penebah Lidi @50 PCS Sima', qty: 1, unit_price: 6000, line_total: 6000 },
    { name: 'Nama barang yang sangat panjang sekali hingga melebihi lebar kertas nota', qty: 12, unit_price: 3500, line_total: 42000 },
  ],
  total: 48000, cash_received: 50000, change: 2000,
};
const settings = {
  receipt_header: 'KANO 5000 SEPANJANG\nJl. Raya Wonocolo No. 48\nTelp:085111328510',
  receipt_footer: 'KUMPULKAN HINGGA 200 BIJI\nDAN TUKARKAN SOUVENIR',
};
const now = new Date(2026, 9, 15, 14, 53, 30);

for (const [w, cols] of [['58', 32], ['80', 48]]) {
  t(`lebar ${w} mm: tidak ada baris melebihi ${cols} karakter`, () => {
    const lines = buildReceiptLines(receipt, { ...settings, paper_width: w }, { now });
    for (const l of lines) assert.ok(l.length <= cols, `"${l}" (${l.length})`);
  });
}

t('header & footer custom tampil di tengah', () => {
  const lines = buildReceiptLines(receipt, { ...settings, paper_width: '58' }, { now });
  assert.strictEqual(lines[0].trim(), 'KANO 5000 SEPANJANG');
  assert.ok(lines[0].startsWith('      '), 'header harus rata tengah');
  assert.ok(lines.some((l) => l.trim() === 'DAN TUKARKAN SOUVENIR'));
  assert.strictEqual(lines[lines.length - 1].trim(), 'DAN TUKARKAN SOUVENIR'); // footer = baris terakhir
  assert.ok(!lines.some((l) => /JAM CETAK/.test(l)), 'jam cetak tidak dicetak di nota (jam sudah ada di atas)');
});

t('isi nota: tanggal/jam, kasir, baris barang, BRS/QTY, tunai, kembali', () => {
  const txt = buildReceiptLines(receipt, { ...settings, paper_width: '58' }, { now }).join('\n');
  assert.match(txt, /Tgl: 15-10-26\s+14:53:30/);
  assert.match(txt, /^Ksr: SPJKASIR$/m);
  assert.match(txt, /6\.000 x 1 =\s+6\.000/);
  assert.match(txt, /3\.500 x 12 =\s+42\.000/);
  assert.match(txt, /BRS=2 ,QTY 13/);
  assert.match(txt, /Tunai\s+=\s+50\.000/);
  assert.match(txt, /Kembali\s+=\s+2\.000/);
});

t('nomor struk tidak dicetak di nota (tunai, non-tunai, cetak ulang, darurat)', () => {
  for (const [r, opt] of [[receipt, {}], [{ ...receipt, payment_method: 'QRIS' }, {}], [receipt, { reprint: true }], [{ ...receipt, receipt_no: 'OFF-20261015-AB12-0001' }, {}]]) {
    const txt = buildReceiptLines(r, settings, { now, ...opt }).join('\n');
    assert.doesNotMatch(txt, /INV-|OFF-|No\.:/);
  }
  assert.match(buildReceiptLines({ ...receipt, receipt_no: 'OFF-20261015-AB12-0001' }, settings, { now }).join('\n'), /MODE DARURAT/);
});

t('header kosong memakai nama & alamat toko', () => {
  const lines = buildReceiptLines(receipt, { store_name: 'Toko Maju', store_address: 'Jl. Merdeka 1' }, { now });
  assert.deepStrictEqual(lines.slice(0, 2).map((l) => l.trim()), ['Toko Maju', 'Jl. Merdeka 1']);
});

t('cetak ulang & non-tunai tanpa kembalian', () => {
  const txt = buildReceiptLines(receipt, settings, { now, reprint: true }).join('\n');
  assert.match(txt, /CETAK ULANG/);
  assert.doesNotMatch(txt, /Kembali/);
  const qris = buildReceiptLines({ ...receipt, payment_method: 'QRIS' }, settings, { now }).join('\n');
  assert.match(qris, /QRIS\s+=\s+48\.000/);
  assert.doesNotMatch(qris, /Kembali/);
});

t('rekap tutup shift ringkas untuk printer nota', () => {
  const recap = { cashier: 'Rina', shift_start: '2026-11-19 08:00:00', closed_at: '2026-11-19 16:05:30', receipts: 12, qty: 40, revenue: 910000, cash_sales: 910000, voids: { count: 1, total: 7000 }, notes: 'Ada uang palsu 50rb' };
  for (const [w, cols] of [['58', 32], ['80', 48]]) {
    const txt = rowsToText(buildShiftRows(recap, { ...settings, paper_width: w }, { now }), cols);
    for (const l of txt) assert.ok(l.length <= cols, `"${l}" (${l.length})`);
    const all = txt.join('\n');
    assert.match(all, /KANO 5000 SEPANJANG/);
    assert.match(all, /\*\* REKAP TUTUP SHIFT \*\*/);
    assert.match(all, /Kasir\s+Rina/);
    assert.match(all, /Mulai\s+19-11-26 08:00/);
    assert.match(all, /Tutup\s+19-11-26 16:05/);
    assert.match(all, /Transaksi\s+=\s+12 struk/);
    assert.match(all, /Barang\s+=\s+40 biji/);
    assert.match(all, /Pembatalan\s+=\s+1 nota/);
    assert.match(all, /Dikembalikan=\s+7\.000/);
    assert.match(all, /Total omset\s+=\s+910\.000/);
    assert.match(all, /Tunai\s+=\s+910\.000/);
    assert.match(all, /Catatan: Ada uang palsu 50rb/);
    assert.doesNotMatch(all, /mother base|CETAK ULANG/i);
  }
  const plain = rowsToText(buildShiftRows({ ...recap, voids: { count: 0, total: 0 }, notes: '' }, settings, { reprint: true, now }), 32).join('\n');
  assert.doesNotMatch(plain, /Pembatalan|Catatan/);
  assert.match(plain, /CETAK ULANG/);
});

t('ukuran halaman cetak sesuai lebar kertas; tinggi diukur dari isi', () => {
  const p = receiptPage(['a', 'b'], '80');
  assert.strictEqual(p.widthMicrons, 80000);
  assert.ok(p.heightMicrons >= 40000);
  assert.strictEqual(p.measure, '.nota');
  assert.match(p.html, /<div class="nota"><div class="n-l">a<\/div><div class="n-l">b<\/div><\/div>/);
});

t('teks nota mulai di tepi kiri area cetak, ada jarak atas, bisa digeser manual', () => {
  const css = (o) => receiptFragment([], o.paper || '58', o).css;
  assert.match(css({}), /width: 48mm; margin: 0 0 0 0mm; padding: 5mm 0 12mm;/);
  assert.doesNotMatch(css({}), /margin:[^;]*auto/); // tidak di tengah kertas
  assert.match(css({ offsetMm: '3.5' }), /margin: 0 0 0 3\.5mm;/);
  assert.match(css({ offsetMm: 99 }), /margin: 0 0 0 10mm;/);
  assert.match(css({ paper: '80', offsetMm: -4 }), /width: 72mm; margin: 0 0 0 0mm;/);
});

t('font biasa (Segoe UI) dan ukuran huruf bisa diatur', () => {
  const size = (fontScale, paper = '58') => Number(/font-size: ([\d.]+)mm/.exec(receiptFragment([], paper, { fontScale }).css)[1]);
  assert.match(receiptFragment([], '58').css, /font-family: "Segoe UI"/);
  assert.strictEqual(size('100'), 2.75);
  assert.ok(size('90') < size('100') && size('100') < size('115') && size('115') < size('130'));
  assert.strictEqual(size('999'), 2.75); // nilai aneh → Normal
  assert.ok(size('100', '80') > size('100', '58'));
});

t('baris nota terstruktur: kiri–kanan, label = nilai, garis, nama toko lebih besar; teks aman', () => {
  const rows = buildReceiptRows({ ...receipt, lines: [{ name: 'Sabun <b>', qty: 1, unit_price: 1000, line_total: 1000 }] }, settings, { now });
  const html = receiptFragment(rows, '58').html;
  assert.match(html, /<div class="n-c n-big">KANO 5000 SEPANJANG<\/div>/);
  assert.match(html, /<div class="n-lr"><span>1\.000 x 1 =<\/span><span class="n-v">1\.000<\/span><\/div>/);
  assert.match(html, /<div class="n-kv"><span>Total<\/span><span>=<\/span><span class="n-v">48\.000<\/span><\/div>/);
  assert.match(html, /<div class="n-hr"><\/div>/);
  assert.match(html, /Sabun &lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

console.log(`\n${passed} tes nota lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
