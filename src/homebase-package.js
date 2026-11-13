'use strict';
// Kontrak paket data Homebase (format v1): satu file JSON di-gzip yang dibuat POS dan dibaca aplikasi Homebase.
// Tanpa Electron agar bisa diuji dengan Node biasa. Kamus field lengkap ada di docs/HOMEBASE.md.
const zlib = require('zlib');
const crypto = require('crypto');

const FORMAT = 'pos-trizone-homebase';
const VERSION = 1;
const KINDS = ['snapshot', 'shift'];
// TRZ_<8 karakter ID toko>_<YYYYMMDD-HHMMSS>_<jenis>[_<8 karakter ID shift>].json.gz
const FILE_RE = /^TRZ_[0-9a-z]{8}_\d{8}-\d{6}_(snapshot|shift)(_[0-9a-z]{1,16})?\.json\.gz$/i;
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function posError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Sidik data (tanpa package_id / waktu) untuk mendeteksi apakah ada perubahan sejak snapshot terakhir
const dataHash = (data) => sha256(Buffer.from(JSON.stringify(data), 'utf8'));
const shortId = (id) => String(id || '').replace(/[^0-9a-z]/gi, '').toLowerCase();

function countsOf(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (Array.isArray(v)) out[k] = v.length;
    else if (v && Array.isArray(v.sales)) out[`${k}_sales`] = v.sales.length;
  }
  return out;
}

function makePackage({ kind, store, source = {}, data, created_at }) {
  if (!KINDS.includes(kind)) throw new Error(`Jenis paket tidak dikenal: ${kind}`);
  if (!store || !store.id) throw new Error('ID toko wajib ada di paket.');
  if (!TIME_RE.test(String(created_at || ''))) throw new Error('Waktu pembuatan paket tidak valid.');
  return {
    format: FORMAT,
    version: VERSION,
    kind,
    package_id: crypto.randomUUID(),
    created_at,
    store: { id: String(store.id), name: String(store.name || ''), address: String(store.address || '') },
    source: {
      app_version: String(source.app_version || ''),
      device_mode: String(source.device_mode || ''),
      demo: !!source.demo,
      legacy: !!source.legacy,
    },
    counts: countsOf(data),
    data,
  };
}

function packageFileName(pkg) {
  const stamp = String(pkg.created_at).replace(/\D/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  let name = `TRZ_${shortId(pkg.store.id).slice(0, 8)}_${stamp}_${pkg.kind}`;
  if (pkg.kind === 'shift' && pkg.data && pkg.data.shift) name += `_${shortId(pkg.data.shift.shift_uid).slice(-8)}`;
  return `${name}.json.gz`;
}

// Level gzip bawaan (6): ukuran hampir sama dengan level 9 tetapi ±2,5× lebih cepat (snapshot dibuat di proses utama)
const encodePackage = (pkg) => zlib.gzipSync(Buffer.from(JSON.stringify(pkg), 'utf8'));

function validatePackage(pkg) {
  if (!pkg || typeof pkg !== 'object' || pkg.format !== FORMAT) throw posError('Bukan paket data POS Tri-Zone.');
  if (!Number.isInteger(pkg.version) || pkg.version < 1) throw posError('Versi paket tidak valid.');
  if (pkg.version > VERSION) {
    throw posError(`Paket versi ${pkg.version} lebih baru dari yang dikenal aplikasi ini (versi ${VERSION}). Perbarui aplikasi Homebase.`);
  }
  if (!KINDS.includes(pkg.kind)) throw posError(`Jenis paket "${pkg.kind}" tidak dikenal.`);
  if (!pkg.store || typeof pkg.store.id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(pkg.store.id)) throw posError('ID toko di paket tidak valid.');
  if (!TIME_RE.test(String(pkg.created_at || ''))) throw posError('Waktu pembuatan paket tidak valid.');
  if (!pkg.data || typeof pkg.data !== 'object') throw posError('Paket tidak berisi data.');
  if (pkg.kind === 'shift') {
    const s = pkg.data.shift;
    if (!s || !s.shift_uid || !Array.isArray(pkg.data.sales)) throw posError('Paket shift tidak lengkap.');
  }
  return pkg;
}

function decodePackage(buf) {
  let json;
  try {
    json = zlib.gunzipSync(buf).toString('utf8');
  } catch (_) {
    throw posError('File rusak atau belum selesai tersalin (gzip tidak utuh).');
  }
  let pkg;
  try {
    pkg = JSON.parse(json);
  } catch (_) {
    throw posError('Isi paket rusak (JSON tidak terbaca).');
  }
  return validatePackage(pkg);
}

module.exports = {
  FORMAT, VERSION, KINDS, FILE_RE, makePackage, packageFileName, encodePackage, decodePackage, validatePackage, sha256, dataHash, shortId,
};
