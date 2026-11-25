'use strict';
// Buka laci kasir yang tersambung ke printer nota (kabel RJ11 di belakang printer).
// Perintah ESC/POS "drawer kick" dikirim RAW ke printer lewat spooler Windows (tanpa mencetak / tanpa kertas keluar).
// Laci yang terbuka otomatis saat Bayar tetap diatur oleh driver printer, bukan dari sini.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// ESC p m t1 t2: pulsa ke pin 2 (m=0) lalu pin 5 (m=1) agar cocok untuk semua jenis laci; pin yang tidak tersambung diabaikan
const KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1b, 0x70, 0x01, 0x19, 0xfa]);
const DLL_NAME = 'rawprint-v1.dll'; // kelas C# terkompilasi (dipakai ulang agar cepat; ganti nama bila kodenya berubah)

const userErr = (msg) => Object.assign(new Error(msg), { userFacing: true });

// Skrip PowerShell: nama printer, data (base64), dan lokasi DLL dibaca dari variabel lingkungan,
// tidak disusun ke dalam skrip (aman untuk nama printer dengan karakter apa pun).
const RAW_PRINT_PS = String.raw`$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class PosRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "open:" + Marshal.GetLastWin32Error();
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "POS Tri-Zone - Buka Laci";
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "doc:" + Marshal.GetLastWin32Error();
      try {
        StartPagePrinter(h);
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "write:" + Marshal.GetLastWin32Error();
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return "ok";
  }
}
"@
function Test-PosRaw { return [bool]('PosRawPrint' -as [type]) }
$dll = $env:POS_RAW_DLL
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -LiteralPath $dll } catch { } }
if (-not (Test-PosRaw) -and $dll) {
  try { Add-Type -TypeDefinition $src -OutputAssembly $dll -OutputType Library } catch { }
  if (-not (Test-PosRaw) -and (Test-Path -LiteralPath $dll)) { try { Add-Type -LiteralPath $dll } catch { } }
}
if (-not (Test-PosRaw)) { Add-Type -TypeDefinition $src }
Write-Output ([PosRawPrint]::Send($env:POS_RAW_PRINTER, [Convert]::FromBase64String($env:POS_RAW_DATA)))
`;

// PowerShell -EncodedCommand = skrip dalam UTF-16LE base64 (tanpa masalah tanda kutip)
const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

function runPowerShell(script, env, { timeout = 15000, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)],
      { env: { ...process.env, ...env }, timeout, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout || '').trim())));
  });
}

/**
 * Buka laci lewat printer nota.
 * testDir: mode uji (POS_PRINT_TO_PDF) → byte ditulis ke file Laci_<waktu>.bin, tanpa printer.
 */
async function openDrawer({ printerName, dataDir, testDir, platform = process.platform, exec } = {}) {
  if (testDir) {
    fs.mkdirSync(testDir, { recursive: true });
    const file = path.join(testDir, `Laci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.bin`);
    fs.writeFileSync(file, KICK);
    return { ok: true, test: true, file };
  }
  if (platform !== 'win32') throw userErr('Buka laci hanya tersedia di Windows.');
  const name = String(printerName || '').trim();
  if (!name) throw userErr('Printer nota belum dipilih. Atur printer nota di Pengaturan, lalu coba lagi.');
  let out;
  try {
    out = await runPowerShell(RAW_PRINT_PS, {
      POS_RAW_PRINTER: name,
      POS_RAW_DATA: KICK.toString('base64'),
      POS_RAW_DLL: dataDir ? path.join(dataDir, DLL_NAME) : '',
    }, { exec });
  } catch (err) {
    console.error('[laci]', err.message, err.stderr || '');
    throw userErr('Laci tidak bisa dibuka: perintah ke printer gagal dijalankan. Coba lagi, atau buka laci dengan kunci.');
  }
  return interpret(String(out).split(/\r?\n/).pop().trim(), name);
}

// Balasan kelas C# → hasil / pesan untuk kasir
function interpret(res, name) {
  if (res === 'ok') return { ok: true, printer: name };
  console.error('[laci]', name, res);
  throw userErr(/^open:/.test(res)
    ? `Laci tidak bisa dibuka: printer nota "${name}" tidak ditemukan. Periksa printer nota di Pengaturan.`
    : `Laci tidak bisa dibuka: printer nota "${name}" tidak merespons (mati / kabel lepas). Periksa printer, lalu coba lagi.`);
}

