# POS Tri-Zone — POS Desktop Offline

Aplikasi kasir offline (Electron + SQLite lokal) dengan inventaris per zona: **Display Toko**, **Gudang Utama**, **Gudang BS / Retur**, dan **Gudang Shopee** (stok online terpisah, tidak dijual di kasir; keluar lewat mutasi "Gudang Shopee → Terjual di Shopee").

## Menjalankan

```bash
npm install
node node_modules/electron/install.js   # hanya jika biner Electron belum terunduh
npm start
```

Membuat installer Windows (.exe): klik **`Buat Installer.bat`** (menjalankan `npm test` lalu `npm run dist`) → hasil `dist\POS Tri-Zone Setup <versi>.exe`.

## Pasang & update di toko

Komputer toko memakai **installer .exe** (tidak perlu Node.js, Git, atau akses GitHub). Data toko ada di `%APPDATA%\POS Tri-Zone` dan **tidak tersentuh** saat aplikasi dipasang ulang atau di-update.

**Pasang pertama kali**
1. Salin `POS Tri-Zone Setup <versi>.exe` ke PC (flashdisk / Google Drive), lalu jalankan. Installer belum bertanda tangan digital, jadi Windows bisa menampilkan "Windows protected your PC" → klik **More info → Run anyway**.
2. Pasang di **PC Server dulu**, lalu di PC Kasir. Buka aplikasi lewat shortcut di Desktop / Start menu.
3. Atur **Pengaturan → Mode Komputer & Jaringan** (lihat bagian dua komputer di bawah).

**Update (setelah tutup shift / sebelum toko buka)**
1. Tutup shift. Bila mau, Admin menekan **Pengaturan → Cadangkan Database…** (cadangan harian otomatis juga ada).
2. Tutup aplikasi POS di semua komputer.
3. **PC Server dulu:** jalankan installer versi baru (Next → Install, folder sama). Buka aplikasi, cek **Pengaturan → Informasi → Versi aplikasi**.
4. Lalu PC Kasir: jalankan installer yang sama.
5. Selama versi PC Kasir berbeda dengan PC Server, kotak status koneksi di PC Kasir menampilkan **⚠ Versi beda** (transaksi tetap jalan). Pasang versi yang sama di semua komputer.
- **Bila ada masalah setelah update:** pasang lagi installer versi sebelumnya (simpan 2 installer terakhir).
- **Bila rilis juga mengubah aplikasi kantor (folder `motherbase/`):** terapkan migrasi mother base di Supabase **sebelum** toko di-update.

**Alur rilis (pengembang)**
1. Kerjakan & uji di branch `motherbase` (`npm test`, `npm run smoke`, `smoke:lan`, `smoke:demo`), naikkan `version` di `package.json`.
2. Gabungkan ke `main` (`main` = versi yang terpasang di toko) dan beri tag `v<versi>`, lalu push.
3. Klik `Buat Installer.bat`, kirim `dist\POS Tri-Zone Setup <versi>.exe` ke toko.
- Bila `npm run dist` gagal dengan *"Cannot create symbolic link : A required privilege is not held"* (alat `winCodeSign`): ekstrak arsip `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<angka>.7z` ke folder `winCodeSign-2.6.0` di tempat yang sama (`node_modules\7zip-bin\win\x64\7za.exe x <arsip> -o<folder>`; 2 error symlink macOS boleh diabaikan), lalu jalankan lagi. Cara lain: aktifkan Developer Mode Windows.

## Versi DEMO (latihan)

Klik dua kali **`Jalankan DEMO.bat`**. Versi ini untuk latihan kasir dan mencoba fitur tanpa mengganggu data toko asli.

- **Data terpisah:** data disimpan di `%APPDATA%\POS Tri-Zone DEMO`. Bisa dibuka bersamaan dengan aplikasi asli.
- **Data contoh:** 30 barang siap pakai (ada yang stok menipis, habis, dan ada stok BS), 2 penerimaan, 3 mutasi, dan desain label.
- **Akun latihan** (tertulis juga di layar login; klik untuk mengisi):

  | Akun | Peran | PIN |
  |---|---|---|
  | Admin | Admin | 111111 |
  | Gudang | Gudang | 222222 |
  | Kasir | Kasir | 333333 |

- **Tanda DEMO:** kotak DEMO oranye di sidebar dan bingkai oranye di layar. Nota bertuliskan `** DEMO - BUKAN NOTA ASLI **`.
- **Printer sungguhan, tanpa kirim data:** nota dan label dicetak ke printer yang dipilih (printer nota di Pengaturan, printer label di kanan bawah layar Cetak Barcode). Nota bertanda DEMO. Pengaturan printer demo terpisah dari aplikasi asli, jadi pilih printernya sekali di demo. Tutup shift membuat file laporan di `Laporan-Demo`; versi DEMO tidak pernah mengirim data ke mother base.
- **Reset Data** mengembalikan semua data latihan ke kondisi awal.
- Versi demo selalu berjalan **Mandiri**; mode Server/Kasir hanya di aplikasi asli.
- Uji otomatis: `npm run smoke:demo`.

## Mother Base (pusat data kantor)

PC Gudang / Mandiri mengirim data toko langsung ke **mother base** (database Supabase milik kantor) lewat internet. Kantor memakai aplikasi web mother base (penjualan, surat jalan Accurate, stok opname, master barang, pembelian, asisten AI). Kode dan cara pasang ada di folder [`motherbase/`](motherbase/README.md).

