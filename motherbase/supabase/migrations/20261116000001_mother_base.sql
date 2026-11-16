-- =====================================================================
-- Mother Base Trizone — skema database (Supabase / PostgreSQL 15+)
--
-- Sumber data toko: Trizone (PC Gudang / Mandiri) mengirim langsung lewat HTTPS ke
-- RPC terima_data() dengan kode toko + kunci toko (src/motherbase.js di Trizone).
-- Trizone menyimpan antrean kiriman di pos.db, jadi toko tetap jalan tanpa internet.
--   * penjualan disimpan per shift; data shift yang lebih baru menggantikan shift itu;
--   * snapshot terbaru mengganti keadaan terkini (barang, stok); snapshot lama dilewati;
--   * riwayat dokumen (penerimaan, mutasi, opname) ditambah/diperbarui, tidak dihapus;
--   * kiriman ulang selalu aman (idempoten).
-- Master barang & harga jual diambil Trizone lewat RPC ambil_master().
--
-- Satuan barang selalu Biji. Waktu dari toko = jam lokal WIB.
-- Kode zona mengikuti Trizone: floor (Display Toko), warehouse (Gudang Utama),
-- damaged (Gudang BS), shopee (Gudang Shopee); luar toko: customer, supplier,
-- disposed, shopee_sold.
-- =====================================================================

create extension if not exists pgcrypto;
create schema if not exists mb;

-- ---------------------------------------------------------------------
-- 0. Tipe dan fungsi bantu
-- ---------------------------------------------------------------------
create type peran_pengguna as enum ('owner','admin_kantor','gudang','purchasing','pemilik_toko');
create type status_dokumen as enum ('BARU','DISETUJUI','DITOLAK');
create type status_po      as enum ('USULAN','DISETUJUI','DIKIRIM','SEBAGIAN','SELESAI','BATAL');
create type jenis_gudang   as enum ('TERIMA_PRINCIPAL','KIRIM_TOKO','RETUR_DARI_TOKO','RETUR_KE_PRINCIPAL','PENYESUAIAN');
create type sumber_harga   as enum ('PEMBELIAN','PRICELIST');

-- Jam lokal toko "YYYY-MM-DD HH:MM:SS" → timestamptz WIB.
create or replace function mb.wib(t text) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when t is null or btrim(t) = '' then null else (btrim(t) || '+07')::timestamptz end
$$;

create or replace function mb.tgl_wib(t timestamptz) returns date
language sql immutable set search_path = '' as $$ select (t at time zone 'Asia/Jakarta')::date $$;

-- Metode bayar Trizone → kelompok laporan. "Kartu Debit" (versi lama Trizone)
-- dihitung sebagai Transfer sesuai keputusan 16 Nov 2026.
create or replace function mb.kelompok_metode(m text) returns text
language sql immutable set search_path = '' as $$
  select case
    when upper(btrim(m)) in ('TUNAI','CASH') then 'TUNAI'
    when upper(btrim(m)) = 'QRIS' then 'QRIS'
    when upper(btrim(m)) in ('TRANSFER','KARTU DEBIT','DEBIT') then 'TRANSFER'
    else 'LAINNYA'
  end
$$;

create or replace function mb.is_zona_stok(z text) returns boolean
language sql immutable set search_path = '' as $$ select z in ('floor','warehouse','damaged','shopee') $$;

-- ---------------------------------------------------------------------
-- 1. Master data
-- ---------------------------------------------------------------------
create table toko (
  kode            char(3) primary key check (kode ~ '^[A-Z]{3}$'),
  nama            text not null,
  kota            text not null,
  nama_pt         text,
  batas_hari_sj   int  not null check (batas_hari_sj > 0),
  aktif           boolean not null default true,
  dibuat_at       timestamptz not null default now()
);

-- Nama pelanggan di Accurate → toko. "X Special" adalah toko yang sama dengan "X".
create table pelanggan_accurate (
  nama       text primary key,
  kode_toko  char(3) references toko(kode),   -- null = belum dipetakan
  catatan    text
);

create table principal (
  id                  bigint generated always as identity primary key,
  nama                text not null unique,
  lead_time_hari      int,
  periode_order_hari  int,
  jadwal_order        text,
  minimum_order_qty   int,
  minimum_order_rp    numeric(14,2),
  stok_pengaman_hari  int not null default 3,
  catatan_promo       text,
  diwawancara_at      timestamptz,
  aktif               boolean not null default true
);

-- Master produk kantor. SKU = kode barang Accurate = SKU Trizone.
create table produk (
  sku                 text primary key,
  nama                text not null,
  principal_id        bigint references principal(id),
  isi_dus             int  not null default 1 check (isi_dus > 0),   -- isi dus dari principal (pembulatan PO)
  barcode             text unique,
  merk                text,
  kategori            text,
  harga_jual_konsumen numeric(14,2),                                   -- harga jual di toko (dikirim ke Trizone)
  satuan_masuk        text not null default 'Dus',                     -- satuan kiriman ke toko, mis. Coly
  rasio_isi           int  not null default 1 check (rasio_isi > 0),   -- Biji per satuan masuk
  aktif               boolean not null default true,
  dibuat_at           timestamptz not null default now(),
  diubah_at           timestamptz not null default now()
);
create index on produk (principal_id);
create index on produk (diubah_at);
create or replace function mb.set_diubah_at() returns trigger language plpgsql set search_path = '' as $$
begin new.diubah_at := now(); return new; end $$;
create trigger produk_diubah before update on produk for each row execute function mb.set_diubah_at();

create table harga_beli (
  id          bigint generated always as identity primary key,
  sku         text not null references produk(sku),
  berlaku_at  date not null,
  harga       numeric(14,2) not null check (harga >= 0),
  sumber      sumber_harga not null,
  referensi   text,
  dicatat_at  timestamptz not null default now(),
  unique (sku, berlaku_at, sumber)
);

create table pengaturan (
  kunci  text primary key,
  nilai  jsonb not null
);

-- ---------------------------------------------------------------------
-- 2. Pengguna & hak akses
-- ---------------------------------------------------------------------
create table pengguna (
  id         uuid primary key references auth.users(id) on delete cascade,
  nama       text not null,
  peran      peran_pengguna not null,
  kode_toko  char(3) references toko(kode),
  aktif      boolean not null default true,
  check ((peran = 'pemilik_toko') = (kode_toko is not null))
);

create or replace function mb.peran_saya() returns peran_pengguna
language sql stable security definer set search_path = public as $$
  select peran from pengguna where id = auth.uid() and aktif
$$;
create or replace function mb.is_kantor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(mb.peran_saya() in ('owner','admin_kantor','gudang','purchasing'), false)
$$;
create or replace function mb.toko_saya() returns char(3)
language sql stable security definer set search_path = public as $$
  select kode_toko from pengguna where id = auth.uid() and aktif
$$;
create or replace function mb.boleh_lihat_toko(x char(3)) returns boolean
language sql stable set search_path = '' as $$ select mb.is_kantor() or x = mb.toko_saya() $$;

-- ---------------------------------------------------------------------
-- 3. Koneksi toko
-- ---------------------------------------------------------------------
-- Kunci toko (sha256). Tidak bisa dibaca pengguna mana pun lewat API (RLS tanpa policy).
create table toko_kunci (
  kode_toko   char(3) primary key references toko(kode),
  kunci_hash  text not null,
  dibuat_at   timestamptz not null default now()
);

