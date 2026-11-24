-- =====================================================================
-- Mother Base Trizone — Penjualan per hari: omzet per kategori (SPECIAL / HOUSEWARE / lainnya)
--
-- laporan_harian mendapat kolom omzet_special, omzet_houseware, omzet_lain (sudah dikurangi pembatalan nota, sama
-- seperti omzet). Kategori dari master barang (kalau kosong: kategori di toko), tanpa beda huruf besar/kecil.
-- omzet = omzet_special + omzet_houseware + omzet_lain. Kolom lama tetap (tambahan di belakang).
-- =====================================================================

drop function public.laporan_harian(date, date, char);
create function public.laporan_harian(p_dari date, p_sampai date, p_kode_toko char(3) default null)
returns table(tanggal date, omzet numeric, jumlah_transaksi bigint, pembatalan numeric, jumlah_pembatalan bigint,
              omzet_special numeric, omzet_houseware numeric, omzet_lain numeric)
language sql stable security invoker set search_path = public, mb as $$
  with ringkas as (
    select tanggal, sum(omzet) as omzet, sum(jumlah_transaksi)::bigint as jumlah_transaksi,
           coalesce(sum(pembatalan), 0) as pembatalan, sum(jumlah_pembatalan)::bigint as jumlah_pembatalan
    from v_ringkasan_harian
    where tanggal between p_dari and p_sampai and (p_kode_toko is null or kode_toko = p_kode_toko)
    group by tanggal
  ),
  per_kategori as (
    select p.tanggal,
           coalesce(sum(p.subtotal) filter (where x.kat = 'SPECIAL'), 0)   as omzet_special,
           coalesce(sum(p.subtotal) filter (where x.kat = 'HOUSEWARE'), 0) as omzet_houseware,
           coalesce(sum(p.subtotal) filter (where x.kat is distinct from 'SPECIAL' and x.kat is distinct from 'HOUSEWARE'), 0) as omzet_lain
    from penjualan p
    left join produk m on m.sku = p.sku
    left join produk_toko pt on pt.kode_toko = p.kode_toko and pt.sku = p.sku
    cross join lateral (select upper(coalesce(nullif(btrim(m.kategori), ''), nullif(btrim(pt.kategori), ''))) as kat) x
    where p.tanggal between p_dari and p_sampai and (p_kode_toko is null or p.kode_toko = p_kode_toko)
    group by p.tanggal
  )
  select r.tanggal, r.omzet, r.jumlah_transaksi, r.pembatalan, r.jumlah_pembatalan,
         coalesce(k.omzet_special, 0), coalesce(k.omzet_houseware, 0), coalesce(k.omzet_lain, 0)
  from ringkas r left join per_kategori k using (tanggal)
  order by r.tanggal
$$;

revoke all on function public.laporan_harian(date, date, char) from public, anon;
grant execute on function public.laporan_harian(date, date, char) to authenticated, service_role;
