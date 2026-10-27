'use strict';
// Versi DEMO: data contoh siap pakai untuk latihan. Tanpa Electron agar bisa diuji dengan Node biasa.

const DEMO_ACCOUNTS = [
  { name: 'Admin', role: 'admin', pin: '111111' },
  { name: 'Gudang', role: 'gudang', pin: '222222' },
  { name: 'Kasir', role: 'kasir', pin: '333333' },
];

// Barcode EAN-13 yang valid (digit cek benar) agar label barcode tercetak sebagai EAN-13
function ean13(base12) {
  const d = String(base12).padStart(12, '0').slice(0, 12);
  const sum = [...d].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return d + ((10 - (sum % 10)) % 10);
}

// [SKU, nama, merk, kategori, harga, satuan masuk, isi per dus, toko, gudang, BS, min toko]
const PRODUCTS = [
  ['MNM-001', 'Air Mineral 600ml', 'Segar', 'Minuman', 3500, 'Dus', 24, 30, 96, 2, 12],
  ['MNM-002', 'Air Mineral 1500ml', 'Segar', 'Minuman', 6500, 'Dus', 12, 18, 48, 0, 6],
  ['MNM-010', 'Teh Kotak Melati 300ml', 'Ultra', 'Minuman', 4500, 'Dus', 24, 9, 72, 1, 12],
  ['MNM-020', 'Kopi Susu Botol 225ml', 'Kopiku', 'Minuman', 7000, 'Dus', 24, 20, 48, 0, 10],
  ['MNM-030', 'Minuman Isotonik 500ml', 'Ion', 'Minuman', 7500, 'Dus', 24, 0, 24, 0, 6],
  ['SNK-010', 'Keripik Kentang 68g', 'Renyah', 'Makanan Ringan', 11500, 'Karton', 40, 4, 80, 0, 10],
  ['SNK-011', 'Keripik Singkong Pedas 150g', 'Renyah', 'Makanan Ringan', 9000, 'Karton', 30, 15, 60, 3, 8],
  ['SNK-020', 'Biskuit Kelapa 200g', 'Manis', 'Makanan Ringan', 8500, 'Karton', 24, 22, 48, 0, 8],
  ['SNK-021', 'Wafer Cokelat 130g', 'Manis', 'Makanan Ringan', 6000, 'Karton', 36, 30, 72, 2, 10],
  ['SNK-030', 'Kacang Atom 250g', 'Gurih', 'Makanan Ringan', 12000, 'Karton', 20, 6, 20, 0, 6],
  ['MKN-001', 'Mi Instan Goreng', 'Sedap', 'Makanan', 3200, 'Dus', 40, 80, 200, 4, 30],
  ['MKN-002', 'Mi Instan Kuah Ayam Bawang', 'Sedap', 'Makanan', 3000, 'Dus', 40, 60, 160, 0, 30],
  ['MKN-010', 'Beras Premium 5kg', 'Pandan Wangi', 'Makanan', 78000, 'Karung', 4, 8, 20, 0, 4],
  ['MKN-020', 'Minyak Goreng 2L', 'Bimoli', 'Makanan', 38000, 'Dus', 6, 10, 30, 1, 6],
  ['MKN-030', 'Gula Pasir 1kg', 'Gulaku', 'Makanan', 17500, 'Karung', 10, 25, 40, 0, 10],
  ['MKN-040', 'Telur Ayam 10 butir', 'Peternak', 'Makanan', 28000, 'Krat', 15, 7, 15, 2, 5],
  ['MKN-050', 'Kecap Manis 520ml', 'Bango', 'Bumbu Dapur', 23500, 'Dus', 12, 12, 24, 0, 6],
  ['MKN-051', 'Saus Sambal 340ml', 'ABC', 'Bumbu Dapur', 14000, 'Dus', 24, 3, 24, 0, 6],
  ['MKN-052', 'Garam Beryodium 250g', 'Kapal', 'Bumbu Dapur', 3500, 'Dus', 50, 40, 100, 0, 15],
  ['SBN-005', 'Sabun Mandi 85g', 'Wangi', 'Perawatan', 4200, 'Dus', 72, 15, 0, 3, 5],
  ['SBN-010', 'Sampo Sachet 10ml (renceng 12)', 'Lembut', 'Perawatan', 6500, 'Dus', 24, 25, 48, 0, 8],
  ['SBN-020', 'Pasta Gigi 190g', 'Senyum', 'Perawatan', 13500, 'Dus', 36, 14, 36, 0, 6],
  ['SBN-030', 'Sikat Gigi Lembut', 'Senyum', 'Perawatan', 8000, 'Dus', 48, 2, 48, 1, 6],
  ['RT-001', 'Deterjen Bubuk 800g', 'Bersih', 'Rumah Tangga', 19500, 'Karton', 12, 11, 24, 0, 6],
  ['RT-002', 'Sabun Cuci Piring 780ml', 'Kilap', 'Rumah Tangga', 15000, 'Karton', 12, 9, 24, 2, 6],
  ['RT-003', 'Tisu Wajah 250 lembar', 'Halus', 'Rumah Tangga', 16000, 'Karton', 24, 18, 24, 0, 6],
  ['BRS-001', 'Penebah Lidi @50 PCS Sima', 'Sima', 'Rumah Tangga', 6000, 'Ikat', 50, 20, 100, 0, 10],
  ['BRS-002', 'Sapu Ijuk', 'Sima', 'Rumah Tangga', 25000, 'Ikat', 10, 5, 20, 1, 3],
  ['ATK-001', 'Buku Tulis 38 Lembar', 'Sinar', 'Alat Tulis', 3500, 'Pak', 10, 50, 100, 0, 20],
  ['ATK-002', 'Pulpen Hitam 0.5', 'Tinta', 'Alat Tulis', 2500, 'Pak', 12, 36, 120, 0, 12],
];

