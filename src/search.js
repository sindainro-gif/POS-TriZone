'use strict';
// Pencarian barang "mirip": kata boleh acak urutannya dan tahan salah ketik kecil.
// Dipakai server (services.js) dan mode darurat kasir (offline.js) agar hasilnya sama.

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const isNumber = (t) => /^\d+$/.test(t);

// Jarak Damerau-Levenshtein (salah ketik, huruf hilang/lebih, dua huruf tertukar)
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Toleransi salah ketik: kata pendek & angka (barcode, ukuran) harus tepat
const maxTypos = (t) => (isNumber(t) || t.length < 4 ? 0 : t.length < 7 ? 1 : 2);

// Nilai kecocokan satu kata kueri terhadap satu kata barang (0 = tidak cocok)
function wordScore(t, w) {
  if (t === w) return 10;
  if (w.startsWith(t)) return 8;
  if (t.length >= 2 && w.includes(t)) return 5;
  const max = maxTypos(t);
  if (!max || w.length < 3) return 0;
  const d = Math.min(editDistance(t, w), editDistance(t, w.slice(0, t.length)));
  return d <= max ? 3 - d : 0;
}

function codeScore(t, code) {
  if (!code) return 0;
  if (t === code) return 10;
  if (code.startsWith(t)) return 8;
  return t.length >= 2 && code.includes(t) ? 5 : 0;
}

function scoreProduct(p, q, tokens) {
  const name = words(p.name);
  const extra = [...words(p.brand), ...words(p.category)];
  const codes = [norm(p.sku).trim(), norm(p.barcode).trim()];
  let score = 0;
  const positions = [];
  for (const t of tokens) {
    let best = 0;
    let pos = -1;
    name.forEach((w, i) => { const s = wordScore(t, w); if (s > best) { best = s; pos = i; } });
    for (const w of extra) best = Math.max(best, wordScore(t, w) * 0.7);
    for (const c of codes) best = Math.max(best, codeScore(t, c));
    if (!best) return 0; // setiap kata kueri harus cocok dengan sesuatu
    score += best;
    positions.push(pos);
  }
  if (codes.includes(q)) score += 1000; // hasil scan / ketik kode persis
  else if (codes.some((c) => c && c.startsWith(q))) score += 500;
  if (norm(p.name).startsWith(q)) score += 200;
  if (positions.every((x, i) => x >= 0 && (i === 0 || x > positions[i - 1]))) score += 2; // urutan kata sama dengan nama
  return score;
}

/** Urutkan barang paling mirip dengan kueri; barang yang tidak cocok dibuang. */
function rankProducts(products, q, limit = 8) {
  const query = norm(q).trim();
  const tokens = words(q);
  if (!query || !tokens.length) return [];
  return (products || [])
    .map((p) => ({ p, s: scoreProduct(p, query, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || String(a.p.name).localeCompare(String(b.p.name), 'id', { sensitivity: 'base' }))
    .slice(0, Math.min(Number(limit) || 8, 50))
    .map((x) => x.p);
}

module.exports = { rankProducts, editDistance, words };
