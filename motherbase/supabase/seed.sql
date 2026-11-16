-- Data awal mother base. Jalankan sekali setelah migrasi.
-- Ganti alamat email contoh dengan alamat email tutup shift toko yang asli.
-- store_id diisi lewat hubungkan_toko('KRP', '<ID toko Trizone>') setelah paket pertama masuk.

insert into toko (kode, nama, kota, email_pengirim, batas_hari_sj) values
  ('KRP','Krampung','Surabaya', null, 1),
  ('MNK','Manukan', 'Surabaya', null, 1),
  ('SDA','Sidoarjo','Sidoarjo', null, 1),
  ('TRP','Tropodo', 'Sidoarjo', null, 1),
  ('MLG','Malang',  'Malang',   null, 3),
  ('BKS','Bekasi',  'Bekasi',   null, 7),
  ('CLD','Ciledug', 'Tangerang',null, 7),
  ('DPK','Depok',   'Depok',    null, 7),
  -- Toko ke-9: kode sementara sampai nama tokonya pasti.
  ('XXX','Toko ke-9 (sementara)','-', null, 7)
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
