-- =====================================================================
-- Mother Base Trizone — mutasi & penerimaan yang dibatalkan di toko (Trizone 1.23.7)
--
-- Toko membatalkan mutasi / penerimaan dengan PIN Admin / PIN Pembatalan: dokumen tidak dihapus,
-- hanya ditandai batal, dan stoknya dikembalikan SAAT DIBATALKAN. Snapshot toko membawa
--   dokumen_batal: [{ jenis: 'mutasi' | 'penerimaan', no_dokumen, dibuat_at, cancelled_at, cancel_reason,
--                     cancelled_by, cancel_approved_by }]   (dibatalkan dalam 60 hari terakhir)
-- yang di sini diterapkan ke mutasi_toko (no_dok) dan penerimaan_toko (no_sj). Kiriman ulang tidak dobel:
-- hanya menulis bila isinya berbeda. Kiriman ulang dokumen (terapkan_dokumen) tidak menyentuh kolom batal.
--
-- Laporan:
--   * v_ledger_toko: dokumen tetap tercatat pada waktunya, ditambah baris pembalik pada waktu batal
--     (sama seperti stok di toko). Tanpa SO di antaranya hasilnya nol; bila ada SO yang disetujui di
--     antara dokumen dan pembatalannya, hanya pembaliknya yang dihitung (dokumen sudah termasuk di SO).
--   * permintaan Shopee, pencocokan surat jalan, SJ tidak dikenal: dokumen batal tidak dihitung.
--   * laporan_dokumen_toko: daftar mutasi & penerimaan untuk web, dengan tanda batal.
-- =====================================================================

alter table mutasi_toko
  add column dibatalkan_at        timestamptz,
  add column alasan_batal         text,
  add column batal_diminta_oleh   text,
  add column batal_disetujui_oleh text;
alter table penerimaan_toko
  add column dibatalkan_at        timestamptz,
  add column alasan_batal         text,
  add column batal_diminta_oleh   text,
  add column batal_disetujui_oleh text;

-- Menerapkan daftar dokumen_batal dari snapshot. Dokumen yang belum sampai di mother base dilewati;
-- daftar dikirim ulang tiap snapshot (60 hari), jadi tandanya terpasang begitu dokumennya masuk.
create or replace function mb.terapkan_dokumen_batal(p_kode char(3), daftar jsonb) returns int
language plpgsql set search_path = public, mb as $$
declare
  n_mt int;
  n_rc int;
begin
  with x as (
    select x->>'no_dokumen' as no, mb.wib(x->>'cancelled_at') as at, nullif(x->>'cancel_reason','') as alasan,
           nullif(x->>'cancelled_by','') as oleh, nullif(x->>'cancel_approved_by','') as setuju
    from jsonb_array_elements(coalesce(daftar,'[]')) x
    where x->>'jenis' = 'mutasi' and coalesce(x->>'no_dokumen','') <> '' and coalesce(x->>'cancelled_at','') <> ''
  )
  update mutasi_toko t
     set dibatalkan_at = x.at, alasan_batal = x.alasan, batal_diminta_oleh = x.oleh, batal_disetujui_oleh = x.setuju
    from x
   where t.kode_toko = p_kode and t.no_dok = x.no
     and (t.dibatalkan_at, t.alasan_batal, t.batal_diminta_oleh, t.batal_disetujui_oleh)
         is distinct from (x.at, x.alasan, x.oleh, x.setuju);
  get diagnostics n_mt = row_count;

  with x as (
    select x->>'no_dokumen' as no, mb.wib(x->>'cancelled_at') as at, nullif(x->>'cancel_reason','') as alasan,
           nullif(x->>'cancelled_by','') as oleh, nullif(x->>'cancel_approved_by','') as setuju
    from jsonb_array_elements(coalesce(daftar,'[]')) x
    where x->>'jenis' = 'penerimaan' and coalesce(x->>'no_dokumen','') <> '' and coalesce(x->>'cancelled_at','') <> ''
  )
  update penerimaan_toko t
     set dibatalkan_at = x.at, alasan_batal = x.alasan, batal_diminta_oleh = x.oleh, batal_disetujui_oleh = x.setuju
    from x
   where t.kode_toko = p_kode and t.no_sj = x.no
     and (t.dibatalkan_at, t.alasan_batal, t.batal_diminta_oleh, t.batal_disetujui_oleh)
         is distinct from (x.at, x.alasan, x.oleh, x.setuju);
  get diagnostics n_rc = row_count;
  return n_mt + n_rc;
