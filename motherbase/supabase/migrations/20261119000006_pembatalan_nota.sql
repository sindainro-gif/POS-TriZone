-- =====================================================================
-- Mother Base Trizone — rincian batal nota dari toko
--
-- Batal nota di Trizone tidak menghapus nota asli: Trizone membuat nota baru BTL-YYYYMMDD-NNNN
-- berisi baris minus (sudah masuk tabel penjualan, jadi omzet kantor bersih). Rinciannya —
-- nota asal, alasan, yang meminta, dan yang menyetujui dengan PIN — sekarang ikut dikirim
-- per shift sebagai daftar "pembatalan" dan disimpan di pembatalan_nota.
--
-- Di laporan penjualan, nota BTL- tidak dihitung sebagai transaksi (sama seperti di Trizone);
-- nilainya tampil terpisah sebagai Pembatalan.
-- =====================================================================

create table pembatalan_nota (
  kode_toko       char(3) not null,
  shift_uid       text not null,
  no_batal        text not null,            -- BTL-YYYYMMDD-NNNN
  no_struk_asal   text,                     -- nota yang dibatalkan (tetap ada di penjualan)
  waktu           timestamptz not null,     -- waktu pembatalan
  tanggal         date not null,
  alasan          text,
  diminta_oleh    text,
  disetujui_oleh  text,                     -- yang memasukkan PIN persetujuan di toko (Admin)
  total           numeric(14,2) not null,   -- nilai nota asal (positif)
  primary key (kode_toko, shift_uid, no_batal),
  foreign key (kode_toko, shift_uid) references shift(kode_toko, shift_uid) on delete cascade
);
create index on pembatalan_nota (tanggal, kode_toko);

-- Sama seperti penjualan: kantor melihat semua, pemilik toko hanya tokonya. Ditulis lewat terima_data.
alter table pembatalan_nota enable row level security;
create policy baca_per_toko on pembatalan_nota for select to authenticated
  using ((select mb.is_kantor()) or kode_toko = (select mb.toko_saya()));

-- ---------------------------------------------------------------------
-- Penjualan satu shift + rincian pembatalannya (sh->'pembatalan').
-- Sama seperti penjualan, data shift yang lebih baru mengganti rincian pembatalan shift itu.
-- Kiriman tanpa daftar pembatalan (Trizone versi lama) tidak menghapus rincian yang sudah ada.
-- ---------------------------------------------------------------------
create or replace function mb.terapkan_shift(p_kode char(3), sh jsonb, sales jsonb, p_at timestamptz)
returns boolean language plpgsql set search_path = public, mb as $$
declare
  v_ada   timestamptz;
  v_tutup timestamptz;
