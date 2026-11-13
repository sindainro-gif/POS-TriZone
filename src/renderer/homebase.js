'use strict';
/* global window, document */
// Aplikasi Homebase: pusat data dari banyak toko. Data disimpan & diolah di proses utama (src/homebase-store.js);
// utilitas tampilan bersama ($, esc, api, toast, modal, badge zona, tema) ada di common.js.

const hb = { status: null, stores: [], store: '', view: 'dash', zones: {}, timer: null };

const pad = (n) => String(n).padStart(2, '0');
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const fmtDay = (s) => {
  if (!s) return '-';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d) ? s : d.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};
const zoneTag = (z) => `<span class="badge ${ZONE_CLASS[z] || 'ext'}">${esc(hb.zones[z] || z || '-')}</span>`;
const th = (h) => {
  const i = h.indexOf(':');
  return i > 0 && i < 3 ? `<th class="${h.slice(0, i)}">${esc(h.slice(i + 1))}</th>` : `<th>${esc(h)}</th>`;
};
const allStores = () => !hb.store;
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty-row">${text}</td></tr>`;
const signed = (n) => (n > 0 ? `<span class="diff-pos">+${num(n)}</span>` : n < 0 ? `<span class="diff-neg">−${num(-n)}</span>` : '<span class="muted">0</span>');

// Data terakhir lebih dari ~1 hari: tandai supaya owner tahu toko itu belum mengirim
function freshness(t) {
  if (!t) return '<span class="muted">-</span>';
  const ms = Date.now() - new Date(String(t).replace(' ', 'T')).getTime();
  return ms > 26 * 3600 * 1000 ? `${fmtTime(t)} <span class="badge floor low" title="Lebih dari sehari belum ada data baru">lama</span>` : fmtTime(t);
}

async function exportExcel(args, btn) {
  if (btn) btn.disabled = true;
  try {
    const file = await api('hb:export', { store_id: hb.store, ...args });
    if (file) toast(`Excel disimpan: ${file}`, 'ok', 7000);
  } catch (e) { toast(e.message, 'err', 8000); } finally { if (btn) btn.disabled = false; }
}

// ================================================================ Status, toko, navigasi
function applyStatus(st) {
  hb.status = st;
  hb.zones = st.zones || hb.zones;
  hb.stores = st.stores || [];
  const sel = $('#hbStore');
  if (hb.store && !hb.stores.some((s) => s.store_id === hb.store)) hb.store = '';
  sel.innerHTML = `<option value="">Semua toko (${num(hb.stores.length)})</option>${hb.stores.map((s) => `<option value="${esc(s.store_id)}">${esc(s.store_name)}</option>`).join('')}`;
  sel.value = hb.store;
  const b = $('#hbInbox');
  if (!st.inbox_dir) {
    b.className = 'conn-badge syncing';
    b.innerHTML = '<b>Folder masuk belum diatur</b><br><span class="small">Atur di Impor &amp; Pengaturan</span>';
  } else if (st.scan_error) {
    b.className = 'conn-badge off';
    b.innerHTML = `⚠ Folder masuk tidak terbaca<br><span class="small">${esc(st.scan_error)}</span>`;
  } else {
    b.className = 'conn-badge on';
    const ls = st.last_scan;
    b.innerHTML = `<b>Folder masuk aktif</b><br><span class="small">${ls ? `Diperiksa ${fmtTime(ls.at)}` : 'Menunggu pemeriksaan pertama'}</span>`;
  }
  $('#hbLockBtn').classList.toggle('hidden', !st.has_pin);
}

async function refreshStatus() {
  const st = await api('hb:status');
  if (st.locked) { showLock(); return null; }
  applyStatus(st);
  const imp = await api('hb:imports', { limit: 1 }).catch(() => null);
  if (imp) {
    const n = imp.unresolved;
    $('#navErr').classList.toggle('hidden', !n);
    $('#navErr').textContent = n;
  }
  return st;
}

const views = {};
function go(view) {
  if (!views[view]) return;
  hb.view = view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  views[view].show();
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); });
$('#hbStore').addEventListener('change', () => { hb.store = $('#hbStore').value; views[hb.view].show(); });

