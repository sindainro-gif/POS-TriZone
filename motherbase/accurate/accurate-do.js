'use strict';
// Pembaca laporan Accurate "Rincian Pengiriman Pesanan" (ekspor Excel).
//
// Laporan ini berbentuk cetakan: satu blok per nomor DO (Nomor #, Tanggal, Pelanggan,
// tabel Kode # / Nama Barang / Kuantitas / Satuan, baris total), diselingi kepala dan
// kaki halaman. Posisi kolom dicari dari label, bukan dari huruf kolom, supaya tahan
// bila tata letak Accurate sedikit bergeser.
//
// Pemakaian (dari folder repo, setelah `npm install`):
//   node motherbase/accurate/accurate-do.js <file.xlsx> [--out <folder>] [--kirim]
//
// Hasil:
//   surat_jalan.json                payload untuk RPC import_surat_jalan (mother base)
//   Penerimaan_<pelanggan>.xlsx     file Import Penerimaan untuk Trizone, satu per pelanggan
// --kirim  langsung memanggil import_surat_jalan di Supabase
//          (butuh env SUPABASE_URL dan SUPABASE_KEY).

const XLSX = require('xlsx');

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

function bacaFile(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
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

function namaAman(s) { return norm(s).replace(/[^0-9a-z]+/gi, '_').replace(/^_|_$/g, '') || 'tanpa_nama'; }

async function main(argv) {
  const fs = require('fs');
  const path = require('path');
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Pakai: node motherbase/accurate/accurate-do.js <file.xlsx> [--out <folder>] [--kirim]');
    process.exit(2);
  }
  const iOut = args.indexOf('--out');
  const outDir = iOut >= 0 ? args[iOut + 1] : path.join(path.dirname(file), 'hasil-accurate');
  const hasil = bacaFile(fs.readFileSync(file));
  fs.mkdirSync(outDir, { recursive: true });

  const payload = payloadMotherBase(hasil, path.basename(file));
  fs.writeFileSync(path.join(outDir, 'surat_jalan.json'), JSON.stringify(payload, null, 2));

  const perPelanggan = new Map();
  for (const d of hasil.do) {
    if (!perPelanggan.has(d.pelanggan)) perPelanggan.set(d.pelanggan, []);
    perPelanggan.get(d.pelanggan).push(d);
  }
  for (const [pel, dos] of perPelanggan) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(barisImportTrizone({ ...hasil, do: dos })), 'Penerimaan');
    XLSX.writeFile(wb, path.join(outDir, `Penerimaan_${namaAman(pel)}.xlsx`));
  }

  const nBarang = hasil.do.reduce((s, d) => s + d.items.length, 0);
  console.log(`${hasil.perusahaan || '(perusahaan?)'} · ${hasil.periode || ''}`);
  console.log(`${hasil.do.length} DO, ${nBarang} baris barang, ${perPelanggan.size} pelanggan → ${outDir}`);
  for (const [pel, dos] of perPelanggan) console.log(`  ${pel}: ${dos.length} DO`);
  if (hasil.masalah.length) {
    console.log(`\n${hasil.masalah.length} masalah:`);
    hasil.masalah.forEach((m) => console.log('  - ' + m));
    process.exitCode = 1;
  }

  if (args.includes('--kirim')) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('Isi env SUPABASE_URL dan SUPABASE_KEY untuk --kirim.');
    if (hasil.masalah.length) throw new Error('Perbaiki masalah di atas sebelum dikirim ke mother base.');
    const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/import_surat_jalan`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: payload }),
    });
    const teks = await res.text();
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${teks.slice(0, 500)}`);
    console.log('\nMother base:', teks);
  }
}

module.exports = { bacaRincianPengiriman, bacaFile, barisImportTrizone, payloadMotherBase, satuanTrizone, keTanggal };

if (require.main === module) main(process.argv).catch((e) => { console.error(e.message); process.exit(1); });
