-- =====================================================================
-- Mother Base Trizone — tombol "Update penjualan" (minta toko mengirim sekarang)
--
-- Homebase tidak bisa menghubungi PC toko langsung, jadi tombol di aplikasi membuat permintaan
-- (toko_status.minta_update_at). Trizone 1.23.0 memeriksa permintaan tiap 5 menit lewat
-- cek_permintaan(), lalu langsung mengirim. Permintaan dianggap terjawab begitu ada kiriman
-- yang lebih baru (kiriman_terakhir_at > minta_update_at); tidak perlu kolom status lain.
-- =====================================================================

alter table toko_status add column minta_update_at timestamptz;
alter table toko_status add column minta_update_oleh text;

-- Minta toko mengirim data sekarang. Kantor: semua toko (p_kode_toko null) atau satu toko.
-- Pemilik toko: hanya tokonya. Mengembalikan jumlah toko yang diminta.
create or replace function public.minta_update_toko(p_kode_toko char(3) default null) returns int
language plpgsql security definer set search_path = public, mb as $$
declare
  v_nama text := (select nama from pengguna where id = auth.uid() and aktif);
  v_n    int;
begin
  if v_nama is null then raise exception 'Akses ditolak.'; end if;
  if not mb.is_kantor() then
    if mb.toko_saya() is null or (p_kode_toko is not null and p_kode_toko <> mb.toko_saya()) then
      raise exception 'Akses ditolak: hanya untuk toko Anda sendiri.';
    end if;
    p_kode_toko := mb.toko_saya();
  end if;
  insert into toko_status as s (kode_toko, minta_update_at, minta_update_oleh)
  select t.kode, now(), v_nama from toko t
  where t.aktif and (p_kode_toko is null or t.kode = p_kode_toko)
  on conflict (kode_toko) do update set minta_update_at = excluded.minta_update_at, minta_update_oleh = excluded.minta_update_oleh;
  get diagnostics v_n = row_count;
  if p_kode_toko is not null and v_n = 0 then raise exception 'Toko % tidak ditemukan atau tidak aktif.', p_kode_toko; end if;
  return v_n;
end $$;

-- Dipanggil Trizone (anon key + kunci toko) tiap 5 menit. Tidak mengubah data.
create or replace function public.cek_permintaan(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, mb as $$
declare
  v_kode char(3) := mb.cek_kunci(p->>'kode_toko', p->>'kunci');
begin
  return jsonb_build_object('kode_toko', v_kode, 'minta', coalesce((
    select s.minta_update_at is not null and (s.kiriman_terakhir_at is null or s.minta_update_at > s.kiriman_terakhir_at)
    from toko_status s where s.kode_toko = v_kode), false));
end $$;

-- Status koneksi toko: ditambah permintaan update yang belum terjawab
drop function public.status_koneksi_toko();
create function public.status_koneksi_toko()
returns table(kode char(3), nama text, kota text, aktif boolean, batas_hari_sj int, punya_kunci boolean,
              kunci_dibuat_at timestamptz, versi_trizone text, kiriman_terakhir_at timestamptz,
              snapshot_terakhir_at timestamptz, shift_terakhir_at timestamptz,
              minta_update_at timestamptz, minta_update_oleh text)
language sql stable security definer set search_path = public, mb as $$
  select t.kode, t.nama, t.kota, t.aktif, t.batas_hari_sj, k.kode_toko is not null, k.dibuat_at,
         s.versi_trizone, s.kiriman_terakhir_at, s.snapshot_terakhir_at, s.shift_terakhir_at,
         case when s.kiriman_terakhir_at is null or s.minta_update_at > s.kiriman_terakhir_at then s.minta_update_at end,
         case when s.kiriman_terakhir_at is null or s.minta_update_at > s.kiriman_terakhir_at then s.minta_update_oleh end
  from toko t
  left join toko_kunci k on k.kode_toko = t.kode
  left join toko_status s on s.kode_toko = t.kode
  where mb.boleh_lihat_toko(t.kode)
  order by t.kode
$$;

revoke all on function public.status_koneksi_toko() from public, anon;
grant execute on function public.status_koneksi_toko() to authenticated, service_role;
revoke all on function public.minta_update_toko(char) from public, anon;
grant execute on function public.minta_update_toko(char) to authenticated, service_role;
-- Trizone memanggil dengan anon key; keamanan dari kode + kunci toko (sama seperti terima_data)
revoke all on function public.cek_permintaan(jsonb) from public, authenticated;
grant execute on function public.cek_permintaan(jsonb) to anon, service_role;