- **Yang dikirim:** penjualan setiap tutup shift, penerimaan, mutasi, stok opname, transaksi mode darurat, daftar barang, stok 4 zona, dan pesanan pelanggan (semua yang belum diambil, plus yang diambil / batal dalam 60 hari terakhir). Shift yang masih berjalan juga ikut, jadi omset hari ini sudah terlihat di kantor (sebaru kiriman terakhir).
- **Jadwal kiriman:** sekali ±20 detik setelah aplikasi dibuka, lalu **tiap 3 jam** (hanya bila ada yang menunggu / berubah). **Tutup shift** langsung mengirim saat itu juga. Admin bisa menekan **Kirim Sekarang** kapan saja.
- **Master barang** (barang & harga dari mother base) **tidak diambil berkala**: hanya **setiap buka shift** (di latar, kasir tidak menunggu, termasuk shift yang dibuka dari PC Kasir) bila daftar barang dikunci, atau manual lewat **Perbarui Daftar Barang** / **Ambil Master Barang**.
- **Tanpa internet:** toko tetap jalan. Penjualan shift masuk antrean di `pos.db` dalam transaksi yang sama dengan tutup shift, dan dokumen ditandai terkirim hanya setelah mother base membalas. Pengiriman dicoba lagi otomatis tiap 3 jam (atau Kirim Sekarang); kiriman ulang tidak membuat data dobel.
- **Pengaturan:** **Pengaturan → Mother Base** (Admin, di PC Gudang / Mandiri): alamat mother base, anon key, kode toko 3 huruf, dan kunci toko dari kantor. Tombol **Tes Koneksi**, **Kirim Sekarang**, **Ambil Master Barang**.
- **Perbarui Daftar Barang (semua pengguna):** tombol **Perbarui Daftar Barang** di halaman **Daftar Barang** mengambil master barang dari mother base dan bisa ditekan Admin, Gudang, maupun Kasir, termasuk dari PC Kasir (diteruskan ke PC Gudang). Tidak tampil di versi DEMO.
- **Disembunyikan dari pegawai:** layar kerja (Laporan Shift, tutup shift, Daftar Barang, layar login) tidak menyebut mother base maupun data cadangan, termasuk untuk akun Admin. Pesannya netral, misalnya "Daftar barang diperbarui" dan "Daftar barang belum bisa diperbarui". Status kiriman, antrean, dan error hanya terlihat di **Pengaturan → Mother Base** (Admin).
- **Kunci daftar barang:** bila dicentang, barang baru, nama, barcode, merk, kategori, harga, dan satuan masuk hanya berubah lewat master barang dari mother base (diambil otomatis setiap buka shift). Batas minimum display toko tetap bisa diubah di toko. Stok tidak pernah diubah oleh master barang.
- **Tidak ikut:** password, PIN, kode pasangan.
- Versi DEMO tidak mengirim data.
- Uji otomatis: `node test/motherbase.test.js` (dengan mother base tiruan) dan `node motherbase/test/uji.js` (dengan PostgreSQL).

## Mengedit program dari komputer lain (git)

Kode program ada di repo git (`main`). Data toko **tidak** ikut, karena ada di `%APPDATA%\POS Tri-Zone`. `node_modules`, `dist`, dan cadangan database juga diabaikan lewat `.gitignore`.

**Satu kali di komputer lain**
1. Install **Node.js LTS**, **Git for Windows**, dan aplikasi **Claude** (Code).
2. Clone repo dari GitHub, lalu `npm install` di foldernya. Bila Electron belum terunduh, jalankan `node node_modules/electron/install.js`.
3. Isi nama & email git: `git config --global user.name "Nama"` dan `git config --global user.email "email@contoh.com"`.
4. Buka folder itu di Claude (Code), lalu coba `npm test` dan `Jalankan POS.bat`.

**Setiap kali mengedit (di komputer mana pun)**
- Sebelum mulai: `git pull`, supaya memakai versi terbaru.
- Setelah selesai & tes lulus: `git add -A`, `git commit -m "keterangan"`, lalu `git push`.
- Jangan mengedit di dua komputer sekaligus tanpa pull/push. Bila terjadi bentrok (conflict), minta Claude membereskannya.

## Pengujian

```bash
npm test          # tes Node: logika bisnis, nota, label, database, jaringan, mode darurat
npm run smoke:lan # uji dua komputer (gudang + kasir), termasuk MODE DARURAT & sinkron ulang
npm run smoke     # uji UI Electron + screenshot (database sementara)
```

## Struktur

| File | Isi |
|---|---|
| `src/db.js` | Skema SQLite (sql.js/WASM, tanpa kompilasi native), transaksi, simpan atomik, backup harian |
| `src/auth.js` | Hash PIN (scrypt) & pencocokan login, dipakai server dan login darurat kasir |
| `src/services.js` | Logika bisnis: produk, import, kasir, mutasi, penerimaan, shift, pengaturan |
| `src/main.js` | Proses utama Electron: IPC, import/template Excel, PDF, tutup shift & kirim ke mother base |
| `src/remote.js` | RPC HTTP LAN antara PC Gudang (server) dan PC Kasir (klien) |
| `src/offline.js` | Mode darurat PC Kasir: cache barang + antrian transaksi OFF- dan sinkron ulang |
| `src/reports.js` | CSV penjualan, CSV snapshot stok, HTML rekap (→ PDF) |
| `src/motherbase.js` | Kirim data ke mother base (RPC `terima_data`) dan ambil master barang (`ambil_master`) |
| `src/renderer/` | Antarmuka POS (`index.html`, `app.js`), utilitas bersama (`common.js`), gaya (`style.css`, gelap/terang) |
| `motherbase/` | Mother base: aplikasi web kantor, skema Supabase, Edge Function asisten AI, pembaca laporan Accurate, server dev, uji |

## Pencarian barang

