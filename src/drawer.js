'use strict';
// Buka laci kasir yang tersambung ke printer nota (kabel RJ11 di belakang printer).
// Perintah ESC/POS "drawer kick" dikirim RAW ke printer lewat spooler Windows (tanpa mencetak / tanpa kertas keluar).
// Laci yang terbuka otomatis saat Bayar tetap diatur oleh driver printer, bukan dari sini.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
  const res = String(out).split(/\r?\n/).pop().trim();
  if (res === 'ok') return { ok: true, printer: name };
  console.error('[laci]', name, res);
  throw userErr(/^open:/.test(res)
    ? `Laci tidak bisa dibuka: printer nota "${name}" tidak ditemukan. Periksa printer nota di Pengaturan.`
    : `Laci tidak bisa dibuka: printer nota "${name}" tidak merespons (mati / kabel lepas). Periksa printer, lalu coba lagi.`);
}

module.exports = { openDrawer, KICK, RAW_PRINT_PS, DLL_NAME, encodePs };
