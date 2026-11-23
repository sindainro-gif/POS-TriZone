-- =====================================================================
-- Mother Base Trizone — stock opname dari kantor (homebase)
--
-- Alur:
--   1. Kantor menarik stok terbaru toko (tombol "Tarik stok terbaru" → minta_update_toko, migrasi 09).
--   2. Kantor mengunduh template opname (stok per waktu kiriman terakhir = Tanggal_Stok), menghitung fisik,
--      lalu mengunggah hasilnya → buat_opname_kantor(): satu dokumen OPK per zona, status 'dikirim'.
--   3. Trizone 1.23.0 memeriksa cek_permintaan() tiap 5 menit, menerapkan opname dengan patokan stok di
--      file (hanya selisih fisik − patokan yang ditambahkan ke stok sekarang, jadi penjualan setelah
--      Tanggal_Stok tetap terhitung), lalu melapor lewat opname_diterapkan() dan mengirim stok terbaru.
--   4. Dokumen OP hasilnya di toko otomatis berstatus DISETUJUI di review SO (tidak perlu review ulang).
-- Hanya owner & admin kantor yang boleh membuat / membatalkan opname kantor.
-- =====================================================================

create table opname_kantor (
  id               bigserial primary key,
  no_dok           text not null unique,                  -- OPK-YYYYMMDD-NNN
  kode_toko        char(3) not null references toko(kode),
  zona             text not null check (mb.is_zona_stok(zona)),
  catatan          text,
  stok_per         timestamptz not null,                  -- Tanggal_Stok: stok patokan di file per kapan
  status           text not null default 'dikirim' check (status in ('dikirim', 'diterapkan', 'batal')),
  dibuat_oleh      uuid references pengguna(id),
  dibuat_oleh_nama text,
  dibuat_at        timestamptz not null default now(),
  diterapkan_at    timestamptz,
  no_op_toko       text,                                  -- nomor OP di Trizone (null = tidak ada barang yang diterapkan)
  dilewati         jsonb not null default '[]',           -- SKU yang tidak ada di Daftar Barang toko
  batal_alasan     text,
  batal_oleh_nama  text
);
create index on opname_kantor (kode_toko, status);
create unique index on opname_kantor (kode_toko, no_op_toko) where no_op_toko is not null;

create table opname_kantor_baris (
  opname_id  bigint not null references opname_kantor(id) on delete cascade,
  baris_ke   int not null,
  sku        text not null,
  nama       text,
  patokan    numeric(12,3) not null,                      -- stok di file (per stok_per)
  fisik      numeric(12,3) not null,
  selisih    numeric(12,3) generated always as (fisik - patokan) stored,
  primary key (opname_id, baris_ke),
  unique (opname_id, sku)
);

alter table opname_kantor enable row level security;
alter table opname_kantor_baris enable row level security;
create policy kantor_baca on opname_kantor for select to authenticated using ((select mb.is_kantor()));
create policy kantor_baca on opname_kantor_baris for select to authenticated using ((select mb.is_kantor()));

-- Buat opname kantor. p_dok: [{ zona, stok_per: 'YYYY-MM-DD HH:MM[:SS]' (WIB), baris: [{ sku, patokan, fisik }] }]
-- Satu dokumen per zona. Barang yang sama di satu zona dijumlahkan fisiknya (dihitung di beberapa rak).
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

-- Batal selama toko belum menerapkan. (Bila toko ternyata sudah menerapkan sebelum batal tercatat,
-- laporan toko tetap diterima dan status menjadi 'diterapkan'.)
create or replace function public.batal_opname_kantor(p_id bigint, p_alasan text) returns void
language plpgsql security definer set search_path = public, mb as $$
begin
  if coalesce(mb.peran_saya()::text, '') not in ('owner', 'admin_kantor') then
    raise exception 'Akses ditolak: hanya owner dan admin kantor yang boleh membatalkan opname kantor.';
  end if;
  if length(btrim(coalesce(p_alasan, ''))) < 3 then raise exception 'Alasan pembatalan minimal 3 huruf.'; end if;
  update opname_kantor set status = 'batal', batal_alasan = btrim(p_alasan),
         batal_oleh_nama = (select nama from pengguna where id = auth.uid())
  where id = p_id and status = 'dikirim';
  if not found then raise exception 'Opname ini sudah diterapkan toko atau sudah dibatalkan.'; end if;
end $$;

-- Dipanggil Trizone (anon key + kunci toko) tiap 5 menit: ada permintaan kirim? ada opname kantor?
create or replace function public.cek_permintaan(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, mb as $$
declare
  v_kode char(3) := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
begin
  return jsonb_build_object(
    'kode_toko', v_kode,
    'minta', coalesce((
      select s.minta_update_at is not null and (s.kiriman_terakhir_at is null or s.minta_update_at > s.kiriman_terakhir_at)
      from toko_status s where s.kode_toko = v_kode), false),
    'opname', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'no_dok', o.no_dok, 'zona', o.zona, 'catatan', o.catatan,
        'stok_per', to_char(o.stok_per at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
        'baris', (select jsonb_agg(jsonb_build_object('sku', b.sku, 'patokan', b.patokan, 'fisik', b.fisik) order by b.baris_ke)
                  from opname_kantor_baris b where b.opname_id = o.id)) order by o.id)
      from opname_kantor o where o.kode_toko = v_kode and o.status = 'dikirim'), '[]'::jsonb));