Di layar Kasir, kursor selalu kembali ke kolom **scan barcode**. Kolom **Jumlah** terpisah di kirinya: tekan **Enter** saat kolom scan kosong untuk pindah ke Jumlah (atau tombol `*`), isi jumlah, lalu **Enter** lagi untuk kembali ke scan. Setelah barang masuk keranjang, Jumlah kembali ke 1 dan kursor tetap di kolom scan. Format lama `12*barcode` tidak dipakai lagi.

**Suara kasir (opsional):** tombol **🔇/🔊 Suara** di kanan kolom scan menyalakan atau mematikan pembacaan barang yang di-scan. Bawaannya mati.
- Tombol **⚙** di sebelahnya mengatur isi bacaan (**Nama barang**, atau **Nama + harga** seperti "Air Mineral 600ml, tiga ribu lima ratus"), pilihan suara, kecepatan, dan volume. Ada juga tombol **Tes Suara**.
- Pengaturan suara berlaku per komputer dan bisa diubah oleh kasir.
- Suara memakai suara Windows (offline). Agar pengucapannya Bahasa Indonesia, pasang **Microsoft Andika** lewat **Pengaturan Windows → Waktu & bahasa → Ucapan → Tambahkan suara → Bahasa Indonesia**, lalu buka ulang aplikasi. Suara ini dipilih otomatis. Tanpa suara Indonesia, aplikasi memakai suara bahasa Inggris bawaan Windows.
- Saat scan beruntun, yang dibacakan barang terakhir (bacaan sebelumnya dipotong).

**Pembayaran:** kasir hanya memakai **Tunai** (sejak 1.14.0 tidak ada pilihan QRIS / Transfer). Isi **Uang Diterima** (F12; F12 lagi = Uang Pas), kembalian dihitung otomatis. Transaksi QRIS / Transfer lama tetap tercatat apa adanya di laporan, dan transaksi darurat lama yang masih antre tetap diterima.

**Batal nota (persetujuan Admin):** di **Laporan Shift → Transaksi Shift Ini → Detail → Batalkan Nota**. Kasir mengisi alasan dan memilih stok tujuan per barang (Display Toko bila masih bagus, Gudang BS bila rusak), lalu **Admin mengetik PIN-nya** di komputer itu, atau kepala toko mengetik **PIN Pembatalan**. PIN Kasir / Gudang tidak berlaku.
- **PIN Pembatalan** diatur Admin di **Pengaturan → PIN Pembatalan Nota** (nama pemegang + PIN 6 digit; bisa ditampilkan, diganti, atau dihapus). Dengan PIN ini kepala toko bisa menyetujui batal nota tanpa mengetahui PIN Admin; nota pembatalan mencatat "<pemegang> (PIN Pembatalan)". PIN ini disimpan terenkripsi akun Windows dan tidak boleh sama dengan PIN login akun mana pun.
- Nota asli **tidak dihapus atau diubah**. Pembatalan dicatat sebagai nota baru `BTL-YYYYMMDD-NNNN` berisi baris minus: omset dan uang tunai berkurang, stok kembali, dan nota pembatalan tercetak (alasan + nama Admin).
- Hanya nota **shift yang sedang berjalan**; satu nota hanya bisa dibatalkan sekali. Tukar barang = batalkan nota, lalu buat transaksi baru.
- Pembatalan tampil di daftar transaksi (badge *Dibatalkan* / *Pembatalan*), di Rekap PDF tutup shift (bagian "Pembatalan Nota"), dan ikut terkirim ke mother base sebagai baris minus. Barang yang dikembalikan ke Gudang BS tercatat sebagai dokumen mutasi.
- Butuh PC Server (tidak tersedia saat MODE DARURAT).

**Jumlah barang:** kotak **Total Belanja** di layar Kasir menampilkan **Jumlah Barang** (total biji) dan **Jenis Barang** (jumlah barang berbeda) dengan angka besar, supaya kasir bisa mencocokkan dengan barang di meja sebelum menekan **Bayar**.

**Draft penjualan:** bila pelanggan belum siap bayar, klik **Tahan (Draft)** (boleh diberi nama pelanggan / catatan). Keranjang tersimpan di komputer kasir itu dan layar kosong untuk pelanggan berikutnya. **Daftar Draft** menampilkan semua draft; **Lanjutkan** memasukkan isinya kembali ke keranjang (keranjang yang sedang berisi bisa ditahan otomatis dulu). Stok tidak dipesan: harga & stok dicek ulang saat dilanjutkan dan saat bayar. Draft tetap ada walau aplikasi ditutup, juga saat MODE DARURAT.

**Pesanan pelanggan (barang dipesan / belum dibawa):** isi keranjang seperti biasa, lalu klik **Jadikan Pesanan** (di bawah Tahan / Daftar Draft).
- Isi **Nama pelanggan*** dan No. HP, **Tanggal barang diambil*** (bawaan besok), **Uang deposit** (tombol cepat Tanpa / 50% / Lunas), dan Catatan. Enter = pindah ke kolom berikutnya.
- Saat pesanan disimpan, **stok belum dipotong**. Harga dikunci saat pesan. Nomor pesanan `PSN-YYYYMMDD-NNNN`. **Bukti pesanan** (No. Pesanan, tanggal ambil, barang, Total / Deposit / Sisa bayar) tercetak otomatis di printer nota, mengikuti "Cetak nota otomatis".
- **Deposit bukan omset.** Deposit masuk laci shift yang sedang berjalan. Omset dihitung penuh saat barang diambil.
- Menu **Pesanan Pelanggan** memiliki tab **Belum diambil**, Sudah diambil, Dibatalkan, dan Semua, plus kotak cari no. pesanan / nama / HP.
  - Tanggal ambil hari ini diberi tanda kuning, yang sudah lewat merah.
  - Angka merah di menu = jumlah pesanan yang waktunya diambil (hari ini / lewat).
  - Pesanan ikut terkirim ke mother base (menu **Pesanan Pelanggan** di aplikasi kantor), termasuk nama dan No. HP pelanggan.
  - **Detail** menampilkan isi pesanan dan tombol **Cetak Bukti** (cetak ulang).
