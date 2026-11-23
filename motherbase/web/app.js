'use strict';
/* global supabase, XLSX, MbAccurate, MbImportBarang, MbOpnameKantor */
// Mother Base — aplikasi web kantor. Tanpa proses build: satu file, supabase-js & SheetJS dari CDN.
// Semua data dibaca dengan login pengguna; Row Level Security di database yang membatasi akses.

const CFG = window.MB_CONFIG || {};
const sb = CFG.url && !/GANTI/.test(CFG.url) ? supabase.createClient(CFG.url, CFG.anonKey) : null;
const S = { profil: null, toko: [], periode: null, menu: false };

// ================================================================ Utilitas
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => (v === null || v === undefined || v === '' ? '-' : new Intl.NumberFormat('id-ID', { maximumFractionDigits: d }).format(Number(v)));
const rp = (v) => (v === null || v === undefined || v === '' ? '-' : `Rp ${new Intl.NumberFormat('id-ID').format(Math.round(Number(v)))}`);
const hariIni = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const geser = (t, n) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const selisihHari = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
const fmtTgl = (s) => (s ? new Date(String(s).length === 10 ? `${s}T00:00:00Z` : s).toLocaleDateString('id-ID',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: String(s).length === 10 ? 'UTC' : 'Asia/Jakarta' }) : '-');
const fmtWaktu = (s) => (s ? new Date(s).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : '-');
function relatif(s) {
  if (!s) return 'belum pernah';
  const m = Math.round((Date.now() - new Date(s)) / 60000);
  if (m < 2) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  if (m < 60 * 24) return `${Math.round(m / 60)} jam lalu`;
  return `${Math.round(m / 1440)} hari lalu`;
}

function pesanError(e) {
  const m = String((e && (e.message || e.error_description || e.msg)) || e || 'Terjadi kesalahan');
  if (/JWT expired|invalid JWT|JWT tidak valid/i.test(m)) return 'Sesi login habis. Silakan login lagi.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Tidak bisa terhubung ke server. Periksa internet.';
  if (/duplicate key|23505/.test(m)) return 'Data sudah ada (kode / barcode dipakai data lain).';
  if (/row-level security|permission denied/i.test(m)) return 'Anda tidak punya hak untuk tindakan ini.';
  return m;
}
async function q(p) {
  const { data, error } = await p;
  if (error) throw new Error(pesanError(error));
  return data;
}
const rpc = (fn, args) => q(sb.rpc(fn, args || {}));
// Semua baris (Supabase membatasi 1.000 baris per permintaan). buat() membuat query baru tiap halaman.
async function ambilSemua(buat, ukuran = 1000) {
  const semua = [];
  for (let dari = 0; ; dari += ukuran) {
    const rows = await q(buat().range(dari, dari + ukuran - 1));
    semua.push(...rows);
    if (rows.length < ukuran) return semua;
  }
}

function toast(msg, jenis = '') {
  const t = document.createElement('div');
  t.className = `toast ${jenis}`;
  t.textContent = msg;
  $('#toasts').append(t);
  while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  setTimeout(() => t.remove(), jenis === 'bad' ? 8000 : 3500);
}

