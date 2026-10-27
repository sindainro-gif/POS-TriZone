'use strict';
// Uji formatter nota thermal: node test/receipt.test.js
const assert = require('assert');
const { buildReceiptLines, receiptPage } = require('../src/receipt');

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
  assert.strictEqual(lines[lines.length - 1], 'JAM CETAK : 15/10/2026 14:53:30');
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

t('ukuran halaman cetak sesuai lebar kertas', () => {
  const p = receiptPage(['a', 'b'], '80');
  assert.strictEqual(p.widthMicrons, 80000);
  assert.ok(p.heightMicrons >= 40000);
  assert.match(p.html, /<pre>a\nb/);
});

console.log(`\n${passed} tes nota lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
