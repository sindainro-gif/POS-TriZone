# POS Tri-Zone — POS Desktop Offline

Aplikasi kasir offline (Electron + SQLite lokal) dengan inventaris tiga zona: **Stok Toko**, **Gudang Utama**, dan **Gudang BS / Retur**.

## Menjalankan

```bash
npm install
node node_modules/electron/install.js   # hanya jika biner Electron belum terunduh
npm start
```

Membuat installer Windows (.exe): `npm run dist` → hasil di folder `dist/`.

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
- **Printer sungguhan, email tidak dikirim:** nota dan label dicetak ke printer yang dipilih (printer nota di Pengaturan, printer label di kanan bawah layar Cetak Barcode). Nota bertanda DEMO. Pengaturan printer demo terpisah dari aplikasi asli, jadi pilih printernya sekali di demo. Tutup shift membuat laporan di `Laporan-Demo` dan tidak mengirim email.
- **Reset Data** mengembalikan semua data latihan ke kondisi awal.
- Versi demo selalu berjalan **Mandiri**; mode Server/Kasir hanya di aplikasi asli.
- Uji otomatis: `npm run smoke:demo`.

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
| `src/main.js` | Proses utama Electron: IPC, import/template Excel, PDF, email SMTP, tutup shift |
| `src/remote.js` | RPC HTTP LAN antara PC Gudang (server) dan PC Kasir (klien) |
| `src/offline.js` | Mode darurat PC Kasir: cache barang + antrian transaksi OFF- dan sinkron ulang |
| `src/reports.js` | CSV penjualan, CSV snapshot stok, HTML rekap (→ PDF) |
| `src/renderer/` | Antarmuka (HTML/CSS/JS, dark mode) |

## Pencarian barang

Di layar Kasir, kursor selalu kembali ke kolom **scan barcode**. Kolom **Jumlah** terpisah di kirinya: tekan **Enter** saat kolom scan kosong untuk pindah ke Jumlah (atau tombol `*`), isi jumlah, lalu **Enter** lagi untuk kembali ke scan. Setelah barang masuk keranjang, Jumlah kembali ke 1 dan kursor tetap di kolom scan. Format lama `12*barcode` tidak dipakai lagi.

**Draft penjualan:** bila pelanggan belum siap bayar, klik **Tahan (Draft)** (boleh diberi nama pelanggan / catatan). Keranjang tersimpan di komputer kasir itu dan layar kosong untuk pelanggan berikutnya. **Daftar Draft** menampilkan semua draft; **Lanjutkan** memasukkan isinya kembali ke keranjang (keranjang yang sedang berisi bisa ditahan otomatis dulu). Stok tidak dipesan: harga & stok dicek ulang saat dilanjutkan dan saat bayar. Draft tetap ada walau aplikasi ditutup, juga saat MODE DARURAT.

**Menjual melebihi stok toko:** kasir selalu boleh menjual walaupun stok toko di sistem kurang (barangnya ada di tangan pelanggan). Keranjang hanya menampilkan peringatan kuning, dan stok toko menjadi 0 atau minus. Stok Gudang Utama dan Gudang BS tidak pernah dipotong. Barang yang stok tokonya habis/minus muncul **merah dan paling atas** di **Mutasi → Saran Restock Rak Toko** (label HABIS / MINUS −N), dan menu Mutasi menampilkan angka merah berisi jumlah barang tersebut untuk akun Gudang & Admin. Klik **Isi Rak** untuk mencatat mutasi Gudang Utama → Toko.

Kolom scan / cari barang (Kasir, Mutasi, Penerimaan, Cetak Barcode) menampilkan dropdown barang yang mirip setelah 2 huruf diketik. Bagian yang cocok diberi warna.
- Urutan kata bebas: `lidi sima` menemukan "Penebah Lidi @50 PCS Sima". Merk dan kategori ikut dicari.
- Tahan salah ketik kecil: `minral` → "Air Mineral", `penebh` → "Penebah". Kata ≤3 huruf dan angka (barcode, ukuran) harus tepat.
- Urutan hasil: barcode/SKU persis → awalan barcode/SKU → nama berawalan kata yang diketik → paling mirip. Enter setelah scan tetap langsung memasukkan barang dengan barcode persis.
- Mode darurat kasir memakai pencarian yang sama (`src/search.js`).

## Printer nota thermal