- **Ambil:** pilih stok sumber, **Display Toko** atau **Gudang Utama**. Jumlah stok tiap barang di kedua zona ditampilkan. Kasir mengisi uang diterima untuk **sisa bayar** (total − deposit).
  - Dari Gudang Utama, stok dicatat sebagai mutasi `MT-…` "Pesanan PSN-… diambil pelanggan" ke Display Toko, lalu terjual.
  - Penjualannya tercatat sebagai nota `INV-…` biasa di shift itu (omset penuh, terkirim ke kantor seperti penjualan lain). Nota memuat No. Pesanan, Deposit, dan Sisa bayar.
- **Batalkan:** isi alasan, pilih deposit **Dikembalikan** (uang keluar dari laci shift berjalan) atau **Hangus**, lalu setujui dengan **PIN Admin / PIN Pembatalan**. Stok tidak berubah.
- **Kartu Tutup Shift dan Rekap** (layar, PDF, dan cetak di printer nota) menampilkan Deposit masuk / terpakai / dikembalikan / hangus dan **Uang tunai di laci**. Rumusnya: penjualan tunai − deposit terpakai + deposit masuk − deposit dikembalikan. Bagian ini hanya muncul bila shift itu punya transaksi pesanan.
- **Hak akses:** Kasir & Admin membuat, mengambil, dan membatalkan pesanan; Gudang hanya melihat daftar pesanan.
- Pesanan disimpan di PC Server, jadi tidak bisa dibuat atau diambil saat MODE DARURAT.
- Data pesanan dan deposit belum dikirim ke kantor (mother base). Penjualannya tetap terkirim saat barang diambil.

**Menjual melebihi display toko:** kasir selalu boleh menjual walaupun display toko di sistem kurang (barangnya ada di tangan pelanggan). Keranjang hanya menampilkan peringatan kuning, dan display toko menjadi 0 atau minus. Stok Gudang Utama dan Gudang BS tidak pernah dipotong. Barang yang display tokonya habis/minus muncul **merah dan paling atas** di **Mutasi → Saran Restock Rak Toko** (label HABIS / MINUS −N), dan menu Mutasi menampilkan angka merah berisi jumlah barang tersebut untuk akun Gudang & Admin. Klik **Isi Rak** untuk mencatat mutasi Gudang Utama → Toko.

Kolom scan / cari barang (Kasir, Mutasi, Penerimaan, Cetak Barcode) menampilkan dropdown barang yang mirip setelah 2 huruf diketik. Bagian yang cocok diberi warna.
- Urutan kata bebas: `lidi sima` menemukan "Penebah Lidi @50 PCS Sima". Merk dan kategori ikut dicari.
- Tahan salah ketik kecil: `minral` → "Air Mineral", `penebh` → "Penebah". Kata ≤3 huruf dan angka (barcode, ukuran) harus tepat.
- Urutan hasil: barcode/SKU persis → awalan barcode/SKU → nama berawalan kata yang diketik → paling mirip. Enter setelah scan tetap langsung memasukkan barang dengan barcode persis.
- Mode darurat kasir memakai pencarian yang sama (`src/search.js`).

## Tampilan (tema & ukuran)

Di kiri bawah sidebar:
- **☾ Gelap / ☀ Terang**: tema warna.
- **A− · 100% · A+**: ukuran tampilan. Seluruh aplikasi (huruf, tombol, tabel, modal) diperbesar atau diperkecil, pilihannya 80–200%. Klik angka persen untuk kembali ke 100%.
- Pintasan keyboard: **Ctrl + =** (atau Ctrl + +) memperbesar, **Ctrl + −** memperkecil, **Ctrl + 0** kembali ke 100%.
- Pilihan tersimpan **per komputer** dan langsung berlaku saat aplikasi dibuka, termasuk di layar login.
- **Lebar menu samping:** geser garis batas antara menu dan halaman (180–400 px), atau fokus garis lalu ← / →. **Klik dua kali** garis = kembali ke lebar awal (248 px). Tombol **« Ciutkan menu** membuat menu jadi ikon saja (nama menu muncul saat kursor di atas ikon, angka merah tetap tampil); tombol **»** melebarkannya lagi (lebar & ciut juga tersimpan per komputer). Saat ciut, info akun, shift, koneksi, tema, ukuran, dan jam disembunyikan.
- Bisa diatur sendiri oleh kasir.
- Nota, label, dan laporan PDF tidak terpengaruh.
- Pada layar kecil dengan ukuran besar, sidebar bisa di-scroll.

## Printer nota thermal

1. Pasang driver printer nota (58 mm / 80 mm) sampai printernya muncul di Windows (Settings → Printers & scanners).
2. Di aplikasi: **Pengaturan → Printer Nota** → pilih printer, lebar kertas, lalu isi Header dan Footer (pratinjau tampil langsung).
3. Klik **Cetak Tes**. Setelah itu nota tercetak otomatis setiap transaksi selesai (bisa dimatikan).
4. Cetak ulang: tombol di layar transaksi berhasil, atau **Laporan Shift → Detail → Cetak Ulang Nota**. Cetak ulang perlu **PIN Admin** atau **PIN Pembatalan** (kepala toko), sama seperti batal nota, dan nota tercetak dengan tanda **CETAK ULANG**.
   - Setiap nota hanya tercetak sekali tanpa PIN. Bila cetak pertama gagal (printer mati / kertas habis), tombol cetak masih bisa dipakai tanpa PIN sampai nota berhasil tercetak.
   - PIN dicek di PC Server, jadi cetak ulang tidak bisa saat MODE DARURAT.