end $$;
revoke all on function mb.terapkan_dokumen_batal(char, jsonb) from public, anon, authenticated;

-- Snapshot: sama seperti migrasi 11, ditambah dokumen_batal
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
  perform mb.catat_riwayat_stok(p_kode, v_at);

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

  if jsonb_typeof(s->'dokumen_batal') = 'array' then
    perform mb.terapkan_dokumen_batal(p_kode, s->'dokumen_batal');
  end if;

  if cs is not null and jsonb_typeof(cs) = 'object' and cs->>'shift_uid' is not null then
    perform mb.terapkan_shift(p_kode, (cs - 'sales') || '{"closed_at": null}', cs->'sales', v_at);
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Laporan yang memakai mutasi / penerimaan toko
-- ---------------------------------------------------------------------

-- Permintaan Shopee: mutasi shopee → shopee_sold yang dibatalkan tidak terjual
create or replace view v_permintaan_harian with (security_invoker = true) as
select kode_toko, tanggal, sku, sum(qty) as qty, sum(subtotal) as nilai, 'KASIR'::text as kanal
from penjualan group by kode_toko, tanggal, sku
union all
select m.kode_toko, mb.tgl_wib(m.waktu), b.sku, sum(b.qty), null, 'SHOPEE'
from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
where m.ke = 'shopee_sold' and m.dibatalkan_at is null
group by m.kode_toko, mb.tgl_wib(m.waktu), b.sku;

