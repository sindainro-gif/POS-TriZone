-- =====================================================================
-- Mother Base Trizone — pesanan pelanggan dari toko
--
-- Trizone 1.22.0 mengirim pesanan pelanggan di snapshot (s->'orders'): semua yang belum diambil,
-- ditambah yang dibuat / selesai dalam 60 hari terakhir. Mother base menyimpan semuanya; pesanan
-- yang tidak ada lagi di snapshot (sudah lama selesai) tidak dihapus, jadi riwayatnya tetap ada.
-- Status: baru (belum diambil), diambil, batal. Deposit = uang muka (bukan omzet); saat diambil,
-- pesanan tercatat sebagai penjualan biasa di nota no_nota.
-- =====================================================================

create table pesanan_toko (
  kode_toko           char(3) not null references toko(kode),
  no_pesanan          text not null,
  nama_pelanggan      text not null,
  hp                  text,
  tanggal_ambil       date not null,
  catatan             text,
  total               numeric(14,2) not null,
  deposit             numeric(14,2) not null default 0,
  status              text not null check (status in ('baru', 'diambil', 'batal')),
  dibuat_at           timestamptz not null,
  dibuat_oleh         text,
  selesai_at          timestamptz,              -- diambil / dibatalkan
  selesai_oleh        text,
  no_nota             text,                     -- nota penjualan saat diambil
  zona_ambil          text,                     -- floor / warehouse
  alasan_batal        text,
  deposit_batal       text check (deposit_batal is null or deposit_batal in ('kembali', 'hangus')),
  batal_disetujui_oleh text,
  diperbarui_at       timestamptz not null default now(),
  primary key (kode_toko, no_pesanan)
);
create index on pesanan_toko (status, tanggal_ambil);

create table pesanan_toko_baris (
  kode_toko   char(3) not null,
  no_pesanan  text not null,
  baris_ke    int not null,
  sku         text,
  nama        text,
  qty         numeric(12,3) not null,
  harga       numeric(14,2),
  subtotal    numeric(14,2) not null,
  primary key (kode_toko, no_pesanan, baris_ke),
  foreign key (kode_toko, no_pesanan) references pesanan_toko(kode_toko, no_pesanan) on delete cascade
);

-- Kantor melihat semua toko, pemilik toko hanya tokonya. Ditulis lewat terima_data.
alter table pesanan_toko enable row level security;
alter table pesanan_toko_baris enable row level security;
create policy baca_per_toko on pesanan_toko for select to authenticated
  using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()));
create policy baca_per_toko on pesanan_toko_baris for select to authenticated
  using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()));

-- Pesanan dari snapshot: kepala di-upsert (hanya bila berubah), barisnya diganti.
create or replace function mb.terapkan_pesanan(p_kode char(3), orders jsonb) returns int
language plpgsql set search_path = public, mb as $$
declare
  v_list text[];
begin
  with b as (
    insert into pesanan_toko as t (kode_toko, no_pesanan, nama_pelanggan, hp, tanggal_ambil, catatan, total, deposit, status,
                                   dibuat_at, dibuat_oleh, selesai_at, selesai_oleh, no_nota, zona_ambil, alasan_batal,
                                   deposit_batal, batal_disetujui_oleh)
    select p_kode, x->>'order_no', coalesce(nullif(x->>'customer_name', ''), '-'), nullif(x->>'customer_phone', ''),
           (x->>'pickup_date')::date, nullif(x->>'notes', ''), coalesce((x->>'total')::numeric, 0), coalesce((x->>'deposit')::numeric, 0),
           x->>'status', mb.wib(x->>'created_at'), x->>'created_by', mb.wib(x->>'done_at'), x->>'done_by',
           nullif(x->>'receipt_no', ''), nullif(x->>'pickup_zone', ''), nullif(x->>'cancel_reason', ''),
           nullif(x->>'cancel_deposit', ''), nullif(x->>'cancel_approved_by', '')
    from jsonb_array_elements(coalesce(orders, '[]')) x
    where coalesce(x->>'order_no', '') <> '' and x->>'status' in ('baru', 'diambil', 'batal')
    on conflict (kode_toko, no_pesanan) do update set
      nama_pelanggan = excluded.nama_pelanggan, hp = excluded.hp, tanggal_ambil = excluded.tanggal_ambil, catatan = excluded.catatan,
      total = excluded.total, deposit = excluded.deposit, status = excluded.status, dibuat_at = excluded.dibuat_at,
      dibuat_oleh = excluded.dibuat_oleh, selesai_at = excluded.selesai_at, selesai_oleh = excluded.selesai_oleh,
      no_nota = excluded.no_nota, zona_ambil = excluded.zona_ambil, alasan_batal = excluded.alasan_batal,
      deposit_batal = excluded.deposit_batal, batal_disetujui_oleh = excluded.batal_disetujui_oleh, diperbarui_at = now()
      where (t.nama_pelanggan, t.hp, t.tanggal_ambil, t.catatan, t.total, t.deposit, t.status, t.selesai_at, t.no_nota, t.alasan_batal)
            is distinct from (excluded.nama_pelanggan, excluded.hp, excluded.tanggal_ambil, excluded.catatan, excluded.total,
                              excluded.deposit, excluded.status, excluded.selesai_at, excluded.no_nota, excluded.alasan_batal)
    returning no_pesanan)
  select coalesce(array_agg(no_pesanan), '{}') into v_list from b;

  delete from pesanan_toko_baris where kode_toko = p_kode and no_pesanan = any(v_list);
  insert into pesanan_toko_baris (kode_toko, no_pesanan, baris_ke, sku, nama, qty, harga, subtotal)
  select p_kode, x->>'order_no', o::int, i->>'sku', i->>'name', (i->>'qty')::numeric, (i->>'unit_price')::numeric,
         coalesce((i->>'line_total')::numeric, 0)
  from jsonb_array_elements(coalesce(orders, '[]')) x,
       jsonb_array_elements(coalesce(x->'items', '[]')) with ordinality t(i, o)
  where x->>'order_no' = any(v_list);
  return cardinality(v_list);