end $$;

-- Laporan Trizone setelah menerapkan opname kantor: hasil = [{ id, no_op, dilewati: [sku] }]
create or replace function public.opname_diterapkan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  v_kode char(3) := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
  v_n    int;
begin
  with h as (
    select (x->>'id')::bigint as id, nullif(x->>'no_op', '') as no_op, coalesce(x->'dilewati', '[]'::jsonb) as dilewati
    from jsonb_array_elements(coalesce(p->'hasil', '[]'::jsonb)) x)
  update opname_kantor o set status = 'diterapkan', no_op_toko = h.no_op, dilewati = h.dilewati,
         diterapkan_at = coalesce(o.diterapkan_at, now())
  from h where o.id = h.id and o.kode_toko = v_kode and o.status in ('dikirim', 'batal');
  get diagnostics v_n = row_count;
  -- Dokumen OP toko yang sudah masuk lebih dulu: setujui otomatis
  update stok_opname_review r set status = 'DISETUJUI', catatan = 'Opname dari kantor ' || o.no_dok,
         direview_oleh = o.dibuat_oleh, direview_at = now()
  from opname_kantor o
  where o.kode_toko = v_kode and r.kode_toko = o.kode_toko and r.no_op = o.no_op_toko and r.status = 'BARU';
  return jsonb_build_object('ok', true, 'diterapkan', v_n);
end $$;

-- Review SO: dokumen OP toko yang berasal dari opname kantor langsung DISETUJUI
create or replace function mb.review_opname_kantor() returns trigger
language plpgsql security definer set search_path = public, mb as $$
declare o record;
begin
  if new.status = 'BARU' then
    select no_dok, dibuat_oleh into o from opname_kantor where kode_toko = new.kode_toko and no_op_toko = new.no_op;
    if found then
      new.status := 'DISETUJUI';
      new.catatan := 'Opname dari kantor ' || o.no_dok;
      new.direview_oleh := o.dibuat_oleh;
      new.direview_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger review_opname_kantor before insert or update on stok_opname_review
  for each row execute function mb.review_opname_kantor();

-- Daftar opname kantor (hak akses mengikuti RLS: hanya kantor)
create or replace function public.laporan_opname_kantor(p_status text default null, p_kode_toko char(3) default null,
                                                        p_batas int default 500)
returns table(id bigint, no_dok text, kode_toko char(3), zona text, catatan text, stok_per timestamptz, status text,
              dibuat_oleh_nama text, dibuat_at timestamptz, diterapkan_at timestamptz, no_op_toko text, dilewati jsonb,
              batal_alasan text, batal_oleh_nama text, jumlah_barang bigint, jumlah_selisih bigint,
              plus_qty numeric, minus_qty numeric, nilai_selisih numeric)
language sql stable security invoker set search_path = public, mb as $$
  select o.id, o.no_dok, o.kode_toko, o.zona, o.catatan, o.stok_per, o.status, o.dibuat_oleh_nama, o.dibuat_at,
         o.diterapkan_at, o.no_op_toko, o.dilewati, o.batal_alasan, o.batal_oleh_nama,
         count(b.sku), count(b.sku) filter (where b.selisih <> 0),
         coalesce(sum(b.selisih) filter (where b.selisih > 0), 0), coalesce(-sum(b.selisih) filter (where b.selisih < 0), 0),
         coalesce(sum(b.selisih * p.harga_jual), 0)
  from opname_kantor o
  left join opname_kantor_baris b on b.opname_id = o.id
  left join produk_toko p on p.kode_toko = o.kode_toko and p.sku = b.sku
  where (coalesce(p_status, '') = '' or o.status = p_status)
    and (p_kode_toko is null or o.kode_toko = p_kode_toko)
  group by o.id
  order by o.id desc
  limit least(greatest(coalesce(p_batas, 500), 1), 2000)
$$;

revoke all on function public.buat_opname_kantor(char, text, jsonb) from public, anon;
grant execute on function public.buat_opname_kantor(char, text, jsonb) to authenticated, service_role;
revoke all on function public.batal_opname_kantor(bigint, text) from public, anon;
grant execute on function public.batal_opname_kantor(bigint, text) to authenticated, service_role;
revoke all on function public.laporan_opname_kantor(text, char, int) from public, anon;
grant execute on function public.laporan_opname_kantor(text, char, int) to authenticated, service_role;
-- Trizone memanggil dengan anon key; keamanan dari kode + kunci toko (sama seperti terima_data)
revoke all on function public.cek_permintaan(jsonb) from public, authenticated;
grant execute on function public.cek_permintaan(jsonb) to anon, service_role;
revoke all on function public.opname_diterapkan(jsonb) from public, authenticated;
grant execute on function public.opname_diterapkan(jsonb) to anon, service_role;
revoke all on function mb.review_opname_kantor() from public, anon, authenticated;
