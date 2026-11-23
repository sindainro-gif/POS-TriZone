/* Stock opname dari kantor (halaman Stock Opname → Opname dari kantor).
 * Dipakai aplikasi web (window.MbOpnameKantor) dan uji Node (require). Butuh SheetJS (XLSX).
 *
 * Template sama dengan template opname Trizone, ditambah kolom Toko:
 *   Kode, Nama_Barang, Display Toko, Fisik Display Toko, Gudang Utama, Fisik Gudang Utama, Gudang BS, Fisik Gudang BS,
 *   Gudang Shopee, Fisik Gudang Shopee, Tanggal_Stok, Toko
 * Kolom stok = patokan (stok toko per Tanggal_Stok, dari kiriman terakhir). Isi kolom Fisik zona yang dihitung;
 * Fisik kosong = barang itu tidak dihitung di zona tersebut. Di toko, hanya selisih Fisik − patokan yang
 * ditambahkan ke stok sekarang, jadi penjualan setelah Tanggal_Stok tetap terhitung.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('xlsx'));
  else root.MbOpnameKantor = factory(root.XLSX);
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const ZONA = [
    { id: 'floor', label: 'Display Toko', stok: 'display' },
    { id: 'warehouse', label: 'Gudang Utama', stok: 'gudang' },
    { id: 'damaged', label: 'Gudang BS', stok: 'bs' },
    { id: 'shopee', label: 'Gudang Shopee', stok: 'shopee' },
  ];
  const HEADER = ['Kode', 'Nama_Barang', ...ZONA.flatMap((z) => [z.label, `Fisik ${z.label}`]), 'Tanggal_Stok', 'Toko'];
  const norm = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const p2 = (n) => String(n).padStart(2, '0');

  // Waktu (ISO / timestamptz) → "YYYY-MM-DD HH:MM:SS" jam WIB, sama dengan Tanggal_Stok di Trizone
  function teksWib(t) {
    const d = new Date(new Date(t).getTime() + 7 * 3600e3);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19).replace('T', ' ');
  }

  // Tanggal_Stok dari sel: teks "YYYY-MM-DD HH:MM[:SS]" atau tanggal Excel (bila file disimpan ulang Excel)
  function bacaTanggal(v) {
    if (typeof v === 'number' && v > 0) {
      const d = new Date(Math.round((v - 25569) * 86400) * 1000);
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
    }
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const [, y, mo, da, h, mi, s = 0] = m;
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || s > 59) return null;
    return `${y}-${p2(mo)}-${p2(da)} ${p2(h)}:${p2(mi)}:${p2(s)}`;
  }

  // "12" / "1.250" / "-3" / 12 → bilangan bulat. null bila kosong, NaN bila bukan bilangan bulat.
  function bulat(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    let s = String(v).replace(/\s+/g, '');
    if (s === '') return null;
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    return /^-?\d+$/.test(s) ? Number(s) : NaN;
  }

  // Baris template dari stok toko: [{ sku, nama, display, gudang, bs, shopee }], stokPer = waktu stok (ISO)
  function barisTemplate(stok, stokPer, kodeToko) {
    const tgl = teksWib(stokPer);
    return stok.map((r) => {
      const o = { Kode: String(r.sku), Nama_Barang: r.nama || '' };
      for (const z of ZONA) { o[z.label] = Number(r[z.stok]) || 0; o[`Fisik ${z.label}`] = ''; }
      o.Tanggal_Stok = tgl;
      o.Toko = kodeToko;
      return o;
    });
  }

  function workbook(rows) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, { header: HEADER });
    ws['!cols'] = HEADER.map((h) => ({ wch: h === 'Nama_Barang' ? 34 : h === 'Tanggal_Stok' ? 20 : Math.max(h.length + 2, 10) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Opname');
    return wb;
  }

  // Hasil hitung → { zona: { floor: [{ sku, patokan, fisik, baris }] }, stokPer: { floor: '…' }, toko, masalah, jumlahBaris }
  function bacaFile(buf) {
    const wb = XLSX.read(buf, { type: buf instanceof ArrayBuffer ? 'array' : 'buffer' });
    for (const nama of wb.SheetNames) {
      const ws = wb.Sheets[nama];
      if (!ws || !ws['!ref']) continue;
      const hasil = bacaLembar(ws);
      if (hasil) return hasil;
    }
    throw new Error('Kolom "Kode" dan "Fisik Display Toko / Fisik Gudang Utama / Fisik Gudang BS / Fisik Gudang Shopee" tidak ditemukan. Pakai template dari tombol Unduh template.');
  }

  function bacaLembar(ws) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    let hi = -1;
    let kol = null;
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
      const h = (aoa[i] || []).map(norm);
      const k = { kode: h.indexOf('kode'), tanggal: h.indexOf('tanggalstok'), toko: h.indexOf('toko'), zona: {} };
      for (const z of ZONA) k.zona[z.id] = { stok: h.indexOf(norm(z.label)), fisik: h.indexOf(norm(`Fisik ${z.label}`)) };
      if (k.kode >= 0 && ZONA.some((z) => k.zona[z.id].fisik >= 0)) { hi = i; kol = k; break; }
    }
    if (!kol) return null;
    if (kol.tanggal < 0) throw new Error('Kolom Tanggal_Stok tidak ada. Pakai template dari tombol Unduh template (stok patokan per waktu kiriman toko).');
    const masalah = [];
    const zona = {};
    const stokPer = {};
    const toko = new Set();
    let jumlahBaris = 0;
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const isi = ZONA.filter((z) => kol.zona[z.id].fisik >= 0 && r[kol.zona[z.id].fisik] !== null && String(r[kol.zona[z.id].fisik]).trim() !== '');
      if (!isi.length) continue;
      const no = i + 1;
      const kode = r[kol.kode] === null ? '' : String(r[kol.kode]).trim();
      if (!kode) { masalah.push(`Baris ${no}: Kode wajib diisi.`); continue; }
      const tgl = bacaTanggal(r[kol.tanggal]);
      if (!tgl) { masalah.push(`Baris ${no} (${kode}): Tanggal_Stok "${r[kol.tanggal] ?? ''}" tidak terbaca.`); continue; }
      if (kol.toko >= 0 && r[kol.toko] !== null && String(r[kol.toko]).trim()) toko.add(String(r[kol.toko]).trim().toUpperCase());
      jumlahBaris++;
      for (const z of isi) {
        const fisik = bulat(r[kol.zona[z.id].fisik]);
        const patokan = kol.zona[z.id].stok >= 0 ? bulat(r[kol.zona[z.id].stok]) : null;
        if (Number.isNaN(fisik)) { masalah.push(`Baris ${no} (${kode}): Fisik ${z.label} harus bilangan bulat.`); continue; }
        if (patokan === null || Number.isNaN(patokan)) { masalah.push(`Baris ${no} (${kode}): stok ${z.label} di file kosong atau bukan angka.`); continue; }
        const list = zona[z.id] || (zona[z.id] = []);
        const sama = list.find((x) => x.sku === kode);
        if (sama) sama.fisik += fisik; // barang yang sama dihitung di beberapa rak
        else list.push({ sku: kode, patokan, fisik, baris: no });
        if (!stokPer[z.id] || tgl < stokPer[z.id]) stokPer[z.id] = tgl;
      }
    }
    if (toko.size > 1) masalah.unshift(`File berisi lebih dari satu toko (${[...toko].join(', ')}).`);
    return { zona, stokPer, toko: toko.size === 1 ? [...toko][0] : null, masalah, jumlahBaris };
  }

  return { ZONA, HEADER, barisTemplate, workbook, bacaFile, teksWib, bacaTanggal, bulat };
}));
