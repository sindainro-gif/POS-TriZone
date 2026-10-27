'use strict';
// Layanan jaringan LAN: PC Gudang (server) menyimpan database, PC Kasir (klien) memanggilnya lewat HTTP.
// Tanpa Electron agar bisa diuji dengan Node biasa.
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 4785;
const MAX_BODY = 5 * 1024 * 1024;

function posError(msg, extra = {}) {
  const e = new Error(msg);
  e.userFacing = true;
  Object.assign(e, extra);
  return e;
}

function sameKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function newPairKey() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Server RPC. `getKey()` dibaca tiap permintaan (kode bisa diganti tanpa restart).
 * `call(method, args)` menjalankan perintah; dijalankan berurutan oleh satu proses Node.
 */
function startServer({ port = DEFAULT_PORT, host = '0.0.0.0', getKey, call, info = () => ({}) }) {
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') return send(res, 200, { ok: true, app: 'POS Tri-Zone', ...info() });
    if (req.method !== 'POST' || req.url !== '/rpc') return send(res, 404, { ok: false, error: 'Tidak ditemukan.' });
    if (!sameKey(req.headers['x-pos-key'], getKey())) return send(res, 401, { ok: false, error: 'Kode pasangan salah. Periksa kode di PC gudang.' });
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, { ok: false, error: 'Data terlalu besar.' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return send(res, 400, { ok: false, error: 'Permintaan tidak valid.' }); }
      try {
        const data = await call(String(msg.method || ''), Array.isArray(msg.args) ? msg.args : []);
        send(res, 200, { ok: true, data: data === undefined ? null : data });
      } catch (err) {
        if (!err.userFacing) console.error('[rpc]', msg.method, err);
        send(res, 200, { ok: false, error: err.message || String(err) });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err.code === 'EADDRINUSE'
      ? posError(`Port ${port} sudah dipakai program lain. Tutup program itu atau ganti port.`)
      : err));
    server.listen(port, host, () => resolve(server));
  });
}

function request({ host, port, key, method, path, body, timeout }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host, port, path, method,
      headers: { 'Content-Type': 'application/json', 'X-POS-Key': key || '', ...(data ? { 'Content-Length': data.length } : {}) },
      timeout,
      // Tanpa koneksi keep-alive: setelah PC gudang dinyalakan ulang, socket lama yang sudah mati
      // tidak dipakai lagi (permintaan pertama setelah koneksi kembali langsung berhasil)
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(posError('Balasan PC gudang tidak dikenali.')); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(posError(
      `Tidak terhubung ke komputer gudang (${host}:${port}). Pastikan PC gudang menyala, aplikasi POS terbuka dalam mode Server, dan kedua PC satu jaringan.`,
      { network: true, code: err.code },
    )));
    if (data) req.write(data);
    req.end();
  });
}

function createRemoteClient({ host, port = DEFAULT_PORT, key, timeout = 10000 }) {
  async function rpc(method, args) {
    const r = await request({ host, port, key, method: 'POST', path: '/rpc', body: { method, args }, timeout });
    if (!r.ok) throw posError(r.error || 'Perintah gagal di PC gudang.');
    return r.data;
  }
  async function ping(t = 3000) {
    const r = await request({ host, port, method: 'GET', path: '/ping', timeout: t });
    if (!r.ok || r.app !== 'POS Tri-Zone') throw posError('Alamat itu bukan aplikasi POS Tri-Zone.');
    return r;
  }
  // svc.namaMetode(...args) → dijalankan di PC gudang
  const services = new Proxy({}, {
    get(_t, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      return (...args) => rpc(name, args);
    },
  });
  return { rpc, ping, services };
}

module.exports = { startServer, createRemoteClient, newPairKey, DEFAULT_PORT };
