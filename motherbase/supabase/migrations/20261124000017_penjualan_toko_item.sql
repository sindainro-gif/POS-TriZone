-- =====================================================================
-- Mother Base Trizone — Laporan Penjualan per Toko per Item (menu Laporan)
--
--   * toko.urutan: urutan toko di daftar & kolom laporan (kosong = di belakang, urut kode). Diatur owner di menu Toko.
--     status_koneksi_toko ikut mengurutkan dengan urutan ini dan mengembalikan kolom urutan.
--   * laporan_penjualan_toko_item(dari, sampai, kategori): jumlah terjual (Biji) per barang per toko dalam periode.
--     Terjual = jual di kasir (nota, termasuk pesanan yang diambil) dikurangi pembatalan nota (BTL-), ditambah terjual
--     di Shopee (mutasi shopee → shopee_sold yang tidak dibatalkan) — sama dengan kolom Penjualan di Mutasi Item.
--     Kategori dari master barang (kalau kosong: kategori di toko), dibandingkan tanpa beda huruf besar/kecil.
--     Hak akses ikut RLS (security invoker): kantor semua toko, pemilik toko hanya tokonya.
-- =====================================================================

alter table toko add column if not exists urutan int;
-- Urutan awal: Jawa Timur lalu Jabodetabek (seperti contoh laporan kantor)
update toko t set urutan = u.n
from (values ('KRP', 1), ('MNK', 2), ('SDA', 3), ('TRP', 4), ('MLG', 5), ('SPJ', 6), ('BKS', 7), ('DPK', 8), ('CLD', 9), ('PAM', 10)) u(kode, n)
where t.kode = u.kode and t.urutan is null;

drop function public.status_koneksi_toko();
create function public.status_koneksi_toko()
returns table(kode char(3), nama text, kota text, aktif boolean, batas_hari_sj int, punya_kunci boolean,
              kunci_dibuat_at timestamptz, versi_trizone text, kiriman_terakhir_at timestamptz,
              snapshot_terakhir_at timestamptz, shift_terakhir_at timestamptz,
              minta_update_at timestamptz, minta_update_oleh text, urutan int)
language sql stable security definer set search_path = public, mb as $$
  select t.kode, t.nama, t.kota, t.aktif, t.batas_hari_sj, k.kode_toko is not null, k.dibuat_at,
         s.versi_trizone, s.kiriman_terakhir_at, s.snapshot_terakhir_at, s.shift_terakhir_at,
         case when s.kiriman_terakhir_at is null or s.minta_update_at > s.kiriman_terakhir_at then s.minta_update_at end,
         case when s.kiriman_terakhir_at is null or s.minta_update_at > s.kiriman_terakhir_at then s.minta_update_oleh end,
         t.urutan
  from toko t
  left join toko_kunci k on k.kode_toko = t.kode
  left join toko_status s on s.kode_toko = t.kode
  where mb.boleh_lihat_toko(t.kode)
  order by t.urutan nulls last, t.kode
$$;
revoke all on function public.status_koneksi_toko() from public, anon;
grant execute on function public.status_koneksi_toko() to authenticated, service_role;

create or replace function public.laporan_penjualan_toko_item(p_dari date, p_sampai date, p_kategori text default null)
returns jsonb language plpgsql stable security invoker set search_path = public, mb as $$
declare
  v_kat text := upper(nullif(btrim(p_kategori), ''));
begin
  if p_dari is null or p_sampai is null or p_sampai < p_dari then raise exception 'Periode tidak valid.'; end if;

  return (
    with jual as (
      select kode_toko, sku, sum(qty) as qty
      from penjualan
      where tanggal between p_dari and p_sampai and sku is not null and mb.boleh_lihat_toko(kode_toko)
      group by kode_toko, sku
      union all
      select m.kode_toko, b.sku, sum(b.qty)
      from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
      where m.ke = 'shopee_sold' and m.dibatalkan_at is null and mb.tgl_wib(m.waktu) between p_dari and p_sampai
        and mb.boleh_lihat_toko(m.kode_toko)
      group by m.kode_toko, b.sku
    ),
    per_toko as (
      select j.kode_toko, j.sku, sum(j.qty) as qty,
             max(coalesce(nullif(btrim(p.kategori), ''), nullif(btrim(pt.kategori), ''))) as kategori,
             max(coalesce(p.nama, pt.nama)) as nama
      from jual j
      left join produk p on p.sku = j.sku
      left join produk_toko pt on pt.kode_toko = j.kode_toko and pt.sku = j.sku
      group by j.kode_toko, j.sku
    ),
    terpilih as (
      select * from per_toko where v_kat is null or upper(kategori) = v_kat
    ),
    barang as (
      select sku, max(nama) as nama, max(kategori) as kategori, sum(qty) as total,
             jsonb_object_agg(kode_toko, qty) filter (where qty <> 0) as toko
      from terpilih group by sku
      having bool_or(qty <> 0)
    ),
    daftar_toko as (
      select t.kode, t.nama, t.urutan from toko t
      where mb.boleh_lihat_toko(t.kode) and (t.aktif or exists (select 1 from terpilih x where x.kode_toko = t.kode and x.qty <> 0))
    )
    select jsonb_build_object(
      'dari', p_dari, 'sampai', p_sampai, 'kategori', v_kat,
      'toko', coalesce((select jsonb_agg(jsonb_build_object('kode', kode, 'nama', nama) order by urutan nulls last, kode) from daftar_toko), '[]'::jsonb),
      'baris', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'nama', nama, 'kategori', kategori, 'total', total,
                                                             'toko', coalesce(toko, '{}'::jsonb)) order by total desc, sku) from barang), '[]'::jsonb))
  );
end $$;

revoke all on function public.laporan_penjualan_toko_item(date, date, text) from public, anon;
grant execute on function public.laporan_penjualan_toko_item(date, date, text) to authenticated, service_role;
