# Mother Base

Pusat data PT kantor untuk toko POS Tri-Zone: database Supabase, aplikasi web kantor, dan asisten AI.
Trizone (PC Gudang / Mandiri) mengirim data langsung ke database lewat internet; kantor memakai
aplikasi web untuk melihat penjualan, mencocokkan surat jalan Accurate, mereview stok opname,
mengelola master barang & harga, dan menyetujui pembelian.

```
 Toko (Trizone)                    Supabase                              Kantor (browser / HP)
 ┌───────────────────┐  terima_data  ┌──────────────────────────┐  login  ┌──────────────────────┐
 │ src/motherbase.js ├──────────────►│ PostgreSQL + RLS         │◄────────┤ web/ (aplikasi)      │
 │ antrean di pos.db │◄──────────────┤ RPC, view laporan        │         │ upload Accurate      │
 └───────────────────┘  ambil_master │ Edge Function "asisten" ─┼──► Claude (Anthropic API)      │
                                     └──────────────────────────┘         └──────────────────────┘
```

## Isi folder

| Path | Isi |
|---|---|
| `web/` | Aplikasi web kantor (HTML/JS tanpa proses build). `config.js` diisi alamat project. |
| `web/lib/accurate.js` | Pembaca laporan Accurate "Rincian Pengiriman Pesanan" (dipakai web & baris perintah) |
| `web/lib/import-barang.js` | Pembaca Excel import master barang (template Trizone, data item, file "Unduh master") |
| `supabase/migrations/` | Skema database: `…01_mother_base.sql` (data & protokol Trizone), `…02_aplikasi.sql` (laporan, PO, SO, pengguna, AI), `…03_import_barang.sql` (import master barang), `…04_satuan_masuk.sql` (satuan masuk Coly / Biji), `…05_tanpa_principal.sql` (usulan beli tanpa principal) |
| `supabase/seed.sql` | Data awal: 10 toko, pemetaan pelanggan Accurate |
| `supabase/functions/asisten/` | Edge Function asisten AI (`index.ts` untuk Deno, inti di `asisten.mjs`) |
| `apps-script/Code.gs` | Alert email harian pukul 09.00 (opsional) |
| `accurate/accurate-do.js` | Pembaca Accurate versi baris perintah |
| `dev/` | Server pengembangan: tiruan Supabase lokal untuk mencoba & menguji (bukan untuk produksi) |
| `test/` | Uji: asisten AI, ujung ke ujung dengan Trizone, dan browser |

## Modul aplikasi web

