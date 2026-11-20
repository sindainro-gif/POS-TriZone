'use strict';
/* global window, document */
// Utilitas tampilan bersama untuk aplikasi POS (index.html).
// Dimuat sebelum app.js; deklarasi di sini terlihat oleh skrip berikutnya.

// ================================================================ Utilitas
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const num = (n) => (Number(n) || 0).toLocaleString('id-ID');
const fmtTime = (s) => {
  if (!s) return '-';
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d) ? s : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// Tema tampilan Gelap / Terang: pilihan per komputer (bukan pengaturan toko yang ikut ke PC kasir lain)
const theme = (() => {
  const KEY = 'pos-theme';
  let cur = 'dark';
  try { cur = window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (_) { /* penyimpanan tidak tersedia */ }
  function apply(t) {
    cur = t === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cur;
    $$('#themeSeg [data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === cur));
    try { window.localStorage.setItem(KEY, cur); } catch (_) { /* abaikan */ }
  }
  apply(cur);
  $('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b) apply(b.dataset.theme); });
  return { apply, get: () => cur };
})();

// Ukuran tampilan (zoom seluruh aplikasi): pilihan per komputer, diterapkan juga oleh preload saat halaman dimuat.
// Tombol A− / persen (kembali 100%) / A+ di sidebar, atau Ctrl + =, Ctrl + −, Ctrl + 0.
const zoom = (() => {
  const KEY = 'pos-zoom';
  const LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const bridge = window.posBridge || {};
  let cur = 1;
  try { cur = Number(window.localStorage.getItem(KEY)) || 1; } catch (_) { /* penyimpanan tidak tersedia */ }
  const nearest = (f) => LEVELS.reduce((best, l) => (Math.abs(l - f) < Math.abs(best - f) ? l : best), 1);
  function apply(f) {
    cur = nearest(Number(f) || 1);
    if (bridge.setZoom) bridge.setZoom(cur);
    try { window.localStorage.setItem(KEY, String(cur)); } catch (_) { /* abaikan */ }
    const lbl = $('#zoomCtl [data-zoom="0"]');
    if (lbl) lbl.textContent = `${Math.round(cur * 100)}%`;
    $$('#zoomCtl [data-zoom="-1"]').forEach((b) => { b.disabled = cur <= LEVELS[0]; });
    $$('#zoomCtl [data-zoom="1"]').forEach((b) => { b.disabled = cur >= LEVELS[LEVELS.length - 1]; });
    return cur;
  }
  function step(dir) {
    const i = LEVELS.indexOf(cur);
    return apply(dir === 0 ? 1 : LEVELS[Math.min(LEVELS.length - 1, Math.max(0, i + dir))]);
  }
  apply(cur);
  const ctl = $('#zoomCtl');
  if (ctl) ctl.addEventListener('click', (e) => { const b = e.target.closest('[data-zoom]'); if (b) step(Number(b.dataset.zoom)); });
  // Pintasan keyboard di mana pun (juga saat kolom input / modal aktif)
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const dir = { '=': 1, '+': 1, '-': -1, _: -1, 0: 0 }[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    step(dir);
  }, true);
  return { apply, step, get: () => cur, LEVELS };
})();

// Lebar menu samping: geser garis batas (klik dua kali = ukuran awal, ← / → saat garis difokus) atau
// tombol "Ciutkan menu" (ikon saja). Pilihan per komputer, seperti tema & ukuran tampilan.
const sidebarCtl = (() => {
  const W_KEY = 'pos-sidebar-w';
  const C_KEY = 'pos-sidebar-collapsed';
  const DEF = 248;
  const MIN = 180;
  const MAX = 400;
  const read = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
  const write = (k, v) => { try { window.localStorage.setItem(k, v); } catch (_) { /* penyimpanan tidak tersedia */ } };
  const clamp = (w) => Math.min(MAX, Math.max(MIN, Math.round(Number(w) || DEF)));
  let width = clamp(read(W_KEY));
  let collapsed = read(C_KEY) === '1';
  const res = $('#sbResizer');
  const toggle = $('#sbToggle');

  function apply() {
    document.documentElement.style.setProperty('--sb-w', `${width}px`);
    document.body.classList.toggle('sb-collapsed', collapsed);
    if (res) res.setAttribute('aria-valuenow', String(width));
    if (toggle) {
      toggle.innerHTML = collapsed ? '<span class="nav-ico">»</span><span>Lebarkan menu</span>' : '<span class="nav-ico">«</span><span>Ciutkan menu</span>';
      toggle.title = collapsed ? 'Lebarkan menu' : 'Ciutkan menu jadi ikon saja';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
    // Saat ciut hanya ikon yang tampil: nama menu jadi tooltip
    $$('.sidebar .nav-btn').forEach((b) => {
      const label = b.querySelector('span:nth-child(2)');
      if (collapsed && label) b.title = label.textContent.trim();
      else b.removeAttribute('title');
    });
  }
  function setWidth(w, { save = true } = {}) {
    width = clamp(w);
    apply();
    if (save) write(W_KEY, String(width));
    return width;
  }
  function setCollapsed(c) {
    collapsed = !!c;
    write(C_KEY, collapsed ? '1' : '0');
    apply();
    return collapsed;
  }

  if (res) {
    res.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { res.setPointerCapture(e.pointerId); } catch (_) { /* pointer sudah lepas */ }
      document.body.classList.add('sb-resizing');
    });
    res.addEventListener('pointermove', (e) => {
      if (document.body.classList.contains('sb-resizing')) setWidth(e.clientX, { save: false });
    });
    const end = (e) => {
      if (!document.body.classList.contains('sb-resizing')) return;
      try { res.releasePointerCapture(e.pointerId); } catch (_) { /* sudah dilepas */ }
      document.body.classList.remove('sb-resizing');
      write(W_KEY, String(width));
    };
    res.addEventListener('pointerup', end);
    res.addEventListener('pointercancel', end);
    res.addEventListener('dblclick', () => setWidth(DEF));
    res.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
      if (d) { e.preventDefault(); setWidth(width + d); }
    });
  }
  if (toggle) toggle.addEventListener('click', () => setCollapsed(!collapsed));
  apply();
  return { setWidth, setCollapsed, get: () => ({ width, collapsed }), DEF, MIN, MAX };
})();

