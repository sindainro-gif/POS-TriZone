'use strict';
// Server pengembangan mother base: tiruan kecil Supabase di atas PostgreSQL lokal.
// HANYA untuk mencoba aplikasi dan pengujian di komputer sendiri — jangan dipasang di internet.
//
//   /rest/v1/<tabel|view>      subset PostgREST: select, filter eq/neq/gt/gte/lt/lte/like/ilike/in/is,
//                              order, limit, offset, count=exact; POST / PATCH / DELETE
//   /rest/v1/rpc/<fungsi>      panggil fungsi SQL dengan argumen bernama
//   /auth/v1/token, /user, /logout   login email + kata sandi (bcrypt di auth.users), JWT HS256
//   /functions/v1/asisten      Edge Function asisten AI (functions/asisten/asisten.js)
//   /functions/v1/pengguna     Edge Function pengguna (functions/pengguna/pengguna.mjs)
//   /                          aplikasi web (web/), config.js dibuat otomatis
//
// Setiap permintaan dijalankan dalam satu transaksi dengan peran anon / authenticated dan klaim JWT,
// jadi Row Level Security dan hak fungsi berlaku sama seperti di Supabase.
//
// Pakai:  MB_DATABASE_URL=postgres://... node dev/server.js [--port 54321] [--demo]
//   --demo  buat ulang database dengan data contoh (dev/data-demo.js)
// Asisten AI memakai Claude sungguhan bila ANTHROPIC_API_KEY diisi; tanpa itu memakai Claude tiruan.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

// Seperti PostgREST: numeric & bigint dikirim sebagai angka JSON, bukan teks
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date tetap teks YYYY-MM-DD seperti PostgREST (bukan objek Date)
types.setTypeParser(1082, (v) => v);

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

// ---------------------------------------------------------------- JWT HS256
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function signJwt(payload, secret) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const sig = Buffer.from(b64u(crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()));
  const got = Buffer.from(parts[2]);
  if (got.length !== sig.length || !crypto.timingSafeEqual(sig, got)) return null;
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}

// ---------------------------------------------------------------- PostgREST (subset)
const IDENT = /^[a-z_][a-z0-9_]*$/;
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const ident = (s) => {
  if (!IDENT.test(s)) throw new HttpError(400, `Nama tidak valid: ${s}`);
  return `"${s}"`;
};

function buildWhere(params, values) {
  const where = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const col = ident(key);
    let v = raw;
    let not = false;
    if (v.startsWith('not.')) { not = true; v = v.slice(4); }
    const dot = v.indexOf('.');
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    let cond;
    if (OPS[op]) {
      values.push(op === 'like' || op === 'ilike' ? val.replace(/\*/g, '%') : val);
      cond = `${col} ${OPS[op]} $${values.length}`;
    } else if (op === 'in') {
      const list = val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
      values.push(list);
      cond = `${col}::text = any($${values.length}::text[])`;
    } else if (op === 'is') {
      if (!['null', 'true', 'false'].includes(val)) throw new HttpError(400, `Nilai is tidak valid: ${val}`);
      cond = `${col} is ${val}`;
    } else {
      throw new HttpError(400, `Operator tidak didukung server dev: ${op}`);
    }
    where.push(not ? `not (${cond})` : cond);
  }
  return where.length ? ` where ${where.join(' and ')}` : '';
}