// ================================================================ 1. RINGKASAN
views.dash = (() => {
  async function show() {
    let d;
    try { d = await api('hb:dashboard', { store_id: hb.store }); } catch (e) { toast(e.message, 'err'); return; }
    const t = d.totals;
    $('#dashSub').textContent = `${allStores() ? `${num(t.stores)} toko` : (d.stores[0] || {}).store_name || '-'} · hari ini ${fmtDay(d.day)} · 7 hari sejak ${fmtDay(d.from_7d)}`;
    $('#dashStats').innerHTML = `
      <div class="stat hl"><div class="lbl">Omset hari ini</div><div class="val">${rp(t.rev_today)}</div><div class="sub">${num(t.receipts_today)} struk</div></div>
      <div class="stat"><div class="lbl">Omset 7 hari</div><div class="val">${rp(t.rev_7d)}</div></div>
      <div class="stat"><div class="lbl">Omset bulan ini</div><div class="val">${rp(t.rev_month)}</div></div>
      <div class="stat"><div class="lbl">Barang display menipis</div><div class="val">${num(t.low_stock)}</div><div class="sub">dari data stok terakhir</div></div>`;
    $('#dashBody').innerHTML = d.stores.length ? d.stores.map((s) => `<tr>
        <td><b>${esc(s.store_name)}</b><div class="psub mono">${esc(String(s.store_id).slice(0, 8))}</div></td>
        <td>${freshness(s.last_package_at)}</td>
        <td>${s.last_shift_at ? fmtTime(s.last_shift_at) : '<span class="muted">-</span>'}</td>
        <td class="c">${s.open_shifts ? '<span class="badge floor ok">Berjalan</span>' : '<span class="muted">-</span>'}</td>
        <td class="r"><b>${rp(s.rev_today)}</b><div class="psub">${num(s.receipts_today)} struk</div></td>
        <td class="r">${rp(s.rev_7d)}</td><td class="r">${rp(s.rev_month)}</td>
        <td class="r">${num(s.products)}</td>
        <td class="r">${s.low_stock ? `<span class="badge floor low">${num(s.low_stock)}</span>` : '0'}</td></tr>`).join('')
      : emptyRow(9, 'Belum ada data toko. Atur folder Google Drive di menu <b>Impor &amp; Pengaturan</b>, atau impor file paket dari email tutup shift.');
  }
  $('#dashRefresh').addEventListener('click', async () => { await refreshStatus(); show(); });
  return { show };
})();

