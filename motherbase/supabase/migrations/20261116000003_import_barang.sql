-- =====================================================================
-- Mother Base Trizone — import master barang dari Excel (halaman Master Barang)
--
-- Excel dibaca di browser (web/lib/import-barang.js); fungsi ini memeriksa dan menyimpan.
-- Dua tahap: p_simpan = false hanya memeriksa dan menghitung perubahan (pratinjau),
-- p_simpan = true menyimpan bila tidak ada kesalahan (semua baris atau tidak sama sekali).
-- Sel kosong (null) = nilai lama dipertahankan. Barang yang tidak berubah tidak disentuh,
-- jadi toko hanya mengambil barang yang benar-benar berubah.
-- =====================================================================

-- Rupiah untuk teks: titik ribuan, koma desimal (27500 → 27.500; 9250.5 → 9.250,5)
create or replace function mb.ribuan(x numeric) returns text
language sql immutable set search_path = '' as $$
  select translate(rtrim(to_char(x, 'FM999,999,999,999,990.99'), '.'), ',.', '.,')
$$;

-- Baris import (jsonb dari aplikasi) → tabel
create or replace function mb.baris_import(p jsonb)
returns table(baris int, sku text, nama text, barcode text, barcode_baru text, merk text, kategori text,
              harga_jual numeric, satuan_masuk text, rasio_isi numeric, principal text, isi_dus numeric,
              harga_beli numeric, aktif boolean)
language sql immutable set search_path = '' as $$
  select (x->>'baris')::int, nullif(btrim(x->>'sku'), ''), nullif(btrim(x->>'nama'), ''),
         nullif(btrim(x->>'barcode'), ''), nullif(btrim(x->>'barcode_baru'), ''),
         nullif(btrim(x->>'merk'), ''), nullif(btrim(x->>'kategori'), ''), (x->>'harga_jual')::numeric,
         nullif(btrim(x->>'satuan_masuk'), ''), (x->>'rasio_isi')::numeric, nullif(btrim(x->>'principal'), ''),
         (x->>'isi_dus')::numeric, (x->>'harga_beli')::numeric, (x->>'aktif')::boolean
  from jsonb_array_elements(p) x
$$;

-- p_baris = [{baris, sku, nama, barcode, barcode_baru, merk, kategori, harga_jual, satuan_masuk,
--             rasio_isi, principal, isi_dus, harga_beli, aktif}]
--   barcode_baru: barcode yang dipakai hanya bila SKU belum ada (format data item: Kode Item).
--   harga_beli: harga per Biji, dicatat sebagai PRICELIST berlaku mulai p_tanggal_harga.
create or replace function public.import_produk(p_baris jsonb, p_simpan boolean default false,
                                                p_tanggal_harga date default current_date)
