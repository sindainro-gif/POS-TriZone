// Asisten AI mother base — inti yang dipakai bersama oleh Edge Function Supabase (index.ts, Deno)
// dan server pengembangan (dev/server.js, Node).
//
// Claude hanya membaca data lewat fungsi laporan di database yang dipanggil dengan token
// pengguna yang login, jadi Row Level Security tetap berlaku (pemilik toko hanya melihat tokonya).
// Satu-satunya alat yang menulis adalah simpan_principal (wawancara principal), dan itu pun
// hanya berhasil untuk pengguna kantor.
//
// Angka dihitung database; Claude menjelaskan, merangkum, dan mengusulkan. Owner yang memutuskan.

export const MODEL = 'claude-opus-5-5';
const MAX_PUTARAN = 8;
const MAX_BARIS_HASIL = 150;
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const tanggal = { type: 'string', description: 'Tanggal YYYY-MM-DD' };
const kodeToko = { type: 'string', description: 'Kode toko 3 huruf (mis. KRP). Kosongkan untuk semua toko yang boleh dilihat.' };
const batas = { type: 'integer', description: 'Jumlah baris maksimum' };

// Definisi alat (urutan tetap supaya prompt caching stabil)
export const ALAT = [
  {
    name: 'daftar_toko',
    description: 'Daftar toko beserta kode, kota, dan kapan terakhir mengirim data / menutup shift. Pakai untuk menerjemahkan nama atau nomor toko ke kode toko.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ringkasan_penjualan',
    description: 'Omzet, jumlah transaksi, qty, dan omzet per metode bayar (tunai, QRIS, transfer) per toko untuk rentang tanggal.',
    input_schema: { type: 'object', properties: { dari: tanggal, sampai: tanggal }, required: ['dari', 'sampai'], additionalProperties: false },
  },
  {
    name: 'penjualan_harian',
    description: 'Omzet dan jumlah transaksi per hari untuk rentang tanggal, semua toko atau satu toko.',
    input_schema: { type: 'object', properties: { dari: tanggal, sampai: tanggal, kode_toko: kodeToko }, required: ['dari', 'sampai'], additionalProperties: false },
  },
  {
    name: 'produk_terlaris',
    description: 'Produk paling laku untuk rentang tanggal, diurutkan berdasarkan nilai rupiah atau qty.',
    input_schema: {
      type: 'object',
      properties: { dari: tanggal, sampai: tanggal, kode_toko: kodeToko, urut: { type: 'string', enum: ['nilai', 'qty'] }, batas },
      required: ['dari', 'sampai'], additionalProperties: false,
    },
  },
  {
    name: 'tren_produk',
    description: 'Bandingkan qty terjual per produk antara periode utama dan periode pembanding (mis. minggu ini vs minggu lalu). Hasil diurutkan dari perubahan terbesar; selisih positif = naik.',
    input_schema: {
      type: 'object',
      properties: { dari: tanggal, sampai: tanggal, dari_banding: tanggal, sampai_banding: tanggal, kode_toko: kodeToko, batas },
      required: ['dari', 'sampai', 'dari_banding', 'sampai_banding'], additionalProperties: false,
    },
  },
  {
    name: 'analisa_abc',
    description: 'Analisa ABC: kelas A = produk penyumbang 80% omzet pertama, B = 15% berikutnya, C = sisanya.',
    input_schema: { type: 'object', properties: { dari: tanggal, sampai: tanggal, kode_toko: kodeToko }, required: ['dari', 'sampai'], additionalProperties: false },
  },
  {
    name: 'cari_stok',
    description: 'Stok terkini per toko dan zona (display, gudang utama, BS, Shopee) untuk produk yang namanya / SKU-nya cocok.',
    input_schema: { type: 'object', properties: { cari: { type: 'string' }, kode_toko: kodeToko, batas }, additionalProperties: false },
  },
  {
    name: 'stok_lambat',
    description: 'Produk yang masih ada stoknya tetapi tidak terjual dalam N hari terakhir (slow / dead stock).',
    input_schema: { type: 'object', properties: { hari: { type: 'integer' }, kode_toko: kodeToko, batas }, additionalProperties: false },
  },
  {
    name: 'usulan_beli',
    description: 'Usulan beli ke principal yang dihitung database, dengan rata-rata jual harian, lead time, stok gudang, stok toko, PO belum datang, dan qty usulan.',
    input_schema: { type: 'object', properties: { principal_id: { type: 'integer' } }, additionalProperties: false },
  },
  {
    name: 'status_surat_jalan',
    description: 'Status pencocokan surat jalan kantor dengan penerimaan toko. Status: COCOK, MENUNGGU, BELUM_DIINPUT, SELISIH_QTY, BARANG_SALAH, SATUAN_BELUM_JELAS, PELANGGAN_BELUM_DIPETAKAN.',
    input_schema: { type: 'object', properties: { status: { type: 'string' }, kode_toko: kodeToko, batas }, additionalProperties: false },
  },
  {
    name: 'selisih_stok_opname',
    description: 'Selisih stok opname per produk beserta nilai rupiahnya. Status review: BARU, DISETUJUI, DITOLAK.',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['BARU', 'DISETUJUI', 'DITOLAK'] }, kode_toko: kodeToko, batas }, additionalProperties: false },
  },
  {
    name: 'daftar_principal',
    description: 'Daftar principal dengan lead time perkiraan dan aktual, periode & jadwal order, minimum order, stok pengaman, catatan promo, dan kapan terakhir diwawancara.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'simpan_principal',
    description: 'Simpan data principal yang sudah DIKONFIRMASI owner dalam percakapan ini. Isi hanya field yang disebut owner. Jangan menebak angka. Set selesai_wawancara true setelah semua data principal itu terkumpul.',
    input_schema: {
      type: 'object',
      properties: {
        principal_id: { type: 'integer' },
        lead_time_hari: { type: 'integer', description: 'Hari dari PO sampai barang tiba' },
        periode_order_hari: { type: 'integer', description: 'Jarak antar-order dalam hari, mis. 7 = mingguan' },
        jadwal_order: { type: 'string', description: 'Mis. "tiap Senin" atau "tanggal 1 dan 15"' },
        minimum_order_qty: { type: 'integer', description: 'Minimum order dalam Biji' },
        minimum_order_rp: { type: 'number' },
        stok_pengaman_hari: { type: 'integer' },
        catatan_promo: { type: 'string' },
        selesai_wawancara: { type: 'boolean' },
      },
      required: ['principal_id'], additionalProperties: false,
    },
  },
];

