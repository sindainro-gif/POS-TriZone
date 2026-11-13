'use strict';
// Outbox paket Homebase di PC pemilik database (Mandiri / PC Gudang).
// Paket selalu ditulis dulu ke folder lokal (pasti tersedia), lalu disalin ke folder sinkron
// (mis. Google Drive) bila diatur. Gagal menyalin tidak memblokir apa pun: dicoba lagi nanti.
// Tanpa Electron agar bisa diuji dengan Node biasa.
const fs = require('fs');
const path = require('path');
const { encodePackage, packageFileName, FILE_RE } = require('./homebase-package');
const { localNow } = require('./services');

const fsp = fs.promises;
const KEEP_SNAPSHOTS = 10;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

const isSnapshot = (name) => /_snapshot\.json\.gz$/i.test(name);
const storePrefix = (name) => name.slice(0, 13); // "TRZ_xxxxxxxx_"
const byStamp = (a, b) => (a.slice(13) < b.slice(13) ? -1 : a.slice(13) > b.slice(13) ? 1 : 0);
const dirKey = (d) => path.resolve(String(d)).toLowerCase();

/**
 * dir = folder paket lokal. stateFile = catatan status (folder data aplikasi, bukan di folder paket
 * supaya tidak ikut tersinkron bila folder paket sama dengan folder Google Drive).
 */
function createOutbox(dir, { stateFile, keepSnapshots = KEEP_SNAPSHOTS, now = localNow } = {}) {
  const sf = stateFile || path.join(path.dirname(path.resolve(dir)), 'homebase-status.json');
  const state = { sent: {}, last_package: null, last_sync: null, last_snapshot_hash: '', ...(readJson(sf) || {}) };
  if (!state.sent || typeof state.sent !== 'object') state.sent = {};

  function save() {
    fs.mkdirSync(path.dirname(sf), { recursive: true });
    fs.writeFileSync(sf + '.tmp', JSON.stringify(state));
    fs.renameSync(sf + '.tmp', sf);
  }

  function files() {
    try { return fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort(); } catch (_) { return []; }
  }

  // Snapshot terbaru per toko (awalan nama file)
  function newestSnapshots(names) {
    const m = new Map();
    for (const n of names.filter(isSnapshot)) {
      const p = storePrefix(n);
      if (!m.has(p) || byStamp(n, m.get(p)) > 0) m.set(p, n);
    }
    return m;
  }

  // Belum terkirim ke folder sinkron; snapshot yang sudah tergantikan snapshot lebih baru tidak perlu dikirim
  function pendingOf(local, sent) {
    const newest = newestSnapshots(local);
    return local.filter((n) => !sent.has(n) && (!isSnapshot(n) || newest.get(storePrefix(n)) === n));
  }

  function pruneLocal() {
    const snaps = files().filter(isSnapshot).sort(byStamp);
    while (snaps.length > keepSnapshots) {
      try { fs.unlinkSync(path.join(dir, snaps.shift())); } catch (_) { /* dicoba lagi nanti */ }
    }
  }

  // Tulis paket secara atomik (.partial lalu ganti nama). Nama sama (detik yang sama) = isi lebih baru menimpa.
  function write(pkg, { hash } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const buffer = encodePackage(pkg);
    const name = packageFileName(pkg);
    const file = path.join(dir, name);
    fs.writeFileSync(`${file}.partial`, buffer);
    fs.renameSync(`${file}.partial`, file);
    for (const k of Object.keys(state.sent)) state.sent[k] = state.sent[k].filter((n) => n !== name);
    state.last_package = { name, kind: pkg.kind, at: pkg.created_at, size: buffer.length };
    if (pkg.kind === 'snapshot' && hash) state.last_snapshot_hash = hash;
    pruneLocal();
    save();
    return { name, file, size: buffer.length, buffer };
  }

  function record(result) {
    state.last_sync = { at: now(), ...result };
    save();
    return state.last_sync;
  }

  async function doSync(syncDir) {
    const target = String(syncDir || '').trim();
    if (!target) return { skipped: true };
    const key = dirKey(target);
    const local = files();
    if (key === dirKey(dir)) {
      // Folder paket = folder sinkron: tidak perlu disalin
      state.sent[key] = local;
      return record({ dir: target, copied: 0, removed: 0, pending: 0, error: '' });
    }
    const sent = new Set((state.sent[key] || []).filter((n) => local.includes(n)));
    const newest = newestSnapshots(local);
    for (const n of local) if (isSnapshot(n) && newest.get(storePrefix(n)) !== n) sent.add(n);
    const todo = pendingOf(local, sent);
    try {
      if (!(await fsp.stat(target)).isDirectory()) throw new Error('bukan folder');
    } catch (_) {
      state.sent[key] = [...sent];
      return record({ dir: target, copied: 0, removed: 0, pending: todo.length, error: `Folder sinkron tidak bisa dibuka: ${target}` });
    }
    let copied = 0;
    try {
      for (const n of todo) {
        const dest = path.join(target, n);
        await fsp.copyFile(path.join(dir, n), `${dest}.partial`);
        await fsp.rename(`${dest}.partial`, dest);
        sent.add(n);
        copied++;
        state.sent[key] = [...sent];
        save();
      }
      // Di folder sinkron cukup snapshot terbaru milik toko ini (snapshot berisi data lengkap)
      let removed = 0;
      for (const n of await fsp.readdir(target)) {
        if (!FILE_RE.test(n) || !isSnapshot(n) || !newest.has(storePrefix(n))) continue;
        if (byStamp(n, newest.get(storePrefix(n))) < 0) {
          try { await fsp.unlink(path.join(target, n)); removed++; } catch (_) { /* dicoba lagi nanti */ }
        }
      }
      state.sent[key] = [...sent];
      return record({ dir: target, copied, removed, pending: 0, error: '' });
    } catch (e) {
      state.sent[key] = [...sent];
      return record({ dir: target, copied, removed: 0, pending: todo.length - copied, error: `Gagal menyalin ke folder sinkron: ${e.message}` });
    }
  }

  // Satu proses sinkron sekaligus
  let running = null;
  function syncTo(syncDir) {
    if (!running) running = doSync(syncDir).finally(() => { running = null; });
    return running;
  }

  function status(syncDir) {
    const local = files();
    const target = String(syncDir || '').trim();
    const sent = new Set(target ? state.sent[dirKey(target)] || [] : []);
    return {
      dir,
      files: local.length,
      shift_files: local.filter((n) => !isSnapshot(n)).length,
      last_package: state.last_package,
      last_sync: state.last_sync,
      pending: target ? (dirKey(target) === dirKey(dir) ? 0 : pendingOf(local, sent).length) : 0,
    };
  }

  return { dir, write, syncTo, status, files, lastSnapshotHash: () => state.last_snapshot_hash };
}

module.exports = { createOutbox, KEEP_SNAPSHOTS };