create table kiriman_log (
  id             bigint generated always as identity primary key,
  kode_toko      char(3) not null references toko(kode),
  versi_trizone  text,
  dikirim_at     timestamptz,
  diterima_at    timestamptz not null default now(),
  jumlah         jsonb
);
create index on kiriman_log (kode_toko, diterima_at);

create table toko_status (
  kode_toko         char(3) primary key references toko(kode),
  versi_trizone        text,
  kiriman_terakhir_at  timestamptz,
  snapshot_terakhir_at timestamptz,
  shift_terakhir_at    timestamptz
);

-- ---------------------------------------------------------------------
-- 4. Data toko (dikirim Trizone)
-- ---------------------------------------------------------------------
-- Keadaan terkini (diganti setiap snapshot terbaru)
create table produk_toko (
  kode_toko   char(3) not null references toko(kode),
  sku         text not null,
  barcode     text,
  nama        text,
  merk        text,
  kategori    text,
  harga_jual  numeric(14,2),
  pack_unit   text,                    -- satuan masuk, mis. Dus / Coly
  pack_ratio  int,                     -- Biji per satuan masuk
  dibuat_at   timestamptz,
  primary key (kode_toko, sku)
);
create index on produk_toko (kode_toko, barcode);

create table stok_toko (
  kode_toko    char(3) not null references toko(kode),
  sku          text not null,
  display      numeric(12,3) not null default 0,   -- floor
  gudang       numeric(12,3) not null default 0,   -- warehouse
  bs           numeric(12,3) not null default 0,   -- damaged
  shopee       numeric(12,3) not null default 0,
  min_display  numeric(12,3),
  habis_at     timestamptz,
  per_waktu    timestamptz not null,
  primary key (kode_toko, sku)
);

-- Hari ketika stok jual (display + gudang + shopee) produk tercatat ≤ 0 di snapshot.
-- Dipakai agar hari stok kosong tidak menurunkan rata-rata permintaan.
create table stok_kosong_harian (
  kode_toko char(3) not null references toko(kode),
  tanggal   date not null,
  sku       text not null,
  primary key (kode_toko, tanggal, sku)
);

create table shift (
  kode_toko      char(3) not null references toko(kode),
  shift_uid      text not null,
  kasir          text,
  mulai_at       timestamptz,
  tutup_at       timestamptz,            -- null = masih berjalan
  catatan        text,
  jumlah_struk   int,
  qty            numeric(12,3),
  omzet          numeric(14,2),
  tunai          numeric(14,2),
  per_metode     jsonb,
  struk_darurat  int,
  data_at        timestamptz not null,   -- waktu data yang menang (tutup shift / snapshot)
  primary key (kode_toko, shift_uid)
);
create index on shift (kode_toko, tutup_at);

create table penjualan (
  kode_toko     char(3) not null,
  shift_uid     text not null,
  no_struk      text not null,
  baris_ke      int  not null,
  waktu         timestamptz not null,
  tanggal       date not null,
  sku           text,
  nama          text,
  qty           numeric(12,3) not null,
  harga         numeric(14,2),
  subtotal      numeric(14,2) not null,
  metode_bayar  text,
  primary key (kode_toko, shift_uid, no_struk, baris_ke),
  foreign key (kode_toko, shift_uid) references shift(kode_toko, shift_uid) on delete cascade
);
create index on penjualan (tanggal, kode_toko);
create index on penjualan (sku, tanggal);

-- Riwayat dokumen (tidak pernah dihapus)
create table penerimaan_toko (
  kode_toko    char(3) not null references toko(kode),
  no_sj        text not null,
  supplier     text,
  catatan      text,
  diterima_at  timestamptz,
  total_biji   numeric(12,3),
  primary key (kode_toko, no_sj)
);
create index on penerimaan_toko (no_sj);
create table penerimaan_toko_baris (
  kode_toko    char(3) not null,
  no_sj        text not null,
  baris_ke     int not null,
  sku          text not null,
  qty          numeric(12,3) not null,     -- Biji
  satuan_input text,                       -- Dus / Biji saat diinput
  zona         text check (mb.is_zona_stok(zona)),
  primary key (kode_toko, no_sj, baris_ke),
  foreign key (kode_toko, no_sj) references penerimaan_toko(kode_toko, no_sj)
);

-- Barang di file penerimaan yang belum terdaftar di Trizone (menunggu diproses toko)
create table penerimaan_draft_toko (
  kode_toko    char(3) not null references toko(kode),
  draft_id     bigint not null,
  no_sj        text,
  kode         text,
  nama         text,
  qty          numeric(12,3),
  satuan_input text,
  zona         text,
  dibuat_at    timestamptz,
  selesai_at   timestamptz,
  primary key (kode_toko, draft_id)
);

create table mutasi_toko (
  kode_toko    char(3) not null references toko(kode),
  no_dok       text not null,              -- MT-…
  dari         text not null,
  ke           text not null,
  alasan       text,
  waktu        timestamptz,
  jumlah_baris int,
  total_qty    numeric(12,3),
  primary key (kode_toko, no_dok)
);
create table mutasi_toko_baris (
  kode_toko  char(3) not null,
  no_dok     text not null,
  baris_ke   int not null,
  sku        text not null,
  qty        numeric(12,3) not null,
  primary key (kode_toko, no_dok, baris_ke),
  foreign key (kode_toko, no_dok) references mutasi_toko(kode_toko, no_dok)
);

create table stok_opname (
  kode_toko    char(3) not null references toko(kode),
  no_op        text not null,              -- OP-…
  zona         text not null check (mb.is_zona_stok(zona)),
  catatan      text,
  dibuat_at    timestamptz,
  hitung_at    timestamptz,                -- Tanggal_Stok (bila diisi), saat fisik dihitung
  jumlah_baris int,
  plus_qty     numeric(12,3),
  minus_qty    numeric(12,3),
  primary key (kode_toko, no_op)
);
create table stok_opname_baris (
  kode_toko    char(3) not null,
  no_op        text not null,
  baris_ke     int not null,
  sku          text not null,
  stok_sistem  numeric(12,3),
  fisik        numeric(12,3) not null,
  selisih      numeric(12,3),
  stok_sebelum numeric(12,3),
  primary key (kode_toko, no_op, baris_ke),
  foreign key (kode_toko, no_op) references stok_opname(kode_toko, no_op)
);
create table stok_opname_review (
  kode_toko     char(3) not null,
  no_op         text not null,
  status        status_dokumen not null default 'BARU',
  catatan       text,
  direview_oleh uuid references pengguna(id),
  direview_at   timestamptz,
  primary key (kode_toko, no_op),
  foreign key (kode_toko, no_op) references stok_opname(kode_toko, no_op)
);

create table transaksi_darurat (
  kode_toko    char(3) not null references toko(kode),
  no_struk     text not null,              -- OFF-…
  kasir        text,
  dibuat_at    timestamptz,
  disinkron_at timestamptz,
  total        numeric(14,2),
  status       text,                       -- ok / check / duplicate
  catatan      text,
  dicek_at     timestamptz,
  primary key (kode_toko, no_struk)
);

-- ---------------------------------------------------------------------
-- 5. Kantor: surat jalan (Accurate), gudang, purchasing
-- ---------------------------------------------------------------------
create table surat_jalan (
  no_sj          text primary key,         -- nomor DO Accurate, mis. DO.2026.11.00001
  pelanggan      text not null,            -- nama pelanggan di Accurate
  tanggal_kirim  date not null,
  sumber         text not null default 'ACCURATE' check (sumber in ('ACCURATE','MOTHERBASE')),
  file_sumber    text,
  diimpor_at     timestamptz not null default now(),
  diimpor_oleh   uuid references pengguna(id)
);
create index on surat_jalan (tanggal_kirim);