// ---------------------------------------------------------------- Pekerja yang tetap menyala
// Menyalakan PowerShell + memuat kelas C# makan ±1–3 detik. Supaya laci terbuka seketika saat Bayar,
// satu proses PowerShell dibiarkan menyala dan menunggu perintah lewat stdin:
//   kirim  "id|nama printer (base64 UTF-8)|data (base64)"   balas  "id|ok" / "id|open:1801" / ...
// Bila pekerja mati / macet, perintah dicoba sekali dengan cara lama (openDrawer) dan pekerja dinyalakan lagi nanti.
const LOADER_PS = `${RAW_PRINT_PS.split('\nWrite-Output ([PosRawPrint]')[0]}\n`;
const WORKER_PS = `${LOADER_PS}${String.raw`[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split('|')
  if ($p.Length -lt 3) { continue }
  try {
    $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
    $r = [PosRawPrint]::Send($name, [Convert]::FromBase64String($p[2]))
  } catch { $r = 'err:' + ($_.Exception.Message -replace '[\r\n|]', ' ') }
  [Console]::Out.WriteLine($p[0] + '|' + $r)
  [Console]::Out.Flush()
}
`}`;

function createDrawerWorker({ dataDir, spawnFn = spawn, oneShot = openDrawer, platform = process.platform, readyTimeout = 20000, timeout = 5000 } = {}) {
  let child = null;
  let ready = false;
  let buf = '';
  let seq = 0;
  const pending = new Map();

  function failAll(why) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pending.clear();
  }
  function stop() {
    const c = child;
    child = null;
    ready = false;
    buf = '';
    if (c) { try { c.stdin.end(); } catch (_) { /* sudah tertutup */ } try { c.kill(); } catch (_) { /* sudah mati */ } }
    failAll('pekerja laci dihentikan');
  }
  function onLine(line) {
    if (line === 'ready') { ready = true; return; }
    const k = line.indexOf('|');
    if (k < 0) return;
    const p = pending.get(line.slice(0, k));
    if (!p) return;
    pending.delete(line.slice(0, k));
    clearTimeout(p.timer);
    p.resolve(line.slice(k + 1).trim());
  }
  function start() {
    if (child || platform !== 'win32') return;
    const c = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(WORKER_PS)], {
      env: { ...process.env, POS_RAW_DLL: dataDir ? path.join(dataDir, DLL_NAME) : '' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = c;
    ready = false;
    buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      if (child !== c) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    c.stderr.on('data', (d) => console.error('[laci pekerja]', String(d).trim()));
    c.stdin.on('error', () => { /* pekerja sudah mati: ditangani di exit */ });
    const gone = () => { if (child === c) { child = null; ready = false; failAll('pekerja laci berhenti'); } };
    c.on('exit', gone);
    c.on('error', gone);
  }
  function send(name) {
    start();
    return new Promise((resolve, reject) => {
      const id = String(++seq);
      // Panggilan pertama ikut menunggu PowerShell menyala & kelas C# dimuat
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('pekerja laci tidak menjawab')); stop(); }, ready ? timeout : readyTimeout);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${id}|${Buffer.from(name, 'utf8').toString('base64')}|${KICK.toString('base64')}\n`);
      } catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
    });
  }
  async function open({ printerName } = {}) {
    if (platform !== 'win32') throw userErr('Buka laci hanya tersedia di Windows.');
    const name = String(printerName || '').trim();
    if (!name) throw userErr('Printer nota belum dipilih. Atur printer nota di Pengaturan, lalu coba lagi.');
    let res;
    try {
      res = await send(name);
    } catch (err) {
      console.error('[laci] pekerja gagal, pakai cara biasa:', err.message);
      stop();
      return oneShot({ printerName: name, dataDir, platform });
    }
    return interpret(res, name);
  }
  return { open, warm: start, stop, get running() { return !!child; }, get ready() { return ready; } };
}

module.exports = { openDrawer, createDrawerWorker, KICK, RAW_PRINT_PS, WORKER_PS, DLL_NAME, encodePs };
