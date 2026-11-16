-- =====================================================================
-- Mother Base Trizone — fungsi untuk aplikasi web kantor dan asisten AI
--
-- Semua fungsi laporan berjalan dengan hak pemanggil (security invoker), jadi
-- Row Level Security tetap berlaku: pemilik toko hanya melihat tokonya sendiri,
-- juga saat bertanya lewat asisten AI.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Pengguna
-- ---------------------------------------------------------------------
-- Profil pengguna yang sedang login (dipakai aplikasi untuk menu & hak akses).
create or replace function public.saya() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'nama', p.nama, 'peran', p.peran, 'kode_toko', p.kode_toko,
                            'email', u.email, 'aktif', p.aktif)
  from pengguna p join auth.users u on u.id = p.id
  where p.id = auth.uid()
$$;

-- Owner pertama: jalankan sekali dari SQL Editor Supabase (bukan dari aplikasi).
create or replace function public.jadikan_owner(p_email text, p_nama text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if auth.uid() is not null then raise exception 'Jalankan dari SQL Editor Supabase'; end if;
  select id into v from auth.users where lower(email) = lower(btrim(p_email));
  if v is null then raise exception 'Akun % belum ada. Buat dulu di Authentication → Users → Add user.', p_email; end if;
  insert into pengguna (id, nama, peran, kode_toko, aktif) values (v, p_nama, 'owner', null, true)
  on conflict (id) do update set nama = excluded.nama, peran = 'owner', kode_toko = null, aktif = true;
  return v;
end $$;

-- Owner mengatur peran pengguna lain. Akun login dibuat dulu di Supabase (Authentication → Add user).
create or replace function public.atur_pengguna(p_email text, p_nama text, p_peran peran_pengguna,
                                                p_kode_toko char(3) default null, p_aktif boolean default true)
returns jsonb language plpgsql security definer set search_path = public, mb as $$
declare v uuid;
begin
  if mb.peran_saya() is distinct from 'owner' then raise exception 'Hanya owner yang boleh mengatur pengguna'; end if;
  select id into v from auth.users where lower(email) = lower(btrim(p_email));
  if v is null then
    raise exception 'Akun % belum ada. Buat dulu di Supabase: Authentication → Users → Add user.', p_email;
  end if;
  if v = auth.uid() and (p_peran <> 'owner' or not p_aktif) then
    raise exception 'Owner tidak bisa menurunkan atau menonaktifkan dirinya sendiri';
  end if;
  if (p_peran = 'pemilik_toko') <> (p_kode_toko is not null) then
    raise exception 'Kode toko wajib diisi untuk pemilik toko, dan hanya untuk pemilik toko';
  end if;
  insert into pengguna (id, nama, peran, kode_toko, aktif) values (v, btrim(p_nama), p_peran, p_kode_toko, p_aktif)
  on conflict (id) do update set nama = excluded.nama, peran = excluded.peran, kode_toko = excluded.kode_toko, aktif = excluded.aktif;
  return jsonb_build_object('id', v, 'email', p_email);
end $$;

create or replace function public.daftar_pengguna()
returns table(id uuid, email text, nama text, peran peran_pengguna, kode_toko char(3), aktif boolean)
language sql stable security definer set search_path = public, mb as $$
  select p.id, u.email::text, p.nama, p.peran, p.kode_toko, p.aktif
  from pengguna p join auth.users u on u.id = p.id
  where mb.peran_saya() = 'owner'
  order by p.peran, p.nama
$$;

-- Pengaturan (mis. markup harga jual ke toko): kantor membaca, hanya owner yang mengubah.
create policy owner_tulis_pengaturan on pengaturan for all to authenticated
  using ((select mb.peran_saya()) = 'owner') with check ((select mb.peran_saya()) = 'owner');

-- ---------------------------------------------------------------------
-- 2. Toko
-- ---------------------------------------------------------------------
-- Status koneksi tiap toko (tanpa kunci).
create or replace function public.status_koneksi_toko()
returns table(kode char(3), nama text, kota text, aktif boolean, batas_hari_sj int, punya_kunci boolean,
              kunci_dibuat_at timestamptz, versi_trizone text, kiriman_terakhir_at timestamptz,
              snapshot_terakhir_at timestamptz, shift_terakhir_at timestamptz)
language sql stable security definer set search_path = public, mb as $$
  select t.kode, t.nama, t.kota, t.aktif, t.batas_hari_sj, k.kode_toko is not null, k.dibuat_at,
         s.versi_trizone, s.kiriman_terakhir_at, s.snapshot_terakhir_at, s.shift_terakhir_at
  from toko t
  left join toko_kunci k on k.kode_toko = t.kode
  left join toko_status s on s.kode_toko = t.kode
  where mb.boleh_lihat_toko(t.kode)
  order by t.kode
$$;

-- ---------------------------------------------------------------------
-- 3. Laporan (dipakai halaman aplikasi dan asisten AI)
-- ---------------------------------------------------------------------
create or replace function public.laporan_ringkasan(p_dari date, p_sampai date)
returns table(kode_toko char(3), omzet numeric, jumlah_transaksi bigint, qty numeric,
              tunai numeric, qris numeric, transfer numeric, hari_berjualan bigint)
language sql stable security invoker set search_path = public, mb as $$
  select kode_toko, sum(omzet), sum(jumlah_transaksi)::bigint, sum(qty),
         coalesce(sum(tunai),0), coalesce(sum(qris),0), coalesce(sum(transfer),0), count(distinct tanggal)
  from v_ringkasan_harian
  where tanggal between p_dari and p_sampai
  group by kode_toko order by kode_toko
$$;

create or replace function public.laporan_harian(p_dari date, p_sampai date, p_kode_toko char(3) default null)
returns table(tanggal date, omzet numeric, jumlah_transaksi bigint)
language sql stable security invoker set search_path = public, mb as $$
  select tanggal, sum(omzet), sum(jumlah_transaksi)::bigint
  from v_ringkasan_harian
  where tanggal between p_dari and p_sampai and (p_kode_toko is null or kode_toko = p_kode_toko)
  group by tanggal order by tanggal
$$;

create or replace function public.laporan_penjualan_produk(p_dari date, p_sampai date, p_kode_toko char(3) default null,
                                                           p_urut text default 'nilai', p_batas int default 100)
returns table(sku text, nama text, qty numeric, nilai numeric, jumlah_toko bigint)
language sql stable security invoker set search_path = public, mb as $$
  select p.sku, max(p.nama), sum(p.qty), sum(p.subtotal), count(distinct p.kode_toko)
  from penjualan p
  where p.tanggal between p_dari and p_sampai and (p_kode_toko is null or p.kode_toko = p_kode_toko)
  group by p.sku
  order by case when p_urut = 'qty' then sum(p.qty) else sum(p.subtotal) end desc nulls last
  limit least(greatest(coalesce(p_batas, 100), 1), 1000)
$$;

-- Perbandingan dua periode per produk (naik / turun).
create or replace function public.laporan_tren_produk(p_dari date, p_sampai date, p_dari_banding date, p_sampai_banding date,
                                                      p_kode_toko char(3) default null, p_batas int default 30)
returns table(sku text, nama text, qty_periode numeric, qty_banding numeric, selisih numeric, persen numeric)
language sql stable security invoker set search_path = public, mb as $$
  with a as (
    select sku, max(nama) nama, sum(qty) qty from penjualan
    where tanggal between p_dari and p_sampai and (p_kode_toko is null or kode_toko = p_kode_toko) group by sku
  ), b as (
    select sku, max(nama) nama, sum(qty) qty from penjualan
    where tanggal between p_dari_banding and p_sampai_banding and (p_kode_toko is null or kode_toko = p_kode_toko) group by sku
  )
  select coalesce(a.sku, b.sku), coalesce(a.nama, b.nama), coalesce(a.qty, 0), coalesce(b.qty, 0),
         coalesce(a.qty, 0) - coalesce(b.qty, 0),
         case when coalesce(b.qty, 0) = 0 then null else round((coalesce(a.qty,0) - b.qty) / b.qty * 100, 1) end
  from a full join b on a.sku = b.sku
  order by abs(coalesce(a.qty, 0) - coalesce(b.qty, 0)) desc
  limit least(greatest(coalesce(p_batas, 30), 1), 500)
$$;

-- Analisa ABC: kelas A = produk penyumbang 80% omzet pertama, B = 15% berikutnya, C = sisanya.
create or replace function public.laporan_abc(p_dari date, p_sampai date, p_kode_toko char(3) default null)
returns table(sku text, nama text, nilai numeric, persen numeric, persen_kumulatif numeric, kelas text)
language sql stable security invoker set search_path = public, mb as $$
  with j as (
    select sku, max(nama) nama, sum(subtotal) nilai from penjualan
    where tanggal between p_dari and p_sampai and (p_kode_toko is null or kode_toko = p_kode_toko)
    group by sku having sum(subtotal) > 0
  ), k as (
    select *, nilai / sum(nilai) over () * 100 as persen,
           sum(nilai) over (order by nilai desc, sku) / sum(nilai) over () * 100 as kum
    from j
  )
  select sku, nama, nilai, round(persen, 2), round(kum, 2),
         case when kum - persen < 80 then 'A' when kum - persen < 95 then 'B' else 'C' end
  from k order by nilai desc
$$;

-- Produk tanpa penjualan dalam N hari tetapi masih ada stok (dead / slow stock).
create or replace function public.laporan_stok_lambat(p_hari int default 30, p_kode_toko char(3) default null, p_batas int default 100)
returns table(kode_toko char(3), sku text, nama text, stok numeric, terakhir_terjual date)
language sql stable security invoker set search_path = public, mb as $$
  select s.kode_toko, s.sku, pt.nama, s.display + s.gudang + s.shopee,
         (select max(tanggal) from penjualan p where p.kode_toko = s.kode_toko and p.sku = s.sku)
  from stok_toko s
  left join produk_toko pt on pt.kode_toko = s.kode_toko and pt.sku = s.sku
  where (p_kode_toko is null or s.kode_toko = p_kode_toko)
    and s.display + s.gudang + s.shopee > 0
    and not exists (select 1 from penjualan p where p.kode_toko = s.kode_toko and p.sku = s.sku
                    and p.tanggal > current_date - greatest(coalesce(p_hari, 30), 1))
  order by s.display + s.gudang + s.shopee desc
  limit least(greatest(coalesce(p_batas, 100), 1), 1000)
$$;

create or replace function public.laporan_stok_produk(p_cari text default null, p_kode_toko char(3) default null, p_batas int default 200)
returns table(kode_toko char(3), sku text, nama text, display numeric, gudang numeric, bs numeric, shopee numeric,
              min_display numeric, per_waktu timestamptz)
language sql stable security invoker set search_path = public, mb as $$
  select s.kode_toko, s.sku, pt.nama, s.display, s.gudang, s.bs, s.shopee, s.min_display, s.per_waktu
  from stok_toko s
  left join produk_toko pt on pt.kode_toko = s.kode_toko and pt.sku = s.sku
  where (p_kode_toko is null or s.kode_toko = p_kode_toko)
    and (coalesce(p_cari, '') = '' or s.sku ilike '%' || p_cari || '%' or pt.nama ilike '%' || p_cari || '%'
         or pt.barcode = p_cari)
  order by pt.nama, s.kode_toko
  limit least(greatest(coalesce(p_batas, 200), 1), 2000)
$$;

create or replace function public.laporan_usulan_beli(p_principal_id bigint default null)
returns setof v_usulan_beli language sql stable security invoker set search_path = public, mb as $$
  select * from v_usulan_beli
  where (p_principal_id is null or principal_id = p_principal_id) and usulan_qty > 0
  order by principal, nama
$$;

create or replace function public.laporan_status_sj(p_status text default null, p_kode_toko char(3) default null, p_batas int default 100)
returns setof v_pencocokan_sj language sql stable security invoker set search_path = public, mb as $$
  select * from v_pencocokan_sj
  where (p_status is null or status = p_status) and (p_kode_toko is null or kode_toko = p_kode_toko)
  order by tanggal_kirim desc, no_sj
  limit least(greatest(coalesce(p_batas, 100), 1), 1000)
$$;

create or replace function public.laporan_selisih_so(p_status text default 'BARU', p_kode_toko char(3) default null, p_batas int default 200)
returns setof v_selisih_so language sql stable security invoker set search_path = public, mb as $$
  select * from v_selisih_so
  where (p_status is null or status::text = p_status) and (p_kode_toko is null or kode_toko = p_kode_toko)
    and selisih <> 0
  order by abs(coalesce(nilai_selisih, selisih)) desc
  limit least(greatest(coalesce(p_batas, 200), 1), 2000)
$$;

-- Perbandingan baris surat jalan (dalam Biji) dengan penerimaan toko.
create or replace view v_sj_banding with (security_invoker = true) as
with kirim as (
  select no_sj, kode_toko, coalesce(sku, kode) as sku, max(nama) as nama, sum(qty) as qty, max(satuan) as satuan,
         sum(qty_biji) as qty_biji
  from v_sj_baris_biji group by no_sj, kode_toko, coalesce(sku, kode)
),
terima as (
  select b.kode_toko, b.no_sj, b.sku, sum(b.qty) as qty
  from penerimaan_toko_baris b
  join surat_jalan sj on sj.no_sj = b.no_sj
  join pelanggan_accurate pa on pa.nama = sj.pelanggan and pa.kode_toko = b.kode_toko
  group by b.kode_toko, b.no_sj, b.sku
)
select coalesce(k.no_sj, t.no_sj) as no_sj, coalesce(k.sku, t.sku) as sku,
       coalesce(k.nama, (select nama from produk_toko p where p.kode_toko = t.kode_toko and p.sku = t.sku)) as nama,
       k.qty as qty_kirim, k.satuan, k.qty_biji as kirim_biji, t.qty as terima_biji,
       coalesce(t.qty, 0) - coalesce(k.qty_biji, 0) as selisih_biji
from kirim k full join terima t on t.no_sj = k.no_sj and t.sku = k.sku;

-- ---------------------------------------------------------------------
-- 4. Stock opname
-- ---------------------------------------------------------------------
create or replace function public.review_so(p_kode_toko char(3), p_no_op text, p_status status_dokumen, p_catatan text default null)
returns void language plpgsql security invoker set search_path = public, mb as $$
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  update stok_opname_review set status = p_status, catatan = p_catatan, direview_oleh = auth.uid(), direview_at = now()
  where kode_toko = p_kode_toko and no_op = p_no_op;
  if not found then raise exception 'Stok opname % di % tidak ditemukan', p_no_op, p_kode_toko; end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Principal & pembelian
-- ---------------------------------------------------------------------
-- Dipakai halaman Principal dan wawancara AI. Hanya field yang diisi yang diubah.
create or replace function public.simpan_data_principal(p_id bigint, p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, mb as $$
declare r principal;
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  update principal set
    lead_time_hari     = coalesce((p->>'lead_time_hari')::int, lead_time_hari),
    periode_order_hari = coalesce((p->>'periode_order_hari')::int, periode_order_hari),
    jadwal_order       = coalesce(p->>'jadwal_order', jadwal_order),
    minimum_order_qty  = coalesce((p->>'minimum_order_qty')::int, minimum_order_qty),
    minimum_order_rp   = coalesce((p->>'minimum_order_rp')::numeric, minimum_order_rp),
    stok_pengaman_hari = coalesce((p->>'stok_pengaman_hari')::int, stok_pengaman_hari),
    catatan_promo      = coalesce(p->>'catatan_promo', catatan_promo),
    diwawancara_at     = case when coalesce((p->>'selesai_wawancara')::boolean, false) then now() else diwawancara_at end
  where id = p_id
  returning * into r;
  if r.id is null then raise exception 'Principal % tidak ditemukan', p_id; end if;
  return to_jsonb(r);
end $$;

-- Lead time sebenarnya per principal (tanggal PO sampai penerimaan pertama).
create or replace view v_lead_time_aktual with (security_invoker = true) as
select po.principal_id, pr.nama as principal, count(*) as jumlah_po,
       round(avg(t.tanggal - po.tanggal), 1) as rata_hari, min(t.tanggal - po.tanggal) as min_hari,
       max(t.tanggal - po.tanggal) as max_hari, pr.lead_time_hari as perkiraan_hari
from po
join principal pr on pr.id = po.principal_id
join lateral (select min(tanggal) as tanggal from penerimaan_principal pp where pp.no_po = po.no_po) t on t.tanggal is not null
group by po.principal_id, pr.nama, pr.lead_time_hari;

create or replace function public.laporan_principal()
returns table(id bigint, nama text, lead_time_hari int, lead_time_aktual numeric, periode_order_hari int, jadwal_order text,
              minimum_order_qty int, minimum_order_rp numeric, stok_pengaman_hari int, catatan_promo text,
              diwawancara_at timestamptz, jumlah_produk bigint)
language sql stable security invoker set search_path = public, mb as $$
  select pr.id, pr.nama, pr.lead_time_hari, la.rata_hari, pr.periode_order_hari, pr.jadwal_order, pr.minimum_order_qty,
         pr.minimum_order_rp, pr.stok_pengaman_hari, pr.catatan_promo, pr.diwawancara_at,
         (select count(*) from produk p where p.principal_id = pr.id and p.aktif)
  from principal pr left join v_lead_time_aktual la on la.principal_id = pr.id
  where pr.aktif order by pr.nama
$$;

-- Angka untuk teks: tanpa nol di belakang koma, koma desimal (24.000 → 24, 16.54 → 16,5).
create or replace function mb.angka(x numeric, d int default 1) returns text
language sql immutable set search_path = '' as $$ select replace(trim_scale(round(x, d))::text, '.', ',') $$;

-- Membuat usulan PO dari v_usulan_beli untuk satu principal, dengan alasan per baris.
create or replace function public.buat_po_dari_usulan(p_principal_id bigint) returns text
language plpgsql security invoker set search_path = public, mb as $$
declare
  v_no text;
  n int;
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  select 'PO-' || to_char(current_date, 'YYYYMMDD') || '-' ||
         lpad((count(*) + 1)::text, 3, '0') into v_no
  from po where no_po like 'PO-' || to_char(current_date, 'YYYYMMDD') || '-%';
  insert into po (no_po, principal_id, dibuat_oleh) values (v_no, p_principal_id, auth.uid());
  insert into po_baris (no_po, sku, qty_usulan, qty_disetujui, harga, alasan)
  select v_no, u.sku, u.usulan_qty, u.usulan_qty, h.harga_beli_dasar,
         format('Rata-rata %s/hari × (lead time %s + periode %s hari) + pengaman %s − stok gudang %s − stok toko %s − PO jalan %s = %s; dibulatkan ke isi dus %s%s',
                mb.angka(u.rata_harian), u.lead_time, u.periode_order, mb.angka(u.stok_pengaman), mb.angka(u.stok_gudang, 0),
                mb.angka(u.stok_toko, 0), mb.angka(u.po_belum_datang, 0), mb.angka(u.kebutuhan), u.isi_dus,
                case when u.usulan_qty = u.minimum_order_qty and u.minimum_order_qty > 0 then ' (naik ke minimum order)' else '' end)
  from v_usulan_beli u left join v_harga_produk h using (sku)
  where u.principal_id = p_principal_id and u.usulan_qty > 0;
  get diagnostics n = row_count;
  if n = 0 then
    delete from po where no_po = v_no;
    raise exception 'Tidak ada barang yang perlu dibeli dari principal ini saat ini';
  end if;
  return v_no;
end $$;

-- Owner menyetujui PO, boleh mengubah qty per baris. p = [{sku, qty}]
create or replace function public.setujui_po(p_no_po text, p jsonb default '[]') returns void
language plpgsql security invoker set search_path = public, mb as $$
begin
  if mb.peran_saya() is distinct from 'owner' then raise exception 'Hanya owner yang boleh menyetujui PO'; end if;
  update po_baris b set qty_disetujui = (x->>'qty')::numeric
  from jsonb_array_elements(coalesce(p, '[]')) x
  where b.no_po = p_no_po and b.sku = x->>'sku';
  update po set status = 'DISETUJUI' where no_po = p_no_po and status = 'USULAN';
  if not found then raise exception 'PO % tidak ditemukan atau bukan berstatus usulan', p_no_po; end if;
end $$;

create or replace function public.ubah_status_po(p_no_po text, p_status status_po, p_no_po_accurate text default null)
returns void language plpgsql security invoker set search_path = public, mb as $$
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  if p_status not in ('DIKIRIM', 'BATAL') then raise exception 'Status hanya bisa diubah ke DIKIRIM atau BATAL di sini'; end if;
  update po set status = p_status, no_po_accurate = coalesce(p_no_po_accurate, no_po_accurate)
  where no_po = p_no_po and status in ('USULAN', 'DISETUJUI', 'DIKIRIM');
  if not found then raise exception 'PO % tidak bisa diubah', p_no_po; end if;
end $$;

-- Barang dari principal diterima di gudang kantor: stok gudang bertambah, harga beli diperbarui.
-- p = [{sku, qty, harga}]
create or replace function public.terima_po(p_no_po text, p_no_terima text, p_tanggal date, p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, mb as $$
declare
  v_sisa numeric;
begin
  if not mb.is_kantor() and auth.uid() is not null then raise exception 'Hanya pengguna kantor'; end if;
  if not exists (select 1 from po where no_po = p_no_po and status in ('DISETUJUI', 'DIKIRIM', 'SEBAGIAN')) then
    raise exception 'PO % belum disetujui atau sudah selesai', p_no_po;
  end if;
  insert into penerimaan_principal (no_terima, no_po, tanggal, dicatat_oleh) values (p_no_terima, p_no_po, p_tanggal, auth.uid());
  insert into penerimaan_principal_baris (no_terima, sku, qty, harga)
  select p_no_terima, x->>'sku', (x->>'qty')::numeric, nullif(x->>'harga', '')::numeric
  from jsonb_array_elements(p) x where (x->>'qty')::numeric > 0;
  insert into gudang_mutasi (waktu, jenis, sku, qty, referensi, dicatat_oleh)
  select p_tanggal::timestamptz, 'TERIMA_PRINCIPAL', sku, qty, p_no_terima, auth.uid()
  from penerimaan_principal_baris where no_terima = p_no_terima;
  insert into harga_beli (sku, berlaku_at, harga, sumber, referensi)
  select sku, p_tanggal, harga, 'PEMBELIAN', p_no_po from penerimaan_principal_baris
  where no_terima = p_no_terima and harga is not null
  on conflict (sku, berlaku_at, sumber) do update set harga = excluded.harga, referensi = excluded.referensi;
  select coalesce(sum(qty), 0) into v_sisa from v_po_belum_datang v
  where v.sku in (select sku from po_baris where no_po = p_no_po);
  update po set status = case when not exists (
      select 1 from po_baris b where b.no_po = p_no_po
        and coalesce(b.qty_disetujui, b.qty_usulan) > coalesce((select sum(pb.qty) from penerimaan_principal pp
              join penerimaan_principal_baris pb using (no_terima) where pp.no_po = p_no_po and pb.sku = b.sku), 0))
    then 'SELESAI'::status_po else 'SEBAGIAN'::status_po end
  where no_po = p_no_po;
  return jsonb_build_object('no_terima', p_no_terima, 'status', (select status from po where no_po = p_no_po));
end $$;

-- ---------------------------------------------------------------------
-- 6. Asisten AI
-- ---------------------------------------------------------------------
create table ai_percakapan (
  id          uuid primary key default gen_random_uuid(),
  pengguna    uuid not null default auth.uid() references pengguna(id) on delete cascade,
  mode        text not null default 'tanya' check (mode in ('tanya', 'wawancara')),
  principal_id bigint references principal(id),
  judul       text,
  pesan       jsonb not null default '[]',      -- riwayat lengkap untuk Claude (termasuk blok alat)
  dibuat_at   timestamptz not null default now(),
  diubah_at   timestamptz not null default now()
);
create index on ai_percakapan (pengguna, diubah_at desc);
create index on ai_percakapan (principal_id);
alter table ai_percakapan enable row level security;
create policy milik_sendiri on ai_percakapan for all to authenticated
  using (pengguna = (select auth.uid()))
  with check (pengguna = (select auth.uid()) and (select mb.peran_saya()) is not null);
create trigger ai_percakapan_diubah before update on ai_percakapan for each row execute function mb.set_diubah_at();

-- ---------------------------------------------------------------------
-- 7. Hak akses fungsi
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'saya()', 'atur_pengguna(text, text, peran_pengguna, char, boolean)', 'daftar_pengguna()', 'status_koneksi_toko()',
    'laporan_ringkasan(date, date)', 'laporan_harian(date, date, char)', 'laporan_penjualan_produk(date, date, char, text, int)',
    'laporan_tren_produk(date, date, date, date, char, int)', 'laporan_abc(date, date, char)',
    'laporan_stok_lambat(int, char, int)', 'laporan_stok_produk(text, char, int)',
    'laporan_usulan_beli(bigint)', 'laporan_status_sj(text, char, int)', 'laporan_selisih_so(text, char, int)', 'laporan_principal()',
    'review_so(char, text, status_dokumen, text)', 'simpan_data_principal(bigint, jsonb)', 'buat_po_dari_usulan(bigint)',
    'setujui_po(text, jsonb)', 'ubah_status_po(text, status_po, text)', 'terima_po(text, text, date, jsonb)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.jadikan_owner(text, text) from public, anon, authenticated;
