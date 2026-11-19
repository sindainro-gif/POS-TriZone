-- =====================================================================
-- Mother Base Trizone — stok opname dari kantor
--
-- Owner / pengguna kantor membuat stok opname untuk satu toko di aplikasi web: upload template
-- opname Trizone (kolom Kode, Fisik per zona, stok per zona, Tanggal_Stok) atau isi baris sendiri.
-- Satu opname = satu zona (sama seperti dokumen OP- di Trizone).
--
-- Trizone (PC Gudang / Mandiri) mengambil opname yang menunggu lewat ambil_opname_kantor().
-- Gudang / Admin toko hanya bisa MENERAPKAN apa adanya: angkanya tidak bisa diubah di toko.
-- Setelah diterapkan, Trizone melaporkan nomor dokumen OP- toko lewat opname_kantor_diterapkan();
-- kantor melihat status "diterapkan" dengan nomor OP itu. Laporan ulang selalu aman (idempoten).
--
-- Cara menghitung sama dengan import opname Trizone:
--   * tanpa stok patokan: stok zona di toko di-set ke angka fisik saat diterapkan;
--   * dengan stok patokan + Tanggal_Stok: hanya selisih (fisik − patokan) yang ditambahkan ke stok
--     saat diterapkan, jadi penjualan / mutasi / penerimaan setelah Tanggal_Stok tetap terhitung.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fungsi bantu
-- ---------------------------------------------------------------------
-- Teks jam WIB "YYYY-MM-DD[ HH:MM[:SS]]" → timestamptz, null bila tidak terbaca (bukan error)
create or replace function mb.coba_wib(t text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if t is null or btrim(t) !~ '^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$' then return null; end if;
  return (replace(btrim(t), 'T', ' ') || '+07')::timestamptz;
exception when others then return null;
end $$;

-- Teks angka → numeric, null bila kosong atau bukan angka (bukan error)
create or replace function mb.coba_angka(t text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return btrim(t)::numeric;
exception when others then return null;
end $$;

create or replace function mb.nama_zona(z text) returns text
language sql immutable set search_path = '' as $$
  select case z when 'floor' then 'Display Toko' when 'warehouse' then 'Gudang Utama'
                when 'damaged' then 'Gudang BS' when 'shopee' then 'Gudang Shopee' else z end
$$;

-- ---------------------------------------------------------------------
-- Tabel
-- ---------------------------------------------------------------------
create table opname_kantor (
  id                   bigint generated always as identity primary key,
  kode_toko            char(3) not null references toko(kode),
  zona                 text not null check (mb.is_zona_stok(zona)),
  catatan              text,
  dibuat_at            timestamptz not null default now(),
  dibuat_oleh          uuid,                      -- auth.uid() pembuat
  dibuat_oleh_nama     text,
  jumlah_baris         int not null default 0,
  status               text not null default 'baru' check (status in ('baru', 'diterapkan', 'dibatalkan')),
  diambil_at           timestamptz,               -- pertama kali diambil Trizone toko
  no_op                text,                      -- dokumen OP- di toko
  diterapkan_at        timestamptz,               -- waktu diterapkan di toko
  diterapkan_oleh      text,                      -- akun Trizone yang menerapkan
  dilaporkan_at        timestamptz,               -- saat Trizone melapor ke kantor
  dibatalkan_at        timestamptz,
  dibatalkan_oleh_nama text,
  check ((status = 'diterapkan') = (no_op is not null))
);
create index on opname_kantor (kode_toko, status);

create table opname_kantor_baris (
  opname_id     bigint not null references opname_kantor(id) on delete cascade,
  baris_ke      int not null,
  sku           text not null,
  fisik         int not null check (fisik >= 0),
  stok_patokan  int,                 -- stok zona di file per tanggal_stok (boleh minus)
  tanggal_stok  timestamptz,
  primary key (opname_id, baris_ke),
  unique (opname_id, sku),
  check ((stok_patokan is null) = (tanggal_stok is null))
);

-- Kantor melihat semua, pemilik toko hanya tokonya. Ditulis hanya lewat fungsi di bawah.
alter table opname_kantor enable row level security;
create policy baca_per_toko on opname_kantor for select to authenticated
  using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()));
alter table opname_kantor_baris enable row level security;
create policy baca_per_toko on opname_kantor_baris for select to authenticated
  using (exists (select 1 from opname_kantor o
                 where o.id = opname_id and ((select mb.is_kantor()) or o.kode_toko = (select mb.toko_saya()))));

