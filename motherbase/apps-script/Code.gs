/**
 * Mother Base Trizone — penerima paket Homebase (TRZ_*.json.gz)
 * Google Apps Script di akun Google khusus mother base.
 *
 * Dua jalur masuk (boleh dipakai bersamaan; paket yang sama tidak dihitung dua kali):
 *   1. Gmail: lampiran TRZ_*.json.gz di email tutup shift dari alamat toko yang terdaftar.
 *   2. Google Drive: folder POS-Homebase yang dibagikan toko ke akun ini (DRIVE_FOLDER_ID),
 *      diperiksa sampai 2 tingkat subfolder.
 * Setiap paket di-ungzip, dicek amplopnya, lalu dikirim utuh ke RPC ingest_paket.
 * Database yang menerapkan aturan impor (lihat docs/HOMEBASE.md bagian 5).
 *
 * Script Properties (Project Settings → Script properties):
 *   SUPABASE_URL          https://<project>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (rahasia)
 *   EMAIL_ALERT           alamat kantor penerima alert, pisahkan dengan koma
 *   DRIVE_FOLDER_ID       (opsional) ID folder Google Drive POS-Homebase
 *   WAJIB_DKIM            (opsional) "false" untuk mematikan cek DKIM/SPF email
 *
 * Pertama kali: jalankan setup() sekali dari editor dan beri izin.
 */

var VERSI_PARSER = '2.0.0';
var LABEL_OK = 'MB/Diproses';
var LABEL_TOLAK = 'MB/Ditolak';
var BATAS_EMAIL_PER_JALAN = 20;
var BATAS_FILE_PER_JALAN = 40;
var BATAS_DETIK = 300;               // Apps Script berhenti di 6 menit; sisakan waktu

// Sama dengan FILE_RE di src/homebase-package.js
var RE_FILE = /^TRZ_[0-9a-z]{8}_\d{8}-\d{6}_(snapshot|shift)(_[0-9a-z]{1,16})?\.json\.gz$/i;
var RE_WAKTU = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// =====================================================================
// Pemicu
// =====================================================================

function setup() {
  [LABEL_OK, LABEL_TOLAK].forEach(function (n) {
    if (!GmailApp.getUserLabelByName(n)) GmailApp.createLabel(n);
  });
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('prosesSemua').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('cekLaporanBelumMasuk').timeBased().atHour(9).nearMinute(0).everyDays(1)
    .inTimezone('Asia/Jakarta').create();
  cekKonfigurasi_();
  Logger.log('Setup selesai: tiap 10 menit (Gmail + Drive) dan harian pukul 09.00 WIB.');
}

function prosesSemua() {
  var kunci = LockService.getScriptLock();
  if (!kunci.tryLock(1000)) return;
  var mulai = Date.now();
  try {
    var cfg = cekKonfigurasi_();
    var ringkas = { ok: 0, lama: 0, menunggu: 0, ditolak: 0, sudah: 0 };
    prosesGmail_(cfg, ringkas, mulai);
    if (cfg.driveFolderId) prosesDrive_(cfg, ringkas, mulai);
    Logger.log(JSON.stringify(ringkas));
  } finally {
    kunci.releaseLock();
  }
}

function cekLaporanBelumMasuk() {
  var cfg = cekKonfigurasi_();
  var kemarin = Utilities.formatDate(new Date(Date.now() - 864e5), 'Asia/Jakarta', 'yyyy-MM-dd');
  var rows = rpc_(cfg, 'laporan_belum_masuk', { p_tanggal: kemarin }) || [];
  if (!rows.length) return;
  MailApp.sendEmail(cfg.emailAlert, '[MOTHER BASE] Laporan belum masuk ' + kemarin, teksBelumMasuk(kemarin, rows));
}

// =====================================================================
// Jalur Gmail
// =====================================================================

function prosesGmail_(cfg, ringkas, mulai) {
  var toko = rpc_(cfg, 'daftar_toko_aktif', {}) || [];
  var pengirim = toko.map(function (t) { return t.email_pengirim; }).filter(Boolean);
  if (!pengirim.length) return;
  var labelOk = GmailApp.getUserLabelByName(LABEL_OK);
  var labelTolak = GmailApp.getUserLabelByName(LABEL_TOLAK);
  var q = 'has:attachment filename:json.gz newer_than:30d -label:' + labelGmail_(LABEL_OK) +
          ' -label:' + labelGmail_(LABEL_TOLAK) + ' from:(' + pengirim.join(' OR ') + ')';
  var threads = GmailApp.search(q, 0, BATAS_EMAIL_PER_JALAN);

  for (var i = 0; i < threads.length && waktuCukup_(mulai); i++) {
    var adaTolak = false;
    threads[i].getMessages().forEach(function (msg) {
      var dari = alamatEmail_(msg.getFrom());
      if (pengirim.indexOf(dari) < 0) return;
      if (cfg.wajibDkim && !lolosOtentikasi(msg.getHeader('Authentication-Results'))) {
        adaTolak = true;
        kirimAlert_(cfg, 'Email ditolak: ' + msg.getSubject(),
          'Email dari ' + dari + ' tidak lolos DKIM/SPF (kemungkinan pengirim palsu). Paketnya tidak diproses.');
        return;
      }
      msg.getAttachments().forEach(function (a) {
        if (!RE_FILE.test(a.getName())) return;
        var h = prosesBlob_(cfg, a.copyBlob(), a.getName(), 'EMAIL', dari);
        hitung_(ringkas, h);
        if (h.status === 'DITOLAK') adaTolak = true;
      });
    });
    threads[i].addLabel(adaTolak ? labelTolak : labelOk);
  }
}

