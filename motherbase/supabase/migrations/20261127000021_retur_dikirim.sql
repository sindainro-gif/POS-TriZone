-- =====================================================================
-- Mother Base Trizone — status kirim Retur Barang (Trizone 1.23.23)
--
-- Retur di toko (mutasi ke 'supplier', nomor RB-…) langsung mengurangi stok saat disimpan, tetapi barang fisiknya
-- bisa masih di toko sampai dimuat ke truk. Toko mencentang "Sudah dikirim" per dokumen retur. Snapshot toko membawa
--   retur_dikirim: [{ no_dokumen, dikirim_at (null = masih di toko), dikirim_oleh }]   (retur 60 hari terakhir, tidak batal)
-- yang di sini diterapkan ke mutasi_toko. Kiriman ulang tidak dobel: hanya menulis bila isinya berbeda.
-- Centang yang dibatalkan di toko (dikirim_at null) ikut terhapus di sini.
-- =====================================================================

alter table mutasi_toko
  add column if not exists dikirim_at   timestamptz,
  add column if not exists dikirim_oleh text;

create or replace function mb.terapkan_retur_dikirim(p_kode char(3), daftar jsonb) returns int
language plpgsql set search_path = public, mb as $$
declare
  n int;
begin
  with x as (
    select x->>'no_dokumen' as no, mb.wib(x->>'dikirim_at') as at, nullif(x->>'dikirim_oleh','') as oleh
    from jsonb_array_elements(coalesce(daftar,'[]')) x
    where coalesce(x->>'no_dokumen','') <> ''
  )
  update mutasi_toko t
     set dikirim_at = x.at, dikirim_oleh = case when x.at is null then null else x.oleh end
    from x
   where t.kode_toko = p_kode and t.no_dok = x.no and t.ke = 'supplier'
     and (t.dikirim_at, t.dikirim_oleh) is distinct from (x.at, case when x.at is null then null else x.oleh end);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function mb.terapkan_retur_dikirim(char, jsonb) from public, anon, authenticated;

-- Snapshot: sama seperti migrasi 12, ditambah retur_dikirim
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

  if jsonb_typeof(s->'retur_dikirim') = 'array' then
    perform mb.terapkan_retur_dikirim(p_kode, s->'retur_dikirim');
  end if;

  if cs is not null and jsonb_typeof(cs) = 'object' and cs->>'shift_uid' is not null then
    perform mb.terapkan_shift(p_kode, (cs - 'sales') || '{"closed_at": null}', cs->'sales', v_at);
  end if;
  return true;
end $$;

-- Daftar dokumen retur toko + status di Accurate + status kirim
-- p_status: null (semua) | 'SUDAH' | 'SEBAGIAN' | 'BELUM'
-- p_kirim:  null (semua) | 'TOKO' (barang masih di toko) | 'DIKIRIM' (sudah dimuat / dikirim)
drop function if exists public.laporan_retur_toko(char, text);
create or replace function public.laporan_retur_toko(p_kode_toko char(3) default null, p_status text default null, p_kirim text default null)
returns table(kode_toko char(3), no_dok text, waktu timestamptz, alasan text, jumlah_barang bigint, qty numeric,
              qty_accurate numeric, status text, dikirim_at timestamptz, dikirim_oleh text)
language sql stable security invoker set search_path = public, mb as $$
  select * from (
    select a.kode_toko, a.no_dok, min(a.waktu) as waktu, min(a.alasan) as alasan, count(*) as jumlah_barang, sum(a.qty) as qty,
           sum(a.qty_accurate) as qty_accurate,
           case when sum(a.qty_accurate) >= sum(a.qty) then 'SUDAH' when sum(a.qty_accurate) > 0 then 'SEBAGIAN' else 'BELUM' end as status,
           max(m.dikirim_at) as dikirim_at, max(m.dikirim_oleh) as dikirim_oleh
    from v_retur_toko_alokasi a
    join mutasi_toko m on m.kode_toko = a.kode_toko and m.no_dok = a.no_dok
    where p_kode_toko is null or a.kode_toko = p_kode_toko
    group by a.kode_toko, a.no_dok
  ) d
  where (coalesce(p_status, '') = '' or d.status = p_status)
    and (coalesce(p_kirim, '') = '' or (p_kirim = 'TOKO' and d.dikirim_at is null) or (p_kirim = 'DIKIRIM' and d.dikirim_at is not null))
  order by d.waktu desc, d.no_dok desc
$$;
revoke all on function public.laporan_retur_toko(char, text, text) from public, anon;
grant execute on function public.laporan_retur_toko(char, text, text) to authenticated, service_role;
