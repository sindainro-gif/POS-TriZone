# Homebase — pusat data POS Tri-Zone

Homebase adalah tempat pusat yang menyimpan data dari **satu atau banyak toko**: riwayat penjualan (yang di POS hanya disimpan sampai akhir hari berikutnya setelah tutup shift), stok terakhir 4 zona, barang, penerimaan, mutasi, dan stok opname. Homebase memakai aplikasi yang sama dalam mode **HOMEBASE** (`Jalankan HOMEBASE.bat`), sehingga bisa dijalankan di PC mana pun, misalnya di rumah atau kantor owner.

```
 PC Gudang / Mandiri (tiap toko)                    PC Homebase
 ┌─────────────────────────────┐                    ┌──────────────────────────┐
 │ pos.db                      │  paket TRZ_*.json.gz│ homebase.db              │
 │  └─ tutup shift / tiap jam ─┼──► folder Google ──►│  Ringkasan, Penjualan,   │
 │     → folder paket lokal    │     Drive (otomatis)│  Stok, Dokumen, Excel    │
 │                             ├──► lampiran email ─►│  (Impor File…)           │
 └─────────────────────────────┘                    └──────────────────────────┘
```

## 1. Cara memasang

### Di toko (PC Gudang, atau PC Mandiri)

Paket hanya dibuat oleh komputer yang menyimpan database. PC Kasir tidak perlu diatur.

1. Pasang **Google Drive for desktop**, lalu login.
2. Di Google Drive, buat folder bersama, misalnya `POS-Homebase`.
   - Bila toko memakai akun Google yang berbeda dari owner, owner membagikan folder itu ke akun toko (akses **Editor**).
   - Di Drive web, akun toko memilih **Tambahkan pintasan ke Drive** agar folder itu muncul di Google Drive for desktop.
3. Di aplikasi POS (login sebagai Admin): **Pengaturan → Homebase (Pusat Data)**.
   - **Pilih Folder…**: pilih folder `POS-Homebase` di drive Google Drive (biasanya `G:\My Drive\POS-Homebase`). Boleh dibuatkan subfolder per toko.
   - Centang **Lampirkan paket data di email tutup shift** (aktif secara bawaan) bila paket juga ingin dikirim lewat email.
   - **Kirim Data Sekarang**: membuat paket pertama saat itu juga.
   - **Sertakan Riwayat Penjualan Lama…** (cukup sekali): penjualan sebelum ada Homebase dibaca dari CSV di folder laporan tutup shift.

### Di Homebase

1. Pasang Google Drive for desktop dengan akun owner.
2. Jalankan **`Jalankan HOMEBASE.bat`**. Data Homebase disimpan di `%APPDATA%\POS Tri-Zone HOMEBASE\homebase.db`, dengan cadangan harian di subfolder `backup/` (14 terakhir).
3. Buka **Impor & Pengaturan → Pilih Folder…** dan pilih folder Google Drive yang sama. Folder ini dan subfoldernya (2 tingkat) diperiksa otomatis setiap menit.
4. Untuk paket dari email: simpan lampiran `TRZ_….json.gz`, lalu pilih **Impor File…**.
5. Opsional: **Atur PIN…** agar Homebase meminta PIN 6 digit setiap kali dibuka.

Paket yang sama tidak pernah dihitung dua kali, walaupun sampai lewat Google Drive **dan** email.

## 2. Kapan paket dibuat

| Saat | Paket |
|---|---|
| Tutup shift | `shift` (penjualan shift) + `snapshot` (semua data). Keduanya ditulis **sebelum** email dikirim, jadi penjualan tetap terarsip walau email gagal. Gagal menulis paket = shift tidak ditutup. |
| 20 detik setelah aplikasi dibuka, lalu tiap jam | `snapshot`, hanya bila datanya berubah sejak snapshot terakhir. Termasuk penjualan shift yang masih berjalan. |
| Tombol **Kirim Data Sekarang** | `snapshot` |
| Tombol **Sertakan Riwayat Penjualan Lama…** | Satu `shift` (riwayat lama) per folder laporan lama |