function modal({ judul, isi, aksi = [], lebar = false, onBuka }) {
  const latar = document.createElement('div');
  latar.className = 'modal-latar';
  latar.innerHTML = `<div class="modal ${lebar ? 'lebar' : ''}" role="dialog" aria-modal="true" aria-label="${esc(judul)}">
    <div class="modal-head"><h3>${esc(judul)}</h3><button class="btn ghost sm tutup" aria-label="Tutup">✕</button></div>
    <div class="modal-isi">${isi}</div>
    ${aksi.length ? `<div class="modal-kaki">${aksi.map((a, i) => `<button class="btn ${a.kelas || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
  </div>`;
  const tutup = () => { latar.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') tutup(); };
  document.addEventListener('keydown', onKey);
  latar.addEventListener('click', async (e) => {
    if (e.target === latar || e.target.closest('.tutup')) return tutup();
    const b = e.target.closest('.modal-kaki [data-i]');
    if (!b) return;
    const a = aksi[Number(b.dataset.i)];
    if (!a.onClick) return tutup();
    b.disabled = true;
    try { await a.onClick({ tutup, el: latar }); } catch (err) { toast(pesanError(err), 'bad'); } finally { b.disabled = false; }
  });
  document.body.append(latar);
  const f = latar.querySelector('input, select, textarea, .modal-kaki .primary');
  if (f) f.focus();
  if (onBuka) onBuka(latar);
  return { el: latar, tutup };
}
function konfirmasi(judul, isi, okLabel = 'Ya', bahaya = false) {
  return new Promise((resolve) => {
    const m = modal({ judul, isi: `<p style="margin:0">${isi}</p>`, aksi: [
      { label: 'Batal', onClick: ({ tutup }) => { tutup(); resolve(false); } },
      { label: okLabel, kelas: bahaya ? 'danger' : 'primary', onClick: ({ tutup }) => { tutup(); resolve(true); } },
    ] });
    m.el.addEventListener('click', (e) => { if (e.target === m.el || e.target.closest('.tutup')) resolve(false); });
  });
}

// kolom: [{ k, judul, num, fmt(v, row), lebar }]
function tabel(kolom, baris, { klik, kosong = 'Tidak ada data.', kunci } = {}) {
  if (!baris || !baris.length) return `<div class="tbl-wrap"><div class="kosong">${esc(kosong)}</div></div>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${kolom.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.judul)}</th>`).join('')}</tr></thead>
    <tbody>${baris.map((r, i) => `<tr ${klik ? `class="klik" data-i="${i}"${kunci ? ` data-k="${esc(r[kunci])}"` : ''} tabindex="0"` : ''}>${kolom.map((c) => {
      const v = c.fmt ? c.fmt(r[c.k], r) : esc(r[c.k] ?? '');
      return `<td class="${c.num ? 'num' : ''}">${v === '' || v === null || v === undefined ? '' : v}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
}
// Klik / Enter pada baris tabel. Dipasang sekali per elemen; data & aksi diganti setiap tabel dimuat ulang.
function onBaris(el, baris, fn) {
  el._baris = { baris, fn };
  if (el._barisPasang) return;
  el._barisPasang = true;
  const pilih = (tr) => { const b = el._baris.baris[Number(tr.dataset.i)]; if (b) el._baris.fn(b); };
  el.addEventListener('click', (e) => { const tr = e.target.closest('tr.klik'); if (tr && !e.target.closest('button, input, select, a')) pilih(tr); });
  el.addEventListener('keydown', (e) => { const tr = e.target.closest('tr.klik'); if (tr && e.key === 'Enter') pilih(tr); });
}

function unduhCsv(nama, kolom, baris) {
  const sel = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const isi = '﻿' + [kolom.map((c) => c.judul), ...baris.map((r) => kolom.map((c) => r[c.k]))].map((r) => r.map(sel).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([isi], { type: 'text/csv;charset=utf-8' }));
  a.download = nama;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function salin(teks) {
  try { await navigator.clipboard.writeText(teks); toast('Disalin.'); } catch (_) { toast('Salin manual: pilih teksnya lalu Ctrl+C.'); }
}

async function sibuk(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(pesanError(e), 'bad'); return undefined; } finally { btn.disabled = false; }
}

const peran = () => S.profil && S.profil.peran;
const isOwner = () => peran() === 'owner';
const isKantor = () => ['owner', 'admin_kantor', 'gudang', 'purchasing'].includes(peran());
const LABEL_PERAN = { owner: 'Owner', admin_kantor: 'Admin kantor', gudang: 'Gudang', purchasing: 'Purchasing', pemilik_toko: 'Pemilik toko' };
const namaToko = (k) => { const t = S.toko.find((x) => x.kode === k); return t ? t.nama : k || '-'; };
const head = (judul, ket, kanan = '') => `<div class="page-head"><div><h1>${esc(judul)}</h1>${ket ? `<p>${ket}</p>` : ''}</div>${kanan ? `<div class="row">${kanan}</div>` : ''}</div>`;
const pilihToko = (id, nilai = '', semua = 'Semua toko') => `<select id="${id}" aria-label="Toko">${semua ? `<option value="">${esc(semua)}</option>` : ''}${S.toko.map((t) =>
  `<option value="${esc(t.kode)}" ${t.kode === nilai ? 'selected' : ''}>${esc(t.kode)} · ${esc(t.nama)}</option>`).join('')}</select>`;

// Periode bersama semua halaman laporan
function periode() {
  if (!S.periode) S.periode = { dari: geser(hariIni(), -6), sampai: hariIni(), pilihan: '7' };
  return S.periode;
}
function kontrolPeriode() {
  const p = periode();
  return `<select id="perPilih" aria-label="Periode">
      <option value="hari" ${p.pilihan === 'hari' ? 'selected' : ''}>Hari ini</option>
      <option value="7" ${p.pilihan === '7' ? 'selected' : ''}>7 hari terakhir</option>
      <option value="30" ${p.pilihan === '30' ? 'selected' : ''}>30 hari terakhir</option>
      <option value="bulan" ${p.pilihan === 'bulan' ? 'selected' : ''}>Bulan ini</option>
      <option value="bulanlalu" ${p.pilihan === 'bulanlalu' ? 'selected' : ''}>Bulan lalu</option>
      <option value="atur" ${p.pilihan === 'atur' ? 'selected' : ''}>Pilih tanggal…</option>
    </select>
    <input type="date" id="perDari" value="${p.dari}" aria-label="Dari tanggal"> <span class="muted">s/d</span>
    <input type="date" id="perSampai" value="${p.sampai}" aria-label="Sampai tanggal">`;
}
function pasangPeriode(el, onUbah) {
  const p = periode();
  $('#perPilih', el).addEventListener('change', (e) => {
    const v = e.target.value;
    const h = hariIni();
    p.pilihan = v;
    if (v === 'hari') { p.dari = h; p.sampai = h; }
    if (v === '7') { p.dari = geser(h, -6); p.sampai = h; }
    if (v === '30') { p.dari = geser(h, -29); p.sampai = h; }
    if (v === 'bulan') { p.dari = `${h.slice(0, 8)}01`; p.sampai = h; }
    if (v === 'bulanlalu') { const awal = `${h.slice(0, 8)}01`; p.sampai = geser(awal, -1); p.dari = `${p.sampai.slice(0, 8)}01`; }
    $('#perDari', el).value = p.dari;
    $('#perSampai', el).value = p.sampai;
    onUbah();
  });
  for (const id of ['#perDari', '#perSampai']) {
    $(id, el).addEventListener('change', () => {
      p.dari = $('#perDari', el).value || p.dari;
      p.sampai = $('#perSampai', el).value || p.sampai;
      if (p.dari > p.sampai) [p.dari, p.sampai] = [p.sampai, p.dari];
      p.pilihan = 'atur';
      $('#perPilih', el).value = 'atur';
      onUbah();
    });
  }
}

function tabs(id, daftar, aktif) {
  return `<div class="tabs" id="${id}" role="tablist">${daftar.map(([k, l]) => `<button role="tab" data-t="${k}" class="${k === aktif ? 'aktif' : ''}" aria-selected="${k === aktif}">${esc(l)}</button>`).join('')}</div>`;
}
function pasangTabs(el, id, onPilih) {
  $(`#${id}`, el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    $$(`#${id} button`, el).forEach((x) => { x.classList.toggle('aktif', x === b); x.setAttribute('aria-selected', x === b); });
    onPilih(b.dataset.t);
  });
}

const STATUS_SJ = {
  COCOK: ['ok', 'Cocok'], MENUNGGU: ['info', 'Menunggu'], BELUM_DIINPUT: ['bad', 'Belum diinput'], SELISIH_QTY: ['warn', 'Selisih qty'],
  BARANG_SALAH: ['bad', 'Barang salah'], SATUAN_BELUM_JELAS: ['warn', 'Satuan belum jelas'], PELANGGAN_BELUM_DIPETAKAN: ['warn', 'Pelanggan belum dipetakan'],
};
const STATUS_PO = { USULAN: ['warn', 'Usulan'], DISETUJUI: ['info', 'Disetujui'], DIKIRIM: ['info', 'Dikirim ke pemasok'], SEBAGIAN: ['warn', 'Diterima sebagian'], SELESAI: ['ok', 'Selesai'], BATAL: ['', 'Batal'] };
const pill = (map, v) => { const [k, l] = map[v] || ['', v]; return `<span class="pill ${k}">${esc(l)}</span>`; };
// Nota BTL- dari Trizone = pembatalan (disetujui di toko dengan PIN). Omzet sudah bersih; kolom ini menampilkan nilainya.
const fmtBatal = (v, r) => (Number(r.jumlah_pembatalan) ? `<span class="pill warn">${rp(v)}</span> <span class="muted small">${num(r.jumlah_pembatalan)} nota</span>` : '<span class="muted">-</span>');

// ================================================================ Halaman
const HALAMAN = [
  { id: 'ringkasan', judul: 'Ringkasan', ikon: '◧', untuk: 'semua' },
  { id: 'penjualan', judul: 'Penjualan', ikon: '▤', untuk: 'semua' },
  { id: 'pembatalan', judul: 'Pembatalan Nota', ikon: '⊘', untuk: 'semua' },
  { id: 'pesanan', judul: 'Pesanan Pelanggan', ikon: '⧉', untuk: 'semua' },
  { id: 'stok', judul: 'Stok', ikon: '▦', untuk: 'semua' },
  { id: 'opname', judul: 'Stock Opname', ikon: '▣', untuk: 'kantor' },
  { id: 'kiriman', judul: 'Surat Jalan', ikon: '⇄', untuk: 'kantor' },
  { id: 'pembelian', judul: 'Pembelian', ikon: '⊕', untuk: 'kantor' },
  { id: 'barang', judul: 'Master Barang', ikon: '☰', untuk: 'kantor' },
  { id: 'toko', judul: 'Toko', ikon: '⌂', untuk: 'kantor' },
  { id: 'asisten', judul: 'Asisten AI', ikon: '✦', untuk: 'semua' },
  { id: 'pengguna', judul: 'Pengguna', ikon: '☺', untuk: 'owner' },
];
const boleh = (h) => h.untuk === 'semua' || (h.untuk === 'kantor' && isKantor()) || (h.untuk === 'owner' && isOwner());

// ---------------------------------------------------------------- Tarik data terbaru dari toko
// Homebase tidak bisa menghubungi PC toko langsung: tombol "Tarik data terbaru" membuat permintaan, Trizone (1.23.0)
// memeriksanya tiap 5 menit lalu langsung mengirim penjualan & stok. Halaman memantau sampai datanya masuk.
const PANTAU = { ms: 10000, batas: 10 * 60 * 1000 };
const tombolTarik = (id, label = 'Tarik data terbaru') => `<button class="btn sm" id="${id}" title="Minta toko mengirim penjualan & stok sekarang (biasanya tiap 3 jam / tutup shift)">${esc(label)}</button>`;

async function tarikData(kode, onMasuk, btn) {
  if (btn) btn.disabled = true;
  try {
    S.toko = await rpc('status_koneksi_toko');
    const n = await rpc('minta_update_toko', { p_kode_toko: kode || null });
    toast(`Permintaan dikirim ke ${kode || `${n} toko`}. Data masuk dalam ±5 menit bila PC toko menyala & online.`);
  } catch (e) {
    toast(pesanError(e), 'bad');
    if (btn) btn.disabled = false;
    return;
  }
  pantauKiriman(kode ? [kode] : S.toko.filter((t) => t.aktif && t.punya_kunci).map((t) => t.kode), onMasuk, btn);
}

// Tunggu kiriman baru dari toko (kiriman_terakhir_at berubah). Berhenti saat pindah halaman atau setelah 10 menit.
function pantauKiriman(kodes, onMasuk, btn) {
  const ini = rute;
  const awal = Object.fromEntries(S.toko.map((t) => [t.kode, t.kiriman_terakhir_at || '']));
  const tunggu = new Set(kodes);
  const mulai = Date.now();
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Menunggu toko…'; }
  const selesai = () => { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } };
  const cek = async () => {
    if (ini !== rute) return;
    try { S.toko = await rpc('status_koneksi_toko'); } catch (_) { /* dicoba lagi */ }
    if (ini !== rute) return;
    const masuk = S.toko.filter((t) => tunggu.has(t.kode) && (t.kiriman_terakhir_at || '') !== awal[t.kode]).map((t) => t.kode);
    if (masuk.length) {
      masuk.forEach((k) => tunggu.delete(k));
      toast(`Data terbaru ${masuk.join(', ')} sudah masuk.`, 'ok');
      if (onMasuk) { try { await onMasuk(masuk); } catch (e) { toast(pesanError(e), 'bad'); } }
    }
    if (tunggu.size && Date.now() - mulai < PANTAU.batas) { setTimeout(cek, PANTAU.ms); return; }
    selesai();
    if (tunggu.size) toast(`Belum ada data dari ${[...tunggu].join(', ')}. PC toko mungkin mati / offline, atau Trizone belum versi 1.23.0. Permintaan tetap berlaku sampai toko mengirim.`);
  };
  if (!tunggu.size) { selesai(); return; }
  setTimeout(cek, PANTAU.ms);
}

// ---------------------------------------------------------------- Ringkasan
async function hRingkasan(el) {
  el.innerHTML = `${head('Ringkasan', 'Penjualan toko dan hal yang perlu ditindaklanjuti.', `${kontrolPeriode()}${tombolTarik('rkTarik')}`)}
    <div class="grid g4" id="rkStat"></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="card-head"><h2>Omzet harian</h2><span class="muted small" id="rkChartKet"></span></div><div id="rkChart"></div></div>
      <div class="card"><h2>Perlu perhatian</h2><ul class="daftar-perhatian" id="rkPerhatian"><li class="muted">Memuat…</li></ul></div>
    </div>
    <div class="card"><div class="card-head"><h2>Per toko</h2><button class="btn sm" id="rkCsv">Unduh CSV</button></div><div id="rkToko"></div></div>`;
  pasangPeriode(el, () => muat());
  let tokoRows = [];
  const kolomToko = [
    { k: 'kode_toko', judul: 'Toko', fmt: (v) => `<b>${esc(v)}</b> <span class="muted">${esc(namaToko(v))}</span>` },
    { k: 'omzet', judul: 'Omzet', num: true, fmt: rp },
    { k: 'jumlah_transaksi', judul: 'Transaksi', num: true, fmt: (v) => num(v) },
    { k: 'tunai', judul: 'Tunai', num: true, fmt: rp }, { k: 'qris', judul: 'QRIS', num: true, fmt: rp }, { k: 'transfer', judul: 'Transfer', num: true, fmt: rp },
    { k: 'pembatalan', judul: 'Pembatalan', num: true, fmt: fmtBatal },
    { k: 'kiriman', judul: 'Data terakhir masuk', fmt: (v) => esc(relatif(v)) },
  ];
  $('#rkCsv', el).addEventListener('click', () => unduhCsv(`ringkasan_${periode().dari}_${periode().sampai}.csv`, kolomToko, tokoRows));
  $('#rkTarik', el).addEventListener('click', (e) => tarikData(null, () => Promise.all([muat(), perhatian()]), e.currentTarget));

  async function muat() {
    const p = periode();
    const [rk, harian] = await Promise.all([
      rpc('laporan_ringkasan', { p_dari: p.dari, p_sampai: p.sampai }),
      rpc('laporan_harian', { p_dari: p.dari, p_sampai: p.sampai }),
    ]);
    const omzet = rk.reduce((a, r) => a + Number(r.omzet), 0);
    const trx = rk.reduce((a, r) => a + Number(r.jumlah_transaksi), 0);
    const hari = selisihHari(p.dari, p.sampai) + 1;
    $('#rkStat', el).innerHTML = [
      ['Omzet', rp(omzet), `${num(hari)} hari · ${fmtTgl(p.dari)} – ${fmtTgl(p.sampai)}`],
      ['Transaksi', num(trx), `${num(trx / hari, 1)} per hari`],
      ['Rata-rata per struk', trx ? rp(omzet / trx) : '-', 'omzet ÷ transaksi'],
      ['Toko berjualan', `${num(rk.filter((r) => Number(r.omzet) > 0).length)} / ${num(S.toko.length)}`, 'toko dengan penjualan di periode ini'],
    ].map(([l, v, s]) => `<div class="card stat"><div class="label">${l}</div><div class="nilai">${v}</div><div class="sub">${s}</div></div>`).join('');
    $('#rkChart', el).innerHTML = grafikHarian(harian, p);
    $('#rkChartKet', el).textContent = 'semua toko';
    const status = Object.fromEntries(S.toko.map((t) => [t.kode, t]));
    tokoRows = S.toko.map((t) => ({ kode_toko: t.kode, omzet: 0, jumlah_transaksi: 0, tunai: 0, qris: 0, transfer: 0, pembatalan: 0, jumlah_pembatalan: 0,
      ...(rk.find((r) => r.kode_toko === t.kode) || {}),
      kiriman: status[t.kode] && status[t.kode].kiriman_terakhir_at }));
    $('#rkToko', el).innerHTML = tabel(kolomToko, tokoRows);
  }

  async function perhatian() {
    const li = [];
    if (isKantor()) {
      const kemarin = geser(hariIni(), -1);
      const [belum, sj, so, po] = await Promise.all([
        rpc('laporan_belum_masuk', { p_tanggal: kemarin }),
        q(sb.from('v_pencocokan_sj').select('status').in('status', ['BELUM_DIINPUT', 'SELISIH_QTY', 'BARANG_SALAH', 'SATUAN_BELUM_JELAS', 'PELANGGAN_BELUM_DIPETAKAN']).limit(2000)),
        q(sb.from('stok_opname_review').select('no_op').eq('status', 'BARU').limit(2000)),
        q(sb.from('po').select('no_po').eq('status', 'USULAN').limit(500)),
      ]);
      if (belum.length) li.push(['bad', `${belum.length} toko belum menutup shift ${fmtTgl(kemarin)}`, belum.map((b) => b.kode).join(', '), 'toko']);
      if (sj.length) li.push(['warn', `${sj.length} surat jalan perlu dicek`, '', 'kiriman']);
      if (so.length) li.push(['warn', `${so.length} stok opname menunggu review`, '', 'opname']);
      if (po.length) li.push([isOwner() ? 'warn' : 'info', `${po.length} usulan PO ${isOwner() ? 'menunggu persetujuan Anda' : 'menunggu persetujuan owner'}`, '', 'pembelian']);
      const opk = await q(sb.from('opname_kantor').select('no_dok,kode_toko').eq('status', 'dikirim').lt('dibuat_at', new Date(Date.now() - 3600e3).toISOString()).limit(500)).catch(() => []);
      if (opk.length) li.push(['warn', `${opk.length} opname kantor belum diterapkan toko (lebih dari 1 jam)`, [...new Set(opk.map((o) => o.kode_toko))].join(', '), 'opname']);
    }
    const lambat = S.toko.filter((t) => !t.kiriman_terakhir_at || Date.now() - new Date(t.kiriman_terakhir_at) > 26 * 3600e3);
    if (lambat.length && isKantor()) li.push(['info', `${lambat.length} toko belum mengirim data lebih dari sehari`, lambat.map((t) => t.kode).join(', '), 'toko']);
    // Gagal (mis. migrasi pembatalan belum dijalankan) tidak menyembunyikan butir lain
    const batal = await rpc('laporan_pembatalan', { p_dari: geser(hariIni(), -6), p_sampai: hariIni(), p_batas: 2000 }).catch(() => []);
    if (batal.length) li.push(['info', `${batal.length} nota dibatalkan dalam 7 hari terakhir`, [...new Set(batal.map((b) => b.kode_toko))].join(', '), 'pembatalan']);
    const pesananLewat = (await rpc('laporan_pesanan', { p_status: 'baru', p_batas: 5000 }).catch(() => [])).filter((r) => r.lewat);
    if (pesananLewat.length) {
      li.push(['warn', `${pesananLewat.length} pesanan pelanggan lewat tanggal ambil`, [...new Set(pesananLewat.map((r) => r.kode_toko))].join(', '), 'pesanan']);
    }
    $('#rkPerhatian', el).innerHTML = li.length ? li.map(([k, t, s, hal, tab]) =>
      `<li><span class="pill ${k}">${k === 'bad' ? 'Penting' : k === 'warn' ? 'Cek' : 'Info'}</span><span>${esc(t)}${s ? ` <span class="muted small">${esc(s)}</span>` : ''}</span><a href="#${hal}" class="small"${tab ? ` data-tab="${tab}"` : ''}>Buka</a></li>`).join('')
      : '<li class="muted">Tidak ada yang perlu ditindaklanjuti.</li>';
  }
  $('#rkPerhatian', el).addEventListener('click', (e) => { const a = e.target.closest('a[data-tab]'); if (a) S.tabPenjualan = a.dataset.tab; });

  await Promise.all([muat(), perhatian().catch((e) => { $('#rkPerhatian', el).innerHTML = `<li class="muted">${esc(pesanError(e))}</li>`; })]);
}

function grafikHarian(rows, p) {
  const n = selisihHari(p.dari, p.sampai) + 1;
  if (n > 120) return '<div class="kosong">Grafik ditampilkan untuk periode sampai 120 hari.</div>';
  const peta = Object.fromEntries(rows.map((r) => [r.tanggal, Number(r.omzet)]));
  const data = Array.from({ length: n }, (_, i) => { const t = geser(p.dari, i); return { t, v: peta[t] || 0 }; });
  const max = Math.max(...data.map((d) => d.v), 1);
  const W = 700; const H = 180; const kiri = 64; const bawah = 22; const atas = 8;
  const lebar = (W - kiri - 4) / n;
  const y = (v) => atas + (H - atas - bawah) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const label = (v) => (v >= 1e6 ? `${num(v / 1e6, 1)} jt` : v >= 1e3 ? `${num(v / 1e3)} rb` : num(v));
  const tLabel = (t) => new Date(`${t}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const idxLabel = n <= 8 ? data.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik omzet harian">
    ${ticks.map((v) => `<line class="grid-l" x1="${kiri}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${kiri - 6}" y="${y(v) + 4}" text-anchor="end">${label(v)}</text>`).join('')}
    ${data.map((d, i) => { const libur = [0, 6].includes(new Date(`${d.t}T00:00:00Z`).getUTCDay());
      return `<rect class="bar${libur ? ' libur' : ''}" x="${kiri + i * lebar + lebar * 0.15}" y="${y(d.v)}" width="${Math.max(lebar * 0.7, 1)}" height="${H - bawah - y(d.v)}" rx="2"><title>${tLabel(d.t)}: ${rp(d.v)}</title></rect>`; }).join('')}
    ${idxLabel.map((i) => `<text x="${kiri + i * lebar + lebar / 2}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${tLabel(data[i].t)}</text>`).join('')}
  </svg>`;
}

// ---------------------------------------------------------------- Penjualan
async function hPenjualan(el) {
  let tab = S.tabPenjualan || 'produk';
  el.innerHTML = `${head('Penjualan', 'Penjualan per produk, tren, analisa ABC, per kasir, dan pembatalan nota. Omzet sudah dikurangi pembatalan.', `${kontrolPeriode()}${pilihToko('pjToko')}${tombolTarik('pjTarik')}`)}
    ${tabs('pjTab', [['produk', 'Per produk'], ['tren', 'Naik / turun'], ['abc', 'Analisa ABC'], ['kasir', 'Per kasir'], ['harian', 'Per hari'], ['batal', 'Pembatalan']], tab)}
    <div class="card"><div class="card-head"><h2 id="pjJudul"></h2><div class="row"><select id="pjUrut" aria-label="Urutkan"><option value="nilai">Urut nilai</option><option value="qty">Urut qty</option></select>
    <button class="btn sm" id="pjCsv">Unduh CSV</button></div></div><div id="pjIsi"><div class="kosong">Memuat…</div></div></div>`;
  let kolom = []; let baris = [];
  pasangPeriode(el, muat);
  pasangTabs(el, 'pjTab', (t) => { tab = t; S.tabPenjualan = t; muat(); });
  $('#pjToko', el).addEventListener('change', muat);
  $('#pjTarik', el).addEventListener('click', (e) => tarikData($('#pjToko', el).value || null, () => muat(), e.currentTarget));
  $('#pjUrut', el).addEventListener('change', muat);
  $('#pjCsv', el).addEventListener('click', () => unduhCsv(`penjualan_${tab}_${periode().dari}_${periode().sampai}.csv`, kolom, baris));

  async function muat() {
    const p = periode();
    const toko = $('#pjToko', el).value || null;
    $('#pjUrut', el).classList.toggle('hidden', tab !== 'produk');
    const isi = $('#pjIsi', el);
    isi.innerHTML = '<div class="kosong">Memuat…</div>';
    try {
      if (tab === 'produk') {
        $('#pjJudul', el).textContent = 'Penjualan per produk';
        baris = await rpc('laporan_penjualan_produk', { p_dari: p.dari, p_sampai: p.sampai, p_kode_toko: toko, p_urut: $('#pjUrut', el).value, p_batas: 500 });
        kolom = [{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
          { k: 'qty', judul: 'Qty (Biji)', num: true, fmt: (v) => num(v) }, { k: 'nilai', judul: 'Nilai', num: true, fmt: rp },
          { k: 'jumlah_toko', judul: 'Toko', num: true, fmt: (v) => num(v) }];
      } else if (tab === 'tren') {
        const len = selisihHari(p.dari, p.sampai) + 1;
        const db = geser(p.dari, -len); const sb2 = geser(p.dari, -1);
        $('#pjJudul', el).textContent = `${fmtTgl(p.dari)} – ${fmtTgl(p.sampai)} dibanding ${fmtTgl(db)} – ${fmtTgl(sb2)}`;
        baris = await rpc('laporan_tren_produk', { p_dari: p.dari, p_sampai: p.sampai, p_dari_banding: db, p_sampai_banding: sb2, p_kode_toko: toko, p_batas: 200 });
        kolom = [{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
          { k: 'qty_periode', judul: 'Periode ini', num: true, fmt: (v) => num(v) }, { k: 'qty_banding', judul: 'Pembanding', num: true, fmt: (v) => num(v) },
          { k: 'selisih', judul: 'Selisih', num: true, fmt: (v) => `<span class="pill ${Number(v) > 0 ? 'ok' : Number(v) < 0 ? 'bad' : ''}">${Number(v) > 0 ? '▲ ' : Number(v) < 0 ? '▼ ' : ''}${num(Math.abs(v))}</span>` },
          { k: 'persen', judul: '%', num: true, fmt: (v) => (v === null ? 'baru' : `${num(v, 1)}%`) }];
      } else if (tab === 'abc') {
        $('#pjJudul', el).textContent = 'Analisa ABC (A = penyumbang 80% omzet pertama)';
        baris = await rpc('laporan_abc', { p_dari: p.dari, p_sampai: p.sampai, p_kode_toko: toko });
        kolom = [{ k: 'kelas', judul: 'Kelas', fmt: (v) => `<span class="pill ${v === 'A' ? 'ok' : v === 'B' ? 'info' : ''}">${esc(v)}</span>` },
          { k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
          { k: 'nilai', judul: 'Nilai', num: true, fmt: rp }, { k: 'persen', judul: '% omzet', num: true, fmt: (v) => `${num(v, 1)}%` },
          { k: 'persen_kumulatif', judul: '% kumulatif', num: true, fmt: (v) => `${num(v, 1)}%` }];
      } else if (tab === 'kasir') {
        $('#pjJudul', el).textContent = 'Penjualan per kasir dan metode bayar';
        let qy = sb.from('v_penjualan_kasir').select('*').gte('tanggal', p.dari).lte('tanggal', p.sampai).limit(5000);
        if (toko) qy = qy.eq('kode_toko', toko);
        const rows = await q(qy);
        const g = new Map();
        for (const r of rows) {
          const k = `${r.kode_toko}|${r.kasir}`;
          if (!g.has(k)) g.set(k, { kode_toko: r.kode_toko, kasir: r.kasir, TUNAI: 0, QRIS: 0, TRANSFER: 0, total: 0, struk: 0, pembatalan: 0, jumlah_pembatalan: 0 });
          const x = g.get(k);
          x[r.metode] = (x[r.metode] || 0) + Number(r.nilai);
          x.total += Number(r.nilai);
          x.struk += Number(r.jumlah_struk);
          x.pembatalan += Number(r.pembatalan || 0);
          x.jumlah_pembatalan += Number(r.jumlah_pembatalan || 0);
        }
        baris = [...g.values()].sort((a, b) => b.total - a.total);
        kolom = [{ k: 'kode_toko', judul: 'Toko' }, { k: 'kasir', judul: 'Kasir' }, { k: 'struk', judul: 'Struk', num: true, fmt: (v) => num(v) },
          { k: 'TUNAI', judul: 'Tunai', num: true, fmt: rp }, { k: 'QRIS', judul: 'QRIS', num: true, fmt: rp }, { k: 'TRANSFER', judul: 'Transfer', num: true, fmt: rp },
          { k: 'pembatalan', judul: 'Pembatalan', num: true, fmt: fmtBatal }, { k: 'total', judul: 'Total', num: true, fmt: rp }];
      } else if (tab === 'batal') {
        $('#pjJudul', el).textContent = 'Pembatalan nota (disetujui di toko dengan PIN)';
        baris = await rpc('laporan_pembatalan', { p_dari: p.dari, p_sampai: p.sampai, p_kode_toko: toko, p_batas: 2000 });
        kolom = KOLOM_BATAL;
        isi.innerHTML = tabel(kolom, baris, { klik: true, kosong: 'Tidak ada nota yang dibatalkan di periode ini.' });
        onBaris(isi, baris, detailBatal);
        return;
      } else {
        $('#pjJudul', el).textContent = 'Penjualan per hari';
        baris = await rpc('laporan_harian', { p_dari: p.dari, p_sampai: p.sampai, p_kode_toko: toko });
        kolom = [{ k: 'tanggal', judul: 'Tanggal', fmt: (v) => esc(fmtTgl(v)) }, { k: 'jumlah_transaksi', judul: 'Transaksi', num: true, fmt: (v) => num(v) },
          { k: 'pembatalan', judul: 'Pembatalan', num: true, fmt: fmtBatal }, { k: 'omzet', judul: 'Omzet', num: true, fmt: rp }];
      }
      isi.innerHTML = tabel(kolom, baris, { kosong: 'Tidak ada penjualan di periode ini.' });
    } catch (e) { isi.innerHTML = `<div class="kosong">${esc(pesanError(e))}</div>`; }
  }
  await muat();
}

const KOLOM_BATAL = [
  { k: 'waktu', judul: 'Waktu batal', fmt: (v) => esc(fmtWaktu(v)) },
  { k: 'kode_toko', judul: 'Toko', fmt: (v) => `<b>${esc(v)}</b> <span class="muted">${esc(namaToko(v))}</span>` },
  { k: 'no_struk_asal', judul: 'Nota asal', fmt: (v, r) => `<span class="mono">${esc(v || '-')}</span>${r.waktu_struk_asal ? ` <span class="muted small">${esc(fmtWaktu(r.waktu_struk_asal))}</span>` : ''}` },
  { k: 'total', judul: 'Total', num: true, fmt: rp },
  { k: 'alasan', judul: 'Alasan' },
  { k: 'diminta_oleh', judul: 'Diminta oleh' },
  { k: 'disetujui_oleh', judul: 'Disetujui oleh', fmt: (v) => (v ? `<b>${esc(v)}</b>` : '<span class="muted">-</span>') },
  { k: 'no_batal', judul: 'No. pembatalan', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
];

// Rincian satu pembatalan: barang di nota BTL- (baris minus di penjualan) ditampilkan positif
async function detailBatal(b) {
  const rows = await q(sb.from('penjualan').select('baris_ke,sku,nama,qty,harga,subtotal').eq('kode_toko', b.kode_toko)
    .eq('shift_uid', b.shift_uid).eq('no_struk', b.no_batal).order('baris_ke'));
  const barang = rows.map((r) => ({ ...r, qty: -Number(r.qty), subtotal: -Number(r.subtotal) }));
  const info = [['Toko', `${b.kode_toko} · ${namaToko(b.kode_toko)}`], ['Nota asal', `${b.no_struk_asal || '-'}${b.waktu_struk_asal ? ` (${fmtWaktu(b.waktu_struk_asal)})` : ''}`],
    ['Dibatalkan', fmtWaktu(b.waktu)], ['Kasir shift', b.kasir || '-'], ['Diminta oleh', b.diminta_oleh || '-'], ['Disetujui oleh (PIN)', b.disetujui_oleh || '-'],
    ['Alasan', b.alasan || '-'], ['Total', rp(b.total)]];
  modal({
    judul: `Pembatalan ${b.no_batal}`, lebar: true,
    isi: `<table class="tbl" style="margin-bottom:12px"><tbody>${info.map(([k, v]) => `<tr><td class="muted" style="width:180px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
      ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
        { k: 'qty', judul: 'Qty (Biji)', num: true, fmt: (v) => num(v) }, { k: 'harga', judul: 'Harga', num: true, fmt: rp },
        { k: 'subtotal', judul: 'Subtotal', num: true, fmt: rp }], barang, { kosong: 'Rincian barang belum masuk.' })}
      <p class="muted small">Nota asal tidak dihapus. Pembatalan tercatat sebagai nota baru berisi barang minus, jadi omzet dan stok toko sudah terkoreksi.</p>`,
    aksi: [{ label: 'Tutup', kelas: 'primary' }],
  });
}

// ---------------------------------------------------------------- Pembatalan nota (riwayat per toko & per nota)
async function hPembatalan(el) {
  const RENTANG = [['30', '30 hari terakhir'], ['90', '90 hari terakhir'], ['tahun', 'Tahun ini'], ['semua', 'Semua riwayat'], ['atur', 'Pilih tanggal…']];
  const st = S.pembatalan || (S.pembatalan = { pilihan: 'semua', dari: '2000-01-01', sampai: hariIni(), toko: '' });
  if (st.pilihan === 'semua') st.sampai = hariIni();
  el.innerHTML = `${head('Pembatalan Nota', 'Riwayat nota yang dibatalkan di toko: ringkasan per toko dan rincian per nota (nota asal, alasan, yang meminta, dan yang menyetujui dengan PIN). Klik toko untuk melihat notanya saja, klik nota untuk rincian barang.',
    `<select id="btRentang" aria-label="Rentang">${RENTANG.map(([v, l]) => `<option value="${v}" ${st.pilihan === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
     <input type="date" id="btDari" value="${st.dari}" aria-label="Dari tanggal"> <span class="muted">s/d</span>
     <input type="date" id="btSampai" value="${st.sampai}" aria-label="Sampai tanggal">${pilihToko('btPilihToko', st.toko)}`)}
    <div class="card"><div class="card-head"><div><h2>Per toko</h2><div class="muted small" id="btRingkas"></div></div><button class="btn sm" id="btCsvToko">Unduh CSV</button></div><div id="btPerToko"></div></div>
    <div class="card"><div class="card-head"><h2 id="btJudulNota">Per nota</h2><button class="btn sm" id="btCsvNota">Unduh CSV</button></div><div id="btPerNota"></div></div>`;

  const KOLOM_TOKO = [
    { k: 'kode_toko', judul: 'Toko', fmt: (v) => `<b>${esc(v)}</b> <span class="muted">${esc(namaToko(v))}</span>` },
    { k: 'jumlah', judul: 'Nota batal', num: true, fmt: (v) => num(v) },
    { k: 'nilai', judul: 'Nilai batal', num: true, fmt: rp },
    { k: 'kotor', judul: 'Penjualan kotor', num: true, fmt: rp },
    { k: 'persen', judul: '% batal', num: true, fmt: (v) => `${num(v, 2)}%` },
    { k: 'terakhir', judul: 'Batal terakhir', fmt: (v) => esc(v ? fmtWaktu(v) : '-') },
  ];
  let perToko = [];
  let perNota = [];

  async function muat() {
    const boxToko = $('#btPerToko', el);
    const boxNota = $('#btPerNota', el);
    try {
      const [ring, nota] = await Promise.all([
        rpc('laporan_ringkasan', { p_dari: st.dari, p_sampai: st.sampai }),
        rpc('laporan_pembatalan', { p_dari: st.dari, p_sampai: st.sampai, p_kode_toko: st.toko || null, p_batas: 2000 }),
      ]);
      const terakhir = {};
      for (const n of nota) if (!terakhir[n.kode_toko] || n.waktu > terakhir[n.kode_toko]) terakhir[n.kode_toko] = n.waktu;
      perToko = ring.filter((r) => Number(r.jumlah_pembatalan) > 0 && (!st.toko || r.kode_toko === st.toko)).map((r) => {
        const kotor = Number(r.omzet) + Number(r.pembatalan);
        return { kode_toko: r.kode_toko, jumlah: Number(r.jumlah_pembatalan), nilai: Number(r.pembatalan), kotor,
          persen: kotor > 0 ? Math.round((Number(r.pembatalan) / kotor) * 10000) / 100 : 0, terakhir: terakhir[r.kode_toko] || null };
      }).sort((a, b) => b.nilai - a.nilai);
      perNota = nota;
      const tot = perToko.reduce((a, r) => ({ jumlah: a.jumlah + r.jumlah, nilai: a.nilai + r.nilai, kotor: a.kotor + r.kotor }), { jumlah: 0, nilai: 0, kotor: 0 });
      $('#btRingkas', el).textContent = perToko.length
        ? `${num(tot.jumlah)} nota dibatalkan · ${rp(tot.nilai)} · ${num(tot.kotor ? (tot.nilai / tot.kotor) * 100 : 0, 2)}% dari penjualan kotor`
        : '';
      boxToko.innerHTML = tabel(KOLOM_TOKO, perToko, { klik: true, kosong: 'Tidak ada nota yang dibatalkan di rentang ini.' });
      onBaris(boxToko, perToko, (r) => { st.toko = r.kode_toko; $('#btPilihToko', el).value = r.kode_toko; muat(); });
      $('#btJudulNota', el).textContent = `Per nota${st.toko ? ` · ${st.toko}` : ''} (${num(nota.length)}${nota.length >= 2000 ? ', 2.000 terbaru' : ''})`;
      boxNota.innerHTML = tabel(KOLOM_BATAL, nota, { klik: true, kosong: 'Tidak ada nota yang dibatalkan di rentang ini.' });
      onBaris(boxNota, nota, detailBatal);
    } catch (e) {
      boxToko.innerHTML = `<div class="kosong">${esc(pesanError(e))}</div>`;
      boxNota.innerHTML = '';
    }
  }

  $('#btRentang', el).addEventListener('change', (e) => {
    const v = e.target.value;
    const h = hariIni();
    st.pilihan = v;
    if (v === '30') { st.dari = geser(h, -29); st.sampai = h; }
    if (v === '90') { st.dari = geser(h, -89); st.sampai = h; }
    if (v === 'tahun') { st.dari = `${h.slice(0, 4)}-01-01`; st.sampai = h; }
    if (v === 'semua') { st.dari = '2000-01-01'; st.sampai = h; }
    $('#btDari', el).value = st.dari;
    $('#btSampai', el).value = st.sampai;
    muat();
  });
  for (const id of ['#btDari', '#btSampai']) {
    $(id, el).addEventListener('change', () => {
      st.dari = $('#btDari', el).value || st.dari;
      st.sampai = $('#btSampai', el).value || st.sampai;
      if (st.dari > st.sampai) [st.dari, st.sampai] = [st.sampai, st.dari];
      st.pilihan = 'atur';
      $('#btRentang', el).value = 'atur';
      muat();
    });
  }
  $('#btPilihToko', el).addEventListener('change', (e) => { st.toko = e.target.value; muat(); });
  $('#btCsvToko', el).addEventListener('click', () => unduhCsv(`pembatalan_per_toko_${st.dari}_${st.sampai}.csv`,
    [{ k: 'kode_toko', judul: 'Toko' }, { k: 'nama', judul: 'Nama toko' }, { k: 'jumlah', judul: 'Nota batal' }, { k: 'nilai', judul: 'Nilai batal' },
      { k: 'kotor', judul: 'Penjualan kotor' }, { k: 'persen', judul: '% batal' }, { k: 'terakhir', judul: 'Batal terakhir' }],
    perToko.map((r) => ({ ...r, nama: namaToko(r.kode_toko), terakhir: r.terakhir ? fmtWaktu(r.terakhir) : '' }))));
  $('#btCsvNota', el).addEventListener('click', () => unduhCsv(`pembatalan_per_nota_${st.toko || 'semua'}_${st.dari}_${st.sampai}.csv`,
    [{ k: 'waktu', judul: 'Waktu batal' }, { k: 'kode_toko', judul: 'Toko' }, { k: 'no_batal', judul: 'No. pembatalan' }, { k: 'no_struk_asal', judul: 'Nota asal' },
      { k: 'waktu_struk_asal', judul: 'Waktu nota asal' }, { k: 'kasir', judul: 'Kasir shift' }, { k: 'qty', judul: 'Qty (Biji)' }, { k: 'total', judul: 'Total' },
      { k: 'alasan', judul: 'Alasan' }, { k: 'diminta_oleh', judul: 'Diminta oleh' }, { k: 'disetujui_oleh', judul: 'Disetujui oleh' }],
    perNota.map((r) => ({ ...r, waktu: fmtWaktu(r.waktu), waktu_struk_asal: r.waktu_struk_asal ? fmtWaktu(r.waktu_struk_asal) : '' }))));
  await muat();
}

// ---------------------------------------------------------------- Pesanan pelanggan (dari Trizone)
const STATUS_PESANAN = { baru: ['warn', 'Belum diambil'], diambil: ['ok', 'Diambil'], batal: ['', 'Batal'] };
const ZONA_AMBIL = { floor: 'Display Toko', warehouse: 'Gudang Utama' };

async function hPesanan(el) {
  const f = S.filterPesanan || (S.filterPesanan = { status: 'baru', toko: '', cari: '' });
  const STATUS = [['baru', 'Belum diambil'], ['diambil', 'Sudah diambil'], ['batal', 'Batal'], ['', 'Semua status']];
  el.innerHTML = `${head('Pesanan Pelanggan', 'Pesanan pelanggan yang dicatat di Trizone: barang yang dipesan, deposit (uang muka), dan tanggal ambil. Ikut terkirim bersama stok toko. Klik pesanan untuk rincian barang.',
    `<select id="psStatus" aria-label="Status">${STATUS.map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
     ${pilihToko('psToko', f.toko)}<input id="psCari" placeholder="No. pesanan, nama, atau HP" style="min-width:200px" value="${esc(f.cari)}">`)}
    <div class="card"><div class="card-head"><div><h2>Pesanan</h2><div class="muted small" id="psRingkas"></div></div><button class="btn sm" id="psCsv">Unduh CSV</button></div>
      <div id="psIsi"><div class="kosong">Memuat…</div></div></div>`;
  const kolom = [
    { k: 'kode_toko', judul: 'Toko', fmt: (v) => `<b>${esc(v)}</b> <span class="muted">${esc(namaToko(v))}</span>` },
    { k: 'no_pesanan', judul: 'No. pesanan', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
    { k: 'nama_pelanggan', judul: 'Pelanggan', fmt: (v, r) => `${esc(v)}${r.hp ? `<div class="muted small">${esc(r.hp)}</div>` : ''}` },
    { k: 'tanggal_ambil', judul: 'Tanggal ambil', fmt: (v, r) => `${esc(fmtTgl(v))}${r.lewat ? ' <span class="pill bad">lewat</span>' : ''}` },
    { k: 'jumlah_barang', judul: 'Barang', num: true, fmt: (v, r) => `${num(v)} jenis<div class="muted small">${num(r.qty)} Biji</div>` },
    { k: 'total', judul: 'Total', num: true, fmt: rp },
    { k: 'deposit', judul: 'Deposit', num: true, fmt: rp },
    { k: 'sisa', judul: 'Sisa bayar', num: true, fmt: (v, r) => (r.status === 'baru' ? rp(v) : '<span class="muted">-</span>') },
    { k: 'status', judul: 'Status', fmt: (v, r) => `${pill(STATUS_PESANAN, v)}${r.selesai_at ? `<div class="muted small">${esc(fmtWaktu(r.selesai_at))}</div>` : ''}` },
    { k: 'dibuat_at', judul: 'Dibuat', fmt: (v, r) => `${esc(fmtWaktu(v))}${r.dibuat_oleh ? `<div class="muted small">${esc(r.dibuat_oleh)}</div>` : ''}` },
  ];
  let rows = [];
  let t;
  let urut = 0;
  async function muat() {
    clearTimeout(t);
    const box = $('#psIsi', el);
    if (!box) return; // halaman sudah ditinggalkan
    const n = ++urut;
    try {
      const hasil = await rpc('laporan_pesanan', { p_status: f.status || null, p_kode_toko: f.toko || null, p_cari: f.cari || null, p_batas: 2000 });
      if (n !== urut || !box.isConnected) return; // ada muat yang lebih baru, atau halaman sudah ganti
      rows = hasil;
      const baru = rows.filter((r) => r.status === 'baru');
      const lewat = baru.filter((r) => r.lewat).length;
      const dep = baru.reduce((a, r) => a + Number(r.deposit), 0);
      $('#psRingkas', el).textContent = `${num(rows.length)} pesanan${baru.length
        ? ` · ${num(baru.length)} belum diambil${lewat ? `, ${num(lewat)} lewat tanggal ambil` : ''} · deposit tertahan ${rp(dep)}` : ''}`;
      box.innerHTML = tabel(kolom, rows, { klik: true, kosong: f.status === 'baru' ? 'Tidak ada pesanan yang belum diambil.' : 'Tidak ada pesanan.' });
      onBaris(box, rows, detailPesanan);
    } catch (e) { if (n === urut && box.isConnected) box.innerHTML = `<div class="kosong">${esc(pesanError(e))}</div>`; }
  }
  $('#psStatus', el).addEventListener('change', (e) => { f.status = e.target.value; muat(); });
  $('#psToko', el).addEventListener('change', (e) => { f.toko = e.target.value; muat(); });
  $('#psCari', el).addEventListener('input', (e) => { f.cari = e.target.value.trim(); clearTimeout(t); t = setTimeout(muat, 250); });
  $('#psCsv', el).addEventListener('click', () => unduhCsv(`pesanan_${f.status || 'semua'}_${hariIni()}.csv`,
    [{ k: 'kode_toko', judul: 'Toko' }, { k: 'no_pesanan', judul: 'No. pesanan' }, { k: 'nama_pelanggan', judul: 'Pelanggan' }, { k: 'hp', judul: 'HP' },
      { k: 'tanggal_ambil', judul: 'Tanggal ambil' }, { k: 'status', judul: 'Status' }, { k: 'jumlah_barang', judul: 'Jenis barang' }, { k: 'qty', judul: 'Qty (Biji)' },
      { k: 'total', judul: 'Total' }, { k: 'deposit', judul: 'Deposit' }, { k: 'sisa', judul: 'Sisa bayar' }, { k: 'catatan', judul: 'Catatan' },
      { k: 'dibuat_at', judul: 'Dibuat' }, { k: 'dibuat_oleh', judul: 'Dibuat oleh' }, { k: 'selesai_at', judul: 'Diambil / batal' },
      { k: 'no_nota', judul: 'Nota' }, { k: 'alasan_batal', judul: 'Alasan batal' }, { k: 'deposit_batal', judul: 'Deposit saat batal' },
      { k: 'batal_disetujui_oleh', judul: 'Batal disetujui oleh' }],
    rows.map((r) => ({ ...r, status: (STATUS_PESANAN[r.status] || [])[1] || r.status, dibuat_at: fmtWaktu(r.dibuat_at), selesai_at: r.selesai_at ? fmtWaktu(r.selesai_at) : '' }))));
  await muat();
}

async function detailPesanan(p) {
  const baris = await q(sb.from('pesanan_toko_baris').select('baris_ke,sku,nama,qty,harga,subtotal')
    .eq('kode_toko', p.kode_toko).eq('no_pesanan', p.no_pesanan).order('baris_ke'));
  const oleh = (w, s) => `${fmtWaktu(w)}${s ? ` oleh ${s}` : ''}`;
  const info = [['Toko', `${p.kode_toko} · ${namaToko(p.kode_toko)}`], ['Pelanggan', `${p.nama_pelanggan}${p.hp ? ` (${p.hp})` : ''}`],
    ['Tanggal ambil', `${fmtTgl(p.tanggal_ambil)}${p.lewat ? ' (sudah lewat)' : ''}`], ['Dibuat', oleh(p.dibuat_at, p.dibuat_oleh)],
    ['Catatan', p.catatan || '-'], ['Total', rp(p.total)], ['Deposit (uang muka)', rp(p.deposit)]];
  if (p.status === 'baru') info.push(['Sisa bayar saat diambil', rp(p.sisa)]);
  if (p.status === 'diambil') info.push(['Diambil', oleh(p.selesai_at, p.selesai_oleh)], ['Nota penjualan', p.no_nota || '-'], ['Stok diambil dari', ZONA_AMBIL[p.zona_ambil] || p.zona_ambil || '-']);
  if (p.status === 'batal') {
    info.push(['Dibatalkan', oleh(p.selesai_at, p.selesai_oleh)], ['Alasan batal', p.alasan_batal || '-'],
      ['Deposit saat batal', p.deposit_batal === 'kembali' ? 'Dikembalikan ke pelanggan' : p.deposit_batal === 'hangus' ? 'Hangus' : '-'],
      ['Disetujui oleh (PIN)', p.batal_disetujui_oleh || '-']);
  }
  modal({
    judul: `Pesanan ${p.no_pesanan}`, lebar: true,
    isi: `<p style="margin-top:0">${pill(STATUS_PESANAN, p.status)}</p>
      <table class="tbl" style="margin-bottom:12px"><tbody>${info.map(([k, v]) => `<tr><td class="muted" style="width:200px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
      ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
        { k: 'qty', judul: 'Qty (Biji)', num: true, fmt: (v) => num(v) }, { k: 'harga', judul: 'Harga', num: true, fmt: rp },
        { k: 'subtotal', judul: 'Subtotal', num: true, fmt: rp }], baris, { kosong: 'Rincian barang belum masuk.' })}`,
    aksi: [{ label: 'Tutup', kelas: 'primary' }],
  });
}

// ---------------------------------------------------------------- Stok & stock opname
// Dua menu memakai satu halaman bertab: Stok (cari stok, stok lambat) dan Stock Opname (review SO, selisih).
const hStok = (el) => halamanStok(el, 'stok');
const hOpname = (el) => halamanStok(el, 'opname');

async function halamanStok(el, jenis) {
  const opname = jenis === 'opname';
  const daftar = opname ? [['kantor', 'Opname dari kantor'], ['so', 'Review stok opname'], ['selisih', 'Selisih vs Trizone']] : [['cari', 'Cari stok'], ['lambat', 'Stok lambat']];
  let tab = daftar[0][0];
  el.innerHTML = `${opname
    ? head('Stock Opname', 'Opname dari kantor (tarik stok, hitung, kirim ke toko), review stok opname dari toko, dan selisih stok Trizone terhadap hitungan mother base.')
    : head('Stok', 'Stok terkini tiap toko (dari Trizone) dan barang yang lama tidak terjual.', tombolTarik('stTarik'))}
    ${tabs('stTab', daftar, tab)}<div id="stIsi"></div>`;
  pasangTabs(el, 'stTab', (t) => { tab = t; tampil(); });
  const isi = $('#stIsi', el);
  if (!opname) $('#stTarik', el).addEventListener('click', (e) => tarikData((S.filterStok && S.filterStok.toko) || null, () => tampil(), e.currentTarget));

  async function tampil() {
    isi.innerHTML = '<div class="card"><div class="kosong">Memuat…</div></div>';
    isi.onclick = null;
    try {
      if (tab === 'kantor') return await opnameKantor();
      if (tab === 'so') return await reviewSo();
      if (tab === 'selisih') return await selisih();
      if (tab === 'cari') return await cari();
      return await lambat();
    } catch (e) { isi.innerHTML = `<div class="card"><div class="kosong">${esc(pesanError(e))}</div></div>`; }
  }

  async function opnameKantor() {
    const f = S.opnameKantor || (S.opnameKantor = { toko: (S.toko.find((t) => t.punya_kunci) || S.toko[0] || {}).kode || '', kategori: '', merk: '', status: '' });
    const bolehBuat = ['owner', 'admin_kantor'].includes(peran());
    const ZONA = Object.fromEntries(MbOpnameKantor.ZONA.map((z) => [z.id, z.label]));
    const STATUS = { dikirim: ['warn', 'Menunggu toko'], diterapkan: ['ok', 'Diterapkan'], batal: ['', 'Batal'] };
    const tanda = (v, t) => (Number(v) ? `${t}${num(v)}` : '0');
    isi.innerHTML = `${bolehBuat ? `<div class="card"><div class="card-head"><div><h2>Buat opname dari kantor</h2>
        <div class="muted small">Fisik dihitung orang kantor; hasilnya langsung mengubah stok Trizone toko (tidak lewat toko).</div></div></div>
        <ol class="small" style="margin:0 0 10px;padding-left:18px;display:grid;gap:4px">
          <li><b>Tarik stok terbaru</b> sebelum mulai menghitung (stok di template = stok kiriman terakhir toko).</li>
          <li><b>Unduh template</b>, hitung fisik, isi kolom <b>Fisik</b> zona yang dihitung (kosong = tidak dihitung). Boleh sebagian / per kategori.</li>
          <li><b>Upload hasil</b>, periksa selisih, lalu <b>Kirim ke toko</b>. Toko menerapkan dalam ±5 menit bila PC toko menyala & online. Hanya selisih fisik − stok di file yang ditambahkan, jadi penjualan setelah stok ditarik tetap terhitung.</li>
        </ol>
        <div class="row" style="flex-wrap:wrap">${pilihToko('okToko', f.toko, '')}
          ${tombolTarik('okTarik', 'Tarik stok terbaru')}
          <select id="okKategori" aria-label="Kategori"><option value="">Semua kategori</option></select>
          <select id="okMerk" aria-label="Merk"><option value="">Semua merk</option></select>
          <button class="btn sm" id="okUnduh">Unduh template</button>
          <label class="btn sm primary" style="cursor:pointer">Upload hasil<input type="file" id="okFile" accept=".xlsx,.xls,.csv" hidden></label>
        </div>
        <div class="muted small" id="okStokPer" style="margin-top:8px"></div>
        <div id="okPratinjau"></div></div>`
    : '<div class="alert" style="margin-bottom:14px">Opname dari kantor dibuat oleh owner atau admin kantor. Riwayatnya bisa dilihat di bawah.</div>'}
      <div class="card"><div class="card-head"><h2>Riwayat opname kantor</h2>
        <select id="okStatus" aria-label="Status">${[['', 'Semua status'], ['dikirim', 'Menunggu toko'], ['diterapkan', 'Diterapkan'], ['batal', 'Batal']]
          .map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div id="okDaftar"><div class="kosong">Memuat…</div></div></div>`;

    // ---- daftar
    const kolom = [
      { k: 'no_dok', judul: 'No. opname', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
      { k: 'kode_toko', judul: 'Toko', fmt: (v) => `<b>${esc(v)}</b> <span class="muted">${esc(namaToko(v))}</span>` },
      { k: 'zona', judul: 'Zona', fmt: (v) => esc(ZONA[v] || v) },
      { k: 'stok_per', judul: 'Stok per', fmt: (v) => esc(fmtWaktu(v)) },
      { k: 'jumlah_barang', judul: 'Barang', num: true, fmt: (v, r) => `${num(v)} dihitung<div class="muted small">${num(r.jumlah_selisih)} selisih</div>` },
      { k: 'plus_qty', judul: 'Plus / minus', num: true, fmt: (v, r) => `${tanda(v, '+')} / ${tanda(r.minus_qty, '−')}` },
      { k: 'nilai_selisih', judul: 'Nilai selisih', num: true, fmt: rp },
      { k: 'status', judul: 'Status', fmt: (v, r) => `${pill(STATUS, v)}${v === 'diterapkan' ? `<div class="muted small">${r.no_op_toko ? `<span class="mono">${esc(r.no_op_toko)}</span> · ` : ''}${esc(fmtWaktu(r.diterapkan_at))}</div>` : ''}` },
      { k: 'dibuat_at', judul: 'Dibuat', fmt: (v, r) => `${esc(fmtWaktu(v))}<div class="muted small">${esc(r.dibuat_oleh_nama || '')}</div>` },
    ];
    async function muatDaftar() {
      const box = $('#okDaftar', isi);
      if (!box) return;
      const rows = await rpc('laporan_opname_kantor', { p_status: f.status || null, p_kode_toko: null, p_batas: 500 });
      if (!box.isConnected) return;
      box.innerHTML = tabel(kolom, rows, { klik: true, kosong: 'Belum ada opname dari kantor.' });
      onBaris(box, rows, detail);
    }
    async function detail(r) {
      const baris = await ambilSemua(() => sb.from('opname_kantor_baris').select('baris_ke,sku,nama,patokan,fisik,selisih').eq('opname_id', r.id).order('baris_ke'));
      const info = [['Toko', `${r.kode_toko} · ${namaToko(r.kode_toko)}`], ['Zona', ZONA[r.zona] || r.zona], ['Stok patokan per', fmtWaktu(r.stok_per)],
        ['Dibuat', `${fmtWaktu(r.dibuat_at)}${r.dibuat_oleh_nama ? ` oleh ${r.dibuat_oleh_nama}` : ''}`], ['Catatan', r.catatan || '-'],
        ['Status', (STATUS[r.status] || [])[1] || r.status]];
      if (r.status === 'diterapkan') {
        info.push(['Diterapkan di toko', `${fmtWaktu(r.diterapkan_at)}${r.no_op_toko ? ` · dokumen ${r.no_op_toko}` : ' · tidak ada barang yang dikenal toko'}`]);
        if ((r.dilewati || []).length) info.push(['Dilewati (tidak ada di Daftar Barang toko)', r.dilewati.join(', ')]);
      }
      if (r.status === 'batal') info.push(['Dibatalkan', `${r.batal_oleh_nama || ''}${r.batal_alasan ? ` · ${r.batal_alasan}` : ''}`]);
      const aksi = [{ label: 'Tutup', kelas: 'primary' }];
      if (bolehBuat && r.status === 'dikirim') {
        aksi.unshift({ label: 'Batalkan', kelas: 'danger', onClick: ({ tutup }) => { tutup(); batal(r); } });
      }
      modal({
        judul: `Opname ${r.no_dok}`, lebar: true, aksi,
        isi: `<table class="tbl" style="margin-bottom:12px"><tbody>${info.map(([k, v]) => `<tr><td class="muted" style="width:220px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
          ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
            { k: 'patokan', judul: 'Stok di file', num: true, fmt: (v) => num(v) }, { k: 'fisik', judul: 'Fisik', num: true, fmt: (v) => num(v) },
            { k: 'selisih', judul: 'Selisih', num: true, fmt: (v) => `<span class="pill ${Number(v) < 0 ? 'bad' : Number(v) > 0 ? 'warn' : ''}">${num(v)}</span>` }], baris)}`,
      });
    }
    function batal(r) {
      modal({
        judul: `Batalkan ${r.no_dok}`,
        isi: `<p style="margin-top:0">Opname yang belum diterapkan toko dibatalkan. Bila toko ternyata sudah menerapkannya, status tetap menjadi Diterapkan.</p>
          <label class="f">Alasan<input id="okAlasan" placeholder="mis. salah hitung rak 3"></label>`,
        aksi: [{ label: 'Kembali' }, { label: 'Batalkan opname', kelas: 'danger', onClick: async ({ tutup, el: m }) => {
          await rpc('batal_opname_kantor', { p_id: r.id, p_alasan: $('#okAlasan', m).value });
          tutup(); toast(`${r.no_dok} dibatalkan.`); muatDaftar();
        } }],
      });
    }
    $('#okStatus', isi).addEventListener('change', (e) => { f.status = e.target.value; muatDaftar(); });
    if (!bolehBuat) return muatDaftar();

    // ---- buat opname
    let data = null; // { kode, produk: Map(sku → { sku, nama, merk, kategori, harga_jual, display, gudang, bs, shopee }), per }
    async function muatStok() {
      const kode = f.toko;
      const infoEl = $('#okStokPer', isi);
      data = null;
      infoEl.textContent = kode ? 'Memuat stok…' : 'Pilih toko.';
      if (!kode) return;
      const [stok, produk] = await Promise.all([
        ambilSemua(() => sb.from('stok_toko').select('sku,display,gudang,bs,shopee,per_waktu').eq('kode_toko', kode).order('sku')),
        ambilSemua(() => sb.from('produk_toko').select('sku,nama,merk,kategori,harga_jual').eq('kode_toko', kode).order('sku')),
      ]);
      if (kode !== f.toko || !infoEl.isConnected) return; // toko diganti / tab ditinggalkan
      const peta = new Map(produk.map((p) => [p.sku, { ...p, display: 0, gudang: 0, bs: 0, shopee: 0 }]));
      let per = null;
      for (const s of stok) {
        if (peta.has(s.sku)) Object.assign(peta.get(s.sku), { display: s.display, gudang: s.gudang, bs: s.bs, shopee: s.shopee });
        if (!per || s.per_waktu > per) per = s.per_waktu;
      }
      data = { kode, produk: peta, per };
      const opsi = (k) => [...new Set(produk.map((p) => p[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
      $('#okKategori', isi).innerHTML = `<option value="">Semua kategori</option>${opsi('kategori').map((v) => `<option ${v === f.kategori ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;
      $('#okMerk', isi).innerHTML = `<option value="">Semua merk</option>${opsi('merk').map((v) => `<option ${v === f.merk ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;
      infoEl.innerHTML = per
        ? `Stok di template: per <b>${esc(fmtWaktu(per))}</b> (${esc(relatif(per))}), ${num(peta.size)} barang. Tarik stok terbaru dulu bila sudah lama.`
        : 'Belum ada data stok dari toko ini. Tekan Tarik stok terbaru, atau pastikan Trizone toko sudah tersambung.';
    }
    $('#okToko', isi).addEventListener('change', (e) => { f.toko = e.target.value; f.kategori = ''; f.merk = ''; $('#okPratinjau', isi).innerHTML = ''; muatStok(); });
    $('#okKategori', isi).addEventListener('change', (e) => { f.kategori = e.target.value; });
    $('#okMerk', isi).addEventListener('change', (e) => { f.merk = e.target.value; });
    $('#okTarik', isi).addEventListener('click', (e) => {
      if (!f.toko) return toast('Pilih toko dulu.', 'bad');
      return tarikData(f.toko, async () => { await muatStok(); await muatDaftar(); }, e.currentTarget);
    });
    $('#okUnduh', isi).addEventListener('click', () => {
      if (!data || !data.per) return toast('Belum ada data stok dari toko ini. Tarik stok terbaru dulu.', 'bad');
      const pilih = [...data.produk.values()].filter((p) => (!f.kategori || p.kategori === f.kategori) && (!f.merk || p.merk === f.merk))
        .sort((a, b) => String(a.nama).localeCompare(String(b.nama), 'id'));
      if (!pilih.length) return toast('Tidak ada barang untuk filter ini.', 'bad');
      const tgl = MbOpnameKantor.teksWib(data.per).slice(0, 16).replace(/\D/g, '');
      const bagian = [f.kategori, f.merk].filter(Boolean).join('_').replace(/[^\w-]+/g, '_');
      XLSX.writeFile(MbOpnameKantor.workbook(MbOpnameKantor.barisTemplate(pilih, data.per, data.kode)), `Opname_${data.kode}_${tgl}${bagian ? `_${bagian}` : ''}.xlsx`);
      return undefined;
    });
    $('#okFile', isi).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const box = $('#okPratinjau', isi);
      try {
        if (!data) await muatStok();
        pratinjau(MbOpnameKantor.bacaFile(await file.arrayBuffer()), file.name);
      } catch (err) { box.innerHTML = `<div class="alert bad" style="margin-top:12px">${esc(pesanError(err))}</div>`; }
    });

    function pratinjau(h, namaFile) {
      const box = $('#okPratinjau', isi);
      const masalah = [...h.masalah];
      if (h.toko && h.toko !== data.kode) masalah.unshift(`File ini template toko ${h.toko}, bukan ${data.kode}. Pilih toko ${h.toko} atau unduh template ${data.kode}.`);
      const dok = [];
      for (const z of MbOpnameKantor.ZONA) {
        const list = h.zona[z.id];
        if (!list) continue;
        const baris = [];
        for (const b of list) {
          const p = data.produk.get(b.sku);
          if (!p) { masalah.push(`Baris ${b.baris}: kode ${b.sku} tidak ada di Daftar Barang toko ${data.kode}.`); continue; }
          baris.push({ ...b, zona: z.id, nama: p.nama, selisih: b.fisik - b.patokan, nilai: (b.fisik - b.patokan) * Number(p.harga_jual || 0) });
        }
        if (baris.length) dok.push({ zona: z.id, label: z.label, stok_per: h.stokPer[z.id], baris });
      }
      if (!dok.length && !masalah.length) masalah.push('Tidak ada kolom Fisik yang diisi.');
      const beda = dok.flatMap((d) => d.baris.filter((b) => b.selisih !== 0).map((b) => ({ ...b, label: d.label })));
      box.innerHTML = `<div style="margin-top:14px"><h3 style="margin:0 0 6px">Hasil hitung: ${esc(namaFile)}</h3>
        ${masalah.length ? `<div class="alert bad" style="margin-bottom:10px"><b>${num(masalah.length)} masalah</b> harus diperbaiki di file lalu upload ulang:<ul style="margin:6px 0 0;padding-left:18px">${masalah.slice(0, 50).map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
        ${dok.length ? tabel([{ k: 'label', judul: 'Zona' }, { k: 'stok_per', judul: 'Stok di file per', fmt: (v) => esc(String(v).slice(0, 16)) },
          { k: 'n', judul: 'Barang dihitung', num: true, fmt: (v) => num(v) }, { k: 'beda', judul: 'Barang selisih', num: true, fmt: (v) => num(v) },
          { k: 'plus', judul: 'Plus', num: true, fmt: (v) => tanda(v, '+') }, { k: 'minus', judul: 'Minus', num: true, fmt: (v) => tanda(v, '−') },
          { k: 'nilai', judul: 'Nilai selisih', num: true, fmt: rp }],
        dok.map((d) => ({ label: d.label, stok_per: d.stok_per, n: d.baris.length, beda: d.baris.filter((b) => b.selisih).length,
          plus: d.baris.reduce((a, b) => a + Math.max(b.selisih, 0), 0), minus: d.baris.reduce((a, b) => a + Math.max(-b.selisih, 0), 0),
          nilai: d.baris.reduce((a, b) => a + b.nilai, 0) }))) : ''}
        ${beda.length ? `<h3 style="margin:14px 0 6px">Barang yang selisih (${num(beda.length)})</h3>${tabel([{ k: 'label', judul: 'Zona' },
          { k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
          { k: 'patokan', judul: 'Stok di file', num: true, fmt: (v) => num(v) }, { k: 'fisik', judul: 'Fisik', num: true, fmt: (v) => num(v) },
          { k: 'selisih', judul: 'Selisih', num: true, fmt: (v) => `<span class="pill ${v < 0 ? 'bad' : 'warn'}">${v > 0 ? '+' : ''}${num(v)}</span>` },
          { k: 'nilai', judul: 'Nilai', num: true, fmt: rp }], beda.slice(0, 500))}` : dok.length ? '<div class="muted small" style="margin-top:8px">Semua barang yang dihitung sama dengan stok di file.</div>' : ''}
        ${dok.length && !masalah.length ? `<div class="row" style="margin-top:12px;flex-wrap:wrap"><input id="okCatatan" placeholder="Catatan (opsional), mis. opname rak depan oleh Andi" maxlength="200" style="flex:1;min-width:240px">
          <button class="btn primary" id="okKirim">Kirim ke toko ${esc(data.kode)}</button></div>` : ''}</div>`;
      const kirim = $('#okKirim', box);
      if (!kirim) return;
      kirim.addEventListener('click', async () => {
        const ok = await konfirmasi(`Kirim opname ke ${data.kode}`, `Stok Trizone <b>${esc(data.kode)} · ${esc(namaToko(data.kode))}</b> akan diubah: ${dok.map((d) => `${esc(d.label)} ${num(d.baris.length)} barang`).join(', ')}. Lanjutkan?`, 'Kirim ke toko');
        if (!ok) return;
        const hasil = await sibuk(kirim, () => rpc('buat_opname_kantor', { p_kode_toko: data.kode, p_catatan: $('#okCatatan', box).value || null,
          p_dok: dok.map((d) => ({ zona: d.zona, stok_per: d.stok_per, baris: d.baris.map((b) => ({ sku: b.sku, patokan: b.patokan, fisik: b.fisik })) })) }));
        if (!hasil) return;
        toast(`${hasil.map((x) => x.no_dok).join(', ')} dikirim ke ${data.kode}. Diterapkan toko dalam ±5 menit.`, 'ok');
        box.innerHTML = '';
        await muatDaftar();
        pantauKiriman([data.kode], async () => { await muatStok(); await muatDaftar(); }, $('#okTarik', isi));
      });
    }

    await Promise.all([muatStok(), muatDaftar()]);
    return undefined;
  }

  async function reviewSo() {
    const rows = await q(sb.from('v_selisih_so').select('*').eq('status', 'BARU').order('kode_toko').order('no_op').limit(3000));
    const g = new Map();
    for (const r of rows) {
      const k = `${r.kode_toko}|${r.no_op}`;
      if (!g.has(k)) g.set(k, { kode_toko: r.kode_toko, no_op: r.no_op, zona: r.zona, waktu: r.waktu, baris: [] });
      g.get(k).baris.push(r);
    }
    const ZONA = { floor: 'Display Toko', warehouse: 'Gudang Utama', damaged: 'Gudang BS', shopee: 'Gudang Shopee' };
    isi.innerHTML = `<div class="alert" style="margin-bottom:14px">SO yang disetujui menjadi patokan <b>stok seharusnya</b>. Setelah itu selisih stok Trizone terhadap hitungan mother base terlihat di tab Selisih vs Trizone.</div>` +
      (g.size ? [...g.values()].map((d, i) => {
        const beda = d.baris.filter((b) => Number(b.selisih) !== 0);
        const nilai = beda.reduce((a, b) => a + Number(b.nilai_selisih || 0), 0);
        return `<div class="card" data-so="${i}"><div class="card-head"><div><h2>${esc(d.kode_toko)} · <span class="mono">${esc(d.no_op)}</span></h2>
          <div class="muted small">${esc(ZONA[d.zona] || d.zona)} · ${esc(fmtWaktu(d.waktu))} · ${num(d.baris.length)} barang dihitung, ${num(beda.length)} selisih · nilai selisih ${rp(nilai)}</div></div>
          <div class="row"><button class="btn sm danger" data-aksi="DITOLAK">Tolak</button><button class="btn sm primary" data-aksi="DISETUJUI">Setujui</button></div></div>
          ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
            { k: 'stok_sistem', judul: 'Sistem', num: true, fmt: (v) => num(v) }, { k: 'fisik', judul: 'Fisik', num: true, fmt: (v) => num(v) },
            { k: 'selisih', judul: 'Selisih', num: true, fmt: (v) => `<span class="pill ${Number(v) < 0 ? 'bad' : Number(v) > 0 ? 'warn' : ''}">${num(v)}</span>` },
            { k: 'nilai_selisih', judul: 'Nilai', num: true, fmt: (v) => (v === null ? '<span class="muted">harga belum ada</span>' : rp(v)) }], beda.length ? beda : d.baris)}</div>`;
      }).join('') : '<div class="card"><div class="kosong">Tidak ada stok opname yang menunggu review.</div></div>');
    const docs = [...g.values()];
    isi.onclick = async (e) => {
      const b = e.target.closest('[data-aksi]');
      if (!b) return;
      const d = docs[Number(b.closest('[data-so]').dataset.so)];
      const setuju = b.dataset.aksi === 'DISETUJUI';
      modal({
        judul: `${setuju ? 'Setujui' : 'Tolak'} ${d.no_op}`,
        isi: `<label class="f">Catatan (opsional)<textarea id="soCat" rows="3" placeholder="${setuju ? 'mis. sudah dicek ulang bersama kepala toko' : 'alasan penolakan'}"></textarea></label>`,
        aksi: [{ label: 'Batal' }, { label: setuju ? 'Setujui' : 'Tolak', kelas: setuju ? 'primary' : 'danger', onClick: async ({ tutup, el: m }) => {
          await rpc('review_so', { p_kode_toko: d.kode_toko, p_no_op: d.no_op, p_status: b.dataset.aksi, p_catatan: $('#soCat', m).value || null });
          tutup(); toast(`${d.no_op} ${setuju ? 'disetujui' : 'ditolak'}.`); tampil();
        } }],
      });
    };
  }

  async function selisih() {
    const rows = await q(sb.from('v_selisih_snapshot').select('*').order('kode_toko').limit(2000));
    const ZONA = { floor: 'Display', warehouse: 'Gudang', damaged: 'BS', shopee: 'Shopee' };
    isi.innerHTML = `<div class="card"><div class="card-head"><h2>Stok Trizone berbeda dari stok seharusnya</h2></div>
      <p class="muted small" style="margin-top:-4px">Hanya barang yang punya SO patokan yang sudah disetujui. Selisih positif = stok di Trizone lebih banyak.</p>
      ${tabel([{ k: 'kode_toko', judul: 'Toko' }, { k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
        { k: 'zona', judul: 'Zona', fmt: (v) => esc(ZONA[v] || v) }, { k: 'stok_trizone', judul: 'Trizone', num: true, fmt: (v) => num(v) },
        { k: 'stok_seharusnya', judul: 'Seharusnya', num: true, fmt: (v) => num(v) }, { k: 'selisih', judul: 'Selisih', num: true, fmt: (v) => `<span class="pill ${Number(v) < 0 ? 'bad' : 'warn'}">${num(v)}</span>` },
        { k: 'so_patokan', judul: 'SO patokan', fmt: (v) => `<span class="mono small">${esc(v)}</span>` }, { k: 'per_waktu', judul: 'Stok per', fmt: (v) => esc(fmtWaktu(v)) }],
      rows, { kosong: 'Tidak ada selisih. Stok Trizone sama dengan hitungan mother base.' })}</div>`;
  }

  async function cari() {
    const KONDISI = [['', 'Semua kondisi'], ['ada', 'Ada stok'], ['habis', 'Habis (tidak bisa dijual)'], ['menipis', 'Display di bawah minimum'],
      ['isi_display', 'Perlu isi display (gudang ada)'], ['minus', 'Stok minus'], ['bs', 'Ada barang BS']];
    const f = S.filterStok || (S.filterStok = { cari: '', toko: '', kondisi: '', kategori: '', merk: '' });
    const opsi = (daftar, nilai) => daftar.map(([v, l]) => `<option value="${esc(v)}" ${v === nilai ? 'selected' : ''}>${esc(l)}</option>`).join('');
    isi.innerHTML = `<div class="card"><div class="card-head"><div class="row" style="flex-wrap:wrap">
        <input id="stCari" placeholder="Cari nama, SKU, atau barcode" style="min-width:220px" value="${esc(f.cari)}">
        ${S.toko.length > 1 ? pilihToko('stToko', f.toko) : ''}
        <select id="stKondisi" aria-label="Kondisi stok">${opsi(KONDISI, f.kondisi)}</select>
        <select id="stKategori" aria-label="Kategori"><option value="">Semua kategori</option></select>
        <select id="stMerk" aria-label="Merk"><option value="">Semua merk</option></select>
        <button class="btn sm ghost" id="stReset">Reset</button><button class="btn sm" id="stCsv">Unduh CSV</button></div></div>
      <div class="muted small" id="stJumlah" style="margin:-4px 0 8px"></div><div id="stHasil"></div></div>`;
    let rows = [];
    const kolom = [{ k: 'kode_toko', judul: 'Toko' }, { k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
      { k: 'nama', judul: 'Nama', fmt: (v, r) => `${esc(v || '')}${r.kategori || r.merk ? `<div class="muted small">${esc([r.kategori, r.merk && r.merk !== '-' ? r.merk : ''].filter(Boolean).join(' · '))}</div>` : ''}` },
      { k: 'display', judul: 'Display', num: true, fmt: (v, r) => `<span class="${Number(v) < 0 ? 'pill bad' : Number(v) <= Number(r.min_display || 0) ? 'pill warn' : ''}">${num(v)}</span>` },
      { k: 'gudang', judul: 'Gudang', num: true, fmt: (v) => `<span class="${Number(v) < 0 ? 'pill bad' : ''}">${num(v)}</span>` },
      { k: 'bs', judul: 'BS', num: true, fmt: (v) => num(v) },
      { k: 'shopee', judul: 'Shopee', num: true, fmt: (v) => num(v) }, { k: 'per_waktu', judul: 'Stok per', fmt: (v) => esc(fmtWaktu(v)) }];
    const BATAS = 2000;
    let t;
    const muat = async () => {
      rows = await rpc('laporan_stok_produk', { p_cari: f.cari || null, p_kode_toko: f.toko || null, p_batas: BATAS,
        p_kondisi: f.kondisi || null, p_kategori: f.kategori || null, p_merk: f.merk || null });
      $('#stJumlah', isi).textContent = `${num(rows.length)} barang${rows.length >= BATAS ? ` (hanya ${num(BATAS)} pertama ditampilkan; persempit filter)` : ''}`;
      $('#stHasil', isi).innerHTML = tabel(kolom, rows, { kosong: 'Tidak ada barang yang cocok dengan filter.' });
    };
    const muatPilihan = async () => {
      const p = await rpc('pilihan_filter_stok', { p_kode_toko: f.toko || null });
      if (f.kategori && !p.kategori.includes(f.kategori)) f.kategori = '';
      if (f.merk && !p.merk.includes(f.merk)) f.merk = '';
      $('#stKategori', isi).innerHTML = `<option value="">Semua kategori</option>${opsi(p.kategori.map((k) => [k, k]), f.kategori)}`;
      $('#stMerk', isi).innerHTML = `<option value="">Semua merk</option>${opsi(p.merk.map((m) => [m, m]), f.merk)}`;
    };
    const ulang = () => muat().catch((e) => toast(pesanError(e), 'bad'));
    $('#stCari', isi).addEventListener('input', (e) => { f.cari = e.target.value.trim(); clearTimeout(t); t = setTimeout(ulang, 250); });
    if ($('#stToko', isi)) $('#stToko', isi).addEventListener('change', async (e) => { f.toko = e.target.value; await muatPilihan(); ulang(); });
    $('#stKondisi', isi).addEventListener('change', (e) => { f.kondisi = e.target.value; ulang(); });
    $('#stKategori', isi).addEventListener('change', (e) => { f.kategori = e.target.value; ulang(); });
    $('#stMerk', isi).addEventListener('change', (e) => { f.merk = e.target.value; ulang(); });
    $('#stReset', isi).addEventListener('click', () => { S.filterStok = null; cari().catch((e) => toast(pesanError(e), 'bad')); });
    $('#stCsv', isi).addEventListener('click', () => unduhCsv('stok.csv',
      [{ k: 'kode_toko', judul: 'Toko' }, { k: 'sku', judul: 'SKU' }, { k: 'nama', judul: 'Nama' }, { k: 'kategori', judul: 'Kategori' }, { k: 'merk', judul: 'Merk' },
        { k: 'display', judul: 'Display' }, { k: 'min_display', judul: 'Min. display' }, { k: 'gudang', judul: 'Gudang' }, { k: 'bs', judul: 'BS' },
        { k: 'shopee', judul: 'Shopee' }, { k: 'per_waktu', judul: 'Stok per' }],
      rows.map((r) => ({ ...r, per_waktu: fmtWaktu(r.per_waktu) }))));
    await muatPilihan();
    await muat();
  }

  async function lambat() {
    isi.innerHTML = `<div class="card"><div class="card-head"><div class="row"><label class="row small muted">Tidak terjual selama
      <select id="slHari"><option>30</option><option>60</option><option>90</option></select> hari</label>${S.toko.length > 1 ? pilihToko('slToko') : ''}</div></div><div id="slHasil"></div></div>`;
    const muat = async () => {
      const rows = await rpc('laporan_stok_lambat', { p_hari: Number($('#slHari', isi).value), p_kode_toko: ($('#slToko', isi) || {}).value || null, p_batas: 500 });
      $('#slHasil', isi).innerHTML = tabel([{ k: 'kode_toko', judul: 'Toko' }, { k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
        { k: 'nama', judul: 'Nama' }, { k: 'stok', judul: 'Stok', num: true, fmt: (v) => num(v) },
        { k: 'terakhir_terjual', judul: 'Terakhir terjual', fmt: (v) => esc(v ? fmtTgl(v) : 'belum pernah') }], rows, { kosong: 'Tidak ada stok lambat.' });
    };
    $('#slHari', isi).addEventListener('change', muat);
    if ($('#slToko', isi)) $('#slToko', isi).addEventListener('change', muat);
    await muat();
  }
  await tampil();
}

// ---------------------------------------------------------------- Surat jalan (Accurate)
async function hKiriman(el) {
  el.innerHTML = `${head('Surat Jalan', 'Upload laporan Accurate <b>Rincian Pengiriman Pesanan</b>, kirim file import penerimaan ke toko, lalu pantau pencocokannya.')}
    <div class="card"><div class="card-head"><h2>Upload dari Accurate</h2></div>
      <div class="row"><input type="file" id="kjFile" accept=".xlsx,.xls" aria-label="File Excel Accurate"><span class="muted small">Ekspor laporan Rincian Pengiriman Pesanan dari Accurate ke Excel.</span></div>
      <div id="kjPratinjau"></div></div>
    <div class="card"><div class="card-head"><h2>Pencocokan surat jalan</h2>
      <div class="row"><select id="kjStatus" aria-label="Status"><option value="masalah">Perlu dicek</option><option value="">Semua status</option>
      ${Object.entries(STATUS_SJ).map(([k, [, l]]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>${pilihToko('kjToko')}</div></div>
      <div id="kjDaftar"><div class="kosong">Memuat…</div></div></div>`;
  let pelanggan = [];

  $('#kjFile', el).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const box = $('#kjPratinjau', el);
    box.innerHTML = '<div class="kosong">Membaca file…</div>';
    try {
      const hasil = MbAccurate.bacaFile(await f.arrayBuffer());
      pelanggan = await q(sb.from('pelanggan_accurate').select('*'));
      const petaPel = Object.fromEntries(pelanggan.map((p) => [p.nama, p.kode_toko]));
      const kelompok = new Map();
      for (const d of hasil.do) {
        const kode = petaPel[d.pelanggan] || null;
        const k = kode || `?${d.pelanggan}`;
        if (!kelompok.has(k)) kelompok.set(k, { kode, pelanggan: new Set(), do: [] });
        kelompok.get(k).pelanggan.add(d.pelanggan);
        kelompok.get(k).do.push(d);
      }
      const grup = [...kelompok.values()];
      const nBaris = hasil.do.reduce((a, d) => a + d.items.length, 0);
      box.innerHTML = `<div style="margin-top:12px" class="grid">
        <div class="${hasil.masalah.length ? 'alert bad' : 'alert ok'}"><b>${esc(f.name)}</b>: ${esc(hasil.perusahaan || '')} · ${esc(hasil.periode || '')} ·
          ${num(hasil.do.length)} DO, ${num(nBaris)} baris barang${hasil.masalah.length ? `<br><b>${num(hasil.masalah.length)} masalah:</b><br>${hasil.masalah.slice(0, 20).map(esc).join('<br>')}` : ''}</div>
        ${tabel([{ k: 'toko', judul: 'Toko', fmt: (v, r) => (r.kode ? `<b>${esc(r.kode)}</b> ${esc(namaToko(r.kode))}` : '<span class="pill warn">Belum dipetakan</span>') },
          { k: 'pel', judul: 'Pelanggan Accurate' }, { k: 'jml', judul: 'DO', num: true }, { k: 'aksi', judul: '', fmt: (v, r) => `<button class="btn sm" data-unduh="${r.i}">Unduh file import Trizone</button>` }],
        grup.map((g2, i) => ({ i, kode: g2.kode, pel: [...g2.pelanggan].join(', '), jml: g2.do.length })))}
        <div class="row end"><span class="muted small">Pelanggan yang belum dipetakan bisa diatur di halaman Toko.</span>
          <button class="btn primary" id="kjSimpan" ${hasil.masalah.length ? 'disabled' : ''}>Simpan ${num(hasil.do.length)} surat jalan ke mother base</button></div></div>`;
      box.onclick = (ev) => {
        const b = ev.target.closest('[data-unduh]');
        if (!b) return;
        const g2 = grup[Number(b.dataset.unduh)];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(MbAccurate.barisImportTrizone({ ...hasil, do: g2.do })), 'Penerimaan');
        XLSX.writeFile(wb, `Penerimaan_${g2.kode || [...g2.pelanggan][0].replace(/\W+/g, '_')}_${hariIni()}.xlsx`);
      };
      $('#kjSimpan', box).addEventListener('click', (ev) => sibuk(ev.target, async () => {
        const r = await rpc('import_surat_jalan', { p: MbAccurate.payloadMotherBase(hasil, f.name) });
        toast(`${num(r.do_baru)} surat jalan baru, ${num(r.do_diganti)} diperbarui.${r.pelanggan_belum_dipetakan.length ? ` Belum dipetakan: ${r.pelanggan_belum_dipetakan.join(', ')}` : ''}`);
        daftar();
      }));
    } catch (err) { box.innerHTML = `<div class="alert bad" style="margin-top:12px">${esc(pesanError(err))}</div>`; }
  });

  async function daftar() {
    const st = $('#kjStatus', el).value;
    const toko = $('#kjToko', el).value;
    let qy = sb.from('v_pencocokan_sj').select('*').order('tanggal_kirim', { ascending: false }).order('no_sj', { ascending: false }).limit(300);
    if (st === 'masalah') qy = qy.in('status', ['BELUM_DIINPUT', 'SELISIH_QTY', 'BARANG_SALAH', 'SATUAN_BELUM_JELAS', 'PELANGGAN_BELUM_DIPETAKAN']);
    else if (st) qy = qy.eq('status', st);
    if (toko) qy = qy.eq('kode_toko', toko);
    const rows = await q(qy);
    const box = $('#kjDaftar', el);
    box.innerHTML = tabel([{ k: 'no_sj', judul: 'No. DO', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'tanggal_kirim', judul: 'Tanggal', fmt: (v) => esc(fmtTgl(v)) },
      { k: 'pelanggan', judul: 'Pelanggan' }, { k: 'kode_toko', judul: 'Toko' }, { k: 'status', judul: 'Status', fmt: (v) => pill(STATUS_SJ, v) },
      { k: 'baris_kirim', judul: 'Baris', num: true }, { k: 'baris_selisih_qty', judul: 'Selisih', num: true }, { k: 'barang_kurang', judul: 'Kurang', num: true },
      { k: 'barang_lebih', judul: 'Lebih', num: true }, { k: 'batas_input', judul: 'Batas input', fmt: (v) => esc(fmtTgl(v)) },
      { k: 'diinput_at', judul: 'Diinput toko', fmt: (v) => esc(v ? fmtWaktu(v) : '-') }], rows, { klik: true, kosong: st === 'masalah' ? 'Tidak ada surat jalan yang perlu dicek.' : 'Belum ada surat jalan.' });
    onBaris(box, rows, detailSj);
  }
  $('#kjStatus', el).addEventListener('change', daftar);
  $('#kjToko', el).addEventListener('change', daftar);
  await daftar();
}

async function detailSj(sj) {
  const rows = await q(sb.from('v_sj_banding').select('*').eq('no_sj', sj.no_sj).order('sku'));
  modal({
    judul: `${sj.no_sj} · ${sj.pelanggan}`, lebar: true,
    isi: `<p class="muted" style="margin-top:0">${esc(fmtTgl(sj.tanggal_kirim))} · toko ${esc(sj.kode_toko || 'belum dipetakan')} · ${pill(STATUS_SJ, sj.status)}</p>
      ${tabel([{ k: 'sku', judul: 'Kode', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
        { k: 'qty_kirim', judul: 'Dikirim', num: true, fmt: (v, r) => (v === null ? '-' : `${num(v)} ${esc(r.satuan || '')}`) },
        { k: 'kirim_biji', judul: 'Dikirim (Biji)', num: true, fmt: (v) => (v === null ? '<span class="muted">?</span>' : num(v)) },
        { k: 'terima_biji', judul: 'Diterima (Biji)', num: true, fmt: (v) => (v === null ? '<span class="muted">-</span>' : num(v)) },
        { k: 'selisih_biji', judul: 'Selisih', num: true, fmt: (v) => `<span class="pill ${Number(v) === 0 ? 'ok' : 'bad'}">${num(v)}</span>` }], rows)}
      <p class="muted small">Bila toko salah input, koreksi di Trizone. Bila memang kurang / lebih kirim, koreksi nota di Accurate.</p>`,
    aksi: [{ label: 'Tutup', kelas: 'primary' }],
  });
}

// ---------------------------------------------------------------- Master barang
async function hBarang(el) {
  el.innerHTML = `${head('Master Barang', 'Kode, barcode, harga jual, dan satuan yang dipakai semua toko. Toko dengan daftar barang terkunci mengambilnya otomatis setiap buka shift.',
    `<button class="btn" id="brImport">Import Excel…</button><button class="btn" id="brIsi">Isi dari toko…</button><button class="btn" id="brHarga">Catat harga beli…</button>${isOwner() ? '<button class="btn" id="brMarkup">Markup…</button>' : ''}<button class="btn primary" id="brTambah">+ Barang</button>`)}
    <div class="card"><div class="card-head"><div class="row"><input id="brCari" placeholder="Cari nama atau SKU" style="min-width:220px"></div>
    <span class="muted small" id="brJumlah"></span></div><div id="brIsiTabel"></div></div>`;
  const markupRow = await q(sb.from('pengaturan').select('nilai').eq('kunci', 'markup_jual_ke_toko'));
  const markup = markupRow.length ? Number(markupRow[0].nilai) : null;
  let rows = [];

  async function muat() {
    const cari = $('#brCari', el).value.trim();
    let qy = sb.from('produk').select('*').order('nama').limit(1000);
    if (cari) qy = /^[A-Za-z0-9-]+$/.test(cari) && cari.length <= 20 ? qy.ilike('sku', `%${cari}%`) : qy.ilike('nama', `%${cari}%`);
    let [produk, harga] = await Promise.all([q(qy), q(sb.from('v_harga_produk').select('sku,harga_beli_dasar,sumber,harga_jual_ke_toko').limit(5000))]);
    if (cari && !produk.length && /^[A-Za-z0-9-]+$/.test(cari)) produk = await q(sb.from('produk').select('*').ilike('nama', `%${cari}%`).order('nama').limit(1000));
    const h = Object.fromEntries(harga.map((x) => [x.sku, x]));
    rows = produk.map((p) => ({ ...p, ...(h[p.sku] || {}) }));
    $('#brJumlah', el).textContent = `${num(rows.length)} barang${markup !== null ? ` · markup ke toko ${num(markup * 100, 1)}%` : ''}`;
    const box = $('#brIsiTabel', el);
    box.innerHTML = tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama', fmt: (v, r) => `${esc(v)}${r.aktif ? '' : ' <span class="pill">nonaktif</span>'}` },
      { k: 'barcode', judul: 'Barcode', fmt: (v) => `<span class="mono small">${esc(v || '-')}</span>` },
      { k: 'harga_jual_konsumen', judul: 'Harga jual', num: true, fmt: rp }, { k: 'satuan_masuk', judul: 'Satuan masuk', fmt: (v, r) => (v === 'Biji' ? 'Biji' : `1 Coly = ${num(r.rasio_isi)} Biji`) },
      { k: 'harga_beli_dasar', judul: 'Harga beli', num: true, fmt: (v, r) => (v === null || v === undefined ? '<span class="muted">-</span>' : `${rp(v)} <span class="muted small">${r.sumber === 'PRICELIST' ? 'pricelist' : 'beli'}</span>`) },
      { k: 'harga_jual_ke_toko', judul: 'Harga ke toko', num: true, fmt: rp }], rows, { klik: true, kosong: 'Belum ada barang. Isi dari daftar barang salah satu toko atau tambah manual.' });
    onBaris(box, rows, formBarang);
  }

  function formBarang(p) {
    const baru = !p;
    p = p || { aktif: true, satuan_masuk: 'Coly', rasio_isi: 1 };
    const biji = p.satuan_masuk === 'Biji';
    modal({
      judul: baru ? 'Tambah barang' : `Ubah ${p.sku}`,
      isi: `<form class="form" id="fBr" onsubmit="return false">
        <div class="grid g2"><label class="f">SKU<input id="fSku" value="${esc(p.sku || '')}" ${baru ? '' : 'readonly'} required></label>
          <label class="f">Barcode<input id="fBarcode" value="${esc(p.barcode || '')}" required></label></div>
        <label class="f">Nama barang<input id="fNama" value="${esc(p.nama || '')}" required></label>
        <div class="grid g2"><label class="f">Merk<input id="fMerk" value="${esc(p.merk || '')}"></label><label class="f">Kategori<input id="fKat" value="${esc(p.kategori || '')}"></label></div>
        <div class="grid g2"><label class="f">Harga jual di toko (Rp)<input id="fHarga" type="number" min="0" step="100" value="${esc(p.harga_jual_konsumen ?? '')}" required></label>
          <label class="f">Status<select id="fAktif"><option value="1" ${p.aktif ? 'selected' : ''}>Aktif</option><option value="0" ${p.aktif ? '' : 'selected'}>Nonaktif</option></select></label></div>
        <div class="grid g2"><label class="f">Satuan masuk (kiriman kantor ke toko)<select id="fSatuan">
            <option value="Coly" ${biji ? '' : 'selected'}>Coly</option><option value="Biji" ${biji ? 'selected' : ''}>Biji</option></select></label>
          <label class="f">Isi 1 Coly (Biji)<input id="fRasio" type="number" min="1" value="${esc(biji ? 1 : p.rasio_isi || 1)}" ${biji ? 'disabled' : ''}></label></div>
        <p class="muted small" style="margin:0"><b>Isi 1 Coly</b> harus sama dengan isi 1 Coly di Accurate: dipakai untuk mencocokkan surat jalan dan untuk membulatkan usulan beli.</p></form>`,
      onBuka: (m) => $('#fSatuan', m).addEventListener('change', (e) => {
        const r = $('#fRasio', m);
        r.disabled = e.target.value === 'Biji';
        if (r.disabled) r.value = 1;
      }),
      aksi: [{ label: 'Batal' }, { label: 'Simpan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
        const v = (id) => $(id, m).value.trim();
        const data = { nama: v('#fNama'), barcode: v('#fBarcode') || null, merk: v('#fMerk') || null, kategori: v('#fKat') || null,
          harga_jual_konsumen: v('#fHarga') === '' ? null : Number(v('#fHarga')),
          satuan_masuk: v('#fSatuan'), rasio_isi: v('#fSatuan') === 'Biji' ? 1 : Number(v('#fRasio')) || 1, aktif: v('#fAktif') === '1' };
        if (!data.nama || (baru && !v('#fSku'))) throw new Error('SKU dan nama wajib diisi.');
        if (baru) await q(sb.from('produk').insert({ sku: v('#fSku'), ...data }));
        else await q(sb.from('produk').update(data).eq('sku', p.sku));
        tutup(); toast('Barang disimpan.'); muat();
      } }],
    });
  }

  $('#brTambah', el).addEventListener('click', () => formBarang(null));
  $('#brImport', el).addEventListener('click', () => importExcel(() => muat()));
  $('#brCari', el).addEventListener('input', () => { clearTimeout(S.tCari); S.tCari = setTimeout(() => muat().catch((e) => toast(pesanError(e), 'bad')), 250); });
  $('#brIsi', el).addEventListener('click', () => modal({
    judul: 'Isi master dari daftar barang toko',
    isi: `<p style="margin-top:0">Barang dari daftar barang Trizone toko ini yang belum ada di master ditambahkan. Barang yang sudah ada tidak diubah.</p><label class="f">Toko${pilihToko('isiToko', '', '')}</label>`,
    aksi: [{ label: 'Batal' }, { label: 'Isi', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
      const n = await rpc('isi_master_dari_toko', { p_kode: $('#isiToko', m).value });
      tutup(); toast(`${num(n)} barang ditambahkan ke master.`); muat();
    } }],
  }));
  $('#brHarga', el).addEventListener('click', () => modal({
    judul: 'Catat harga beli',
    isi: `<form class="form" onsubmit="return false"><label class="f">SKU<input id="hSku" list="hSkuList" required><datalist id="hSkuList">${rows.map((r) => `<option value="${esc(r.sku)}">${esc(r.nama)}</option>`).join('')}</datalist></label>
      <div class="grid g2"><label class="f">Berlaku mulai<input id="hTgl" type="date" value="${hariIni()}"></label><label class="f">Harga (Rp per Biji)<input id="hHarga" type="number" min="0" step="1"></label></div>
      <div class="grid g2"><label class="f">Sumber<select id="hSumber"><option value="PRICELIST">Pricelist pabrik</option><option value="PEMBELIAN">Pembelian</option></select></label>
      <label class="f">Referensi<input id="hRef" placeholder="mis. Pricelist Nov 2026"></label></div></form>`,
    aksi: [{ label: 'Batal' }, { label: 'Simpan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
      const sku = $('#hSku', m).value.trim();
      const harga = Number($('#hHarga', m).value);
      if (!sku || !(harga >= 0) || $('#hHarga', m).value === '') throw new Error('SKU dan harga wajib diisi.');
      await q(sb.from('harga_beli').upsert({ sku, berlaku_at: $('#hTgl', m).value, harga, sumber: $('#hSumber', m).value, referensi: $('#hRef', m).value || null }, { onConflict: 'sku,berlaku_at,sumber' }));
      tutup(); toast('Harga beli disimpan. Harga jual ke toko ikut diperbarui.'); muat();
    } }],
  }));
  if ($('#brMarkup', el)) {
    $('#brMarkup', el).addEventListener('click', () => modal({
      judul: 'Markup harga jual ke toko',
      isi: `<label class="f">Markup (%)<input id="mkNilai" type="number" step="0.1" min="0" value="${markup !== null ? num(markup * 100, 2).replace(',', '.') : ''}"></label>
        <p class="muted small">Harga jual kantor ke toko = harga beli dasar × (1 + markup). Harga beli dasar = harga pembelian terakhir atau pricelist terbaru.</p>`,
      aksi: [{ label: 'Batal' }, { label: 'Simpan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
        const v = Number($('#mkNilai', m).value);
        if (!(v >= 0)) throw new Error('Isi angka markup.');
        await q(sb.from('pengaturan').upsert({ kunci: 'markup_jual_ke_toko', nilai: Math.round(v * 100) / 10000 }, { onConflict: 'kunci' }));
        tutup(); toast('Markup disimpan.'); route();
      } }],
    }));
  }
  await muat();
}

// Import master barang dari Excel: baca file di browser → pratinjau (import_produk tanpa simpan) → simpan.
function importExcel(selesai) {
  let file = null;
  let data = null;
  const m = modal({
    judul: 'Import barang dari Excel', lebar: true,
    isi: `<p style="margin-top:0">Format sama dengan template import barang Trizone, ditambah kolom kantor <b>Harga_Beli</b> (per Biji) dan <b>Aktif</b>.
        File "data item" (Kode Item, Nama Item, Jenis, Harga Jual) juga bisa. Satuan_Masuk diisi <b>Coly</b> atau <b>Biji</b> (Dus / Karton dibaca Coly, Pcs dibaca Biji).
        <b>Sel kosong tidak mengubah data lama.</b> Barang yang tidak ada di file tidak dihapus.</p>
      <div class="row"><button class="btn sm" id="imTemplate">Unduh template</button><button class="btn sm" id="imMaster">Unduh master saat ini</button>
        <span class="muted small">Cara termudah: unduh master, ubah di Excel, lalu import kembali.</span></div>
      <div class="grid g2" style="margin-top:12px"><label class="f">File Excel<input type="file" id="imFile" accept=".xlsx,.xls"></label>
        <label class="f">Harga beli berlaku mulai<input type="date" id="imTgl" value="${hariIni()}"></label></div>
      <div id="imHasil"></div>`,
    aksi: [{ label: 'Batal' }, { label: 'Simpan ke master', kelas: 'primary', onClick: async ({ tutup }) => {
      if (!data) throw new Error('Pilih file Excel dulu.');
      if (!data.cek.ok || data.file.masalah.length) throw new Error('Perbaiki kesalahan di file dulu, lalu pilih file lagi.');
      const r = await rpc('import_produk', { p_baris: data.file.baris, p_simpan: true, p_tanggal_harga: $('#imTgl', m.el).value || hariIni() });
      if (!r.disimpan) throw new Error('Tidak disimpan: data di server berubah. Pilih file lagi untuk memeriksa ulang.');
      tutup();
      toast(`Import selesai: ${num(r.baru)} barang baru, ${num(r.diubah)} diubah, ${num(r.harga_beli)} harga beli dicatat.`);
      selesai();
    } }],
  });
  const tombolSimpan = $('.modal-kaki .primary', m.el);
  tombolSimpan.disabled = true;

  $('#imTemplate', m.el).addEventListener('click', () => XLSX.writeFile(MbImportBarang.workbook(MbImportBarang.CONTOH), 'Template_Import_Barang.xlsx'));
  $('#imMaster', m.el).addEventListener('click', (e) => sibuk(e.target, async () => {
    const [produk, harga] = await Promise.all([
      ambilSemua(() => sb.from('produk').select('*').order('sku')),
      ambilSemua(() => sb.from('v_harga_produk').select('sku,harga_beli_dasar').order('sku')),
    ]);
    const hb = Object.fromEntries(harga.map((h) => [h.sku, h.harga_beli_dasar]));
    XLSX.writeFile(MbImportBarang.workbook(MbImportBarang.barisMaster(produk, hb)), `Master_Barang_${hariIni()}.xlsx`);
  }));

  async function periksa() {
    const box = $('#imHasil', m.el);
    tombolSimpan.disabled = true;
    data = null;
    if (!file) return;
    box.innerHTML = '<div class="kosong">Membaca dan memeriksa file…</div>';
    try {
      const f = MbImportBarang.bacaFile(await file.arrayBuffer());
      if (!f.baris.length) throw new Error('Tidak ada baris barang (dengan SKU / Kode Item) di file ini.');
      const cek = await rpc('import_produk', { p_baris: f.baris, p_simpan: false, p_tanggal_harga: $('#imTgl', m.el).value || hariIni() });
      data = { file: f, cek };
      const salah = [...f.masalah, ...cek.error].sort((a, b) => a.baris - b.baris);
      const nSalah = f.masalah.length + cek.jumlah_error;
      const bisa = nSalah === 0 && (cek.baru + cek.diubah + cek.harga_beli) > 0;
      tombolSimpan.disabled = !bisa;
      box.innerHTML = `<div class="grid" style="margin-top:12px">
        <div class="alert ${nSalah ? 'bad' : 'ok'}"><b>${esc(file.name)}</b> · lembar ${esc(f.lembar)} · format ${esc(f.format)} · judul kolom di baris ${num(f.barisJudul)}<br>
          ${num(cek.jumlah)} barang: <b>${num(cek.baru)} baru</b>, <b>${num(cek.diubah)} diubah</b>, ${num(cek.sama)} sama${cek.harga_beli ? ` · ${num(cek.harga_beli)} harga beli baru` : ''}
          <br><span class="small">Kolom terbaca: ${f.kolom.map((k) => esc(k.judul)).join(', ')}</span>
          ${nSalah ? `<br><b>${num(nSalah)} kesalahan. Perbaiki di Excel, simpan, lalu pilih file lagi.</b>` : ''}</div>
        ${f.tanpaSku.length ? `<div class="alert warn">${num(f.tanpaSku.length)} baris tanpa SKU dilewati (baris ${f.tanpaSku.slice(0, 15).join(', ')}${f.tanpaSku.length > 15 ? ', …' : ''}).</div>` : ''}
        ${cek.belum_lengkap ? `<div class="alert warn">${num(cek.belum_lengkap)} barang belum punya barcode atau harga jual, jadi belum dikirim ke toko sampai dilengkapi.</div>` : ''}
        ${salah.length ? tabel([{ k: 'baris', judul: 'Baris', num: true }, { k: 'pesan', judul: 'Kesalahan' }], salah.slice(0, 200)) : ''}
        ${!nSalah && cek.perubahan.length ? tabel([{ k: 'baris', judul: 'Baris', num: true }, { k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` },
          { k: 'nama', judul: 'Nama' }, { k: 'status', judul: '', fmt: (v) => (v === 'BARU' ? '<span class="pill ok">Baru</span>' : '<span class="pill info">Diubah</span>') },
          { k: 'detail', judul: 'Perubahan', fmt: (v) => `<span class="small">${esc(v)}</span>` }], cek.perubahan) : ''}
        ${!nSalah && !bisa ? '<div class="alert">Tidak ada perubahan: isi file sama dengan master.</div>' : ''}
        ${cek.perubahan.length >= 500 ? '<p class="muted small" style="margin:0">Hanya 500 perubahan pertama yang ditampilkan.</p>' : ''}</div>`;
    } catch (err) { box.innerHTML = `<div class="alert bad" style="margin-top:12px">${esc(pesanError(err))}</div>`; }
  }
  $('#imFile', m.el).addEventListener('change', (e) => { file = e.target.files[0] || null; periksa(); });
  $('#imTgl', m.el).addEventListener('change', periksa);
}

// ---------------------------------------------------------------- Pembelian
async function hPembelian(el) {
  let tab = S.tabPembelian || 'po';
  el.innerHTML = `${head('Pembelian', 'Usulan beli dihitung dari penjualan semua toko, stok gudang, stok toko, dan PO yang belum datang. Owner menyetujui, admin memasukkan ke Accurate.')}
    ${tabs('pbTab', [['po', 'Purchase order'], ['usulan', 'Usulan beli']], tab)}<div id="pbIsi"></div>`;
  pasangTabs(el, 'pbTab', (t) => { tab = t; S.tabPembelian = t; tampil(); });
  const isi = $('#pbIsi', el);

  async function tampil() {
    isi.innerHTML = '<div class="card"><div class="kosong">Memuat…</div></div>';
    try { await (tab === 'po' ? daftarPo() : usulan()); } catch (e) { isi.innerHTML = `<div class="card"><div class="kosong">${esc(pesanError(e))}</div></div>`; }
  }

  async function usulan() {
    const [rows, atur] = await Promise.all([rpc('laporan_usulan_beli'), q(sb.from('pengaturan').select('kunci,nilai').in('kunci', ['usulan_lead_time_hari', 'usulan_periode_order_hari', 'usulan_stok_pengaman_hari']))]);
    const a = Object.fromEntries(atur.map((x) => [x.kunci, Number(x.nilai)]));
    const lead = a.usulan_lead_time_hari ?? 7;
    const per = a.usulan_periode_order_hari ?? 7;
    const aman = a.usulan_stok_pengaman_hari ?? 3;
    isi.innerHTML = `<div class="card"><div class="card-head"><div><h2>Usulan beli</h2>
        <div class="muted small" id="pbAturTeks">Lead time ${num(lead)} hari · order tiap ${num(per)} hari · stok pengaman ${num(aman)} hari · dibulatkan ke isi 1 Coly</div></div>
        <div class="row">${isOwner() ? '<button class="btn sm" id="pbAtur">Pengaturan…</button>' : ''}${rows.length ? '<button class="btn primary sm" id="pbBuat">Buat usulan PO</button>' : ''}</div></div>
      ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama' },
        { k: 'rata_harian', judul: 'Jual / hari', num: true, fmt: (v) => num(v, 1) },
        { k: 'stok_gudang', judul: 'Stok gudang', num: true, fmt: (v) => num(v) }, { k: 'stok_toko', judul: 'Stok toko', num: true, fmt: (v) => num(v) },
        { k: 'po_belum_datang', judul: 'PO jalan', num: true, fmt: (v) => num(v) },
        { k: 'usulan_qty', judul: 'Usulan', num: true, fmt: (v, r) => `<b>${num(v)} Biji</b>${r.satuan_masuk === 'Coly' && Number(r.isi_kemasan) > 1 ? `<div class="muted small">${num(Number(v) / Number(r.isi_kemasan))} Coly</div>` : ''}` }],
      rows, { kosong: 'Tidak ada barang yang perlu dibeli saat ini.' })}</div>`;
    isi.onclick = (e) => {
      if (e.target.closest('#pbBuat')) {
        sibuk(e.target.closest('#pbBuat'), async () => { const no = await rpc('buat_po_dari_usulan'); toast(`Usulan ${no} dibuat.`); tab = 'po'; S.tabPembelian = 'po'; route(); });
      }
      if (e.target.closest('#pbAtur')) {
        modal({
          judul: 'Pengaturan usulan beli',
          isi: `<div class="grid g2"><label class="f">Lead time (hari: dari pesan sampai barang tiba)<input id="atLead" type="number" min="0" value="${lead}"></label>
            <label class="f">Periode order (hari: order tiap berapa hari)<input id="atPer" type="number" min="1" value="${per}"></label></div>
            <label class="f">Stok pengaman (hari penjualan cadangan)<input id="atAman" type="number" min="0" value="${aman}"></label>
            <p class="muted small">Usulan = rata-rata jual harian × (lead time + periode order) + stok pengaman − (stok gudang + stok toko + PO belum datang), dibulatkan ke isi 1 Coly.</p>`,
          aksi: [{ label: 'Batal' }, { label: 'Simpan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
            const n = (id) => Number($(id, m).value);
            if (!(n('#atLead') >= 0 && n('#atPer') >= 1 && n('#atAman') >= 0)) throw new Error('Isi angka hari yang benar.');
            await q(sb.from('pengaturan').upsert([{ kunci: 'usulan_lead_time_hari', nilai: n('#atLead') }, { kunci: 'usulan_periode_order_hari', nilai: n('#atPer') },
              { kunci: 'usulan_stok_pengaman_hari', nilai: n('#atAman') }], { onConflict: 'kunci' }));
            tutup(); toast('Pengaturan usulan disimpan.'); tampil();
          } }],
        });
      }
    };
  }

  async function daftarPo() {
    const rows = await q(sb.from('po').select('*').order('tanggal', { ascending: false }).order('no_po', { ascending: false }).limit(200));
    isi.innerHTML = `<div class="card">${tabel([{ k: 'no_po', judul: 'No. PO', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'tanggal', judul: 'Tanggal', fmt: (v) => esc(fmtTgl(v)) },
      { k: 'status', judul: 'Status', fmt: (v) => pill(STATUS_PO, v) },
      { k: 'no_po_accurate', judul: 'No. PO Accurate', fmt: (v) => esc(v || '-') }, { k: 'disetujui_at', judul: 'Disetujui', fmt: (v) => esc(v ? fmtWaktu(v) : '-') }],
    rows, { klik: true, kosong: 'Belum ada PO. Buat dari tab Usulan beli.' })}</div>`;
    onBaris(isi, rows, (po) => detailPo(po, tampil));
  }

  async function detailPo(po, segarkan) {
    const [baris, terima] = await Promise.all([
      q(sb.from('po_baris').select('*').eq('no_po', po.no_po).order('sku')),
      q(sb.from('penerimaan_principal').select('no_terima').eq('no_po', po.no_po)),
    ]);
    const produk = baris.length ? await q(sb.from('produk').select('sku,nama').in('sku', baris.map((b) => b.sku))) : [];
    const nm = Object.fromEntries(produk.map((p) => [p.sku, p.nama]));
    let sudah = {};
    if (terima.length) {
      const tb = await q(sb.from('penerimaan_principal_baris').select('sku,qty').in('no_terima', terima.map((t) => t.no_terima)));
      for (const t of tb) sudah[t.sku] = (sudah[t.sku] || 0) + Number(t.qty);
    }
    const bisaSetujui = isOwner() && po.status === 'USULAN';
    const total = baris.reduce((a, b) => a + Number(b.qty_disetujui ?? b.qty_usulan) * Number(b.harga || 0), 0);
    const aksi = [{ label: 'Unduh CSV untuk Accurate', onClick: () => unduhCsv(`${po.no_po}.csv`, [{ k: 'sku', judul: 'Kode' }, { k: 'nama', judul: 'Nama' }, { k: 'qty', judul: 'Qty (Biji)' }, { k: 'harga', judul: 'Harga' }],
      baris.map((b) => ({ sku: b.sku, nama: nm[b.sku] || '', qty: b.qty_disetujui ?? b.qty_usulan, harga: b.harga }))) }];
    if (['USULAN', 'DISETUJUI'].includes(po.status)) aksi.push({ label: 'Batalkan PO', kelas: 'danger', onClick: async ({ tutup }) => {
      if (!(await konfirmasi('Batalkan PO', `Batalkan ${esc(po.no_po)}?`, 'Batalkan', true))) return;
      await rpc('ubah_status_po', { p_no_po: po.no_po, p_status: 'BATAL' }); tutup(); toast('PO dibatalkan.'); segarkan();
    } });
    if (po.status === 'DISETUJUI') aksi.push({ label: 'Tandai sudah dikirim ke pemasok', onClick: async ({ tutup, el: m }) => {
      await rpc('ubah_status_po', { p_no_po: po.no_po, p_status: 'DIKIRIM', p_no_po_accurate: ($('#poAcc', m) || {}).value || null }); tutup(); toast('PO ditandai dikirim.'); segarkan();
    } });
    if (['DISETUJUI', 'DIKIRIM', 'SEBAGIAN'].includes(po.status)) aksi.push({ label: 'Terima barang…', onClick: ({ tutup }) => { tutup(); formTerima(po, baris, nm, sudah, segarkan); } });
    if (bisaSetujui) aksi.push({ label: 'Setujui PO', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
      const p = $$('[data-qty]', m).map((i) => ({ sku: i.dataset.qty, qty: Number(i.value) }));
      if (p.some((x) => !(x.qty >= 0))) throw new Error('Qty harus angka 0 atau lebih.');
      await rpc('setujui_po', { p_no_po: po.no_po, p }); tutup(); toast(`${po.no_po} disetujui.`); segarkan();
    } });
    modal({
      judul: po.no_po, lebar: true,
      isi: `<p class="muted" style="margin-top:0">${esc(fmtTgl(po.tanggal))} · ${pill(STATUS_PO, po.status)} · perkiraan nilai ${rp(total)}${po.status === 'USULAN' && !isOwner() ? ' · menunggu persetujuan owner' : ''}</p>
        ${po.status === 'DISETUJUI' ? '<label class="f" style="margin-bottom:12px">No. PO di Accurate (diisi setelah dimasukkan ke Accurate)<input id="poAcc"></label>' : ''}
        ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama', fmt: (v, r) => esc(nm[r.sku] || '') },
          { k: 'qty_usulan', judul: 'Usulan', num: true, fmt: (v) => num(v) },
          { k: 'qty_disetujui', judul: 'Disetujui', num: true, fmt: (v, r) => (bisaSetujui ? `<input type="number" min="0" data-qty="${esc(r.sku)}" value="${esc(v ?? r.qty_usulan)}" style="width:90px;text-align:right" aria-label="Qty ${esc(r.sku)}">` : num(v)) },
          { k: 'diterima', judul: 'Diterima', num: true, fmt: (v, r) => num(sudah[r.sku] || 0) }, { k: 'harga', judul: 'Harga', num: true, fmt: rp },
          { k: 'alasan', judul: 'Alasan', fmt: (v) => `<span class="small muted">${esc(v || '')}</span>` }], baris)}`,
      aksi,
    });
  }

  function formTerima(po, baris, nm, sudah, segarkan) {
    modal({
      judul: `Terima barang ${po.no_po}`, lebar: true,
      isi: `<div class="grid g2" style="margin-bottom:12px"><label class="f">No. penerimaan<input id="trNo" value="TR-${po.no_po.replace(/^PO-/, '')}-${Object.keys(sudah).length ? 2 : 1}"></label>
        <label class="f">Tanggal<input id="trTgl" type="date" value="${hariIni()}"></label></div>
        ${tabel([{ k: 'sku', judul: 'SKU', fmt: (v) => `<span class="mono">${esc(v)}</span>` }, { k: 'nama', judul: 'Nama', fmt: (v, r) => esc(nm[r.sku] || '') },
          { k: 'sisa', judul: 'Sisa', num: true, fmt: (v, r) => num(Number(r.qty_disetujui ?? r.qty_usulan) - (sudah[r.sku] || 0)) },
          { k: 'qty', judul: 'Diterima', num: true, fmt: (v, r) => `<input type="number" min="0" data-tq="${esc(r.sku)}" value="${Math.max(0, Number(r.qty_disetujui ?? r.qty_usulan) - (sudah[r.sku] || 0))}" style="width:90px;text-align:right">` },
          { k: 'harga', judul: 'Harga beli / Biji', num: true, fmt: (v, r) => `<input type="number" min="0" data-th="${esc(r.sku)}" value="${esc(v ?? '')}" style="width:110px;text-align:right">` }], baris)}
        <p class="muted small">Stok gudang kantor bertambah dan harga beli diperbarui (harga jual ke toko ikut berubah).</p>`,
      aksi: [{ label: 'Batal' }, { label: 'Simpan penerimaan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
        const p = baris.map((b) => ({ sku: b.sku, qty: Number($(`[data-tq="${b.sku}"]`, m).value || 0), harga: $(`[data-th="${b.sku}"]`, m).value || null }));
        const r = await rpc('terima_po', { p_no_po: po.no_po, p_no_terima: $('#trNo', m).value.trim(), p_tanggal: $('#trTgl', m).value, p });
        tutup(); toast(`Penerimaan disimpan. Status PO: ${(STATUS_PO[r.status] || [])[1] || r.status}.`); segarkan();
      } }],
    });
  }
  await tampil();
}

// ---------------------------------------------------------------- Toko
async function hToko(el) {
  el.innerHTML = `${head('Toko', 'Koneksi Trizone tiap toko, kunci toko, dan pemetaan pelanggan Accurate.', tombolTarik('tkTarik', 'Tarik data semua toko'))}
    <div class="card"><div class="card-head"><h2>Koneksi toko</h2></div><div id="tkDaftar"></div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Menghubungkan Trizone</h2>
        <ol style="margin:0;padding-left:18px;display:grid;gap:6px">
          <li>Di PC Gudang toko, login Admin lalu buka <b>Pengaturan → Mother Base</b>.</li>
          <li>Isi alamat dan anon key di bawah, kode toko, dan <b>kunci toko</b> (dibuat owner di tabel atas).</li>
          <li>Tekan <b>Simpan</b> lalu <b>Tes Koneksi</b>. Data terkirim otomatis saat aplikasi toko dibuka, tiap 3 jam, dan setiap tutup shift.</li>
        </ol>
        <label class="f" style="margin-top:12px">Alamat mother base<div class="row"><input readonly value="${esc(CFG.url)}" style="flex:1"><button class="btn sm" data-salin="${esc(CFG.url)}">Salin</button></div></label>
        <label class="f" style="margin-top:8px">Anon key<div class="row"><input readonly value="${esc(CFG.anonKey)}" style="flex:1"><button class="btn sm" data-salin="${esc(CFG.anonKey)}">Salin</button></div></label></div>
      <div class="card"><h2>Pelanggan Accurate → toko</h2><p class="muted small" style="margin-top:-4px">"X Special" adalah toko yang sama dengan "X". Surat jalan pelanggan yang belum dipetakan tidak bisa dicocokkan.</p><div id="tkPel"></div></div>
    </div>`;
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-salin]'); if (b) salin(b.dataset.salin); });
  $('#tkTarik', el).addEventListener('click', async (e) => { await tarikData(null, () => muat(), e.currentTarget); muat(); });

  async function muat() {
    S.toko = await rpc('status_koneksi_toko');
    const box = $('#tkDaftar', el);
    box.innerHTML = tabel([{ k: 'kode', judul: 'Kode', fmt: (v) => `<b class="mono">${esc(v)}</b>` }, { k: 'nama', judul: 'Toko', fmt: (v, r) => `${esc(v)}<div class="muted small">${esc(r.kota)}${r.aktif ? '' : ' · nonaktif'}</div>` },
      { k: 'punya_kunci', judul: 'Kunci toko', fmt: (v, r) => (v ? `<span class="pill ok">Ada</span><div class="muted small">${esc(fmtTgl(r.kunci_dibuat_at))}</div>` : '<span class="pill warn">Belum</span>') },
      { k: 'kiriman_terakhir_at', judul: 'Data terakhir masuk', fmt: (v, r) => `<span class="pill ${!v ? '' : Date.now() - new Date(v) > 26 * 3600e3 ? 'warn' : 'ok'}">${esc(relatif(v))}</span>${r.minta_update_at
        ? `<div class="muted small">menunggu toko… (diminta ${esc(relatif(r.minta_update_at))}${r.minta_update_oleh ? ` oleh ${esc(r.minta_update_oleh)}` : ''})</div>` : ''}` },
      { k: 'shift_terakhir_at', judul: 'Tutup shift terakhir', fmt: (v) => esc(v ? fmtWaktu(v) : '-') }, { k: 'versi_trizone', judul: 'Versi Trizone', fmt: (v) => esc(v || '-') },
      { k: 'batas_hari_sj', judul: 'Batas input SJ', num: true, fmt: (v) => `${num(v)} hari` },
      { k: 'aksi', judul: '', fmt: (v, r) => `<div class="row">${r.punya_kunci && r.aktif ? `<button class="btn sm" data-tarik="${esc(r.kode)}">Tarik data</button>` : ''}${isOwner() ? `<button class="btn sm" data-ubah="${esc(r.kode)}">Ubah</button><button class="btn sm ${r.punya_kunci ? '' : 'primary'}" data-kunci="${esc(r.kode)}">${r.punya_kunci ? 'Ganti kunci' : 'Buat kunci'}</button>` : ''}</div>` }],
    S.toko);
    box.onclick = async (e) => {
      const k = e.target.closest('[data-kunci]');
      const u = e.target.closest('[data-ubah]');
      const tk = e.target.closest('[data-tarik]');
      if (tk) { await tarikData(tk.dataset.tarik, () => muat(), tk); muat(); return; }
      if (k) {
        const t = S.toko.find((x) => x.kode === k.dataset.kunci);
        if (t.punya_kunci && !(await konfirmasi('Ganti kunci toko', `Kunci lama <b>${esc(t.kode)}</b> langsung tidak berlaku. Trizone toko ini berhenti mengirim data sampai kunci baru diisi di Pengaturan → Mother Base. Lanjutkan?`, 'Ganti kunci', true))) return;
        const kunci = await sibuk(k, () => rpc('buat_kunci_toko', { p_kode: t.kode }));
        if (!kunci) return;
        modal({ judul: `Kunci toko ${t.kode}`, isi: `<div class="alert warn" style="margin-bottom:12px">Kunci ini hanya ditampilkan <b>sekali</b>. Salin dan isi di Trizone toko ${esc(t.nama)} (Pengaturan → Mother Base → Kunci toko).</div>
          <div class="kunci-box" id="kunciBox">${esc(kunci)}</div>`, aksi: [{ label: 'Salin kunci', onClick: () => salin(kunci) }, { label: 'Selesai', kelas: 'primary' }] });
        muat();
      }
      if (u) {
        const t = S.toko.find((x) => x.kode === u.dataset.ubah);
        modal({ judul: `Ubah toko ${t.kode}`, isi: `<form class="form" onsubmit="return false"><label class="f">Nama<input id="tNama" value="${esc(t.nama)}"></label>
          <div class="grid g2"><label class="f">Kota<input id="tKota" value="${esc(t.kota)}"></label><label class="f">Batas input surat jalan (hari)<input id="tBatas" type="number" min="1" value="${esc(t.batas_hari_sj)}"></label></div>
          <label class="f">Status<select id="tAktif"><option value="1" ${t.aktif ? 'selected' : ''}>Aktif</option><option value="0" ${t.aktif ? '' : 'selected'}>Nonaktif</option></select></label></form>`,
        aksi: [{ label: 'Batal' }, { label: 'Simpan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
          await q(sb.from('toko').update({ nama: $('#tNama', m).value.trim(), kota: $('#tKota', m).value.trim(), batas_hari_sj: Number($('#tBatas', m).value) || 1, aktif: $('#tAktif', m).value === '1' }).eq('kode', t.kode));
          tutup(); toast('Toko disimpan.'); muat();
        } }] });
      }
    };
    const pel = await q(sb.from('pelanggan_accurate').select('*').order('nama'));
    $('#tkPel', el).innerHTML = tabel([{ k: 'nama', judul: 'Pelanggan Accurate' }, { k: 'kode_toko', judul: 'Toko', fmt: (v, r) => `<select data-pel="${esc(r.nama)}" aria-label="Toko untuk ${esc(r.nama)}">
      <option value="">— belum dipetakan —</option>${S.toko.map((t) => `<option value="${esc(t.kode)}" ${t.kode === v ? 'selected' : ''}>${esc(t.kode)} · ${esc(t.nama)}</option>`).join('')}</select>` }],
    pel, { kosong: 'Pelanggan muncul setelah surat jalan pertama diupload.' });
    $('#tkPel', el).onchange = async (e) => {
      const s = e.target.closest('[data-pel]');
      if (!s) return;
      try { await q(sb.from('pelanggan_accurate').update({ kode_toko: s.value || null }).eq('nama', s.dataset.pel)); toast(`${s.dataset.pel} → ${s.value || 'belum dipetakan'}`); } catch (err) { toast(pesanError(err), 'bad'); }
    };
  }
  await muat();
}

// ---------------------------------------------------------------- Pengguna
async function hPengguna(el) {
  el.innerHTML = `${head('Pengguna', 'Akun login dibuat di Supabase (Authentication → Users → Add user). Setelah itu atur nama dan perannya di sini.', '<button class="btn primary" id="pgTambah">+ Atur pengguna</button>')}
    <div class="card" id="pgDaftar"></div>`;
  async function muat() {
    const rows = await rpc('daftar_pengguna');
    const box = $('#pgDaftar', el);
    box.innerHTML = tabel([{ k: 'nama', judul: 'Nama', fmt: (v) => `<b>${esc(v)}</b>` }, { k: 'email', judul: 'Email' }, { k: 'peran', judul: 'Peran', fmt: (v) => esc(LABEL_PERAN[v] || v) },
      { k: 'kode_toko', judul: 'Toko', fmt: (v) => esc(v || '-') }, { k: 'aktif', judul: 'Status', fmt: (v) => `<span class="pill ${v ? 'ok' : ''}">${v ? 'Aktif' : 'Nonaktif'}</span>` }],
    rows, { klik: true });
    onBaris(box, rows, form);
  }
  function form(u) {
    u = u || { aktif: true, peran: 'admin_kantor' };
    modal({
      judul: u.email ? `Ubah ${u.email}` : 'Atur pengguna',
      isi: `<form class="form" onsubmit="return false"><label class="f">Email akun<input id="uEmail" type="email" value="${esc(u.email || '')}" ${u.email ? 'readonly' : ''}></label>
        <label class="f">Nama<input id="uNama" value="${esc(u.nama || '')}"></label>
        <div class="grid g2"><label class="f">Peran<select id="uPeran">${Object.entries(LABEL_PERAN).map(([k, l]) => `<option value="${k}" ${k === u.peran ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="f" id="uTokoL">Toko${pilihToko('uToko', u.kode_toko || '', '')}</label></div>
        <label class="f">Status<select id="uAktif"><option value="1" ${u.aktif ? 'selected' : ''}>Aktif</option><option value="0" ${u.aktif ? '' : 'selected'}>Nonaktif</option></select></label>
        <p class="muted small" style="margin:0">Owner: semua menu, menyetujui PO, membuat kunci toko. Admin / gudang / purchasing: semua menu kantor. Pemilik toko: hanya data tokonya.</p></form>`,
      onBuka: (m) => { const ubah = () => $('#uTokoL', m).classList.toggle('hidden', $('#uPeran', m).value !== 'pemilik_toko'); $('#uPeran', m).addEventListener('change', ubah); ubah(); },
      aksi: [{ label: 'Batal' }, { label: 'Simpan', kelas: 'primary', onClick: async ({ tutup, el: m }) => {
        const pr = $('#uPeran', m).value;
        await rpc('atur_pengguna', { p_email: $('#uEmail', m).value.trim(), p_nama: $('#uNama', m).value.trim(), p_peran: pr,
          p_kode_toko: pr === 'pemilik_toko' ? $('#uToko', m).value : null, p_aktif: $('#uAktif', m).value === '1' });
        tutup(); toast('Pengguna disimpan.'); muat();
      } }],
    });
  }
  $('#pgTambah', el).addEventListener('click', () => form(null));
  await muat();
}

