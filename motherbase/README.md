# Mother Base

Pusat data PT kantor di atas Supabase, untuk 9 toko POS Tri-Zone. Mother base membaca
**paket Homebase** (`TRZ_*.json.gz`, format v1 di [docs/HOMEBASE.md](../docs/HOMEBASE.md)) yang
sudah dibuat Trizone setiap tutup shift dan tiap jam, lalu menambahkan yang tidak ada di Homebase:
surat jalan dari Accurate dan pencocokannya, stok seharusnya per zona, dan usulan beli.

Aplikasi POS di toko tidak perlu diubah untuk menerima data. Perubahan Trizone yang masih
diperlukan ada di bagian [Perubahan Trizone](#perubahan-trizone).

```
 Toko (Trizone)                         Mother base
 ┌────────────────────┐   TRZ_*.json.gz   ┌──────────────────────────────┐
 │ tutup shift / jam  ├─► Google Drive ──►│ Apps Script (tiap 10 menit)  │
 │                    ├─► email ─────────►│   → RPC ingest_paket         │
 └────────────────────┘                   │ Supabase (PostgreSQL)        │
 Kantor (Accurate)                        │   tabel toko, kantor, view   │
 Rincian Pengiriman Pesanan.xlsx ────────►│   → RPC import_surat_jalan   │
   accurate-do.js ──► Penerimaan_*.xlsx ─► import penerimaan di Trizone  │
                                          └──────────────────────────────┘
```

## Isi folder

| Path | Isi |
|---|---|
| `supabase/migrations/20261116000001_mother_base.sql` | Skema: tabel, aturan impor paket, view hitungan, RPC, Row Level Security |
| `supabase/seed.sql` | Data awal: 9 toko, pemetaan pelanggan Accurate, pengaturan |
| `supabase/tests/stub_supabase.sql` | Peniru `auth.uid()` dan peran Supabase untuk uji di PostgreSQL biasa |
| `apps-script/Code.gs` | Penerima paket dari Gmail dan Google Drive |
| `accurate/accurate-do.js` | Pembaca laporan Accurate "Rincian Pengiriman Pesanan" |
| `test/uji.js` | Uji dari ujung ke ujung memakai kode Trizone asli |

## Pasang

1. **Supabase.** Buat project, jalankan migrasi lalu `seed.sql` (SQL Editor atau `supabase db push`).
2. **Akun Google mother base.** Buat akun khusus. Buka script.google.com, buat project, tempel
   `apps-script/Code.gs`.
3. **Script Properties:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `EMAIL_ALERT`, dan
   `DRIVE_FOLDER_ID` bila memakai jalur Google Drive.
4. Jalankan `setup()` sekali dan beri izin.
5. **Di tiap toko**, pilih salah satu atau keduanya:
   - Google Drive: bagikan folder `POS-Homebase` toko ke akun mother base, atau pakai satu folder
     bersama milik akun mother base (lihat docs/HOMEBASE.md bagian 1). Isi `DRIVE_FOLDER_ID`.
   - Email: isi email toko di `toko.email_pengirim`, dan jadikan alamat Gmail mother base sebagai
     email owner (atau tambahan penerima) di Pengaturan Trizone.
6. **Hubungkan toko.** Paket pertama dari toko yang belum dikenal ditahan dengan status
   `MENUNGGU_TOKO`, dan kantor mendapat email berisi ID toko. Jalankan
   `select hubungkan_toko('TRP', '<ID toko>');`. Semua paket toko itu yang sudah masuk langsung
   diproses.

## Surat jalan dari Accurate

1. Di Accurate, ekspor laporan **Rincian Pengiriman Pesanan** ke Excel.
2. Jalankan dari folder repo (setelah `npm install`):
   ```bash
   node motherbase/accurate/accurate-do.js "Rincian Pengiriman Pesanan.xlsx" --out hasil
   ```
   Hasilnya `surat_jalan.json` dan satu `Penerimaan_<pelanggan>.xlsx` per pelanggan.
3. Kirim file `Penerimaan_<pelanggan>.xlsx` ke toko. Staf toko mengimpornya di menu
   **Penerimaan Barang → Import** Trizone, menyesuaikan jumlah dengan hitungan fisik, lalu menyimpan.
4. Masukkan surat jalan ke mother base: tambahkan `--kirim` (dengan env `SUPABASE_URL` dan
   `SUPABASE_KEY`), atau panggil RPC `import_surat_jalan` dengan isi `surat_jalan.json`.

Aturan satuan: `Pcs`/`Biji` = 1 Biji. Satuan kemasan (`Coly`, `Dus`) ditulis `Dus` di file Trizone
dan dikali **Rasio Isi** satuan masuk barang itu di Trizone. Mother base memakai rasio yang sama,
jadi isi satuan di Trizone harus sama dengan di Accurate.

Nama pelanggan Accurate dipetakan ke kode toko di tabel `pelanggan_accurate` ("X Special" = toko
yang sama dengan "X"). Surat jalan untuk pelanggan yang belum dipetakan berstatus
`PELANGGAN_BELUM_DIPETAKAN`.

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

Dengan PostgreSQL 15+ lokal, uji juga databasenya (membuat database `mb_uji` baru):

```bash
MB_PSQL="psql -h localhost -U postgres" node motherbase/test/uji.js
```

## Perubahan Trizone

Data sudah lengkap di paket Homebase. Yang masih perlu diubah di aplikasi POS:

| # | Perubahan | Alasan |
|---|---|---|
| 1 | Metode bayar `Kartu Debit` diganti `Transfer` | Keputusan 16 Nov 2026. Data lama "Kartu Debit" sudah dihitung sebagai Transfer di mother base. |
| 2 | Riwayat Shift disimpan 4 hari (sekarang hari ini + kemarin) | Cadangan bila paket/email gagal saat akhir pekan |
| 3 | Tutup shift tetap bisa tanpa internet: paket sudah tertulis, email dikirim menyusul | Toko online sesekali; paket di Google Drive tersalin saat internet kembali |
| 4 | Kunci master barang dan harga jual; perubahan hanya lewat import dari mother base (tahap 2) | Kode dan harga seragam di 9 toko |
