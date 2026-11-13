/* global module */
// Angka → kata Bahasa Indonesia untuk dibacakan suara kasir: 3500 → "tiga ribu lima ratus".
// Dimuat sebagai skrip biasa di layar POS (fungsi global terbilang) dan bisa di-require dari tes Node.
(function (root) {
  'use strict';
  const SATUAN = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];

  function words(n) {
    if (n < 12) return SATUAN[n];
    if (n < 20) return `${SATUAN[n - 10]} belas`;
    if (n < 100) return `${SATUAN[Math.floor(n / 10)]} puluh ${words(n % 10)}`.trim();
    if (n < 200) return `seratus ${words(n - 100)}`.trim();
    if (n < 1000) return `${SATUAN[Math.floor(n / 100)]} ratus ${words(n % 100)}`.trim();
    if (n < 2000) return `seribu ${words(n - 1000)}`.trim();
    if (n < 1e6) return `${words(Math.floor(n / 1000))} ribu ${words(n % 1000)}`.trim();
    if (n < 1e9) return `${words(Math.floor(n / 1e6))} juta ${words(n % 1e6)}`.trim();
    if (n < 1e12) return `${words(Math.floor(n / 1e9))} miliar ${words(n % 1e9)}`.trim();
    return `${words(Math.floor(n / 1e12))} triliun ${words(n % 1e12)}`.trim();
  }

  function terbilang(value) {
    const n = Math.round(Number(value) || 0);
    if (n === 0) return 'nol';
    return (n < 0 ? 'minus ' : '') + words(Math.abs(n));
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { terbilang };
  else root.terbilang = terbilang;
}(this));
