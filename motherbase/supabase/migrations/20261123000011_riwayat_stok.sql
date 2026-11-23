-- =====================================================================
-- Mother Base Trizone — riwayat stok toko (7 hari) untuk opname dari kantor
--
-- stok_toko hanya berisi stok terkini (diganti tiap snapshot). Agar template opname kantor bisa
-- memakai stok per tanggal/jam tertentu (mis. lupa unduh saat menghitung pagi/malam), tiap snapshot
-- dicatat: waktunya di toko_snapshot_waktu, dan barang yang stoknya BERUBAH di stok_toko_riwayat.
-- Stok per waktu T = baris riwayat terakhir tiap barang ≤ snapshot terakhir ≤ T.
-- Disimpan 7 hari (baris terakhir sebelum batas tetap disimpan sebagai dasar).
-- =====================================================================

create table toko_snapshot_waktu (
  kode_toko char(3) not null references toko(kode),
  per_waktu timestamptz not null,
  primary key (kode_toko, per_waktu)
);

create table stok_toko_riwayat (
  kode_toko char(3) not null references toko(kode),
  sku       text not null,
  per_waktu timestamptz not null,
  display   numeric(12,3) not null,
  gudang    numeric(12,3) not null,
  bs        numeric(12,3) not null,
  shopee    numeric(12,3) not null,
  primary key (kode_toko, sku, per_waktu)
);

alter table toko_snapshot_waktu enable row level security;
alter table stok_toko_riwayat enable row level security;
create policy baca_per_toko on toko_snapshot_waktu for select to authenticated
  using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()));
create policy baca_per_toko on stok_toko_riwayat for select to authenticated
  using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()));

-- Riwayat dimulai dari stok yang ada sekarang
insert into toko_snapshot_waktu (kode_toko, per_waktu)
select distinct kode_toko, per_waktu from stok_toko on conflict do nothing;
insert into stok_toko_riwayat (kode_toko, sku, per_waktu, display, gudang, bs, shopee)
select kode_toko, sku, per_waktu, display, gudang, bs, shopee from stok_toko on conflict do nothing;

-- Catat snapshot ke riwayat (dipanggil terapkan_snapshot setelah stok_toko diisi) lalu bersihkan > 7 hari
create or replace function mb.catat_riwayat_stok(p_kode char(3), p_at timestamptz) returns void
language plpgsql set search_path = public, mb as $$
declare
  v_batas timestamptz := now() - interval '7 days';
begin
  insert into toko_snapshot_waktu (kode_toko, per_waktu) values (p_kode, p_at) on conflict do nothing;
  insert into stok_toko_riwayat (kode_toko, sku, per_waktu, display, gudang, bs, shopee)
  select s.kode_toko, s.sku, p_at, s.display, s.gudang, s.bs, s.shopee
  from stok_toko s
  left join lateral (
    select r.display, r.gudang, r.bs, r.shopee from stok_toko_riwayat r
    where r.kode_toko = s.kode_toko and r.sku = s.sku and r.per_waktu <= p_at
    order by r.per_waktu desc limit 1) l on true
  where s.kode_toko = p_kode
    and (l.display is null or (l.display, l.gudang, l.bs, l.shopee) is distinct from (s.display, s.gudang, s.bs, s.shopee))
  on conflict (kode_toko, sku, per_waktu) do update
    set display = excluded.display, gudang = excluded.gudang, bs = excluded.bs, shopee = excluded.shopee;

  delete from toko_snapshot_waktu where kode_toko = p_kode and per_waktu < v_batas;
  -- Baris lama yang sudah tertutup baris lain sebelum batas tidak diperlukan lagi
  delete from stok_toko_riwayat r
  where r.kode_toko = p_kode and r.per_waktu < v_batas
    and exists (select 1 from stok_toko_riwayat n
                where n.kode_toko = r.kode_toko and n.sku = r.sku and n.per_waktu > r.per_waktu and n.per_waktu <= v_batas);
end $$;
revoke all on function mb.catat_riwayat_stok(char, timestamptz) from public, anon, authenticated;

-- Snapshot: sama seperti migrasi 08, ditambah catatan riwayat stok
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

  if cs is not null and jsonb_typeof(cs) = 'object' and cs->>'shift_uid' is not null then
    perform mb.terapkan_shift(p_kode, (cs - 'sales') || '{"closed_at": null}', cs->'sales', v_at);
  end if;
  return true;
end $$;