- **Folder paket lokal:** `Dokumen\POS-Homebase\Paket`.
  - Semua paket shift disimpan selamanya (ukurannya kecil). Snapshot disimpan 10 terakhir.
  - Paket disalin ke folder Google Drive saat dibuat. Yang gagal tersalin (misalnya drive G: belum siap) dicoba lagi tiap 10 menit.
  - Di folder Google Drive hanya disisakan snapshot terbaru milik toko itu.
- **Folder laporan:** setiap folder tutup shift di `Dokumen\POS-Laporan\Shift_*` mendapat file `homebase.json`. Tanda ini membuat penjualannya tidak diambil lagi sebagai riwayat lama.
- **Versi DEMO:** paket ditulis ke folder data demo dan **ditolak** oleh Homebase.

## 3. Inventaris data POS

| Data | Lokasi | Ikut ke Homebase? |
|---|---|---|
| Barang (`products`), stok 4 zona (`inventory`) | pos.db | Ya, keadaan terkini |
| Penerimaan + item, draft barang belum terdaftar | pos.db | Ya, seluruh riwayat |
| Mutasi (dokumen + baris), stok opname (dokumen + baris) | pos.db | Ya, seluruh riwayat |
| Penjualan shift (`shift_sales`, `active_shift`) | pos.db. Saat tutup shift dipindah ke Riwayat Shift (`shift_history`, `shift_history_sales`), disimpan hari ini & kemarin, lalu dihapus otomatis | Ya: paket `shift` saat tutup, dan shift berjalan di dalam snapshot |
| Transaksi mode darurat yang diterima gudang (`offline_sales`) | pos.db | Ya |
| Akun (`users`) | pos.db | Hanya nama, peran, aktif, dan tanggal dibuat. **Tanpa hash PIN.** |
| Desain label, pengaturan toko (nama, alamat, header/footer nota) | pos.db | Ya |
| Password/akun SMTP, email owner, kode pasangan LAN, `checkout_refs`, nomor urut struk | pos.db / device.json | **Tidak** (rahasia atau teknis) |
| `device.json` (printer, mode), `drafts.json`, cache/antrian darurat PC Kasir, `backup/*.db` | per komputer | Tidak (lokal/sementara; antrian darurat sudah masuk ke PC Gudang) |
| Laporan lama `Dokumen\POS-Laporan\Shift_*\Penjualan_Shift_*.csv` | folder laporan | Ya, lewat tombol **Sertakan Riwayat Penjualan Lama…** |

## 4. Format paket (versi 1)

- **Nama file:** `TRZ_<8 karakter ID toko>_<YYYYMMDD-HHMMSS>_<snapshot|shift>[_<8 karakter ID shift>].json.gz`
- **Isi file:** JSON UTF-8 yang di-gzip.
- **Satuan:** jumlah barang selalu dalam **Biji**, uang dalam **Rupiah bulat**.
- **Waktu:** waktu lokal PC toko, format `YYYY-MM-DD HH:MM:SS`.
- **Kode zona:**
  - Zona stok: `floor` (Display Toko), `warehouse` (Gudang Utama), `damaged` (Gudang BS), `shopee` (Gudang Shopee).
  - Asal/tujuan luar (hanya di mutasi): `customer` (retur pelanggan), `supplier` (retur ke supplier), `disposed` (dibuang), `shopee_sold` (terjual di Shopee).

### Amplop (semua paket)

| Field | Isi |
|---|---|
| `format` | `"pos-trizone-homebase"` |
| `version` | `1`. Homebase menolak versi yang lebih baru dari yang dikenalnya ("perbarui Homebase"). |
| `kind` | `"snapshot"` atau `"shift"` |
| `package_id` | UUID unik per paket |
| `created_at` | Waktu paket dibuat |
| `store` | `{ id, name, address }`. `id` = UUID toko (`settings.store_id`), ikut ke file cadangan database. |
| `source` | `{ app_version, device_mode, demo, legacy }`. `legacy` = paket dari laporan lama. |
| `counts` | Jumlah baris per daftar (untuk pengecekan) |
| `data` | Isi paket (lihat di bawah) |

