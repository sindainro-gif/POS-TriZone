-- =====================================================================
-- Mother Base Trizone — pembelian tanpa principal
--
-- Barang tidak lagi dikelompokkan per principal. Usulan beli dihitung untuk semua barang aktif
-- dalam satu daftar dan dibulatkan ke isi 1 Coly (kemasan kantor). Lead time, periode order,
-- dan stok pengaman berlaku untuk semua barang (Pembelian → Pengaturan usulan, owner).
-- Tabel principal dan kolom principal_id / isi_dus tetap ada untuk riwayat, tetapi tidak dipakai.
-- =====================================================================

alter table po alter column principal_id drop not null;

insert into pengaturan (kunci, nilai) values
  ('usulan_lead_time_hari', '7'), ('usulan_periode_order_hari', '7'), ('usulan_stok_pengaman_hari', '3')
on conflict (kunci) do nothing;

drop function if exists public.laporan_usulan_beli(bigint);
drop function if exists public.buat_po_dari_usulan(bigint);
drop view if exists v_usulan_beli;

-- Usulan beli:
--   rata-rata jual harian × (lead time + periode order) + stok pengaman
--   − (stok gudang + stok tersedia 9 toko + PO belum datang), dibulatkan ke isi 1 Coly.
-- Rata-rata per toko = jual 28 hari ÷ hari stok tidak kosong, lalu dijumlah 9 toko.
create view v_usulan_beli with (security_invoker = true) as
with atur as (
  select coalesce((select (nilai #>> '{}')::numeric from pengaturan where kunci = 'usulan_lead_time_hari'), 7) as lead_time,
         coalesce((select (nilai #>> '{}')::numeric from pengaturan where kunci = 'usulan_periode_order_hari'), 7) as periode_order,
         coalesce((select (nilai #>> '{}')::numeric from pengaturan where kunci = 'usulan_stok_pengaman_hari'), 3) as pengaman_hari
),
jual as (
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
  select p.sku, p.nama, p.satuan_masuk, p.rasio_isi as isi_kemasan,
         coalesce(r.rata_harian, 0) as rata_harian, a.lead_time, a.periode_order,
         coalesce(r.rata_harian, 0) * a.pengaman_hari as stok_pengaman,
         coalesce(g.stok, 0) as stok_gudang,
         coalesce((select sum(stok) from v_stok_tersedia s where s.sku = p.sku), 0) as stok_toko,
         coalesce(o.qty, 0) as po_belum_datang
  from produk p
  cross join atur a
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
            else ceil((h.rata_harian * (h.lead_time + h.periode_order) + h.stok_pengaman
                       - (h.stok_gudang + h.stok_toko + h.po_belum_datang)) / h.isi_kemasan) * h.isi_kemasan
       end as usulan_qty
from hitung h;

create function public.laporan_usulan_beli()
returns setof v_usulan_beli language sql stable security invoker set search_path = public, mb as $$
  select * from v_usulan_beli where usulan_qty > 0 order by nama
$$;

-- Satu usulan PO untuk semua barang yang perlu dibeli, dengan alasan per baris.
create function public.buat_po_dari_usulan() returns text
language plpgsql security invoker set search_path = public, mb as $$
declare
  v_no text;
  n int;
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  select 'PO-' || to_char(current_date, 'YYYYMMDD') || '-' ||
         lpad((count(*) + 1)::text, 3, '0') into v_no
  from po where no_po like 'PO-' || to_char(current_date, 'YYYYMMDD') || '-%';
  insert into po (no_po, dibuat_oleh) values (v_no, auth.uid());
  insert into po_baris (no_po, sku, qty_usulan, qty_disetujui, harga, alasan)
  select v_no, u.sku, u.usulan_qty, u.usulan_qty, h.harga_beli_dasar,
         format('Rata-rata %s/hari × (lead time %s + periode %s hari) + pengaman %s − stok gudang %s − stok toko %s − PO jalan %s = %s%s',
                mb.angka(u.rata_harian), mb.angka(u.lead_time, 0), mb.angka(u.periode_order, 0), mb.angka(u.stok_pengaman),
                mb.angka(u.stok_gudang, 0), mb.angka(u.stok_toko, 0), mb.angka(u.po_belum_datang, 0), mb.angka(u.kebutuhan),
                case when u.isi_kemasan > 1 then format('; dibulatkan ke isi 1 Coly (%s Biji)', u.isi_kemasan) else '' end)
  from v_usulan_beli u left join v_harga_produk h using (sku)
  where u.usulan_qty > 0;
  get diagnostics n = row_count;
  if n = 0 then
    delete from po where no_po = v_no;
    raise exception 'Tidak ada barang yang perlu dibeli saat ini';
  end if;
  return v_no;
end $$;

revoke all on function public.laporan_usulan_beli() from public, anon;
revoke all on function public.buat_po_dari_usulan() from public, anon;
grant execute on function public.laporan_usulan_beli() to authenticated, service_role;
grant execute on function public.buat_po_dari_usulan() to authenticated, service_role;