// ================================================================ 2. PENJUALAN
views.sales = (() => {
  const from = $('#slFrom');
  const to = $('#slTo');
  const group = $('#slGroup');
  from.value = localDate(-29);
  to.value = localDate(0);
  let data = null;

  const HEAD = {
    day: ['Tanggal', 'Toko', 'r:Struk', 'r:Jumlah (Biji)', 'r:Omset'],
    shift: ['Toko', 'Kasir', 'Mulai', 'Tutup', 'c:Status', 'r:Struk', 'r:Biji', 'r:Omset', ''],
    item: ['SKU', 'Nama Barang', 'r:Toko', 'r:Struk', 'r:Jumlah (Biji)', 'r:Omset'],
    method: ['Metode Bayar', 'r:Struk', 'r:Jumlah (Biji)', 'r:Omset'],
    receipt: ['Waktu', 'Toko', 'No. Struk', 'Metode', 'r:Baris', 'r:Biji', 'r:Total', ''],
  };
  const shiftStatus = (s) => (!s.closed_at ? '<span class="badge floor low">Berjalan</span>'
    : s.legacy ? '<span class="badge wh" title="Dari laporan tutup shift lama">Riwayat lama</span>' : '<span class="badge floor ok">Tutup</span>');
  const ROW = {
    day: (r) => `<td>${fmtDay(r.day)}</td><td>${esc(r.store_name)}</td><td class="r">${num(r.receipts)}</td><td class="r">${num(r.qty)}</td><td class="r"><b>${rp(r.total)}</b></td>`,
    shift: (r) => `<td>${esc(r.store_name)}</td><td>${esc(r.cashier_name)}</td><td>${fmtTime(r.shift_start)}</td><td>${r.closed_at ? fmtTime(r.closed_at) : '-'}</td>
      <td class="c">${shiftStatus(r)}</td><td class="r">${num(r.receipts)}</td><td class="r">${num(r.qty)}</td><td class="r"><b>${rp(r.revenue)}</b></td>
      <td><button class="btn sm ghost" data-shift="${esc(r.shift_uid)}" data-store="${esc(r.store_id)}">Detail</button></td>`,
    item: (r) => `<td class="mono">${esc(r.sku)}</td><td>${esc(r.name)}</td><td class="r">${num(r.stores)}</td><td class="r">${num(r.receipts)}</td><td class="r">${num(r.qty)}</td><td class="r"><b>${rp(r.total)}</b></td>`,
    method: (r) => `<td>${esc(r.method)}</td><td class="r">${num(r.receipts)}</td><td class="r">${num(r.qty)}</td><td class="r"><b>${rp(r.total)}</b></td>`,
    receipt: (r) => `<td class="muted">${fmtTime(r.created_at)}</td><td>${esc(r.store_name)}</td><td class="mono"><b>${esc(r.receipt_no)}</b></td><td>${esc(r.payment_method)}</td>
      <td class="r">${num(r.lines)}</td><td class="r">${num(r.qty)}</td><td class="r"><b>${rp(r.total)}</b></td>
      <td><button class="btn sm ghost" data-receipt="${esc(r.receipt_no)}" data-shift="${esc(r.shift_uid)}" data-store="${esc(r.store_id)}">Detail</button></td>`,
  };

  async function show() {
    const g = group.value;
    try { data = await api('hb:sales', { store_id: hb.store, from: from.value, to: to.value, group: g }); } catch (e) { toast(e.message, 'err'); return; }
    const t = data.totals;
    $('#slTotals').innerHTML = `${fmtDay(data.from)} – ${fmtDay(data.to)} · ${num(t.receipts)} struk · ${num(t.qty)} Biji · Omset <b>${rp(t.total)}</b>`;
    $('#slHead').innerHTML = `<tr>${HEAD[g].map(th).join('')}</tr>`;
    $('#slBody').innerHTML = data.rows.length ? data.rows.map((r) => `<tr>${ROW[g](r)}</tr>`).join('')
      : emptyRow(HEAD[g].length, 'Tidak ada penjualan di rentang tanggal ini.');
  }
  [from, to, group].forEach((el) => el.addEventListener('change', show));

  $('#slBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.receipt) {
        const lines = await api('hb:receipt', { store_id: b.dataset.store, shift_uid: b.dataset.shift, receipt_no: b.dataset.receipt });
        const total = lines.reduce((s, l) => s + l.line_total, 0);
        modal({
          title: `Struk ${b.dataset.receipt}`,
          wide: true,
          body: `<div class="kv"><span>Toko</span><b>${esc(lines[0] ? lines[0].store_name : '-')}</b></div>
            <div class="kv"><span>Waktu</span><b>${fmtTime(lines[0] && lines[0].created_at)}</b></div>
            <div class="kv"><span>Metode bayar</span><b>${esc(lines[0] ? lines[0].payment_method : '-')}</b></div>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="r">No</th><th>SKU</th><th>Nama Barang</th><th class="r">Jumlah</th><th class="r">Harga</th><th class="r">Subtotal</th></tr></thead><tbody>
            ${lines.map((l) => `<tr><td class="r muted">${l.line_no}</td><td class="mono">${esc(l.sku)}</td><td>${esc(l.product_name)}</td><td class="r">${num(l.qty)}</td>
              <td class="r">${rp(l.unit_price)}</td><td class="r"><b>${rp(l.line_total)}</b></td></tr>`).join('')}
            </tbody></table></div><div class="kv total-line" style="margin-top:10px"><span>Total</span><b>${rp(total)}</b></div>`,
          actions: [{ label: 'Tutup', kind: 'primary' }],
        });
      } else if (b.dataset.shift) {
        const d = await api('hb:shift', { store_id: b.dataset.store, shift_uid: b.dataset.shift });
        const s = d.shift;
        modal({
          title: `Shift ${s.cashier_name} — ${s.store_name}`,
          wide: true,
          body: `<div class="kv"><span>Mulai</span><b>${fmtTime(s.shift_start)}</b></div>
            <div class="kv"><span>Tutup</span><b>${s.closed_at ? fmtTime(s.closed_at) : 'Masih berjalan'}</b></div>
            <div class="kv"><span>Transaksi</span><b>${num(s.receipts)} struk · ${num(s.qty)} Biji</b></div>
            <div class="kv"><span>Per metode</span><b>${s.by_method.map((m) => `${esc(m.method)} ${rp(m.total)}`).join(' · ') || '-'}</b></div>
            ${s.offline_receipts ? `<div class="kv"><span>Transaksi mode darurat</span><b>${num(s.offline_receipts)} struk</b></div>` : ''}
            ${s.notes ? `<div class="kv"><span>Catatan</span><b>${esc(s.notes)}</b></div>` : ''}
            <div class="kv total-line"><span>Omset</span><b>${rp(s.revenue)}</b></div>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>SKU</th><th>Nama Barang</th><th class="r">Jumlah (Biji)</th><th class="r">Total</th></tr></thead><tbody>
            ${d.items.map((i) => `<tr><td class="mono">${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="r">${num(i.qty)}</td><td class="r"><b>${rp(i.total)}</b></td></tr>`).join('')}
            </tbody></table></div>`,
          actions: [{ label: 'Tutup', kind: 'primary' }],
        });
      }
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#slExport').addEventListener('click', (e) => exportExcel({ kind: 'sales', group: group.value, from: from.value, to: to.value }, e.currentTarget));
  return { show };
})();

// ================================================================ 3. STOK
views.stock = (() => {
  let timer;
  async function show() {
    let d;
    try { d = await api('hb:stock', { store_id: hb.store, q: $('#skSearch').value, filter: $('#skFilter').value, limit: 5000 }); } catch (e) { toast(e.message, 'err'); return; }
    const all = allStores();
    $('#skHead').innerHTML = `<tr>${[...(all ? ['Toko'] : []), 'SKU', 'Nama Barang', 'r:Harga Jual', 'c:Display Toko', 'c:Gudang Utama', 'c:Gudang BS', 'c:Gudang Shopee', 'Per waktu'].map(th).join('')}</tr>`;
    $('#skBody').innerHTML = d.rows.length ? d.rows.map((p) => `<tr class="${p.floor_stock <= p.min_floor_alert ? 'low' : ''}">
        ${all ? `<td>${esc(p.store_name)}</td>` : ''}
        <td class="mono">${esc(p.sku)}</td>
        <td><div class="pname">${esc(p.name || '(barang tidak ditemukan)')}</div><div class="psub">${esc(p.barcode || '')} · ${esc(p.category || '-')} · min display ${num(p.min_floor_alert)}</div></td>
        <td class="r">${num(p.unit_price)}</td>
        <td class="c">${floorBadge(p)}</td><td class="c">${whBadge(p)}</td><td class="c">${bsBadge(p)}</td><td class="c">${shpBadge(p)}</td>
        <td class="muted small">${fmtTime(p.as_of)}</td></tr>`).join('')
      : emptyRow(all ? 9 : 8, 'Tidak ada barang yang cocok.');
    const t = d.totals;
    $('#skTotals').innerHTML = `${num(d.rows.length)} baris${d.rows.length >= 5000 ? ' (ditampilkan 5.000 pertama — ekspor Excel untuk semua)' : ''} · Display toko <b>${num(t.floor)}</b> · Gudang utama <b>${num(t.warehouse)}</b> · Gudang BS <b>${num(t.damaged)}</b> · Gudang Shopee <b>${num(t.shopee)}</b> Biji`;
  }
  $('#skSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 250); });
  $('#skFilter').addEventListener('change', show);
  $('#skExport').addEventListener('click', (e) => exportExcel({ kind: 'stock', q: $('#skSearch').value, filter: $('#skFilter').value }, e.currentTarget));
  return { show };
})();

// ================================================================ 4. DOKUMEN
views.docs = (() => {
  let type = 'receptions';
  let timer;
  const from = $('#dcFrom');
  const to = $('#dcTo');
  from.value = localDate(-89);
  to.value = localDate(0);
  const KEY = { receptions: 'reference_no', transfers: 'doc_no', opnames: 'doc_no' };
  const TITLE = { receptions: 'Penerimaan', transfers: 'Mutasi', opnames: 'Stok Opname' };
  const HEAD = {
    receptions: ['Waktu', 'Toko', 'No. Surat Jalan', 'Supplier', 'r:Baris', 'r:Total Biji', 'Catatan', ''],
    transfers: ['Waktu', 'Toko', 'No. Mutasi', 'Dari', '', 'Ke', 'r:Baris', 'r:Total Biji', 'Alasan', ''],
    opnames: ['Waktu', 'Toko', 'No. Opname', 'Zona', 'r:Baris', 'r:Lebih', 'r:Kurang', 'Catatan', ''],
  };
  const detailBtn = (d) => `<td><button class="btn sm ghost" data-key="${esc(d[KEY[type]])}" data-store="${esc(d.store_id)}">Detail</button></td>`;
  const ROW = {
    receptions: (d) => `<td class="muted">${fmtTime(d.received_at)}</td><td>${esc(d.store_name)}</td><td class="mono"><b>${esc(d.reference_no)}</b></td>
      <td>${esc(d.supplier_name || '-')}</td><td class="r">${num(d.lines)}</td><td class="r"><b>${num(d.total_items_count)}</b></td><td>${esc(d.notes || '-')}</td>${detailBtn(d)}`,
    transfers: (d) => `<td class="muted">${fmtTime(d.created_at)}</td><td>${esc(d.store_name)}</td><td class="mono"><b>${esc(d.doc_no)}</b></td>
      <td>${zoneTag(d.from_zone)}</td><td class="arrow">→</td><td>${zoneTag(d.to_zone)}</td><td class="r">${num(d.line_count)}</td><td class="r"><b>${num(d.total_qty)}</b></td>
      <td>${esc(d.reason || '-')}</td>${detailBtn(d)}`,
    opnames: (d) => `<td class="muted">${fmtTime(d.created_at)}</td><td>${esc(d.store_name)}</td><td class="mono"><b>${esc(d.doc_no)}</b></td><td>${zoneTag(d.zone)}</td>
      <td class="r">${num(d.line_count)}</td><td class="r">${signed(d.plus_qty)}</td><td class="r">${signed(-d.minus_qty)}</td><td>${esc(d.notes || '-')}</td>${detailBtn(d)}`,
  };

  async function show() {
    $$('#dcTabs [data-type]').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
    let d;
    try { d = await api('hb:docs', { type, store_id: hb.store, from: from.value, to: to.value, q: $('#dcSearch').value, limit: 3000 }); } catch (e) { toast(e.message, 'err'); return; }
    $('#dcHead').innerHTML = `<tr>${HEAD[type].map(th).join('')}</tr>`;
    $('#dcBody').innerHTML = d.rows.length ? d.rows.map((r) => `<tr>${ROW[type](r)}</tr>`).join('')
      : emptyRow(HEAD[type].length, `Tidak ada dokumen ${TITLE[type].toLowerCase()} di rentang tanggal ini.`);
    $('#dcTotals').innerHTML = `${fmtDay(d.from)} – ${fmtDay(d.to)} · <b>${num(d.rows.length)}</b> dokumen ${TITLE[type].toLowerCase()}${d.rows.length >= 3000 ? ' (ditampilkan 3.000 terbaru — ekspor Excel untuk semua)' : ''}`;
  }

  $('#dcTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { type = b.dataset.type; show(); } });
  [from, to].forEach((el) => el.addEventListener('change', show));
  $('#dcSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 250); });
  $('#dcExport').addEventListener('click', (e) => exportExcel({ kind: 'docs', type, from: from.value, to: to.value, q: $('#dcSearch').value }, e.currentTarget));

  $('#dcBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    let d;
    try { d = await api('hb:doc', { type, store_id: b.dataset.store, key: b.dataset.key }); } catch (err) { toast(err.message, 'err'); return; }
    const LINES = {
      receptions: [['r:No', 'SKU', 'Nama Barang', 'r:Jumlah (Biji)', 'Satuan input', 'Tujuan'],
        (i) => `<td class="r muted">${i.line_no}</td><td class="mono">${esc(i.sku)}</td><td>${esc(i.name || i.sku)}</td><td class="r"><b>${num(i.qty)}</b></td><td>${esc(i.pack_type)}</td><td>${zoneTag(i.destination)}</td>`],
      transfers: [['r:No', 'SKU', 'Nama Barang', 'r:Jumlah (Biji)'],
        (i) => `<td class="r muted">${i.line_no}</td><td class="mono">${esc(i.sku)}</td><td>${esc(i.name || i.sku)}</td><td class="r"><b>${num(i.qty)}</b></td>`],
      opnames: [['r:No', 'SKU', 'Nama Barang', 'r:Stok sistem', 'r:Fisik', 'r:Selisih'],
        (i) => `<td class="r muted">${i.line_no}</td><td class="mono">${esc(i.sku)}</td><td>${esc(i.name || i.sku)}</td><td class="r muted">${num(i.system_qty)}</td>
          <td class="r"><b>${num(i.counted_qty)}</b></td><td class="r">${signed(i.diff)}</td>`],
    };
    const INFO = {
      receptions: `<div class="kv"><span>Supplier</span><b>${esc(d.supplier_name || '-')}</b></div><div class="kv"><span>Total</span><b>${num(d.total_items_count)} Biji</b></div>`,
      transfers: `<div class="kv"><span>Arah</span><b>${zoneTag(d.from_zone)} → ${zoneTag(d.to_zone)}</b></div><div class="kv"><span>Alasan</span><b>${esc(d.reason || '-')}</b></div>`,
      opnames: `<div class="kv"><span>Zona</span><b>${zoneTag(d.zone)}</b></div><div class="kv"><span>Selisih</span><b>${signed(d.plus_qty)} / ${signed(-d.minus_qty)}</b></div>
        ${d.count_at ? `<div class="kv"><span>Tanggal stok di file</span><b>${fmtTime(d.count_at)}</b></div>` : ''}`,
    };
    const [head, row] = LINES[type];
    modal({
      title: `${TITLE[type]} ${d[KEY[type]]}`,
      wide: true,
      body: `<div class="kv"><span>Toko</span><b>${esc(d.store_name)}</b></div>
        <div class="kv"><span>Waktu</span><b>${fmtTime(d.received_at || d.created_at)}</b></div>${INFO[type]}
        ${d.notes ? `<div class="kv"><span>Catatan</span><b>${esc(d.notes)}</b></div>` : ''}
        <div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map(th).join('')}</tr></thead><tbody>${d.items.map((i) => `<tr>${row(i)}</tr>`).join('')}</tbody></table></div>`,
      actions: [{ label: 'Tutup', kind: 'primary' }],
    });
  });
  return { show };
})();

// ================================================================ 5. IMPOR & PENGATURAN
views.imports = (() => {
  const STATUS = {
    ok: '<span class="badge floor ok">Masuk</span>',
    old: '<span class="badge wh" title="Ada data yang lebih baru; hanya riwayat yang ditambahkan">Lama</span>',
    error: '<span class="badge bs">Gagal</span>',
    skip: '<span class="badge wh">Sudah ada</span>',
  };
  const KIND = { snapshot: 'Snapshot data', shift: 'Penjualan shift' };
  $('#exFrom').value = localDate(-29);
  $('#exTo').value = localDate(0);

  function summary(results) {
    const n = (s) => results.filter((r) => r.status === s).length;
    return `${num(n('ok') + n('old'))} paket diimpor${n('skip') ? `, ${num(n('skip'))} sudah ada` : ''}${n('error') ? `, ${num(n('error'))} gagal` : ''}.`;
  }

  async function show() {
    const st = await refreshStatus();
    if (!st) return;
    $('#imDir').value = st.inbox_dir || '';
    const ls = st.last_scan;
    $('#imScanInfo').innerHTML = !st.inbox_dir ? 'Folder belum diatur — paket hanya bisa diimpor manual.'
      : st.scan_error ? `<span class="diff-neg">${esc(st.scan_error)}</span>`
        : ls ? `Diperiksa ${fmtTime(ls.at)} · ${num(ls.files)} file paket di folder · ${num(ls.imported)} baru diimpor${ls.errors ? ` · <span class="diff-neg">${num(ls.errors)} gagal</span>` : ''}` : 'Menunggu pemeriksaan pertama…';
    $('#pinInfo').textContent = st.has_pin ? 'PIN aktif: Homebase meminta PIN setiap kali dibuka.' : 'Belum ada PIN: siapa pun yang membuka komputer ini bisa melihat data Homebase.';
    $('#pinRemove').classList.toggle('hidden', !st.has_pin);
    $('#pinSet').textContent = st.has_pin ? 'Ganti PIN…' : 'Atur PIN…';
    $('#infoVersion').textContent = st.version || '-';
    $('#infoDb').textContent = st.db_file;
    $('#stBody').innerHTML = hb.stores.length ? hb.stores.map((s) => `<tr>
        <td><b>${esc(s.store_name)}</b><div class="psub">${esc(s.store_address || '')}</div></td>
        <td class="mono small">${esc(s.store_id)}</td><td>${esc(s.app_version || '-')}</td>
        <td>${freshness(s.last_package_at)}</td><td class="muted">${fmtTime(s.last_snapshot_at)}</td><td class="muted">${fmtTime(s.last_shift_at)}</td>
        <td class="muted">${fmtTime(s.first_seen_at)}</td>
        <td><button class="btn sm danger" data-del="${esc(s.store_id)}" data-name="${esc(s.store_name)}">Hapus Data</button></td></tr>`).join('')
      : emptyRow(8, 'Belum ada toko.');
    const imp = await api('hb:imports', { limit: 300 });
    $('#imUnresolved').innerHTML = imp.unresolved ? `<span class="badge bs">${num(imp.unresolved)} file gagal</span>` : '<span class="muted small">Semua file berhasil dibaca</span>';
    $('#imBody').innerHTML = imp.rows.length ? imp.rows.map((r) => `<tr>
        <td class="muted">${fmtTime(r.imported_at)}</td><td class="file-name">${esc(r.file_name || '-')}</td>
        <td>${esc(r.store_name || '-')}</td><td>${esc(KIND[r.kind] || '-')}</td><td>${r.source === 'folder' ? 'Folder' : 'Manual'}</td>
        <td>${STATUS[r.status] || esc(r.status)}</td><td class="small">${esc(r.message || '')}</td></tr>`).join('')
      : emptyRow(7, 'Belum ada file yang diimpor.');
  }

  $('#imPick').addEventListener('click', async () => {
    try {
      const r = await api('hb:pickInbox');
      if (!r) return;
      toast(`Folder masuk disimpan. ${r.scan && !r.scan.error ? summary(r.scan.results) : ''}`, 'ok', 6000);
      show();
    } catch (e) { toast(e.message, 'err', 8000); }
  });
  $('#imClear').addEventListener('click', async () => {
    if (!hb.status || !hb.status.inbox_dir) return;
    if (!(await confirmDialog('Kosongkan Folder Masuk', 'Homebase berhenti memeriksa folder Google Drive. Data yang sudah diimpor tetap tersimpan.', { okLabel: 'Kosongkan' }))) return;
    try { await api('hb:setInbox', { dir: '' }); show(); } catch (e) { toast(e.message, 'err'); }
  });
  $('#imScan').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { const r = await api('hb:scan'); toast(summary(r.results), r.errors ? 'err' : 'ok', 6000); show(); } catch (err) { toast(err.message, 'err', 8000); } finally { btn.disabled = false; }
  });
  $('#imFiles').addEventListener('click', async () => {
    try {
      const results = await api('hb:importFiles');
      if (!results) return;
      modal({
        title: 'Hasil Impor File',
        wide: true,
        body: `<p>${summary(results)}</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>File</th><th>Toko</th><th>Status</th><th>Keterangan</th></tr></thead><tbody>
          ${results.map((r) => `<tr><td class="file-name">${esc(r.file_name)}</td><td>${esc(r.store_name || '-')}</td><td>${STATUS[r.status] || esc(r.status)}</td><td class="small">${esc(r.message || '')}</td></tr>`).join('')}
          </tbody></table></div>`,
        actions: [{ label: 'Tutup', kind: 'primary' }],
      });
      show();
    } catch (e) { toast(e.message, 'err', 8000); }
  });
  $('#stBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!(await confirmDialog('Hapus Data Toko',
      `Hapus semua data <b>${esc(b.dataset.name)}</b> dari Homebase (penjualan, stok, dokumen)? Data di toko tidak terpengaruh.
       <br><br>File paket lama tidak diimpor ulang otomatis; paket baru dari toko ini akan diterima lagi.`, { okLabel: 'Hapus Data', danger: true }))) return;
    try { await api('hb:deleteStore', { store_id: b.dataset.del }); toast('Data toko dihapus dari Homebase.', 'ok'); show(); } catch (err) { toast(err.message, 'err'); }
  });
  $('#exAll').addEventListener('click', (e) => exportExcel({ kind: 'all', from: $('#exFrom').value, to: $('#exTo').value }, e.currentTarget));
  $('#exBackup').addEventListener('click', async () => {
    try { const f = await api('hb:backup'); if (f) toast(`Homebase dicadangkan ke: ${f}`, 'ok', 8000); } catch (e) { toast(e.message, 'err', 8000); }
  });
  $('#exOpen').addEventListener('click', () => api('hb:openData'));
  $('#pinSet').addEventListener('click', () => {
    modal({
      title: hb.status && hb.status.has_pin ? 'Ganti PIN Homebase' : 'Atur PIN Homebase',
      body: `<div class="field"><label>PIN baru (6 digit angka)</label><input id="pnA" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>
        <div class="field"><label>Ulangi PIN</label><input id="pnB" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>`,
      actions: [
        { label: 'Batal', kind: 'ghost' },
        {
          label: 'Simpan PIN',
          kind: 'primary',
          onClick: async ({ close, el }) => {
            const a = $('#pnA', el).value;
            if (a !== $('#pnB', el).value) { toast('PIN tidak sama.', 'err'); return; }
            try { applyStatus(await api('hb:setPin', { pin: a })); toast('PIN disimpan.', 'ok'); close(); show(); } catch (e) { toast(e.message, 'err'); }
          },
        },
      ],
    });
  });
  $('#pinRemove').addEventListener('click', async () => {
    if (!(await confirmDialog('Hapus PIN', 'Homebase bisa dibuka tanpa PIN di komputer ini.', { okLabel: 'Hapus PIN', danger: true }))) return;
    try { applyStatus(await api('hb:setPin', { pin: '' })); show(); } catch (e) { toast(e.message, 'err'); }
  });
  return { show };
})();

