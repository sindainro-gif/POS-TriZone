'use strict';
// Uji angka → kata untuk suara kasir: node test/terbilang.test.js
const assert = require('assert');
const { terbilang } = require('../src/renderer/terbilang');

const cases = [
  [0, 'nol'],
  [7, 'tujuh'],
  [10, 'sepuluh'],
  [11, 'sebelas'],
  [12, 'dua belas'],
  [19, 'sembilan belas'],
  [21, 'dua puluh satu'],
  [100, 'seratus'],
  [115, 'seratus lima belas'],
  [1000, 'seribu'],
  [1500, 'seribu lima ratus'],
  [3500, 'tiga ribu lima ratus'],
  [11500, 'sebelas ribu lima ratus'],
  [42000, 'empat puluh dua ribu'],
  [115000, 'seratus lima belas ribu'],
  [1000000, 'satu juta'],
  [2501000, 'dua juta lima ratus satu ribu'],
  [1250000000, 'satu miliar dua ratus lima puluh juta'],
  [-2500, 'minus dua ribu lima ratus'],
  ['3500', 'tiga ribu lima ratus'],
];

let passed = 0;
for (const [n, want] of cases) {
  try {
    assert.strictEqual(terbilang(n), want);
    passed++;
  } catch (e) {
    console.error('  ✗', n, '→', terbilang(n), '(seharusnya', want + ')');
    process.exitCode = 1;
  }
}
console.log(`${passed} tes terbilang lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