1. Pasang driver printer nota (58 mm / 80 mm) sampai printernya muncul di Windows (Settings → Printers & scanners).
2. Di aplikasi: **Pengaturan → Printer Nota** → pilih printer, lebar kertas, lalu isi Header dan Footer (pratinjau tampil langsung).
3. Klik **Cetak Tes**. Setelah itu nota tercetak otomatis setiap transaksi selesai (bisa dimatikan).
4. Cetak ulang: tombol di layar transaksi berhasil, atau **Laporan Shift → Detail → Cetak Ulang Nota**.

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
- Laporan tutup shift: `Dokumen\POS-Laporan\Shift_YYYYMMDD_HHMMSS\`

## Login & hak akses

Setiap orang login dengan **nama + PIN 6 digit**. Menu yang tidak diizinkan disembunyikan, dan perintahnya juga ditolak oleh proses utama aplikasi.

| Peran | Menu |
|---|---|
| **Admin** | Semua menu, termasuk Pengaturan, Pengguna, Mode Komputer, Cadangkan / Pulihkan |
| **Gudang** | Mutasi, Penerimaan Barang, Daftar Barang (tambah / ubah / hapus / import), Cetak Barcode |
| **Kasir** | Kasir / Pembayaran, Laporan Shift & Tutup Kasir, Daftar Barang (hanya lihat) |

- **Akun pertama:** saat database belum punya akun, layar login menjadi **Buat Akun Admin**. Tidak ada PIN bawaan.
- Admin menambah, mengubah, atau menonaktifkan akun di **Pengaturan → Pengguna & Hak Akses**. Minimal harus selalu ada satu Admin aktif.
- Lupa PIN: Admin mengisi PIN baru untuk akun itu. Jika semua Admin lupa PIN, pulihkan dari file cadangan yang akunnya masih diketahui.
- Nama kasir pada shift dan nota diambil otomatis dari akun yang membuka shift.
- PIN disimpan sebagai hash `scrypt` (bukan PIN asli). PIN yang salah diberi jeda ±1 detik.
- Mode dua komputer: akun disimpan di database PC Gudang dan berlaku di semua PC. PC Kasir menyimpan salinan hash akun di cache darurat, sehingga kasir tetap bisa login saat **MODE DARURAT**. Perubahan PIN ikut masuk ke cache saat PC Kasir terhubung.
- Keterbatasan: pembatasan peran dijalankan oleh aplikasi di tiap PC. Panggilan jaringan antar-PC dilindungi kode pasangan, tetapi tidak dicek per peran.
- **Update dari versi lama:** perbarui **PC Gudang dulu**, buat akun Admin di sana, baru perbarui PC Kasir.

## Dua komputer: PC Gudang (server) & PC Kasir

Satu database di **PC Gudang**; **PC Kasir** membaca & menyimpan semua data langsung ke PC Gudang lewat jaringan toko (LAN/WiFi yang sama). Stok selalu sama di kedua komputer, tanpa proses sinkron terpisah.

**Pembagian tugas**
- PC Gudang: Penerimaan Barang, Cetak Barcode, Mutasi Stok, Daftar Barang (+ semua menu lain). Menyimpan database, cadangan, dan laporan tutup shift; email laporan dikirim dari sini.
- PC Kasir: Kasir / Pembayaran, cetak nota, Laporan Shift. Semua menu tetap bisa dibuka dan memakai data PC Gudang.

**Langkah pemasangan**
1. Instal aplikasi di kedua PC.
2. Jika data sudah ada di salah satu PC: **Pengaturan → Cadangkan Database…** di PC itu, lalu **Pulihkan dari Cadangan…** di PC Gudang.
3. **PC Gudang**: Pengaturan → Mode Komputer → **Server (PC Gudang)** → *Simpan & Mulai Ulang*. Catat **alamat IP** dan **kode pasangan 6 digit** yang tampil. Saat Windows Firewall bertanya, pilih **Allow / Izinkan** untuk jaringan **Private**.
4. **PC Kasir**: Pengaturan → Mode Komputer → **Kasir** → isi alamat IP & kode → **Tes Koneksi** → *Simpan & Mulai Ulang*.
5. Atur printer di masing-masing PC (pengaturan printer tersimpan per komputer): printer nota di PC Kasir, printer label di PC Gudang.

**Penting**
- PC Gudang dan aplikasinya sebaiknya menyala selama kasir berjualan. Jika terputus, PC Kasir masuk **MODE DARURAT** (lihat di bawah).

**MODE DARURAT (PC Gudang / jaringan mati)**
- Saat terhubung, PC Kasir menyimpan salinan daftar barang (SKU, barcode, nama, harga, stok terakhir), shift aktif, dan pengaturan nota ke `offline-cache.json` di folder data kasir. Salinan diperbarui tiap ±1 menit. Password SMTP tidak ikut disimpan.
- Jika PC Gudang tidak terjangkau, layar kasir diberi bingkai & spanduk kuning **MODE DARURAT**. Scan dan cari barang memakai salinan tadi. Transaksi tetap bisa dibayar dan disimpan ke `offline-queue.json` sebelum nota dicetak. Nomor struknya `OFF-YYYYMMDD-XXXX-0001` (`XXXX` = kode unik PC kasir) dan nota bertanda `** MODE DARURAT **`.
- Syarat: PC Kasir pernah terhubung, dan shift sudah dibuka saat terakhir terhubung. Buka shift, tutup shift, laporan shift, dan menu gudang tetap memerlukan PC Gudang.
- Stok yang tampil adalah stok terakhir yang diketahui, dikurangi transaksi darurat yang belum terkirim. Jika stok itu kurang, kasir hanya diberi peringatan dan tetap boleh menjual, karena barangnya sudah ada di tangan pelanggan.
- Saat koneksi kembali (dicek tiap 15 detik), antrian dikirim **berurutan**, dimulai dari yang paling lama, dengan harga dan waktu jual aslinya. Jika jaringan putus di tengah pengiriman, sisa antrian dicoba lagi nanti. Transaksi yang ditolak PC Gudang (data rusak) tetap disimpan di antrian beserta pesan errornya, lalu antrian berikutnya tetap dikirim.
- **Jika stok toko di PC Gudang tidak cukup**, transaksi **tetap dicatat** dan **stok toko dibiarkan minus**, lalu transaksi ditandai **Perlu Dicek**. Alasannya, barang sudah keluar secara fisik dan uang sudah diterima. Jika ditolak, omset dan laci kasir tidak akan cocok. Jika stok dipaksa 0, selisihnya hilang tanpa jejak. Dengan stok minus, selisihnya terlihat jelas, dan barang itu muncul merah paling atas di **Saran Restock Rak Toko** sampai stok dibereskan (Mutasi Gudang → Toko atau Penerimaan). Stok Gudang Utama dan Gudang BS tidak pernah disentuh.
- Daftar **Perlu Dicek** tampil di **Laporan Shift** (tombol *Sudah Dicek*) dan di PDF/email rekap tutup shift. Daftar ini juga mencakup barang yang sudah dihapus dari gudang dan transaksi yang masuk saat tidak ada shift aktif (dicatat ke shift berikutnya).
- Anti dobel: transaksi darurat tercatat di tabel `offline_sales` yang tidak ikut dihapus saat tutup shift, sehingga pengiriman ulang diabaikan. Setiap pembayaran juga membawa penanda unik. Jika koneksi putus tepat setelah PC Gudang menyimpan transaksi online, salinan daruratnya tidak dihitung dua kali.
- Tutup shift di PC Kasir ditolak selama masih ada transaksi darurat yang belum terkirim.
- Sebaiknya beri PC Gudang **IP tetap** (atur DHCP reservation di router) agar alamatnya tidak berubah.
- Komunikasi memakai HTTP port 4785 di jaringan lokal, dilindungi kode pasangan. Jangan buka port ini ke internet.

## Cadangkan, pulihkan & pindah komputer

- **Pengaturan → Cadangkan Database…** menyimpan seluruh data (barang, stok, riwayat, pengaturan, desain label) ke satu file `.db`.
- **Pengaturan → Pulihkan dari Cadangan…** mengganti data dengan isi file cadangan. Data lama disimpan dulu otomatis ke `backup/sebelum-pulih-*.db`.
- Pindah komputer: Cadangkan → salin file `.db` → instal aplikasi di komputer baru → Pulihkan.
- Selalu buka aplikasi lewat `Jalankan POS.bat` atau shortcut Start menu. Jika dijalankan dari dalam aplikasi lain yang terisolasi (misalnya aplikasi Microsoft Store), Windows bisa mengalihkan data ke folder lain sehingga data tampak "hilang".

## Penyesuaian terhadap spesifikasi

- `stock_transfers` menerima zona eksternal: `customer` (retur pelanggan) sebagai asal, `supplier` (retur keluar) dan `disposed` (dibuang) sebagai tujuan.
- Tabel tambahan `settings` untuk nama toko, SMTP, dan nomor struk.
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
- Saran Restock: barang yang stok tokonya 0 karena belum pernah dipajang (mis. hasil import) tampil biasa. Merah hanya untuk barang yang habis/minus karena terjual di kasir, dan hilang setelah rak diisi lagi (Mutasi / Penerimaan ke Toko).
- Shortcut: F1 Kasir, F2 fokus scan, F3 Mutasi, F4 Penerimaan, F5 Daftar Barang, F6 Shift, F8 kosongkan keranjang, F9 bayar, F10 Cetak Barcode, F12 isi Uang Diterima (F12 lagi = Uang Pas, lalu Enter = bayar). Pengaturan dibuka lewat tombol di sidebar. Di layar Kasir, tombol `*` di kolom barcode yang kosong memindahkan fokus ke kolom Jumlah.
