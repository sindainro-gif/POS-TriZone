'use strict';
/* global window, document */

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
    afterModalClose(prevFocus);
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

function bindMoney(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    input.value = digits ? Number(digits).toLocaleString('id-ID') : '';
  });
}
const moneyVal = (input) => Number(String(input.value).replace(/\D/g, '')) || 0;
const setMoney = (input, n) => { input.value = n ? Number(n).toLocaleString('id-ID') : ''; };

function floorBadge(p) {
  const cls = p.floor_stock <= 0 ? 'zero' : p.floor_stock <= p.min_floor_alert ? 'low' : 'ok';
  return `<span class="badge floor ${cls}" title="Display Toko (siap jual)">${num(p.floor_stock)}</span>`;
}
const whBadge = (p) => `<span class="badge wh" title="Gudang Utama (cadangan)">${num(p.warehouse_stock)}</span>`;
const bsBadge = (p) => `<span class="badge bs ${p.damaged_stock ? '' : 'none'}" title="Gudang BS / Retur (tidak bisa dijual)">${num(p.damaged_stock)}</span>`;
function zoneBadges(p) {
  return `<div class="zone-badges">
    <span class="badge floor ${p.floor_stock <= 0 ? 'zero' : p.floor_stock <= p.min_floor_alert ? 'low' : 'ok'}">Display Toko: ${num(p.floor_stock)}</span>
    <span class="badge wh">Gudang: ${num(p.warehouse_stock)}</span>
    <span class="badge bs ${p.damaged_stock ? '' : 'none'}">BS: ${num(p.damaged_stock)}</span></div>`;
}
const ZONE_CLASS = { floor: 'floor', warehouse: 'wh', damaged: 'bs', customer: 'ext', supplier: 'ext', disposed: 'ext' };
const zoneTag = (z) => `<span class="badge ${ZONE_CLASS[z]}">${esc(state.meta.zones[z] || z)}</span>`;

// Tebalkan bagian teks yang sama dengan kata yang diketik (aman: setiap potongan di-escape)
function highlight(text, q) {
  const tokens = String(q || '').toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 2);
  if (!tokens.length) return esc(text);
  const re = new RegExp(`(${tokens.join('|')})`, 'ig'); // token hanya huruf/angka, aman untuk regex
  return String(text ?? '').split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

