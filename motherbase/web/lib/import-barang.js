/* Import master barang dari Excel (halaman Master Barang).
 * Dipakai aplikasi web (window.MbImportBarang) dan uji Node (require). Butuh SheetJS (XLSX).
 *
 * Format yang diterima:
 * - Template import barang Trizone: Barcode, SKU, Nama_Barang, Merk, Kategori, Harga_Jual, Satuan_Masuk,
 *   Rasio_Isi_Dus (kolom stok awal & min alert diabaikan), ditambah kolom kantor: Harga_Beli, Aktif.
 *   File hasil "Unduh master" memakai format ini. Kolom lain (mis. Principal) diabaikan.
 *   Satuan_Masuk: Coly atau Biji (Dus/Karton dibaca Coly, Pcs dibaca Biji; diterjemahkan di database).
 * - "Data item" program lama: Kode Item, Nama Item, Jenis, Harga Jual. Barang baru memakai Kode Item
 *   sebagai barcode bila tidak ada kolom Barcode (sama dengan Trizone).
 * Nama kolom tidak peka huruf besar/kecil, spasi, atau garis bawah. Baris judul di atas tabel dilewati.
 * Sel kosong = nilai lama dipertahankan.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('xlsx'));
  else root.MbImportBarang = factory(root.XLSX);
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const norm = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Field → nama kolom yang dikenali (sudah dinormalkan), urut prioritas
  const KOLOM = {
    sku: ['sku', 'kodeitem', 'kodebarang', 'kode', 'kodeproduk'],
    nama: ['namabarang', 'namaitem', 'nama', 'namaproduk'],
    barcode: ['barcode', 'kodebarcode'],
    merk: ['merk', 'merek', 'brand'],
    kategori: ['kategori', 'jenis', 'kategoribarang'],
    harga_jual: ['hargajual', 'hargajualkonsumen', 'hargaecer'],
    satuan_masuk: ['satuanmasuk'],
    rasio_isi: ['rasioisidus', 'rasioisi', 'isisatuanmasuk', 'isipersatuanmasuk'],
    harga_beli: ['hargabeli', 'hargapokok', 'hpp'],
    aktif: ['aktif'],
  };
  const TEKS = ['sku', 'nama', 'barcode', 'merk', 'kategori', 'satuan_masuk'];
  const ANGKA = { harga_jual: 'Harga jual', harga_beli: 'Harga beli', rasio_isi: 'Isi per satuan masuk' };

  const HEADER = ['Barcode', 'SKU', 'Nama_Barang', 'Merk', 'Kategori', 'Harga_Jual', 'Satuan_Masuk', 'Rasio_Isi_Dus',
    'Harga_Beli', 'Aktif'];

  function petaKolom(row) {
    const h = (row || []).map(norm);
    const peta = {};
    for (const [f, alias] of Object.entries(KOLOM)) {
      for (const a of alias) {
        const i = h.indexOf(a);
        if (i >= 0) { peta[f] = i; break; }
      }
    }
    return peta;
  }

  function teks(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    const s = String(v).trim();
    return s === '' ? null : s;
  }

  // "12.500" / "Rp 12.500" / "12.500,50" / "12500.5" / 12500 → angka. null bila kosong, NaN bila bukan angka.
  function angka(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    let s = String(v).replace(/rp\.?/i, '').replace(/\s+/g, '');
    if (s === '' || s === '-') return null;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  function benar(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    if (typeof v === 'boolean') return v;
    const s = norm(v);
    if (['ya', 'y', '1', 'aktif', 'true', 'yes'].includes(s)) return true;
    if (['tidak', 't', '0', 'nonaktif', 'tidakaktif', 'false', 'no', 'n'].includes(s)) return false;
    return undefined;
  }

  /** Baca workbook (ArrayBuffer / Buffer). Hasil: { lembar, format, kolom, baris, masalah, tanpaSku } */
  function bacaFile(buf) {
    const wb = XLSX.read(buf, { type: buf instanceof ArrayBuffer ? 'array' : 'buffer' });
    for (const nama of wb.SheetNames) {
      const ws = wb.Sheets[nama];
      if (!ws || !ws['!ref']) continue;
      const hasil = bacaLembar(ws);
      if (hasil) return { lembar: nama, ...hasil };
    }
    throw new Error('Kolom SKU (atau Kode Item) dan Nama_Barang tidak ditemukan. Pakai template import barang, file "Unduh master", atau file data item.');
  }

  function bacaLembar(ws) {
    const awal = XLSX.utils.decode_range(ws['!ref']).s.r;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    // Baris judul: dalam 20 baris pertama, punya kolom SKU dan (Nama atau Harga jual); paling banyak kolom dikenali
    let hi = -1;
    let peta = null;
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
      const p = petaKolom(aoa[i]);
      if (p.sku === undefined || (p.nama === undefined && p.harga_jual === undefined)) continue;
      if (!peta || Object.keys(p).length > Object.keys(peta).length) { hi = i; peta = p; }
    }
    if (!peta) return null;
    const dataItem = norm(aoa[hi][peta.sku]) === 'kodeitem' && peta.barcode === undefined;
    const baris = [];
    const masalah = [];
    const tanpaSku = [];
    for (let i = hi + 1; i < aoa.length; i++) {
      const row = aoa[i] || [];
      const no = awal + i + 1; // nomor baris di Excel
      const ambil = (f) => (peta[f] === undefined ? null : row[peta[f]]);
      if (!Object.values(peta).some((c) => teks(row[c]) !== null)) continue;
      const r = { baris: no };
      for (const f of TEKS) r[f] = teks(ambil(f));
      if (!r.sku) { tanpaSku.push(no); continue; }
      for (const [f, label] of Object.entries(ANGKA)) {
        const v = angka(ambil(f));
        if (Number.isNaN(v)) { masalah.push({ baris: no, pesan: `${label} "${ambil(f)}" bukan angka` }); r[f] = null; } else r[f] = v;
      }
      const a = benar(ambil('aktif'));
      if (a === undefined) { masalah.push({ baris: no, pesan: `Aktif "${ambil('aktif')}" harus Ya atau Tidak` }); r.aktif = null; } else r.aktif = a;
      r.barcode_baru = dataItem ? r.sku : null;
      baris.push(r);
    }
    const kolom = Object.keys(peta).map((f) => ({ field: f, judul: String(aoa[hi][peta[f]]).trim() }));
    return { format: dataItem ? 'data item' : 'template', kolom, baris, masalah, tanpaSku, barisJudul: awal + hi + 1 };
  }

  // Isi file untuk "Unduh master": SKU & barcode sebagai teks supaya Excel tidak mengubahnya.
  function barisMaster(produk, hargaBeli) {
    return produk.map((p) => ({
      Barcode: p.barcode || '', SKU: p.sku, Nama_Barang: p.nama, Merk: p.merk || '', Kategori: p.kategori || '',
      Harga_Jual: p.harga_jual_konsumen === null || p.harga_jual_konsumen === undefined ? '' : Number(p.harga_jual_konsumen),
      Satuan_Masuk: p.satuan_masuk, Rasio_Isi_Dus: p.rasio_isi,
      Harga_Beli: hargaBeli[p.sku] === null || hargaBeli[p.sku] === undefined ? '' : Number(hargaBeli[p.sku]),
      Aktif: p.aktif ? 'Ya' : 'Tidak',
    }));
  }

  const CONTOH = [
    { Barcode: '8991234567890', SKU: 'MNM-001', Nama_Barang: 'Air Mineral 600ml', Merk: 'Segar', Kategori: 'Minuman', Harga_Jual: 3500,
      Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 24, Harga_Beli: 2400, Aktif: 'Ya' },
    { Barcode: '8997654321098', SKU: 'SNK-010', Nama_Barang: 'Keripik Kentang 68g', Merk: 'Renyah', Kategori: 'Makanan Ringan', Harga_Jual: 11500,
      Satuan_Masuk: 'Coly', Rasio_Isi_Dus: 40, Harga_Beli: 8900, Aktif: 'Ya' },
  ];

  function workbook(rows) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, { header: HEADER });
    ws['!cols'] = HEADER.map((h) => ({ wch: Math.max(h.length + 2, h === 'Nama_Barang' ? 32 : 12) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Barang');
    return wb;
  }

  return { bacaFile, barisMaster, workbook, CONTOH, HEADER, angka, _petaKolom: petaKolom };
}));
