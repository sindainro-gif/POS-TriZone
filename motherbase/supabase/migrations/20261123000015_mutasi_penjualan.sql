-- =====================================================================
-- Mother Base Trizone — Laporan Mutasi Item: Penjualan dipisah dari Barang Keluar
--
-- Kolom: Awal, Masuk, Penjualan, Barang Keluar, Akhir  (Awal = Akhir − Masuk + Penjualan + Barang Keluar)
--   * Penjualan     = jual di kasir (nota, termasuk pesanan yang diambil) dikurangi pembatalan nota, ditambah
--                     terjual di Shopee (mutasi shopee → shopee_sold, dikurangi bila mutasi itu dibatalkan).
--                     Sama dengan definisi permintaan (v_permintaan_harian).
--   * Masuk         = gerak lain yang menambah stok (penerimaan, mutasi masuk zona, selisih opname plus, …).
--   * Barang Keluar = gerak lain yang mengurangi stok (mutasi keluar zona, selisih opname minus, batal penerimaan, …).
-- Sisanya sama dengan migrasi 14.
-- =====================================================================

create or replace function public.laporan_mutasi_item(p_kode_toko char(3), p_dari date, p_sampai date, p_zona text default null)
returns jsonb language plpgsql stable security invoker set search_path = public, mb as $$
declare
  v_zona  text[];
  v_awal  timestamptz;
  v_akhir timestamptz;
  v_per   timestamptz;
begin
  if p_dari is null or p_sampai is null or p_sampai < p_dari then raise exception 'Periode tidak valid.'; end if;
  if p_zona is not null and not mb.is_zona_stok(p_zona) then raise exception 'Gudang "%" tidak dikenal.', p_zona; end if;
  v_zona  := case when p_zona is null then array['floor', 'warehouse', 'damaged', 'shopee'] else array[p_zona] end;
  v_awal  := p_dari::timestamp at time zone 'Asia/Jakarta';
  v_akhir := (p_sampai + 1)::timestamp at time zone 'Asia/Jakarta';
  select max(per_waktu) into v_per from stok_toko where kode_toko = p_kode_toko;

  return jsonb_build_object('kode_toko', p_kode_toko, 'stok_per', v_per, 'baris', coalesce((
    with gerak as (
      select l.sku, l.waktu, sum(l.qty) as qty,
             l.sumber = 'PENJUALAN' or (l.sumber in ('MUTASI', 'BATAL_MUTASI') and exists (
               select 1 from mutasi_toko m where m.kode_toko = p_kode_toko and m.no_dok = l.referensi and m.ke = 'shopee_sold')) as jual
      from v_ledger_toko l
      where l.kode_toko = p_kode_toko and l.zona = any(v_zona)
      group by l.sumber, l.referensi, l.sku, l.waktu
      union all
      select b.sku, coalesce(o.dibuat_at, o.hitung_at), sum(b.selisih), false
      from stok_opname o join stok_opname_baris b on b.kode_toko = o.kode_toko and b.no_op = o.no_op
      where o.kode_toko = p_kode_toko and o.zona = any(v_zona)
      group by o.no_op, b.sku, coalesce(o.dibuat_at, o.hitung_at)
    ),
    per_sku as (
      select sku,
             coalesce(sum(qty) filter (where waktu >= v_akhir and waktu <= v_per), 0)                            as setelah,
             coalesce(sum(qty) filter (where waktu >= v_awal and waktu < v_akhir and not jual and qty > 0), 0)  as masuk,
             coalesce(-sum(qty) filter (where waktu >= v_awal and waktu < v_akhir and jual), 0)                  as penjualan,
             coalesce(-sum(qty) filter (where waktu >= v_awal and waktu < v_akhir and not jual and qty < 0), 0) as keluar
      from gerak where qty <> 0 group by sku
    ),
    stok as (
      select sku, case when 'floor' = any(v_zona) then display else 0 end
                + case when 'warehouse' = any(v_zona) then gudang else 0 end
                + case when 'damaged' = any(v_zona) then bs else 0 end
                + case when 'shopee' = any(v_zona) then shopee else 0 end as kini
      from stok_toko where kode_toko = p_kode_toko
    ),
    hasil as (
      select p.sku, coalesce(p.nama, m.nama) as nama,
             coalesce(s.kini, 0) - coalesce(g.setelah, 0) as akhir, coalesce(g.masuk, 0) as masuk,
             coalesce(g.penjualan, 0) as penjualan, coalesce(g.keluar, 0) as keluar
      from produk_toko p
      left join produk m on m.sku = p.sku
      left join stok s on s.sku = p.sku
      left join per_sku g on g.sku = p.sku
      where p.kode_toko = p_kode_toko
    )
    select jsonb_agg(jsonb_build_object('kode', sku, 'nama', nama, 'satuan', 'Biji', 'awal', akhir - masuk + penjualan + keluar,
                                        'masuk', masuk, 'penjualan', penjualan, 'keluar', keluar, 'akhir', akhir) order by sku)
    from hasil
    where akhir - masuk + penjualan + keluar <> 0 or masuk <> 0 or penjualan <> 0 or keluar <> 0 or akhir <> 0), '[]'::jsonb));
end $$;

revoke all on function public.laporan_mutasi_item(char, date, date, text) from public, anon;
grant execute on function public.laporan_mutasi_item(char, date, date, text) to authenticated, service_role;
