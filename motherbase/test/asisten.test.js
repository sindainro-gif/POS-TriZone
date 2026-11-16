'use strict';
// Uji inti asisten AI (supabase/functions/asisten/asisten.mjs) dengan SDK Anthropic asli dan
// Messages API tiruan (fetch palsu): bentuk permintaan, loop alat, penolakan, dan penyimpanan.
//   node motherbase/test/asisten.test.js
const assert = require('assert');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

let lulus = 0;
const ok = (n) => { lulus++; console.log('  ✓', n); };

// Messages API tiruan: setiap panggilan mengambil balasan berikutnya dari daftar skenario
function claudeTiruan(skenario) {
  const permintaan = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    permintaan.push({ url: String(url), body, headers });
    const langkah = skenario.shift();
    if (!langkah) throw new Error('Skenario habis');
    const isi = typeof langkah === 'function' ? langkah(body) : langkah;
    return new Response(JSON.stringify({ id: `msg_${permintaan.length}`, type: 'message', role: 'assistant', model: body.model,
      stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, ...isi }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { anthropic: new Anthropic({ apiKey: 'uji', fetch, maxRetries: 0 }), permintaan };
}

// Database tiruan: hanya mencatat panggilan
function dbTiruan({ peran = 'owner' } = {}) {
  const panggilan = [];
  const percakapan = new Map();
  let n = 0;
  return {
    panggilan, percakapan,
    rpc: async (fn, args) => {
      panggilan.push([fn, args]);
      if (fn === 'saya') return { id: 'u1', nama: 'Owner Uji', peran, kode_toko: null, aktif: true };
      if (fn === 'laporan_principal') return [{ id: 7, nama: 'PT Uji' }];
      if (fn === 'laporan_tren_produk') return [{ sku: 'A', nama: 'Barang A', qty_periode: 10, qty_banding: 4, selisih: 6, persen: 150 }];
      if (fn === 'simpan_data_principal') return { id: args.p_id, ...args.p };
      if (fn === 'laporan_stok_produk') return Array.from({ length: 400 }, (_, i) => ({ sku: `S${i}` }));
      throw new Error(`fungsi ${fn} tidak ada di tiruan`);
    },
    ambilPercakapan: async (id) => percakapan.get(id) || null,
    simpanPercakapan: async (row) => {
      const id = row.id || `p${++n}`;
      percakapan.set(id, { ...row, id });
      return { id };
    },
  };
}

(async () => {
  const { jalankanAsisten, ALAT, MODEL, riwayatTampil } = await import(path.join(__dirname, '..', 'supabase/functions/asisten/asisten.mjs'));

  // 1. Pertanyaan biasa: alat dipanggil, hasil dikembalikan, jawaban teks
  {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
    const { anthropic, permintaan } = claudeTiruan([
      { content: [thinking, { type: 'tool_use', id: 'tu_1', name: 'tren_produk', input: { dari: '2026-11-10', sampai: '2026-11-16', dari_banding: '2026-11-03', sampai_banding: '2026-11-09', kode_toko: 'trp' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'thinking', thinking: '', signature: 'sig-2' }, { type: 'text', text: 'Barang A naik 6 Biji (150%).' }], stop_reason: 'end_turn' },
    ]);
    const db = dbTiruan();
    const r = await jalankanAsisten({ anthropic, db, permintaan: { pesan: 'Produk apa yang naik minggu ini di TRP?' }, hariIni: '2026-11-16' });
    assert.strictEqual(r.jawaban, 'Barang A naik 6 Biji (150%).');
    assert.deepStrictEqual(r.alat.map((a) => a.nama), ['tren_produk']);
    const [p1, p2] = permintaan;
    assert.match(p1.url, /\/v1\/messages/);
    assert.strictEqual(p1.body.model, 'claude-opus-5-5');
    assert.strictEqual(MODEL, 'claude-opus-5-5');
    assert.strictEqual(p1.body.fallbacks, 'default');
    assert.match(p1.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.deepStrictEqual(p1.body.output_config, { effort: 'medium' });
    assert.deepStrictEqual(p1.body.cache_control, { type: 'ephemeral' });
    assert.strictEqual(p1.body.thinking, undefined, 'thinking tidak boleh diatur (selalu adaptif di Opus 5.5)');
    assert.strictEqual(p1.body.tool_choice, undefined);
    assert.deepStrictEqual(p1.body.tools.map((t) => t.name), ALAT.map((t) => t.name));
    assert.match(p1.body.messages[0].content, /^\[Konteks\] Tanggal hari ini: 2026-11-16 \(Senin\)/);
    // Hasil alat: kode toko dinormalkan, isi = JSON data
    assert.deepStrictEqual(db.panggilan.find(([f]) => f === 'laporan_tren_produk')[1].p_kode_toko, 'TRP');
    const tr = p2.body.messages[2].content[0];
    assert.strictEqual(tr.type, 'tool_result');
    assert.strictEqual(tr.tool_use_id, 'tu_1');
    assert.strictEqual(JSON.parse(tr.content)[0].sku, 'A');
    // Blok thinking dikembalikan apa adanya
    assert.deepStrictEqual(p2.body.messages[1].content[0], thinking);
    // Prefiks permintaan sama (cache): system & tools identik
    assert.strictEqual(JSON.stringify(p1.body.system), JSON.stringify(p2.body.system));
    assert.strictEqual(JSON.stringify(p1.body.tools), JSON.stringify(p2.body.tools));
    ok('permintaan ke Claude: Opus 5.5, fallback server-side default, effort medium, cache, alat tetap; hasil alat & thinking dikembalikan');

    // Giliran kedua di percakapan yang sama: riwayat lengkap dikirim ulang
    const { anthropic: a2, permintaan: q2 } = claudeTiruan([{ content: [{ type: 'text', text: 'Sama-sama.' }], stop_reason: 'end_turn' }]);
    const r2 = await jalankanAsisten({ anthropic: a2, db, permintaan: { pesan: 'Terima kasih', percakapan_id: r.percakapan_id }, hariIni: '2026-11-16' });
    assert.strictEqual(r2.percakapan_id, r.percakapan_id);
    assert.strictEqual(q2[0].body.messages.length, 5);
    assert.deepStrictEqual(q2[0].body.messages[3].content[0], { type: 'thinking', thinking: '', signature: 'sig-2' });
    const tampil = riwayatTampil(db.percakapan.get(r.percakapan_id).pesan);
    assert.deepStrictEqual(tampil.map((x) => x.dari), ['pengguna', 'asisten', 'pengguna', 'asisten']);
    assert.strictEqual(tampil[0].teks, 'Produk apa yang naik minggu ini di TRP?');
    ok('percakapan berlanjut: riwayat (termasuk blok thinking) disimpan dan dikirim ulang; tampilan tanpa konteks & blok alat');
  }

  // 2. Masukan alat tidak valid dan alat simpan di mode tanya → tool_result error, bukan exception
  {
    const { anthropic, permintaan } = claudeTiruan([
      { content: [
        { type: 'tool_use', id: 'a', name: 'ringkasan_penjualan', input: { dari: 'kemarin', sampai: '2026-11-16' } },
        { type: 'tool_use', id: 'b', name: 'simpan_principal', input: { principal_id: 7, lead_time_hari: 5 } },
        { type: 'tool_use', id: 'c', name: 'cari_stok', input: { cari: 'x' } },
      ], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Selesai.' }], stop_reason: 'end_turn' },
    ]);
    const db = dbTiruan();
    const r = await jalankanAsisten({ anthropic, db, permintaan: { pesan: 'tes' }, hariIni: '2026-11-16' });
    const hasil = permintaan[1].body.messages[2].content;
    assert.strictEqual(hasil.length, 3, 'semua tool_result dalam satu pesan user');
    assert.ok(hasil[0].is_error && /YYYY-MM-DD/.test(hasil[0].content));
    assert.ok(hasil[1].is_error && /wawancara/.test(hasil[1].content));
    assert.ok(!db.panggilan.some(([f]) => f === 'simpan_data_principal'));
    assert.ok(!hasil[2].is_error && /Hanya 150 dari 400 baris/.test(hasil[2].content));
    assert.deepStrictEqual(r.alat.map((a) => a.error), [true, true, false]);
    ok('masukan tidak valid & penyimpanan di mode tanya ditolak sebagai tool_result error; hasil besar dipotong 150 baris');
  }

  // 3. Mode wawancara: simpan_principal diteruskan ke database
  {
    const { anthropic, permintaan } = claudeTiruan([
      { content: [{ type: 'tool_use', id: 'w', name: 'simpan_principal', input: { principal_id: 7, lead_time_hari: 5, selesai_wawancara: true } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Tersimpan.' }], stop_reason: 'end_turn' },
    ]);
    const db = dbTiruan();
    const r = await jalankanAsisten({ anthropic, db, permintaan: { pesan: 'Lead time 5 hari', mode: 'wawancara', principal_id: 7 }, hariIni: '2026-11-16' });
    assert.deepStrictEqual(db.panggilan.find(([f]) => f === 'simpan_data_principal')[1], { p_id: 7, p: { lead_time_hari: 5, selesai_wawancara: true } });
    assert.match(permintaan[0].body.system, /mewawancarai owner/);
    assert.match(permintaan[0].body.messages[0].content, /Principal yang diwawancara: id 7, PT Uji/);
    assert.strictEqual(r.judul, 'Wawancara PT Uji');
    await assert.rejects(jalankanAsisten({ anthropic, db, permintaan: { pesan: 'x', mode: 'wawancara' } }), /Pilih principal/);
    ok('mode wawancara: prompt khusus, data principal disimpan lewat simpan_data_principal');
  }

  // 4. Penolakan (refusal), pause_turn, max_tokens
  {
    const { anthropic } = claudeTiruan([{ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }]);
    const r = await jalankanAsisten({ anthropic, db: dbTiruan(), permintaan: { pesan: 'x' } });
    assert.match(r.jawaban, /tidak bisa dijawab/);
    assert.strictEqual(r.berhenti, 'refusal');
    const { anthropic: a2, permintaan: q2 } = claudeTiruan([
      { content: [{ type: 'text', text: 'Sebentar…' }], stop_reason: 'pause_turn' },
      { content: [{ type: 'text', text: 'Panjang sekali' }], stop_reason: 'max_tokens' },
    ]);
    const r2 = await jalankanAsisten({ anthropic: a2, db: dbTiruan(), permintaan: { pesan: 'x' } });
    assert.strictEqual(q2.length, 2);
    assert.match(r2.jawaban, /terpotong/);
    ok('refusal dijawab sopan; pause_turn dilanjutkan; max_tokens ditandai terpotong');
  }

  // 5. Pengguna belum terdaftar & pesan kosong
  {
    const db = dbTiruan();
    db.rpc = async () => null;
    await assert.rejects(jalankanAsisten({ anthropic: claudeTiruan([]).anthropic, db, permintaan: { pesan: 'x' } }), (e) => e.status === 401);
    await assert.rejects(jalankanAsisten({ anthropic: claudeTiruan([]).anthropic, db: dbTiruan(), permintaan: { pesan: '  ' } }), (e) => e.status === 400);
    ok('pengguna yang belum terdaftar ditolak (401), pesan kosong ditolak (400)');
  }

  // 6. Kesalahan API Claude diteruskan sebagai kelas error SDK (dipetakan di index.ts)
  {
    const fetch = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'sibuk' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    const anthropic = new Anthropic({ apiKey: 'uji', fetch, maxRetries: 0 });
    await assert.rejects(jalankanAsisten({ anthropic, db: dbTiruan(), permintaan: { pesan: 'x' } }), (e) => e instanceof Anthropic.RateLimitError);
    ok('error 429 dari Claude muncul sebagai Anthropic.RateLimitError');
  }

  console.log(`\n${lulus} uji asisten lulus`);
})().catch((e) => { console.error('\n✗', e.stack || e.message); process.exit(1); });