Format nota diatur di `src/receipt.js` (58 mm = 32 karakter, 80 mm = 48 karakter per baris). Nota tidak mencetak nomor struk; nomornya tetap tersimpan dan tampil di layar transaksi serta Laporan Shift.

## Cetak label barcode

- Menu **Cetak Barcode (F10)**: atur desain label (kertas label rol, lebar, tinggi, kolom, jarak, margin, isi label, ukuran huruf) dengan pratinjau langsung. Desain bisa disimpan lebih dari satu; salah satunya default.
- Setelah **Simpan Penerimaan**, aplikasi menawarkan cetak label; antrian otomatis terisi jumlah Biji yang diterima (bisa diubah). Bisa juga lewat Detail Penerimaan atau tombol **Barcode** di Daftar Barang.
- Barcode: EAN-13 untuk barcode 13 digit yang valid, selain itu Code 128 (pilihan "Otomatis"). Lebar batang dibulatkan ke titik printer 203 dpi agar mudah di-scan.
- Tambah barang manual ke antrian: kursor selalu berada di **Jumlah label**. Isi jumlah, tekan **Enter** (kursor pindah ke kolom scan), lalu scan barcode. Setelah barang ditambahkan, Jumlah kembali ke 1 dan kursor kembali ke Jumlah label. Enter di kolom scan yang kosong juga kembali ke Jumlah. Scan barang yang sudah ada di antrian menambah jumlah labelnya.
- **Designer Label**: tersembunyi secara default; klik **Buka Designer Label** di kartu Desain Label (tutup lagi dengan **Tutup Designer**). Isinya kanvas satu label dengan grid mm, hasilnya sama persis dengan cetakan.
  - Tambah elemen: Nama, Harga, Barcode, Angka Barcode, SKU, Merk, Teks, Garis, Kotak.
  - Klik untuk memilih, seret untuk memindah, tarik kotak kecil di sudut/sisi untuk mengubah ukuran (snap 0,5 mm).
  - Panel kanan: X/Y, lebar/tinggi, ukuran huruf (pt), tebal, rata kiri/tengah/kanan, teks, ketebalan garis. Kotak ikut membesar bila huruf diperbesar.
  - Panah = geser 0,5 mm (Shift = 2 mm), Delete = hapus, **Reset Tata Letak** = kembali ke susunan bawaan.
  - Klik **Simpan Desain** setelah selesai. Desain lama otomatis diubah ke susunan elemen yang sama.
- Pilih printer label di kanan bawah layar Cetak Barcode. Jika hasil terbalik, centang **Putar 180°**.

## Lokasi data