// Alat → fungsi database (argumen p_*)
const KE_RPC = {
  daftar_toko: () => ['status_koneksi_toko', {}],
  ringkasan_penjualan: (a) => ['laporan_ringkasan', { p_dari: a.dari, p_sampai: a.sampai }],
  penjualan_harian: (a) => ['laporan_harian', { p_dari: a.dari, p_sampai: a.sampai, p_kode_toko: a.kode_toko || null }],
  produk_terlaris: (a) => ['laporan_penjualan_produk', { p_dari: a.dari, p_sampai: a.sampai, p_kode_toko: a.kode_toko || null, p_urut: a.urut || 'nilai', p_batas: a.batas || 20 }],
  tren_produk: (a) => ['laporan_tren_produk', {
    p_dari: a.dari, p_sampai: a.sampai, p_dari_banding: a.dari_banding, p_sampai_banding: a.sampai_banding,
    p_kode_toko: a.kode_toko || null, p_batas: a.batas || 20,
  }],
  analisa_abc: (a) => ['laporan_abc', { p_dari: a.dari, p_sampai: a.sampai, p_kode_toko: a.kode_toko || null }],
  cari_stok: (a) => ['laporan_stok_produk', { p_cari: a.cari || null, p_kode_toko: a.kode_toko || null, p_batas: a.batas || 50 }],
  stok_lambat: (a) => ['laporan_stok_lambat', { p_hari: a.hari || 30, p_kode_toko: a.kode_toko || null, p_batas: a.batas || 50 }],
  usulan_beli: (a) => ['laporan_usulan_beli', { p_principal_id: a.principal_id || null }],
  status_surat_jalan: (a) => ['laporan_status_sj', { p_status: a.status || null, p_kode_toko: a.kode_toko || null, p_batas: a.batas || 50 }],
  selisih_stok_opname: (a) => ['laporan_selisih_so', { p_status: a.status || 'BARU', p_kode_toko: a.kode_toko || null, p_batas: a.batas || 50 }],
  daftar_principal: () => ['laporan_principal', {}],
  simpan_principal: (a) => {
    const { principal_id, ...data } = a;
    return ['simpan_data_principal', { p_id: principal_id, p: data }];
  },
};