-- Stok toko per waktu (null = terbaru) untuk template opname kantor. Satu nilai jsonb (tidak kena batas baris API).
-- { per_waktu: snapshot yang dipakai (terakhir ≤ p_waktu), paling_awal: snapshot tertua yang tersimpan,
--   baris: [{ sku, nama, merk, kategori, harga_jual, satuan_masuk, isi, display, gudang, bs, shopee }] }
create or replace function public.stok_toko_per(p_kode_toko char(3), p_waktu timestamptz default null) returns jsonb
language plpgsql stable security invoker set search_path = public, mb as $$
declare
  v_per  timestamptz;
  v_awal timestamptz;
begin
  select max(per_waktu) into v_per from toko_snapshot_waktu
  where kode_toko = p_kode_toko and (p_waktu is null or per_waktu <= p_waktu);
  select min(per_waktu) into v_awal from toko_snapshot_waktu where kode_toko = p_kode_toko;
  if v_per is null then
    return jsonb_build_object('per_waktu', null, 'paling_awal', v_awal, 'baris', '[]'::jsonb);
  end if;
  return jsonb_build_object('per_waktu', v_per, 'paling_awal', v_awal, 'baris', coalesce((
    select jsonb_agg(jsonb_build_object(
      'sku', p.sku, 'nama', p.nama, 'merk', p.merk, 'kategori', p.kategori, 'harga_jual', p.harga_jual,
      'satuan_masuk', coalesce(m.satuan_masuk, mb.satuan_masuk(p.pack_unit), 'Coly'),
      'isi', case when coalesce(m.satuan_masuk, mb.satuan_masuk(p.pack_unit)) = 'Biji' then 1
                  else coalesce(m.rasio_isi::int, p.pack_ratio, 1) end,
      'display', coalesce(r.display, 0), 'gudang', coalesce(r.gudang, 0), 'bs', coalesce(r.bs, 0), 'shopee', coalesce(r.shopee, 0))
      order by p.nama, p.sku)
    from produk_toko p
    left join produk m on m.sku = p.sku
    left join lateral (
      select h.display, h.gudang, h.bs, h.shopee from stok_toko_riwayat h
      where h.kode_toko = p.kode_toko and h.sku = p.sku and h.per_waktu <= v_per
      order by h.per_waktu desc limit 1) r on true
    where p.kode_toko = p_kode_toko), '[]'::jsonb));
end $$;
revoke all on function public.stok_toko_per(char, timestamptz) from public, anon;
grant execute on function public.stok_toko_per(char, timestamptz) to authenticated, service_role;