returns jsonb language plpgsql security invoker set search_path = public, mb as $$
declare
  v_err jsonb;
  v_ubah jsonb;
  v_pr_baru jsonb;
  n_jumlah int; n_baru int; n_ubah int; n_sama int; n_harga int; n_belum_lengkap int;
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  if jsonb_typeof(p_baris) is distinct from 'array' then raise exception 'Data import harus berupa daftar baris'; end if;
  if jsonb_array_length(p_baris) > 20000 then raise exception 'Maksimal 20.000 baris sekali import'; end if;

  -- 1. Periksa
  with d as (
    select b.*, p.sku is not null as ada,
           case when p.sku is null then coalesce(b.barcode, b.barcode_baru) else b.barcode end as bc
    from mb.baris_import(p_baris) b left join produk p on p.sku = b.sku
  ),
  w as (
    select d.*,
           count(*) over s as n_sku, string_agg(d.baris::text, ', ') over s as baris_sku,
           count(*) over c as n_bc, string_agg(d.baris::text, ', ') over c as baris_bc
    from d
    window s as (partition by d.sku order by d.baris rows between unbounded preceding and unbounded following),
           c as (partition by d.bc order by d.baris rows between unbounded preceding and unbounded following)
  ),
  e as (
    select baris, 'SKU kosong' as pesan from w where sku is null
    union all select baris, format('SKU %s ada di lebih dari satu baris (%s)', sku, baris_sku) from w where sku is not null and n_sku > 1
    union all select baris, 'Barang baru wajib ada nama' from w where sku is not null and not ada and nama is null
    union all select baris, format('Barcode %s ada di lebih dari satu baris (%s)', bc, baris_bc) from w where bc is not null and n_bc > 1
    union all select w.baris, format('Barcode %s sudah dipakai SKU %s', w.bc, p.sku)
              from w join produk p on p.barcode = w.bc and p.sku <> w.sku
    union all select baris, 'Harga jual tidak boleh minus' from w where harga_jual < 0
    union all select baris, 'Harga beli tidak boleh minus' from w where harga_beli < 0
    union all select baris, 'Isi per satuan masuk harus bilangan bulat 1 atau lebih' from w
              where rasio_isi is not null and (rasio_isi < 1 or rasio_isi <> trunc(rasio_isi))
    union all select baris, 'Isi dus principal harus bilangan bulat 1 atau lebih' from w
              where isi_dus is not null and (isi_dus < 1 or isi_dus <> trunc(isi_dus))
    union all select baris, 'Satuan masuk terlalu panjang (maks. 20 huruf)' from w where length(satuan_masuk) > 20
  )
  select coalesce(jsonb_agg(jsonb_build_object('baris', baris, 'pesan', pesan) order by baris, pesan), '[]') into v_err from e;

  -- 2. Hitung perubahan (sebelum disimpan)
  with d as (
    select b.*, p.sku is not null as ada,
           case when p.sku is null then coalesce(b.barcode, b.barcode_baru) else b.barcode end as bc,
           p.nama as o_nama, p.barcode as o_barcode, p.merk as o_merk, p.kategori as o_kategori,
           p.harga_jual_konsumen as o_harga, p.satuan_masuk as o_satuan, p.rasio_isi as o_rasio,
           opr.nama as o_principal, p.isi_dus as o_isi_dus, p.aktif as o_aktif, h.harga_beli_dasar as o_beli
    from mb.baris_import(p_baris) b
    left join produk p on p.sku = b.sku
    left join principal opr on opr.id = p.principal_id
    left join v_harga_produk h on h.sku = b.sku
    where b.sku is not null
  ),
  k as (
    select d.*, array_remove(array[
      case when ada and nama is not null and nama is distinct from o_nama then format('nama: %s → %s', o_nama, nama) end,
      case when ada and bc is not null and bc is distinct from o_barcode then format('barcode: %s → %s', coalesce(o_barcode, '-'), bc) end,
      case when ada and merk is not null and merk is distinct from o_merk then format('merk: %s → %s', coalesce(o_merk, '-'), merk) end,
      case when ada and kategori is not null and kategori is distinct from o_kategori
           then format('kategori: %s → %s', coalesce(o_kategori, '-'), kategori) end,
      case when ada and harga_jual is not null and harga_jual is distinct from o_harga
           then format('harga jual: %s → %s', coalesce(mb.ribuan(o_harga), '-'), mb.ribuan(harga_jual)) end,
      case when ada and satuan_masuk is not null and satuan_masuk is distinct from o_satuan
           then format('satuan masuk: %s → %s', o_satuan, satuan_masuk) end,
      case when ada and rasio_isi is not null and rasio_isi is distinct from o_rasio
           then format('isi per satuan masuk: %s → %s', o_rasio, mb.angka(rasio_isi, 0)) end,
      case when ada and principal is not null and lower(principal) is distinct from lower(o_principal)
           then format('principal: %s → %s', coalesce(o_principal, '-'), principal) end,
      case when ada and isi_dus is not null and isi_dus is distinct from o_isi_dus
           then format('isi dus principal: %s → %s', o_isi_dus, mb.angka(isi_dus, 0)) end,
      case when ada and aktif is not null and aktif is distinct from o_aktif
           then case when aktif then 'diaktifkan' else 'dinonaktifkan' end end,
      case when ada and harga_beli is not null and harga_beli is distinct from o_beli
           then format('harga beli: %s → %s', coalesce(mb.ribuan(o_beli), '-'), mb.ribuan(harga_beli)) end,
      -- Barang baru: ringkasan isinya
      case when not ada then concat_ws(' · ',
             case when harga_jual is not null then 'harga jual ' || mb.ribuan(harga_jual) end,
             format('1 %s = %s Biji', coalesce(satuan_masuk, 'Dus'), coalesce(rasio_isi, 1)),
             principal,
             case when harga_beli is not null then 'harga beli ' || mb.ribuan(harga_beli) end) end
    ], null) as detail
    from d
  )
  select count(*), count(*) filter (where not ada), count(*) filter (where ada and cardinality(detail) > 0),
         count(*) filter (where ada and cardinality(detail) = 0),
         count(*) filter (where harga_beli is not null and harga_beli is distinct from o_beli),
         count(*) filter (where coalesce(bc, o_barcode) is null or coalesce(harga_jual, o_harga) is null),
         coalesce((select jsonb_agg(jsonb_build_object('baris', x.baris, 'sku', x.sku, 'nama', coalesce(x.nama, x.o_nama),
                                                       'status', case when x.ada then 'UBAH' else 'BARU' end,
                                                       'detail', array_to_string(x.detail, '; ')) order by x.baris)
                   from (select * from k where not ada or cardinality(detail) > 0 order by baris limit 500) x), '[]')
    into n_jumlah, n_baru, n_ubah, n_sama, n_harga, n_belum_lengkap, v_ubah
  from k;

  select coalesce(jsonb_agg(nm order by nm), '[]') into v_pr_baru
  from (select min(b.principal) as nm from mb.baris_import(p_baris) b
        where b.principal is not null and b.sku is not null
          and not exists (select 1 from principal pr where lower(pr.nama) = lower(b.principal))
        group by lower(b.principal)) t;

  -- 3. Simpan
  if p_simpan and jsonb_array_length(v_err) = 0 then
    insert into principal (nama)
    select x from jsonb_array_elements_text(v_pr_baru) x;

    update produk p set
      nama = coalesce(d.nama, p.nama), barcode = coalesce(d.barcode, p.barcode), merk = coalesce(d.merk, p.merk),
      kategori = coalesce(d.kategori, p.kategori), harga_jual_konsumen = coalesce(d.harga_jual, p.harga_jual_konsumen),
      satuan_masuk = coalesce(d.satuan_masuk, p.satuan_masuk), rasio_isi = coalesce(d.rasio_isi::int, p.rasio_isi),
      principal_id = coalesce(d.pr_id, p.principal_id), isi_dus = coalesce(d.isi_dus::int, p.isi_dus), aktif = coalesce(d.aktif, p.aktif)
    from (select b.*, (select pr.id from principal pr where lower(pr.nama) = lower(b.principal) order by pr.id limit 1) as pr_id
          from mb.baris_import(p_baris) b) d
    where p.sku = d.sku
      and (p.nama, p.barcode, p.merk, p.kategori, p.harga_jual_konsumen, p.satuan_masuk, p.rasio_isi, p.principal_id, p.isi_dus, p.aktif)
          is distinct from
          (coalesce(d.nama, p.nama), coalesce(d.barcode, p.barcode), coalesce(d.merk, p.merk), coalesce(d.kategori, p.kategori),
           coalesce(d.harga_jual, p.harga_jual_konsumen), coalesce(d.satuan_masuk, p.satuan_masuk), coalesce(d.rasio_isi::int, p.rasio_isi),
           coalesce(d.pr_id, p.principal_id), coalesce(d.isi_dus::int, p.isi_dus), coalesce(d.aktif, p.aktif));

    insert into produk (sku, nama, barcode, merk, kategori, harga_jual_konsumen, satuan_masuk, rasio_isi, principal_id, isi_dus, aktif)
    select b.sku, b.nama, coalesce(b.barcode, b.barcode_baru), b.merk, b.kategori, b.harga_jual, coalesce(b.satuan_masuk, 'Dus'),
           coalesce(b.rasio_isi::int, 1), (select pr.id from principal pr where lower(pr.nama) = lower(b.principal) order by pr.id limit 1),
           coalesce(b.isi_dus::int, 1), coalesce(b.aktif, true)
    from mb.baris_import(p_baris) b
    where not exists (select 1 from produk p where p.sku = b.sku);

    -- Harga beli: dibandingkan dengan harga beli dasar sebelum import
    insert into harga_beli (sku, berlaku_at, harga, sumber, referensi)
    select b.sku, p_tanggal_harga, b.harga_beli, 'PRICELIST', 'Import Excel'
    from mb.baris_import(p_baris) b
    where b.harga_beli is not null
      and b.harga_beli is distinct from (
        select h.harga from harga_beli h where h.sku = b.sku
        order by h.berlaku_at desc, (h.sumber = 'PRICELIST') desc limit 1)
    on conflict (sku, berlaku_at, sumber) do update set harga = excluded.harga, referensi = excluded.referensi;
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_err) = 0,
    'disimpan', p_simpan and jsonb_array_length(v_err) = 0,
    'jumlah', n_jumlah, 'baru', n_baru, 'diubah', n_ubah, 'sama', n_sama, 'harga_beli', n_harga,
    'belum_lengkap', n_belum_lengkap, 'principal_baru', v_pr_baru,
    'jumlah_error', jsonb_array_length(v_err), 'error', jsonb_path_query_array(v_err, '$[0 to 199]'),
    'perubahan', v_ubah);
end $$;

revoke all on function public.import_produk(jsonb, boolean, date) from public, anon;
grant execute on function public.import_produk(jsonb, boolean, date) to authenticated, service_role;