// ---------------------------------------------------------------- Asisten AI
function markdown(teks) {
  const baris = esc(teks).split('\n');
  const out = [];
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, '$1<i>$2</i>').replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,]|$)/g, '$1<i>$2</i>');
  for (let i = 0; i < baris.length; i++) {
    const b = baris[i];
    if (/^\s*\|.*\|\s*$/.test(b) && i + 1 < baris.length && /^\s*\|[\s:|-]+\|\s*$/.test(baris[i + 1])) {
      const sel = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const h = sel(b);
      i += 2;
      const rows = [];
      while (i < baris.length && /^\s*\|.*\|\s*$/.test(baris[i])) rows.push(sel(baris[i++]));
      i--;
      out.push(`<table><thead><tr>${h.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^\s*[-*] /.test(b)) {
      const items = [];
      while (i < baris.length && /^\s*[-*] /.test(baris[i])) items.push(inline(baris[i++].replace(/^\s*[-*] /, '')));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`);
    } else if (/^#{1,4} /.test(b)) {
      out.push(`<p><b>${inline(b.replace(/^#+ /, ''))}</b></p>`);
    } else if (b.trim()) {
      out.push(`<p>${inline(b)}</p>`);
    }
  }
  return out.join('');
}

function riwayatTampil(pesan) {
  const out = [];
  const teks = (c) => c.filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
  for (const m of pesan || []) {
    if (m.role === 'user' && typeof m.content === 'string') out.push({ dari: 'pengguna', teks: m.content.replace(/^\[Konteks\][^\n]*\n\n/, '') });
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const t = teks(m.content);
      if (t && !m.content.some((b) => b.type === 'tool_use')) out.push({ dari: 'asisten', teks: t });
    }
  }
  return out;
}