create table surat_jalan_baris (
  no_sj     text not null references surat_jalan(no_sj) on delete cascade,
  baris_ke  int  not null,
  kode      text not null,                 -- kode barang Accurate (= SKU / barcode Trizone)
  nama      text,
  qty       numeric(12,3) not null check (qty > 0),
  satuan    text not null,                 -- satuan Accurate: Pcs, Coly, ...
  primary key (no_sj, baris_ke)
);

create table gudang_mutasi (
  id            bigint generated always as identity primary key,
  waktu         timestamptz not null default now(),
  jenis         jenis_gudang not null,
  sku           text not null references produk(sku),
  qty           numeric(12,3) not null,
  referensi     text not null,
  dicatat_oleh  uuid references pengguna(id),
  unique (jenis, referensi, sku)
);

create table po (
  no_po          text primary key,
  principal_id   bigint not null references principal(id),
  tanggal        date not null default current_date,
  status         status_po not null default 'USULAN',
  dibuat_oleh    uuid references pengguna(id),
  disetujui_oleh uuid references pengguna(id),
  disetujui_at   timestamptz,
  no_po_accurate text,
  catatan        text
);
create table po_baris (
  no_po          text not null references po(no_po),
  sku            text not null references produk(sku),
  qty_usulan     numeric(12,3),
  qty_disetujui  numeric(12,3),
  harga          numeric(14,2),
  alasan         text,
  primary key (no_po, sku)
);
create table penerimaan_principal (
  no_terima     text primary key,
  no_po         text references po(no_po),
  tanggal       date not null,
  dicatat_oleh  uuid references pengguna(id)
);
create table penerimaan_principal_baris (
  no_terima  text not null references penerimaan_principal(no_terima),
  sku        text not null references produk(sku),
  qty        numeric(12,3) not null check (qty > 0),
  harga      numeric(14,2),
  primary key (no_terima, sku)
);

