'use strict';
// PIN login: disimpan sebagai hash scrypt dengan salt acak per akun (PIN asli tidak pernah disimpan).
const crypto = require('crypto');

// Manukan = sama persis dengan Gudang, tanpa menu Retur Barang
const ROLES = ['admin', 'gudang', 'manukan', 'kasir'];
const ROLE_LABEL = { admin: 'Admin', gudang: 'Gudang', manukan: 'Manukan', kasir: 'Kasir' };

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}

function checkPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  const a = Buffer.from(hashPin(pin, salt).hash, 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Cocokkan nama + PIN terhadap daftar akun {id, name, role, pin_hash, pin_salt, active}
function matchLogin(users, { name, pin } = {}) {
  const n = String(name || '').trim().toLowerCase();
  const u = (users || []).find((x) => String(x.name).toLowerCase() === n && x.active);
  if (!u || !checkPin(String(pin || ''), u.pin_salt, u.pin_hash)) return null;
  return { id: u.id, name: u.name, role: u.role };
}

module.exports = { ROLES, ROLE_LABEL, hashPin, checkPin, matchLogin };
