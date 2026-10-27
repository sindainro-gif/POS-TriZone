'use strict';
// Generator barcode (EAN-13 / Code 128) dan halaman label rol — murni, tanpa dependensi.

// ---------------------------------------------------------------- EAN-13
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_R = EAN_L.map((p) => p.replace(/./g, (b) => (b === '0' ? '1' : '0')));
const EAN_G = EAN_R.map((p) => p.split('').reverse().join(''));
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function eanChecksum(d12) {
  const sum = d12.split('').reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

function isValidEAN13(code) {
  return /^\d{13}$/.test(code) && eanChecksum(code.slice(0, 12)) === code[12];
}

// Hasil: string bit 95 modul ('1' = batang hitam)
function encodeEAN13(code) {
  let c = String(code);
  if (/^\d{12}$/.test(c)) c += eanChecksum(c);
  if (!isValidEAN13(c)) throw new Error(`Barcode ${code} bukan EAN-13 yang valid.`);
  const parity = EAN_PARITY[Number(c[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[Number(c[i])];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[Number(c[i])];
  return { bits: bits + '101', text: c };
}

// ---------------------------------------------------------------- Code 128
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const STOP = 106;

function encodeCode128(code) {
  const c = String(code);
  if (!c.length) throw new Error('Barcode kosong.');
  let values;
  if (/^\d+$/.test(c) && c.length % 2 === 0 && c.length >= 4) {
    // Set C: dua digit per simbol, lebih ringkas untuk kode angka
    values = [START_C];
    for (let i = 0; i < c.length; i += 2) values.push(Number(c.slice(i, i + 2)));
  } else {
    values = [START_B];
    for (const ch of c) {
      const v = ch.charCodeAt(0) - 32;
      if (v < 0 || v > 95) throw new Error(`Karakter "${ch}" tidak didukung Code 128.`);
      values.push(v);
    }
  }
  const check = values.reduce((s, v, i) => s + (i === 0 ? v : v * i), 0) % 103;
  values.push(check, STOP);
  let bits = '';
  for (const v of values) {
    C128[v].split('').forEach((w, i) => { bits += (i % 2 ? '0' : '1').repeat(Number(w)); });
  }
  return { bits, text: c, values };
}

function encodeBarcode(code, type = 'auto') {
  const c = String(code || '').trim();
  if (type === 'ean13' || (type === 'auto' && (isValidEAN13(c) || /^\d{12}$/.test(c)))) return { type: 'ean13', ...encodeEAN13(c) };
  return { type: 'code128', ...encodeCode128(c) };
}

// Lebar satu titik printer thermal 203 dpi (8 titik/mm)
const DOT_MM = 0.125;

// widthMm = lebar maksimum; lebar modul dibulatkan ke kelipatan titik printer agar batang rata & mudah di-scan
function barcodeSvg(code, { type = 'auto', heightMm = 8, widthMm = 40 } = {}) {
  const { bits } = encodeBarcode(code, type);
  const quiet = 10;
  const total = bits.length + quiet * 2;
  const moduleMm = Math.min(0.5, Math.max(DOT_MM, Math.floor(widthMm / total / DOT_MM) * DOT_MM));
  widthMm = (moduleMm * total).toFixed(3);
  let rects = '';
  let x = 0;
  while (x < bits.length) {
    if (bits[x] === '1') {
      let w = 1;
      while (bits[x + w] === '1') w++;
      rects += `<rect x="${x + quiet}" y="0" width="${w}" height="1"/>`;
      x += w;
    } else x++;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${total} 1" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${rects}</svg>`;
}

// ---------------------------------------------------------------- Desain label
const DEFAULT_DESIGN = {
  paper_type: 'roll',
  paper_width_mm: 106,
  label_height_mm: 20,
  columns: 2,
  gap_mm: 3,
  margin_mm: 1,
  rotate: false,
  align: 'center',
  barcode_type: 'auto',
  barcode_height_mm: 7,
  show_top_text: false, top_text: '', top_size: 6,
  show_name: true, name_size: 7,
  show_brand: false, brand_size: 6,
  show_barcode: true,
  show_code_text: true, code_size: 6,
  show_sku: false, sku_size: 6,
  show_price: true, price_size: 9,
};

function num(v, label, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    const e = new Error(`${label} harus antara ${min} dan ${max}.`);
    e.userFacing = true;
    throw e;
  }
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- Elemen designer (posisi bebas, satuan mm)
const ELEMENT_TYPES = {
  name: 'Nama barang', price: 'Harga', barcode: 'Barcode', code: 'Angka barcode',
  sku: 'SKU', brand: 'Merk', text: 'Teks', line: 'Garis', box: 'Kotak',
};
const TEXT_TYPES = new Set(['name', 'price', 'code', 'sku', 'brand', 'text']);
const MAX_ELEMENTS = 30;
const PT_MM = 0.3528; // 1 pt dalam mm
const lineHeightMm = (pt) => Math.round(pt * PT_MM * 1.15 * 100) / 100;
const round2 = (n) => Math.round(n * 100) / 100;

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return round2(Math.min(max, Math.max(min, n)));
}

// Ukuran satu kotak label (setelah margin)
function cellSize(d) {
  return { w: round2(labelWidth(d)), h: round2(d.label_height_mm - 2 * d.margin_mm) };
}

// Susunan bawaan dari pengaturan lama (checkbox + ukuran pt): bertumpuk, di tengah label
function defaultElements(d) {
  const { w, h } = cellSize(d);
  const rows = [];
  if (d.show_top_text && d.top_text) rows.push({ type: 'text', text: d.top_text, size: d.top_size });
  if (d.show_name) rows.push({ type: 'name', size: d.name_size, bold: true });
  if (d.show_brand) rows.push({ type: 'brand', size: d.brand_size });
  if (d.show_barcode) rows.push({ type: 'barcode', h: d.barcode_height_mm });
  if (d.show_code_text) rows.push({ type: 'code', size: d.code_size });
  if (d.show_sku) rows.push({ type: 'sku', size: d.sku_size });
  if (d.show_price) rows.push({ type: 'price', size: d.price_size, bold: true });
  for (const r of rows) if (!r.h) r.h = lineHeightMm(r.size);
  const gap = 0.4;
  let total = rows.reduce((s, r) => s + r.h, 0) + gap * Math.max(0, rows.length - 1);
  const scale = total > h ? h / total : 1; // terlalu tinggi → dipadatkan agar tetap di dalam label
  total *= scale;
  let y = (h - total) / 2;
  return rows.map((r, i) => {
    const el = {
      id: `e${i + 1}`, type: r.type, x: 0, y: round2(y), w, h: round2(r.h * scale),
      size: r.size || 8, bold: !!r.bold, align: d.align === 'left' ? 'left' : 'center', text: r.text || '', thickness: 0.3,
    };
    y += (r.h + gap) * scale;
    return el;
  });
}

function normalizeElements(list, d) {
  if (!Array.isArray(list)) return defaultElements(d);
  if (list.length > MAX_ELEMENTS) fail(`Maksimal ${MAX_ELEMENTS} elemen per label.`);
  const { w: cw, h: ch } = cellSize(d);
  const ids = new Set();
  return list.map((e, i) => {
    if (!ELEMENT_TYPES[e && e.type]) fail(`Jenis elemen label tidak dikenal: ${e && e.type}`);
    let id = String(e.id || '').replace(/[^\w-]/g, '').slice(0, 20) || `e${i + 1}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    const w = clampNum(e.w, 0.5, cw, Math.min(20, cw));
    const h = clampNum(e.h, e.type === 'line' ? 0.1 : 0.5, ch, Math.min(4, ch));
    return {
      id,
      type: e.type,
      x: clampNum(e.x, 0, round2(cw - w), 0),
      y: clampNum(e.y, 0, round2(ch - h), 0),
      w,
      h,
      size: clampNum(e.size, 3, 40, 8),
      bold: e.bold === true || e.bold === 1 || e.bold === '1' || e.bold === 'true',
      align: ['left', 'right'].includes(e.align) ? e.align : 'center',
      text: String(e.text || '').slice(0, 60),
      thickness: clampNum(e.thickness, 0.1, 2, 0.3),
    };
  });
}

function normalizeDesign(cfg = {}) {
  const d = { ...DEFAULT_DESIGN, ...cfg };
  const out = {
    paper_type: 'roll',
    paper_width_mm: num(d.paper_width_mm, 'Lebar kertas', 10, 300),
    label_height_mm: num(d.label_height_mm, 'Tinggi label', 5, 300),
    columns: Math.round(num(d.columns, 'Jumlah kolom', 1, 6)),
    gap_mm: num(d.gap_mm, 'Jarak antar kolom', 0, 50),
    margin_mm: num(d.margin_mm, 'Margin', 0, 20),
    rotate: !!d.rotate && d.rotate !== '0',
    align: d.align === 'left' ? 'left' : 'center',
    barcode_type: ['auto', 'ean13', 'code128'].includes(d.barcode_type) ? d.barcode_type : 'auto',
    barcode_height_mm: num(d.barcode_height_mm, 'Tinggi barcode', 2, 100),
    top_text: String(d.top_text || '').slice(0, 60),
  };
  for (const k of ['top', 'name', 'brand', 'code', 'sku', 'price']) out[`${k}_size`] = num(d[`${k}_size`], 'Ukuran huruf', 3, 30);
  for (const k of ['show_top_text', 'show_name', 'show_brand', 'show_barcode', 'show_code_text', 'show_sku', 'show_price']) {
    out[k] = d[k] === true || d[k] === 1 || d[k] === '1' || d[k] === 'true';
  }
  const inner = out.paper_width_mm - 2 * out.margin_mm - (out.columns - 1) * out.gap_mm;
  if (inner / out.columns < 8) fail('Label terlalu sempit: kurangi kolom, jarak, atau margin.');
  if (out.label_height_mm - 2 * out.margin_mm < 3) fail('Label terlalu pendek: kurangi margin atau tambah tinggi label.');
  out.elements = normalizeElements(cfg.elements, out);
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

function labelWidth(d) {
  return (d.paper_width_mm - 2 * d.margin_mm - (d.columns - 1) * d.gap_mm) / d.columns;
}

function elementText(e, p) {
  switch (e.type) {
    case 'name': return p.name;
    case 'price': return rp(p.unit_price);
    case 'code': return p.barcode;
    case 'sku': return p.sku;
    case 'brand': return p.brand && p.brand !== '-' ? p.brand : '';
    default: return e.text;
  }
}

// Satu elemen sebagai kotak berposisi absolut (mm) di dalam label
function elementHtml(e, p, d) {
  const pos = (x, y, w, h) => `left:${round2(x)}mm;top:${round2(y)}mm;width:${round2(w)}mm;height:${round2(h)}mm`;
  const attr = `data-el="${esc(e.id)}"`;
  if (e.type === 'line') {
    // Garis mendatar bila kotaknya lebar, tegak bila tinggi; ketebalan di tengah kotak
    const t = Math.min(e.thickness, e.w >= e.h ? e.h : e.w);
    return e.w >= e.h
      ? `<div class="el ln" ${attr} style="${pos(e.x, e.y + (e.h - t) / 2, e.w, t)}"></div>`
      : `<div class="el ln" ${attr} style="${pos(e.x + (e.w - t) / 2, e.y, t, e.h)}"></div>`;
  }
  if (e.type === 'box') return `<div class="el bx" ${attr} style="${pos(e.x, e.y, e.w, e.h)};border-width:${e.thickness}mm"></div>`;
  if (e.type === 'barcode') {
    let svg;
    try { svg = barcodeSvg(p.barcode, { type: d.barcode_type, heightMm: e.h, widthMm: e.w }); } catch (err) { svg = `<div class="err">${esc(err.message)}</div>`; }
    return `<div class="el bc ${e.align}" ${attr} style="${pos(e.x, e.y, e.w, e.h)}">${svg}</div>`;
  }
  const wrap = e.type === 'name' && e.h >= 2 * lineHeightMm(e.size) ? ' wrap' : '';
  const mono = e.type === 'code' || e.type === 'sku' ? ' mono' : '';
  return `<div class="el tx${wrap}${mono}" ${attr} style="${pos(e.x, e.y, e.w, e.h)};font-size:${e.size}pt;font-weight:${e.bold ? 800 : 400};text-align:${e.align}"><span>${esc(elementText(e, p))}</span></div>`;
}

function labelHtml(d, p) {
  const { w } = cellSize(d);
  return `<div class="bclbl" style="width:${w}mm">${d.elements.map((e) => elementHtml(e, p, d)).join('')}</div>`;
}

function labelCss(d) {
  const { h } = cellSize(d);
  return `.bclbl-row{display:flex;gap:${d.gap_mm}mm;padding:${d.margin_mm}mm;width:${d.paper_width_mm}mm;height:${d.label_height_mm}mm;box-sizing:border-box;overflow:hidden;${d.rotate ? 'transform:rotate(180deg);' : ''}}
.bclbl{position:relative;flex:none;height:${h}mm;overflow:hidden;font-family:Arial,"Segoe UI",sans-serif;color:#000;box-sizing:border-box}
.bclbl .el{position:absolute;box-sizing:border-box;overflow:hidden}
.bclbl .tx{display:flex;align-items:center;line-height:1.1}
.bclbl .tx>span{display:block;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bclbl .tx.wrap>span{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bclbl .mono{font-family:"Courier New",Consolas,monospace;letter-spacing:.5px}
.bclbl .bc{display:flex;align-items:center;justify-content:center;line-height:0}
.bclbl .bc.left{justify-content:flex-start}.bclbl .bc.right{justify-content:flex-end}
.bclbl .ln{background:#000}
.bclbl .bx{border-style:solid;border-color:#000}
.bclbl .err{font-size:6pt;color:#000;border:1px dashed #000;padding:1mm;line-height:1.1}`;
}

// items: [{ product: {sku, barcode, name, brand, unit_price}, copies }]
function expandItems(items) {
  const out = [];
  for (const it of items) for (let i = 0; i < Math.max(0, Math.floor(Number(it.copies) || 0)); i++) out.push(it.product);
  return out;
}

function labelRowsHtml(design, products) {
  const d = normalizeDesign(design);
  const rows = [];
  for (let i = 0; i < products.length; i += d.columns) {
    const cells = products.slice(i, i + d.columns).map((p) => labelHtml(d, p));
    while (cells.length < d.columns) cells.push(`<div class="bclbl" style="width:${labelWidth(d).toFixed(2)}mm"></div>`);
    rows.push(`<div class="bclbl-row">${cells.join('')}</div>`);
  }
  return { d, rows };
}

function labelPages(design, items) {
  const products = expandItems(items);
  if (!products.length) {
    const e = new Error('Tidak ada label untuk dicetak.');
    e.userFacing = true;
    throw e;
  }
  const { d, rows } = labelRowsHtml(design, products);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:${d.paper_width_mm}mm ${d.label_height_mm}mm;margin:0}
html,body{margin:0;padding:0;background:#fff}
.page{width:${d.paper_width_mm}mm;height:${d.label_height_mm}mm;overflow:hidden;page-break-after:always;break-after:page}
.page:last-child{page-break-after:auto;break-after:auto}
${labelCss(d)}
</style></head><body>${rows.map((r) => `<div class="page">${r}</div>`).join('')}</body></html>`;
  return {
    html,
    widthMicrons: Math.round(d.paper_width_mm * 1000),
    heightMicrons: Math.round(d.label_height_mm * 1000),
    pageCount: rows.length,
    labelCount: products.length,
  };
}

// Pratinjau untuk UI (markup + CSS): satu baris kertas, atau satu label saja untuk kanvas designer
function labelPreview(design, products, { single = false } = {}) {
  const nd = normalizeDesign(design);
  const cell = cellSize(nd);
  if (single) {
    return { css: labelCss(nd), html: labelHtml(nd, products[0]), cellW: cell.w, cellH: cell.h, elements: nd.elements };
  }
  const row = Array.from({ length: nd.columns }, (_, i) => products[i % products.length]);
  const { d, rows } = labelRowsHtml(nd, row);
  return { css: labelCss(d), html: rows[0], widthMm: d.paper_width_mm, heightMm: d.label_height_mm, cellW: cell.w, cellH: cell.h, elements: d.elements };
}

module.exports = {
  DEFAULT_DESIGN, ELEMENT_TYPES, normalizeDesign, defaultElements, encodeEAN13, encodeCode128, encodeBarcode, isValidEAN13, eanChecksum, barcodeSvg,
  labelPages, labelPreview, expandItems, C128,
};