- Database: `%APPDATA%\POS Tri-Zone\pos.db` (backup harian di subfolder `backup/`, 14 terakhir). Path persisnya tampil di **Pengaturan → Informasi**.
- Laporan tutup shift: `%APPDATA%\POS Tri-Zone\Laporan\Shift_YYYYMMDD_HHMMSS\` (Rekap PDF, CSV penjualan, CSV snapshot stok). File ini cadangan lokal; tidak ada lagi email laporan.
  - **Disimpan 7 hari** (hari ini + 6 hari sebelumnya). Folder `Shift_…` yang lebih lama dihapus otomatis saat aplikasi dibuka, tiap jam, dan setiap tutup shift. Data penjualannya tetap ada di mother base.
  - Lokasinya **tidak ditampilkan** di layar tutup shift. Hanya **Admin** yang bisa melihat dan membukanya di **Pengaturan → Informasi**.
  - **Terenkripsi (sejak 1.12.0):** file disimpan sebagai `*.pdf.enc` / `*.csv.enc` (AES-256-GCM). Isinya tidak bisa dibuka langsung, hanya lewat **Pengaturan → Lihat Laporan…** (Admin). File yang dibuka didekripsi ke `buka-laporan\` di folder data dan dihapus saat aplikasi ditutup / dibuka lagi.
  - Kuncinya ada di `laporan.key` di folder data, dienkripsi akun Windows (DPAPI). Bila Windows diinstal ulang atau file itu hilang, laporan lokal tidak bisa dibuka lagi (datanya tetap ada di mother base). Laporan polos dari versi 1.9.1–1.11.0 di folder ini dienkripsi otomatis saat aplikasi dibuka.
  - Laporan dari versi sebelum 1.9.1 tetap di `Dokumen\POS-Laporan` (tidak dipindah dan tidak dienkripsi).
- **Riwayat Shift (cadangan):** tutup shift tidak lagi menghapus penjualan. Penjualan shift yang sudah ditutup dipindah ke tabel riwayat di database.
  - Riwayat disimpan **4 hari** (hari ini + 3 hari sebelumnya). Yang lebih lama dihapus otomatis saat tutup shift, saat aplikasi dibuka, dan tiap jam.
  - **Riwayat tidak tampil di aplikasi** dan keberadaannya tidak disebut di layar pegawai.
  - **Rekap tutup shift tercetak** otomatis di printer nota komputer yang menutup shift (ikut pengaturan "Cetak nota otomatis"): kasir, jam mulai/tutup, jumlah transaksi, barang terjual, total omset, tunai, pembatalan, catatan kasir. Layar Shift Berhasil Ditutup punya tombol **Cetak Ulang Rekap**.
  - **Tutup shift langsung mengirim ke mother base** dan menunggu konfirmasinya, tetapi layar hanya menampilkan "Shift Berhasil Ditutup" dan omsetnya. Bila internet putus atau mother base belum diatur, shift tetap ditutup; datanya menunggu di antrean dan dikirim otomatis tiap 3 jam. Admin memantau jumlah shift menunggu dan tombol **Kirim Sekarang** di **Pengaturan → Mother Base**.
- Antrean mother base: tabel `mb_outbox_shift` di `pos.db` (tidak ikut dihapus bersama Riwayat Shift sampai diterima mother base).

## Login & hak akses

Setiap orang login dengan **nama + PIN 6 digit**. Menu yang tidak diizinkan disembunyikan, dan perintahnya juga ditolak oleh proses utama aplikasi.

| Peran | Menu |
|---|---|
| **Admin** | Semua menu, termasuk Pengaturan, Pengguna, Mode Komputer, Cadangkan / Pulihkan |
| **Gudang** | Mutasi, Penerimaan Barang, Stok Opname **hanya lewat Excel** (Unduh Template → isi Fisik → Import), Daftar Barang (tambah / ubah / hapus / import), Cetak Barcode, Pesanan Pelanggan (hanya lihat) |
| **Kasir** | Kasir / Pembayaran, Pesanan Pelanggan, Laporan Shift & Tutup Kasir, Daftar Barang (hanya lihat) |

- **Akun pertama:** saat database belum punya akun, layar login menjadi **Buat Akun Admin**. Tidak ada PIN bawaan.
- Admin menambah, mengubah, atau menonaktifkan akun di **Pengaturan → Pengguna & Hak Akses**. Minimal harus selalu ada satu Admin aktif.
- Lupa PIN: Admin mengisi PIN baru untuk akun itu. Jika semua Admin lupa PIN, pulihkan dari file cadangan yang akunnya masih diketahui.
- Nama kasir pada shift dan nota diambil otomatis dari akun yang membuka shift.
- PIN disimpan sebagai hash `scrypt` (bukan PIN asli). PIN yang salah diberi jeda ±1 detik.
- Mode dua komputer: akun disimpan di database PC Gudang dan berlaku di semua PC. PC Kasir menyimpan salinan hash akun di cache darurat, sehingga kasir tetap bisa login saat **MODE DARURAT**. Perubahan PIN ikut masuk ke cache saat PC Kasir terhubung.
- Keterbatasan: pembatasan peran dijalankan oleh aplikasi di tiap PC. Panggilan jaringan antar-PC dilindungi kode pasangan, tetapi tidak dicek per peran.
- **Update dari versi lama:** perbarui **PC Gudang dulu**, buat akun Admin di sana, baru perbarui PC Kasir.

## Dua komputer: PC Server & komputer yang terhubung

Satu database di **PC Server**; komputer lain (mode **Terhubung ke Server**) membaca & menyimpan semua data langsung ke PC Server lewat jaringan toko (LAN/WiFi yang sama). Stok selalu sama di kedua komputer, tanpa proses sinkron terpisah.

**PC Server boleh PC Gudang atau PC Kasir.** Menu yang tampil tetap mengikuti akun yang login, bukan mode komputernya. Bila PC Kasir menjadi server: kasir tidak pernah masuk MODE DARURAT, tetapi PC Kasir harus menyala selama PC Gudang dipakai (menu gudang memerlukan PC Server), dan database, cadangan, laporan terenkripsi, serta pengiriman ke mother base pindah ke PC Kasir. Contoh di bawah memakai PC Gudang sebagai server.

**Pembagian tugas**
- PC Gudang: Penerimaan Barang, Cetak Barcode, Mutasi Stok, Daftar Barang (+ semua menu lain). Menyimpan database, cadangan, dan laporan tutup shift; data dikirim ke mother base dari sini.
- PC Kasir: Kasir / Pembayaran, cetak nota, Laporan Shift. Semua menu tetap bisa dibuka dan memakai data PC Gudang.

**Langkah pemasangan**
1. Instal aplikasi di kedua PC.
2. Jika data sudah ada di salah satu PC: **Pengaturan → Cadangkan Database…** di PC itu, lalu **Pulihkan dari Cadangan…** di PC Gudang.
3. **PC Gudang**: Pengaturan → Mode Komputer → **Server (menyimpan database)** → *Simpan & Mulai Ulang*. Catat **alamat IP** dan **kode pasangan 6 digit** yang tampil. Saat Windows Firewall bertanya, pilih **Allow / Izinkan** untuk jaringan **Private**.
4. **PC Kasir**: Pengaturan → Mode Komputer → **Terhubung ke Server** → isi alamat IP & kode → **Tes Koneksi** → *Simpan & Mulai Ulang*.
5. Atur printer di masing-masing PC (pengaturan printer tersimpan per komputer): printer nota di PC Kasir, printer label di PC Gudang.

**Penting**
- PC Gudang dan aplikasinya sebaiknya menyala selama kasir berjualan. Jika terputus, PC Kasir masuk **MODE DARURAT** (lihat di bawah).

**MODE DARURAT (PC Gudang / jaringan mati)**
- Saat terhubung, PC Kasir menyimpan salinan daftar barang (SKU, barcode, nama, harga, stok terakhir), shift aktif, dan pengaturan nota ke `offline-cache.json` di folder data kasir. Salinan diperbarui tiap ±1 menit.
- Jika PC Gudang tidak terjangkau, layar kasir diberi bingkai & spanduk kuning **MODE DARURAT**. Scan dan cari barang memakai salinan tadi. Transaksi tetap bisa dibayar dan disimpan ke `offline-queue.json` sebelum nota dicetak. Nomor struknya `OFF-YYYYMMDD-XXXX-0001` (`XXXX` = kode unik PC kasir) dan nota bertanda `** MODE DARURAT **`.
- Syarat: PC Kasir pernah terhubung, dan shift sudah dibuka saat terakhir terhubung. Buka shift, tutup shift, laporan shift, dan menu gudang tetap memerlukan PC Gudang.
- Stok yang tampil adalah stok terakhir yang diketahui, dikurangi transaksi darurat yang belum terkirim. Jika stok itu kurang, kasir hanya diberi peringatan dan tetap boleh menjual, karena barangnya sudah ada di tangan pelanggan.
- Saat koneksi kembali (dicek tiap 15 detik), antrian dikirim **berurutan**, dimulai dari yang paling lama, dengan harga dan waktu jual aslinya. Jika jaringan putus di tengah pengiriman, sisa antrian dicoba lagi nanti. Transaksi yang ditolak PC Gudang (data rusak) tetap disimpan di antrian beserta pesan errornya, lalu antrian berikutnya tetap dikirim.
- **Jika display toko di PC Gudang tidak cukup**, transaksi **tetap dicatat** dan **display toko dibiarkan minus**, lalu transaksi ditandai **Perlu Dicek**. Alasannya, barang sudah keluar secara fisik dan uang sudah diterima. Jika ditolak, omset dan laci kasir tidak akan cocok. Jika stok dipaksa 0, selisihnya hilang tanpa jejak. Dengan stok minus, selisihnya terlihat jelas, dan barang itu muncul merah paling atas di **Saran Restock Rak Toko** sampai stok dibereskan (Mutasi Gudang → Toko atau Penerimaan). Stok Gudang Utama dan Gudang BS tidak pernah disentuh.
- Daftar **Perlu Dicek** tampil di **Laporan Shift** (tombol *Sudah Dicek*) dan di PDF rekap tutup shift. Daftar ini juga mencakup barang yang sudah dihapus dari gudang dan transaksi yang masuk saat tidak ada shift aktif (dicatat ke shift berikutnya).
- Anti dobel: transaksi darurat tercatat di tabel `offline_sales` yang tidak ikut dihapus saat tutup shift, sehingga pengiriman ulang diabaikan. Setiap pembayaran juga membawa penanda unik. Jika koneksi putus tepat setelah PC Gudang menyimpan transaksi online, salinan daruratnya tidak dihitung dua kali.
- Tutup shift di PC Kasir ditolak selama masih ada transaksi darurat yang belum terkirim.
- Sebaiknya beri PC Gudang **IP tetap** (atur DHCP reservation di router) agar alamatnya tidak berubah.
- Komunikasi memakai HTTP port 4785 di jaringan lokal, dilindungi kode pasangan. Jangan buka port ini ke internet.

## Cadangkan, pulihkan & pindah komputer

- **Pengaturan → Cadangkan Database…** menyimpan seluruh data (barang, stok, riwayat, pengaturan, desain label) ke satu file `.db`.
- **Pengaturan → Pulihkan dari Cadangan…** mengganti data dengan isi file cadangan. Data lama disimpan dulu otomatis ke `backup/sebelum-pulih-*.db`.
- Pindah komputer: Cadangkan → salin file `.db` → instal aplikasi di komputer baru → Pulihkan.
- **Reset Program** (Pengaturan → Informasi, hanya Admin, di PC Server / Mandiri): menghapus semua data toko seperti baru dipasang (barang, stok, transaksi, akun, pengaturan toko, mother base, PIN Pembatalan, draft, file laporan). Harus mengetik `RESET` dan PIN Admin; ditolak bila shift masih berjalan atau masih ada data yang belum terkirim ke kantor. Database dicadangkan dulu ke `backup\sebelum-reset-*.db` (bisa dikembalikan dengan Pulihkan dari Cadangan). Mode jaringan & printer komputer ini tetap.
- Selalu buka aplikasi lewat `Jalankan POS.bat` atau shortcut Start menu. Jika dijalankan dari dalam aplikasi lain yang terisolasi (misalnya aplikasi Microsoft Store), Windows bisa mengalihkan data ke folder lain sehingga data tampak "hilang".

## Penyesuaian terhadap spesifikasi

- `stock_transfers` menerima zona eksternal: `customer` (retur pelanggan) sebagai asal, `supplier` (retur keluar) dan `disposed` (dibuang) sebagai tujuan.
- Tabel tambahan `settings` untuk nama toko, printer, nomor struk, dan mother base.
- Waktu disimpan dalam waktu lokal (`datetime('now','localtime')`).
- Import ulang SKU yang sudah ada memperbarui data master; kolom kosong mempertahankan nilai lama, dan stok awal diabaikan.
- **Daftar Barang → Import Excel / CSV** menerima dua format, dikenali otomatis dari judul kolom:
  - **Template POS** (tombol Unduh Template).
  - **Data Item** dari program lama: `Kode Item`, `Nama Item`, `Jenis`, `Rak`, `Stok`, `Satuan`, `Harga Jual`.
    - Kode Item menjadi SKU sekaligus barcode (dicetak Code 128).
    - Jenis menjadi kategori.
    - Stok masuk ke **Gudang Utama** (minus diterima apa adanya).
    - Rak dan Satuan diabaikan.
    - Import ulang hanya memperbarui nama, kategori, dan harga. Stok dan barcode yang sudah diganti tidak berubah.
- Stok awal di file import boleh minus.
- **Penerimaan Barang → Import Excel / CSV** (template dari tombol Unduh Template di layar Penerimaan):
  - Kolom: `No_Surat_Jalan`*, `Catatan`, `Kode`*, `Nama_Barang` (info saja), `Jumlah`*, `Satuan`, `Tujuan`. File lama yang masih memiliki kolom `Supplier` tetap bisa diimpor.
  - Satu file boleh berisi beberapa surat jalan; baris dikelompokkan per No_Surat_Jalan dan tiap kelompok menjadi satu penerimaan.
  - Kode = SKU atau barcode. Satuan kosong = Dus (boleh juga nama satuan masuk barang, mis. Karton), `Biji`/`pcs` = Biji. Tujuan kosong = Gudang Utama; lainnya `Display Toko` atau `Gudang BS`.
  - Sebelum disimpan tampil ringkasan. Baris tidak valid dilewati dan dilaporkan; surat jalan yang sudah pernah dicatat dilewati seluruhnya.
- **Draft Barang Belum Terdaftar** (layar Penerimaan): barang yang kodenya belum ada di Daftar Barang dicatat sebagai draft — otomatis dari import Excel, atau dari form manual (scan kode tidak dikenal → *Catat sebagai Draft*; No. Surat Jalan harus diisi dulu). Stoknya belum masuk. Angka merah di menu Penerimaan menunjukkan jumlah draft. Setelah barangnya didaftarkan di Daftar Barang, status draft berubah jadi *Sudah terdaftar* dan tombol **Proses** memasukkan stoknya sebagai penerimaan (No. Surat Jalan asli, atau `<No SJ>-S<id>` bila nomor itu sudah dipakai). Draft yang salah bisa dihapus. Import ulang file yang sama tidak membuat draft ganda.
- **Stok Opname** (menu sendiri, F7): opname manual (form scan) hanya untuk **Admin**; akun **Gudang** hanya lewat **Unduh Template → isi kolom Fisik → Import Excel / CSV / PDF**.
  - **Import PDF:** isi template di Excel, lalu **File → Save as → PDF** (bawaan Excel maupun "Fit All Columns on One Page" bisa). Aplikasi membaca tabelnya (termasuk kolom yang dicetak Excel di halaman terpisah) lalu menampilkan ringkasan selisih seperti Excel. PDF hanya mempersulit pengubahan biasa; PDF tetap bisa diubah dengan aplikasi PDF editor. Untuk angka yang benar-benar tidak bisa diubah di toko, pakai opname dari kantor. Satu form = satu zona (Display Toko, Gudang Utama, atau Gudang BS). Scan barang → isi Jumlah Fisik → Enter = masuk list (scan barang yang sama lagi = jumlah ditambahkan). Jumlah Fisik **boleh minus** (mis. `-3`), baik di form maupun di kolom Fisik file Excel / CSV / PDF; stok zona itu lalu dicatat minus. Tabel menampilkan Stok Sistem, Fisik, dan Selisih. **Simpan Opname** men-set stok zona itu ke angka fisik dengan nomor `OP-YYYYMMDD-NNN`; stok sistem dibaca ulang saat simpan, jadi penjualan di tengah hitungan tetap benar. Barang yang tidak dimasukkan ke list tidak diubah, jadi opname boleh sebagian (per rak). **Unduh Template** berisi semua barang dengan stok sistem ketiga zona (kolom `Kode, Nama_Barang, Display Toko, Fisik Display Toko, Gudang Utama, Fisik Gudang Utama, Gudang BS, Fisik Gudang BS, Tanggal_Stok`); isi kolom Fisik zona yang dihitung lalu **Import Excel / CSV** — muncul ringkasan selisih per zona, dan **Simpan** membuat satu dokumen OP per zona (kolom Fisik yang kosong = barang itu tidak diubah di zona tersebut). `Tanggal_Stok` = waktu template diunduh: selisih dihitung dari **Fisik − stok di file**, lalu hanya selisih itu yang ditambahkan ke stok saat upload. Contoh: template 1 Nov, Display Toko 10, dihitung fisik 8 (selisih −2); sampai 4 Nov terjual 3 dan diisi rak 5 sehingga stok 12 — setelah upload stok menjadi 12 − 2 = 10, bukan 8. Hasil boleh minus. File tanpa kolom `Tanggal_Stok` (template lama) dibandingkan dengan stok saat upload dan stok di-set ke angka Fisik. Detail opname menampilkan stok per tanggal itu, fisik, selisih, dan stok akhir. Riwayat Opname menyimpan stok sistem, fisik, dan selisih tiap barang.
- Mutasi: satu form = satu arah + satu alasan, berisi banyak barang. **Satuan** bawaan **Biji**; pilih **Coly** (satuan masuk barang, mis. Dus isi 24) di kotak Satuan atau tekan **C** di kolom Jumlah (**B** = kembali ke Biji). Coly dihitung jadi Biji (2 Coly isi 24 = 48 Biji) dan satuan kembali ke Biji setelah barang masuk list. Detail mutasi menampilkan "2 Coly (isi 24) = 48 Biji"; stok, riwayat, dan kiriman ke kantor tetap dalam Biji. Scan barang → isi Jumlah → Enter = masuk list; Simpan Mutasi menyimpan semuanya sekaligus dengan nomor `MT-YYYYMMDD-NNN` (kalau satu barang stoknya kurang, seluruh form batal). Riwayat tampil per nomor mutasi dengan tombol Detail. Mutasi dari versi lama otomatis diberi nomor `MT-LAMA-<id>`.
- Saran Restock: barang yang display tokonya 0 karena belum pernah dipajang (mis. hasil import) tampil biasa. Merah hanya untuk barang yang habis/minus karena terjual di kasir, dan hilang setelah rak diisi lagi (Mutasi / Penerimaan ke Toko).
- Shortcut: F1 Kasir, F2 fokus scan, F3 Mutasi, F4 Penerimaan, F5 Daftar Barang, F6 Shift, F7 Stok Opname, F8 kosongkan keranjang, F9 bayar, F10 Cetak Barcode, F12 isi Uang Diterima (F12 lagi = Uang Pas, lalu Enter = bayar). Pengaturan dibuka lewat tombol di sidebar. Di layar Kasir, tombol `*` di kolom barcode yang kosong memindahkan fokus ke kolom Jumlah.
