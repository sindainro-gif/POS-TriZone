-- =====================================================================
-- Mother Base Trizone — Retur barang ke supplier & pencocokan dengan Retur Penjualan Accurate
--
-- Toko mencatat retur di Trizone sebagai mutasi Gudang BS → Supplier (mutasi_toko.ke = 'supplier').
-- Kantor menginput retur yang sama di Accurate sebagai Retur Penjualan (SRT.…), dari laporan
-- "Rincian Retur Penjualan" yang diunggah di menu Retur Barang. Laporan itu tidak memuat tanggal per
-- dokumen dan nomor retur toko tidak ada di Accurate, jadi pencocokan dilakukan per toko & per barang,
-- KUMULATIF sejak tanggal mulai (pengaturan mulai_pencocokan_retur): jumlah retur toko vs jumlah di Accurate.
-- Status per dokumen toko memakai alokasi FIFO: qty Accurate dipakai untuk retur toko yang paling lama dulu.
-- Kuantitas Accurate dalam Biji (sama dengan Trizone). Pelanggan Accurate → toko lewat pelanggan_accurate.
-- =====================================================================

create table retur_accurate (
  no_srt          text primary key,          -- nomor retur penjualan Accurate, mis. SRT.2026.11.00035
  pelanggan       text not null,
  periode_dari    date,                      -- periode laporan tempat dokumen ini terakhir diimpor
  periode_sampai  date,
  file_sumber     text,
  diimpor_at      timestamptz not null default now(),
  diimpor_oleh    uuid references pengguna(id)
);
create table retur_accurate_baris (
  no_srt      text not null references retur_accurate(no_srt) on delete cascade,
  baris_ke    int  not null,
  kode        text not null,                 -- kode barang Accurate (= SKU / barcode Trizone)
  nama        text,
  qty         numeric(12,3) not null check (qty > 0),   -- Biji
  harga       numeric(14,2),
  keterangan  text,
  primary key (no_srt, baris_ke)
);
alter table retur_accurate enable row level security;
alter table retur_accurate_baris enable row level security;
create policy kantor_baca on retur_accurate for select to authenticated using ((select mb.is_kantor()));
create policy kantor_baca on retur_accurate_baris for select to authenticated using ((select mb.is_kantor()));