const TGL_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validasi ringan masukan alat (skema JSON tidak dipaksakan server karena strict tidak dipakai)
function periksaMasukan(alat, input) {
  const def = ALAT.find((t) => t.name === alat);
  if (!def) return `Alat ${alat} tidak dikenal.`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Masukan harus berupa objek.';
  const props = def.input_schema.properties;
  for (const k of def.input_schema.required || []) if (input[k] === undefined || input[k] === null || input[k] === '') return `Field ${k} wajib diisi.`;
  for (const [k, v] of Object.entries(input)) {
    const p = props[k];
    if (!p) return `Field ${k} tidak dikenal.`;
    if (v === null) continue;
    if (p.type === 'integer' && !Number.isInteger(v)) return `Field ${k} harus bilangan bulat.`;
    if (p.type === 'number' && typeof v !== 'number') return `Field ${k} harus angka.`;
    if (p.type === 'string' && typeof v !== 'string') return `Field ${k} harus teks.`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `Field ${k} harus true/false.`;
    if (p.enum && !p.enum.includes(v)) return `Field ${k} harus salah satu dari ${p.enum.join(', ')}.`;
    if (p === tanggal && !TGL_RE.test(v)) return `Field ${k} harus berformat YYYY-MM-DD.`;
    if (p === kodeToko && v && !/^[A-Za-z]{3}$/.test(v)) return `Field ${k} harus kode toko 3 huruf.`;
  }
  return null;
}

async function jalankanAlat(db, nama, input) {
  const salah = periksaMasukan(nama, input);
  if (salah) return { isi: JSON.stringify({ error: salah }), error: true };
  const masukan = { ...input };
  if (masukan.kode_toko) masukan.kode_toko = masukan.kode_toko.toUpperCase();
  const [fn, args] = KE_RPC[nama](masukan);
  try {
    let data = await db.rpc(fn, args);
    let catatan;
    if (Array.isArray(data) && data.length > MAX_BARIS_HASIL) {
      catatan = `Hanya ${MAX_BARIS_HASIL} dari ${data.length} baris ditampilkan.`;
      data = data.slice(0, MAX_BARIS_HASIL);
    }
    return { isi: JSON.stringify(catatan ? { catatan, data } : data), error: false };
  } catch (err) {
    return { isi: JSON.stringify({ error: String(err && err.message || err) }), error: true };
  }
}

const SISTEM_TANYA = `Anda asisten data untuk owner dan staf kantor sebuah perusahaan distribusi yang memasok beberapa toko ritel (POS Trizone). Jawab dalam Bahasa Indonesia yang singkat dan jelas.

Aturan:
- Semua angka harus berasal dari alat. Jangan menebak atau mengarang angka. Bila data tidak ada atau alat mengembalikan error, katakan apa adanya.
- Untuk "minggu ini", "bulan lalu", dan sejenisnya, hitung tanggalnya dari tanggal hari ini yang diberikan di pesan pengguna. Minggu dimulai hari Senin.
- Bila pengguna menyebut toko dengan nama atau nomor, pakai daftar_toko untuk mencari kodenya. Bila tetap tidak jelas, tanyakan.
- Tulis rupiah dengan format Rp 1.234.567 dan jumlah barang dalam Biji.
- Tampilkan daftar lebih dari 3 baris sebagai tabel Markdown sederhana. Sebutkan rentang tanggal yang dipakai.
- Anda boleh menjelaskan, membandingkan, dan menyarankan tindakan, tetapi keputusan (pembelian, persetujuan PO, persetujuan stok opname) tetap di tangan owner.
- Jangan mengubah data. Alat simpan_principal hanya untuk wawancara principal yang diminta pengguna.`;

