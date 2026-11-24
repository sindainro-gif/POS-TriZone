-- =====================================================================
-- Mother Base Trizone — Ringkasan per toko: omzet per kategori (SPECIAL / HOUSEWARE / lainnya)
--
-- laporan_ringkasan mendapat kolom omzet_special, omzet_houseware, omzet_lain (bersih dari pembatalan nota, sama
-- seperti omzet; kategori seperti laporan_harian di migrasi 19). Kolom lama tetap (tunai / qris / transfer masih
-- dipakai asisten AI); web Ringkasan tidak lagi menampilkan QRIS & Transfer.
-- =====================================================================

drop function public.laporan_ringkasan(date, date);
create function public.laporan_ringkasan(p_dari date, p_sampai date)
returns table(kode_toko char(3), omzet numeric, jumlah_transaksi bigint, qty numeric,
              tunai numeric, qris numeric, transfer numeric, hari_berjualan bigint,
              pembatalan numeric, jumlah_pembatalan bigint,
              omzet_special numeric, omzet_houseware numeric, omzet_lain numeric)
language sql stable security invoker set search_path = public, mb as $$
  with ringkas as (
    select kode_toko, sum(omzet) as omzet, sum(jumlah_transaksi)::bigint as jumlah_transaksi, sum(qty) as qty,
           coalesce(sum(tunai), 0) as tunai, coalesce(sum(qris), 0) as qris, coalesce(sum(transfer), 0) as transfer,
           count(distinct tanggal) as hari_berjualan, coalesce(sum(pembatalan), 0) as pembatalan,
           sum(jumlah_pembatalan)::bigint as jumlah_pembatalan
    from v_ringkasan_harian
    where tanggal between p_dari and p_sampai
    group by kode_toko
  ),
  per_kategori as (
    select p.kode_toko,
           coalesce(sum(p.subtotal) filter (where x.kat = 'SPECIAL'), 0)   as omzet_special,
           coalesce(sum(p.subtotal) filter (where x.kat = 'HOUSEWARE'), 0) as omzet_houseware,
           coalesce(sum(p.subtotal) filter (where x.kat is distinct from 'SPECIAL' and x.kat is distinct from 'HOUSEWARE'), 0) as omzet_lain
    from penjualan p
    left join produk m on m.sku = p.sku
    left join produk_toko pt on pt.kode_toko = p.kode_toko and pt.sku = p.sku
    cross join lateral (select upper(coalesce(nullif(btrim(m.kategori), ''), nullif(btrim(pt.kategori), ''))) as kat) x
    where p.tanggal between p_dari and p_sampai
    group by p.kode_toko
  )
  select r.kode_toko, r.omzet, r.jumlah_transaksi, r.qty, r.tunai, r.qris, r.transfer, r.hari_berjualan,
         r.pembatalan, r.jumlah_pembatalan,
         coalesce(k.omzet_special, 0), coalesce(k.omzet_houseware, 0), coalesce(k.omzet_lain, 0)
  from ringkas r left join per_kategori k using (kode_toko)
  order by r.kode_toko
$$;

revoke all on function public.laporan_ringkasan(date, date) from public, anon;
grant execute on function public.laporan_ringkasan(date, date) to authenticated, service_role;
