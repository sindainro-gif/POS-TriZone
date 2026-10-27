'use strict';
// Uji generator barcode & label: node test/labels.test.js
const assert = require('assert');
const L = require('../src/labels');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}
const product = (n) => ({ sku: `SKU-${n}`, barcode: '4006381333931', name: `Barang ${n}`, brand: 'Merk', unit_price: 3500 });

(async () => {
  await t('tabel Code 128: tiap simbol 11 modul, stop 13 modul', () => {
    assert.strictEqual(L.C128.length, 107);
    L.C128.forEach((p, i) => {
      const sum = p.split('').reduce((s, w) => s + Number(w), 0);
      assert.strictEqual(sum, i === 106 ? 13 : 11, `simbol ${i}`);
    });
  });

  await t('EAN-13: checksum, 95 modul, guard & pola paritas', () => {
    assert.strictEqual(L.eanChecksum('400638133393'), '1');
    assert.ok(L.isValidEAN13('4006381333931'));
    assert.ok(!L.isValidEAN13('4006381333932'));
    const { bits, text } = L.encodeEAN13('400638133393'); // 12 digit → checksum ditambahkan
    assert.strictEqual(text, '4006381333931');
    assert.strictEqual(bits.length, 95);
    assert.strictEqual(bits.slice(0, 3), '101');
    assert.strictEqual(bits.slice(45, 50), '01010');
    assert.strictEqual(bits.slice(92), '101');
    // digit awal 4 → paritas LGLLGG: digit ke-2 '0' pola L, digit ke-3 '0' pola G
    assert.strictEqual(bits.slice(3, 10), '0001101');
    assert.strictEqual(bits.slice(10, 17), '0100111');
  });

  await t('Code 128 set B: checksum & panjang', () => {
    const r = L.encodeCode128('MNM-001');
    assert.strictEqual(r.values[0], 104);
    assert.strictEqual(r.values[r.values.length - 2], 2); // (104+45+92+135+52+80+96+119) = 723, 723 % 103 = 2
    assert.strictEqual(r.bits.length, 11 * 9 + 13);
    assert.ok(r.bits.endsWith('11'));
  });

  await t('Code 128 set C untuk angka genap', () => {
    const r = L.encodeCode128('12345678');
    assert.strictEqual(r.values[0], 105);
    assert.deepStrictEqual(r.values.slice(1, 5), [12, 34, 56, 78]);
  });

  await t('mode auto memilih EAN-13 / Code 128', () => {
    assert.strictEqual(L.encodeBarcode('4006381333931').type, 'ean13');
    assert.strictEqual(L.encodeBarcode('MNM-001').type, 'code128');
    assert.strictEqual(L.encodeBarcode('8991234567890').type, 'code128'); // checksum EAN tidak valid
    assert.throws(() => L.encodeBarcode('ABC', 'ean13'), /bukan EAN-13/);
  });

  await t('SVG barcode berisi batang', () => {
    const svg = L.barcodeSvg('4006381333931', { widthMm: 40, heightMm: 8 });
    // EAN-13: 95 + 20 modul quiet zone; 40 mm / 115 → modul 0,25 mm (2 titik printer) = 28,75 mm
    assert.match(svg, /^<svg[^>]+width="28\.750mm" height="8mm"/);
    assert.ok((svg.match(/<rect/g) || []).length >= 30);
  });

  await t('5 label × 2 kolom = 3 halaman 106×20 mm', () => {
    const p = L.labelPages({ ...L.DEFAULT_DESIGN }, [{ product: product(1), copies: 3 }, { product: product(2), copies: 2 }, { product: product(3), copies: 0 }]);
    assert.strictEqual(p.labelCount, 5);
    assert.strictEqual(p.pageCount, 3);
    assert.strictEqual(p.widthMicrons, 106000);
    assert.strictEqual(p.heightMicrons, 20000);
    assert.strictEqual((p.html.match(/class="page"/g) || []).length, 3);
    assert.match(p.html, /Rp 3\.500/);
    assert.throws(() => L.labelPages(L.DEFAULT_DESIGN, [{ product: product(1), copies: 0 }]), /Tidak ada label/);
  });

  await t('validasi desain', () => {
    assert.throws(() => L.normalizeDesign({ columns: 9 }), /kolom/);
    assert.throws(() => L.normalizeDesign({ paper_width_mm: 20, columns: 4 }), /terlalu sempit/);
    const d = L.normalizeDesign({ columns: '3', show_sku: 'true', rotate: '1' });
    assert.strictEqual(d.columns, 3);
    assert.strictEqual(d.show_sku, true);
    assert.strictEqual(d.rotate, true);
  });

  await t('designer: desain lama → elemen bawaan bertumpuk di dalam label', () => {
    const d = L.normalizeDesign({ ...L.DEFAULT_DESIGN });
    assert.deepStrictEqual(d.elements.map((e) => e.type), ['name', 'barcode', 'code', 'price']);
    const cellW = (106 - 2 - 3) / 2;
    for (const e of d.elements) {
      assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= cellW + 0.01 && e.y + e.h <= 18.01, `${e.type} di luar label`);
    }
    for (let i = 1; i < d.elements.length; i++) assert.ok(d.elements[i].y >= d.elements[i - 1].y + d.elements[i - 1].h - 0.01, 'tumpang tindih');
    assert.strictEqual(d.elements.find((e) => e.type === 'price').size, 9);
    assert.strictEqual(d.elements.find((e) => e.type === 'barcode').h, 7);
    // Isi lama yang terlalu tinggi dipadatkan agar tetap muat
    const tall = L.normalizeDesign({ label_height_mm: 10, barcode_height_mm: 20, show_sku: true, show_brand: true });
    for (const e of tall.elements) assert.ok(e.y + e.h <= 8.01);
  });

  await t('designer: elemen dijepit ke dalam label, jenis tidak dikenal ditolak', () => {
    const d = L.normalizeDesign({ elements: [
      { id: 'p', type: 'price', x: 45, y: 16, w: 20, h: 5, size: 99, bold: '1', align: 'right' },
      { id: 'p', type: 'line', x: -3, y: 2, w: 10, h: 0.05, thickness: 9 },
    ] });
    const [p, ln] = d.elements;
    assert.deepStrictEqual([p.w, p.h, p.x, p.y, p.size, p.bold, p.align], [20, 5, 30.5, 13, 40, true, 'right']);
    assert.deepStrictEqual([ln.x, ln.h, ln.thickness], [0, 0.1, 2]);
    assert.notStrictEqual(ln.id, p.id); // id unik
    assert.throws(() => L.normalizeDesign({ elements: [{ type: 'gambar' }] }), /tidak dikenal/);
    assert.throws(() => L.normalizeDesign({ elements: Array.from({ length: 31 }, () => ({ type: 'text' })) }), /Maksimal 30/);
    assert.deepStrictEqual(L.normalizeDesign({ elements: [] }).elements, []); // label kosong boleh
  });

  await t('designer: HTML memakai posisi & ukuran yang diatur (pratinjau = cetak)', () => {
    const design = { elements: [
      { id: 'h', type: 'price', x: 25, y: 2, w: 25, h: 6, size: 14, bold: true, align: 'right' },
      { id: 'b', type: 'barcode', x: 0, y: 9, w: 30, h: 5 },
      { id: 'l', type: 'line', x: 0, y: 8, w: 50, h: 1, thickness: 0.4 },
      { id: 'k', type: 'box', x: 0, y: 0, w: 50.5, h: 18, thickness: 0.3 },
      { id: 't', type: 'text', x: 0, y: 0, w: 20, h: 3, size: 6, text: 'TOKO <A>' },
    ] };
    const pv = L.labelPreview(design, [product(1)], { single: true });
    assert.strictEqual(pv.cellW, 50.5);
    assert.strictEqual(pv.cellH, 18);
    assert.match(pv.html, /data-el="h" style="left:25mm;top:2mm;width:25mm;height:6mm;font-size:14pt;font-weight:800;text-align:right"><span>Rp 3\.500<\/span>/);
    assert.match(pv.html, /data-el="b" style="left:0mm;top:9mm;width:30mm;height:5mm"><svg[^>]+height="5mm"/);
    assert.match(pv.html, /class="el ln" data-el="l" style="left:0mm;top:8\.3mm;width:50mm;height:0\.4mm"/);
    assert.match(pv.html, /class="el bx" data-el="k"[^>]+border-width:0\.3mm/);
    assert.match(pv.html, /TOKO &lt;A&gt;/);
    const pages = L.labelPages(design, [{ product: product(1), copies: 2 }]);
    assert.match(pages.html, /font-size:14pt/);
    assert.strictEqual((pages.html.match(/data-el="h"/g) || []).length, 2);
  });

  const db = await Database.open(null);
  const svc = createServices(db);

  await t('desain: default otomatis, simpan, nama unik, default, hapus', () => {
    const list = svc.listLabelDesigns();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].config.paper_width_mm, 106);
    const id = svc.saveLabelDesign({ name: 'Rol 33x15 3 Kolom', config: { paper_width_mm: 105, label_height_mm: 15, columns: 3 } });
    assert.throws(() => svc.saveLabelDesign({ name: 'rol 33x15 3 kolom', config: {} }), /sudah dipakai/);
    svc.setDefaultLabelDesign({ id });
    assert.strictEqual(svc.getLabelDesign().id, id);
    svc.deleteLabelDesign({ id });
    assert.strictEqual(svc.listLabelDesigns().length, 1);
    assert.strictEqual(svc.listLabelDesigns()[0].is_default, 1);
    assert.throws(() => svc.deleteLabelDesign({ id: svc.listLabelDesigns()[0].id }), /Minimal/);
  });

  await t('antrian dari penerimaan = jumlah Biji diterima', () => {
    svc.importRows([{ Barcode: '4006381333931', SKU: 'A-1', Nama_Barang: 'Barang A', Harga_Jual: 5000, Rasio_Isi_Dus: 12 }]);
    const r = svc.createReception({
      reference_no: 'SJ-L1',
      items: [{ sku: 'A-1', qty: 2, pack_type: 'Dus', destination: 'warehouse' }, { sku: 'A-1', qty: 3, pack_type: 'Biji', destination: 'floor' }],
    });
    const q = svc.labelItemsFromReception({ id: r.id });
    assert.strictEqual(q.items.length, 1);
    assert.strictEqual(q.items[0].copies, 27);
  });

  console.log(`\n${passed} tes label lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
