-- =====================================================================
-- Mother Base Trizone — pengguna dibuat dari homebase dengan kata sandi sementara
--
-- Owner membuat akun di menu Pengguna (Edge Function `pengguna`, memakai service role untuk membuat akun
-- Supabase Auth), lalu memberikan kata sandi sementara secara pribadi. Saat login pertama (dan setelah
-- owner mereset kata sandi) pengguna wajib membuat kata sandi sendiri: tanda wajib_ganti_sandi.
-- Pendaftaran umum tetap dimatikan di Supabase Auth.
-- =====================================================================

alter table pengguna add column wajib_ganti_sandi boolean not null default false;

create or replace function public.saya() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'nama', p.nama, 'peran', p.peran, 'kode_toko', p.kode_toko,
                            'email', u.email, 'aktif', p.aktif, 'wajib_ganti_sandi', p.wajib_ganti_sandi)
  from pengguna p join auth.users u on u.id = p.id
  where p.id = auth.uid()
$$;

drop function public.daftar_pengguna();
create function public.daftar_pengguna()
returns table(id uuid, email text, nama text, peran peran_pengguna, kode_toko char(3), aktif boolean, wajib_ganti_sandi boolean)
language sql stable security definer set search_path = public, mb as $$
  select p.id, u.email::text, p.nama, p.peran, p.kode_toko, p.aktif, p.wajib_ganti_sandi
  from pengguna p join auth.users u on u.id = p.id
  where mb.peran_saya() = 'owner'
  order by p.peran, p.nama
$$;

-- Owner: pengguna ini wajib membuat kata sandi sendiri saat login berikutnya (setelah dibuat / direset)
create or replace function public.wajibkan_ganti_sandi(p_email text) returns void
language plpgsql security definer set search_path = public, mb as $$
declare v uuid;
begin
  if mb.peran_saya() is distinct from 'owner' then raise exception 'Hanya owner yang boleh mengatur pengguna'; end if;
  select p.id into v from pengguna p join auth.users u on u.id = p.id where lower(u.email) = lower(btrim(p_email));
  if v is null then raise exception 'Pengguna % tidak ditemukan.', p_email; end if;
  if v = auth.uid() then raise exception 'Untuk akun sendiri pakai Ganti kata sandi.'; end if;
  update pengguna set wajib_ganti_sandi = true where id = v;
end $$;

-- Pengguna sudah membuat kata sandi sendiri
create or replace function public.selesai_ganti_sandi() returns void
language sql security definer set search_path = public as $$
  update pengguna set wajib_ganti_sandi = false where id = auth.uid()
$$;

revoke all on function public.saya() from public, anon;
grant execute on function public.saya() to authenticated, service_role;
revoke all on function public.daftar_pengguna() from public, anon;
grant execute on function public.daftar_pengguna() to authenticated, service_role;
revoke all on function public.wajibkan_ganti_sandi(text) from public, anon;
grant execute on function public.wajibkan_ganti_sandi(text) to authenticated, service_role;
revoke all on function public.selesai_ganti_sandi() from public, anon;
grant execute on function public.selesai_ganti_sandi() to authenticated, service_role;