function seedDemo(svc) {
  svc.saveSettings({
    store_name: 'Toko Demo Tri-Zone',
    store_address: 'Jl. Contoh No. 1 (DATA DEMO)',
    owner_email: 'owner@demo.local',
    smtp_host: 'demo.local',
    smtp_from: 'toko@demo.local',
    receipt_header: 'TOKO DEMO TRI-ZONE\nJl. Contoh No. 1\nTelp: 0800-0000-0000',
    receipt_footer: 'TERIMA KASIH\nNOTA LATIHAN - BUKAN TRANSAKSI ASLI',
  });
  for (const a of DEMO_ACCOUNTS) svc.saveUser({ ...a, active: true });

  svc.importRows(PRODUCTS.map(([sku, name, brand, category, price, unit, ratio, floor, wh, bs, min], i) => ({
    Barcode: ean13(`899${String(1000000 + i * 7919).slice(-7)}01`), SKU: sku, Nama_Barang: name, Merk: brand, Kategori: category,
    Harga_Jual: price, Satuan_Masuk: unit, Rasio_Isi_Dus: ratio,
    Stok_Awal_Toko: floor, Stok_Awal_Gudang: wh, Stok_Awal_BS: bs, Min_Alert_Toko: min,
  })));

  // Riwayat contoh: penerimaan & mutasi
  svc.createReception({ reference_no: 'SJ-DEMO-001', supplier_name: 'PT Sumber Minuman', notes: 'Kiriman contoh', items: [
    { sku: 'MNM-001', qty: 2, pack_type: 'Dus', destination: 'warehouse' },
    { sku: 'MNM-010', qty: 1, pack_type: 'Dus', destination: 'warehouse' },
  ] });
  svc.createReception({ reference_no: 'SJ-DEMO-002', supplier_name: 'CV Sembako Jaya', items: [
    { sku: 'MKN-001', qty: 1, pack_type: 'Dus', destination: 'warehouse' },
    { sku: 'MKN-030', qty: 10, pack_type: 'Biji', destination: 'floor' },
  ] });
  svc.createTransfer({ sku: 'MNM-001', from_zone: 'warehouse', to_zone: 'floor', qty: 24, reason: 'Isi rak pagi' });
  svc.createTransfer({ sku: 'MKN-040', from_zone: 'floor', to_zone: 'damaged', qty: 1, reason: 'Telur pecah di rak' });
  svc.createTransfer({ sku: 'SNK-011', from_zone: 'customer', to_zone: 'damaged', qty: 1, reason: 'Retur pelanggan: kemasan bocor' });
  svc.listLabelDesigns(); // buat desain label bawaan
  return { products: PRODUCTS.length, accounts: DEMO_ACCOUNTS.length };
}

module.exports = { seedDemo, DEMO_ACCOUNTS, ean13 };