function buildOrder(order) {
  if (!order) return '';
  return ' order by ' + order.split(',').map((o) => {
    const [c, dir, nulls] = o.split('.');
    return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`;
  }).join(', ');
}

function buildSelect(sel) {
  if (!sel || sel === '*') return '*';
  return sel.split(',').map((c) => ident(c.trim())).join(', ');
}

function createServer({ pool, jwtSecret, anonKey, anthropicFactory, log = () => {} }) {
  const fnCache = new Map();

  async function fnInfo(client, name) {
    if (fnCache.has(name)) return fnCache.get(name);
    const r = await client.query(
      `select p.proretset as set, format_type(p.prorettype, null) as ret,
              coalesce(p.proargnames, '{}') as names, coalesce(p.proargmodes::text[], '{}') as modes,
              array(select format_type(t, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t) as types
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`, [name]);
    if (!r.rows.length) throw new HttpError(404, `Fungsi public.${name} tidak ditemukan`, 'PGRST202');
    const f = r.rows[0];
    const inputs = [];
    f.types.forEach((t, i) => {
      const mode = f.modes[i] || 'i';
      // format_type tanpa typmod menulis char(n) sebagai "character" (= char(1)); pakai bpchar agar tidak terpotong
      if (mode === 'i' || mode === 'b') inputs.push({ name: f.names[i], type: t === 'character' ? 'bpchar' : t });
    });
    const info = { set: f.set || f.ret === 'record', ret: f.ret, inputs };
    fnCache.set(name, info);
    return info;
  }

  async function withRole(claims, fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : claims.role === 'service_role' ? 'service_role' : 'anon'}`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function rpc(claims, name, args = {}) {
    if (!IDENT.test(name)) throw new HttpError(404, 'Fungsi tidak valid');
    return withRole(claims, async (client) => {
      const info = await fnInfo(client, name);
      const values = [];
      const parts = [];
      for (const inp of info.inputs) {
        if (!(inp.name in args)) continue;
        const v = args[inp.name];
        values.push(v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
        parts.push(`${ident(inp.name)} => $${values.length}::${inp.type}`);
      }
      for (const k of Object.keys(args)) if (!info.inputs.some((i) => i.name === k)) throw new HttpError(400, `Argumen tidak dikenal: ${k}`);
      if (info.set) return (await client.query(`select * from public.${ident(name)}(${parts.join(', ')})`, values)).rows;
      const r = await client.query(`select public.${ident(name)}(${parts.join(', ')}) as v`, values);
      return info.ret === 'void' ? null : r.rows[0].v;
    });
  }

  async function rest(claims, method, table, url, body, prefer) {
    const t = `public.${ident(table)}`;
    const params = [...url.searchParams.entries()];
    const values = [];
    const where = buildWhere(params, values);
    const ret = /return=representation/.test(prefer);
    return withRole(claims, async (client) => {
      if (method === 'GET' || method === 'HEAD') {
        const sel = buildSelect(url.searchParams.get('select'));
        let sql = `select ${sel} from ${t}${where}${buildOrder(url.searchParams.get('order'))}`;
        const lim = url.searchParams.get('limit');
        const off = url.searchParams.get('offset');
        if (lim) sql += ` limit ${Math.max(0, parseInt(lim, 10) || 0)}`;
        if (off) sql += ` offset ${Math.max(0, parseInt(off, 10) || 0)}`;
        const rows = (await client.query(sql, values)).rows;
        let count = null;
        if (/count=exact/.test(prefer)) count = Number((await client.query(`select count(*) as n from ${t}${where}`, values)).rows[0].n);
        return { rows, count, offset: Number(off) || 0 };
      }
      if (method === 'POST') {
        const list = Array.isArray(body) ? body : [body];
        if (!list.length) return { rows: [] };
        const cols = Object.keys(list[0]).map(ident);
        values.push(JSON.stringify(list));
        let sql = `insert into ${t} (${cols.join(', ')}) select ${cols.join(', ')} from json_populate_recordset(null::${t}, $${values.length})`;
        const conflict = url.searchParams.get('on_conflict');
        if (conflict && /resolution=merge-duplicates/.test(prefer)) {
          const keys = conflict.split(',').map(ident);
          const upd = cols.filter((c) => !keys.includes(c));
          sql += ` on conflict (${keys.join(', ')}) do ${upd.length ? `update set ${upd.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'nothing'}`;
        }
        return { rows: (await client.query(`${sql} returning *`, values)).rows, created: true };
      }
      if (method === 'PATCH') {
        const cols = Object.keys(body || {}).map(ident);
        if (!cols.length) throw new HttpError(400, 'Tidak ada kolom yang diubah');
        values.push(JSON.stringify(body));
        const sql = `update ${t} set (${cols.join(', ')}) = (select ${cols.join(', ')} from json_populate_record(null::${t}, $${values.length}))${where} returning *`;
        if (!where) throw new HttpError(400, 'PATCH tanpa filter ditolak');
        return { rows: (await client.query(sql, values)).rows };
      }
      if (method === 'DELETE') {
        if (!where) throw new HttpError(400, 'DELETE tanpa filter ditolak');
        return { rows: (await client.query(`delete from ${t}${where} returning *`, values)).rows };
      }
      throw new HttpError(405, 'Metode tidak didukung');
    }).then((r) => ({ ...r, ret }));
  }

  // ---------------------------------------------------------------- Auth (subset GoTrue)
  const refreshTokens = new Map();
  function session(user) {
    const now = Math.floor(Date.now() / 1000);
    const access = signJwt({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 }, jwtSecret);
    const refresh = crypto.randomBytes(24).toString('hex');
    refreshTokens.set(refresh, user);
    return {
      access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh,
      user: userJson(user),
    };
  }
  function userJson(u) {
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: u.created_at || new Date().toISOString() };
  }

  async function auth(req, res, url, body, claims) {
    const p = url.pathname.replace('/auth/v1', '');
    if (p === '/token' && url.searchParams.get('grant_type') === 'password') {
      const r = await pool.query(
        'select id, email, created_at from auth.users where lower(email) = lower($1) and encrypted_password = crypt($2, encrypted_password)',
        [String(body.email || ''), String(body.password || '')]);
      if (!r.rows.length) return send(res, 400, { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' });
      return send(res, 200, session(r.rows[0]));
    }
    if (p === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const u = refreshTokens.get(body.refresh_token);
      if (!u) return send(res, 400, { code: 'refresh_token_not_found', error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      refreshTokens.delete(body.refresh_token);
      return send(res, 200, session(u));
    }
    if (p === '/user' && req.method === 'PUT') {
      if (claims.role !== 'authenticated') return send(res, 401, { code: 'no_authorization', msg: 'Not logged in' });
      if (body.password !== undefined) {
        if (String(body.password).length < 6) return send(res, 422, { code: 'weak_password', msg: 'Password should be at least 6 characters.' });
        await pool.query("update auth.users set encrypted_password = crypt($2, gen_salt('bf')) where id = $1", [claims.sub, String(body.password)]);
      }
      const r = await pool.query('select id, email, created_at from auth.users where id = $1', [claims.sub]);
      return send(res, 200, userJson(r.rows[0]));
    }
    if (p === '/user') {
      if (claims.role !== 'authenticated') return send(res, 401, { code: 'no_authorization', msg: 'Not logged in' });
      const r = await pool.query('select id, email, created_at from auth.users where id = $1', [claims.sub]);
      return r.rows.length ? send(res, 200, userJson(r.rows[0])) : send(res, 404, { msg: 'User not found' });
    }
    if (p === '/logout') { res.writeHead(204); return res.end(); }
    return send(res, 404, { msg: 'Tidak didukung server dev' });
  }

  // ---------------------------------------------------------------- Edge Function asisten
  async function functions(req, res, url, body, claims, token) {
    const name = url.pathname.replace('/functions/v1/', '');
    if (name === 'pengguna') return fungsiPengguna(res, body, token);
    if (name !== 'asisten') return send(res, 404, { error: 'Fungsi tidak ada' });
    const { jalankanAsisten, dbDariSupabase } = await import(path.join(ROOT, 'supabase/functions/asisten/asisten.mjs'));
    const { createClient } = require('@supabase/supabase-js');
    const base = `http://127.0.0.1:${server.address().port}`;
    const sb = createClient(base, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    try {
      const out = await jalankanAsisten({ anthropic: anthropicFactory(), db: dbDariSupabase(sb), permintaan: body });
      return send(res, 200, out);
    } catch (err) {
      const status = err.status === 401 ? 401 : err.status === 429 ? 429 : err.status >= 500 ? 502 : 400;
      return send(res, status, { error: err.message });
    }
  }

  // Edge Function pengguna: admin Supabase Auth ditiru langsung di tabel auth.users
  async function fungsiPengguna(res, body, token) {
    const { kelolaPengguna } = await import(path.join(ROOT, 'supabase/functions/pengguna/pengguna.mjs'));
    const { createClient } = require('@supabase/supabase-js');
    const base = `http://127.0.0.1:${server.address().port}`;
    const sb = createClient(base, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const db = { rpc: async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(error.message); return data; } };
    const admin = {
      createUser: async ({ email, password }) => {
        try {
          return (await pool.query("insert into auth.users (email, encrypted_password) values ($1, crypt($2, gen_salt('bf'))) returning id", [email, password])).rows[0].id;
        } catch (e) {
          if (e.code === '23505') throw new Error('A user with this email address has already been registered');
          throw e;
        }
      },
      updateUserById: async (id, { password }) => { await pool.query("update auth.users set encrypted_password = crypt($2, gen_salt('bf')) where id = $1", [id, password]); },
      deleteUser: async (id) => { await pool.query('delete from auth.users where id = $1', [id]); },
    };
    try {
      return send(res, 200, await kelolaPengguna({ admin, db, permintaan: body }));
    } catch (err) {
      return send(res, err.status || 500, { error: err.message });
    }
  }

  // ---------------------------------------------------------------- File statis
  const CDN_LOKAL = [
    [/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[\d.]+\/dist\/umd\/supabase\.js/g, '/_vendor/supabase.js'],
    [/https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx@[\d.]+\/dist\/xlsx\.full\.min\.js/g, '/_vendor/xlsx.full.min.js'],
    [/https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx-js-style@[\d.]+\/dist\/xlsx\.min\.js/g, '/_vendor/xlsx-js-style.min.js'],
  ];
  const VENDOR = {
    '/_vendor/supabase.js': require.resolve('@supabase/supabase-js/dist/umd/supabase.js'),
    '/_vendor/xlsx.full.min.js': path.join(path.dirname(require.resolve('xlsx/package.json')), 'dist/xlsx.full.min.js'),
    '/_vendor/xlsx-js-style.min.js': path.join(path.dirname(require.resolve('xlsx-js-style/package.json')), 'dist/xlsx.min.js'),
  };
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

  function serveStatic(req, res, url) {
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      return res.end(`window.MB_CONFIG = ${JSON.stringify({ url: `http://${req.headers.host}`, anonKey, mode: 'dev' })};\n`);
    }
    if (VENDOR[url.pathname]) {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] });
      return fs.createReadStream(VENDOR[url.pathname]).pipe(res);
    }
    let file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Tidak ditemukan'); }
    const ext = path.extname(file);
    if (ext === '.html') {
      let html = fs.readFileSync(file, 'utf8');
      for (const [re, local] of CDN_LOKAL) html = html.replace(re, local);
      res.writeHead(200, { 'Content-Type': TYPES[ext], 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  function send(res, status, obj, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!/^\/(rest|auth|functions)\/v1\//.test(url.pathname)) return serveStatic(req, res, url);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers.apikey;
      const claims = verifyJwt(token, jwtSecret);
      if (!claims) return send(res, 401, { message: 'JWT tidak valid atau kedaluwarsa', code: 'PGRST301' });
      log(`${req.method} ${url.pathname}${url.search} [${claims.role}]`);
      if (url.pathname.startsWith('/auth/v1/')) return auth(req, res, url, body, claims);
      if (url.pathname.startsWith('/functions/v1/')) return functions(req, res, url, body, claims, token);
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const data = await rpc(claims, url.pathname.replace('/rest/v1/rpc/', ''), body);
        return send(res, 200, data === undefined ? null : data);
      }
      const table = url.pathname.replace('/rest/v1/', '');
      const prefer = String(req.headers.prefer || '');
      const r = await rest(claims, req.method, table, url, body, prefer);
      const single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
      const headers = {};
      if (r.count !== null && r.count !== undefined) {
        headers['Content-Range'] = `${r.rows.length ? `${r.offset}-${r.offset + r.rows.length - 1}` : '*'}/${r.count}`;
      }
      if (single) {
        if (r.rows.length !== 1) return send(res, 406, { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `The result contains ${r.rows.length} rows` });
        return send(res, 200, r.rows[0], headers);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, r.rows, headers);
      if (r.ret) return send(res, r.created ? 201 : 200, r.rows, headers);
      res.writeHead(r.created ? 201 : 204, headers);
      return res.end();
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { message: err.message, code: err.code || null });
      if (err && err.code && /^[0-9A-Z]{5}$/.test(err.code)) {
        const status = err.code === '42501' ? 403 : err.code === '28000' ? 400 : err.code === '23505' ? 409 : 400;
        return send(res, status, { message: err.message, code: err.code, details: err.detail || null, hint: err.hint || null });
      }
      console.error('[server dev]', err);
      return send(res, 500, { message: String(err && err.message || err) });
    }
  });
  return server;
}

// ---------------------------------------------------------------- Menjalankan
async function main() {
  const port = Number(arg('--port', process.env.PORT || 54321));
  const dbUrl = process.env.MB_DATABASE_URL || 'postgresql://postgres@localhost/mb_dev';
  const jwtSecret = process.env.MB_JWT_SECRET || crypto.randomBytes(32).toString('hex');
  if (process.argv.includes('--demo')) {
    const { buatDataDemo } = require('./data-demo');
    console.log('Membuat database contoh…');
    const akun = await buatDataDemo(dbUrl);
    console.log('Akun contoh:');
    for (const a of akun) console.log(`  ${a.email} / ${a.password} (${a.peran})`);
  }
  const pool = new Pool({ connectionString: dbUrl });
  const anonKey = signJwt({ role: 'anon', iss: 'mother-base-dev' }, jwtSecret);
  const anthropicFactory = () => {
    const Anthropic = require('@anthropic-ai/sdk');
    if (process.env.ANTHROPIC_API_KEY) return new Anthropic();
    return new Anthropic({ apiKey: 'tiruan', fetch: require('./claude-tiruan').fetchTiruan });
  };
  const server = createServer({ pool, jwtSecret, anonKey, anthropicFactory, log: process.argv.includes('--log') ? console.log : () => {} });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mother base (server dev) di http://127.0.0.1:${port}`);
    console.log(process.env.ANTHROPIC_API_KEY ? 'Asisten AI: Claude sungguhan (ANTHROPIC_API_KEY)' : 'Asisten AI: Claude tiruan (isi ANTHROPIC_API_KEY untuk yang sungguhan)');
  });
}

module.exports = { createServer, signJwt, verifyJwt };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