const SISTEM_WAWANCARA = `Anda mewawancarai owner sebuah perusahaan distribusi untuk melengkapi data satu principal (pemasok) di sistem mother base. Bahasa Indonesia, ramah, dan singkat.

Data yang perlu dikumpulkan:
1. Lead time: berapa hari dari PO dikirim sampai barang tiba di gudang.
2. Periode order: berapa hari sekali order (mis. 7 = mingguan) dan jadwalnya (mis. tiap Senin).
3. Minimum order: dalam Biji dan/atau rupiah.
4. Stok pengaman: berapa hari penjualan yang ingin disimpan sebagai cadangan.
5. Promo atau catatan khusus (diskon periodik, musim ramai, barang sering kosong).

Cara kerja:
- Mulai dengan daftar_principal untuk melihat data yang sudah ada, lalu tanyakan yang masih kosong atau perlu dikonfirmasi. Bila ada lead time aktual dari PO sebelumnya, sebutkan dan minta owner membandingkan.
- Tanyakan satu atau dua hal per pesan.
- Setelah owner menjawab, ulangi singkat apa yang Anda tangkap. Simpan dengan simpan_principal hanya angka yang disebut owner dengan jelas. Jangan menebak.
- Setelah semua butir terjawab, simpan dengan selesai_wawancara = true, lalu ringkas data akhirnya.`;

function konteks(pengguna, hariIni, principal) {
  const d = new Date(`${hariIni}T00:00:00Z`);
  const baris = [`[Konteks] Tanggal hari ini: ${hariIni} (${HARI[d.getUTCDay()]}). Pengguna: ${pengguna.nama} (${pengguna.peran}${pengguna.kode_toko ? `, toko ${pengguna.kode_toko}` : ''}).`];
  if (principal) baris.push(`Principal yang diwawancara: id ${principal.id}, ${principal.nama}.`);
  return baris.join(' ');
}