// Komponen pencarian barang (scan barcode / ketik nama) dengan daftar saran
function makePicker(input, { onPick, onEnter, queryOf = (v) => v, limit = 8 }) {
  const box = document.createElement('div');
  box.className = 'picker-list hidden';
  input.after(box);
  let items = [];
  let idx = -1;
  let timer;
  let seq = 0;
  let shownQ = '';

  const hide = () => { box.classList.add('hidden'); idx = -1; };
  const render = () => {
    if (!items.length) { box.innerHTML = '<div class="picker-empty">Barang tidak ditemukan.</div>'; }
    else {
      box.innerHTML = items.map((p, i) => `<div class="picker-item ${i === idx ? 'active' : ''}" data-i="${i}">
        <div><div class="pname">${highlight(p.name, shownQ)}</div><div class="psub mono">${highlight(p.sku, shownQ)} · ${highlight(p.barcode, shownQ)} · ${rp(p.unit_price)}</div></div>
        <div class="zone-badges">${floorBadge(p)}${whBadge(p)}${bsBadge(p)}</div></div>`).join('');
    }
    box.classList.remove('hidden');
  };
  async function load() {
    const q = queryOf(input.value).trim();
    if (q.length < 2) { hide(); return; }
    const my = ++seq;
    const res = await api('products:search', { q, limit }).catch(() => []);
    if (my !== seq) return;
    items = res;
    shownQ = q;
    idx = items.length ? 0 : -1;
    render();
  }
  function pick(p) { hide(); seq++; onPick(p); }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
  input.addEventListener('keydown', async (e) => {
    const open = !box.classList.contains('hidden');
    if (e.key === 'ArrowDown' && open && items.length) { e.preventDefault(); idx = (idx + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp' && open && items.length) { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      const raw = input.value.trim();
      if (!raw) return;
      // Prioritas: kecocokan persis barcode/SKU (hasil scan) — baru kemudian pilihan di daftar
      const exact = await api('products:findByCode', { code: queryOf(raw).trim() }).catch(() => null);
      if (exact) { pick(exact); return; }
      if (open && idx >= 0 && items[idx]) { pick(items[idx]); return; }
      if (onEnter) { hide(); onEnter(raw); return; }
      await load();
      if (items.length === 1) pick(items[0]);
      else if (!items.length) { sound('err'); toast(`Barang "${raw}" tidak ditemukan.`, 'err'); }
    }
  });
  box.addEventListener('mousedown', (e) => {
    const row = e.target.closest('[data-i]');
    if (row) { e.preventDefault(); pick(items[Number(row.dataset.i)]); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  return { hide, open: load };
}

// ================================================================ State & navigasi
const state = {
  view: 'checkout',
  meta: { directions: [], zones: {}, paymentMethods: [] },
  settings: {},
  shift: null,
  connected: true,
  emergency: null, // ringkasan mode darurat (khusus PC kasir)
  user: null, // akun login: { id, name, role }
};

// Menu yang boleh dibuka per peran (Admin: semua)
const ROLE_VIEWS = {
  admin: ['checkout', 'transfers', 'receiving', 'products', 'barcode', 'shift', 'settings'],
  gudang: ['transfers', 'receiving', 'products', 'barcode'],
  kasir: ['checkout', 'shift', 'products'],
};
const ROLE_LABEL = { admin: 'Admin', gudang: 'Gudang', kasir: 'Kasir' };
const role = () => (state.user ? state.user.role : '');
const canView = (v) => !!state.user && ROLE_VIEWS[role()].includes(v);
const canEditProducts = () => ['admin', 'gudang'].includes(role());

// PC kasir terputus dari PC gudang tetapi data darurat siap → transaksi masuk antrian lokal
const emergencyMode = () => state.connected === false && !!(state.emergency && state.emergency.ready);

const views = {};

function go(view) {
  if (!views[view] || !canView(view)) return;
  state.view = view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  views[view].show();
}

function afterModalClose(prevFocus) {
  if (state.view === 'checkout' && !$('#modalRoot').children.length) views.checkout.focusScan();
  else if (prevFocus && prevFocus.isConnected) prevFocus.focus();
}

async function refreshShift() {
  state.shift = await api('shift:get');
  const b = $('#shiftBadge');
  if (state.shift) {
    b.className = 'shift-badge on';
    b.innerHTML = `<b>Shift aktif</b> · ${esc(state.shift.cashier_name)}<br><span class="small">Mulai ${fmtTime(state.shift.shift_start)}</span>`;
  } else {
    b.className = 'shift-badge off';
    b.textContent = 'Shift belum dibuka';
  }
  return state.shift;
}

function openShiftForm(container, onDone) {
  container.innerHTML = `
    <h2>Buka Shift Kasir</h2>
    <p class="muted">Shift harus dibuka sebelum melakukan transaksi penjualan.</p>
    <div class="field"><label>Kasir</label><div class="big-input" id="osName" style="padding:10px 12px;text-align:left">${esc(state.user ? state.user.name : '-')}</div></div>
    <button class="btn primary" id="osBtn" style="width:100%">Buka Shift <kbd>Enter</kbd></button>`;
  const btn = $('#osBtn', container);
  const submit = async () => {
    try {
      await api('shift:open', {});
      toast('Shift dibuka. Selamat bekerja!', 'ok');
      await refreshShift();
      onDone();
    } catch (e) { toast(e.message, 'err'); }
  };
  btn.addEventListener('click', submit);
  setTimeout(() => btn.focus(), 30); // Enter pada tombol = buka shift
}

// ================================================================ 1. KASIR
views.checkout = (() => {
  const cart = []; // {sku, name, barcode, unit_price, qty, floor_stock, warehouse_stock, damaged_stock, min_floor_alert}
  let method = 'Tunai';
  let busy = false;
  const scan = $('#scanInput');
  const qtyInput = $('#qtyInput');
  const cashInput = $('#cashInput');

  // Kolom Jumlah: isi → Enter → pindah ke kolom barcode; kembali ke 1 setelah barang masuk
  const resetQty = () => { qtyInput.value = '1'; };
  function readQty() {
    const n = Number(String(qtyInput.value).trim());
    if (Number.isInteger(n) && n >= 1) return n;
    sound('err');
    toast('Jumlah minimal 1.', 'err');
    qtyInput.focus();
    return 0;
  }
  qtyInput.addEventListener('focus', () => qtyInput.select());
  qtyInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!readQty()) return;
    scan.focus();
    scan.select();
  });
  // Enter di kolom scan yang kosong (atau tombol *) → pindah ke Jumlah; Enter di Jumlah → kembali ke scan
  scan.addEventListener('keydown', (e) => {
    if ((e.key === '*' || e.key === 'Enter') && !scan.value.trim()) { e.preventDefault(); qtyInput.focus(); }
  });

  makePicker(scan, {
    limit: 10,
    onPick: (p) => {
      const qty = readQty();
      if (!qty) return;
      scan.value = '';
      if (addToCart(p, qty)) resetQty();
    },
    onEnter: (raw) => {
      sound('err');
      showAlert(`Barang dengan kode / nama "<b>${esc(raw)}</b>" tidak ditemukan.`);
      scan.select();
    },
  });

  function showAlert(html, kind = 'danger') {
    const a = $('#stockAlert');
    a.className = `alert ${kind}`;
    a.innerHTML = html;
    a.classList.remove('hidden');
  }
  const hideAlert = () => $('#stockAlert').classList.add('hidden');

  const shortMsg = (p) => `<b>${esc(p.name)}</b>: Display toko tidak cukup. Tersedia <b>${num(p.floor_stock)}</b> di toko, <b>${num(p.warehouse_stock)}</b> di gudang utama, dan <b>${num(p.damaged_stock)}</b> di gudang BS.`;

  // Barang sudah dibawa pelanggan ke kasir: display toko kurang hanya peringatan, tetap boleh dijual.
  // Display toko jadi 0/minus dan barangnya muncul merah paling atas di "Saran Restock Rak Toko" gudang.
  const oversellMsg = (p, qty) => `${emergencyMode() ? '<b>MODE DARURAT:</b> ' : ''}<b>${esc(p.name)}</b>: display toko ${emergencyMode() ? 'terakhir diketahui ' : ''}<b>${num(p.floor_stock)}</b>, di keranjang <b>${num(qty)}</b>.
    Tetap dijual — gudang akan melihatnya (merah) di <b>Saran Restock Rak Toko</b>.`;

  function addToCart(p, qty) {
    if (!qty || qty < 1) { toast('Jumlah minimal 1.', 'err'); return false; }
    const line = cart.find((l) => l.sku === p.sku);
    const want = (line ? line.qty : 0) + qty;
    if (want > p.floor_stock) showAlert(oversellMsg(p, want), 'warn');
    else hideAlert();
    if (line) { Object.assign(line, p, { qty: want }); cart.splice(cart.indexOf(line), 1); cart.unshift(line); }
    else cart.unshift({ ...p, qty });
    sound('ok');
    render(p.sku);
    return true;
  }

  function setQty(sku, qty) {
    const line = cart.find((l) => l.sku === sku);
    if (!line) return;
    if (!Number.isInteger(qty) || qty < 1) { render(); return; }
    if (qty > line.floor_stock) showAlert(oversellMsg(line, qty), 'warn');
    else hideAlert();
    line.qty = qty;
    render();
  }

  const total = () => cart.reduce((s, l) => s + l.unit_price * l.qty, 0);

  function render(flashSku) {
    const body = $('#cartBody');
    body.innerHTML = cart.map((l, i) => `<tr data-sku="${esc(l.sku)}" class="${l.sku === flashSku ? 'flash' : ''}">
      <td class="muted">${cart.length - i}</td>
      <td><div class="pname">${esc(l.name)}</div><div class="psub mono">${esc(l.barcode)} · display toko ${num(l.floor_stock)}</div></td>
      <td class="r">${rp(l.unit_price)}</td>
      <td class="c"><div class="qty-ctl"><button data-act="dec">−</button><input data-act="qty" type="number" min="1" value="${l.qty}"><button data-act="inc">+</button></div></td>
      <td class="r"><b>${rp(l.unit_price * l.qty)}</b></td>
      <td class="c"><button class="icon-btn" data-act="del" title="Hapus">✕</button></td></tr>`).join('');
    $('#cartEmpty').classList.toggle('hidden', cart.length > 0);
    const t = total();
    $('#coTotal').textContent = rp(t);
    $('#coCount').textContent = `${num(cart.reduce((s, l) => s + l.qty, 0))} Biji · ${cart.length} baris`;
    renderQuickCash(t);
    updateChange();
  }

  $('#cartBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const sku = btn.closest('tr').dataset.sku;
    const line = cart.find((l) => l.sku === sku);
    if (btn.dataset.act === 'inc') setQty(sku, line.qty + 1);
    if (btn.dataset.act === 'dec') { if (line.qty > 1) setQty(sku, line.qty - 1); }
    if (btn.dataset.act === 'del') { cart.splice(cart.indexOf(line), 1); hideAlert(); render(); focusScan(); }
  });
  $('#cartBody').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'qty') return;
    setQty(e.target.closest('tr').dataset.sku, Number(e.target.value));
    focusScan();
  });
  $('#cartBody').addEventListener('keydown', (e) => {
    if (e.target.dataset.act === 'qty' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  function renderMethods() {
    $('#payMethods').innerHTML = state.meta.paymentMethods.map((m) => `<button data-m="${esc(m)}" class="${m === method ? 'active' : ''}">${esc(m)}</button>`).join('');
    $('#cashBlock').classList.toggle('hidden', method !== 'Tunai');
    updateChange();
  }
  // F12: kolom uang hanya ada untuk Tunai, jadi metode dipindah ke Tunai dulu.
  // F12 lagi saat sudah di kolom uang = Uang Pas.
  function focusCash() {
    if (!state.shift || $('#modalRoot').children.length) return;
    if (method === 'Tunai' && document.activeElement === cashInput && total() > 0) {
      setMoney(cashInput, total());
      updateChange();
      cashInput.select();
      return;
    }
    if (method !== 'Tunai') { method = 'Tunai'; renderMethods(); }
    cashInput.focus();
    cashInput.select();
  }

  $('#payMethods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    method = b.dataset.m;
    renderMethods();
    if (method === 'Tunai') cashInput.focus(); else focusScan();
  });

  function renderQuickCash(t) {
    const opts = [];
    if (t > 0) opts.push(['Uang Pas', t]);
    for (const d of [5000, 10000, 20000, 50000, 100000]) {
      const v = Math.ceil(t / d) * d;
      if (v > t && !opts.some((o) => o[1] === v)) opts.push([rp(v), v]);
    }
    if (t === 0) opts.push([rp(50000), 50000], [rp(100000), 100000]);
    $('#quickCash').innerHTML = opts.slice(0, 4).map(([l, v]) => `<button data-v="${v}">${l}</button>`).join('');
  }
  $('#quickCash').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    setMoney(cashInput, Number(b.dataset.v));
    updateChange();
  });

  bindMoney(cashInput);
  cashInput.addEventListener('input', updateChange);
  cashInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pay(); } });

  function updateChange() {
    const t = total();
    const el = $('#coChange');
    let ok = cart.length > 0 && !!state.shift && (state.connected !== false || emergencyMode());
    if (method === 'Tunai') {
      const c = moneyVal(cashInput);
      const diff = c - t;
      el.textContent = c ? (diff < 0 ? `Kurang ${rp(-diff)}` : rp(diff)) : rp(0);
      el.classList.toggle('neg', c > 0 && diff < 0);
      ok = ok && c >= t;
    }
    $('#payBtn').disabled = !ok || busy;
  }

  async function pay() {
    if (busy || !cart.length) return;
    if (method === 'Tunai' && moneyVal(cashInput) < total()) {
      sound('err');
      toast('Uang diterima kurang dari total belanja.', 'err');
      cashInput.focus();
      return;
    }
    busy = true;
    updateChange();
    try {
      const res = await api('sales:checkout', {
        items: cart.map((l) => ({ sku: l.sku, qty: l.qty })),
        payment_method: method,
        cash_received: method === 'Tunai' ? moneyVal(cashInput) : undefined,
      });
      cart.length = 0;
      resetQty();
      cashInput.value = '';
      hideAlert();
      render();
      showReceipt(res);
      if (state.settings.auto_print !== '0') printReceipt(res);
      if (res.short && res.short.length) {
        toast(`${res.short.length} barang display tokonya habis (${res.short.map((s) => `${s.name}: ${s.floor_stock}`).join(', ')}) — sudah masuk Saran Restock gudang.`, 'warn', 9000);
      }
      if (res.offline) refreshConnection();
    } catch (e) {
      sound('err');
      showAlert(esc(e.message));
      await refreshCartStock();
    } finally {
      busy = false;
      updateChange();
    }
  }

  async function refreshCartStock() {
    for (const l of cart) {
      const p = await api('products:get', { sku: l.sku }).catch(() => null);
      if (p) Object.assign(l, p, { qty: l.qty });
    }
    render();
  }

  // Cetak ke printer nota tanpa dialog; transaksi tetap sah walau printer bermasalah
  async function printReceipt(r) {
    try { await api('receipt:print', r); } catch (e) { sound('err'); toast(e.message, 'err', 8000); }
  }

  function showReceipt(r) {
    sound('ok');
    modal({
      title: r.offline ? `MODE DARURAT — Transaksi Disimpan — ${r.receipt_no}` : `Transaksi Berhasil — ${r.receipt_no}`,
      body: `${r.offline ? `<div class="alert warn" style="margin-bottom:10px"><b>MODE DARURAT.</b> Transaksi tersimpan di komputer kasir ini dan dikirim otomatis ke PC Gudang saat koneksi kembali.${(r.warnings || []).length ? `<br>Perlu dicek: ${r.warnings.map(esc).join(' ')}` : ''}</div>` : ''}
        <div class="alert ok" style="text-align:center">
          <div class="muted small">Kembalian</div><div style="font-size:34px;font-weight:800">${rp(r.change)}</div>
          <div class="small">${esc(r.payment_method)} · Total ${rp(r.total)}${r.payment_method === 'Tunai' ? ` · Diterima ${rp(r.cash_received)}` : ''}</div></div>
        <table class="receipt-lines">${r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="r muted">${num(l.qty)} × ${rp(l.unit_price)}</td><td class="r">${rp(l.line_total)}</td></tr>`).join('')}</table>`,
      actions: [
        { label: state.settings.auto_print !== '0' ? 'Cetak Ulang Nota' : 'Cetak Nota', kind: 'ghost', onClick: () => printReceipt(r) },
        { label: 'Transaksi Baru <kbd>Enter</kbd>', kind: 'primary', onClick: ({ close }) => close() },
      ],
    });
  }

  function clearCart() {
    if (!cart.length) return;
    confirmDialog('Kosongkan Keranjang', `Hapus ${cart.length} baris barang dari keranjang?`, { okLabel: 'Kosongkan', danger: true }).then((ok) => {
      if (!ok) return;
      cart.length = 0;
      resetQty();
      cashInput.value = '';
      hideAlert();
      render();
    });
  }

  $('#payBtn').addEventListener('click', pay);
  $('#clearBtn').addEventListener('click', clearCart);

  // ---- Draft penjualan: tahan keranjang, layani pelanggan lain, lanjutkan nanti.
  // Disimpan di komputer ini; stok tidak dipesan, harga & stok dicek ulang saat dilanjutkan.
  async function refreshDrafts() {
    const n = (await api('drafts:list').catch(() => [])).length;
    $('#draftListBtn').innerHTML = `Daftar Draft${n ? ` <span class="draft-count">${n}</span>` : ''}`;
    return n;
  }
  const emptyCart = () => { cart.length = 0; resetQty(); cashInput.value = ''; hideAlert(); render(); };
  const cartItems = () => cart.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unit_price: l.unit_price }));

  function holdCart() {
    if (!cart.length) { sound('err'); toast('Keranjang masih kosong.', 'err'); return; }
    modal({
      title: 'Tahan Transaksi (Draft)',
      body: `<p class="muted small" style="margin-top:0">Keranjang disimpan di komputer kasir ini supaya bisa melayani pelanggan lain dulu. Stok belum dikurangi sampai dibayar.</p>
        <div class="field"><label>Nama pelanggan / catatan <span class="muted">(opsional)</span></label><input id="drLabel" maxlength="40" placeholder="Contoh: Bu Ani, kaos merah"></div>`,
      actions: [
        { label: 'Batal', kind: 'ghost' },
        {
          label: 'Simpan Draft',
          kind: 'primary',
          onClick: async ({ close }) => {
            try {
              const d = await api('drafts:save', { label: $('#drLabel').value, items: cartItems() });
              emptyCart();
              close();
              toast(`Draft "${d.label}" disimpan. Silakan layani pelanggan berikutnya.`, 'ok');
              refreshDrafts();
            } catch (e) { toast(e.message, 'err'); }
          },
        },
      ],
      onOpen: (el) => $('#drLabel', el).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $('.modal-foot .btn.primary', el).click(); }
      }),
    });
  }

  async function resumeDraft(id) {
    if (cart.length) {
      if (!(await confirmDialog('Lanjutkan Draft', 'Keranjang sekarang masih berisi barang. Tahan keranjang ini sebagai draft dulu, lalu lanjutkan draft yang dipilih?', { okLabel: 'Tahan & Lanjutkan' }))) return;
      await api('drafts:save', { label: 'Ditahan otomatis', items: cartItems() });
      emptyCart();
    }
    const d = await api('drafts:take', { id });
    const notes = [];
    for (const it of d.items) {
      const p = await api('products:get', { sku: it.sku }).catch(() => null);
      if (!p) { notes.push(`<b>${esc(it.name)}</b>: barang tidak ditemukan, dilewati.`); continue; }
      if (p.unit_price !== it.unit_price) notes.push(`<b>${esc(p.name)}</b>: harga berubah ${rp(it.unit_price)} → ${rp(p.unit_price)}.`);
      if (p.floor_stock < it.qty) notes.push(`${shortMsg(p)} Di draft ${num(it.qty)}.`);
      const line = cart.find((l) => l.sku === p.sku);
      if (line) line.qty += it.qty;
      else cart.push({ ...p, qty: it.qty });
    }
    render();
    if (notes.length) showAlert(`Draft "${esc(d.label)}" — periksa sebelum bayar:<br>${notes.join('<br>')}`, 'warn');
    else hideAlert();
    toast(`Draft "${d.label}" dilanjutkan.`, 'ok');
    refreshDrafts();
    focusScan();
  }

  async function openDrafts() {
    let list;
    try { list = await api('drafts:list'); } catch (e) { toast(e.message, 'err'); return; }
    if (!list.length) { toast('Belum ada draft penjualan.'); return; }
    const m = modal({
      title: `Draft Penjualan (${list.length})`,
      wide: true,
      body: `<p class="muted small" style="margin-top:0">Tersimpan di komputer kasir ini. Stok belum dikurangi; harga &amp; stok dicek ulang saat dilanjutkan.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>Pelanggan / Catatan</th><th class="r">Biji</th><th class="r">Total</th><th>Kasir</th><th></th></tr></thead><tbody>
        ${list.map((d) => `<tr data-id="${esc(d.id)}"><td class="muted">${fmtTime(d.created_at)}</td>
          <td><b>${esc(d.label)}</b><div class="psub">${esc(d.items.map((i) => `${i.qty}× ${i.name}`).join(', '))}</div></td>
          <td class="r">${num(d.qty)}</td><td class="r"><b>${rp(d.total)}</b></td><td>${esc(d.cashier)}</td>
          <td><div class="btn-row"><button class="btn sm primary" data-resume>Lanjutkan</button><button class="btn sm danger" data-del>Hapus</button></div></td></tr>`).join('')}
        </tbody></table></div>`,
      actions: [{ label: 'Tutup', kind: 'ghost' }],
    });
    m.el.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const d = list.find((x) => x.id === row.dataset.id);
      if (e.target.closest('[data-resume]')) {
        m.close();
        try { await resumeDraft(d.id); } catch (err) { toast(err.message, 'err', 6000); refreshDrafts(); }
      } else if (e.target.closest('[data-del]')) {
        if (!(await confirmDialog('Hapus Draft', `Hapus draft <b>${esc(d.label)}</b> (${rp(d.total)})?`, { okLabel: 'Hapus', danger: true }))) return;
        try { await api('drafts:delete', { id: d.id }); m.close(); toast('Draft dihapus.', 'ok'); refreshDrafts(); } catch (err) { toast(err.message, 'err'); }
      }
    });
  }

  $('#draftHoldBtn').addEventListener('click', holdCart);
  $('#draftListBtn').addEventListener('click', openDrafts);

  function focusScan() {
    if (state.view === 'checkout' && state.shift && !$('#modalRoot').children.length) scan.focus();
  }

  // Kolom scan selalu kembali fokus bila kasir mengklik area kosong
  $('#view-checkout').addEventListener('mouseup', (e) => {
    if (!e.target.closest('input, select, textarea, button, .picker-list')) setTimeout(focusScan, 0);
  });

  function renderShiftInfo() {
    const s = state.shift;
    $('#coShiftInfo').innerHTML = s ? `<span>Kasir: <b>${esc(s.cashier_name)}</b></span><span>Mulai ${fmtTime(s.shift_start)}</span>` : '';
    $('#coNoShift').classList.toggle('hidden', !!s);
    if (!s) openShiftForm($('#coNoShiftCard'), () => show());
  }

  function show() {
    renderMethods();
    renderShiftInfo();
    render();
    refreshDrafts();
    setTimeout(focusScan, 30);
  }

  let wasOffline = false;
  let lastPending = 0;
  function connectionChanged() {
    const offline = state.connected === false;
    const em = state.emergency;
    const banner = $('#emergencyBanner');
    document.body.classList.toggle('emergency', emergencyMode());
    if (emergencyMode()) {
      banner.innerHTML = `<span class="big">⚠ MODE DARURAT</span>PC Gudang tidak terhubung. Transaksi tetap bisa dibayar: disimpan di komputer kasir ini
        (nomor struk <b>OFF-…</b>), nota tetap tercetak, dan dikirim otomatis ke PC Gudang saat koneksi kembali. Stok yang tampil = stok terakhir yang diketahui.
        ${em.pending ? `<br>Antrian: <b>${num(em.pending)} transaksi</b> (${rp(em.pending_total)}) belum terkirim.` : ''}`;
      banner.classList.remove('hidden');
      if (!wasOffline) hideAlert();
    } else {
      banner.classList.add('hidden');
      if (offline) {
        const why = !em ? '' : !em.products ? 'Mode darurat belum siap: data barang belum pernah diunduh dari PC Gudang. '
          : 'Mode darurat tidak bisa dipakai karena shift belum dibuka saat terakhir terhubung. ';
        showAlert(`<b>Terputus dari PC Gudang.</b> ${why}Transaksi tidak bisa diproses sampai koneksi kembali. Periksa PC gudang (menyala &amp; aplikasi terbuka) dan kabel/WiFi.`);
      } else if (wasOffline) { hideAlert(); toast('Terhubung kembali ke PC Gudang.', 'ok'); if (!state.shift && state.user) refreshShift().then(() => state.view === 'checkout' && show()); }
    }
    const pending = em ? em.pending : 0;
    if (!offline && lastPending > 0 && pending === 0) {
      toast(`${num(lastPending)} transaksi darurat terkirim ke PC Gudang.`, 'ok', 6000);
      const checks = em.last_sync && em.last_sync.checks ? em.last_sync.checks.length : 0;
      if (checks) toast(`${num(checks)} transaksi darurat perlu dicek stoknya — lihat Laporan Shift.`, 'warn', 12000);
    }
    lastPending = pending;
    wasOffline = offline;
    updateChange();
  }

  return {
    show, focusScan, focusCash, pay, clearCart, connectionChanged,
    hasItems: () => cart.length > 0,
  };
})();

// ================================================================ 2. MUTASI
views.transfers = (() => {
  let picked = null; // barang hasil scan yang menunggu Jumlah
  const items = []; // {product, qty} — satu form = satu arah + satu alasan
  const qty = $('#trQty');
  const dir = $('#trDirection');
  const picker = $('#trPicker');
  const HINT = $('#trPicked').innerHTML;
  const ZONE_COL = { floor: 'floor_stock', warehouse: 'warehouse_stock', damaged: 'damaged_stock' };

  // Kursor default di Barang. Scan → Jumlah; Enter di Jumlah → barang masuk list, kembali ke Barang
  qty.addEventListener('focus', () => qty.select());
  qty.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const n = Number(qty.value);
    if (!Number.isInteger(n) || n < 1) { sound('err'); toast('Jumlah minimal 1.', 'err'); return; }
    if (picked) add(picked, n);
    picker.focus();
    picker.select();
  });
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !picker.value.trim()) { e.preventDefault(); qty.focus(); }
  });

  makePicker(picker, {
    onPick: (p) => {
      picked = p;
      picker.value = '';
      $('#trPicked').innerHTML = `Dipilih: <b>${esc(p.name)}</b> · ${esc(p.sku)} — isi Jumlah lalu Enter`;
      qty.focus();
    },
  });

  function add(p, n) {
    const same = items.find((i) => i.product.sku === p.sku);
    if (same) same.qty += n;
    else items.push({ product: p, qty: n });
    picked = null;
    qty.value = 1;
    $('#trPicked').innerHTML = HINT;
    render();
  }

  const zoneStock = (p) => { const col = ZONE_COL[dir.value.split('>')[0]]; return col ? p[col] : null; };

  function render() {
    $('#trItems').innerHTML = items.length ? items.map((i, idx) => {
      const avail = zoneStock(i.product);
      const short = avail !== null && avail < i.qty;
      return `<tr data-i="${idx}">
        <td class="r muted">${idx + 1}</td><td class="mono">${esc(i.product.sku)}</td><td>${esc(i.product.name)}</td>
        <td class="r"><input type="number" min="1" value="${i.qty}" data-act="qty" style="width:80px;text-align:right"></td>
        <td>Biji</td>
        <td class="r ${short ? 'diff-neg' : 'muted'}">${avail === null ? '-' : `${num(avail)}${short ? ' — KURANG' : ''}`}</td>
        <td class="c"><button class="icon-btn" data-act="del">✕</button></td></tr>`;
    }).join('')
      : '<tr><td colspan="7" class="empty-row">Belum ada barang. Scan barang, isi Jumlah, lalu Enter.</td></tr>';
    $('#trTotal').textContent = `${items.length} baris · ${num(items.reduce((s, i) => s + i.qty, 0))} Biji`;
  }
  dir.addEventListener('change', render);
  $('#trItems').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'del') { items.splice(Number(e.target.closest('tr').dataset.i), 1); render(); picker.focus(); }
  });
  $('#trItems').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'qty') return;
    const q = Number(e.target.value);
    if (Number.isInteger(q) && q >= 1) items[Number(e.target.closest('tr').dataset.i)].qty = q;
    render();
  });
  $('#trItems').addEventListener('keydown', (e) => {
    if (e.target.dataset.act === 'qty' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); picker.focus(); }
  });

  function reset() {
    items.length = 0;
    picked = null;
    picker.value = '';
    qty.value = 1;
    $('#trReason').value = '';
    $('#trPicked').innerHTML = HINT;
    render();
    picker.focus();
  }
  $('#trReset').addEventListener('click', async () => {
    if (items.length && !(await confirmDialog('Batalkan Mutasi', 'Semua barang di list akan dihapus dari form.', { okLabel: 'Ya, Batalkan', danger: true }))) return;
    reset();
  });

  const REASONS = ['Pecah terinjak', 'Retur konsumen', 'Kardus basah', 'Cacat pabrik saat unboxing', 'Kedaluwarsa', 'Kemasan penyok', 'Restock harian'];
  $('#trReasonChips').innerHTML = REASONS.map((r) => `<span class="chip">${esc(r)}</span>`).join('');
  $('#trReasonChips').addEventListener('click', (e) => { if (e.target.classList.contains('chip')) $('#trReason').value = e.target.textContent; });

  $('#trSubmit').addEventListener('click', async () => {
    if (!items.length) { toast('Tambahkan minimal satu barang ke list.', 'err'); picker.focus(); return; }
    const [from_zone, to_zone] = dir.value.split('>');
    const total = items.reduce((s, i) => s + i.qty, 0);
    const ok = await confirmDialog('Simpan Mutasi', `Simpan mutasi <b>${esc(state.meta.zones[from_zone])} → ${esc(state.meta.zones[to_zone])}</b> berisi ${items.length} baris (${num(total)} Biji)? Stok akan langsung berpindah.`, { okLabel: 'Simpan' });
    if (!ok) return;
    try {
      const d = await api('transfers:create', { from_zone, to_zone, reason: $('#trReason').value, items: items.map((i) => ({ sku: i.product.sku, qty: i.qty })) });
      toast(`Mutasi ${d.doc_no} tersimpan: ${num(d.line_count)} baris, ${num(d.total_qty)} Biji.`, 'ok');
      reset();
      loadLow();
      loadHistory();
    } catch (e) { toast(e.message, 'err', 6000); }
  });

  async function loadLow() {
    const rows = await api('stock:low', { limit: 60 });
    // Display toko habis/minus (mis. kasir menjual melebihi stok): merah & paling atas (urutan dari server)
    $('#trLowList').innerHTML = rows.length ? rows.map((p) => {
      const out = !!p.sold_out; // habis/minus karena terjual di kasir (bukan barang yang belum pernah dipajang)
      return `<div class="low-item ${out ? 'out' : ''}">
        <div><div class="pname">${out ? `<span class="out-tag">${p.floor_stock < 0 ? `MINUS ${num(p.floor_stock)}` : 'HABIS'}</span>` : ''}${esc(p.name)}</div>
        <div class="psub">Display Toko ${num(p.floor_stock)} / min ${num(p.min_floor_alert)} · Gudang ${num(p.warehouse_stock)} · BS ${num(p.damaged_stock)}${out ? ' · <b>Kosong di sistem / terjual melebihi stok — segera isi rak</b>' : ''}</div></div>
        ${p.warehouse_stock > 0 ? `<button class="btn sm" data-sku="${esc(p.sku)}">Isi Rak</button>` : '<span class="badge bs">Gudang kosong</span>'}</div>`;
    }).join('')
      : '<div class="muted">Semua display toko di atas batas minimum. 👍</div>';
    refreshOutBadge(rows);
    $('#trLowList').onclick = (e) => {
      const b = e.target.closest('[data-sku]');
      if (!b) return;
      const p = rows.find((r) => r.sku === b.dataset.sku);
      if (items.length && dir.value !== 'warehouse>floor') { toast('Form berisi arah mutasi lain — simpan atau batalkan dulu.', 'err'); return; }
      dir.value = 'warehouse>floor';
      add(p, Math.max(1, Math.min(p.warehouse_stock, p.min_floor_alert * 2 - p.floor_stock)));
      picker.focus();
    };
  }

  let searchTimer;
  $('#trSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadHistory, 200); });

  async function loadHistory() {
    const rows = await api('transfers:list', { q: $('#trSearch').value, limit: 300 });
    $('#trHistory').innerHTML = rows.length ? rows.map((d) => `<tr>
        <td class="muted">${fmtTime(d.created_at)}</td><td class="mono"><b>${esc(d.doc_no)}</b></td>
        <td>${zoneTag(d.from_zone)}</td><td class="arrow">→</td><td>${zoneTag(d.to_zone)}</td>
        <td class="r">${num(d.line_count)}</td><td class="r"><b>${num(d.total_qty)}</b></td><td>${esc(d.reason || '-')}</td>
        <td><button class="btn sm ghost" data-id="${d.id}">Detail</button></td></tr>`).join('')
      : '<tr><td colspan="9" class="empty-row">Belum ada riwayat mutasi.</td></tr>';
  }
  $('#trHistory').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const d = await api('transfers:get', { id: Number(b.dataset.id) });
    modal({
      title: `Mutasi ${d.doc_no}`,
      wide: true,
      body: `<div class="kv"><span>Tanggal</span><b>${fmtTime(d.created_at)}</b></div>
        <div class="kv"><span>Arah</span><b>${zoneTag(d.from_zone)} → ${zoneTag(d.to_zone)}</b></div>
        <div class="kv"><span>Alasan</span><b>${esc(d.reason || '-')}</b></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="r">No</th><th>Kode Item</th><th>Keterangan</th><th class="r">Jumlah</th><th>Satuan</th></tr></thead><tbody>
        ${d.items.map((i, idx) => `<tr><td class="r muted">${idx + 1}</td><td class="mono">${esc(i.sku)}</td><td>${esc(i.name || i.sku)}</td><td class="r"><b>${num(i.qty)}</b></td><td>Biji</td></tr>`).join('')}
        </tbody></table></div>`,
      actions: [{ label: 'Tutup', kind: 'primary' }],
    });
  });

  let inited = false;
  function show() {
    if (!inited) {
      dir.innerHTML = state.meta.directions.map((d) => `<option value="${d.from}>${d.to}">${esc(d.label)}</option>`).join('');
      inited = true;
    }
    // Perbarui stok barang di list (bisa berubah karena penjualan / penerimaan)
    Promise.all(items.map((i) => api('products:get', { sku: i.product.sku }).then((p) => { if (p) i.product = p; }))).then(render);
    render();
    loadLow();
    loadHistory();
    setTimeout(() => picker.focus(), 30);
  }
  return { show };
})();

// ================================================================ 3. PENERIMAAN
views.receiving = (() => {
  let picked = null;
  const items = []; // {product, qty, pack_type, destination}
  const DEST = { warehouse: 'Gudang Utama', floor: 'Display Toko', damaged: 'Gudang BS' };
  const DEST_CLASS = { warehouse: 'wh', floor: 'floor', damaged: 'bs' };

  makePicker($('#rcPicker'), {
    onPick: (p) => {
      picked = p;
      $('#rcPicker').value = p.name;
      $('#rcUnit option[value="Dus"]').textContent = `${p.pack_unit} (isi ${p.pack_ratio})`;
      $('#rcPicked').innerHTML = `Dipilih: <b>${esc(p.name)}</b> · ${esc(p.sku)} · 1 ${esc(p.pack_unit)} = ${num(p.pack_ratio)} Biji`;
      $('#rcQty').focus();
      $('#rcQty').select();
    },
  });
  $('#rcPicker').addEventListener('input', () => { picked = null; $('#rcPicked').textContent = ''; });

  function add() {
    if (!picked) { toast('Pilih barang dari daftar terlebih dahulu.', 'err'); $('#rcPicker').focus(); return; }
    const q = Number($('#rcQty').value);
    if (!Number.isInteger(q) || q < 1) { toast('Jumlah harus angka bulat ≥ 1.', 'err'); return; }
    const pack_type = $('#rcUnit').value;
    const destination = $('#rcDest').value;
    const same = items.find((i) => i.product.sku === picked.sku && i.pack_type === pack_type && i.destination === destination);
    if (same) same.qty += q;
    else items.push({ product: picked, qty: q, pack_type, destination });
    picked = null;
    $('#rcPicker').value = '';
    $('#rcPicked').textContent = '';
    $('#rcQty').value = 1;
    render();
    $('#rcPicker').focus();
  }
  $('#rcAdd').addEventListener('click', add);
  $('#rcQty').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  const pieces = (i) => (i.pack_type === 'Dus' ? i.qty * i.product.pack_ratio : i.qty);

  function render() {
    $('#rcItems').innerHTML = items.length ? items.map((i, idx) => `<tr data-i="${idx}">
        <td><div class="pname">${esc(i.product.name)}</div><div class="psub mono">${esc(i.product.sku)} · ${esc(i.product.barcode)}</div></td>
        <td class="r"><input type="number" min="1" value="${i.qty}" data-act="qty" style="width:90px;text-align:right"></td>
        <td>${i.pack_type === 'Dus' ? `${esc(i.product.pack_unit)} <span class="muted">(isi ${num(i.product.pack_ratio)})</span>` : 'Biji'}</td>
        <td class="r"><b>${num(pieces(i))}</b></td>
        <td><span class="badge ${DEST_CLASS[i.destination]}">${DEST[i.destination]}</span></td>
        <td class="c"><button class="icon-btn" data-act="del">✕</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty-row">Belum ada barang. Scan / cari barang lalu klik Tambah.</td></tr>';
    $('#rcTotal').textContent = `${items.length} baris · ${num(items.reduce((s, i) => s + pieces(i), 0))} Biji`;
  }
  $('#rcItems').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'del') { items.splice(Number(e.target.closest('tr').dataset.i), 1); render(); }
  });
  $('#rcItems').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'qty') return;
    const it = items[Number(e.target.closest('tr').dataset.i)];
    const q = Number(e.target.value);
    if (Number.isInteger(q) && q >= 1) it.qty = q;
    render();
  });

  function reset() {
    items.length = 0;
    ['#rcRef', '#rcSupplier', '#rcNotes', '#rcPicker'].forEach((s) => { $(s).value = ''; });
    picked = null;
    $('#rcPicked').textContent = '';
    render();
  }
  $('#rcReset').addEventListener('click', async () => {
    if (items.length && !(await confirmDialog('Batalkan Penerimaan', 'Semua barang yang sudah ditambahkan akan dihapus dari form.', { okLabel: 'Ya, Batalkan', danger: true }))) return;
    reset();
  });

  $('#rcSave').addEventListener('click', async () => {
    if (!$('#rcRef').value.trim()) { toast('No. Surat Jalan / Nota wajib diisi.', 'err'); $('#rcRef').focus(); return; }
    if (!items.length) { toast('Tambahkan minimal satu barang.', 'err'); return; }
    const total = items.reduce((s, i) => s + pieces(i), 0);
    const ok = await confirmDialog('Simpan Penerimaan', `Simpan penerimaan <b>${esc($('#rcRef').value)}</b> berisi ${items.length} baris (${num(total)} Biji)? Stok akan langsung bertambah.`, { okLabel: 'Simpan' });
    if (!ok) return;
    try {
      const r = await api('receptions:create', {
        reference_no: $('#rcRef').value, supplier_name: $('#rcSupplier').value, notes: $('#rcNotes').value,
        items: items.map((i) => ({ sku: i.product.sku, qty: i.qty, pack_type: i.pack_type, destination: i.destination })),
      });
      toast(`Penerimaan ${r.reference_no} tersimpan (${num(r.total_items_count)} Biji).`, 'ok');
      reset();
      loadHistory();
      if (await confirmDialog('Cetak Barcode', `Cetak label barcode untuk barang yang baru masuk (<b>${esc(r.reference_no)}</b>)?<br><span class="muted small">Jumlah label otomatis = jumlah Biji diterima, bisa diubah sebelum mencetak.</span>`, { okLabel: 'Ya, Siapkan Label' })) {
        views.barcode.openWith({ receptionId: r.id });
      }
    } catch (e) { toast(e.message, 'err', 6000); }
  });

  $('#rcTemplate').addEventListener('click', async () => {
    try { const f = await api('receptions:template'); if (f) toast(`Template disimpan: ${f}`, 'ok', 6000); } catch (e) { toast(e.message, 'err'); }
  });

  const errorList = (errors) => (errors.length
    ? `<div class="tbl-wrap" style="max-height:220px;margin-top:10px"><table class="tbl"><tbody>${errors.map((e) => `<tr><td>${esc(e)}</td></tr>`).join('')}</tbody></table></div>`
    : '');

  // Import Excel: baca file → ringkasan (dry run) → konfirmasi → simpan semua surat jalan
  $('#rcImport').addEventListener('click', async () => {
    let f;
    let plan;
    try {
      f = await api('receptions:importFile');
      if (!f) return;
      plan = await api('receptions:import', { rows: f.rows, dry_run: true });
    } catch (e) { toast(e.message, 'err', 7000); return; }
    const n = plan.docs.length;
    const total = plan.docs.reduce((s, d) => s + d.total, 0);
    modal({
      title: `Import Penerimaan — ${f.file}`,
      wide: true,
      body: `<div class="alert ${plan.errors.length ? 'warn' : 'ok'}">${n ? `${num(n)} penerimaan siap disimpan (${num(total)} Biji)` : 'Tidak ada penerimaan yang bisa disimpan'}${plan.errors.length ? `, <b>${plan.errors.length} baris/dokumen dilewati</b>` : ''}.</div>
        ${n ? `<div class="tbl-wrap" style="max-height:260px;margin-top:10px"><table class="tbl"><thead><tr><th>No. Surat Jalan</th><th>Supplier</th><th class="r">Baris</th><th class="r">Total Biji</th></tr></thead><tbody>
          ${plan.docs.map((d) => `<tr><td class="mono"><b>${esc(d.reference_no)}</b></td><td>${esc(d.supplier_name || '-')}</td><td class="r">${num(d.lines)}</td><td class="r">${num(d.total)}</td></tr>`).join('')}
        </tbody></table></div><p class="muted small">Stok langsung bertambah setelah disimpan.</p>` : ''}
        ${errorList(plan.errors)}`,
      actions: [
        { label: n ? 'Batal' : 'Tutup', kind: 'ghost' },
        ...(n ? [{
          label: `Simpan ${num(n)} Penerimaan`,
          kind: 'primary',
          onClick: async ({ close, btn }) => {
            btn.disabled = true;
            try {
              const r = await api('receptions:import', { rows: f.rows });
              close();
              loadHistory();
              if (r.created.length) toast(`${num(r.created.length)} penerimaan tersimpan (${num(r.created.reduce((s, c) => s + c.total_items_count, 0))} Biji).`, 'ok');
              if (r.errors.length) {
                modal({ title: 'Sebagian Tidak Tersimpan', body: `<div class="alert warn">${num(r.errors.length)} baris/dokumen dilewati.</div>${errorList(r.errors)}`, actions: [{ label: 'Tutup', kind: 'primary' }] });
              } else if (r.created.length === 1) {
                const c = r.created[0];
                if (await confirmDialog('Cetak Barcode', `Cetak label barcode untuk barang yang baru masuk (<b>${esc(c.reference_no)}</b>)?<br><span class="muted small">Jumlah label otomatis = jumlah Biji diterima, bisa diubah sebelum mencetak.</span>`, { okLabel: 'Ya, Siapkan Label' })) {
                  views.barcode.openWith({ receptionId: c.id });
                }
              }
            } catch (e) { btn.disabled = false; toast(e.message, 'err', 7000); }
          },
        }] : []),
      ],
    });
  });

  let t;
  $('#rcSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadHistory, 200); });

  async function loadHistory() {
    const rows = await api('receptions:list', { q: $('#rcSearch').value });
    $('#rcHistory').innerHTML = rows.length ? rows.map((r) => `<tr>
        <td class="muted">${fmtTime(r.received_at)}</td><td class="mono"><b>${esc(r.reference_no)}</b></td><td>${esc(r.supplier_name || '-')}</td>
        <td class="r">${num(r.line_count)}</td><td class="r">${num(r.total_items_count)}</td><td class="muted">${esc(r.notes || '')}</td>
        <td><button class="btn sm ghost" data-id="${r.id}">Detail</button></td></tr>`).join('')
      : '<tr><td colspan="7" class="empty-row">Belum ada riwayat penerimaan.</td></tr>';
  }
  $('#rcHistory').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const r = await api('receptions:get', { id: Number(b.dataset.id) });
    modal({
      title: `Penerimaan ${r.reference_no}`,
      wide: true,
      body: `<div class="kv"><span>Tanggal</span><b>${fmtTime(r.received_at)}</b></div>
        <div class="kv"><span>Supplier</span><b>${esc(r.supplier_name || '-')}</b></div>
        ${r.notes ? `<div class="kv"><span>Catatan</span><b>${esc(r.notes)}</b></div>` : ''}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Barang</th><th>Satuan Input</th><th class="r">Diterima (Biji)</th><th>Tujuan</th></tr></thead><tbody>
        ${r.items.map((i) => `<tr><td><div class="pname">${esc(i.name || i.sku)}</div><div class="psub mono">${esc(i.sku)}</div></td>
          <td>${i.pack_type === 'Dus' ? `${esc(i.pack_unit || 'Dus')} (isi ${num(i.pack_ratio)})` : 'Biji'}</td>
          <td class="r"><b>${num(i.quantity_received)}</b></td><td><span class="badge ${DEST_CLASS[i.destination]}">${DEST[i.destination]}</span></td></tr>`).join('')}
        </tbody></table></div>`,
      actions: [
        { label: 'Cetak Barcode', kind: 'ghost', onClick: ({ close }) => { close(); views.barcode.openWith({ receptionId: r.id }); } },
        { label: 'Tutup', kind: 'primary' },
      ],
    });
  });

  function show() {
    render();
    loadHistory();
    setTimeout(() => (items.length ? $('#rcPicker') : $('#rcRef')).focus(), 30);
  }
  return { show };
})();