-- Tanggal mulai pencocokan: pengaturan, atau periode laporan retur pertama yang diimpor
create or replace function mb.mulai_retur() returns date
language sql stable set search_path = public as $$
  select coalesce((select (nilai #>> '{}')::date from pengaturan where kunci = 'mulai_pencocokan_retur'),
                  (select min(periode_dari) from retur_accurate), date '2000-01-01')
$$;

-- Impor laporan Rincian Retur Penjualan: { file, dari, sampai, dokumen: [{ no, pelanggan, items: [{ kode, nama, qty, harga, keterangan }] }] }
-- Dokumen yang sudah ada diganti (impor ulang periode yang bertumpuk tidak dobel).
create or replace function public.import_retur_accurate(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  n_baru int; n_ganti int; n_baris int;
  v_belum text[];
begin
  if not mb.is_kantor() then raise exception 'Hanya pengguna kantor'; end if;
  if jsonb_typeof(p->'dokumen') <> 'array' or jsonb_array_length(p->'dokumen') = 0 then
    raise exception 'Tidak ada dokumen retur di file ini.';
  end if;

  insert into pelanggan_accurate (nama)
  select distinct btrim(x->>'pelanggan') from jsonb_array_elements(p->'dokumen') x
  where coalesce(btrim(x->>'pelanggan'), '') <> ''
  on conflict do nothing;

  select count(*) filter (where r.no_srt is null), count(*) filter (where r.no_srt is not null)
    into n_baru, n_ganti
  from jsonb_array_elements(p->'dokumen') x left join retur_accurate r on r.no_srt = x->>'no';

  insert into retur_accurate (no_srt, pelanggan, periode_dari, periode_sampai, file_sumber, diimpor_oleh)
  select x->>'no', btrim(x->>'pelanggan'), nullif(p->>'dari', '')::date, nullif(p->>'sampai', '')::date, p->>'file', auth.uid()
  from jsonb_array_elements(p->'dokumen') x
  on conflict (no_srt) do update set pelanggan = excluded.pelanggan, periode_dari = excluded.periode_dari,
    periode_sampai = excluded.periode_sampai, file_sumber = excluded.file_sumber, diimpor_at = now(), diimpor_oleh = excluded.diimpor_oleh;

  delete from retur_accurate_baris where no_srt in (select x->>'no' from jsonb_array_elements(p->'dokumen') x);
  insert into retur_accurate_baris (no_srt, baris_ke, kode, nama, qty, harga, keterangan)
  select x->>'no', o::int, btrim(i->>'kode'), i->>'nama', (i->>'qty')::numeric, nullif(i->>'harga', '')::numeric, nullif(i->>'keterangan', '')
  from jsonb_array_elements(p->'dokumen') x, jsonb_array_elements(x->'items') with ordinality t(i, o);
  get diagnostics n_baris = row_count;

  insert into pengaturan (kunci, nilai)
  select 'mulai_pencocokan_retur', to_jsonb(p->>'dari') where coalesce(p->>'dari', '') <> ''
  on conflict (kunci) do nothing;

  select coalesce(array_agg(distinct pa.nama), '{}') into v_belum
  from jsonb_array_elements(p->'dokumen') x join pelanggan_accurate pa on pa.nama = btrim(x->>'pelanggan')
  where pa.kode_toko is null;

  return jsonb_build_object('dokumen_baru', n_baru, 'dokumen_diganti', n_ganti, 'baris', n_baris,
                            'pelanggan_belum_dipetakan', v_belum, 'mulai', mb.mulai_retur());
end $$;

create or replace function public.atur_mulai_pencocokan_retur(p_tanggal date) returns date
language plpgsql security definer set search_path = public, mb as $$
begin
  if not mb.is_kantor() then raise exception 'Hanya pengguna kantor'; end if;
  if p_tanggal is null then raise exception 'Tanggal mulai wajib diisi.'; end if;
  insert into pengaturan (kunci, nilai) values ('mulai_pencocokan_retur', to_jsonb(p_tanggal::text))
  on conflict (kunci) do update set nilai = excluded.nilai;
  return p_tanggal;
end $$;

-- Baris retur toko (mutasi ke supplier, tidak dibatalkan, sejak tanggal mulai)
create or replace view v_retur_toko_baris with (security_invoker = true) as
select m.kode_toko, m.no_dok, m.waktu, m.alasan, b.baris_ke, b.sku, b.qty
from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
where m.ke = 'supplier' and m.dibatalkan_at is null and mb.tgl_wib(m.waktu) >= mb.mulai_retur();

-- Baris retur Accurate dengan toko & SKU-nya (kode = sku atau barcode barang di toko itu)
create or replace view v_retur_accurate_baris with (security_invoker = true) as
select r.no_srt, r.pelanggan, pa.kode_toko, b.baris_ke, b.kode, b.nama, b.qty, b.keterangan, pt.sku
from retur_accurate_baris b
join retur_accurate r using (no_srt)
left join pelanggan_accurate pa on pa.nama = r.pelanggan
left join lateral (
  select t.sku from produk_toko t
  where t.kode_toko = pa.kode_toko and (t.sku = b.kode or t.barcode = b.kode)
  order by (t.sku = b.kode) desc limit 1
) pt on true
where r.periode_sampai is null or r.periode_sampai >= mb.mulai_retur();

-- Alokasi FIFO per baris retur toko: qty Accurate per toko & SKU dipakai untuk retur toko paling lama dulu
create or replace view v_retur_toko_alokasi with (security_invoker = true) as
with acc as (
  select kode_toko, sku, sum(qty) as qty from v_retur_accurate_baris
  where kode_toko is not null and sku is not null group by kode_toko, sku
),
t as (
  select r.*, sum(r.qty) over (partition by r.kode_toko, r.sku order by r.waktu, r.no_dok, r.baris_ke) as kumulatif
  from v_retur_toko_baris r
)
select t.kode_toko, t.no_dok, t.waktu, t.alasan, t.baris_ke, t.sku, t.qty,
       greatest(0, least(t.qty, coalesce(a.qty, 0) - (t.kumulatif - t.qty))) as qty_accurate
from t left join acc a on a.kode_toko = t.kode_toko and a.sku = t.sku;

-- Daftar dokumen retur toko + status di Accurate
-- p_status: null (semua) | 'SUDAH' | 'SEBAGIAN' | 'BELUM'
create or replace function public.laporan_retur_toko(p_kode_toko char(3) default null, p_status text default null)
returns table(kode_toko char(3), no_dok text, waktu timestamptz, alasan text, jumlah_barang bigint, qty numeric,
              qty_accurate numeric, status text)
language sql stable security invoker set search_path = public, mb as $$
  select * from (
    select a.kode_toko, a.no_dok, min(a.waktu) as waktu, min(a.alasan) as alasan, count(*) as jumlah_barang, sum(a.qty) as qty,
           sum(a.qty_accurate) as qty_accurate,
           case when sum(a.qty_accurate) >= sum(a.qty) then 'SUDAH' when sum(a.qty_accurate) > 0 then 'SEBAGIAN' else 'BELUM' end as status
    from v_retur_toko_alokasi a
    where p_kode_toko is null or a.kode_toko = p_kode_toko
    group by a.kode_toko, a.no_dok
  ) d
  where coalesce(p_status, '') = '' or d.status = p_status
  order by d.waktu desc, d.no_dok desc
$$;

-- Pencocokan per toko & barang (kumulatif sejak tanggal mulai)
-- status: COCOK | BELUM_DI_ACCURATE | LEBIH_DI_ACCURATE | BARANG_TIDAK_DIKENAL | PELANGGAN_BELUM_DIPETAKAN
create or replace function public.laporan_pencocokan_retur(p_kode_toko char(3) default null)
returns table(kode_toko char(3), pelanggan text, sku text, nama text, qty_toko numeric, qty_accurate numeric, selisih numeric,
              dokumen_toko bigint, dokumen_accurate bigint, status text)
language sql stable security invoker set search_path = public, mb as $$
  with toko as (
    select kode_toko, sku, sum(qty) as qty, count(distinct no_dok) as n from v_retur_toko_baris group by kode_toko, sku
  ),
  acc as (
    select kode_toko, sku, string_agg(distinct pelanggan, ', ') as pelanggan, max(nama) as nama, sum(qty) as qty, count(distinct no_srt) as n
    from v_retur_accurate_baris where kode_toko is not null and sku is not null group by kode_toko, sku
  ),
  lain as (   -- pelanggan belum dipetakan / kode barang tidak dikenal di toko itu
    select kode_toko, coalesce(case when kode_toko is null then pelanggan end, string_agg(distinct pelanggan, ', ')) as pelanggan,
           kode, max(nama) as nama, sum(qty) as qty, count(distinct no_srt) as n
    from v_retur_accurate_baris where kode_toko is null or sku is null
    group by kode_toko, case when kode_toko is null then pelanggan end, kode
  ),
  hasil as (
    select coalesce(t.kode_toko, a.kode_toko) as kode_toko, a.pelanggan, coalesce(t.sku, a.sku) as sku, a.nama as nama_acc,
           coalesce(t.qty, 0) as qty_toko, coalesce(a.qty, 0) as qty_accurate, coalesce(t.n, 0) as dt, coalesce(a.n, 0) as da
    from toko t full join acc a on a.kode_toko = t.kode_toko and a.sku = t.sku
  )
  select * from (
    select h.kode_toko, h.pelanggan, h.sku, coalesce(p.nama, h.nama_acc) as nama, h.qty_toko, h.qty_accurate,
           h.qty_toko - h.qty_accurate as selisih, h.dt as dokumen_toko, h.da as dokumen_accurate,
           case when h.qty_toko = h.qty_accurate then 'COCOK' when h.qty_toko > h.qty_accurate then 'BELUM_DI_ACCURATE' else 'LEBIH_DI_ACCURATE' end as status
    from hasil h left join produk_toko p on p.kode_toko = h.kode_toko and p.sku = h.sku
    union all
    select l.kode_toko, l.pelanggan, l.kode, l.nama, 0, l.qty, -l.qty, 0, l.n,
           case when l.kode_toko is null then 'PELANGGAN_BELUM_DIPETAKAN' else 'BARANG_TIDAK_DIKENAL' end
    from lain l
  ) r
  where p_kode_toko is null or r.kode_toko = p_kode_toko
  order by (r.status = 'COCOK'), r.kode_toko nulls first, r.sku
$$;

revoke all on function public.import_retur_accurate(jsonb) from public, anon;
grant execute on function public.import_retur_accurate(jsonb) to authenticated, service_role;
revoke all on function public.atur_mulai_pencocokan_retur(date) from public, anon;
grant execute on function public.atur_mulai_pencocokan_retur(date) to authenticated, service_role;
revoke all on function public.laporan_retur_toko(char, text) from public, anon;
grant execute on function public.laporan_retur_toko(char, text) to authenticated, service_role;
revoke all on function public.laporan_pencocokan_retur(char) from public, anon;
grant execute on function public.laporan_pencocokan_retur(char) to authenticated, service_role;