begin
  select data_at, tutup_at into v_ada, v_tutup from shift where kode_toko = p_kode and shift_uid = sh->>'shift_uid';
  if v_ada is not null and v_ada > p_at then return false; end if;
  -- Potongan shift berjalan tidak boleh membuka lagi shift yang sudah tertutup.
  if v_tutup is not null and sh->>'closed_at' is null then return false; end if;

  insert into shift as s (kode_toko, shift_uid, kasir, mulai_at, tutup_at, catatan, jumlah_struk, qty, omzet,
                          tunai, per_metode, struk_darurat, data_at)
  with l as (select x from jsonb_array_elements(coalesce(sales,'[]')) x)
  select p_kode, sh->>'shift_uid', sh->>'cashier_name', mb.wib(sh->>'shift_start'), mb.wib(sh->>'closed_at'),
         coalesce(sh->>'notes',''),
         coalesce((sh->>'receipts')::int, (select count(distinct x->>'receipt_no') from l where x->>'receipt_no' not like 'BTL-%')),
         coalesce((sh->>'qty')::numeric, (select coalesce(sum((x->>'qty')::numeric),0) from l)),
         coalesce((sh->>'revenue')::numeric, (select coalesce(sum((x->>'line_total')::numeric),0) from l)),
         coalesce((sh->>'cash_sales')::numeric,
                  (select coalesce(sum((x->>'line_total')::numeric),0) from l where x->>'payment_method' = 'Tunai')),
         sh->'by_method', coalesce((sh->>'offline_receipts')::int, 0), p_at
  on conflict (kode_toko, shift_uid) do update set
    kasir = excluded.kasir, mulai_at = excluded.mulai_at, tutup_at = excluded.tutup_at, catatan = excluded.catatan,
    jumlah_struk = excluded.jumlah_struk, qty = excluded.qty, omzet = excluded.omzet, tunai = excluded.tunai,
    per_metode = excluded.per_metode, struk_darurat = excluded.struk_darurat, data_at = excluded.data_at;

  delete from penjualan where kode_toko = p_kode and shift_uid = sh->>'shift_uid';
  insert into penjualan (kode_toko, shift_uid, no_struk, baris_ke, waktu, tanggal, sku, nama, qty, harga, subtotal, metode_bayar)
  select p_kode, sh->>'shift_uid', x->>'receipt_no', coalesce((x->>'line_no')::int, o::int),
         mb.wib(x->>'created_at'), mb.tgl_wib(mb.wib(x->>'created_at')),
         x->>'sku', x->>'product_name', (x->>'qty')::numeric, (x->>'unit_price')::numeric,
         (x->>'line_total')::numeric, x->>'payment_method'
  from jsonb_array_elements(coalesce(sales,'[]')) with ordinality t(x, o)
  on conflict (kode_toko, shift_uid, no_struk, baris_ke) do update
    set qty = excluded.qty, subtotal = excluded.subtotal;

  if jsonb_typeof(sh->'pembatalan') = 'array' then
    delete from pembatalan_nota where kode_toko = p_kode and shift_uid = sh->>'shift_uid';
    insert into pembatalan_nota (kode_toko, shift_uid, no_batal, no_struk_asal, waktu, tanggal, alasan, diminta_oleh,
                                 disetujui_oleh, total)
    select p_kode, sh->>'shift_uid', x->>'void_no', nullif(x->>'receipt_no',''), w.waktu, mb.tgl_wib(w.waktu),
           x->>'reason', x->>'requested_by', x->>'approved_by', coalesce((x->>'total')::numeric, 0)
    from jsonb_array_elements(sh->'pembatalan') x
    cross join lateral (select coalesce(mb.wib(x->>'created_at'), p_at) as waktu) w
    where coalesce(x->>'void_no','') <> ''
    on conflict (kode_toko, shift_uid, no_batal) do update set
      no_struk_asal = excluded.no_struk_asal, waktu = excluded.waktu, tanggal = excluded.tanggal, alasan = excluded.alasan,
      diminta_oleh = excluded.diminta_oleh, disetujui_oleh = excluded.disetujui_oleh, total = excluded.total;
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- terima_data: daftar "pembatalan" per shift diteruskan ke terapkan_shift.
-- Shift berjalan (snapshot.current_shift) membawa daftar pembatalan di dalam objeknya sendiri.
-- Protokol v1 (tambahan, kompatibel dengan Trizone lama):
--   shifts: [{ shift: {...}, sales: [...],
--              pembatalan: [{void_no, receipt_no, reason, requested_by, approved_by, total, created_at}] }]
-- ---------------------------------------------------------------------
create or replace function public.terima_data(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, mb as $$
declare
  v_kode   char(3);
  v_shift  jsonb;
  v_sh     jsonb;
  v_uids   text[] := '{}';
  v_lama   int := 0;
  v_batal  int := 0;
  v_dok    jsonb := '{}';
  v_snap   boolean := null;
  v_closed timestamptz;
begin
  v_kode := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
  if coalesce((p->>'protokol')::int, 0) <> 1 then
    raise exception 'Versi protokol % tidak dikenal mother base (perbarui mother base).', p->>'protokol';
  end if;

  for v_shift in select x from jsonb_array_elements(coalesce(p->'shifts','[]')) x loop
    if v_shift->'shift'->>'shift_uid' is null or v_shift->'shift'->>'closed_at' is null then
      raise exception 'Data shift tanpa shift_uid atau closed_at';
    end if;
    v_sh := v_shift->'shift';
    if jsonb_typeof(v_shift->'pembatalan') = 'array' then
      v_sh := v_sh || jsonb_build_object('pembatalan', v_shift->'pembatalan');
      v_batal := v_batal + jsonb_array_length(v_shift->'pembatalan');
    end if;
    v_closed := mb.wib(v_sh->>'closed_at');
    if not mb.terapkan_shift(v_kode, v_sh, v_shift->'sales', v_closed) then v_lama := v_lama + 1; end if;
    v_uids := v_uids || (v_sh->>'shift_uid');
  end loop;

  if p->'dokumen' is not null then v_dok := mb.terapkan_dokumen(v_kode, p->'dokumen'); end if;
  if jsonb_typeof(p->'snapshot') = 'object' then v_snap := mb.terapkan_snapshot(v_kode, p->'snapshot'); end if;

  insert into toko_status as s (kode_toko, versi_trizone, kiriman_terakhir_at, snapshot_terakhir_at, shift_terakhir_at)
  values (v_kode, p->>'app_version', now(),
          case when v_snap then mb.wib(p->'snapshot'->>'created_at') end,
          (select max(mb.wib(x->'shift'->>'closed_at')) from jsonb_array_elements(coalesce(p->'shifts','[]')) x))
  on conflict (kode_toko) do update set
    versi_trizone        = coalesce(excluded.versi_trizone, s.versi_trizone),
    kiriman_terakhir_at  = now(),
    snapshot_terakhir_at = greatest(s.snapshot_terakhir_at, excluded.snapshot_terakhir_at),
    shift_terakhir_at    = greatest(s.shift_terakhir_at, excluded.shift_terakhir_at);

  insert into kiriman_log (kode_toko, versi_trizone, dikirim_at, jumlah)
  values (v_kode, p->>'app_version', mb.wib(p->>'dikirim_at'),
          jsonb_build_object('shift', jsonb_array_length(coalesce(p->'shifts','[]')), 'shift_lama', v_lama,
                             'pembatalan', v_batal, 'snapshot', v_snap) || v_dok);

  return jsonb_build_object('ok', true, 'kode_toko', v_kode, 'shift_diterima', to_jsonb(v_uids),
                            'snapshot', v_snap, 'dokumen', v_dok, 'server_at', now());
end $$;
revoke all on function public.terima_data(jsonb) from public, authenticated;
grant execute on function public.terima_data(jsonb) to anon, service_role;

-- ---------------------------------------------------------------------
-- Laporan penjualan: nota BTL- = Pembatalan, bukan transaksi.
-- Omzet tetap bersih (sudah dikurangi pembatalan). pembatalan = nilai nota yang dibatalkan (positif).
-- ---------------------------------------------------------------------
create or replace view v_ringkasan_harian with (security_invoker = true) as
select kode_toko, tanggal,
       sum(subtotal) as omzet,
       count(distinct no_struk) filter (where no_struk not like 'BTL-%')          as jumlah_transaksi,
       sum(qty) as qty,
       sum(subtotal) filter (where mb.kelompok_metode(metode_bayar) = 'TUNAI')    as tunai,
       sum(subtotal) filter (where mb.kelompok_metode(metode_bayar) = 'QRIS')     as qris,
       sum(subtotal) filter (where mb.kelompok_metode(metode_bayar) = 'TRANSFER') as transfer,
       count(distinct no_struk) filter (where no_struk like 'OFF-%')              as struk_darurat,
       coalesce(-sum(subtotal) filter (where no_struk like 'BTL-%'), 0)           as pembatalan,
       count(distinct no_struk) filter (where no_struk like 'BTL-%')              as jumlah_pembatalan
from penjualan group by kode_toko, tanggal;

create or replace view v_penjualan_kasir with (security_invoker = true) as
select p.kode_toko, p.tanggal, s.kasir, mb.kelompok_metode(p.metode_bayar) as metode,
       sum(p.subtotal) as nilai,
       count(distinct p.no_struk) filter (where p.no_struk not like 'BTL-%') as jumlah_struk,
       coalesce(-sum(p.subtotal) filter (where p.no_struk like 'BTL-%'), 0) as pembatalan,
       count(distinct p.no_struk) filter (where p.no_struk like 'BTL-%')    as jumlah_pembatalan
from penjualan p join shift s using (kode_toko, shift_uid)
group by p.kode_toko, p.tanggal, s.kasir, mb.kelompok_metode(p.metode_bayar);

drop function if exists public.laporan_ringkasan(date, date);
create function public.laporan_ringkasan(p_dari date, p_sampai date)
returns table(kode_toko char(3), omzet numeric, jumlah_transaksi bigint, qty numeric,
              tunai numeric, qris numeric, transfer numeric, hari_berjualan bigint,
              pembatalan numeric, jumlah_pembatalan bigint)
language sql stable security invoker set search_path = public, mb as $$
  select kode_toko, sum(omzet), sum(jumlah_transaksi)::bigint, sum(qty),
         coalesce(sum(tunai),0), coalesce(sum(qris),0), coalesce(sum(transfer),0), count(distinct tanggal),
         coalesce(sum(pembatalan),0), sum(jumlah_pembatalan)::bigint
  from v_ringkasan_harian
  where tanggal between p_dari and p_sampai
  group by kode_toko order by kode_toko
$$;

drop function if exists public.laporan_harian(date, date, char);
create function public.laporan_harian(p_dari date, p_sampai date, p_kode_toko char(3) default null)
returns table(tanggal date, omzet numeric, jumlah_transaksi bigint, pembatalan numeric, jumlah_pembatalan bigint)
language sql stable security invoker set search_path = public, mb as $$
  select tanggal, sum(omzet), sum(jumlah_transaksi)::bigint, coalesce(sum(pembatalan),0), sum(jumlah_pembatalan)::bigint
  from v_ringkasan_harian
  where tanggal between p_dari and p_sampai and (p_kode_toko is null or kode_toko = p_kode_toko)
  group by tanggal order by tanggal
$$;

-- Daftar batal nota: siapa yang meminta, Admin yang menyetujui, alasan, nota asal.
create or replace function public.laporan_pembatalan(p_dari date, p_sampai date, p_kode_toko char(3) default null,
                                                     p_batas int default 500)
returns table(kode_toko char(3), shift_uid text, no_batal text, waktu timestamptz, tanggal date, no_struk_asal text,
              waktu_struk_asal timestamptz, kasir text, total numeric, qty numeric, alasan text,
              diminta_oleh text, disetujui_oleh text)
language sql stable security invoker set search_path = public, mb as $$
  select b.kode_toko, b.shift_uid, b.no_batal, b.waktu, b.tanggal, b.no_struk_asal,
         (select min(p.waktu) from penjualan p
          where p.kode_toko = b.kode_toko and p.shift_uid = b.shift_uid and p.no_struk = b.no_struk_asal),
         s.kasir, b.total,
         (select -sum(p.qty) from penjualan p
          where p.kode_toko = b.kode_toko and p.shift_uid = b.shift_uid and p.no_struk = b.no_batal),
         b.alasan, b.diminta_oleh, b.disetujui_oleh
  from pembatalan_nota b
  left join shift s on s.kode_toko = b.kode_toko and s.shift_uid = b.shift_uid
  where b.tanggal between p_dari and p_sampai and (p_kode_toko is null or b.kode_toko = p_kode_toko)
  order by b.waktu desc, b.no_batal desc
  limit least(greatest(coalesce(p_batas, 500), 1), 2000)
$$;

do $$
declare f text;
begin
  foreach f in array array['laporan_ringkasan(date, date)', 'laporan_harian(date, date, char)',
                           'laporan_pembatalan(date, date, char, int)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