// ================================================================ 4. DAFTAR BARANG
views.products = (() => {
  let rows = [];
  let t;
  $('#pdSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 200); });
  $('#pdFilter').addEventListener('change', load);

  async function load() {
    rows = await api('products:list', { q: $('#pdSearch').value, filter: $('#pdFilter').value });
    $('#pdBody').innerHTML = rows.length ? rows.map((p) => `<tr class="${p.floor_stock <= p.min_floor_alert ? 'low' : ''}">
        <td class="mono">${esc(p.sku)}</td><td class="mono">${esc(p.barcode)}</td>
        <td><div class="pname">${esc(p.name)}</div><div class="psub">1 ${esc(p.pack_unit)} = ${num(p.pack_ratio)} Biji · min toko ${num(p.min_floor_alert)}</div></td>
        <td>${esc(p.brand)}</td><td>${esc(p.category)}</td><td class="r">${num(p.unit_price)}</td>
        <td class="c">${floorBadge(p)}</td><td class="c">${whBadge(p)}</td><td class="c">${bsBadge(p)}</td>
        <td>${canEditProducts() ? `<div class="btn-row"><button class="btn sm ghost" data-label="${esc(p.sku)}" title="Tambah ke antrian cetak barcode">Barcode</button><button class="btn sm" data-edit="${esc(p.sku)}">Ubah</button><button class="btn sm danger" data-del="${esc(p.sku)}">Hapus</button></div>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="10" class="empty-row">Tidak ada barang. Tambah barang baru atau import dari Excel.</td></tr>';
    const tot = rows.reduce((a, p) => ({ f: a.f + p.floor_stock, w: a.w + p.warehouse_stock, d: a.d + p.damaged_stock }), { f: 0, w: 0, d: 0 });
    $('#pdCount').style.marginTop = '10px';
    $('#pdCount').textContent = `${num(rows.length)} barang · Total display toko ${num(tot.f)} · gudang utama ${num(tot.w)} · gudang BS ${num(tot.d)} Biji`;
  }

  $('#pdBody').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    const lbl = e.target.closest('[data-label]');
    if (lbl) views.barcode.openWith({ product: rows.find((r) => r.sku === lbl.dataset.label) });
    if (edit) openForm(rows.find((r) => r.sku === edit.dataset.edit));
    if (del) {
      const p = rows.find((r) => r.sku === del.dataset.del);
      const stockNote = p.floor_stock + p.warehouse_stock + p.damaged_stock > 0 ? `<br><br><span class="badge bs">Perhatian</span> Barang ini masih memiliki stok (Display Toko ${p.floor_stock}, Gudang ${p.warehouse_stock}, BS ${p.damaged_stock}).` : '';
      if (!(await confirmDialog('Hapus Barang', `Hapus <b>${esc(p.name)}</b> (${esc(p.sku)}) dari master barang?${stockNote}`, { okLabel: 'Hapus', danger: true }))) return;
      try { await api('products:delete', { sku: p.sku }); toast('Barang dihapus.', 'ok'); load(); } catch (err) { toast(err.message, 'err', 6000); }
    }
  });

  async function openForm(p) {
    const isNew = !p;
    p = p || { sku: '', barcode: '', name: '', brand: '', category: '', unit_price: 0, pack_unit: 'Dus', pack_ratio: 1, min_floor_alert: 5 };
    const cats = await api('products:categories');
    modal({
      title: isNew ? 'Tambah Barang Baru' : `Ubah Barang — ${p.sku}`,
      wide: true,
      body: `
        <div class="row-3">
          <div class="field"><label>SKU *</label><input id="fSku" maxlength="50" value="${esc(p.sku)}" ${isNew ? '' : 'readonly'}></div>
          <div class="field"><label>Barcode * <span class="muted">(scan di sini)</span></label><input id="fBarcode" maxlength="64" value="${esc(p.barcode)}"></div>
          <div class="field"><label>Harga Jual per Biji (Rp) *</label><input id="fPrice" class="money" inputmode="numeric" value="${p.unit_price ? num(p.unit_price) : ''}"></div>
        </div>
        <div class="field"><label>Nama Barang *</label><input id="fName" maxlength="150" value="${esc(p.name)}"></div>
        <div class="row-3">
          <div class="field"><label>Merk</label><input id="fBrand" maxlength="80" value="${esc(p.brand === '-' ? '' : p.brand)}" placeholder="-"></div>
          <div class="field"><label>Kategori</label><input id="fCat" maxlength="80" list="fCatList" value="${esc(p.category)}" placeholder="Umum">
            <datalist id="fCatList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
          <div class="field"><label>Min. Display Toko (peringatan)</label><input id="fMin" type="number" min="0" value="${p.min_floor_alert}"></div>
        </div>
        <div class="row-3">
          <div class="field"><label>Satuan Jual Kasir</label><input value="Biji" readonly></div>
          <div class="field"><label>Satuan Masuk Supplier</label><input id="fPack" maxlength="30" value="${esc(p.pack_unit)}" placeholder="Dus / Karton"></div>
          <div class="field"><label>Isi per Satuan Masuk (Biji)</label><input id="fRatio" type="number" min="1" value="${p.pack_ratio}"></div>
        </div>
        ${isNew ? `<h2 class="mt">Stok Awal (Biji)</h2><div class="row-3">
          <div class="field"><label><span class="badge floor ok">Display Toko</span></label><input id="fFloor" type="number" min="0" value="0"></div>
          <div class="field"><label><span class="badge wh">Gudang Utama</span></label><input id="fWh" type="number" min="0" value="0"></div>
          <div class="field"><label><span class="badge bs">Gudang BS</span></label><input id="fBs" type="number" min="0" value="0"></div></div>`
          : `<div class="muted small">Stok diubah melalui menu Penerimaan Barang dan Mutasi agar riwayatnya tercatat.</div>${zoneBadges(p)}`}`,
      actions: [
        { label: 'Batal', kind: 'ghost' },
        {
          label: isNew ? 'Simpan Barang' : 'Simpan Perubahan',
          kind: 'primary',
          onClick: async ({ close, el }) => {
            const v = (id) => $(id, el).value;
            try {
              const saved = await api('products:save', {
                isNew,
                product: {
                  sku: v('#fSku'), barcode: v('#fBarcode'), name: v('#fName'), brand: v('#fBrand'), category: v('#fCat'),
                  unit_price: moneyVal($('#fPrice', el)), pack_unit: v('#fPack'), pack_ratio: v('#fRatio'), min_floor_alert: v('#fMin'),
                },
                initial: isNew ? { floor: v('#fFloor'), warehouse: v('#fWh'), damaged: v('#fBs') } : undefined,
              });
              toast(`"${saved.name}" tersimpan.`, 'ok');
              close();
              load();
            } catch (err) { toast(err.message, 'err', 6000); }
          },
        },
      ],
      onOpen: (el) => {
        bindMoney($('#fPrice', el));
        // Enter dari scanner di kolom barcode jangan menutup form
        $('#fBarcode', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#fName', el).focus(); } });
        (isNew ? $('#fSku', el) : $('#fName', el)).focus();
      },
    });
  }

  $('#pdAdd').addEventListener('click', () => openForm(null));
  $('#pdTemplate').addEventListener('click', async () => {
    try { const f = await api('products:template'); if (f) toast(`Template disimpan: ${f}`, 'ok', 6000); } catch (e) { toast(e.message, 'err'); }
  });
  $('#pdImport').addEventListener('click', async () => {
    try {
      const r = await api('products:import');
      if (!r) return;
      load();
      modal({
        title: `Hasil Import — ${r.file}`,
        body: `<div class="alert ${r.errors.length ? 'warn' : 'ok'}">${num(r.inserted)} barang baru ditambahkan, ${num(r.updated)} barang diperbarui${r.errors.length ? `, <b>${r.errors.length} baris dilewati</b>` : ''}.</div>
          ${r.format === 'data item' ? '<p class="muted small">Format: <b>Data Item</b> (Kode Item → SKU &amp; barcode, Jenis → kategori, Stok → Gudang Utama).</p>' : ''}
          ${r.updated ? '<p class="muted small">Untuk SKU yang sudah ada, kolom stok awal diabaikan (stok hanya berubah lewat Penerimaan / Mutasi).</p>' : ''}
          ${r.errors.length ? `<div class="tbl-wrap" style="max-height:260px;margin-top:10px"><table class="tbl"><tbody>${r.errors.map((e) => `<tr><td>${esc(e)}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
        actions: [{ label: 'Tutup', kind: 'primary' }],
      });
    } catch (e) { toast(e.message, 'err', 7000); }
  });

  function show() {
    load();
    setTimeout(() => $('#pdSearch').focus(), 30);
  }
  return { show };
})();

// ================================================================ 4b. CETAK BARCODE
views.barcode = (() => {
  let designs = [];
  let current = null; // desain yang sedang diedit (id null = baru)
  const queue = []; // { product, copies }
  const fields = $$('#view-barcode [data-k]');

  let els = null; // elemen designer (null = susunan bawaan dari server)

  function readConfig() {
    const cfg = {};
    for (const el of fields) cfg[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
    if (els) cfg.elements = els.map((e) => ({ ...e }));
    return cfg;
  }
  function writeConfig(cfg) {
    for (const el of fields) {
      if (el.type === 'checkbox') el.checked = !!cfg[el.dataset.k];
      else el.value = cfg[el.dataset.k] ?? '';
    }
    els = Array.isArray(cfg.elements) ? cfg.elements.map((e) => ({ ...e })) : null;
    designer.select(null);
  }

  // ---------- Designer label: kanvas satu label (render asli) + lapisan kotak yang bisa diseret/diubah ukurannya
  const designer = (() => {
    const TYPE_LABEL = { name: 'Nama barang', price: 'Harga', barcode: 'Barcode', code: 'Angka barcode', sku: 'SKU', brand: 'Merk', text: 'Teks', line: 'Garis', box: 'Kotak' };
    const TEXT_TYPES = ['name', 'price', 'code', 'sku', 'brand', 'text'];
    const SNAP = 0.5;
    const r2 = (n) => Math.round(n * 100) / 100;
    const snap = (n) => Math.round(n / SNAP) * SNAP;
    let cell = { w: 50, h: 18 };
    let S = 8; // piksel per mm di kanvas
    let sel = null;
    let drag = null;
    let seq = 0;
    const overlay = $('#dzOverlay');
    const stage = $('#dzStage');

    const find = (id) => (els || []).find((e) => e.id === id);
    function clampEl(e) {
      e.w = r2(Math.min(cell.w, Math.max(0.5, e.w)));
      e.h = r2(Math.min(cell.h, Math.max(e.type === 'line' ? 0.1 : 0.5, e.h)));
      e.x = r2(Math.min(cell.w - e.w, Math.max(0, e.x)));
      e.y = r2(Math.min(cell.h - e.h, Math.max(0, e.y)));
    }

    const isOpen = () => !$('#lbDesigner').classList.contains('hidden');

    async function render() {
      if (!isOpen()) return; // designer tersembunyi: tidak perlu render kanvas
      const my = ++seq;
      let pv;
      try {
        pv = await api('labels:preview', { config: readConfig(), items: queue.slice(0, 1).map((q) => ({ sku: q.product.sku })), single: true });
      } catch (_) { return; } // pesan error sudah tampil di pratinjau baris
      if (my !== seq) return;
      cell = { w: pv.cellW, h: pv.cellH };
      if (!els) els = pv.elements.map((e) => ({ ...e }));
      const avail = Math.max(200, stage.clientWidth - 48);
      S = Math.max(4, Math.min(16, avail / cell.w));
      const label = $('#dzLabel');
      label.style.width = `${cell.w * S}px`;
      label.style.height = `${cell.h * S}px`;
      // Grid 1 mm & 5 mm
      label.style.backgroundImage = `linear-gradient(rgba(0,0,0,.13) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,.13) 1px, transparent 1px),
        linear-gradient(rgba(0,0,0,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,.05) 1px, transparent 1px)`;
      label.style.backgroundSize = `${5 * S}px ${5 * S}px, ${5 * S}px ${5 * S}px, ${S}px ${S}px, ${S}px ${S}px`;
      const rd = $('#dzRender');
      rd.innerHTML = `<style>${pv.css}</style>${pv.html}`;
      rd.style.zoom = (S / 3.7795).toFixed(4);
      drawOverlay();
      if (!drag) drawProps();
    }

    function boxStyle(e) {
      // Garis tipis tetap mudah diklik: kotak minimal 8 px, tetap di tengah posisi aslinya
      const minPx = 8;
      let x = e.x * S; let y = e.y * S; let w = e.w * S; let h = e.h * S;
      if (h < minPx) { y -= (minPx - h) / 2; h = minPx; }
      if (w < minPx) { x -= (minPx - w) / 2; w = minPx; }
      return `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    }

    function drawOverlay() {
      overlay.innerHTML = (els || []).map((e) => `<div class="dz-el ${e.id === sel ? 'sel' : ''}" data-id="${esc(e.id)}" style="${boxStyle(e)}">
        <span class="tag">${esc(TYPE_LABEL[e.type])}</span>${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i class="dz-h" data-h="${h}"></i>`).join('')}</div>`).join('');
    }

    function moveBox(e) {
      const box = overlay.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
      if (box) box.setAttribute('style', boxStyle(e));
    }

    let rTimer;
    const scheduleRender = () => { clearTimeout(rTimer); rTimer = setTimeout(() => { updatePreview(); }, 120); };

    function drawProps() {
      const p = $('#dzProps');
      const e = find(sel);
      if (!e) {
        p.innerHTML = `<h3>Elemen (${(els || []).length})</h3><div class="muted small">Klik elemen di kanvas atau di daftar ini untuk mengatur ukuran &amp; posisinya.</div>
          <div class="dz-list">${(els || []).map((x) => `<button data-pick="${esc(x.id)}">${esc(TYPE_LABEL[x.type])}${x.type === 'text' && x.text ? ` — ${esc(x.text)}` : ''}</button>`).join('')}</div>`;
        return;
      }
      const isText = TEXT_TYPES.includes(e.type);
      const numField = (k, label, step = 0.5, min = 0) => `<div class="field"><label>${label}</label><input type="number" step="${step}" min="${min}" data-p="${k}" value="${e[k]}"></div>`;
      p.innerHTML = `<h3>${esc(TYPE_LABEL[e.type])}</h3>
        <div class="row-2">${numField('x', 'X (mm)')}${numField('y', 'Y (mm)')}</div>
        <div class="row-2">${numField('w', 'Lebar (mm)')}${numField('h', 'Tinggi (mm)', e.type === 'line' ? 0.1 : 0.5)}</div>
        ${isText ? `<div class="row-2">${numField('size', 'Ukuran huruf (pt)', 0.5, 3)}<div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" data-p="bold" ${e.bold ? 'checked' : ''}> Tebal</label></div></div>` : ''}
        ${isText || e.type === 'barcode' ? `<div class="field"><label>Rata</label><div class="dz-seg">${[['left', 'Kiri'], ['center', 'Tengah'], ['right', 'Kanan']].map(([v, l]) => `<button data-align="${v}" class="${e.align === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>` : ''}
        ${e.type === 'text' ? `<div class="field"><label>Teks</label><input data-p="text" maxlength="60" value="${esc(e.text)}"></div>` : ''}
        ${e.type === 'line' || e.type === 'box' ? numField('thickness', 'Ketebalan garis (mm)', 0.1, 0.1) : ''}
        <div class="btn-row" style="margin-top:6px"><button class="btn sm ghost" data-act="full">Lebar penuh</button><button class="btn sm danger" data-act="del">Hapus</button><button class="btn sm ghost" data-act="none">Selesai</button></div>`;
    }

    function select(id) {
      sel = id;
      drawOverlay();
      drawProps();
    }

    function remove(id) {
      els = els.filter((e) => e.id !== id);
      select(null);
      scheduleRender();
    }

    function add(type) {
      if (!els) els = [];
      if (els.length >= 30) { toast('Maksimal 30 elemen per label.', 'err'); return; }
      let n = els.length + 1;
      while (find(`e${n}`)) n++;
      const lh = (pt) => r2(pt * 0.3528 * 1.15 + 0.3);
      const base = { id: `e${n}`, type, x: 0, y: 0, w: cell.w, h: 4, size: 8, bold: false, align: 'center', text: '', thickness: 0.3 };
      const preset = {
        name: { size: 8, bold: true, h: lh(8) },
        price: { size: 12, bold: true, h: lh(12) },
        code: { size: 6, h: lh(6) },
        sku: { size: 6, h: lh(6) },
        brand: { size: 6, h: lh(6) },
        text: { size: 7, h: lh(7), text: 'Teks' },
        barcode: { w: r2(cell.w * 0.9), x: r2(cell.w * 0.05), h: Math.min(7, cell.h) },
        line: { h: 1, y: r2(cell.h / 2 - 0.5) },
        box: { w: cell.w, h: cell.h },
      }[type];
      const e = { ...base, ...preset };
      clampEl(e);
      els.push(e);
      select(e.id);
      updatePreview();
      stage.focus();
    }

    // Pilih / seret / ubah ukuran dengan mouse
    overlay.addEventListener('pointerdown', (ev) => {
      const box = ev.target.closest('.dz-el');
      if (!box) { select(null); return; }
      ev.preventDefault();
      const e = find(box.dataset.id);
      if (sel !== e.id) select(e.id);
      const handle = ev.target.closest('.dz-h');
      drag = { id: e.id, mode: handle ? handle.dataset.h : 'move', sx: ev.clientX, sy: ev.clientY, o: { x: e.x, y: e.y, w: e.w, h: e.h } };
      try { overlay.setPointerCapture(ev.pointerId); } catch (_) { /* pointer sudah dilepas */ }
      stage.focus();
    });
    overlay.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const e = find(drag.id);
      if (!e) return;
      const dx = snap((ev.clientX - drag.sx) / S);
      const dy = snap((ev.clientY - drag.sy) / S);
      const o = drag.o;
      const m = drag.mode;
      if (m === 'move') { e.x = o.x + dx; e.y = o.y + dy; } else {
        if (m.includes('e')) e.w = o.w + dx;
        if (m.includes('s')) e.h = o.h + dy;
        if (m.includes('w')) { const w = Math.max(0.5, o.w - dx); e.x = o.x + o.w - w; e.w = w; }
        if (m.includes('n')) { const h = Math.max(e.type === 'line' ? 0.1 : 0.5, o.h - dy); e.y = o.y + o.h - h; e.h = h; }
      }
      clampEl(e);
      moveBox(e);
      drawProps();
      scheduleRender();
    });
    const endDrag = () => { if (drag) { drag = null; updatePreview(); } };
    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);

    // Panah = geser 0,5 mm (Shift = 2 mm), Delete = hapus
    stage.addEventListener('keydown', (ev) => {
      const e = find(sel);
      if (!e) return;
      const step = ev.shiftKey ? 2 : SNAP;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
      if (mv) {
        ev.preventDefault();
        e.x += mv[0];
        e.y += mv[1];
        clampEl(e);
        moveBox(e);
        drawProps();
        scheduleRender();
      } else if (ev.key === 'Delete') { ev.preventDefault(); remove(e.id); }
    });

    // Panel properti
    const props = $('#dzProps');
    props.addEventListener('input', (ev) => {
      const k = ev.target.dataset.p;
      const e = find(sel);
      if (!k || !e) return;
      if (k === 'bold') e.bold = ev.target.checked;
      else if (k === 'text') e.text = ev.target.value;
      else {
        const v = Number(ev.target.value);
        if (!Number.isFinite(v)) return;
        e[k] = k === 'size' ? Math.min(40, Math.max(3, v)) : k === 'thickness' ? Math.min(2, Math.max(0.1, v)) : v;
        // Huruf diperbesar → tinggi kotak ikut agar teks tidak terpotong
        if (k === 'size') e.h = Math.max(e.h, r2(e.size * 0.3528 * 1.15 + 0.3));
        clampEl(e);
      }
      moveBox(e);
      scheduleRender();
    });
    props.addEventListener('change', () => drawProps()); // tampilkan nilai setelah dijepit ke dalam label
    props.addEventListener('click', (ev) => {
      const pick = ev.target.closest('[data-pick]');
      if (pick) { select(pick.dataset.pick); stage.focus(); return; }
      const e = find(sel);
      if (!e) return;
      const al = ev.target.closest('[data-align]');
      if (al) { e.align = al.dataset.align; drawProps(); scheduleRender(); }
      const act = ev.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'del') remove(e.id);
      if (act.dataset.act === 'none') select(null);
      if (act.dataset.act === 'full') { e.x = 0; e.w = cell.w; clampEl(e); moveBox(e); drawProps(); scheduleRender(); }
    });

    $('#dzAdd').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-add]');
      if (b) add(b.dataset.add);
    });
    $('#dzReset').addEventListener('click', async () => {
      if (!(await confirmDialog('Reset Tata Letak', 'Kembalikan isi label ke susunan bawaan (nama, barcode, angka barcode, harga)?', { okLabel: 'Reset' }))) return;
      els = null;
      select(null);
      updatePreview();
    });

    // Designer hanya tampil saat tombol "Buka Designer Label" ditekan
    function setOpen(open) {
      $('#lbDesigner').classList.toggle('hidden', !open);
      $('#lbDesignerToggle').textContent = open ? 'Tutup Designer Label' : 'Buka Designer Label';
      if (open) {
        render();
        $('#lbDesigner').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else select(null);
    }
    $('#lbDesignerToggle').addEventListener('click', () => setOpen(!isOpen()));
    $('#dzClose').addEventListener('click', () => setOpen(false));

    return { render, select, add, setOpen, get selected() { return sel; }, get scale() { return S; } };
  })();

  function renderDesigns() {
    $('#lbDesign').innerHTML = designs.map((d) => `<option value="${d.id}">${esc(d.name)}${d.is_default ? ' (default)' : ''}</option>`).join('')
      + (current && !current.id ? '<option value="" selected>(desain baru)</option>' : '');
    if (current && current.id) $('#lbDesign').value = current.id;
  }

  function selectDesign(d) {
    current = d;
    $('#lbName').value = d.name;
    writeConfig(d.config);
    renderDesigns();
    updatePreview();
  }

  async function loadDesigns(selectId) {
    designs = await api('labels:designs');
    selectDesign(designs.find((d) => d.id === selectId) || designs.find((d) => d.is_default) || designs[0]);
  }

  let pvTimer;
  async function updatePreview() {
    try {
      const pv = await api('labels:preview', { config: readConfig(), items: queue.slice(0, 6).map((q) => ({ sku: q.product.sku })) });
      const paper = $('#lbPreviewPaper');
      paper.innerHTML = `<style>${pv.css}</style>${pv.html}`;
      paper.style.width = `${pv.widthMm}mm`;
      paper.style.height = `${pv.heightMm}mm`;
      const avail = $('.label-preview').clientWidth - 32;
      const px = pv.widthMm * 3.7795;
      paper.style.zoom = Math.max(0.5, Math.min(4, avail / px)).toFixed(2);
      const cfg = readConfig();
      const lw = (pv.widthMm - 2 * cfg.margin_mm - (cfg.columns - 1) * cfg.gap_mm) / cfg.columns;
      $('#lbPreviewInfo').textContent = `Kertas ${num(pv.widthMm)} × ${num(pv.heightMm)} mm · ${cfg.columns} kolom · ukuran tiap label ±${lw.toFixed(1).replace('.', ',')} × ${(pv.heightMm - 2 * cfg.margin_mm).toFixed(1).replace('.', ',')} mm`;
      $('#lbPreviewErr').classList.add('hidden');
      designer.render();
    } catch (e) {
      $('#lbPreviewErr').textContent = e.message;
      $('#lbPreviewErr').classList.remove('hidden');
    }
  }
  $('#view-barcode .card').addEventListener('input', () => { clearTimeout(pvTimer); pvTimer = setTimeout(updatePreview, 200); });

  $('#lbDesign').addEventListener('change', () => {
    const d = designs.find((x) => x.id === Number($('#lbDesign').value));
    if (d) selectDesign(d);
  });
  $('#lbNew').addEventListener('click', () => {
    selectDesign({ id: null, name: `Desain ${designs.length + 1}`, config: current ? readConfig() : {} });
    $('#lbName').focus();
    $('#lbName').select();
  });
  $('#lbSave').addEventListener('click', async () => {
    try {
      const id = await api('labels:saveDesign', { id: current && current.id, name: $('#lbName').value, config: readConfig() });
      toast('Desain label tersimpan.', 'ok');
      await loadDesigns(id);
    } catch (e) { toast(e.message, 'err', 6000); }
  });
  $('#lbDefault').addEventListener('click', async () => {
    if (!current || !current.id) { toast('Simpan desain terlebih dahulu.', 'err'); return; }
    try { await api('labels:setDefault', { id: current.id }); toast('Desain dijadikan default.', 'ok'); await loadDesigns(current.id); } catch (e) { toast(e.message, 'err'); }
  });
  $('#lbDelete').addEventListener('click', async () => {
    if (!current || !current.id) { await loadDesigns(); return; }
    if (!(await confirmDialog('Hapus Desain', `Hapus desain label <b>${esc(current.name)}</b>?`, { okLabel: 'Hapus', danger: true }))) return;
    try { await api('labels:deleteDesign', { id: current.id }); toast('Desain dihapus.', 'ok'); await loadDesigns(); } catch (e) { toast(e.message, 'err'); }
  });

  // ---------- Antrian
  function renderQueue() {
    $('#lbQueue').innerHTML = queue.length ? queue.map((q, i) => `<tr data-i="${i}">
        <td><div class="pname">${esc(q.product.name)}</div><div class="psub mono">${esc(q.product.sku)}</div></td>
        <td class="mono">${esc(q.product.barcode)}</td><td class="r">${rp(q.product.unit_price)}</td>
        <td class="c"><input type="number" min="0" max="5000" step="1" value="${q.copies}" data-act="copies" style="width:100px;text-align:center"></td>
        <td class="c"><button class="icon-btn" data-act="del" title="Hapus">✕</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="empty-row">Antrian kosong. Ambil dari dokumen penerimaan atau tambah barang manual.</td></tr>';
    const total = queue.reduce((s, q) => s + q.copies, 0);
    const cols = Number(readConfig().columns) || 1;
    $('#lbTotal').textContent = `${num(queue.length)} barang · ${num(total)} label · ${num(Math.ceil(total / cols))} baris kertas`;
  }
  $('#lbQueue').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'copies') return;
    const q = queue[Number(e.target.closest('tr').dataset.i)];
    const n = Number(e.target.value);
    if (Number.isInteger(n) && n >= 0 && n <= 5000) q.copies = n;
    else toast('Jumlah label harus angka bulat 0–5000.', 'err');
    renderQueue();
  });
  $('#lbQueue').addEventListener('click', (e) => {
    if (e.target.dataset.act !== 'del') return;
    queue.splice(Number(e.target.closest('tr').dataset.i), 1);
    renderQueue();
    updatePreview();
  });

  function add(product, copies = 1) {
    const q = queue.find((x) => x.product.sku === product.sku);
    if (q) q.copies += copies;
    else queue.push({ product, copies });
    renderQueue();
    updatePreview();
  }
  function setQueue(items) {
    queue.length = 0;
    for (const it of items) queue.push({ product: it.product, copies: it.copies });
    renderQueue();
  }

  // Kolom Jumlah label (kursor default): Enter di Jumlah → kolom scan; Enter di scan kosong (atau *) → Jumlah;
  // setelah barang ditambah, Jumlah kembali ke 1 dan kursor kembali ke Jumlah
  const lbPicker = $('#lbPicker');
  const lbQty = $('#lbQty');
  function readLbQty() {
    const n = Number(String(lbQty.value).trim());
    if (Number.isInteger(n) && n >= 1 && n <= 5000) return n;
    sound('err');
    toast('Jumlah label harus angka bulat 1–5000.', 'err');
    lbQty.focus();
    return 0;
  }
  lbQty.addEventListener('focus', () => lbQty.select());
  lbQty.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (readLbQty()) lbPicker.focus();
  });
  lbPicker.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === '*') && !lbPicker.value.trim()) { e.preventDefault(); lbQty.focus(); }
  });
  makePicker(lbPicker, {
    onPick: (p) => {
      const n = readLbQty();
      if (!n) return;
      lbPicker.value = '';
      add(p, n);
      lbQty.value = '1';
      lbQty.focus(); // kursor default di Jumlah label (isi terpilih, langsung tertimpa ketikan)
    },
  });
  $('#lbClear').addEventListener('click', () => { queue.length = 0; renderQueue(); updatePreview(); });

  async function fillFromReception(id) {
    const r = await api('labels:fromReception', { id });
    setQueue(r.items);
    toast(`Antrian diisi dari ${r.reference_no}: ${num(r.items.reduce((s, i) => s + i.copies, 0))} label.`, 'ok');
  }
  $('#lbFromReception').addEventListener('click', async () => {
    const id = Number($('#lbReception').value);
    if (!id) { toast('Belum ada dokumen penerimaan.', 'err'); return; }
    try { await fillFromReception(id); updatePreview(); } catch (e) { toast(e.message, 'err'); }
  });

  async function loadPrinters() {
    const list = await api('printer:list').catch(() => []);
    const saved = state.settings.label_printer_name || '';
    const opts = ['<option value="">Printer default Windows</option>'].concat(list.map((p) => `<option value="${esc(p.name)}">${esc(p.displayName)}</option>`));
    if (saved && !list.some((p) => p.name === saved)) opts.push(`<option value="${esc(saved)}">${esc(saved)} (tidak terdeteksi)</option>`);
    $('#lbPrinter').innerHTML = opts.join('');
    $('#lbPrinter').value = saved;
  }
  $('#lbPrinter').addEventListener('change', async () => {
    try { state.settings = await api('settings:save', { label_printer_name: $('#lbPrinter').value }); } catch (e) { toast(e.message, 'err'); }
  });

  $('#lbPrint').addEventListener('click', async () => {
    const items = queue.filter((q) => q.copies > 0);
    const total = items.reduce((s, q) => s + q.copies, 0);
    if (!total) { toast('Antrian kosong atau jumlah label 0.', 'err'); return; }
    if (total > 500 && !(await confirmDialog('Cetak Banyak Label', `Anda akan mencetak <b>${num(total)} label</b>. Lanjutkan?`, { okLabel: 'Cetak' }))) return;
    const btn = $('#lbPrint');
    btn.disabled = true;
    btn.textContent = 'Mencetak…';
    try {
      const r = await api('labels:print', { config: readConfig(), items: items.map((q) => ({ sku: q.product.sku, copies: q.copies })) });
      toast(`${num(r.labels)} label dikirim ke printer (${num(r.rows)} baris).`, 'ok', 6000);
    } catch (e) { toast(e.message, 'err', 8000); } finally { btn.disabled = false; btn.textContent = 'Cetak Label'; }
  });

  async function show() {
    designer.setOpen(false); // designer tersembunyi setiap layar dibuka
    const recs = await api('receptions:list', { limit: 50 });
    $('#lbReception').innerHTML = recs.length
      ? recs.map((r) => `<option value="${r.id}">${esc(r.reference_no)} · ${esc(r.supplier_name || '-')} · ${fmtTime(r.received_at)}</option>`).join('')
      : '<option value="">Belum ada dokumen penerimaan</option>';
    await loadPrinters();
    if (!current) await loadDesigns();
    else updatePreview();
    renderQueue();
    if (!$('#modalRoot').children.length) lbQty.focus();
  }

  // Dipanggil dari menu lain: buka layar ini dengan antrian terisi
  async function openWith({ receptionId, product } = {}) {
    if (receptionId) await fillFromReception(receptionId);
    if (product) add(product, 1);
    go('barcode');
    if (receptionId) $('#lbReception').value = receptionId;
  }

  return { show, openWith, get designerScale() { return designer.scale; } };
})();

