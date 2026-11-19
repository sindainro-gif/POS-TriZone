'use strict';
// Baca tabel dari PDF hasil "Save as PDF" Microsoft Excel (mis. template stok opname yang sudah diisi).
// Tanpa Electron agar bisa diuji dengan Node biasa.
//
// Excel membagi lembar lebar ke beberapa "pita" kolom: urutan bawaan "ke bawah lalu ke samping" mencetak
// kolom A–E untuk semua baris dulu, lalu kolom berikutnya di halaman-halaman sesudahnya TANPA kolom Kode.
// Setiap pita diawali baris judul kolom; baris di pita lain dicocokkan lewat (halaman ke-n dalam pita, posisi
// vertikal) karena tinggi baris sama di semua pita. Kalau susunannya tidak bisa dipastikan, baca DITOLAK
// dengan pesan jelas (lebih baik gagal daripada angka stok tertukar).
const PDFParser = require('pdf2json');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const Y_TOL = 0.3; // satuan pdf2json (≈ 1/16 inci)

function parsePdf(buffer) {
  return new Promise((resolve, reject) => {
    const p = new PDFParser(null, true);
    p.on('pdfParser_dataError', (e) => reject(new Error(`File PDF tidak bisa dibaca: ${(e && (e.parserError || e.message)) || e}`)));
    p.on('pdfParser_dataReady', resolve);
    p.parseBuffer(buffer);
  });
}

const textOf = (t) => {
  const raw = (t.R || []).map((r) => r.T).join('');
  try { return decodeURIComponent(raw).trim(); } catch (_) { return raw.trim(); }
};

// Kelompokkan teks satu halaman menjadi baris (posisi vertikal sama), urut atas → bawah, kiri → kanan
function linesOf(page) {
  const items = (page.Texts || []).map((t) => ({ x: t.x, y: t.y, s: textOf(t) })).filter((i) => i.s !== '');
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Y_TOL) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

// Angka stok / hitung fisik: buang pemisah ribuan ("1.234" / "1,234" → "1234"); teks lain apa adanya
function cellValue(s) {
  const v = String(s).trim();
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(v)) return v.replace(/[.,]/g, '');
  return v;
}

/**
 * @param {Buffer} buffer isi file PDF
 * @param {{ headers: string[], keyHeader: string }} opt judul kolom yang dikenal & kolom kunci (mis. "Kode")
 * @returns {Promise<object[]>} baris seperti XLSX sheet_to_json: { "<judul>": nilai }, kolom kosong = ''
 */
async function readPdfTable(buffer, { headers, keyHeader }) {
  const known = new Map(headers.map((h) => [norm(h), h]));
  const keyNorm = norm(keyHeader);
  const data = await parsePdf(buffer);
  const pages = (data.Pages || []).map(linesOf);
  if (!pages.length) throw new Error('File PDF kosong.');

  // Pita kolom: dimulai di halaman yang baris pertamanya berisi judul kolom template
  const isHeader = (line) => line.items.length > 0 && line.items.every((i) => known.has(norm(i.s)));
  const bands = [];
  pages.forEach((lines, pageIdx) => {
    const hi = lines.findIndex(isHeader);
    if (hi >= 0) {
      const cols = lines[hi].items.map((i) => ({ x: i.x, name: known.get(norm(i.s)) }));
      bands.push({ cols, pages: [{ pageIdx, lines: lines.slice(hi + 1) }] });
    } else if (bands.length) {
      bands[bands.length - 1].pages.push({ pageIdx, lines });
    }
  });
  if (!bands.length) throw new Error(`Judul kolom template (mis. "${keyHeader}") tidak ditemukan di PDF. Gunakan template opname dari aplikasi.`);
  const keyBand = bands.findIndex((b) => b.cols.some((c) => norm(c.name) === keyNorm));
  if (keyBand < 0) throw new Error(`Kolom "${keyHeader}" tidak ditemukan di PDF.`);
  const unclear = 'Susunan halaman PDF tidak dikenali. Di Excel pilih Page Layout → Width: 1 page (atau "Fit All Columns on One Page"), lalu simpan PDF lagi.';
  if (bands.some((b) => b.pages.length !== bands[keyBand].pages.length)) throw new Error(unclear);

  // Isi sel: teks masuk ke kolom yang posisi judulnya paling dekat di sebelah kirinya
  const cellsOf = (band, line) => {
    const out = {};
    for (const it of line.items) {
      let col = null;
      for (const c of band.cols) if (it.x >= c.x - 0.2) col = c;
      if (!col) col = band.cols[0];
      out[col.name] = out[col.name] ? `${out[col.name]} ${it.s}` : it.s;
    }
    return out;
  };

  // Baris induk: baris di pita kolom Kode yang berisi kode barang (baris lanjutan nama barang diabaikan)
  const keyName = bands[keyBand].cols.find((c) => norm(c.name) === keyNorm).name;
  const rows = [];
  const index = new Map(); // "halaman-ke:y" → baris
  bands[keyBand].pages.forEach((pg, n) => {
    for (const line of pg.lines) {
      const cells = cellsOf(bands[keyBand], line);
      if (!cells[keyName]) continue;
      const row = Object.fromEntries(headers.map((h) => [h, '']));
      for (const [k, v] of Object.entries(cells)) row[k] = cellValue(v);
      rows.push(row);
      index.set(`${n}:${line.y.toFixed(1)}`, row);
    }
  });
  if (!rows.length) throw new Error('PDF tidak berisi baris barang.');

  // Pita lain: cocokkan ke baris induk lewat halaman ke-n dalam pita + posisi vertikal
  const find = (n, y) => {
    for (const d of [0, -0.1, 0.1, -0.2, 0.2, -0.3, 0.3]) {
      const r = index.get(`${n}:${(y + d).toFixed(1)}`);
      if (r) return r;
    }
    return null;
  };
  bands.forEach((band, b) => {
    if (b === keyBand) return;
    band.pages.forEach((pg, n) => {
      for (const line of pg.lines) {
        const row = find(n, line.y);
        if (!row) throw new Error(unclear);
        for (const [k, v] of Object.entries(cellsOf(band, line))) row[k] = cellValue(v);
      }
    });
  });
  return rows;
}

module.exports = { readPdfTable };