-- ---------------------------------------------------------------------
-- Aplikasi web kantor
-- ---------------------------------------------------------------------
-- Periksa (p_simpan = false) atau simpan (p_simpan = true) opname untuk satu toko.
-- p_baris = [{ baris, zona, kode, fisik, stok_patokan, tanggal_stok }]
--   baris: nomor baris di Excel (untuk pesan kesalahan); kode: SKU atau barcode;
--   stok_patokan + tanggal_stok (jam WIB "YYYY-MM-DD HH:MM[:SS]"): diisi berdua atau kosong berdua.
-- Disimpan hanya bila tidak ada kesalahan: satu opname per zona yang punya baris.
create or replace function public.buat_opname_kantor(p_kode_toko text, p_baris jsonb, p_catatan text default null,
                                                     p_simpan boolean default false)
returns jsonb language plpgsql security definer set search_path = public, mb, pg_temp as $$
declare
  v_kode     char(3) := upper(btrim(coalesce(p_kode_toko, '')));
  v_catatan  text := nullif(btrim(coalesce(p_catatan, '')), '');
  v_err      jsonb;
  v_n_err    int;
  v_warn     jsonb;
  v_ringkas  jsonb;
  v_rinci    jsonb;
  v_ids      bigint[] := '{}';
  v_id       bigint;
  v_zona     text;
  v_nama     text;