-- ---------------------------------------------------------------------
-- 6. Audit
-- ---------------------------------------------------------------------
create table audit_log (
  id        bigint generated always as identity primary key,
  waktu     timestamptz not null default now(),
  pengguna  uuid,
  tabel     text not null,
  aksi      text not null,
  data_lama jsonb,
  data_baru jsonb
);
create or replace function mb.catat_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (pengguna, tabel, aksi, data_lama, data_baru)
  values (auth.uid(), tg_table_name, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['toko','pelanggan_accurate','principal','produk','harga_beli','pengaturan','pengguna',
                           'gudang_mutasi','po','po_baris','penerimaan_principal','penerimaan_principal_baris',
                           'stok_opname_review']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$I
                    for each row execute function mb.catat_audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Menerapkan data dari toko
-- ---------------------------------------------------------------------
-- Penjualan satu shift. Data yang lebih baru (p_at) menang; yang lebih lama dilewati.
-- Shift yang ditutup memakai p_at = waktu tutup; shift berjalan memakai waktu snapshot,
-- jadi data tutup shift selalu menggantikan potongan shift berjalan.
create or replace function mb.terapkan_shift(p_kode char(3), sh jsonb, sales jsonb, p_at timestamptz)
returns boolean language plpgsql set search_path = public, mb as $$
declare
  v_ada   timestamptz;
  v_tutup timestamptz;
begin
  select data_at, tutup_at into v_ada, v_tutup from shift where kode_toko = p_kode and shift_uid = sh->>'shift_uid';
  if v_ada is not null and v_ada > p_at then return false; end if;
  -- Potongan shift berjalan tidak boleh membuka lagi shift yang sudah tertutup.
  if v_tutup is not null and sh->>'closed_at' is null then return false; end if;

  insert into shift as s (kode_toko, shift_uid, kasir, mulai_at, tutup_at, catatan, jumlah_struk, qty, omzet,
                          tunai, per_metode, struk_darurat, data_at)
  with l as (select x from jsonb_array_elements(coalesce(sales,'[]')) x)
  select p_kode, sh->>'shift_uid', sh->>'cashier_name', mb.wib(sh->>'shift_start'), mb.wib(sh->>'closed_at'),
         coalesce(sh->>'notes',''),
         coalesce((sh->>'receipts')::int, (select count(distinct x->>'receipt_no') from l)),
         coalesce((sh->>'qty')::numeric, (select coalesce(sum((x->>'qty')::numeric),0) from l)),
         coalesce((sh->>'revenue')::numeric, (select coalesce(sum((x->>'line_total')::numeric),0) from l)),
         coalesce((sh->>'cash_sales')::numeric,
                  (select coalesce(sum((x->>'line_total')::numeric),0) from l where x->>'payment_method' = 'Tunai')),
         sh->'by_method', coalesce((sh->>'offline_receipts')::int, 0), p_at
  on conflict (kode_toko, shift_uid) do update set
    kasir = excluded.kasir, mulai_at = excluded.mulai_at, tutup_at = excluded.tutup_at, catatan = excluded.catatan,
    jumlah_struk = excluded.jumlah_struk, qty = excluded.qty, omzet = excluded.omzet, tunai = excluded.tunai,
    per_metode = excluded.per_metode, struk_darurat = excluded.struk_darurat, data_at = excluded.data_at;

  delete from penjualan where kode_toko = p_kode and shift_uid = sh->>'shift_uid';
  insert into penjualan (kode_toko, shift_uid, no_struk, baris_ke, waktu, tanggal, sku, nama, qty, harga, subtotal, metode_bayar)
  select p_kode, sh->>'shift_uid', x->>'receipt_no', coalesce((x->>'line_no')::int, o::int),
         mb.wib(x->>'created_at'), mb.tgl_wib(mb.wib(x->>'created_at')),
         x->>'sku', x->>'product_name', (x->>'qty')::numeric, (x->>'unit_price')::numeric,
         (x->>'line_total')::numeric, x->>'payment_method'
  from jsonb_array_elements(coalesce(sales,'[]')) with ordinality t(x, o)
  on conflict (kode_toko, shift_uid, no_struk, baris_ke) do update
    set qty = excluded.qty, subtotal = excluded.subtotal;
  return true;
end $$;

-- Riwayat dokumen: penerimaan, mutasi, stok opname. Dokumen Trizone tidak berubah setelah dibuat;
-- kiriman ulang dokumen yang sama hanya mengganti barisnya bila kepalanya berbeda.
create or replace function mb.terapkan_dokumen(p_kode char(3), d jsonb) returns jsonb
language plpgsql set search_path = public, mb as $$
declare
  v_list text[];
  n_rc int := jsonb_array_length(coalesce(d->'receptions','[]'));
  n_tr int := jsonb_array_length(coalesce(d->'transfers','[]'));
  n_op int := jsonb_array_length(coalesce(d->'opnames','[]'));
begin
  with b as (
    insert into penerimaan_toko as t (kode_toko, no_sj, supplier, catatan, diterima_at, total_biji)
    select p_kode, x->>'reference_no', x->>'supplier_name', x->>'notes', mb.wib(x->>'received_at'),
           (x->>'total_items_count')::numeric
    from jsonb_array_elements(coalesce(d->'receptions','[]')) x
    where coalesce(x->>'reference_no','') <> ''
    on conflict (kode_toko, no_sj) do update
      set supplier = excluded.supplier, catatan = excluded.catatan,
          diterima_at = excluded.diterima_at, total_biji = excluded.total_biji
      where (t.diterima_at, t.total_biji, t.supplier, t.catatan)
            is distinct from (excluded.diterima_at, excluded.total_biji, excluded.supplier, excluded.catatan)
    returning no_sj)
  select coalesce(array_agg(no_sj), '{}') into v_list from b;
  delete from penerimaan_toko_baris where kode_toko = p_kode and no_sj = any(v_list);
  insert into penerimaan_toko_baris (kode_toko, no_sj, baris_ke, sku, qty, satuan_input, zona)
  select p_kode, x->>'reference_no', coalesce((l->>'line_no')::int, o::int), l->>'sku', (l->>'qty')::numeric,
         l->>'pack_type', l->>'destination'
  from jsonb_array_elements(coalesce(d->'receptions','[]')) x,
       jsonb_array_elements(coalesce(x->'items','[]')) with ordinality t(l, o)
  where x->>'reference_no' = any(v_list);

  with b as (
    insert into mutasi_toko as t (kode_toko, no_dok, dari, ke, alasan, waktu, jumlah_baris, total_qty)
    select p_kode, x->>'doc_no', x->>'from_zone', x->>'to_zone', x->>'reason', mb.wib(x->>'created_at'),
           (x->>'line_count')::int, (x->>'total_qty')::numeric
    from jsonb_array_elements(coalesce(d->'transfers','[]')) x
    where coalesce(x->>'doc_no','') <> ''
    on conflict (kode_toko, no_dok) do update
      set dari = excluded.dari, ke = excluded.ke, alasan = excluded.alasan, waktu = excluded.waktu,
          jumlah_baris = excluded.jumlah_baris, total_qty = excluded.total_qty
      where (t.waktu, t.jumlah_baris, t.total_qty) is distinct from (excluded.waktu, excluded.jumlah_baris, excluded.total_qty)
    returning no_dok)
  select coalesce(array_agg(no_dok), '{}') into v_list from b;
  delete from mutasi_toko_baris where kode_toko = p_kode and no_dok = any(v_list);
  insert into mutasi_toko_baris (kode_toko, no_dok, baris_ke, sku, qty)
  select p_kode, x->>'doc_no', coalesce((l->>'line_no')::int, o::int), l->>'sku', (l->>'qty')::numeric
  from jsonb_array_elements(coalesce(d->'transfers','[]')) x,
       jsonb_array_elements(coalesce(x->'lines','[]')) with ordinality t(l, o)
  where x->>'doc_no' = any(v_list);

  with b as (
    insert into stok_opname as t (kode_toko, no_op, zona, catatan, dibuat_at, hitung_at, jumlah_baris, plus_qty, minus_qty)
    select p_kode, x->>'doc_no', x->>'zone', x->>'notes', mb.wib(x->>'created_at'), mb.wib(x->>'count_at'),
           (x->>'line_count')::int, (x->>'plus_qty')::numeric, (x->>'minus_qty')::numeric
    from jsonb_array_elements(coalesce(d->'opnames','[]')) x
    where coalesce(x->>'doc_no','') <> ''
    on conflict (kode_toko, no_op) do update
      set zona = excluded.zona, catatan = excluded.catatan, dibuat_at = excluded.dibuat_at, hitung_at = excluded.hitung_at,
          jumlah_baris = excluded.jumlah_baris, plus_qty = excluded.plus_qty, minus_qty = excluded.minus_qty
      where (t.dibuat_at, t.jumlah_baris, t.plus_qty, t.minus_qty)
            is distinct from (excluded.dibuat_at, excluded.jumlah_baris, excluded.plus_qty, excluded.minus_qty)
    returning no_op)
  select coalesce(array_agg(no_op), '{}') into v_list from b;
  delete from stok_opname_baris where kode_toko = p_kode and no_op = any(v_list);
  insert into stok_opname_baris (kode_toko, no_op, baris_ke, sku, stok_sistem, fisik, selisih, stok_sebelum)
  select p_kode, x->>'doc_no', coalesce((l->>'line_no')::int, o::int), l->>'sku', (l->>'system_qty')::numeric,
         (l->>'counted_qty')::numeric, (l->>'diff')::numeric, (l->>'before_qty')::numeric
  from jsonb_array_elements(coalesce(d->'opnames','[]')) x,
       jsonb_array_elements(coalesce(x->'lines','[]')) with ordinality t(l, o)
  where x->>'doc_no' = any(v_list);
  -- SO baru atau berubah perlu direview (yang sudah disetujui dibuka lagi bila isinya berubah)
  insert into stok_opname_review (kode_toko, no_op)
  select p_kode, unnest(v_list)
  on conflict (kode_toko, no_op) do update set status = 'BARU', direview_oleh = null, direview_at = null;

  return jsonb_build_object('penerimaan', n_rc, 'mutasi', n_tr, 'opname', n_op);
end $$;

-- Keadaan terkini toko: barang, stok, draft penerimaan, transaksi darurat, shift berjalan.
-- Snapshot yang lebih lama dari yang sudah ada dilewati, jadi stok tidak mundur.
create or replace function mb.terapkan_snapshot(p_kode char(3), s jsonb) returns boolean
language plpgsql set search_path = public, mb as $$
declare
  v_at timestamptz := mb.wib(s->>'created_at');
  cs   jsonb := s->'current_shift';
begin
  if v_at is null then raise exception 'snapshot tanpa created_at'; end if;
  if exists (select 1 from toko_status where kode_toko = p_kode and snapshot_terakhir_at > v_at) then
    return false;
  end if;

  delete from produk_toko where kode_toko = p_kode;
  insert into produk_toko (kode_toko, sku, barcode, nama, merk, kategori, harga_jual, pack_unit, pack_ratio, dibuat_at)
  select p_kode, x->>'sku', nullif(x->>'barcode',''), x->>'name', x->>'brand', x->>'category',
         (x->>'unit_price')::numeric, x->>'pack_unit', (x->>'pack_ratio')::int, mb.wib(x->>'created_at')
  from jsonb_array_elements(coalesce(s->'products','[]')) x
  on conflict do nothing;

  delete from stok_toko where kode_toko = p_kode;
  insert into stok_toko (kode_toko, sku, display, gudang, bs, shopee, min_display, habis_at, per_waktu)
  select p_kode, x->>'sku', coalesce((x->>'floor_stock')::numeric,0), coalesce((x->>'warehouse_stock')::numeric,0),
         coalesce((x->>'damaged_stock')::numeric,0), coalesce((x->>'shopee_stock')::numeric,0),
         (x->>'min_floor_alert')::numeric, mb.wib(x->>'sold_out_at'), v_at
  from jsonb_array_elements(coalesce(s->'inventory','[]')) x
  on conflict do nothing;

  insert into stok_kosong_harian (kode_toko, tanggal, sku)
  select p_kode, mb.tgl_wib(v_at), sku from stok_toko
  where kode_toko = p_kode and display + gudang + shopee <= 0
  on conflict do nothing;

  delete from penerimaan_draft_toko where kode_toko = p_kode;
  insert into penerimaan_draft_toko (kode_toko, draft_id, no_sj, kode, nama, qty, satuan_input, zona, dibuat_at, selesai_at)
  select p_kode, (x->>'draft_id')::bigint, x->>'reference_no', x->>'code', x->>'name', (x->>'qty')::numeric,
         x->>'pack_type', x->>'destination', mb.wib(x->>'created_at'), mb.wib(x->>'resolved_at')
  from jsonb_array_elements(coalesce(s->'reception_drafts','[]')) x
  where x->>'draft_id' is not null
  on conflict do nothing;

  insert into transaksi_darurat (kode_toko, no_struk, kasir, dibuat_at, disinkron_at, total, status, catatan, dicek_at)
  select p_kode, x->>'receipt_no', x->>'cashier_name', mb.wib(x->>'created_at'), mb.wib(x->>'synced_at'),
         (x->>'total')::numeric, x->>'status', x->>'notes', mb.wib(x->>'checked_at')
  from jsonb_array_elements(coalesce(s->'offline_sales','[]')) x
  where coalesce(x->>'receipt_no','') <> ''
  on conflict (kode_toko, no_struk) do update
    set status = excluded.status, catatan = excluded.catatan, dicek_at = excluded.dicek_at,
        disinkron_at = excluded.disinkron_at, total = excluded.total;

  if cs is not null and jsonb_typeof(cs) = 'object' and cs->>'shift_uid' is not null then
    perform mb.terapkan_shift(p_kode, (cs - 'sales') || '{"closed_at": null}', cs->'sales', v_at);
  end if;
  return true;
end $$;

-- Kode toko + kunci toko → kode toko, atau error. Kunci disimpan sebagai sha256.
create or replace function mb.cek_kunci(p_kode text, p_kunci text) returns char(3)
language plpgsql stable security definer set search_path = public, mb, extensions as $$
declare v char(3);
begin
  select k.kode_toko into v
  from toko_kunci k join toko t on t.kode = k.kode_toko
  where k.kode_toko = upper(btrim(p_kode)) and t.aktif
    and k.kunci_hash = encode(digest(coalesce(p_kunci,''), 'sha256'), 'hex');
  if v is null then
    raise exception 'Kode toko atau kunci toko salah, atau toko tidak aktif.' using errcode = '28000';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 8. RPC
-- ---------------------------------------------------------------------
-- Dipanggil langsung oleh Trizone (PC Gudang / Mandiri) dengan anon key + kode & kunci toko.
-- Protokol v1:
-- p = { protokol: 1, kode_toko, kunci, app_version, dikirim_at,
--       shifts:   [{ shift: {shift_uid, cashier_name, shift_start, closed_at, notes, receipts, qty, revenue,
--                           cash_sales, by_method, offline_receipts}, sales: [...] }],
--       dokumen:  { receptions: [...], transfers: [...], opnames: [...] },
--       snapshot: null | { created_at, products, inventory, reception_drafts, offline_sales, current_shift } }
-- Satu kiriman = satu transaksi. Balasan berisi shift_uid yang diterima; Trizone baru menandai
-- data terkirim setelah balasan ini, jadi kiriman ulang selalu aman.
create or replace function public.terima_data(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  v_kode   char(3);
  v_shift  jsonb;
  v_uids   text[] := '{}';
  v_lama   int := 0;
  v_dok    jsonb := '{}';
  v_snap   boolean := null;
  v_closed timestamptz;
begin
  v_kode := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
  if coalesce((p->>'protokol')::int, 0) <> 1 then
    raise exception 'Versi protokol % tidak dikenal mother base (perbarui mother base).', p->>'protokol';
  end if;

  for v_shift in select x from jsonb_array_elements(coalesce(p->'shifts','[]')) x loop
    if v_shift->'shift'->>'shift_uid' is null or v_shift->'shift'->>'closed_at' is null then
      raise exception 'Data shift tanpa shift_uid atau closed_at';
    end if;
    v_closed := mb.wib(v_shift->'shift'->>'closed_at');
    if not mb.terapkan_shift(v_kode, v_shift->'shift', v_shift->'sales', v_closed) then v_lama := v_lama + 1; end if;
    v_uids := v_uids || (v_shift->'shift'->>'shift_uid');
  end loop;

  if p->'dokumen' is not null then v_dok := mb.terapkan_dokumen(v_kode, p->'dokumen'); end if;
  if jsonb_typeof(p->'snapshot') = 'object' then v_snap := mb.terapkan_snapshot(v_kode, p->'snapshot'); end if;

  insert into toko_status as s (kode_toko, versi_trizone, kiriman_terakhir_at, snapshot_terakhir_at, shift_terakhir_at)
  values (v_kode, p->>'app_version', now(),
          case when v_snap then mb.wib(p->'snapshot'->>'created_at') end,
          (select max(mb.wib(x->'shift'->>'closed_at')) from jsonb_array_elements(coalesce(p->'shifts','[]')) x))
  on conflict (kode_toko) do update set
    versi_trizone        = coalesce(excluded.versi_trizone, s.versi_trizone),
    kiriman_terakhir_at  = now(),
    snapshot_terakhir_at = greatest(s.snapshot_terakhir_at, excluded.snapshot_terakhir_at),
    shift_terakhir_at    = greatest(s.shift_terakhir_at, excluded.shift_terakhir_at);

  insert into kiriman_log (kode_toko, versi_trizone, dikirim_at, jumlah)
  values (v_kode, p->>'app_version', mb.wib(p->>'dikirim_at'),
          jsonb_build_object('shift', jsonb_array_length(coalesce(p->'shifts','[]')), 'shift_lama', v_lama,
                             'snapshot', v_snap) || v_dok);

  return jsonb_build_object('ok', true, 'kode_toko', v_kode, 'shift_diterima', to_jsonb(v_uids),
                            'snapshot', v_snap, 'dokumen', v_dok, 'server_at', now());
end $$;

-- Master barang & harga jual untuk Trizone (daftar barang terkunci di toko).
-- p = { kode_toko, kunci, sejak (opsional, ISO) } → { server_at, produk: [...] }
create or replace function public.ambil_master(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, mb as $$
declare
  v_kode  char(3);
  v_sejak timestamptz := nullif(p->>'sejak','')::timestamptz;
begin
  v_kode := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
  return jsonb_build_object(
    'kode_toko', v_kode,
    'server_at', now(),
    'produk', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', sku, 'barcode', barcode, 'name', nama, 'brand', merk, 'category', kategori,
        'unit_price', harga_jual_konsumen, 'pack_unit', satuan_masuk, 'pack_ratio', rasio_isi,
        'aktif', aktif, 'diubah_at', diubah_at) order by sku)
      from produk
      where barcode is not null and harga_jual_konsumen is not null
        and (v_sejak is null or diubah_at > v_sejak)), '[]'::jsonb));