// ================================================================ 5. SHIFT
views.shift = (() => {
  const root = $('#shiftContent');

  function checksCard(checks) {
    if (!checks || !checks.length) return '';
    return `<div class="card">
        <h2>Transaksi Mode Darurat — Perlu Dicek</h2>
        <p class="muted small">Saat transaksi darurat dikirim, display toko di PC Gudang tidak cukup. Transaksi tetap dicatat dan display toko dibiarkan minus.
          Cek fisik rak, catat Mutasi / Penerimaan bila perlu, lalu tandai sudah dicek.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>No. Struk</th><th>Waktu</th><th class="r">Total</th><th>Catatan</th><th></th></tr></thead><tbody id="shChecks">
          ${checks.map((c) => `<tr><td class="mono">${esc(c.receipt_no)}</td><td class="muted">${fmtTime(c.created_at)}</td><td class="r">${rp(c.total)}</td>
            <td class="small">${c.notes.map(esc).join('<br>')}</td><td>${role() === 'admin' ? `<button class="btn sm ghost" data-chk="${esc(c.receipt_no)}">Sudah Dicek</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
      </div>`;
  }

  async function show() {
    if (state.connected === false && state.emergency) {
      const em = state.emergency;
      root.innerHTML = `<div class="card" style="max-width:640px"><h2>Laporan Shift belum tersedia</h2>
        <p>PC Gudang tidak terhubung (MODE DARURAT). Laporan shift dan tutup kasir bisa dibuka lagi setelah koneksi kembali.</p>
        ${em.pending ? `<div class="alert warn">${num(em.pending)} transaksi MODE DARURAT (${rp(em.pending_total)}) menunggu dikirim ke PC Gudang.</div>` : ''}</div>`;
      return;
    }
    await refreshShift();
    if (!state.shift) {
      root.innerHTML = '<div class="card" style="max-width:440px" id="shOpen"></div>';
      openShiftForm($('#shOpen'), () => show());
      return;
    }
    const s = await api('shift:summary');
    const sh = s.shift;
    root.innerHTML = `
      <div class="stats">
        <div class="stat hl"><div class="lbl">Total Omset Shift</div><div class="val">${rp(s.totals.revenue)}</div></div>
        <div class="stat"><div class="lbl">Jumlah Transaksi</div><div class="val">${num(s.totals.receipts)}</div></div>
        <div class="stat"><div class="lbl">Barang Terjual</div><div class="val">${num(s.totals.qty)} <span class="small muted">Biji</span></div></div>
        <div class="stat"><div class="lbl">Kasir</div><div class="val" style="font-size:18px">${esc(sh.cashier_name)}</div><div class="muted small">Mulai ${fmtTime(sh.shift_start)}</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h2>Omset per Metode Pembayaran</h2>
          ${s.byMethod.length ? s.byMethod.map((m) => `<div class="kv"><span>${esc(m.method)} <span class="muted small">(${num(m.receipts)} transaksi)</span></span><b>${rp(m.total)}</b></div>`).join('') : '<div class="muted">Belum ada penjualan.</div>'}
          <h2 class="mt">Barang Terjual</h2>
          <div class="tbl-wrap" style="max-height:300px"><table class="tbl"><thead><tr><th>Barang</th><th class="r">Biji</th><th class="r">Total</th></tr></thead><tbody>
            ${s.byItem.map((i) => `<tr><td><div class="pname">${esc(i.name)}</div><div class="psub mono">${esc(i.sku)}</div></td><td class="r">${num(i.qty)}</td><td class="r">${rp(i.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-row">Belum ada penjualan.</td></tr>'}
          </tbody></table></div>
        </div>
        <div class="card">
          <h2>Tutup Shift / Cetak Rekap</h2>
          <div class="kv"><span>Penjualan tunai</span><b>${rp(s.cashSales)}</b></div>
          <div class="field"><label>Catatan Kasir <span class="muted">(opsional)</span></label><input id="shNotes" maxlength="300" placeholder="Contoh: ada uang palsu Rp 50.000"></div>
          <button class="btn primary xl" id="shClose">Tutup Shift &amp; Kirim Laporan</button>
          <p class="muted small" style="margin-top:10px">Laporan (PDF rekap, CSV penjualan, CSV snapshot stok Display Toko / Gudang Utama / Gudang BS) dikirim ke <b>${esc(state.settings.owner_email || '(email owner belum diatur)')}</b>.
          Data penjualan shift dihapus hanya setelah server email membalas <b>250 OK</b>.</p>
        </div>
      </div>
      ${checksCard(s.offline && s.offline.checks)}
      <div class="card">
        <h2>Transaksi Shift Ini</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>No. Struk</th><th>Metode</th><th class="r">Biji</th><th class="r">Total</th><th></th></tr></thead><tbody id="shReceipts">
          ${s.receipts.map((r) => `<tr><td class="muted">${fmtTime(r.created_at)}</td><td class="mono">${esc(r.receipt_no)}</td><td>${esc(r.payment_method)}</td><td class="r">${num(r.qty)}</td><td class="r"><b>${rp(r.total)}</b></td>
            <td><button class="btn sm ghost" data-r="${esc(r.receipt_no)}">Detail</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">Belum ada transaksi.</td></tr>'}
        </tbody></table></div>
      </div>`;


    if ($('#shChecks')) {
      $('#shChecks').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-chk]');
        if (!b) return;
        try { await api('offline:markChecked', { receipt_no: b.dataset.chk }); toast('Ditandai sudah dicek.', 'ok'); show(); } catch (err) { toast(err.message, 'err'); }
      });
    }

    $('#shReceipts').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      const lines = await api('shift:receipt', { receipt_no: b.dataset.r });
      modal({
        title: `Struk ${b.dataset.r}`,
        body: `<table class="receipt-lines">${lines.map((l) => `<tr><td>${esc(l.product_name)}</td><td class="r muted">${num(l.qty_sold)} × ${rp(l.unit_price)}</td><td class="r">${rp(l.line_total)}</td></tr>`).join('')}</table>
          <div class="kv total-line"><span>Total (${esc(lines[0]?.payment_method || '')})</span><span>${rp(lines.reduce((a, l) => a + l.line_total, 0))}</span></div>`,
        actions: [
          {
            label: 'Cetak Ulang Nota',
            kind: 'ghost',
            onClick: async () => {
              try { await api('receipt:reprint', { receipt_no: b.dataset.r }); toast('Nota dicetak ulang.', 'ok'); } catch (err) { toast(err.message, 'err', 8000); }
            },
          },
          { label: 'Tutup', kind: 'primary' },
        ],
      });
    });

    $('#shClose').addEventListener('click', async () => {
      if (views.checkout.hasItems()) { toast('Masih ada barang di keranjang kasir. Selesaikan atau kosongkan dulu.', 'err'); return; }
      const draftCount = (await api('drafts:list').catch(() => [])).length;
      const ok = await confirmDialog('Tutup Shift', `Tutup shift <b>${esc(sh.cashier_name)}</b> dengan omset <b>${rp(s.totals.revenue)}</b>?<br><br>
        Laporan akan dikirim ke email owner. Setelah email terkirim (250 OK), <b>seluruh data penjualan shift ini dihapus</b> dari komputer. Master barang dan stok tetap aman.
        ${draftCount ? `<br><br><span class="badge bs">Perhatian</span> Masih ada <b>${draftCount} draft penjualan</b> belum dibayar di komputer ini (tidak ikut dihitung di laporan).` : ''}`, { okLabel: 'Tutup Shift & Kirim' });
      if (!ok) return;
      const prog = modal({ title: 'Menutup Shift…', body: '<p>Membuat laporan PDF & CSV, lalu mengirim email ke owner. Mohon tunggu, jangan tutup aplikasi.</p>', dismissable: false });
      try {
        const r = await api('shift:close', { notes: $('#shNotes').value });
        prog.close();
        await refreshShift();
        modal({
          title: 'Shift Berhasil Ditutup',
          body: `<div class="alert ok">Laporan terkirim ke owner. Server email membalas: <code>${esc(r.response)}</code></div>
            <p>Omset ${rp(r.revenue)} dari ${num(r.receipts)} transaksi. Data penjualan shift sudah dibersihkan.</p>
            <p class="muted small">Salinan laporan tersimpan di${r.onServer ? ' <b>PC gudang</b>' : ''}:<br><code>${esc(r.dir)}</code></p>`,
          actions: [
            { label: 'Buka Folder', kind: 'ghost', onClick: () => api('app:openPath', { dir: r.dir }) },
            { label: 'Selesai', kind: 'primary', onClick: ({ close }) => { close(); show(); } },
          ],
        });
      } catch (e) {
        prog.close();
        modal({
          title: 'Tutup Shift Gagal',
          body: `<div class="alert danger">${esc(e.message)}</div><p>Data penjualan shift <b>tidak dihapus</b>. Periksa koneksi internet atau menu Pengaturan, lalu coba lagi.</p>`,
          actions: [{ label: 'Buka Pengaturan', kind: 'ghost', onClick: ({ close }) => { close(); go('settings'); } }, { label: 'Tutup', kind: 'primary' }],
        });
      }
    });
  }
  return { show };
})();