const NAMA_ALAT = { daftar_toko: 'daftar toko', ringkasan_penjualan: 'ringkasan penjualan', penjualan_harian: 'penjualan harian', produk_terlaris: 'produk terlaris',
  tren_produk: 'tren produk', analisa_abc: 'analisa ABC', cari_stok: 'stok', stok_lambat: 'stok lambat', usulan_beli: 'usulan beli', status_surat_jalan: 'surat jalan',
  selisih_stok_opname: 'selisih SO' };

async function hAsisten(el) {
  el.innerHTML = `${head('Asisten AI', 'Tanya tentang penjualan, stok, surat jalan, atau pembelian. Jawaban diambil dari data mother base dengan hak akses Anda.')}
    <div class="chat-layout"><div class="card"><div class="card-head"><h2>Percakapan</h2><button class="btn sm primary" id="aiBaru">+ Baru</button></div><div class="chat-list" id="aiList"></div></div>
    <div class="card chat-panel"><div class="chat-msgs" id="aiMsgs"></div><div class="saran" id="aiSaran"></div>
      <form class="chat-input" id="aiForm"><textarea id="aiInput" rows="2" placeholder="Tulis pertanyaan…" aria-label="Pertanyaan"></textarea><button class="btn primary" id="aiKirim">Kirim</button></form></div></div>`;
  let aktif = null; // { id }
  let pending = null;
  const SARAN = ['Produk apa yang naik minggu ini?', 'Bandingkan omzet semua toko bulan ini', 'Barang apa yang stoknya lambat di TRP?', 'Jelaskan usulan beli saat ini', 'Surat jalan mana yang bermasalah?'];

  async function daftar() {
    const rows = await q(sb.from('ai_percakapan').select('id,judul,mode,diubah_at').order('diubah_at', { ascending: false }).limit(50));
    $('#aiList', el).innerHTML = rows.length ? rows.map((r) => `<button data-id="${r.id}" class="${aktif && aktif.id === r.id ? 'aktif' : ''}"><div>${esc(r.judul || 'Tanpa judul')}</div>
      <div class="muted small">${esc(relatif(r.diubah_at))}</div></button>`).join('') : '<div class="muted small">Belum ada percakapan.</div>';
  }
  function render(list) {
    const box = $('#aiMsgs', el);
    box.innerHTML = list.length ? list.map((m) => (m.dari === 'pengguna' ? `<div class="msg pengguna">${esc(m.teks)}</div>`
      : `<div class="msg asisten">${markdown(m.teks)}${m.alat && m.alat.length ? `<div class="alat">Data: ${m.alat.map((a) => esc(NAMA_ALAT[a.nama] || a.nama) + (a.error ? ' (gagal)' : '')).join(', ')}</div>` : ''}</div>`)).join('')
      : '<div class="kosong">Mulai dengan pertanyaan, atau pilih salah satu contoh di bawah.</div>';
    box.scrollTop = box.scrollHeight;
    $('#aiSaran', el).innerHTML = list.length ? '' : SARAN.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  }
  let tampilan = [];
  async function buka(id) {
    const [r] = await q(sb.from('ai_percakapan').select('*').eq('id', id).limit(1));
    aktif = { id: r.id };
    tampilan = riwayatTampil(r.pesan);
    render(tampilan);
    daftar();
  }
  async function kirim(pesan) {
    if (pending || !pesan.trim()) return;
    tampilan.push({ dari: 'pengguna', teks: pesan });
    render(tampilan);
    $('#aiMsgs', el).insertAdjacentHTML('beforeend', '<div class="msg asisten muted" id="aiTunggu">Sedang mencari jawaban…</div>');
    $('#aiKirim', el).disabled = true;
    pending = sb.functions.invoke('asisten', { body: { pesan, percakapan_id: aktif && aktif.id } });
    try {
      const { data, error } = await pending;
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch (_) { /* bukan JSON */ }
        throw new Error(msg);
      }
      aktif = { id: data.percakapan_id };
      tampilan.push({ dari: 'asisten', teks: data.jawaban || '(tidak ada jawaban)', alat: data.alat });
      render(tampilan);
      daftar();
    } catch (e) {
      tampilan.pop();
      render(tampilan);
      $('#aiInput', el).value = pesan;
      toast(pesanError(e), 'bad');
    } finally {
      pending = null;
      $('#aiKirim', el).disabled = false;
    }
  }
  $('#aiForm', el).addEventListener('submit', (e) => { e.preventDefault(); const v = $('#aiInput', el).value; $('#aiInput', el).value = ''; kirim(v); });
  $('#aiInput', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiForm', el).requestSubmit(); } });
  $('#aiSaran', el).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) kirim(b.textContent); });
  $('#aiList', el).addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) buka(b.dataset.id).catch((err) => toast(pesanError(err), 'bad')); });
  $('#aiBaru', el).addEventListener('click', () => { aktif = null; tampilan = []; render(tampilan); daftar(); $('#aiInput', el).focus(); });

  await daftar();
  render(tampilan);
}

