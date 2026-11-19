/* Stok opname dari kantor: baca template opname Trizone di browser (halaman Stok & Opname).
 * Dipakai aplikasi web (window.MbOpnameKantor) dan uji Node (require). Butuh SheetJS (XLSX).
 *
 * Template sama dengan tombol Unduh Template di Stok Opname Trizone:
 *   Kode, Nama_Barang, Display Toko, Fisik Display Toko, Gudang Utama, Fisik Gudang Utama,
 *   Gudang BS, Fisik Gudang BS, Gudang Shopee, Fisik Gudang Shopee, Tanggal_Stok
 * - Kode = SKU atau barcode. Kolom Fisik yang kosong = zona itu tidak dihitung untuk barang tersebut.
 * - Ada kolom Tanggal_Stok → kolom stok zona di file menjadi stok patokan per Tanggal_Stok
 *   (di toko hanya selisih fisik − patokan yang ditambahkan ke stok saat diterapkan).
 *   Tanpa kolom Tanggal_Stok → stok zona di toko di-set ke angka fisik saat diterapkan.
 * Nama kolom tidak peka huruf besar/kecil, spasi, atau garis bawah. Baris judul di atas tabel dilewati.
 * Hasil: baris untuk RPC buat_opname_kantor (satu baris per barang per zona yang Fisik-nya terisi).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('xlsx'));
  else root.MbOpnameKantor = factory(root.XLSX);
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const norm = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const HEADER = ['Kode', 'Nama_Barang', 'Display Toko', 'Fisik Display Toko', 'Gudang Utama', 'Fisik Gudang Utama',
    'Gudang BS', 'Fisik Gudang BS', 'Gudang Shopee', 'Fisik Gudang Shopee', 'Tanggal_Stok'];
  const ZONA = ['floor', 'warehouse', 'damaged', 'shopee'];
  const LABEL = { floor: 'Display Toko', warehouse: 'Gudang Utama', damaged: 'Gudang BS', shopee: 'Gudang Shopee' };
  const FISIK = { floor: 'fisikdisplaytoko', warehouse: 'fisikgudangutama', damaged: 'fisikgudangbs', shopee: 'fisikgudangshopee' };
  const STOK = { floor: 'displaytoko', warehouse: 'gudangutama', damaged: 'gudangbs', shopee: 'gudangshopee' };
  const p2 = (n) => String(n).padStart(2, '0');

  const kosong = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

  // Kode dari Excel bisa terbaca sebagai angka (barcode)
  function teksKode(v) {
    if (kosong(v)) return null;
    if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
    return String(v).trim();
  }

  // 12 / "12" / "1.250" (ribuan) / "-3" → angka; null bila kosong; NaN bila bukan angka
  function angka(v) {
    if (kosong(v)) return null;
    if (typeof v === 'number') return v;
    let s = String(v).trim().replace(/\s/g, '');
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    else s = s.replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  // Tanggal_Stok: teks "YYYY-MM-DD[ HH:MM[:SS]]" atau angka seri tanggal Excel → "YYYY-MM-DD HH:MM:SS" (jam toko, WIB)
  function tanggal(v) {
    if (typeof v === 'number' && v > 0) {
      const d = new Date(Math.round((v - 25569) * 86400) * 1000);
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
    }
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const [, y, mo, da, h = 0, mi = 0, s = 0] = m;
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || s > 59) return null;
    return `${y}-${p2(mo)}-${p2(da)} ${p2(h)}:${p2(mi)}:${p2(s)}`;
  }

  // Baris judul: baris pertama (dari 20 teratas) yang punya kolom Kode dan minimal satu kolom Fisik
  function cariJudul(aoa) {
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
      const h = (aoa[i] || []).map(norm);
      if (h.includes('kode') && ZONA.some((z) => h.includes(FISIK[z]))) return i;
    }
    return -1;
  }

  // ArrayBuffer / Buffer file Excel atau CSV → { baris, bertanggal, lembar, barisJudul, jumlahBarang }
  //   baris: [{ baris, zona, kode, fisik, stok_patokan, tanggal_stok }]  (baris = nomor baris di Excel)
  // Isian yang tidak terbaca dikirim apa adanya (teks); buat_opname_kantor melaporkannya per baris.
  function bacaFile(data) {
    const wb = XLSX.read(data, { type: data instanceof ArrayBuffer ? 'array' : 'buffer' });
    let lembar = null;
    let aoa = null;
    let judul = -1;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      const j = cariJudul(rows);
      if (j >= 0) { lembar = name; aoa = rows; judul = j; break; }
    }
    if (judul < 0) {
      throw new Error('Kolom "Kode" dan "Fisik Display Toko / Fisik Gudang Utama / Fisik Gudang BS / Fisik Gudang Shopee" tidak ditemukan. Gunakan template opname Trizone.');
    }
    const h = aoa[judul].map(norm);
    const col = (n) => h.indexOf(n);
    const iKode = col('kode');
    const iTgl = col('tanggalstok');
    const bertanggal = iTgl >= 0;
    const baris = [];
    let jumlahBarang = 0;
    const nilai = (v) => { const n = angka(v); return Number.isNaN(n) ? String(v).trim() : n; };
    for (let r = judul + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const isi = ZONA.filter((z) => col(FISIK[z]) >= 0 && !kosong(row[col(FISIK[z])]));
      if (!isi.length) continue;
      jumlahBarang++;
      const tgl = bertanggal ? tanggal(row[iTgl]) || (kosong(row[iTgl]) ? null : String(row[iTgl]).trim()) : null;
      for (const z of isi) {
        // Ada Tanggal_Stok → stok zona di file = stok patokan (wajib; diperiksa database)
        const iStok = col(STOK[z]);
        baris.push({
          baris: r + 1, zona: z, kode: teksKode(row[iKode]), fisik: nilai(row[col(FISIK[z])]),
          stok_patokan: bertanggal && iStok >= 0 ? nilai(row[iStok]) : null,
          tanggal_stok: tgl,
        });
      }
    }
    return { baris, bertanggal, lembar, barisJudul: judul + 1, jumlahBarang };
  }

  // Template untuk satu toko dari stok terakhir yang dikirim toko (stok_toko + produk_toko).
  // Tanggal_Stok = waktu stok itu (jam WIB), jadi selisih di toko dihitung terhadap stok saat itu.
  function barisTemplate(stok) {
    const wib = (s) => {
      if (!s) return '';
      const d = new Date(new Date(s).getTime() + 7 * 3600e3);
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    };
    return stok.map((s) => [s.sku, s.nama || '', Number(s.display) || 0, '', Number(s.gudang) || 0, '', Number(s.bs) || 0, '',
      Number(s.shopee) || 0, '', wib(s.per_waktu)]);
  }

  function workbook(aoa) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([HEADER, ...aoa]);
    // Kode sebagai teks supaya barcode panjang tidak berubah jadi angka di Excel
    for (let r = 1; r <= aoa.length; r++) {
      const c = ws[XLSX.utils.encode_cell({ r, c: 0 })];
      if (c) { c.t = 's'; c.v = String(c.v); }
    }
    ws['!cols'] = HEADER.map((x) => ({ wch: x === 'Nama_Barang' ? 32 : Math.max(x.length + 2, 12) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Opname');
    return wb;
  }

  return { bacaFile, barisTemplate, workbook, HEADER, ZONA, LABEL, angka, tanggal };
}));
