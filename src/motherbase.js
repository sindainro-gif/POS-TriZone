'use strict';
// Kirim data toko ke mother base (Supabase) dan ambil master barang.
// Tanpa Electron agar bisa diuji dengan Node biasa. Dijalankan hanya di PC pemilik database
// (Mandiri / Server). Data disiapkan dan ditandai oleh services.js (mbBatch / mbAck), jadi:
//   * tanpa internet, toko tetap jalan; data menunggu di pos.db sampai terkirim;
//   * data baru ditandai terkirim setelah mother base membalas, jadi kiriman ulang selalu aman.
// Lawan bicara: RPC terima_data dan ambil_master di motherbase/supabase/migrations.

const { localNow } = require('./services');

const PROTOKOL = 1;
const MAX_KIRIMAN_PER_JALAN = 50;
const TIMEOUT_MS = 60000;

function mbError(msg, extra = {}) {
  const e = new Error(msg);
  e.userFacing = true;
  Object.assign(e, extra);
  return e;
}

// Pesan yang bisa dipahami di toko untuk kegagalan jaringan / HTTP
function explain(err, res, body) {
  if (res) {
    let msg = '';
    try { msg = JSON.parse(body).message || ''; } catch (_) { msg = String(body || '').slice(0, 200); }
    if (/kunci toko/i.test(msg)) return mbError(msg);
    if (/invalid api key/i.test(msg)) {
      return mbError('Anon key tidak dikenali mother base. Salin ulang anon key dari kantor: teks panjang yang diawali "eyJ", bukan kunci toko.');
    }
    if (res.status === 401 || res.status === 403) return mbError(`Mother base menolak akses (HTTP ${res.status}). Periksa anon key. ${msg}`.trim());
    if (res.status === 404) return mbError('Alamat mother base salah atau fungsi belum dipasang (HTTP 404). Periksa alamat dan migrasi database.');
    return mbError(`Mother base membalas HTTP ${res.status}: ${msg || 'tanpa keterangan'}`);
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return mbError('Koneksi ke mother base habis waktu. Periksa internet.', { network: true });
  return mbError(`Tidak dapat terhubung ke mother base (${err && err.cause ? err.cause.code || err.cause.message : err && err.message}). Periksa internet.`, { network: true });
}

function createMotherbase({ svc, appVersion = '', demo = false, fetchFn = globalThis.fetch, now = () => new Date() } = {}) {
  let running = null;

  async function rpc(cfg, fn, payload) {
    let res;
    let body;
    try {
      res = await fetchFn(`${cfg.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg.anon_key, Authorization: `Bearer ${cfg.anon_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p: payload }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await res.text();
    } catch (err) {
      throw explain(err);
    }
    if (!res.ok) throw explain(null, res, body);
    try { return JSON.parse(body); } catch (_) { throw mbError('Balasan mother base tidak terbaca.'); }
  }

  function config() {
    if (demo) throw mbError('Versi DEMO tidak mengirim data ke mother base.');
    const cfg = svc.mbConfig();
    if (!cfg.ready) throw mbError('Mother base belum diatur: isi alamat, anon key, kode toko, dan kunci toko di Pengaturan → Mother Base.');
    return cfg;
  }

  function stamp() {
    return now().toISOString();
  }

  // Kirim semua yang menunggu. force = keadaan terkini dikirim walau tidak berubah.
  function kirim({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const cfg = config();
      svc.mbSetState({ last_attempt_at: stamp() });
      const total = { kiriman: 0, shift: 0, penerimaan: 0, mutasi: 0, opname: 0, snapshot: false };
      try {
        for (let i = 0; i < MAX_KIRIMAN_PER_JALAN; i++) {
          const b = svc.mbBatch({ includeSnapshot: i === 0, force: force && i === 0 });
          if (b.empty) break;
          const reply = await rpc(cfg, 'terima_data', {
            protokol: PROTOKOL,
            kode_toko: cfg.kode_toko,
            kunci: cfg.kunci,
            app_version: appVersion,
            dikirim_at: localNow(),
            shifts: b.shifts,
            dokumen: b.dokumen,
            snapshot: b.snapshot,
          });
          if (!reply || !reply.ok) throw mbError('Mother base tidak mengonfirmasi kiriman.');
          svc.mbAck(b.ack, reply);
          total.kiriman++;
          total.shift += (reply.shift_diterima || []).length;
          for (const k of ['penerimaan', 'mutasi', 'opname']) total[k] += (reply.dokumen && reply.dokumen[k]) || 0;
          if (b.snapshot) total.snapshot = true;
          if (!b.more) break;
        }
      } catch (err) {
        svc.mbSetState({ last_error: err.message });
        throw err;
      }
      svc.mbSetState({ last_ok_at: stamp(), last_error: '', last_result: total });
      return total;
    })().finally(() => { running = null; });
    return running;
  }

  // Master barang & harga. full = ambil semua (bukan hanya yang berubah sejak terakhir).
  async function ambilMaster({ full = false } = {}) {
    const cfg = config();
    try {
      const r = await rpc(cfg, 'ambil_master', {
        kode_toko: cfg.kode_toko, kunci: cfg.kunci, sejak: full ? null : svc.mbMasterSince() || null,
      });
      const out = svc.mbApplyMaster({ produk: r.produk || [], server_at: r.server_at });
      svc.mbSetState({ master_at: stamp(), master_server_at: r.server_at, master_error: '', master_result: { ...out, dilewati: out.dilewati.length } });
      return { ...out, jumlah: (r.produk || []).length };
    } catch (err) {
      svc.mbSetState({ master_error: err.message });
      throw err;
    }
  }

  // Cek alamat, anon key, kode & kunci toko tanpa mengubah data apa pun
  async function tes() {
    const cfg = config();
    const r = await rpc(cfg, 'ambil_master', { kode_toko: cfg.kode_toko, kunci: cfg.kunci, sejak: '2999-01-01T00:00:00Z' });
    return { kode_toko: r.kode_toko, server_at: r.server_at };
  }

  // Permintaan dari homebase, dicek tiap 5 menit (satu RPC kecil):
  //   * minta  = tombol "Tarik data terbaru": keadaan terkini (penjualan & stok) langsung dikirim;
  //   * opname = stock opname dari kantor: diterapkan ke stok (sekali per dokumen), dilaporkan lewat
  //     opname_diterapkan, lalu stok terbaru dikirim.
  // Tidak pernah melempar: gagal (mis. internet putus) dikembalikan di hasil dan dicoba lagi 5 menit kemudian.
  async function cekPermintaan() {
    if (demo || !svc.mbConfig().ready) return { minta: false, opname: [] };
    const out = { minta: false, opname: [] };
    let cfg;
    let r;
    try {
      cfg = config();
      r = await rpc(cfg, 'cek_permintaan', { kode_toko: cfg.kode_toko, kunci: cfg.kunci });
    } catch (err) {
      return { ...out, error: err.message };
    }
    out.minta = !!(r && r.minta);
    const dokumen = Array.isArray(r && r.opname) ? r.opname : [];
    const hasil = [];
    for (const d of dokumen) {
      try {
        const h = svc.mbApplyKantorOpname(d);
        hasil.push({ id: h.id, no_op: h.no_op, dilewati: h.dilewati });
        out.opname.push(h);
      } catch (err) {
        out.opnameError = `${d && d.no_dok}: ${err.message}`;
      }
    }
    if (hasil.length) {
      try {
        await rpc(cfg, 'opname_diterapkan', { kode_toko: cfg.kode_toko, kunci: cfg.kunci, hasil });
      } catch (err) {
        out.laporError = err.message; // dilaporkan lagi pada cek berikutnya (tidak diterapkan ulang)
      }
    }
    if (!out.minta && !hasil.length) return out;
    try {
      out.kirim = await kirim({ force: true });
    } catch (err) {
      out.kirimError = err.message;
    }
    return out;
  }

  // Dipanggil berkala oleh proses utama; tidak pernah melempar error (status tersimpan di mbState)
  async function tick({ pullMaster = false } = {}) {
    if (demo || !svc.mbConfig().ready) return null;
    const out = {};
    try { out.kirim = await kirim(); } catch (err) { out.kirimError = err.message; }
    if (pullMaster && svc.masterLocked()) {
      try { out.master = await ambilMaster(); } catch (err) { out.masterError = err.message; }
    }
    return out;
  }

  return { kirim, ambilMaster, tes, tick, cekPermintaan, isRunning: () => !!running };
}

module.exports = { createMotherbase, PROTOKOL };