end $$;

-- Snapshot: sama seperti sebelumnya, ditambah pesanan pelanggan
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

  if jsonb_typeof(s->'orders') = 'array' then
    perform mb.terapkan_pesanan(p_kode, s->'orders');
  end if;

  if cs is not null and jsonb_typeof(cs) = 'object' and cs->>'shift_uid' is not null then
    perform mb.terapkan_shift(p_kode, (cs - 'sales') || '{"closed_at": null}', cs->'sales', v_at);
  end if;
  return true;
end $$;

-- Daftar pesanan untuk aplikasi (hak akses mengikuti RLS)
-- p_status: 'baru' | 'diambil' | 'batal' | null (semua); p_cari: no. pesanan / nama / HP
create or replace function public.laporan_pesanan(p_status text default 'baru', p_kode_toko char(3) default null,
                                                  p_cari text default null, p_batas int default 1000)
returns table(kode_toko char(3), no_pesanan text, nama_pelanggan text, hp text, tanggal_ambil date, catatan text,
              total numeric, deposit numeric, sisa numeric, status text, lewat boolean, jumlah_barang bigint, qty numeric,
              dibuat_at timestamptz, dibuat_oleh text, selesai_at timestamptz, selesai_oleh text, no_nota text,
              zona_ambil text, alasan_batal text, deposit_batal text, batal_disetujui_oleh text)
language sql stable security invoker set search_path = public, mb as $$
  select p.kode_toko, p.no_pesanan, p.nama_pelanggan, p.hp, p.tanggal_ambil, p.catatan, p.total, p.deposit,
         case when p.status = 'baru' then p.total - p.deposit else 0 end,
         p.status, p.status = 'baru' and p.tanggal_ambil < mb.tgl_wib(now()),
         (select count(*) from pesanan_toko_baris b where b.kode_toko = p.kode_toko and b.no_pesanan = p.no_pesanan),
         (select coalesce(sum(b.qty), 0) from pesanan_toko_baris b where b.kode_toko = p.kode_toko and b.no_pesanan = p.no_pesanan),
         p.dibuat_at, p.dibuat_oleh, p.selesai_at, p.selesai_oleh, p.no_nota, p.zona_ambil, p.alasan_batal,
         p.deposit_batal, p.batal_disetujui_oleh
  from pesanan_toko p
  where (coalesce(p_status, '') = '' or p.status = p_status)
    and (p_kode_toko is null or p.kode_toko = p_kode_toko)
    and (coalesce(p_cari, '') = '' or p.no_pesanan ilike '%' || p_cari || '%' or p.nama_pelanggan ilike '%' || p_cari || '%'
         or p.hp ilike '%' || p_cari || '%')
  order by case when p.status = 'baru' then p.tanggal_ambil end, p.dibuat_at desc
  limit least(greatest(coalesce(p_batas, 1000), 1), 5000)
$$;

revoke all on function public.laporan_pesanan(text, char, text, int) from public, anon;
grant execute on function public.laporan_pesanan(text, char, text, int) to authenticated, service_role;
-- Fungsi internal: hanya dipanggil lewat terima_data (security definer)
revoke all on function mb.terapkan_pesanan(char, jsonb) from public, anon, authenticated;