-- Pencocokan surat jalan: penerimaan yang dibatalkan dianggap belum diinput
create or replace view v_pencocokan_sj with (security_invoker = true) as
with kirim as (
  select no_sj, kode_toko, coalesce(sku, kode) as sku, sum(qty_biji) as qty,
         bool_or(qty_biji is null) as satuan_belum_jelas
  from v_sj_baris_biji group by no_sj, kode_toko, coalesce(sku, kode)
),
terima as (
  select b.kode_toko, b.no_sj, b.sku, sum(b.qty) as qty
  from penerimaan_toko_baris b
  join penerimaan_toko h using (kode_toko, no_sj)
  where h.dibatalkan_at is null
  group by b.kode_toko, b.no_sj, b.sku
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
       (select min(diterima_at) from penerimaan_toko pt
        where pt.no_sj = sj.no_sj and pt.kode_toko = pa.kode_toko and pt.dibatalkan_at is null) as diinput_at,
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

create or replace view v_sj_banding with (security_invoker = true) as
with kirim as (
  select no_sj, kode_toko, coalesce(sku, kode) as sku, max(nama) as nama, sum(qty) as qty, max(satuan) as satuan,
         sum(qty_biji) as qty_biji
  from v_sj_baris_biji group by no_sj, kode_toko, coalesce(sku, kode)
),
terima as (
  select b.kode_toko, b.no_sj, b.sku, sum(b.qty) as qty
  from penerimaan_toko_baris b
  join penerimaan_toko h using (kode_toko, no_sj)
  join surat_jalan sj on sj.no_sj = b.no_sj
  join pelanggan_accurate pa on pa.nama = sj.pelanggan and pa.kode_toko = b.kode_toko
  where h.dibatalkan_at is null
  group by b.kode_toko, b.no_sj, b.sku
)
select coalesce(k.no_sj, t.no_sj) as no_sj, coalesce(k.sku, t.sku) as sku,
       coalesce(k.nama, (select nama from produk_toko p where p.kode_toko = t.kode_toko and p.sku = t.sku)) as nama,
       k.qty as qty_kirim, k.satuan, k.qty_biji as kirim_biji, t.qty as terima_biji,
       coalesce(t.qty, 0) - coalesce(k.qty_biji, 0) as selisih_biji
from kirim k full join terima t on t.no_sj = k.no_sj and t.sku = k.sku;

create or replace view v_sj_tidak_dikenal with (security_invoker = true) as
select t.kode_toko, t.no_sj, t.supplier, t.diterima_at, t.total_biji
from penerimaan_toko t
where t.diterima_at >= coalesce((select (nilai #>> '{}')::date from pengaturan where kunci = 'mulai_pencocokan_sj'),
                                '2100-01-01')
  and t.dibatalkan_at is null
  and not exists (select 1 from surat_jalan s where s.no_sj = t.no_sj);

-- Pergerakan stok toko per zona; pembatalan = baris pembalik pada waktu batal (lihat kepala file)
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
  from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok) where mb.is_zona_stok(m.ke)
union all
  select h.kode_toko, b.sku, b.zona, h.dibatalkan_at, -b.qty, 'BATAL_PENERIMAAN', h.no_sj
  from penerimaan_toko h join penerimaan_toko_baris b using (kode_toko, no_sj)
  where h.dibatalkan_at is not null and mb.is_zona_stok(b.zona)
union all
  select m.kode_toko, b.sku, m.dari, m.dibatalkan_at, b.qty, 'BATAL_MUTASI', m.no_dok
  from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
  where m.dibatalkan_at is not null and mb.is_zona_stok(m.dari)
union all
  select m.kode_toko, b.sku, m.ke, m.dibatalkan_at, -b.qty, 'BATAL_MUTASI', m.no_dok
  from mutasi_toko m join mutasi_toko_baris b using (kode_toko, no_dok)
  where m.dibatalkan_at is not null and mb.is_zona_stok(m.ke);

-- Daftar mutasi & penerimaan toko (web: Stok → Mutasi & penerimaan). Tanggal = tanggal dokumen (WIB).
create or replace function public.laporan_dokumen_toko(p_dari date, p_sampai date, p_kode_toko char(3) default null,
                                                       p_jenis text default null, p_batas int default 2000)
returns table(jenis text, kode_toko char(3), no_dokumen text, waktu timestamptz, keterangan text, dari text, ke text,
              jumlah_baris int, total_qty numeric, dibatalkan_at timestamptz, alasan_batal text,
              batal_diminta_oleh text, batal_disetujui_oleh text)
language sql stable security invoker set search_path = public, mb as $$
  select * from (
    select 'mutasi'::text, m.kode_toko, m.no_dok, m.waktu, m.alasan, m.dari, m.ke, m.jumlah_baris, m.total_qty,
           m.dibatalkan_at, m.alasan_batal, m.batal_diminta_oleh, m.batal_disetujui_oleh
    from mutasi_toko m
    where coalesce(p_jenis, '') in ('', 'mutasi')
      and (p_kode_toko is null or m.kode_toko = p_kode_toko)
      and mb.tgl_wib(m.waktu) between p_dari and p_sampai
    union all
    select 'penerimaan', h.kode_toko, h.no_sj, h.diterima_at, h.supplier, null, null,
           (select count(*)::int from penerimaan_toko_baris b where b.kode_toko = h.kode_toko and b.no_sj = h.no_sj),
           h.total_biji, h.dibatalkan_at, h.alasan_batal, h.batal_diminta_oleh, h.batal_disetujui_oleh
    from penerimaan_toko h
    where coalesce(p_jenis, '') in ('', 'penerimaan')
      and (p_kode_toko is null or h.kode_toko = p_kode_toko)
      and mb.tgl_wib(h.diterima_at) between p_dari and p_sampai
  ) d
  order by 4 desc, 3 desc
  limit least(greatest(coalesce(p_batas, 2000), 1), 5000)
$$;
revoke all on function public.laporan_dokumen_toko(date, date, char, text, int) from public, anon;
grant execute on function public.laporan_dokumen_toko(date, date, char, text, int) to authenticated, service_role;