### `kind: "snapshot"` — semua data terkini

| Daftar | Field |
|---|---|
| `settings` | `store_name`, `store_address`, `receipt_header`, `receipt_footer` |
| `zones`, `payment_methods` | Label zona dan metode bayar yang dipakai versi POS itu |
| `products[]` | `sku`, `barcode`, `name`, `brand`, `category`, `unit_price` (per Biji), `base_unit`, `pack_unit`, `pack_ratio` (Biji per satuan masuk), `created_at` |
| `inventory[]` | `sku`, `floor_stock`, `warehouse_stock`, `damaged_stock`, `shopee_stock` (boleh minus), `min_floor_alert`, `sold_out_at` |
| `receptions[]` | `reference_no` (No. Surat Jalan), `supplier_name`, `notes`, `received_at`, `total_items_count`, `items[]` |
| `receptions[].items[]` | `line_no`, `sku`, `qty` (Biji), `pack_type` (satuan saat input: Dus/Biji), `destination` (zona) |
| `reception_drafts[]` | `draft_id`, `reference_no`, `supplier_name`, `notes`, `code`, `name`, `qty`, `pack_type`, `destination`, `source` (manual/import), `created_at`, `resolved_at`, `reception_reference_no` |
| `transfers[]` | `doc_no` (MT-…), `from_zone`, `to_zone`, `reason`, `created_at`, `line_count`, `total_qty`, `lines[]` (`line_no`, `sku`, `qty`) |
| `opnames[]` | `doc_no` (OP-…), `zone`, `notes`, `created_at`, `count_at` (Tanggal_Stok di file), `line_count`, `plus_qty`, `minus_qty`, `lines[]` |
| `opnames[].lines[]` | `line_no`, `sku`, `system_qty`, `counted_qty`, `diff`, `before_qty` |
| `offline_sales[]` | `receipt_no` (OFF-…), `client_ref`, `cashier_name`, `created_at`, `synced_at`, `total`, `status` (ok/check/duplicate), `notes`, `checked_at` |
| `users[]` | `name`, `role` (admin/gudang/kasir), `active`, `created_at` |
| `label_designs[]` | `name`, `config` (objek desain label), `is_default`, `updated_at` |
| `current_shift` | `null`, atau `{ shift_uid, cashier_name, shift_start, sales[] }` untuk shift yang masih berjalan |

### `kind: "shift"` — penjualan satu shift

| Field | Isi |
|---|---|
| `shift` | `shift_uid`, `cashier_name`, `shift_start`, `closed_at`, `notes`, `receipts`, `qty`, `revenue`, `cash_sales`, `by_method[]` (`method`, `receipts`, `total`), `offline_receipts`, `legacy` (riwayat lama) |
| `sales[]` | `receipt_no`, `line_no` (urutan baris di struk), `created_at`, `sku`, `product_name`, `qty`, `unit_price`, `line_total`, `payment_method` |

Riwayat lama memakai `shift_uid = legacy-<hash ID toko + nama folder>` dan kasir `(riwayat lama)`. Struk yang muncul di beberapa folder laporan (tutup shift yang email-nya gagal lalu diulang) hanya dihitung di folder **terakhir**.

## 5. Aturan impor Homebase

Setiap paket diimpor dalam satu langkah. Mengimpor ulang selalu aman.

1. **File yang sama persis** (sha256 sama) dilewati.
2. **Paket DEMO** ditolak. **File rusak atau belum selesai tersalin** dicatat "Gagal", lalu dicoba lagi otomatis setelah isinya berubah.
3. **Snapshot:**
   - **Keadaan terkini** (barang, stok, akun, desain label, draft, pengaturan) **diganti** untuk toko itu. Barang yang dihapus di toko ikut hilang di Homebase.
   - **Riwayat** (penerimaan, mutasi, opname, transaksi darurat) ditambah atau diperbarui, dan **tidak pernah dihapus**.
   - Snapshot yang lebih lama dari snapshot terakhir toko itu hanya menambah riwayat (status "Lama"), jadi stok tidak mundur.
