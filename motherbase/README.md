# Mother Base

Pusat data PT kantor di atas Supabase untuk 9 toko POS Tri-Zone. Trizone (PC Gudang / Mandiri)
mengirim data langsung ke database lewat internet; mother base menambahkan surat jalan dari Accurate
dan pencocokannya, stok seharusnya per zona, master barang & harga, dan usulan beli.

```
 Toko (Trizone, src/motherbase.js)                 Mother base (Supabase)
 ┌────────────────────────────────┐   HTTPS        ┌──────────────────────────────────┐
 │ pos.db: antrean shift,         ├─ terima_data ─►│ penjualan, shift, stok 4 zona,   │
 │ penanda dokumen terkirim       │                │ penerimaan, mutasi, opname       │
 │ daftar barang (terkunci)       │◄─ ambil_master ┤ master barang & harga jual       │
 └────────────────────────────────┘                │                                  │
 Kantor (Accurate)                                 │                                  │
 Rincian Pengiriman Pesanan.xlsx ── accurate-do.js ┼─ import_surat_jalan ─────────────►│
                     └─► Penerimaan_<pelanggan>.xlsx → import penerimaan di Trizone   │
 Apps Script (09.00 WIB) ◄──────── laporan_belum_masuk ───────────────────────────────┘
```

## Isi folder

| Path | Isi |
|---|---|
| `supabase/migrations/20261116000001_mother_base.sql` | Skema: tabel, RPC, view hitungan, Row Level Security, audit |
| `supabase/seed.sql` | Data awal: 9 toko, pemetaan pelanggan Accurate, pengaturan |
| `supabase/tests/stub_supabase.sql` | Peniru `auth.uid()` dan peran Supabase untuk uji di PostgreSQL biasa |
| `apps-script/Code.gs` | Alert harian pukul 09.00: toko yang belum menutup shift kemarin |
| `accurate/accurate-do.js` | Pembaca laporan Accurate "Rincian Pengiriman Pesanan" |
| `test/uji.js` | Uji ujung ke ujung: Trizone asli → `src/motherbase.js` → PostgreSQL |

## Protokol dengan Trizone

Trizone memanggil RPC dengan **anon key** Supabase ditambah **kode toko** dan **kunci toko**. Kunci
dibuat di mother base, disimpan sebagai sha256 di tabel `toko_kunci` (tidak terbaca lewat API), dan
di Trizone disimpan terenkripsi.

| RPC | Arah | Isi |
|---|---|---|
| `terima_data(p)` | toko → kantor | `{protokol: 1, kode_toko, kunci, app_version, dikirim_at, shifts: [{shift, sales}], dokumen: {receptions, transfers, opnames}, snapshot: {created_at, products, inventory, reception_drafts, offline_sales, current_shift}}`. Satu panggilan = satu transaksi. Balasan berisi `shift_diterima`; Trizone baru menandai terkirim setelah balasan. |
| `ambil_master(p)` | kantor → toko | `{kode_toko, kunci, sejak}` → barang yang berubah sejak `sejak` (SKU, barcode, nama, merk, kategori, harga jual, satuan masuk, rasio isi). |

Aturan penerapan:
- Penjualan disimpan per shift. Data tutup shift menggantikan potongan shift berjalan, dan shift yang sudah tertutup tidak bisa dibuka lagi oleh data yang lebih lama.
- Snapshot yang lebih lama dari yang sudah ada dilewati, jadi stok tidak mundur.
- Penerimaan, mutasi, dan stok opname ditambah atau diperbarui, tidak pernah dihapus. SO baru atau berubah masuk antrean review.
- Kiriman ulang selalu aman: tidak ada data yang dobel.

## Pasang

1. **Supabase.** Buat project, jalankan migrasi lalu `seed.sql` (SQL Editor atau `supabase db push`).
2. **Markup harga jual ke toko** (tidak disimpan di repo karena repo ini publik):
   `insert into pengaturan values ('markup_jual_ke_toko', '0.06');` (ganti angkanya).