begin
  if auth.uid() is not null and not mb.is_kantor() then
    raise exception 'Hanya pengguna kantor yang boleh membuat opname untuk toko';
  end if;
  if not exists (select 1 from toko where kode = v_kode and aktif) then
    raise exception 'Toko % tidak ada atau tidak aktif', coalesce(nullif(btrim(p_kode_toko), ''), '-');
  end if;
  if jsonb_typeof(p_baris) is distinct from 'array' then raise exception 'Data opname harus berupa daftar baris'; end if;
  if jsonb_array_length(p_baris) = 0 then raise exception 'Belum ada baris opname'; end if;
  if jsonb_array_length(p_baris) > 40000 then raise exception 'Maksimal 40.000 baris sekali buat'; end if;
  if length(v_catatan) > 150 then raise exception 'Catatan maksimal 150 karakter'; end if;

  drop table if exists pg_temp.opname_kantor_cek;
  create temp table opname_kantor_cek on commit drop as
  with d as (
    select case when x->>'baris' ~ '^\d{1,9}$' then (x->>'baris')::int else o::int end as baris,
           lower(btrim(coalesce(x->>'zona', ''))) as zona,
           nullif(btrim(coalesce(x->>'kode', '')), '') as kode,
           nullif(btrim(coalesce(x->>'fisik', '')), '') as fisik_t,
           mb.coba_angka(x->>'fisik') as fisik,
           nullif(btrim(coalesce(x->>'stok_patokan', '')), '') as patokan_t,
           mb.coba_angka(x->>'stok_patokan') as patokan,
           nullif(btrim(coalesce(x->>'tanggal_stok', '')), '') as tgl_t,
           mb.coba_wib(x->>'tanggal_stok') as tgl
    from jsonb_array_elements(p_baris) with ordinality t(x, o)
  ),
  r as (
    -- Kode = SKU atau barcode; daftar barang toko didahulukan, lalu master barang kantor
    select d.*, c.sku, c.nama, coalesce(c.di_toko, false) as di_toko
    from d left join lateral (
      select k.sku, k.nama, k.di_toko from (
        select pt.sku, pt.nama, true as di_toko, 1 as urut from produk_toko pt where pt.kode_toko = v_kode and pt.sku = d.kode
        union all select pt.sku, pt.nama, true, 2 from produk_toko pt where pt.kode_toko = v_kode and pt.barcode = d.kode
        union all select p.sku, p.nama, false, 3 from produk p where p.sku = d.kode
        union all select p.sku, p.nama, false, 4 from produk p where p.barcode = d.kode
      ) k order by k.urut limit 1) c on true
  ),
  s as (
    select r.*, case r.zona when 'floor' then st.display when 'warehouse' then st.gudang
                            when 'damaged' then st.bs when 'shopee' then st.shopee end as stok_toko
    from r left join stok_toko st on st.kode_toko = v_kode and st.sku = r.sku
  )
  select s.*,
         count(*) over g as n_dobel, string_agg(s.baris::text, ', ') over g as baris_dobel,
         case s.zona when 'floor' then 1 when 'warehouse' then 2 when 'damaged' then 3 when 'shopee' then 4 else 9 end as urut_zona
  from s
  window g as (partition by s.zona, s.sku order by s.baris rows between unbounded preceding and unbounded following);

  with e as (
    select baris, 'Kode barang kosong' as pesan from opname_kantor_cek where kode is null
    union all select baris, format('Kode %s tidak ada di daftar barang toko %s maupun master barang', kode, v_kode)
              from opname_kantor_cek where kode is not null and sku is null
    union all select baris, format('Zona "%s" tidak dikenal', zona) from opname_kantor_cek where not mb.is_zona_stok(zona)
    union all select baris, 'Fisik wajib diisi' from opname_kantor_cek where fisik_t is null
    union all select baris, format('Fisik "%s" harus angka bulat 0 atau lebih', fisik_t) from opname_kantor_cek
              where fisik_t is not null and (fisik is null or fisik < 0 or fisik <> trunc(fisik) or fisik > 1000000000)
    union all select baris, format('Stok patokan "%s" harus angka bulat', patokan_t) from opname_kantor_cek
              where patokan_t is not null and (patokan is null or patokan <> trunc(patokan) or abs(patokan) > 1000000000)
    union all select baris, 'Tanggal_Stok wajib diisi bila stok patokan diisi' from opname_kantor_cek where patokan_t is not null and tgl_t is null
    union all select baris, 'Stok patokan wajib diisi bila Tanggal_Stok diisi' from opname_kantor_cek where patokan_t is null and tgl_t is not null
    union all select baris, format('Tanggal_Stok "%s" tidak terbaca (format YYYY-MM-DD HH:MM)', tgl_t) from opname_kantor_cek
              where tgl_t is not null and tgl is null
    union all select baris, format('Tanggal_Stok %s belum terjadi', to_char(tgl at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI'))
              from opname_kantor_cek where tgl > now()
    union all select baris, format('%s ada di lebih dari satu baris untuk %s (baris %s)', sku, mb.nama_zona(zona), baris_dobel)
              from opname_kantor_cek where sku is not null and mb.is_zona_stok(zona) and n_dobel > 1
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object('baris', baris, 'pesan', pesan) order by baris, pesan)
                            filter (where n <= 500), '[]')
  into v_n_err, v_err
  from (select e.*, row_number() over (order by baris, pesan) as n from e) e;

  select coalesce(jsonb_agg(jsonb_build_object('baris', baris,
           'pesan', format('%s belum ada di daftar barang toko %s (baru ada di master barang). Toko perlu Perbarui Daftar Barang sebelum menerapkan.', sku, v_kode))
           order by baris) filter (where n <= 200), '[]')
  into v_warn
  from (select c.*, row_number() over (order by baris) as n from opname_kantor_cek c where sku is not null and not di_toko) w;

  -- Perkiraan selisih: terhadap stok patokan di file, atau stok terakhir yang dikirim toko
  select coalesce(jsonb_agg(jsonb_build_object('zona', zona, 'jumlah_baris', n, 'plus_qty', plus, 'minus_qty', minus,
                                               'tanpa_stok', tanpa, 'berpatokan', berpatokan, 'tanggal_stok', tgl_awal) order by urut_zona), '[]')
  into v_ringkas
  from (select zona, urut_zona, count(*) as n, coalesce(sum(greatest(sel, 0)), 0) as plus, coalesce(sum(greatest(-sel, 0)), 0) as minus,
               count(*) filter (where sel is null) as tanpa, bool_or(patokan is not null) as berpatokan, min(tgl) as tgl_awal
        from (select *, fisik - coalesce(patokan, stok_toko) as sel from opname_kantor_cek where mb.is_zona_stok(zona)) z
        group by zona, urut_zona) g;

  select coalesce(jsonb_agg(jsonb_build_object('baris', baris, 'zona', zona, 'sku', sku, 'kode', kode, 'nama', nama, 'fisik', fisik,
                                               'stok_patokan', patokan, 'tanggal_stok', tgl, 'stok_toko', stok_toko,
                                               'selisih', fisik - coalesce(patokan, stok_toko)) order by urut_zona, baris), '[]')
  into v_rinci
  from (select * from opname_kantor_cek order by urut_zona, baris limit 2000) x;

  if p_simpan and v_n_err = 0 then
    select nama into v_nama from pengguna where id = auth.uid();
    for v_zona in select u.z from unnest(array['floor', 'warehouse', 'damaged', 'shopee']) with ordinality u(z, n)
                  where exists (select 1 from opname_kantor_cek c where c.zona = u.z) order by u.n loop
      insert into opname_kantor (kode_toko, zona, catatan, dibuat_oleh, dibuat_oleh_nama, jumlah_baris)
      values (v_kode, v_zona, v_catatan, auth.uid(), coalesce(v_nama, 'Kantor'),
              (select count(*) from opname_kantor_cek c where c.zona = v_zona))
      returning id into v_id;
      insert into opname_kantor_baris (opname_id, baris_ke, sku, fisik, stok_patokan, tanggal_stok)
      select v_id, row_number() over (order by c.baris), c.sku, c.fisik::int, c.patokan::int, c.tgl
      from opname_kantor_cek c where c.zona = v_zona;
      v_ids := v_ids || v_id;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', v_n_err = 0, 'kode_toko', v_kode, 'jumlah', (select count(*) from opname_kantor_cek),
    'jumlah_error', v_n_err, 'error', v_err, 'peringatan', v_warn, 'opname', v_ringkas, 'rincian', v_rinci,
    'stok_per', (select snapshot_terakhir_at from toko_status where kode_toko = v_kode),
    'disimpan', cardinality(v_ids) > 0, 'id', to_jsonb(v_ids));