4. **Penjualan disimpan per shift.** Data shift dari paket yang lebih baru menggantikan seluruh baris shift itu, sehingga tidak ada dobel. Contoh: email gagal lalu shift ditutup ulang, atau shift berjalan di snapshot lalu ditutup oleh paket shift.
5. **Hapus Data toko** (Impor & Pengaturan) menghapus semua data toko itu dari Homebase. Catatan impornya tetap disimpan, jadi file lama tidak diimpor ulang otomatis.

## 6. Skema `homebase.db`

Semua tabel data memakai `store_id` sebagai bagian dari kunci, sehingga banyak toko bisa disimpan berdampingan.

| Tabel | Kunci | Isi |
|---|---|---|
| `stores` | `store_id` | Nama, alamat, versi POS, waktu paket/snapshot/tutup shift terakhir |
| `imports` | `id`, `sha256` unik | Riwayat impor: file, asal, toko, jenis, status (ok/old/error), pesan |
| `products`, `stock` | `store_id, sku` | Keadaan terkini dari snapshot terakhir. `stock.as_of` = waktu snapshot itu. |
| `shifts` | `store_id, shift_uid` | Ringkasan shift. `closed_at` kosong = masih berjalan. `package_at` = waktu paket yang menang. |
| `sales` | `store_id, shift_uid, receipt_no, line_no` | Baris penjualan. Index: `(store_id, created_at)` dan `(store_id, sku)`. |
| `receptions` / `reception_items` | `store_id, reference_no` (+`line_no`) | Penerimaan |
| `transfers` / `transfer_lines` | `store_id, doc_no` (+`line_no`) | Mutasi |
| `opnames` / `opname_lines` | `store_id, doc_no` (+`line_no`) | Stok opname |
| `reception_drafts`, `offline_sales`, `users`, `label_designs` | `store_id` + kunci masing-masing | Salinan data toko |
| `settings` | `key` | Folder masuk, hash PIN Homebase |

Definisi lengkap ada di `src/homebase-store.js` (`SCHEMA`). SQL-nya sederhana (tanpa fitur khusus SQLite selain `INSERT OR REPLACE`), sehingga bisa dipindah ke PostgreSQL atau MySQL.

### Pindah ke server / cloud nanti

Format paket di atas adalah "kontrak" antara toko dan Homebase. Untuk memindahkan Homebase ke server online:
- Buat tabel yang sama di database server.
- Pasang importir yang membaca paket `TRZ_*.json.gz` dan mengikuti aturan bagian 5. Paketnya bisa dari folder Google Drive, upload, atau email.
- Aplikasi POS di toko tidak perlu diubah.
- Data lama bisa dipindahkan dari `homebase.db`, atau dengan mengimpor ulang semua paket shift dari folder paket di tiap toko.

## 7. Catatan & batasan

- **ID toko** tersimpan di database toko. Bila membuka cabang baru dari cadangan database toko lain, tekan **Pengaturan → Homebase → Ganti ID Toko…** di cabang baru. Tanpa itu, Homebase menganggap keduanya toko yang sama.
- **Nomor dokumen** (MT-/OP-/No. SJ) adalah kunci riwayat. Setelah database toko dipulihkan dari cadangan lama, dokumen baru yang kebetulan bernomor sama akan menggantikan dokumen lama di Homebase.
- **Waktu** memakai jam lokal PC toko. Pastikan jam PC benar.
- **Ukuran data:** `homebase.db` dimuat penuh ke memori (sql.js), sama seperti database POS. Ini cukup untuk bertahun-tahun data beberapa toko. Bila nanti terasa berat, pindahkan ke server (bagian 6).
- **PIN Homebase** hanya mengunci tampilan aplikasi. File `homebase.db` sendiri tidak dienkripsi, jadi lindungi juga akun Windows-nya.