// ================================================================ Mode komputer (Mandiri / Server / Kasir)
const modeCard = (() => {
  let info = null;
  const LABEL = { standalone: 'Mandiri', server: 'Server (PC Gudang)', client: 'Kasir (terhubung ke PC Gudang)' };
  const selected = () => ($('input[name="mdMode"]:checked') || {}).value || 'standalone';

  function renderPanels() {
    const m = selected();
    $('#mdServer').classList.toggle('hidden', m !== 'server');
    $('#mdClient').classList.toggle('hidden', m !== 'client');
  }
  $('#mdModes').addEventListener('change', renderPanels);

  async function load() {
    info = await api('device:get');
    $$('input[name="mdMode"]').forEach((r) => { r.checked = r.value === info.mode; });
    $('#mdIps').textContent = info.addresses.join(' / ') || '(tidak ada jaringan)';
    $('#mdServerPort').value = info.server_port;
    $('#mdKey').textContent = info.server_pair_key || '(dibuat saat disimpan)';
    $('#mdHost').value = info.server_host || '';
    $('#mdPort').value = info.server_port;
    $('#mdPair').value = info.pair_key || '';
    $('#mdCurrent').textContent = `Mode saat ini: ${LABEL[info.mode]}`;
    $('#mdTestResult').textContent = '';
    renderPanels();
    // Cadangkan / pulihkan hanya di PC pemilik database
    ['#stBackup', '#stRestore', '#stOpenData', '#stOpenReports'].forEach((s) => { $(s).disabled = info.mode === 'client'; });
  }

  $('#mdNewKey').addEventListener('click', async () => {
    if (!(await confirmDialog('Buat Kode Baru', 'PC kasir yang sudah terhubung harus memasukkan kode baru. Lanjutkan?', { okLabel: 'Buat Kode Baru' }))) return;
    try { info = await api('device:newKey'); $('#mdKey').textContent = info.server_pair_key; toast('Kode pasangan baru dibuat.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  });

  $('#mdTest').addEventListener('click', async () => {
    const out = $('#mdTestResult');
    out.className = 'small muted';
    out.textContent = 'Menghubungi PC gudang…';
    try {
      const r = await api('device:test', { host: $('#mdHost').value, port: $('#mdPort').value, key: $('#mdPair').value });
      out.className = 'small diff-pos';
      out.textContent = `✓ Terhubung ke "${r.store_name}"`;
    } catch (e) {
      out.className = 'small diff-neg';
      out.textContent = e.message;
    }
  });

  $('#mdSave').addEventListener('click', async () => {
    const mode = selected();
    const msg = {
      standalone: 'Komputer ini akan bekerja sendiri dengan database lokal.',
      server: 'Komputer ini menjadi <b>PC Gudang (server)</b>. Biarkan aplikasi tetap terbuka agar PC kasir bisa terhubung.',
      client: 'Komputer ini menjadi <b>PC Kasir</b>. Semua data barang, stok, dan penjualan akan dibaca &amp; disimpan di PC gudang. Data lokal komputer ini tidak dipakai (tidak dihapus).',
    }[mode];
    if (!(await confirmDialog('Ganti Mode Komputer', `${msg}<br><br>Aplikasi akan dimulai ulang.`, { okLabel: 'Simpan & Mulai Ulang' }))) return;
    try {
      await api('device:save', {
        mode,
        host: $('#mdHost').value,
        port: mode === 'server' ? $('#mdServerPort').value : $('#mdPort').value,
        key: $('#mdPair').value,
      });
      toast('Tersimpan. Aplikasi dimulai ulang…', 'ok');
    } catch (e) { toast(e.message, 'err', 8000); }
  });

  return { load };
})();

// ================================================================ Pengguna & hak akses (Admin)
const usersCard = (() => {
  let list = [];

  async function load() {
    if (role() !== 'admin') return;
    try { list = await api('users:list'); } catch (e) { $('#usBody').innerHTML = `<tr><td colspan="5" class="empty-row">${esc(e.message)}</td></tr>`; return; }
    $('#usBody').innerHTML = list.map((u) => `<tr>
      <td><b>${esc(u.name)}</b>${state.user && u.id === state.user.id ? ' <span class="muted small">(Anda)</span>' : ''}</td>
      <td>${esc(ROLE_LABEL[u.role])}</td>
      <td>${u.active ? '<span class="badge floor ok">Aktif</span>' : '<span class="badge bs">Nonaktif</span>'}</td>
      <td class="muted">${fmtTime(u.created_at)}</td>
      <td><div class="btn-row"><button class="btn sm" data-uedit="${u.id}">Ubah</button><button class="btn sm danger" data-udel="${u.id}">Hapus</button></div></td></tr>`).join('');
  }

  function openForm(u) {
    modal({
      title: u ? `Ubah Pengguna — ${u.name}` : 'Tambah Pengguna',
      body: `<div class="field"><label>Nama</label><input id="usName" maxlength="40" value="${esc(u ? u.name : '')}"></div>
        <div class="field"><label>Peran</label><select id="usRole">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${(u ? u.role : 'kasir') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>PIN 6 digit${u ? ' <span class="muted">(kosongkan bila tidak diganti)</span>' : ''}</label><input id="usPin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>
        <label class="check"><input type="checkbox" id="usActive" ${!u || u.active ? 'checked' : ''}> Aktif (boleh login)</label>`,
      actions: [
        { label: 'Batal', kind: 'ghost' },
        {
          label: 'Simpan',
          kind: 'primary',
          onClick: async ({ close }) => {
            try {
              const saved = await api('users:save', { id: u ? u.id : undefined, name: $('#usName').value, role: $('#usRole').value, pin: $('#usPin').value, active: $('#usActive').checked });
              close();
              toast('Pengguna tersimpan.', 'ok');
              if (state.user && saved.id === state.user.id) { state.user = { id: saved.id, name: saved.name, role: saved.role }; refreshUserBadge(); }
              load();
            } catch (e) { toast(e.message, 'err', 6000); }
          },
        },
      ],
    });
  }

  $('#usAdd').addEventListener('click', () => openForm(null));
  $('#usBody').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-uedit]');
    const del = e.target.closest('[data-udel]');
    if (ed) openForm(list.find((u) => u.id === Number(ed.dataset.uedit)));
    if (del) {
      const u = list.find((x) => x.id === Number(del.dataset.udel));
      if (!(await confirmDialog('Hapus Pengguna', `Hapus akun <b>${esc(u.name)}</b> (${ROLE_LABEL[u.role]})?`, { okLabel: 'Hapus', danger: true }))) return;
      try { await api('users:delete', { id: u.id }); toast('Pengguna dihapus.', 'ok'); load(); } catch (err) { toast(err.message, 'err', 6000); }
    }
  });

  return { load };
})();

// Angka merah di menu Mutasi: jumlah barang yang display tokonya habis/minus (untuk Gudang & Admin)
async function refreshOutBadge(rows) {
  const btn = $('#nav [data-view="transfers"]');
  if (!btn || !canView('transfers')) return;
  if (!rows) rows = await api('stock:low', { limit: 200 }).catch(() => null);
  if (!rows) return;
  const n = rows.filter((p) => p.sold_out).length;
  let b = $('.nav-badge', btn);
  if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; btn.querySelector('kbd').before(b); }
  b.textContent = n;
  b.title = `${n} barang display tokonya habis/minus — lihat Saran Restock`;
  b.classList.toggle('hidden', !n);
}