// =====================================================================
// Jalur Google Drive
// =====================================================================

function prosesDrive_(cfg, ringkas, mulai) {
  var akar = DriveApp.getFolderById(cfg.driveFolderId);
  var files = [];
  kumpulkanFile_(akar, 0, files);
  if (!files.length) return;
  files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });   // urut waktu dalam nama

  var nama = files.map(function (f) { return f.getName(); });
  var sudah = {};
  for (var i = 0; i < nama.length; i += 200) {
    (rpc_(cfg, 'paket_sudah_ada', { p_nama: nama.slice(i, i + 200) }) || []).forEach(function (n) {
      sudah[typeof n === 'string' ? n : n.paket_sudah_ada] = true;
    });
  }
  var diproses = 0;
  var props = PropertiesService.getScriptProperties();
  for (var j = 0; j < files.length && diproses < BATAS_FILE_PER_JALAN && waktuCukup_(mulai); j++) {
    var f = files[j];
    if (sudah[f.getName()]) continue;
    // Lewati file yang masih disalin Google Drive for desktop (baru berubah < 2 menit)
    var diubah = f.getLastUpdated().getTime();
    if (Date.now() - diubah < 120000) continue;
    // File yang sudah ditolak baru dicoba lagi setelah isinya berubah
    var kTolak = 'tolak:' + f.getId();
    if (props.getProperty(kTolak) === String(diubah)) continue;
    var h = prosesBlob_(cfg, f.getBlob(), f.getName(), 'DRIVE', null);
    if (h.status === 'DITOLAK') props.setProperty(kTolak, String(diubah)); else props.deleteProperty(kTolak);
    hitung_(ringkas, h);
    diproses++;
  }
}

function kumpulkanFile_(folder, tingkat, out) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (RE_FILE.test(f.getName())) out.push(f);
  }
  if (tingkat >= 2) return;
  var sub = folder.getFolders();
  while (sub.hasNext()) kumpulkanFile_(sub.next(), tingkat + 1, out);
}

// =====================================================================
// Satu paket
// =====================================================================

function prosesBlob_(cfg, blob, namaFile, sumber, pengirim) {
  var bytes = blob.getBytes();
  var sha = sha256Hex_(bytes);
  var pkg;
  try {
    var json = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip', namaFile)).getDataAsString('UTF-8');
    pkg = JSON.parse(json);
  } catch (e) {
    // File belum utuh tersalin atau rusak: catat sebagai ditolak; dicoba lagi bila isinya berubah (sha berbeda).
    pkg = null;
  }
  var masalah = pkg ? cekPaket(pkg) : 'File rusak atau belum selesai tersalin (gzip/JSON tidak utuh).';
  var hasil;
  try {
    hasil = rpc_(cfg, 'ingest_paket', { p: {
      sha256: sha, nama_file: namaFile, sumber: sumber, pengirim: pengirim, versi_parser: VERSI_PARSER,
      alasan_parser: pkg ? null : masalah, paket: pkg || {}
    } });
  } catch (e) {
    hasil = { status: 'DITOLAK', pesan: e.message };
  }
  if (hasil.status === 'DITOLAK') {
    kirimAlert_(cfg, 'Paket ditolak: ' + namaFile, 'Sumber: ' + sumber + (pengirim ? ' (' + pengirim + ')' : '') +
      '\nAlasan: ' + (hasil.pesan || masalah || '-') +
      '\n\nPaket yang sama akan dicoba lagi bila filenya dikirim ulang dari toko (Kirim Data Sekarang / Kirim Ulang Laporan).');
  } else if (hasil.status === 'MENUNGGU_TOKO') {
    kirimAlert_(cfg, 'Toko baru menunggu dihubungkan: ' + ((pkg && pkg.store && pkg.store.name) || namaFile),
      hasil.pesan + '\n\nHubungkan di mother base: hubungkan_toko(\'<KODE>\', \'' + (pkg && pkg.store && pkg.store.id) + '\'). ' +
      'Semua paket toko ini yang sudah masuk akan diproses saat itu.');
  }
  return hasil;
}