| Menu | Untuk | Isi |
|---|---|---|
| Ringkasan | semua | Omzet, transaksi, grafik harian, per toko, daftar yang perlu ditindaklanjuti. Tombol **Tarik data terbaru** (juga di Penjualan, Stok, Toko): toko mengirim penjualan & stok dalam ±5 menit (Trizone 1.23.0 memeriksa permintaan tiap 5 menit) |
| Penjualan | semua | Per produk, naik/turun dibanding periode sebelumnya, analisa ABC, per kasir, per hari, pembatalan nota; unduh CSV |
| Pembatalan Nota | semua | Riwayat pembatalan nota: ringkasan per toko (jumlah, nilai, % dari penjualan) dan rincian per nota (nota asal, alasan, peminta, penyetuju); unduh CSV |
| Pesanan Pelanggan | semua | Pesanan pelanggan dari Trizone: belum diambil (tanda lewat tanggal ambil, deposit tertahan), diambil, batal (alasan, deposit kembali / hangus, penyetuju); rincian barang; unduh CSV |
| Stok | semua | Cari stok per toko & zona dengan filter kondisi (ada, habis, di bawah minimum, perlu isi display, minus, BS), kategori, merk; stok lambat |
| Stock Opname | kantor | **Opname dari kantor** (owner & admin kantor): tarik stok terbaru, atau pilih **Stok per** di dropdown: stok terbaru / update terakhir tiap hari (riwayat stok tiap kiriman toko disimpan 7 hari), unduh template (format template opname Trizone + Kategori, Satuan_Masuk, Isi_Coly, stok tiap zona dalam Coly, kolom Toko; bisa per kategori / merk; Fisik diisi dalam Biji), upload hasil hitung, periksa selisih, kirim ke toko; Trizone menerapkannya dengan patokan stok di file (penjualan setelah stok ditarik tetap terhitung), SO hasilnya langsung disetujui. Review & persetujuan SO dari toko, selisih stok Trizone vs hitungan mother base |
| Surat Jalan | kantor | Upload Excel Accurate di browser, unduh file import penerimaan Trizone per toko, simpan, status pencocokan |
| Pembelian | kantor | Usulan beli semua barang dalam satu daftar (lead time, periode order, stok pengaman diatur owner; dibulatkan ke isi 1 Coly) → usulan PO dengan alasan per baris → owner ubah qty & setujui → tandai dikirim → terima barang (stok gudang & harga beli diperbarui) |
| Master Barang | kantor | Barcode, harga jual, satuan masuk (Coly / Biji) & isi 1 Coly; harga beli / pricelist; markup (owner); import Excel dengan pratinjau |
| Toko | kantor | Koneksi tiap toko, buat / ganti kunci toko (owner), pemetaan pelanggan Accurate |
| Asisten AI | semua | Tanya jawab data dengan Claude; percakapan tersimpan per pengguna |
| Pengguna | owner | Peran: owner, admin kantor, gudang, purchasing, pemilik toko (hanya tokonya) |

Hak akses dijaga di database (Row Level Security), bukan hanya di menu: pemilik toko hanya melihat
data tokonya, juga saat bertanya ke asisten AI.

**Batal nota.** Nota asli di toko tidak pernah dihapus. Pembatalan (disetujui di toko dengan PIN)
menjadi nota baru `BTL-YYYYMMDD-NNNN` berisi barang minus, dan rinciannya — nota asal, alasan, yang
meminta, yang menyetujui — dikirim bersama data shift ke tabel `pembatalan_nota`. Omzet di mother
base sudah bersih; nota `BTL-` tidak dihitung sebagai transaksi dan tampil sebagai **Pembatalan**
(Penjualan → tab Pembatalan, kolom Pembatalan di Ringkasan / Per kasir / Per hari).

## Asisten AI

- Model: Claude Opus 5.5 (`claude-opus-5-5`), effort `medium`, fallback server-side aktif
  (`fallbacks: "default"`) supaya permintaan yang ditolak filter keamanan dialihkan otomatis.
- Claude hanya memakai alat yang memanggil fungsi laporan di database dengan token pengguna yang login.
  Angka selalu dari database; Claude menjelaskan dan menyarankan.
- Semua alat hanya membaca; asisten tidak mengubah data.
- Biaya mengikuti pemakaian API Anthropic (per token). Setiap pertanyaan biasanya 2–3 panggilan
  ke Claude (memanggil alat, lalu menjawab).

## Pasang

### 1. Supabase

1. Buat project di supabase.com.
2. SQL Editor: jalankan berurutan `migrations/20261116000001_mother_base.sql`,
   `migrations/20261116000002_aplikasi.sql`, `migrations/20261116000003_import_barang.sql`,
   `migrations/20261119000004_satuan_masuk.sql`, `migrations/20261119000005_tanpa_principal.sql`,
   `migrations/20261119000006_pembatalan_nota.sql`, `migrations/20261120000007_filter_stok.sql`, `migrations/20261120000008_pesanan_toko.sql`, `migrations/20261120000009_minta_update.sql`, `migrations/20261122000010_opname_kantor.sql`, `migrations/20261123000011_riwayat_stok.sql`, `migrations/20261123000012_dokumen_batal.sql`, lalu `seed.sql`
   (atau `supabase link` + `supabase db push`, lalu `seed.sql`).