// ================================================================ Login
function refreshUserBadge() {
  const b = $('#userBadge');
  if (!state.user) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.innerHTML = `<div><b>${esc(state.user.name)}</b><br><span class="role">${esc(ROLE_LABEL[state.user.role])}</span></div><button class="btn sm ghost" id="logoutBtn">Keluar</button>`;
  $('#logoutBtn').addEventListener('click', logout);
}

async function logout() {
  if (views.checkout.hasItems()) { toast('Masih ada barang di keranjang kasir. Selesaikan atau kosongkan dulu.', 'err'); return; }
  await api('auth:logout').catch(() => null);
  location.reload();
}

function applyRole() {
  $$('#nav .nav-btn, .sidebar-foot .nav-btn').forEach((b) => b.classList.toggle('hidden', !canView(b.dataset.view)));
  ['#pdAdd', '#pdImport', '#pdTemplate'].forEach((sel) => $(sel).classList.toggle('hidden', !canEditProducts()));
  refreshUserBadge();
}

// Versi DEMO: kotak penanda, reset data, dan daftar akun latihan di layar login
function setupDemo(demo) {
  document.body.classList.add('demo');
  $('#demoRibbon').classList.remove('hidden');
  $('#demoReset').addEventListener('click', async () => {
    if (views.checkout.hasItems()) { toast('Kosongkan keranjang kasir dulu.', 'err'); return; }
    if (!(await confirmDialog('Reset Data Demo', 'Semua data latihan (barang, stok, penjualan, akun) dikembalikan ke kondisi awal. Lanjutkan?', { okLabel: 'Reset', danger: true }))) return;
    try { await api('demo:reset'); toast('Data demo dikembalikan ke awal. Memuat ulang…', 'ok'); } catch (e) { toast(e.message, 'err', 6000); }
  });
  const box = $('#lgDemo');
  box.innerHTML = `<div class="demo-title"><b class="demo-tag">DEMO</b> Versi latihan: data contoh, email tidak dikirim. Nota &amp; label dicetak ke printer yang dipilih (nota bertanda DEMO).</div><b>Akun latihan</b> <span class="muted">(klik untuk mengisi)</span><table>${demo.accounts.map((a) => `<tr data-name="${esc(a.name)}" data-pin="${esc(a.pin)}">
    <td><b>${esc(a.name)}</b></td><td class="muted">${esc(ROLE_LABEL[a.role])}</td><td class="mono">PIN ${esc(a.pin)}</td></tr>`).join('')}</table>`;
  box.classList.remove('hidden');
  box.addEventListener('click', (e) => {
    const r = e.target.closest('[data-name]');
    if (!r) return;
    $('#lgName').value = r.dataset.name;
    $('#lgPin').value = r.dataset.pin;
    $('#lgBtn').focus();
  });
}

