/**
 * Mother Base Trizone — alert harian
 * Google Apps Script di akun Google kantor.
 *
 * Data toko tidak lewat skrip ini: Trizone mengirim langsung ke Supabase (RPC terima_data).
 * Skrip ini hanya memeriksa setiap pagi pukul 09.00 WIB toko mana yang belum menutup shift
 * kemarin, lalu mengirim email ke kantor.
 *
 * Script Properties (Project Settings → Script properties):
 *   SUPABASE_URL          https://<project>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (rahasia)
 *   EMAIL_ALERT           alamat kantor penerima alert, pisahkan dengan koma
 *
 * Pertama kali: jalankan setup() sekali dari editor dan beri izin.
 */

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cekLaporanBelumMasuk').timeBased().atHour(9).nearMinute(0).everyDays(1)
    .inTimezone('Asia/Jakarta').create();
  cekKonfigurasi_();
  Logger.log('Setup selesai: alert harian pukul 09.00 WIB.');
}

function cekLaporanBelumMasuk() {
  var cfg = cekKonfigurasi_();
  var kemarin = Utilities.formatDate(new Date(Date.now() - 864e5), 'Asia/Jakarta', 'yyyy-MM-dd');
  var rows = rpc_(cfg, 'laporan_belum_masuk', { p_tanggal: kemarin }) || [];
  if (!rows.length) return;
  MailApp.sendEmail(cfg.emailAlert, '[MOTHER BASE] Laporan belum masuk ' + kemarin, teksBelumMasuk(kemarin, rows));
}

function teksBelumMasuk(tanggal, rows) {
  return 'Belum ada shift yang ditutup pada ' + tanggal + ' (dicek pukul 09.00) dari ' + rows.length + ' toko:\n\n' +
    rows.map(function (r) {
      if (!r.terhubung) return '- ' + r.kode + ' ' + r.nama + ': belum dihubungkan (kunci toko belum dibuat)';
      return '- ' + r.kode + ' ' + r.nama + ' (shift terakhir: ' + (r.shift_terakhir || 'belum ada') +
             ', kiriman terakhir: ' + (r.kiriman_terakhir || 'belum ada') + ')';
    }).join('\n') +
    '\n\nBila toko sudah tutup shift, data menunggu internet di PC Gudang. Minta toko menyalakan internet ' +
    'lalu menekan "Kirim Sekarang" di Pengaturan → Mother Base.';
}

function cekKonfigurasi_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    url: (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, ''),
    key: p.getProperty('SUPABASE_SERVICE_KEY') || '',
    emailAlert: p.getProperty('EMAIL_ALERT') || ''
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

// Untuk pengujian di Node (diabaikan oleh Apps Script).
if (typeof module !== 'undefined') module.exports = { teksBelumMasuk: teksBelumMasuk };