3. **Kunci toko**, sekali per toko: `select buat_kunci_toko('KRP');`. Kunci hanya tampil sekali; jalankan
   lagi untuk mengganti (kunci lama langsung tidak berlaku).
4. **Di Trizone** (PC Gudang / Mandiri, login Admin): **Pengaturan → Mother Base**. Isi alamat project
   (`https://<project>.supabase.co`), anon key, kode toko, dan kunci toko, lalu **Simpan** dan **Tes Koneksi**.
   Shift di Riwayat Shift (4 hari terakhir) ikut terkirim.
5. **Master barang** (saat siap mengunci daftar barang): `select isi_master_dari_toko('KRP');` mengisi
   master dari daftar barang satu toko. Rapikan harga dan barcode di tabel `produk`, lalu centang
   **Kunci daftar barang** di Trizone dan tekan **Ambil Master Barang**.
6. **Alert harian.** Buka script.google.com dengan akun kantor, tempel `apps-script/Code.gs`, isi Script
   Properties `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `EMAIL_ALERT`, lalu jalankan `setup()` sekali.

## Surat jalan dari Accurate

1. Di Accurate, ekspor laporan **Rincian Pengiriman Pesanan** ke Excel.
2. Dari folder repo (setelah `npm install`):
   ```bash
   node motherbase/accurate/accurate-do.js "Rincian Pengiriman Pesanan.xlsx" --out hasil
   ```
   Hasilnya `surat_jalan.json` dan satu `Penerimaan_<pelanggan>.xlsx` per pelanggan.
3. Kirim `Penerimaan_<pelanggan>.xlsx` ke toko. Staf toko mengimpornya di **Penerimaan Barang → Import**
   Trizone, menyesuaikan jumlah dengan hitungan fisik, lalu menyimpan.
4. Masukkan surat jalan ke mother base: tambahkan `--kirim` (env `SUPABASE_URL` dan `SUPABASE_KEY`), atau
   panggil RPC `import_surat_jalan` dengan isi `surat_jalan.json`.

Satuan: `Pcs`/`Biji` = 1 Biji. Satuan kemasan (`Coly`, `Dus`) ditulis `Dus` di file Trizone dan dikali
**Rasio Isi** satuan masuk barang itu di Trizone. Mother base memakai rasio yang sama, jadi isi satuan
di Trizone harus sama dengan di Accurate.

Nama pelanggan Accurate dipetakan ke kode toko di tabel `pelanggan_accurate` ("X Special" = toko yang
sama dengan "X"). Surat jalan untuk pelanggan yang belum dipetakan berstatus `PELANGGAN_BELUM_DIPETAKAN`.

## View utama

| View | Isi |
|---|---|
| `v_ringkasan_harian` | Omzet, transaksi, Tunai/QRIS/Transfer per toko per tanggal |
| `v_penjualan_kasir`, `v_permintaan_harian` | Per kasir; permintaan kasir + terjual di Shopee |
| `v_pencocokan_sj` | Status setiap surat jalan: `COCOK`, `MENUNGGU`, `BELUM_DIINPUT`, `SELISIH_QTY`, `BARANG_SALAH`, `SATUAN_BELUM_JELAS`, `PELANGGAN_BELUM_DIPETAKAN` |
| `v_sj_tidak_dikenal` | Penerimaan toko yang nomornya tidak ada di data kantor |
| `v_stok_seharusnya`, `v_selisih_snapshot` | Stok per zona sejak SO yang disetujui, dan selisihnya terhadap stok Trizone |
| `v_selisih_so` | Selisih SO dan nilai rupiahnya |
| `v_usulan_beli` | Usulan beli per produk ke principal |

## Uji

```bash
npm install
node motherbase/test/uji.js
```

Dengan PostgreSQL 15+ lokal (membuat database `mb_uji` baru):

```bash
MB_PSQL="psql -h localhost -U postgres" node motherbase/test/uji.js
```
