-- =====================================================================
-- Mother Base Trizone — Penjualan per Toko per Item: stok yang bisa dijual (penanda stok menipis)
--
-- laporan_penjualan_toko_item juga mengembalikan stok yang bisa dijual sekarang (Display + Gudang Utama + Gudang Shopee,
-- dari kiriman stok terakhir toko; Gudang BS tidak) per barang per toko:
--   * baris.stok  = { kode_toko: qty } untuk barang yang tercatat di stok toko itu;
--   * toko.stok_per = waktu kiriman stok terakhir toko (kosong = toko belum pernah mengirim stok).
-- Web memerahkan angka penjualan bila stok di toko itu < 10 (HOUSEWARE) atau < 5 (SPECIAL); barang yang tidak tercatat
-- di stok toko yang sudah mengirim stok dianggap 0.
-- =====================================================================

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
      select t.kode, t.nama, t.urutan, (select max(s.per_waktu) from stok_toko s where s.kode_toko = t.kode) as stok_per
      from toko t
      where mb.boleh_lihat_toko(t.kode) and (t.aktif or exists (select 1 from terpilih x where x.kode_toko = t.kode and x.qty <> 0))
    ),
    stok as (
      select b.sku, jsonb_object_agg(s.kode_toko, s.display + s.gudang + s.shopee) as stok
      from barang b join stok_toko s on s.sku = b.sku
      where mb.boleh_lihat_toko(s.kode_toko)
      group by b.sku
    )
    select jsonb_build_object(
      'dari', p_dari, 'sampai', p_sampai, 'kategori', v_kat,
      'toko', coalesce((select jsonb_agg(jsonb_build_object('kode', kode, 'nama', nama, 'stok_per', stok_per) order by urutan nulls last, kode) from daftar_toko), '[]'::jsonb),
      'baris', coalesce((select jsonb_agg(jsonb_build_object('sku', b.sku, 'nama', b.nama, 'kategori', b.kategori, 'total', b.total,
                                                             'toko', coalesce(b.toko, '{}'::jsonb), 'stok', coalesce(st.stok, '{}'::jsonb))
                                          order by b.total desc, b.sku)
                         from barang b left join stok st on st.sku = b.sku), '[]'::jsonb))
  );
end $$;

revoke all on function public.laporan_penjualan_toko_item(date, date, text) from public, anon;
grant execute on function public.laporan_penjualan_toko_item(date, date, text) to authenticated, service_role;