3. Markup harga jual ke toko (tidak disimpan di repo karena repo ini publik), mis. 6%:
   `insert into pengaturan values ('markup_jual_ke_toko', '0.06');`
   Nanti bisa diubah owner di Master Barang → Markup.
4. **Owner pertama:** Authentication → Users → Add user (email + kata sandi), lalu di SQL Editor:
   `select jadikan_owner('email@owner', 'Nama Owner');`
   Pengguna lain: buat akunnya di Authentication → Add user, lalu atur perannya di menu **Pengguna**.
5. Authentication → Providers → Email: matikan **Allow new users to sign up** supaya hanya akun
   yang dibuat owner yang bisa login.

### 2. Asisten AI (Edge Function)

Tanpa CLI: **Edge Functions → Deploy a new function → Via Editor**, nama `asisten`, isi
`index.ts` dan `asisten.mjs` dari `supabase/functions/asisten/`. Lalu **Edge Functions → Secrets**:
tambah `ANTHROPIC_API_KEY` (dari console.anthropic.com → API Keys).

Dengan CLI:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

```bash
supabase functions deploy asisten
```

Opsional: secret `ASISTEN_ALLOWED_ORIGIN=https://alamat-aplikasi-anda` untuk membatasi asal
permintaan.

### 3. Aplikasi web

1. Isi `web/config.js` dengan alamat project dan anon key (Project Settings → API).
2. Upload isi folder `web/` ke hosting statis, mis. Netlify, Cloudflare Pages, atau Vercel
   (tanpa perintah build; folder publikasi = `motherbase/web`). Bisa dibuka dari PC dan HP.
3. **Akses & privasi.** Alamat web boleh dibuka siapa saja; tanpa akun yang terdaftar yang terlihat hanya
   layar login. Semua data ada di Supabase dan dilindungi login + Row Level Security (kantor melihat semua
   toko, pemilik toko hanya tokonya). Isi `config.js` (alamat project & anon key) memang publik.
   - Matikan pendaftaran umum: Supabase → Authentication → Sign In / Providers → **Allow new users to sign up**
     = off. Akun baru dibuat owner: Authentication → **Add user**, lalu atur nama & peran di menu **Pengguna**.
     Orang yang keluar: nonaktifkan di menu Pengguna.
   - `web/_headers` & `web/robots.txt`: tidak diindeks mesin pencari, tidak bisa disematkan di situs lain.
   - Netlify: **Visitor access → Team login** cukup untuk deploy non-production; production dibiarkan terbuka
     agar staf & pemilik toko (tanpa akun Netlify) bisa login.
   - Bila layar login pun ingin disembunyikan: Netlify Password protection (paket berbayar) atau Cloudflare
     Access di depan domain sendiri.

### 4. Toko

1. Di aplikasi: **Toko → Buat kunci** untuk tiap toko (owner). Kunci hanya tampil sekali.
2. Di Trizone PC Gudang: **Pengaturan → Mother Base**, isi alamat, anon key, kode toko, dan kunci,
   lalu **Tes Koneksi**.
3. Saat master barang kantor sudah rapi: **Master Barang → Isi dari toko**, rapikan harga & barcode,
   lalu centang **Kunci daftar barang** di Trizone.

### 5. Alert harian (opsional)