end $$;

-- Membuat (atau mengganti) kunci toko. Kunci hanya ditampilkan sekali; masukkan di
-- Trizone: Pengaturan → Mother Base. Kunci lama langsung tidak berlaku.
create or replace function public.buat_kunci_toko(p_kode char(3)) returns text
language plpgsql security definer set search_path = public, mb, extensions as $$
declare v text := encode(gen_random_bytes(24), 'hex');
begin
  if auth.uid() is not null and mb.peran_saya() is distinct from 'owner' then
    raise exception 'Hanya owner yang boleh membuat kunci toko';
  end if;
  if not exists (select 1 from toko where kode = p_kode) then raise exception 'Kode toko % tidak ada', p_kode; end if;
  insert into toko_kunci (kode_toko, kunci_hash, dibuat_at) values (p_kode, encode(digest(v, 'sha256'), 'hex'), now())
  on conflict (kode_toko) do update set kunci_hash = excluded.kunci_hash, dibuat_at = now();
  return v;
end $$;

-- Mengisi master produk kantor dari daftar barang satu toko (sekali, saat mulai).
-- Barang yang sudah ada di master tidak diubah.
create or replace function public.isi_master_dari_toko(p_kode char(3)) returns int
language plpgsql security definer set search_path = public, mb as $$
declare n int;
begin
  if auth.uid() is not null and not mb.is_kantor() then raise exception 'Hanya pengguna kantor'; end if;
  insert into produk (sku, nama, barcode, merk, kategori, harga_jual_konsumen, satuan_masuk, rasio_isi)
  select sku, nama, barcode, merk, kategori, harga_jual, coalesce(pack_unit,'Dus'), coalesce(pack_ratio,1)
  from produk_toko where kode_toko = p_kode
  on conflict (sku) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Toko yang belum menutup shift pada tanggal tertentu.