// ================================================================ Kerangka aplikasi
const RENDER = { ringkasan: hRingkasan, penjualan: hPenjualan, pembatalan: hPembatalan, pesanan: hPesanan, stok: hStok, opname: hOpname, kiriman: hKiriman, pembelian: hPembelian, barang: hBarang, toko: hToko, pengguna: hPengguna, asisten: hAsisten };

function tampilLogin(pesan = '') {
  $('#root').innerHTML = `<div class="login"><div class="card"><div class="brand" style="padding:0"><div class="brand-mark">MB</div><div><div class="brand-name">Mother Base</div><div class="brand-sub">Pusat data kantor</div></div></div>
    <h1>Masuk</h1><p class="muted" style="margin-top:0">Gunakan akun yang dibuat owner.</p>
    <form class="form" id="lgForm"><label class="f">Email<input id="lgEmail" type="email" autocomplete="username" required></label>
      <label class="f">Kata sandi<input id="lgPass" type="password" autocomplete="current-password" required></label>
      <div class="alert bad ${pesan ? '' : 'hidden'}" id="lgErr">${esc(pesan)}</div>
      <button class="btn primary" id="lgBtn">Masuk</button></form></div></div>`;
  $('#lgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#lgBtn');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('#lgEmail').value.trim(), password: $('#lgPass').value });
    btn.disabled = false;
    if (error) { $('#lgErr').textContent = /invalid/i.test(error.message) ? 'Email atau kata sandi salah.' : pesanError(error); $('#lgErr').classList.remove('hidden'); return; }
    masuk();
  });
  $('#lgEmail').focus();
}

