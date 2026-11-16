'use strict';
// Pengaturan milik satu komputer saja (mode jaringan & printer), disimpan di device.json.
const fs = require('fs');
const path = require('path');

const PRINTER_KEYS = ['printer_name', 'paper_width', 'auto_print', 'label_printer_name'];
const MODES = ['standalone', 'server', 'client'];

const DEFAULTS = {
  mode: 'standalone',
  server_host: '',
  server_port: 4785,
  pair_key: '', // kode yang diketik di PC kasir
  server_pair_key: '', // kode milik PC gudang (mode server)
  printer_name: '',
  paper_width: '58',
  auto_print: '1',
  label_printer_name: '',
};

function loadDevice(dir) {
  const file = path.join(dir, 'device.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* belum ada */ }
  const out = { ...DEFAULTS, ...data, _exists: fs.existsSync(file) };
  if (!MODES.includes(out.mode)) out.mode = 'standalone';
  return out;
}

function saveDevice(dir, data) {
  const cur = loadDevice(dir);
  const next = { ...cur, ...data };
  delete next._exists;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'device.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  return loadDevice(dir);
}

module.exports = { loadDevice, saveDevice, PRINTER_KEYS, MODES };