create or replace function public.laporan_belum_masuk(p_tanggal date default current_date - 1)
returns table(kode char(3), nama text, terhubung boolean, shift_terakhir timestamptz, kiriman_terakhir timestamptz)
language sql stable security definer set search_path = public, mb as $$
  select t.kode, t.nama, exists (select 1 from toko_kunci k where k.kode_toko = t.kode),
         s.shift_terakhir_at, s.kiriman_terakhir_at
  from toko t left join toko_status s on s.kode_toko = t.kode
  where t.aktif and (auth.uid() is null or mb.boleh_lihat_toko(t.kode))
    and not exists (select 1 from shift x where x.kode_toko = t.kode and mb.tgl_wib(x.tutup_at) = p_tanggal)
  order by t.kode
$$;

-- Import surat jalan dari laporan Accurate "Rincian Pengiriman Pesanan"
-- (dibaca oleh motherbase/accurate/accurate-do.js).
-- p = {file, do: [{no, tanggal, pelanggan, items: [{kode, nama, qty, satuan}]}]}
-- DO yang diimpor ulang menggantikan baris lamanya.
create or replace function public.import_surat_jalan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  n_baru int; n_ganti int;
  v_belum text[];
begin
  if auth.uid() is not null and not mb.is_kantor() then raise exception 'Hanya pengguna kantor'; end if;

  insert into pelanggan_accurate (nama)
  select distinct btrim(x->>'pelanggan') from jsonb_array_elements(p->'do') x
  on conflict do nothing;

  select count(*) filter (where s.no_sj is null), count(*) filter (where s.no_sj is not null)
    into n_baru, n_ganti
  from jsonb_array_elements(p->'do') x left join surat_jalan s on s.no_sj = x->>'no';

  insert into surat_jalan (no_sj, pelanggan, tanggal_kirim, sumber, file_sumber, diimpor_oleh)
  select x->>'no', btrim(x->>'pelanggan'), (x->>'tanggal')::date, 'ACCURATE', p->>'file', auth.uid()
  from jsonb_array_elements(p->'do') x
  on conflict (no_sj) do update set pelanggan = excluded.pelanggan, tanggal_kirim = excluded.tanggal_kirim,
    file_sumber = excluded.file_sumber, diimpor_at = now(), diimpor_oleh = excluded.diimpor_oleh;

  delete from surat_jalan_baris where no_sj in (select x->>'no' from jsonb_array_elements(p->'do') x);
  insert into surat_jalan_baris (no_sj, baris_ke, kode, nama, qty, satuan)
  select x->>'no', o::int, btrim(i->>'kode'), i->>'nama', (i->>'qty')::numeric, btrim(i->>'satuan')
  from jsonb_array_elements(p->'do') x, jsonb_array_elements(x->'items') with ordinality t(i, o);

  select coalesce(array_agg(distinct pa.nama), '{}') into v_belum
  from jsonb_array_elements(p->'do') x join pelanggan_accurate pa on pa.nama = btrim(x->>'pelanggan')
  where pa.kode_toko is null;

  return jsonb_build_object('do_baru', n_baru, 'do_diganti', n_ganti, 'pelanggan_belum_dipetakan', v_belum);
end $$;