async function masuk() {
  try {
    S.profil = await rpc('saya');
  } catch (e) { return tampilLogin(pesanError(e)); }
  if (!S.profil || !S.profil.aktif) {
    await sb.auth.signOut();
    return tampilLogin('Akun ini belum didaftarkan owner di mother base, atau sudah dinonaktifkan.');
  }
  S.toko = await rpc('status_koneksi_toko').catch(() => []);
  tampilApp();
  route();
}

function tampilApp() {
  const p = S.profil;
  $('#root').innerHTML = `<div class="app" id="app">
    <aside class="side" id="side"><div class="brand"><div class="brand-mark">MB</div><div><div class="brand-name">Mother Base</div><div class="brand-sub">Pusat data kantor</div></div></div>
      <nav class="nav" aria-label="Menu">${HALAMAN.filter(boleh).map((h) => `<a href="#${h.id}" data-h="${h.id}"><span class="ikon" aria-hidden="true">${h.ikon}</span>${esc(h.judul)}</a>`).join('')}</nav>
      <div class="side-foot"><div><div class="akun-nama">${esc(p.nama)}</div><div class="muted small">${esc(LABEL_PERAN[p.peran] || p.peran)}${p.kode_toko ? ` · ${esc(p.kode_toko)}` : ''}</div></div>
        <div class="row"><button class="btn sm" id="btnTema">Tema</button><button class="btn sm" id="btnKeluar">Keluar</button></div>
        ${CFG.mode === 'dev' ? '<div class="pill warn" title="Server dev lokal, bukan Supabase">Server dev</div>' : ''}</div></aside>
    <div style="min-width:0"><div class="topbar"><button class="btn sm" id="btnMenu" aria-label="Buka menu">☰</button><b>Mother Base</b></div>
      <main class="main" id="isi"></main></div></div>`;
  $('#btnKeluar').addEventListener('click', async () => { await sb.auth.signOut(); S.profil = null; location.hash = ''; tampilLogin(); });
  $('#btnTema').addEventListener('click', () => {
    const urut = ['', 'light', 'dark'];
    const kini = document.documentElement.dataset.theme || '';
    const next = urut[(urut.indexOf(kini) + 1) % urut.length];
    if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
    try { if (next) localStorage.setItem('mb-tema', next); else localStorage.removeItem('mb-tema'); } catch (_) { /* tanpa penyimpanan */ }
    toast(`Tema: ${next === 'light' ? 'terang' : next === 'dark' ? 'gelap' : 'ikut sistem'}`);
  });
  $('#btnMenu').addEventListener('click', () => menu(true));
  $('#side').addEventListener('click', (e) => { if (e.target.closest('.nav a')) menu(false); });
}