end $$;

-- Batalkan opname yang belum diterapkan toko. Trizone menghapusnya dari daftar saat mengambil berikutnya.
-- (Bila toko ternyata sudah menerapkannya tanpa internet, laporan toko tetap mengubah status jadi diterapkan.)
create or replace function public.batalkan_opname_kantor(p_id bigint) returns void
language plpgsql security definer set search_path = public, mb as $$
begin
  if auth.uid() is not null and not mb.is_kantor() then raise exception 'Hanya pengguna kantor yang boleh membatalkan opname'; end if;
  update opname_kantor set status = 'dibatalkan', dibatalkan_at = now(),
         dibatalkan_oleh_nama = coalesce((select nama from pengguna where id = auth.uid()), 'Kantor')
  where id = p_id and status = 'baru';
  if not found then raise exception 'Opname #% tidak bisa dibatalkan: sudah diterapkan toko, sudah dibatalkan, atau tidak ada', p_id; end if;
end $$;

-- Daftar opname dari kantor + status di toko. Selisih +/− dari dokumen OP- toko (setelah terkirim ke mother base).
create or replace function public.daftar_opname_kantor(p_kode_toko char(3) default null, p_status text default null,
                                                       p_batas int default 200)
returns table(id bigint, kode_toko char(3), zona text, catatan text, dibuat_at timestamptz, dibuat_oleh text, jumlah_baris int,
              status text, diambil_at timestamptz, no_op text, diterapkan_at timestamptz, diterapkan_oleh text,
              dibatalkan_at timestamptz, dibatalkan_oleh text, plus_qty numeric, minus_qty numeric)
language sql stable security invoker set search_path = public, mb as $$
  select o.id, o.kode_toko, o.zona, o.catatan, o.dibuat_at, o.dibuat_oleh_nama, o.jumlah_baris, o.status, o.diambil_at,
         o.no_op, o.diterapkan_at, o.diterapkan_oleh, o.dibatalkan_at, o.dibatalkan_oleh_nama, s.plus_qty, s.minus_qty
  from opname_kantor o
  left join stok_opname s on s.kode_toko = o.kode_toko and s.no_op = o.no_op
  where (p_kode_toko is null or o.kode_toko = p_kode_toko) and (p_status is null or o.status = p_status)
  order by o.id desc
  limit least(greatest(coalesce(p_batas, 200), 1), 1000)
$$;

-- Baris satu opname; setelah dokumen OP- toko masuk: stok sistem toko saat diterapkan dan selisihnya.
create or replace function public.rincian_opname_kantor(p_id bigint)
returns table(baris_ke int, sku text, nama text, fisik int, stok_patokan int, tanggal_stok timestamptz,
              stok_sistem_toko numeric, selisih_toko numeric, stok_sebelum_toko numeric)
language sql stable security invoker set search_path = public, mb as $$
  select b.baris_ke, b.sku, coalesce(pt.nama, p.nama), b.fisik, b.stok_patokan, b.tanggal_stok,
         sb.stok_sistem, sb.selisih, sb.stok_sebelum
  from opname_kantor o
  join opname_kantor_baris b on b.opname_id = o.id
  left join produk_toko pt on pt.kode_toko = o.kode_toko and pt.sku = b.sku
  left join produk p on p.sku = b.sku
  left join stok_opname_baris sb on sb.kode_toko = o.kode_toko and sb.no_op = o.no_op and sb.sku = b.sku
  where o.id = p_id
  order by b.baris_ke