-- ---------------------------------------------------------------------
-- 9. View hitungan
-- ---------------------------------------------------------------------
create or replace view v_harga_produk with (security_invoker = true) as
with terakhir as (
  select distinct on (sku) sku, harga, berlaku_at, sumber
  from harga_beli order by sku, berlaku_at desc, (sumber = 'PRICELIST') desc
)
select p.sku, p.nama, t.harga as harga_beli_dasar, t.berlaku_at, t.sumber,
       round(t.harga * (1 + coalesce((select (nilai #>> '{}')::numeric from pengaturan
                                      where kunci = 'markup_jual_ke_toko'), 0)), 0) as harga_jual_ke_toko,
       p.harga_jual_konsumen
from produk p left join terakhir t using (sku);

create or replace view v_ringkasan_harian with (security_invoker = true) as
select kode_toko, tanggal,
       sum(subtotal) as omzet,
       count(distinct no_struk) as jumlah_transaksi,
       sum(qty) as qty,
       sum(subtotal) filter (where mb.kelompok_metode(metode_bayar) = 'TUNAI')    as tunai,
       sum(subtotal) filter (where mb.kelompok_metode(metode_bayar) = 'QRIS')     as qris,
       sum(subtotal) filter (where mb.kelompok_metode(metode_bayar) = 'TRANSFER') as transfer,
       count(distinct no_struk) filter (where no_struk like 'OFF-%')              as struk_darurat
from penjualan group by kode_toko, tanggal;

create or replace view v_penjualan_kasir with (security_invoker = true) as
select p.kode_toko, p.tanggal, s.kasir, mb.kelompok_metode(p.metode_bayar) as metode,
       sum(p.subtotal) as nilai, count(distinct p.no_struk) as jumlah_struk
from penjualan p join shift s using (kode_toko, shift_uid)
group by p.kode_toko, p.tanggal, s.kasir, mb.kelompok_metode(p.metode_bayar);

-- Permintaan = jual di kasir + terjual di Shopee (mutasi shopee → shopee_sold).
create or replace view v_permintaan_harian with (security_invoker = true) as
select kode_toko, tanggal, sku, sum(qty) as qty, sum(subtotal) as nilai, 'KASIR'::text as kanal
from penjualan group by kode_toko, tanggal, sku
union all
select m.kode_toko, mb.tgl_wib(m.waktu), b.sku, sum(b.qty), null, 'SHOPEE'
from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
where m.ke = 'shopee_sold'
group by m.kode_toko, mb.tgl_wib(m.waktu), b.sku;

-- Baris surat jalan dalam Biji. Kode Accurate dicocokkan ke SKU atau barcode
-- produk di toko tujuan; satuan Pcs/Biji = 1, satuan lain = isi satuan masuk Trizone
-- (sama dengan aturan import penerimaan Trizone).
create or replace view v_sj_baris_biji with (security_invoker = true) as
select b.no_sj, b.baris_ke, sj.pelanggan, pa.kode_toko, sj.tanggal_kirim, b.kode, b.nama, b.qty, b.satuan,
       pt.sku,
       case when lower(b.satuan) in ('pcs','pc','biji') then b.qty
            when pt.pack_ratio is not null then b.qty * pt.pack_ratio
       end as qty_biji,
       pt.pack_unit
from surat_jalan_baris b
join surat_jalan sj using (no_sj)
left join pelanggan_accurate pa on pa.nama = sj.pelanggan
left join lateral (
  select sku, pack_unit, pack_ratio from produk_toko t
  where t.kode_toko = pa.kode_toko and (t.sku = b.kode or t.barcode = b.kode)
  order by (t.sku = b.kode) desc limit 1
) pt on true;

create or replace view v_pencocokan_sj with (security_invoker = true) as
with kirim as (
  select no_sj, kode_toko, coalesce(sku, kode) as sku, sum(qty_biji) as qty,
         bool_or(qty_biji is null) as satuan_belum_jelas
  from v_sj_baris_biji group by no_sj, kode_toko, coalesce(sku, kode)
),
terima as (
  select kode_toko, no_sj, sku, sum(qty) as qty
  from penerimaan_toko_baris group by kode_toko, no_sj, sku
),
terima_sj as (   -- hanya penerimaan di toko tujuan SJ itu
  select t.* from terima t
  join surat_jalan sj on sj.no_sj = t.no_sj
  join pelanggan_accurate pa on pa.nama = sj.pelanggan and pa.kode_toko = t.kode_toko
),
gabung as (
  select coalesce(k.no_sj, t.no_sj) as no_sj, k.sku as sku_kirim, t.sku as sku_terima,
         k.qty as qty_kirim, t.qty as qty_terima, coalesce(k.satuan_belum_jelas, false) as satuan_belum_jelas
  from kirim k full join terima_sj t on t.no_sj = k.no_sj and t.sku = k.sku
)
select sj.no_sj, sj.pelanggan, pa.kode_toko, sj.tanggal_kirim, tk.batas_hari_sj,
       sj.tanggal_kirim + tk.batas_hari_sj as batas_input,
       (select min(diterima_at) from penerimaan_toko pt where pt.no_sj = sj.no_sj and pt.kode_toko = pa.kode_toko) as diinput_at,
       count(*) filter (where g.sku_kirim is not null) as baris_kirim,
       count(*) filter (where g.sku_kirim is not null and g.sku_terima is null) as barang_kurang,
       count(*) filter (where g.sku_kirim is null and g.sku_terima is not null) as barang_lebih,
       count(*) filter (where g.qty_kirim <> g.qty_terima) as baris_selisih_qty,
       case
         when pa.kode_toko is null then 'PELANGGAN_BELUM_DIPETAKAN'
         when bool_or(g.satuan_belum_jelas) then 'SATUAN_BELUM_JELAS'
         when count(*) filter (where g.sku_terima is not null) = 0 then
           case when current_date > sj.tanggal_kirim + tk.batas_hari_sj then 'BELUM_DIINPUT' else 'MENUNGGU' end
         when count(*) filter (where g.sku_kirim is null or g.sku_terima is null) > 0 then 'BARANG_SALAH'
         when count(*) filter (where g.qty_kirim <> g.qty_terima) > 0 then 'SELISIH_QTY'
         else 'COCOK'
       end as status
from surat_jalan sj
left join pelanggan_accurate pa on pa.nama = sj.pelanggan
left join toko tk on tk.kode = pa.kode_toko
left join gabung g on g.no_sj = sj.no_sj
group by sj.no_sj, sj.pelanggan, pa.kode_toko, sj.tanggal_kirim, tk.batas_hari_sj;

-- Penerimaan toko yang nomornya tidak ada di data kantor (sejak tanggal mulai pencocokan).
create or replace view v_sj_tidak_dikenal with (security_invoker = true) as
select t.kode_toko, t.no_sj, t.supplier, t.diterima_at, t.total_biji
from penerimaan_toko t
where t.diterima_at >= coalesce((select (nilai #>> '{}')::date from pengaturan where kunci = 'mulai_pencocokan_sj'),
                                '2100-01-01')
  and not exists (select 1 from surat_jalan s where s.no_sj = t.no_sj);

-- Semua pergerakan stok toko per zona. Penjualan kasir mengurangi Display Toko.
create or replace view v_ledger_toko with (security_invoker = true) as
  select kode_toko, sku, 'floor'::text as zona, waktu, -qty as qty, 'PENJUALAN'::text as sumber, no_struk as referensi
  from penjualan
union all
  select h.kode_toko, b.sku, b.zona, h.diterima_at, b.qty, 'PENERIMAAN', h.no_sj
  from penerimaan_toko h join penerimaan_toko_baris b using (kode_toko, no_sj)
union all
  select m.kode_toko, b.sku, m.dari, m.waktu, -b.qty, 'MUTASI', m.no_dok
  from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok) where mb.is_zona_stok(m.dari)
union all
  select m.kode_toko, b.sku, m.ke, m.waktu, b.qty, 'MUTASI', m.no_dok
  from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok) where mb.is_zona_stok(m.ke);

-- Stok seharusnya per toko/produk/zona:
--   fisik SO terakhir yang disetujui + diterima − terjual + retur pelanggan
--   − retur ke kantor − dibuang ± pindah zona, sejak waktu SO itu.
create or replace view v_stok_seharusnya with (security_invoker = true) as
with so as (
  select distinct on (o.kode_toko, b.sku, o.zona)
         o.kode_toko, b.sku, o.zona, b.fisik, coalesce(o.hitung_at, o.dibuat_at) as waktu, o.no_op
  from stok_opname o
  join stok_opname_baris b using (kode_toko, no_op)
  join stok_opname_review r using (kode_toko, no_op)
  where r.status = 'DISETUJUI'
  order by o.kode_toko, b.sku, o.zona, coalesce(o.hitung_at, o.dibuat_at) desc
),
kunci as (
  select kode_toko, sku, zona from so union select kode_toko, sku, zona from v_ledger_toko
)
select k.kode_toko, k.sku, k.zona, s.no_op as so_patokan, s.waktu as waktu_so,
       coalesce(s.fisik, 0) + coalesce(sum(l.qty), 0) as stok_seharusnya
from kunci k
left join so s using (kode_toko, sku, zona)
left join v_ledger_toko l
  on l.kode_toko = k.kode_toko and l.sku = k.sku and l.zona = k.zona
 and l.waktu > coalesce(s.waktu, '-infinity'::timestamptz)
group by k.kode_toko, k.sku, k.zona, s.no_op, s.waktu, s.fisik;

-- Stok Trizone saat snapshot terakhir, per zona (bentuk panjang).
create or replace view v_stok_trizone with (security_invoker = true) as
select kode_toko, sku, z.zona, z.qty, per_waktu
from stok_toko,
     lateral (values ('floor', display), ('warehouse', gudang), ('damaged', bs), ('shopee', shopee)) z(zona, qty);

-- Selisih stok seharusnya vs Trizone. Hanya bermakna setelah ada SO patokan.
create or replace view v_selisih_snapshot with (security_invoker = true) as
select t.kode_toko, t.sku, t.zona, t.per_waktu, t.qty as stok_trizone, s.so_patokan,
       s.stok_seharusnya, t.qty - s.stok_seharusnya as selisih
from v_stok_trizone t
join v_stok_seharusnya s using (kode_toko, sku, zona)
where s.so_patokan is not null and t.qty <> s.stok_seharusnya;

create or replace view v_selisih_so with (security_invoker = true) as
select o.kode_toko, o.no_op, o.zona, b.sku, coalesce(pt.nama, p.nama) as nama, b.stok_sistem, b.fisik, b.selisih,
       b.selisih * h.harga_jual_ke_toko as nilai_selisih, r.status, coalesce(o.hitung_at, o.dibuat_at) as waktu
from stok_opname o
join stok_opname_baris b using (kode_toko, no_op)
join stok_opname_review r using (kode_toko, no_op)
left join produk p on p.sku = b.sku
left join produk_toko pt on pt.kode_toko = o.kode_toko and pt.sku = b.sku
left join v_harga_produk h on h.sku = b.sku;

-- Stok yang bisa dijual: Display + Gudang Utama + Gudang Shopee (Gudang BS tidak).
create or replace view v_stok_tersedia with (security_invoker = true) as
select kode_toko, sku, display + gudang + shopee as stok, per_waktu from stok_toko;

create or replace view v_stok_gudang with (security_invoker = true) as
select sku, sum(qty) as stok from gudang_mutasi group by sku;

create or replace view v_po_belum_datang with (security_invoker = true) as
select b.sku, sum(coalesce(b.qty_disetujui, b.qty_usulan)
                  - coalesce((select sum(pb.qty) from penerimaan_principal pp
                              join penerimaan_principal_baris pb using (no_terima)
                              where pp.no_po = b.no_po and pb.sku = b.sku), 0)) as qty
from po_baris b join po using (no_po)
where po.status in ('DISETUJUI','DIKIRIM','SEBAGIAN')
group by b.sku;

-- Usulan beli ke principal:
--   rata-rata jual harian × (lead time + periode order) + stok pengaman
--   − (stok gudang + stok tersedia 9 toko + PO belum datang), dibulatkan ke isi dus.
-- Rata-rata per toko = jual 28 hari ÷ hari stok tidak kosong, lalu dijumlah 9 toko.
create or replace view v_usulan_beli with (security_invoker = true) as
with jual as (
  select kode_toko, sku, sum(qty) as qty from v_permintaan_harian
  where tanggal >= current_date - 28 and tanggal < current_date group by kode_toko, sku
),
kosong as (
  select kode_toko, sku, count(*) as hari from stok_kosong_harian
  where tanggal >= current_date - 28 and tanggal < current_date group by kode_toko, sku
),
rata as (
  select j.sku, sum(j.qty / greatest(28 - coalesce(k.hari, 0), 1)) as rata_harian
  from jual j left join kosong k using (kode_toko, sku) group by j.sku
),
hitung as (
  select p.sku, p.nama, p.principal_id, pr.nama as principal, p.isi_dus,
         coalesce(pr.minimum_order_qty, 0) as minimum_order_qty,
         coalesce(r.rata_harian, 0) as rata_harian,
         coalesce(pr.lead_time_hari, 7) as lead_time, coalesce(pr.periode_order_hari, 7) as periode_order,
         coalesce(r.rata_harian, 0) * pr.stok_pengaman_hari as stok_pengaman,
         coalesce(g.stok, 0) as stok_gudang,
         coalesce((select sum(stok) from v_stok_tersedia s where s.sku = p.sku), 0) as stok_toko,
         coalesce(o.qty, 0) as po_belum_datang
  from produk p
  join principal pr on pr.id = p.principal_id
  left join rata r on r.sku = p.sku
  left join v_stok_gudang g on g.sku = p.sku
  left join v_po_belum_datang o on o.sku = p.sku
  where p.aktif
)
select h.*,
       h.rata_harian * (h.lead_time + h.periode_order) + h.stok_pengaman
         - (h.stok_gudang + h.stok_toko + h.po_belum_datang) as kebutuhan,
       case when h.rata_harian * (h.lead_time + h.periode_order) + h.stok_pengaman
                 - (h.stok_gudang + h.stok_toko + h.po_belum_datang) <= 0 then 0
            else greatest(ceil((h.rata_harian * (h.lead_time + h.periode_order) + h.stok_pengaman
                                - (h.stok_gudang + h.stok_toko + h.po_belum_datang)) / h.isi_dus) * h.isi_dus,
                          h.minimum_order_qty)
       end as usulan_qty
from hitung h;

-- ---------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- Tabel kantor: hanya pengguna kantor.
  foreach t in array array['pelanggan_accurate','principal','produk','harga_beli','pengaturan','surat_jalan',
                           'surat_jalan_baris','gudang_mutasi','po','po_baris','penerimaan_principal',
                           'penerimaan_principal_baris','audit_log','kiriman_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy kantor_baca on %I for select to authenticated using ((select mb.is_kantor()))', t);
  end loop;
  foreach t in array array['pelanggan_accurate','principal','produk','harga_beli','gudang_mutasi','po','po_baris',
                           'penerimaan_principal','penerimaan_principal_baris']
  loop
    execute format('create policy kantor_tulis on %I for insert to authenticated with check ((select mb.is_kantor()))', t);
    execute format('create policy kantor_ubah on %I for update to authenticated using ((select mb.is_kantor()))', t);
  end loop;

  -- Tabel per toko: kantor melihat semua, pemilik toko hanya tokonya. Ditulis lewat terima_data.
  foreach t in array array['toko_status','produk_toko','stok_toko','stok_kosong_harian','shift','penjualan',
                           'penerimaan_toko','penerimaan_toko_baris','penerimaan_draft_toko','mutasi_toko',
                           'mutasi_toko_baris','stok_opname','stok_opname_baris','stok_opname_review',
                           'transaksi_darurat']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy baca_per_toko on %I for select to authenticated using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()))', t);
  end loop;