async function api(channel, args) {
  const r = await window.posBridge.call(channel, args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const sound = (() => {
  let ctx;
  return (kind) => {
    try {
      ctx = ctx || new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = kind === 'err' ? 220 : 1250;
      o.type = kind === 'err' ? 'square' : 'sine';
      g.gain.value = 0.06;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + (kind === 'err' ? 0.28 : 0.07));
    } catch (_) { /* audio tidak tersedia */ }
  };
})();

// Setelah modal ditutup: fokus kembali ke elemen sebelumnya (halaman boleh mengganti perilaku ini)
const modalHooks = { afterClose: (prevFocus) => { if (prevFocus && prevFocus.isConnected) prevFocus.focus(); } };

function modal({ title, body, actions = [], wide = false, onOpen, dismissable = true }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}"><div class="modal-head">${esc(title)}</div><div class="modal-body">${body}</div>
    ${actions.length ? '<div class="modal-foot"></div>' : ''}</div>`;
  const foot = $('.modal-foot', back);
  const prevFocus = document.activeElement;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    modalHooks.afterClose(prevFocus);
  };
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.innerHTML = a.label;
    b.addEventListener('click', () => a.onClick ? a.onClick({ close, el: back, btn: b }) : close());
    foot.appendChild(b);
  });
  function onKey(e) {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
  $('#modalRoot').appendChild(back);
  const first = $('input, select, textarea', back) || $('.modal-foot .btn.primary', back);
  if (first) first.focus();
  if (onOpen) onOpen(back, close);
  return { close, el: back };
}

function confirmDialog(title, message, { okLabel = 'Ya, Lanjutkan', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => { if (!done) { done = true; close(); resolve(v); } };
    const m = modal({
      title,
      body: `<div style="line-height:1.6">${message}</div>`,
      actions: [
        { label: 'Batal', kind: 'ghost', onClick: ({ close }) => finish(false, close) },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: ({ close }) => finish(true, close) },
      ],
    });
    const obs = new MutationObserver(() => { if (!m.el.isConnected) { obs.disconnect(); if (!done) { done = true; resolve(false); } } });
    obs.observe($('#modalRoot'), { childList: true });
  });
}

function floorBadge(p) {
  const cls = p.floor_stock <= 0 ? 'zero' : p.floor_stock <= p.min_floor_alert ? 'low' : 'ok';
  return `<span class="badge floor ${cls}" title="Display Toko (siap jual)">${num(p.floor_stock)}</span>`;
}
const whBadge = (p) => `<span class="badge wh" title="Gudang Utama (cadangan)">${num(p.warehouse_stock)}</span>`;
const bsBadge = (p) => `<span class="badge bs ${p.damaged_stock ? '' : 'none'}" title="Gudang BS / Retur (tidak bisa dijual)">${num(p.damaged_stock)}</span>`;
const shpBadge = (p) => `<span class="badge shp ${p.shopee_stock ? '' : 'none'}" title="Gudang Shopee (stok online, tidak dijual di kasir)">${num(p.shopee_stock)}</span>`;
function zoneBadges(p) {
  return `<div class="zone-badges">
    <span class="badge floor ${p.floor_stock <= 0 ? 'zero' : p.floor_stock <= p.min_floor_alert ? 'low' : 'ok'}">Display Toko: ${num(p.floor_stock)}</span>
    <span class="badge wh">Gudang: ${num(p.warehouse_stock)}</span>
    <span class="badge bs ${p.damaged_stock ? '' : 'none'}">BS: ${num(p.damaged_stock)}</span>
    <span class="badge shp ${p.shopee_stock ? '' : 'none'}">Shopee: ${num(p.shopee_stock)}</span></div>`;
}
const ZONE_CLASS = { floor: 'floor', warehouse: 'wh', damaged: 'bs', shopee: 'shp', customer: 'ext', supplier: 'ext', disposed: 'ext', shopee_sold: 'ext' };
// Daftar baris yang dilewati di modal hasil import
const errorList = (errors) => (errors.length
  ? `<div class="tbl-wrap" style="max-height:220px;margin-top:10px"><table class="tbl"><tbody>${errors.map((e) => `<tr><td>${esc(e)}</td></tr>`).join('')}</tbody></table></div>`
  : '');