function teksDari(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

const hariIniWib = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

/**
 * Satu giliran percakapan.
 * permintaan = { pesan, percakapan_id?, mode?: 'tanya' | 'wawancara', principal_id? }
 * db = { rpc(fn, args), ambilPercakapan(id), simpanPercakapan(row) } — lihat dbDariSupabase.
 * Hasil: { percakapan_id, jawaban, alat: [{ nama, masukan, error }], berhenti }
 */
export async function jalankanAsisten({ anthropic, db, permintaan, hariIni = hariIniWib() }) {
  const pesan = String(permintaan && permintaan.pesan || '').trim();
  if (!pesan) throw Object.assign(new Error('Pesan kosong'), { status: 400 });
  if (pesan.length > 4000) throw Object.assign(new Error('Pesan terlalu panjang (maks. 4.000 karakter)'), { status: 400 });
  const pengguna = await db.rpc('saya', {});
  if (!pengguna || !pengguna.aktif) throw Object.assign(new Error('Akun belum terdaftar sebagai pengguna mother base'), { status: 401 });

  let percakapan = permintaan.percakapan_id ? await db.ambilPercakapan(permintaan.percakapan_id) : null;
  if (permintaan.percakapan_id && !percakapan) throw Object.assign(new Error('Percakapan tidak ditemukan'), { status: 404 });
  const mode = percakapan ? percakapan.mode : permintaan.mode === 'wawancara' ? 'wawancara' : 'tanya';
  const principalId = percakapan ? percakapan.principal_id : permintaan.principal_id || null;
  if (mode === 'wawancara' && !principalId) throw Object.assign(new Error('Pilih principal untuk wawancara'), { status: 400 });
  let principal = null;
  if (mode === 'wawancara') {
    principal = (await db.rpc('laporan_principal', {})).find((p) => Number(p.id) === Number(principalId));
    if (!principal) throw Object.assign(new Error('Principal tidak ditemukan'), { status: 404 });
  }

  const messages = percakapan ? [...percakapan.pesan] : [];
  const awalBaru = messages.length;
  messages.push({ role: 'user', content: `${konteks(pengguna, hariIni, principal)}\n\n${pesan}` });

  const dipakai = [];
  let berhenti = null;
  let jawaban = '';
  for (let putaran = 0; putaran < MAX_PUTARAN; putaran++) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: mode === 'wawancara' ? SISTEM_WAWANCARA : SISTEM_TANYA,
      tools: ALAT,
      messages,
    });
    berhenti = response.stop_reason;
    // Seluruh isi dikembalikan apa adanya (termasuk blok thinking & fallback) di giliran berikutnya
    messages.push({ role: 'assistant', content: response.content });

    if (berhenti === 'refusal') {
      jawaban = 'Maaf, permintaan ini tidak bisa dijawab oleh asisten.';
      break;
    }
    if (berhenti === 'pause_turn') continue;
    if (berhenti !== 'tool_use') {
      jawaban = teksDari(response.content);
      if (berhenti === 'max_tokens') jawaban += '\n\n_(Jawaban terpotong karena terlalu panjang.)_';
      break;
    }
    const hasil = [];
    for (const blok of response.content) {
      if (blok.type !== 'tool_use') continue;
      if (blok.name === 'simpan_principal' && mode !== 'wawancara') {
        hasil.push({ type: 'tool_result', tool_use_id: blok.id, is_error: true, content: JSON.stringify({ error: 'Penyimpanan hanya boleh dalam mode wawancara principal.' }) });
        dipakai.push({ nama: blok.name, masukan: blok.input, error: true });
        continue;
      }
      const r = await jalankanAlat(db, blok.name, blok.input);
      hasil.push({ type: 'tool_result', tool_use_id: blok.id, content: r.isi, ...(r.error ? { is_error: true } : {}) });
      dipakai.push({ nama: blok.name, masukan: blok.input, error: r.error });
    }
    messages.push({ role: 'user', content: hasil });
    if (putaran === MAX_PUTARAN - 1) jawaban = teksDari(response.content) || 'Pertanyaan ini butuh terlalu banyak langkah. Coba persempit pertanyaannya.';
  }

  const judul = percakapan ? percakapan.judul : (mode === 'wawancara' ? `Wawancara ${principal.nama}` : pesan.slice(0, 70));
  const disimpan = await db.simpanPercakapan({
    id: percakapan ? percakapan.id : undefined, mode, principal_id: principalId, judul, pesan: messages,
  });
  return { percakapan_id: disimpan.id, judul, jawaban, alat: dipakai, berhenti, pesan_baru: messages.length - awalBaru };
}

// Riwayat untuk ditampilkan di layar: hanya teks pengguna & jawaban (tanpa blok alat / konteks)
export function riwayatTampil(pesan) {
  const out = [];
  for (const m of pesan || []) {
    if (m.role === 'user' && typeof m.content === 'string') out.push({ dari: 'pengguna', teks: m.content.replace(/^\[Konteks\][^\n]*\n\n/, '') });
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const t = teksDari(m.content);
      if (t && !m.content.some((b) => b.type === 'tool_use')) out.push({ dari: 'asisten', teks: t });
    }
  }
  return out;
}

// Adaptor database dari klien supabase-js yang membawa token pengguna (Edge Function & server dev)
export function dbDariSupabase(sb) {
  const cek = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    rpc: async (fn, args) => cek(await sb.rpc(fn, args)),
    ambilPercakapan: async (id) => {
      const rows = cek(await sb.from('ai_percakapan').select('*').eq('id', id).limit(1));
      return rows[0] || null;
    },
    simpanPercakapan: async (row) => {
      if (row.id) {
        const rows = cek(await sb.from('ai_percakapan').update({ pesan: row.pesan }).eq('id', row.id).select('id'));
        if (!rows.length) throw new Error('Percakapan tidak bisa disimpan');
        return rows[0];
      }
      const rows = cek(await sb.from('ai_percakapan').insert({ mode: row.mode, principal_id: row.principal_id, judul: row.judul, pesan: row.pesan }).select('id'));
      return rows[0];
    },
  };
}