end $$;

-- Kunci toko: RLS aktif TANPA policy, jadi tidak terbaca lewat API oleh siapa pun (hanya fungsi security definer).
alter table toko_kunci enable row level security;

-- Index untuk relasi yang sering di-join
create index on pelanggan_accurate (kode_toko);
create index on po (principal_id);
create index on po_baris (sku);
create index on penerimaan_principal (no_po);
create index on gudang_mutasi (sku);

create policy kantor_review on stok_opname_review for update to authenticated using ((select mb.is_kantor()));

alter table toko enable row level security;
create policy baca_toko on toko for select to authenticated using ((select mb.peran_saya()) is not null);
create policy owner_ubah_toko on toko for all to authenticated
  using ((select mb.peran_saya()) = 'owner') with check ((select mb.peran_saya()) = 'owner');

alter table pengguna enable row level security;
create policy lihat_diri on pengguna for select to authenticated using (id = (select auth.uid()) or (select mb.peran_saya()) = 'owner');
create policy owner_kelola on pengguna for all to authenticated
  using ((select mb.peran_saya()) = 'owner') with check ((select mb.peran_saya()) = 'owner');

-- Hanya owner yang boleh menyetujui PO.
create or replace function mb.cek_persetujuan_po() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'DISETUJUI' and old.status is distinct from 'DISETUJUI' then
    if auth.uid() is not null and mb.peran_saya() is distinct from 'owner' then
      raise exception 'Hanya owner yang boleh menyetujui PO';
    end if;
    new.disetujui_oleh := auth.uid();
    new.disetujui_at := now();
  end if;
  return new;
end $$;
create trigger po_persetujuan before update on po for each row execute function mb.cek_persetujuan_po();

revoke all on function public.terima_data(jsonb)          from public, authenticated;
revoke all on function public.ambil_master(jsonb)         from public, authenticated;
revoke all on function public.buat_kunci_toko(char)       from public, anon;
revoke all on function public.isi_master_dari_toko(char)  from public, anon;
revoke all on function public.import_surat_jalan(jsonb)   from public, anon;
revoke all on function public.laporan_belum_masuk(date)   from public, anon;
revoke all on function mb.cek_kunci(text, text)           from public, anon, authenticated;
-- Trizone memanggil dengan anon key; keamanan dari kode + kunci toko.
grant execute on function public.terima_data(jsonb)       to anon, service_role;
grant execute on function public.ambil_master(jsonb)      to anon, service_role;
grant execute on function public.buat_kunci_toko(char)    to service_role, authenticated;
grant execute on function public.isi_master_dari_toko(char) to service_role, authenticated;
grant execute on function public.import_surat_jalan(jsonb) to service_role, authenticated;
grant execute on function public.laporan_belum_masuk(date) to service_role, authenticated;
grant usage on schema mb to authenticated, service_role;
