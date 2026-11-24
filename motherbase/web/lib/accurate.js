/* Pembaca laporan Accurate "Rincian Pengiriman Pesanan" (ekspor Excel).
 * Dipakai bersama oleh aplikasi web (window.MbAccurate) dan alat baris perintah
 * motherbase/accurate/accurate-do.js (require). Butuh SheetJS (XLSX).
 *
 * Laporan ini berbentuk cetakan: satu blok per nomor DO (Nomor #, Tanggal, Pelanggan,
 * tabel Kode # / Nama Barang / Kuantitas / Satuan, baris total), diselingi kepala dan
 * kaki halaman. Posisi kolom dicari dari label, bukan dari huruf kolom, supaya tahan
 * bila tata letak Accurate sedikit bergeser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('xlsx'));
  else root.MbAccurate = factory(root.XLSX);
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const norm = (v) => String(v ?? '').trim();
  const lower = (v) => norm(v).toLowerCase();
  const KAKI = /^(accurate accounting system report|tercetak pada|halaman\b)/i;

  // Nilai setelah label (melewati sel kosong dan ':') pada baris yang sama.
  function nilaiSetelah(row, idx) {
    for (let j = idx + 1; j < row.length; j++) {
      const v = row[j];
      if (v === null || v === undefined || norm(v) === '' || norm(v) === ':') continue;
      return v;
    }
    return null;
  }

  function keTanggal(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
      const d = XLSX.SSF.parse_date_code(v);
      if (!d) return null;
      return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    const s = norm(v);
    const BULAN = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
    let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})$/i.exec(s);
    if (m && BULAN[m[2].toLowerCase()]) return `${m[3]}-${String(BULAN[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }

  function keAngka(v) {
    if (typeof v === 'number') return v;
    const s = norm(v);
    if (!s) return null;
    // 1.234,5 (Indonesia) atau 1,234.5 (Inggris)
    const t = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * rows: array 2D (baris → sel) dari sheet, nilai mentah (tanggal sebagai nomor seri Excel).
   * Hasil: { perusahaan, periode, do: [{no, tanggal, pelanggan, items: [{kode, nama, qty, satuan}], total}], masalah: [] }
   */
  function bacaRincianPengiriman(rows) {
    const out = { perusahaan: null, periode: null, do: [], masalah: [] };
    let cur = null;            // DO yang sedang dibaca
    let kol = null;            // indeks kolom tabel barang
    let selesai = true;        // baris total DO sudah lewat

    const tutup = (baris) => {
      if (!cur) return;
      const jumlah = cur.items.reduce((s, i) => s + i.qty, 0);
      if (cur.total !== null && Math.abs(cur.total - jumlah) > 1e-9) {
        out.masalah.push(`${cur.no}: total ${cur.total} tidak sama dengan jumlah baris ${jumlah} (baris ${baris}).`);
      }
      if (!cur.items.length) out.masalah.push(`${cur.no}: tidak ada barang.`);
    };

    rows.forEach((raw, i) => {
      const row = Array.isArray(raw) ? raw : [];
      const baris = i + 1;
      const sel = row.map(norm);
      const isi = sel.filter(Boolean);
      if (!isi.length) return;

      if (!out.perusahaan && isi.length === 1 && /^(pt|cv|ud)\b/i.test(isi[0])) { out.perusahaan = isi[0]; return; }
      if (isi.length === 1 && /^dari\s+.+\s+s\/d\s+/i.test(isi[0])) { out.periode = out.periode || isi[0]; return; }
      if (isi.length <= 2 && (KAKI.test(isi[0]) || /^cabang\s*:/i.test(isi[0]) || /^rincian pengiriman pesanan$/i.test(isi[0])
          || (out.perusahaan && isi[0] === out.perusahaan))) return;

      const iNomor = sel.findIndex((v) => /^nomor\s*#?$/i.test(v));
      if (iNomor >= 0) {
        const no = norm(nilaiSetelah(row, iNomor));
        const iPel = sel.findIndex((v) => /^pelanggan$/i.test(v));
        const pelanggan = iPel >= 0 ? norm(nilaiSetelah(row, iPel)) : '';
        if (cur && cur.no === no && !selesai) return;   // DO yang sama berlanjut ke halaman berikutnya
        tutup(baris);
        cur = { no, tanggal: null, pelanggan, items: [], total: null };
        out.do.push(cur);
        kol = null;
        selesai = false;
        if (!no) out.masalah.push(`Baris ${baris}: nomor DO kosong.`);
        if (!pelanggan) out.masalah.push(`Baris ${baris}: pelanggan kosong untuk ${no}.`);
        return;
      }
      const iTgl = sel.findIndex((v) => /^tanggal$/i.test(v));
      if (iTgl >= 0 && cur && !kol) {
        cur.tanggal = keTanggal(nilaiSetelah(row, iTgl));
        if (!cur.tanggal) out.masalah.push(`${cur.no}: tanggal tidak terbaca (baris ${baris}).`);
        return;
      }
      const iKode = sel.findIndex((v) => /^kode\s*#?$/i.test(v));
      if (iKode >= 0 && sel.some((v) => /^kuantitas$/i.test(v))) {
        kol = {
          kode: iKode,
          nama: sel.findIndex((v) => /^nama barang$/i.test(v)),
          qty: sel.findIndex((v) => /^kuantitas$/i.test(v)),
          satuan: sel.findIndex((v) => /^satuan$/i.test(v)),
        };
        return;
      }
      if (!cur || !kol || selesai) {
        out.masalah.push(`Baris ${baris} tidak dikenali: ${isi.join(' | ')}`);
        return;
      }
      const kode = sel[kol.kode];
      const qty = keAngka(row[kol.qty]);
      if (!kode && qty !== null) {        // baris total DO
        cur.total = qty;
        selesai = true;
        tutup(baris);
        return;
      }
      if (kode && qty !== null) {
        cur.items.push({ kode, nama: kol.nama >= 0 ? sel[kol.nama] : '', qty, satuan: kol.satuan >= 0 ? sel[kol.satuan] : '' });
        if (!(qty > 0)) out.masalah.push(`${cur.no} ${kode}: kuantitas ${qty} tidak valid.`);
        if (kol.satuan >= 0 && !sel[kol.satuan]) out.masalah.push(`${cur.no} ${kode}: satuan kosong.`);
        return;
      }
      out.masalah.push(`Baris ${baris} tidak dikenali: ${isi.join(' | ')}`);
    });
    if (cur && !selesai) { out.masalah.push(`${cur.no}: baris total tidak ditemukan.`); tutup(rows.length); }

    const ganda = out.do.map((d) => d.no).filter((n, i, a) => a.indexOf(n) !== i);
    if (ganda.length) out.masalah.push(`Nomor DO muncul lebih dari sekali: ${[...new Set(ganda)].join(', ')}`);
    return out;
  }

  /**
   * Laporan Accurate "Rincian Retur Penjualan" (retur barang dari toko ke kantor, ekspor Excel).
   * Bentuknya tabel per baris barang: Nomor # | Kode # | Nama Barang | Kuantitas | @Harga | Total Harga |
   * Pelanggan | Keterangan Retur Penjualan. Tidak ada tanggal per dokumen; periode laporan dari kepala
   * "Dari 01 Nov 2026 s/d 24 Nov 2026". Baris satu dokumen boleh terpisah-pisah. Kuantitas dalam Biji.
   * Hasil: { perusahaan, dari, sampai, dokumen: [{ no, pelanggan, items: [{ kode, nama, qty, harga, keterangan }] }],
   *          baris, masalah: [] }
   */
  function bacaRincianRetur(rows) {
    const out = { perusahaan: null, dari: null, sampai: null, dokumen: [], baris: 0, masalah: [] };
    const peta = new Map();
    let judul = false;
    let kol = null;
    rows.forEach((raw, i) => {
      const row = Array.isArray(raw) ? raw : [];
      const baris = i + 1;
      const sel = row.map(norm);
      const isi = sel.filter(Boolean);
      if (!isi.length) return;
      if (isi.length === 1 && /^rincian retur penjualan$/i.test(isi[0])) { judul = true; return; }
      const periode = isi.length === 1 && /^dari\s+(.+?)\s+s\/d\s+(.+)$/i.exec(isi[0]);
      if (periode) {
        out.dari = out.dari || keTanggal(periode[1]);
        out.sampai = out.sampai || keTanggal(periode[2]);
        if (!out.dari || !out.sampai) out.masalah.push(`Periode laporan tidak terbaca: ${isi[0]}`);
        return;
      }
      if (isi.length <= 2 && (KAKI.test(isi[0]) || /^cabang\s*:/i.test(isi[0]))) return;
      if (!judul && !kol && isi.length === 1) { out.perusahaan = out.perusahaan || isi[0]; return; }
      if (sel.some((v) => /^nomor\s*#?$/i.test(v)) && sel.some((v) => /^kuantitas$/i.test(v))) {
        kol = {
          no: sel.findIndex((v) => /^nomor\s*#?$/i.test(v)),
          kode: sel.findIndex((v) => /^kode\s*#?$/i.test(v)),
          nama: sel.findIndex((v) => /^nama barang$/i.test(v)),
          qty: sel.findIndex((v) => /^kuantitas$/i.test(v)),
          harga: sel.findIndex((v) => /^@\s*harga$/i.test(v)),
          pelanggan: sel.findIndex((v) => /^pelanggan$/i.test(v)),
          keterangan: sel.findIndex((v) => /^keterangan/i.test(v)),
        };
        if (kol.kode < 0 || kol.pelanggan < 0) { out.masalah.push(`Baris ${baris}: kolom Kode # atau Pelanggan tidak ditemukan.`); kol = null; }
        return;
      }
      if (!kol) { if (judul) out.masalah.push(`Baris ${baris} tidak dikenali: ${isi.join(' | ')}`); return; }
      const no = sel[kol.no];
      const kode = sel[kol.kode];
      const qty = keAngka(row[kol.qty]);
      if (!no && !kode) return; // baris jumlah / kosong
      if (!no || !kode || qty === null) { out.masalah.push(`Baris ${baris} tidak lengkap: ${isi.join(' | ')}`); return; }
      if (!(qty > 0)) out.masalah.push(`${no} ${kode}: kuantitas ${qty} tidak valid.`);
      const pelanggan = sel[kol.pelanggan];
      let d = peta.get(no);
      if (!d) { d = { no, pelanggan, items: [] }; peta.set(no, d); out.dokumen.push(d); }
      else if (pelanggan && d.pelanggan !== pelanggan) out.masalah.push(`${no}: pelanggan berbeda (${d.pelanggan} / ${pelanggan}).`);
      if (!pelanggan) out.masalah.push(`${no}: pelanggan kosong (baris ${baris}).`);
      d.items.push({ kode, nama: kol.nama >= 0 ? sel[kol.nama] : '', qty, harga: kol.harga >= 0 ? keAngka(row[kol.harga]) : null,
        keterangan: kol.keterangan >= 0 ? sel[kol.keterangan] : '' });
      out.baris++;
    });
    if (!judul) out.masalah.unshift('Bukan laporan "Rincian Retur Penjualan" Accurate.');
    else if (!out.baris) out.masalah.push('Tidak ada baris retur di file ini.');
    if (judul && (!out.dari || !out.sampai)) out.masalah.push('Periode laporan ("Dari … s/d …") tidak ditemukan.');
    return out;
  }

  function bacaFileRetur(buf) {
    const wb = XLSX.read(buf, { type: buf instanceof ArrayBuffer ? 'array' : 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return bacaRincianRetur(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true }));
  }

  function payloadRetur(hasil, file) {
    return { file, dari: hasil.dari, sampai: hasil.sampai, dokumen: hasil.dokumen };
  }

  // buf: Buffer (Node) atau ArrayBuffer / Uint8Array (browser)
  function bacaFile(buf) {
    const wb = XLSX.read(buf, { type: buf instanceof ArrayBuffer ? 'array' : 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    return bacaRincianPengiriman(rows);
  }

  // Satuan Accurate → kolom Satuan di import penerimaan Trizone.
  // Pcs/Biji → Biji. Satuan kemasan (Coly, Dus, ...) → Dus, artinya dikali Rasio Isi
  // satuan masuk barang itu di Trizone. Rasio di Trizone harus sama dengan isi satuan di Accurate.
  function satuanTrizone(s) {
    return ['pcs', 'pc', 'biji'].includes(lower(s)) ? 'Biji' : 'Dus';
  }

  // Baris file Import Penerimaan Trizone (kolom = RECEPTION_TEMPLATE_HEADERS di src/services.js).
  function barisImportTrizone(hasil, { supplier, tujuan = 'Gudang Utama' } = {}) {
    const pt = supplier || hasil.perusahaan || 'PT Kantor';
    const rows = [];
    for (const d of hasil.do) {
      for (const it of d.items) {
        rows.push({
          No_Surat_Jalan: d.no,
          Supplier: pt,
          Catatan: `Accurate ${d.tanggal || ''}`.trim(),
          Kode: it.kode,
          Nama_Barang: it.nama,
          Jumlah: it.qty,
          Satuan: satuanTrizone(it.satuan),
          Tujuan: tujuan,
        });
      }
    }
    return rows;
  }

  function payloadMotherBase(hasil, file) {
    return { file, do: hasil.do.map(({ no, tanggal, pelanggan, items }) => ({ no, tanggal, pelanggan, items })) };
  }

  return { bacaRincianPengiriman, bacaFile, barisImportTrizone, payloadMotherBase, satuanTrizone, keTanggal, bacaRincianRetur, bacaFileRetur, payloadRetur };
}));