// ================================================================ Kunci PIN
function showLock() {
  $('#lockScreen').classList.remove('hidden');
  $('#lkErr').textContent = '';
  $('#lkPin').value = '';
  setTimeout(() => $('#lkPin').focus(), 30);
}
async function unlock() {
  try {
    const st = await api('hb:unlock', { pin: $('#lkPin').value });
    $('#lockScreen').classList.add('hidden');
    start(st);
  } catch (e) {
    $('#lkErr').textContent = e.message;
    $('#lkPin').select();
  }
}
$('#lkBtn').addEventListener('click', unlock);
$('#lkPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
$('#hbLockBtn').addEventListener('click', async () => {
  const st = await api('hb:lock');
  if (st.locked) showLock();
});

// ================================================================ Mulai
function tick() {
  $('#clock').textContent = new Date().toLocaleString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function start(st) {
  applyStatus(st);
  go(hb.view);
  refreshStatus().catch(() => {});
  if (!hb.timer) {
    // Folder masuk diperiksa otomatis di proses utama; tampilan ringkasan & impor ikut diperbarui
    hb.timer = setInterval(async () => {
      if (!$('#lockScreen').classList.contains('hidden') || $('#modalRoot').children.length) return;
      try {
        if (!(await refreshStatus())) return;
        if (hb.view === 'dash' || hb.view === 'imports') views[hb.view].show();
      } catch (_) { /* dicoba lagi */ }
    }, 30000);
  }
}

(async function init() {
  tick();
  setInterval(tick, 30000);
  try {
    const st = await api('hb:status');
    hb.zones = st.zones || {};
    if (st.locked) showLock();
    else start(st);
  } catch (e) {
    toast(`Gagal memuat Homebase: ${e.message}`, 'err', 10000);
  }
}());
