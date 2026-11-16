-- Data awal mother base. Jalankan sekali setelah migrasi.
-- Setelah itu buat kunci tiap toko: select buat_kunci_toko('KRP');  (tampil sekali, isi di Trizone)

insert into toko (kode, nama, kota, batas_hari_sj) values
  ('KRP','Krampung','Surabaya', 1),
  ('MNK','Manukan', 'Surabaya', 1),
  ('SDA','Sidoarjo','Sidoarjo', 1),
  ('TRP','Tropodo', 'Sidoarjo', 1),
  ('MLG','Malang',  'Malang', 3),
  ('BKS','Bekasi',  'Bekasi', 7),
  ('CLD','Ciledug', 'Tangerang', 7),
  ('DPK','Depok',   'Depok', 7),
  -- Toko ke-9: kode sementara sampai nama tokonya pasti.
  ('XXX','Toko ke-9 (sementara)','-', 7)
on conflict (kode) do nothing;

-- Pelanggan di Accurate. "X Special" = toko yang sama dengan "X".
-- Utama, Sepanjang, dan Jago belum dipetakan; isi kode_toko-nya setelah diputuskan.
insert into pelanggan_accurate (nama, kode_toko) values
  ('Tropodo','TRP'), ('Tropodo Special','TRP'),
  ('Sidoarjo','SDA'), ('Sidoarjo Special','SDA'),
  ('Malang','MLG'), ('Malang Special','MLG'),
  ('Utama', null), ('Utama Special', null),
  ('Sepanjang', null), ('Sepanjang Special', null),
  ('Jago Plastik', null), ('Jago Special', null)
on conflict (nama) do nothing;

insert into pengaturan (kunci, nilai) values
  ('jam_alert_laporan', '"09:00"'),
  ('mulai_pencocokan_sj', '"2026-11-01"')    -- penerimaan sebelum tanggal ini tidak dicek
on conflict (kunci) do nothing;

-- Markup harga jual kantor ke toko tidak disimpan di repo (repo ini publik).
-- Isi langsung di database, mis. untuk 10%:
--   insert into pengaturan values ('markup_jual_ke_toko', '0.10');
