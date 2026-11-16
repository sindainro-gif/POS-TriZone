'use strict';
// Pembaca laporan Accurate "Rincian Pengiriman Pesanan" (ekspor Excel).
//
// Laporan ini berbentuk cetakan: satu blok per nomor DO (Nomor #, Tanggal, Pelanggan,
// tabel Kode # / Nama Barang / Kuantitas / Satuan, baris total), diselingi kepala dan
// kaki halaman. Posisi kolom dicari dari label, bukan dari huruf kolom, supaya tahan
// bila tata letak Accurate sedikit bergeser.
//
// Logika pembaca ada di web/lib/accurate.js (dipakai juga oleh aplikasi web).
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
const { bacaRincianPengiriman, bacaFile, barisImportTrizone, payloadMotherBase, satuanTrizone, keTanggal } = require('../web/lib/accurate');

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