/** Cek amplop paket; null bila baik. Sama dengan validatePackage di src/homebase-package.js. */
function cekPaket(pkg) {
  if (!pkg || typeof pkg !== 'object' || pkg.format !== 'pos-trizone-homebase') return 'Bukan paket data POS Tri-Zone.';
  if (typeof pkg.version !== 'number' || pkg.version < 1 || pkg.version % 1) return 'Versi paket tidak valid.';
  if (pkg.version > 1) return 'Paket versi ' + pkg.version + ' lebih baru dari yang dikenal mother base. Perbarui mother base.';
  if (pkg.kind !== 'snapshot' && pkg.kind !== 'shift') return 'Jenis paket "' + pkg.kind + '" tidak dikenal.';
  if (!pkg.store || !/^[0-9a-z-]{8,64}$/i.test(String(pkg.store.id || ''))) return 'ID toko di paket tidak valid.';
  if (!RE_WAKTU.test(String(pkg.created_at || ''))) return 'Waktu pembuatan paket tidak valid.';
  if (!pkg.data || typeof pkg.data !== 'object') return 'Paket tidak berisi data.';
  if (pkg.kind === 'shift' && (!pkg.data.shift || !pkg.data.shift.shift_uid || !Array.isArray(pkg.data.sales))) {
    return 'Paket shift tidak lengkap.';
  }
  if (pkg.source && pkg.source.demo) return 'Paket dari versi DEMO (data latihan) tidak diimpor.';
  return null;
}

/** Header Authentication-Results harus memuat dkim=pass atau spf=pass. */
function lolosOtentikasi(header) {
  if (!header) return false;
  return /\bdkim=pass\b/i.test(header) || /\bspf=pass\b/i.test(header);
}

function teksBelumMasuk(tanggal, rows) {
  return 'Belum ada shift yang ditutup pada ' + tanggal + ' (dicek pukul 09.00) dari ' + rows.length + ' toko:\n\n' +
    rows.map(function (r) {
      if (!r.terhubung) return '- ' + r.kode + ' ' + r.nama + ': belum dihubungkan ke mother base';
      return '- ' + r.kode + ' ' + r.nama + ' (shift terakhir: ' + (r.shift_terakhir || 'belum ada') +
             ', paket terakhir: ' + (r.paket_terakhir || 'belum ada') + ')';
    }).join('\n') +
    '\n\nMinta toko menyalakan internet dan Google Drive di PC Gudang, atau menekan ' +
    '"Kirim Data Sekarang" / "Kirim Ulang Laporan" di Trizone.';
}

// =====================================================================
// Bantu
// =====================================================================

function cekKonfigurasi_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    url: (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, ''),
    key: p.getProperty('SUPABASE_SERVICE_KEY') || '',
    emailAlert: p.getProperty('EMAIL_ALERT') || '',
    driveFolderId: p.getProperty('DRIVE_FOLDER_ID') || '',
    wajibDkim: p.getProperty('WAJIB_DKIM') !== 'false'
  };
  if (!cfg.url || !cfg.key || !cfg.emailAlert) {
    throw new Error('Isi Script Properties: SUPABASE_URL, SUPABASE_SERVICE_KEY, EMAIL_ALERT');
  }
  return cfg;
}

function rpc_(cfg, nama, body) {
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + nama, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var kode = res.getResponseCode();
  var teks = res.getContentText();
  if (kode >= 300) throw new Error('Supabase ' + nama + ' HTTP ' + kode + ': ' + teks.slice(0, 500));
  return teks ? JSON.parse(teks) : null;
}

function kirimAlert_(cfg, judul, isi) {
  MailApp.sendEmail(cfg.emailAlert, '[MOTHER BASE] ' + judul, isi);
}

function hitung_(r, h) {
  var k = { OK: 'ok', LAMA: 'lama', MENUNGGU_TOKO: 'menunggu', DITOLAK: 'ditolak', SUDAH_ADA: 'sudah' }[h.status];
  if (k) r[k]++;
}

function waktuCukup_(mulai) { return (Date.now() - mulai) / 1000 < BATAS_DETIK; }

function alamatEmail_(from) {
  var m = /<([^>]+)>/.exec(from || '');
  return String(m ? m[1] : from).trim().toLowerCase();
}

function labelGmail_(nama) { return nama.replace(/[\/\s]/g, '-'); }

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (b) {
    var h = (b & 0xff).toString(16); return h.length < 2 ? '0' + h : h;
  }).join('');
}

// Untuk pengujian di Node (diabaikan oleh Apps Script).
if (typeof module !== 'undefined') {
  module.exports = { cekPaket: cekPaket, lolosOtentikasi: lolosOtentikasi, teksBelumMasuk: teksBelumMasuk,
                     RE_FILE: RE_FILE, prosesBlob_: prosesBlob_ };
}