function showLogin(status) {
  const setup = status.needsSetup;
  $('#loginScreen').classList.remove('hidden');
  $('#lgSub').textContent = setup ? 'Belum ada akun. Buat akun ADMIN pertama.' : 'Masuk dengan nama & PIN';
  $('#lgPin2Wrap').classList.toggle('hidden', !setup);
  $('#lgBtn').textContent = setup ? 'Buat Akun Admin' : 'Masuk';
  const err = (m) => { $('#lgErr').textContent = m; $('#lgErr').classList.remove('hidden'); };
  let target = $('#lgPin');
  ['#lgPin', '#lgPin2'].forEach((sel) => {
    $(sel).addEventListener('focus', () => { target = $(sel); });
    $(sel).addEventListener('input', () => { $(sel).value = $(sel).value.replace(/\D/g, '').slice(0, 6); });
  });
  $('#lgPad').addEventListener('mousedown', (e) => e.preventDefault()); // fokus tetap di kolom PIN
  $('#lgPad').addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]');
    if (!k) return;
    const v = target.value;
    target.value = k.dataset.k === 'del' ? v.slice(0, -1) : k.dataset.k === 'clr' ? '' : (v + k.dataset.k).slice(0, 6);
  });
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const name = $('#lgName').value.trim();
    const pin = $('#lgPin').value;
    if (!name) { err('Isi nama.'); $('#lgName').focus(); return; }
    if (!/^\d{6}$/.test(pin)) { err('PIN harus 6 digit angka.'); $('#lgPin').focus(); return; }
    if (setup && pin !== $('#lgPin2').value) { err('Ulangi PIN tidak sama.'); $('#lgPin2').focus(); return; }
    busy = true;
    $('#lgBtn').disabled = true;
    try {
      await api(setup ? 'auth:setup' : 'auth:login', { name, pin });
      location.reload();
    } catch (e) {
      sound('err');
      err(e.message);
      $('#lgPin').value = '';
      $('#lgPin').focus();
    } finally {
      busy = false;
      $('#lgBtn').disabled = false;
    }
  };
  $('#lgBtn').addEventListener('click', submit);
  ['#lgName', '#lgPin', '#lgPin2'].forEach((sel) => $(sel).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (sel === '#lgName') $('#lgPin').focus(); else submit();
  }));
  setTimeout(() => $('#lgName').focus(), 30);
}

