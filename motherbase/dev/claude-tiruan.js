'use strict';
// Claude tiruan untuk server dev dan uji: meniru Messages API (/v1/messages) tanpa API key.
// Jawabannya berdasar aturan sederhana, bukan AI — hanya supaya alur aplikasi bisa dicoba:
// memanggil satu alat yang cocok dengan pertanyaan, lalu merangkum hasilnya.

let seq = 0;
const TGL = (d) => d.toISOString().slice(0, 10);

function pesanAkhir(body) {
  return body.messages[body.messages.length - 1];
}

function pilihAlat(teks, hariIni) {
  const t = teks.toLowerCase();
  const h = new Date(`${hariIni}T00:00:00Z`);
  const mundur = (n) => { const d = new Date(h); d.setUTCDate(d.getUTCDate() - n); return TGL(d); };
  const kode = (/\b(krp|mnk|sda|trp|mlg|bks|cld|dpk)\b/i.exec(teks) || [])[1];
  if (/wawancara|principal|lead time/.test(t)) return ['daftar_principal', {}];
  if (/stok lambat|tidak laku|dead/.test(t)) return ['stok_lambat', { hari: 30 }];
  if (/stok/.test(t)) return ['cari_stok', { cari: (/stok\s+(\w+)/.exec(t) || [])[1] || '' }];
  if (/naik|turun|tren/.test(t)) return ['tren_produk', { dari: mundur(6), sampai: hariIni, dari_banding: mundur(13), sampai_banding: mundur(7), ...(kode ? { kode_toko: kode.toUpperCase() } : {}) }];
  if (/beli|po\b|usulan/.test(t)) return ['usulan_beli', {}];
  if (/laris|terlaris|produk/.test(t)) return ['produk_terlaris', { dari: mundur(6), sampai: hariIni, ...(kode ? { kode_toko: kode.toUpperCase() } : {}) }];
  return ['ringkasan_penjualan', { dari: mundur(6), sampai: hariIni }];
}

function ringkas(nama, isi) {
  let data;
  try { data = JSON.parse(isi); } catch (_) { return isi; }
  if (data && data.error) return `Data tidak bisa diambil: ${data.error}`;
  const rows = Array.isArray(data) ? data : data.data || [];
  if (!rows.length) return 'Tidak ada data untuk pertanyaan ini.';
  const kolom = Object.keys(rows[0]).slice(0, 5);
  const tabel = [`| ${kolom.join(' | ')} |`, `| ${kolom.map(() => '---').join(' | ')} |`,
    ...rows.slice(0, 10).map((r) => `| ${kolom.map((k) => (r[k] === null ? '-' : String(r[k]))).join(' | ')} |`)].join('\n');
  return `Hasil dari alat **${nama}** (${rows.length} baris):\n\n${tabel}`;
}

function balas(body) {
  const akhir = pesanAkhir(body);
  const base = { id: `msg_tiruan_${++seq}`, type: 'message', role: 'assistant', model: body.model, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } };
  const thinking = { type: 'thinking', thinking: '', signature: 'tiruan' };
  if (Array.isArray(akhir.content) && akhir.content[0] && akhir.content[0].type === 'tool_result') {
    const sebelumnya = body.messages[body.messages.length - 2].content.find((b) => b.type === 'tool_use');
    const teks = `*(Claude tiruan untuk mencoba: asisten sungguhan aktif setelah API key Anthropic diisi.)*\n\n${ringkas(sebelumnya.name, akhir.content[0].content)}`;
    return { ...base, content: [thinking, { type: 'text', text: teks }], stop_reason: 'end_turn' };
  }
  const teks = typeof akhir.content === 'string' ? akhir.content : '';
  const hariIni = (/Tanggal hari ini: (\d{4}-\d{2}-\d{2})/.exec(teks) || [])[1] || TGL(new Date());
  const [name, input] = pilihAlat(teks.replace(/^\[Konteks\][^\n]*\n\n/, ''), hariIni);
  return { ...base, content: [thinking, { type: 'tool_use', id: `toolu_tiruan_${seq}`, name, input }], stop_reason: 'tool_use' };
}

async function fetchTiruan(url, init) {
  const body = JSON.parse(init.body);
  return new Response(JSON.stringify(balas(body)), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `req_tiruan_${seq}` } });
}

module.exports = { fetchTiruan };