`apps-script/Code.gs` mengirim email pukul 09.00 bila ada toko yang belum menutup shift kemarin.
Tempel di script.google.com, isi Script Properties `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`EMAIL_ALERT`, lalu jalankan `setup()` sekali.

## Mencoba di komputer sendiri

Butuh Node.js dan PostgreSQL 15+ lokal. Dari folder repo:

```bash
npm install
```

```bash
cd motherbase && npm install
```

```bash
MB_DATABASE_URL=postgresql://postgres@localhost/mb_dev npm run dev
```

Perintah terakhir membuat ulang database `mb_dev` berisi data contoh (3 toko, 5 minggu penjualan)
lalu membuka server di http://127.0.0.1:54321 dengan akun `owner@contoh.local` / `owner123`,
`admin@contoh.local` / `admin123`, dan `tropodo@contoh.local` / `toko123`. Asisten AI memakai
Claude tiruan; isi `ANTHROPIC_API_KEY` sebelum `npm run dev` untuk Claude sungguhan.

Server dev meniru bagian Supabase yang dipakai (REST, RPC, login, Edge Function) di atas
PostgreSQL, dengan peran dan Row Level Security yang sama. Jangan dipakai di internet.

## Import master barang dari Excel

Di aplikasi: **Master Barang → Import Excel…**. Cara termudah: **Unduh master saat ini**, ubah di Excel,
lalu pilih file itu lagi.

- **Format:** sama dengan template import barang Trizone (`Barcode`, `SKU`, `Nama_Barang`, `Merk`,
  `Kategori`, `Harga_Jual`, `Satuan_Masuk` (Coly / Biji), `Rasio_Isi_Dus` = isi 1 Coly), ditambah kolom
  kantor `Harga_Beli` (per Biji, dicatat sebagai pricelist) dan `Aktif` (Ya/Tidak). Kolom lain diabaikan.
  File "data item" program lama (`Kode Item`, `Nama Item`, `Jenis`, `Harga Jual`) juga diterima.
- **Membaca kolom:** nama kolom tidak peka huruf besar/kecil, spasi, atau garis bawah, dan baris judul
  di atas tabel dilewati.
- **Sel kosong tidak mengubah data lama.** Barang yang tidak ada di file tidak dihapus.
- **Pratinjau dulu:** jumlah barang baru, diubah, dan sama, rincian perubahan per barang, serta
  kesalahan per baris (SKU ganda, barcode dipakai barang lain, angka salah, barang baru tanpa nama).
  Simpan hanya bisa bila tidak ada kesalahan, dan semua baris tersimpan bersama atau tidak sama sekali.
- **Ke toko:** hanya barang yang benar-benar berubah yang diambil toko dengan daftar barang terkunci.

## Surat jalan dari Accurate

Di aplikasi: **Surat Jalan → Upload dari Accurate**. Dari baris perintah:

```bash
node motherbase/accurate/accurate-do.js "Rincian Pengiriman Pesanan.xlsx" --out hasil
```

Satuan: `Pcs`/`Biji` = 1 Biji. Satuan kemasan (`Coly`, `Dus`) ditulis `Dus` di file import Trizone
dan dikali **isi per satuan masuk** barang itu. Isi di Trizone & master harus sama dengan isi satu
Coly di Accurate. "X Special" di Accurate dipetakan ke toko yang sama dengan "X".

## Protokol dengan Trizone

Trizone memanggil RPC dengan anon key + kode toko + kunci toko. Kunci disimpan sebagai sha256 di
`toko_kunci` (tidak terbaca lewat API).

| RPC | Arah | Isi |
|---|---|---|
| `terima_data(p)` | toko → kantor | `{protokol: 1, kode_toko, kunci, app_version, dikirim_at, shifts: [{shift, sales}], dokumen: {receptions, transfers, opnames}, snapshot}`. Satu panggilan = satu transaksi; balasan berisi `shift_diterima`. Kiriman ulang aman. |
| `ambil_master(p)` | kantor → toko | `{kode_toko, kunci, sejak}` → barang yang berubah sejak `sejak` |

## Uji

```bash
cd motherbase && node test/asisten.test.js
```

Dengan PostgreSQL lokal (database yang disebut dibuat ulang):

```bash
MB_PSQL="psql -h localhost -U postgres" node motherbase/test/uji.js
```

```bash
MB_DATABASE_URL=postgresql://postgres@localhost/mb_web_uji node motherbase/test/web.test.js
```

`uji.js` menjalankan toko Trizone sungguhan yang mengirim lewat `src/motherbase.js`;
`web.test.js` memakai aplikasi web di Chromium (Playwright) seperti pengguna.
