-- =====================================================================
-- Mother Base Trizone — filter di Stok → Cari stok
--
-- laporan_stok_produk mendapat filter kondisi stok, kategori, dan merk, dan mengembalikan merk
-- & kategori. Parameter lama (p_cari, p_kode_toko, p_batas) tetap, jadi asisten AI tidak berubah.
--
-- p_kondisi:
--   'ada'        stok bisa dijual (Display + Gudang Utama + Gudang Shopee) lebih dari 0
--   'habis'      stok bisa dijual 0 atau kurang
--   'menipis'    Display di bawah atau sama dengan batas minimum display
--   'isi_display' Display di bawah minimum tetapi Gudang Utama masih ada (perlu dipindah ke display)
--   'minus'      ada zona yang minus
--   'bs'         ada barang di Gudang BS
-- =====================================================================

drop function if exists public.laporan_stok_produk(text, char, int);
create function public.laporan_stok_produk(p_cari text default null, p_kode_toko char(3) default null, p_batas int default 200,
                                           p_kondisi text default null, p_kategori text default null, p_merk text default null)
returns table(kode_toko char(3), sku text, nama text, merk text, kategori text, display numeric, gudang numeric, bs numeric,
              shopee numeric, min_display numeric, per_waktu timestamptz)
language sql stable security invoker set search_path = public, mb as $$
  select s.kode_toko, s.sku, pt.nama, pt.merk, pt.kategori, s.display, s.gudang, s.bs, s.shopee, s.min_display, s.per_waktu
  from stok_toko s
  left join produk_toko pt on pt.kode_toko = s.kode_toko and pt.sku = s.sku
  where (p_kode_toko is null or s.kode_toko = p_kode_toko)
    and (coalesce(p_cari, '') = '' or s.sku ilike '%' || p_cari || '%' or pt.nama ilike '%' || p_cari || '%'
         or pt.barcode = p_cari)
    and (coalesce(p_kategori, '') = '' or pt.kategori = p_kategori)
    and (coalesce(p_merk, '') = '' or pt.merk = p_merk)
    and case coalesce(p_kondisi, '')
          when '' then true
          when 'ada' then s.display + s.gudang + s.shopee > 0
          when 'habis' then s.display + s.gudang + s.shopee <= 0
          when 'menipis' then s.display <= coalesce(s.min_display, 0)
          when 'isi_display' then s.display <= coalesce(s.min_display, 0) and s.gudang > 0
          when 'minus' then least(s.display, s.gudang, s.bs, s.shopee) < 0
          when 'bs' then s.bs > 0
          else true
        end
  order by pt.nama, s.kode_toko
  limit least(greatest(coalesce(p_batas, 200), 1), 5000)
$$;

-- Pilihan kategori & merk untuk filter (sesuai toko yang boleh dilihat pengguna)
create or replace function public.pilihan_filter_stok(p_kode_toko char(3) default null)
returns jsonb language sql stable security invoker set search_path = public, mb as $$
  select jsonb_build_object(
    'kategori', coalesce((select jsonb_agg(k order by k) from (select distinct kategori k from produk_toko
                 where nullif(btrim(kategori), '') is not null and (p_kode_toko is null or kode_toko = p_kode_toko)) a), '[]'),
    'merk', coalesce((select jsonb_agg(m order by m) from (select distinct merk m from produk_toko
             where nullif(btrim(merk), '') is not null and merk <> '-' and (p_kode_toko is null or kode_toko = p_kode_toko)) b), '[]'))
$$;

revoke all on function public.laporan_stok_produk(text, char, int, text, text, text) from public, anon;
revoke all on function public.pilihan_filter_stok(char) from public, anon;
grant execute on function public.laporan_stok_produk(text, char, int, text, text, text) to authenticated, service_role;
grant execute on function public.pilihan_filter_stok(char) to authenticated, service_role;