-- Opname kantor: sama seperti migrasi 10, ditambah pengaman stok opname toko setelah Tanggal_Stok
-- (stok lama dipakai sebagai patokan; opname toko sesudahnya sudah menyetel ulang stok barang itu).
create or replace function public.buat_opname_kantor(p_kode_toko char(3), p_catatan text, p_dok jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  v_peran   peran_pengguna := mb.peran_saya();
  v_nama    text := (select nama from pengguna where id = auth.uid() and aktif);
  v_kode    char(3) := upper(btrim(p_kode_toko));
  v_catatan text := nullif(btrim(coalesce(p_catatan, '')), '');
  d         jsonb;
  v_zona    text;
  v_per     timestamptz;
  v_id      bigint;
  v_no      text;
  v_hari    text := to_char(mb.tgl_wib(now()), 'YYYYMMDD');
  v_salah   text;
  v_hasil   jsonb := '[]';
begin
  if v_peran is null or v_peran not in ('owner', 'admin_kantor') then
    raise exception 'Akses ditolak: hanya owner dan admin kantor yang boleh membuat opname kantor.';
  end if;
  if not exists (select 1 from toko where kode = v_kode and aktif) then
    raise exception 'Toko % tidak ditemukan atau tidak aktif.', v_kode;
  end if;
  if jsonb_typeof(p_dok) <> 'array' or jsonb_array_length(p_dok) = 0 then
    raise exception 'Tidak ada hasil hitung yang dikirim.';
  end if;
  if length(coalesce(v_catatan, '')) > 200 then raise exception 'Catatan maksimal 200 huruf.'; end if;
  perform pg_advisory_xact_lock(hashtext('opname_kantor'));

  for d in select * from jsonb_array_elements(p_dok) loop
    v_zona := d->>'zona';
    if not mb.is_zona_stok(coalesce(v_zona, '')) then raise exception 'Zona opname "%" tidak dikenal.', v_zona; end if;
    begin
      v_per := mb.wib(d->>'stok_per');
    exception when others then
      raise exception 'Tanggal_Stok "%" tidak terbaca (format YYYY-MM-DD HH:MM).', d->>'stok_per';
    end;
    if v_per is null then raise exception 'Tanggal_Stok wajib diisi (unduh template dari homebase).'; end if;
    if v_per > now() + interval '5 minutes' then raise exception 'Tanggal_Stok % belum terjadi.', d->>'stok_per'; end if;
    if jsonb_typeof(d->'baris') <> 'array' or jsonb_array_length(d->'baris') = 0 then
      raise exception 'Zona % tidak berisi barang.', v_zona;
    end if;

    -- Barang harus ada di Daftar Barang toko; angka harus bilangan bulat (stok dalam Biji)
    select string_agg(x->>'sku', ', ') into v_salah from (
      select x from jsonb_array_elements(d->'baris') x
      where not exists (select 1 from produk_toko p where p.kode_toko = v_kode and p.sku = x->>'sku')
      limit 10) s;
    if v_salah is not null then raise exception 'Barang tidak ada di Daftar Barang toko %: %', v_kode, v_salah; end if;
    select string_agg(x->>'sku', ', ') into v_salah from (
      select x from jsonb_array_elements(d->'baris') x
      where (x->>'fisik') is null or (x->>'patokan') is null
         or (x->>'fisik')::numeric <> trunc((x->>'fisik')::numeric) or (x->>'patokan')::numeric <> trunc((x->>'patokan')::numeric)
      limit 10) s;
    if v_salah is not null then raise exception 'Fisik dan stok patokan harus bilangan bulat (Biji): %', v_salah; end if;

    -- Cegah selisih dihitung dua kali: barang yang sama di zona yang sama masih menunggu toko,
    -- atau sudah diopname kantor setelah stok di file ini.
    select string_agg(distinct o.no_dok || ' (' || b.sku || ')', ', ') into v_salah
    from opname_kantor o join opname_kantor_baris b on b.opname_id = o.id
    where o.kode_toko = v_kode and o.zona = v_zona
      and (o.status = 'dikirim' or (o.status = 'diterapkan' and o.diterapkan_at > v_per))
      and b.sku in (select x->>'sku' from jsonb_array_elements(d->'baris') x);
    if v_salah is not null then
      raise exception 'Barang ini sudah diopname kantor setelah stok di file, atau masih menunggu toko: %. Tarik stok terbaru lalu unduh template baru.', left(v_salah, 300);
    end if;
    -- ... atau toko sendiri sudah membuat stok opname barang itu setelah stok di file
    select string_agg(distinct o.no_op || ' (' || b.sku || ')', ', ') into v_salah
    from stok_opname o join stok_opname_baris b on b.kode_toko = o.kode_toko and b.no_op = o.no_op
    where o.kode_toko = v_kode and o.zona = v_zona and o.dibuat_at > v_per
      and not exists (select 1 from opname_kantor k where k.kode_toko = o.kode_toko and k.no_op_toko = o.no_op)
      and b.sku in (select x->>'sku' from jsonb_array_elements(d->'baris') x);
    if v_salah is not null then
      raise exception 'Toko sudah membuat stok opname untuk barang ini setelah stok di file: %. Pakai stok setelah opname itu (pilih jam yang lebih baru).', left(v_salah, 300);
    end if;

    v_no := 'OPK-' || v_hari || '-' || lpad((coalesce((
      select max(substring(no_dok from 14)::int) from opname_kantor where no_dok like 'OPK-' || v_hari || '-%'), 0) + 1)::text, 3, '0');
    insert into opname_kantor (no_dok, kode_toko, zona, catatan, stok_per, dibuat_oleh, dibuat_oleh_nama)
    values (v_no, v_kode, v_zona, v_catatan, v_per, auth.uid(), v_nama)
    returning id into v_id;
    insert into opname_kantor_baris (opname_id, baris_ke, sku, nama, patokan, fisik)
    select v_id, row_number() over (order by min(o)), x->>'sku', min(p.nama), min((x->>'patokan')::numeric), sum((x->>'fisik')::numeric)
    from jsonb_array_elements(d->'baris') with ordinality t(x, o)
    join produk_toko p on p.kode_toko = v_kode and p.sku = x->>'sku'
    group by x->>'sku';
    v_hasil := v_hasil || jsonb_build_object('id', v_id, 'no_dok', v_no, 'zona', v_zona,
      'jumlah', (select count(*) from opname_kantor_baris where opname_id = v_id));
  end loop;

  -- Minta toko segera memeriksa (Trizone mengecek tiap 5 menit)
  insert into toko_status as s (kode_toko, minta_update_at, minta_update_oleh) values (v_kode, now(), v_nama)
  on conflict (kode_toko) do update set minta_update_at = excluded.minta_update_at, minta_update_oleh = excluded.minta_update_oleh;
  return v_hasil;
end $$;