// Status koneksi ke PC gudang (mode kasir) / alamat server (mode server)
async function refreshConnection() {
  const s = await api('app:status').catch(() => null);
  const b = $('#connBadge');
  if (!s || s.mode === 'standalone') { b.classList.add('hidden'); state.connected = true; return; }
  b.classList.remove('hidden');
  state.connected = s.connected;
  state.emergency = s.emergency || null;
  const em = state.emergency;
  if (s.mode === 'server') {
    b.className = 'conn-badge on';
    b.innerHTML = `<b>Server aktif</b><br>${esc(s.addresses.join(' / ') || '-')} : ${s.port}`;
  } else if (s.connected && em && em.pending) {
    b.className = 'conn-badge syncing';
    b.innerHTML = `<b>Terhubung ke PC Gudang</b><br>Mengirim ${num(em.pending)} transaksi darurat…`;
  } else if (!s.connected && em && em.ready) {
    b.className = 'conn-badge emergency';
    b.innerHTML = `⚠ MODE DARURAT<br><span class="small">Terputus dari PC Gudang · ${num(em.pending)} transaksi antre</span>`;
  } else if (s.connected) {
    b.className = 'conn-badge on';
    b.innerHTML = `<b>Terhubung ke PC Gudang</b><br>${esc(s.server)}`;
  } else {
    b.className = 'conn-badge off';
    b.innerHTML = `⚠ Terputus dari PC Gudang<br><span class="small">${esc(s.server)}</span>`;
  }
  views.checkout.connectionChanged();
}

// ================================================================ 6. PENGATURAN
views.settings = (() => {
  const F = { store_name: '#stStoreName', store_address: '#stStoreAddress', smtp_host: '#stHost', smtp_port: '#stPort', smtp_security: '#stSecurity', smtp_user: '#stUser', smtp_from: '#stFrom', owner_email: '#stOwner',
    receipt_header: '#stHeader', receipt_footer: '#stFooter', printer_name: '#stPrinter', paper_width: '#stPaper' };

  async function loadPrinters(selected) {
    const list = await api('printer:list').catch(() => []);
    const opts = [`<option value="">Printer default Windows${list.find((p) => p.isDefault) ? ` (${esc(list.find((p) => p.isDefault).displayName)})` : ''}</option>`]
      .concat(list.map((p) => `<option value="${esc(p.name)}">${esc(p.displayName)}</option>`));
    // Printer tersimpan yang sedang tidak terpasang tetap ditampilkan
    if (selected && !list.some((p) => p.name === selected)) opts.push(`<option value="${esc(selected)}">${esc(selected)} (tidak terdeteksi)</option>`);
    $('#stPrinter').innerHTML = opts.join('');
  }

  let previewTimer;
  async function updatePreview() {
    const lines = await api('receipt:preview', {
      settings: { receipt_header: $('#stHeader').value, receipt_footer: $('#stFooter').value, paper_width: $('#stPaper').value, store_name: $('#stStoreName').value, store_address: $('#stStoreAddress').value },
    }).catch(() => null);
    if (lines) $('#stPreview').textContent = lines.join('\n');
  }
  ['#stHeader', '#stFooter', '#stPaper', '#stStoreName', '#stStoreAddress'].forEach((s) => $(s).addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 150);
  }));

  async function show() {
    modeCard.load();
    usersCard.load();
    const s = await api('settings:get');
    state.settings = s;
    await loadPrinters(s.printer_name);
    for (const [k, sel] of Object.entries(F)) $(sel).value = s[k] || '';
    $('#stAutoPrint').checked = s.auto_print !== '0';
    updatePreview();
    $('#stPass').value = '';
    $('#stPass').placeholder = s.has_smtp_pass ? '•••••••• (tersimpan — kosongkan jika tidak diubah)' : 'Password / App Password';
    const info = await api('app:info');
    $('#infoVersion').textContent = info.version;
    $('#infoDb').textContent = info.dbFile;
    $('#infoReports').textContent = info.reportsDir;
  }

  async function save(silent) {
    const d = {};
    for (const [k, sel] of Object.entries(F)) d[k] = $(sel).value;
    d.auto_print = $('#stAutoPrint').checked ? '1' : '0';
    if ($('#stPass').value) d.smtp_pass = $('#stPass').value;
    state.settings = await api('settings:save', d);
    $('#storeName').textContent = state.settings.store_name;
    $('#stPass').value = '';
    $('#stPass').placeholder = state.settings.has_smtp_pass ? '•••••••• (tersimpan — kosongkan jika tidak diubah)' : 'Password / App Password';
    if (!silent) toast('Pengaturan tersimpan.', 'ok');
  }

  $('#stSave').addEventListener('click', () => save(false).catch((e) => toast(e.message, 'err', 6000)));
  $('#stSave2').addEventListener('click', () => save(false).catch((e) => toast(e.message, 'err', 6000)));
  $('#stTestPrint').addEventListener('click', async () => {
    try {
      await save(true);
      await api('receipt:test');
      toast('Nota tes dikirim ke printer.', 'ok');
    } catch (e) { toast(e.message, 'err', 8000); }
  });
  $('#stSecurity').addEventListener('change', () => { $('#stPort').value = { ssl: 465, starttls: 587, none: 25 }[$('#stSecurity').value]; });
  $('#stTest').addEventListener('click', async () => {
    const btn = $('#stTest');
    btn.disabled = true;
    btn.textContent = 'Mengirim…';
    try {
      await save(true);
      const r = await api('settings:testEmail');
      toast(`Email tes terkirim ke ${state.settings.owner_email}. Balasan server: ${r.response}`, 'ok', 8000);
    } catch (e) { toast(e.message, 'err', 9000); }
    finally { btn.disabled = false; btn.textContent = 'Kirim Email Tes'; }
  });
  $('#stOpenReports').addEventListener('click', () => api('app:openReports'));
  $('#stOpenData').addEventListener('click', () => api('db:openFolder'));
  $('#stBackup').addEventListener('click', async () => {
    try { const f = await api('db:backup'); if (f) toast(`Database dicadangkan ke: ${f}`, 'ok', 8000); } catch (e) { toast(e.message, 'err', 8000); }
  });
  $('#stRestore').addEventListener('click', async () => {
    if (views.checkout.hasItems()) { toast('Kosongkan keranjang kasir dulu sebelum memulihkan data.', 'err'); return; }
    try {
      const r = await api('db:restore');
      if (r) toast(`Data dipulihkan: ${num(r.products)} barang. Memuat ulang…`, 'ok', 6000);
    } catch (e) { toast(e.message, 'err', 8000); }
  });

  return { show };
})();

// ================================================================ Start
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); });
$('.sidebar-foot [data-view]').addEventListener('click', () => go('settings'));

document.addEventListener('keydown', (e) => {
  if ($('#modalRoot').children.length) {
    // Enter pada modal struk = transaksi baru
    if (e.key === 'Enter' && !e.target.closest('input, textarea, select')) {
      const primary = $('#modalRoot .modal-foot .btn.primary');
      if (primary && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); primary.click(); }
    }
    return;
  }
  const keys = { F1: 'checkout', F3: 'transfers', F4: 'receiving', F5: 'products', F6: 'shift', F10: 'barcode' };
  if (keys[e.key]) { e.preventDefault(); go(keys[e.key]); return; }
  // F12 = isi Uang Diterima (Enter di kolom itu = Bayar). Pengaturan dibuka lewat tombol sidebar.
  if (e.key === 'F12') {
    e.preventDefault();
    if (!canView('checkout')) return;
    if (state.view !== 'checkout') go('checkout');
    views.checkout.focusCash();
    return;
  }
  if (state.view === 'checkout' && canView('checkout')) {
    if (e.key === 'F2') { e.preventDefault(); views.checkout.focusScan(); }
    if (e.key === 'F8') { e.preventDefault(); views.checkout.clearCart(); }
    if (e.key === 'F9') { e.preventDefault(); views.checkout.pay(); }
  }
});

function tick() {
  $('#clock').textContent = new Date().toLocaleString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

(async function init() {
  tick();
  setInterval(tick, 30000);
  let status = null;
  try {
    status = await api('auth:status');
    state.user = status.user;
    if (status.demo) setupDemo(status.demo);
  } catch (e) {
    toast(`Gagal memuat aplikasi: ${e.message}`, 'err', 10000);
  }
  if (!state.user) {
    refreshConnection();
    setInterval(refreshConnection, 10000);
    showLogin(status || { needsSetup: false });
    return;
  }
  applyRole();
  try {
    state.meta = await api('meta');
    state.settings = await api('settings:get');
    $('#storeName').textContent = state.settings.store_name;
    await refreshShift();
  } catch (e) {
    toast(`Gagal memuat aplikasi: ${e.message}`, 'err', 10000);
  }
  refreshConnection();
  setInterval(refreshConnection, 10000);
  refreshOutBadge();
  setInterval(() => refreshOutBadge(), 30000);
  go(ROLE_VIEWS[role()][0]);
}());