$$;

-- ---------------------------------------------------------------------
-- RPC untuk Trizone (anon key + kode & kunci toko, seperti terima_data / ambil_master)
-- ---------------------------------------------------------------------
-- p = { kode_toko, kunci } → { kode_toko, server_at, opname: [{ id, zona, catatan, dibuat_at, dibuat_oleh,
--       baris: [{ sku, fisik, stok_patokan, tanggal_stok }] }] }   (jam WIB "YYYY-MM-DD HH:MM:SS")
-- Hanya opname berstatus baru. Opname yang tidak ada lagi di daftar = dibatalkan kantor.
create or replace function public.ambil_opname_kantor(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare v_kode char(3);
begin
  v_kode := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
  update opname_kantor set diambil_at = now() where kode_toko = v_kode and status = 'baru' and diambil_at is null;
  return jsonb_build_object('kode_toko', v_kode, 'server_at', now(), 'opname', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'zona', o.zona, 'catatan', o.catatan, 'dibuat_oleh', o.dibuat_oleh_nama,
      'dibuat_at', to_char(o.dibuat_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
      'baris', (select coalesce(jsonb_agg(jsonb_build_object(
                  'sku', b.sku, 'fisik', b.fisik, 'stok_patokan', b.stok_patokan,
                  'tanggal_stok', to_char(b.tanggal_stok at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS')) order by b.baris_ke), '[]')
                from opname_kantor_baris b where b.opname_id = o.id)) order by o.id)
    from opname_kantor o where o.kode_toko = v_kode and o.status = 'baru'), '[]'::jsonb));
end $$;

-- Laporan dari toko: opname kantor sudah diterapkan dengan dokumen OP- toko.
-- p = { kode_toko, kunci, diterapkan: [{ id, no_op, diterapkan_at, diterapkan_oleh }] }
-- → { ok, diterima: [id opname toko ini], tidak_ada: [id yang bukan milik toko ini / tidak ada] }
-- Idempoten: laporan ulang tidak mengubah apa pun. Laporan pertama yang menentukan nomor OP-.
create or replace function public.opname_kantor_diterapkan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  v_kode  char(3);
  v_ada   bigint[];
  v_tidak bigint[];
begin
  v_kode := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
  if jsonb_typeof(coalesce(p->'diterapkan', '[]')) <> 'array' then raise exception 'diterapkan harus berupa daftar'; end if;
  with x as (
    select (e->>'id')::bigint as id, nullif(btrim(e->>'no_op'), '') as no_op, mb.coba_wib(e->>'diterapkan_at') as waktu,
           left(nullif(btrim(e->>'diterapkan_oleh'), ''), 100) as oleh
    from jsonb_array_elements(coalesce(p->'diterapkan', '[]')) e
    where e->>'id' ~ '^\d{1,18}$'
  ),
  u as (
    update opname_kantor o
       set status = 'diterapkan', no_op = x.no_op, diterapkan_at = coalesce(x.waktu, now()),
           diterapkan_oleh = x.oleh, dilaporkan_at = now()
      from x
     where o.id = x.id and o.kode_toko = v_kode and x.no_op is not null and o.status <> 'diterapkan'
    returning o.id
  )
  select coalesce(array_agg(x.id) filter (where o.id is not null), '{}'),
         coalesce(array_agg(x.id) filter (where o.id is null), '{}')
  into v_ada, v_tidak
  from x left join opname_kantor o on o.id = x.id and o.kode_toko = v_kode;
  return jsonb_build_object('ok', true, 'kode_toko', v_kode, 'diterima', to_jsonb(v_ada), 'tidak_ada', to_jsonb(v_tidak));
end $$;

-- ---------------------------------------------------------------------
-- Hak akses fungsi
-- ---------------------------------------------------------------------
revoke all on function public.ambil_opname_kantor(jsonb) from public, authenticated;
revoke all on function public.opname_kantor_diterapkan(jsonb) from public, authenticated;
grant execute on function public.ambil_opname_kantor(jsonb) to anon, service_role;
grant execute on function public.opname_kantor_diterapkan(jsonb) to anon, service_role;
do $$
declare f text;
begin
  foreach f in array array['buat_opname_kantor(text, jsonb, text, boolean)', 'batalkan_opname_kantor(bigint)',
                           'daftar_opname_kantor(char, text, int)', 'rincian_opname_kantor(bigint)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