function menu(buka) {
  $('#app').classList.toggle('menu-buka', buka);
  const ada = $('.scrim');
  if (buka && !ada) { const s = document.createElement('div'); s.className = 'scrim'; s.addEventListener('click', () => menu(false)); $('#app').append(s); }
  if (!buka && ada) ada.remove();
}

let rute = 0;
async function route() {
  if (!S.profil) return;
  const id = location.hash.replace(/^#/, '') || 'ringkasan';
  const h = HALAMAN.find((x) => x.id === id && boleh(x)) || HALAMAN[0];
  $$('.nav a').forEach((a) => a.classList.toggle('aktif', a.dataset.h === h.id));
  document.title = `${h.judul} · Mother Base`;
  const el = $('#isi');
  const ini = ++rute;
  el.innerHTML = '<div class="kosong">Memuat…</div>';
  try {
    await RENDER[h.id](el);
  } catch (e) {
    if (ini === rute) el.innerHTML = `${head(h.judul)}<div class="card"><div class="alert bad">${esc(pesanError(e))}</div></div>`;
  }
}

window.addEventListener('hashchange', route);

(async function mulai() {
  if (!sb) {
    $('#root').innerHTML = `<div class="login"><div class="card"><h1>Belum diatur</h1><p>Isi alamat project Supabase dan anon key di <code>config.js</code>. Lihat motherbase/README.md.</p></div></div>`;
    return;
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.profil) { S.profil = null; tampilLogin('Sesi berakhir. Silakan login lagi.'); } });
  const { data } = await sb.auth.getSession();
  if (data && data.session) masuk(); else tampilLogin();
}());
