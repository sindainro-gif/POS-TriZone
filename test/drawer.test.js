'use strict';
// Uji buka laci kasir lewat printer nota: node test/drawer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDrawer, KICK, RAW_PRINT_PS, DLL_NAME } = require('../src/drawer');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}
const rejectsMsg = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); assert.ok(e.userFacing, 'pesan untuk pengguna'); return true; });
// Tiruan execFile: catat argumen, balas stdout tertentu
const fakeExec = (stdout, calls = [], err = null) => (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); setImmediate(() => cb(err, stdout, '')); };

(async () => {
  await t('perintah ESC/POS: pulsa pin 2 lalu pin 5', () => {
    assert.deepStrictEqual([...KICK], [0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1b, 0x70, 0x01, 0x19, 0xfa]);
  });

  await t('mode uji: byte ditulis ke file Laci_*.bin tanpa printer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-laci-'));
    const r = await openDrawer({ testDir: dir, printerName: '' });
    assert.ok(r.ok && r.test && /Laci_\d+_\w+\.bin$/.test(r.file));
    assert.deepStrictEqual(fs.readFileSync(r.file), KICK);
  });

  await t('bukan Windows / printer belum dipilih: pesan jelas', async () => {
    await rejectsMsg(openDrawer({ printerName: 'POS-58', platform: 'linux' }), /hanya tersedia di Windows/);
    await rejectsMsg(openDrawer({ printerName: '  ', platform: 'win32' }), /Printer nota belum dipilih/);
  });

  await t('PowerShell: RAW ke spooler, nama printer & data lewat variabel lingkungan (tidak disisipkan ke skrip)', async () => {
    const calls = [];
    const name = `POS-58 "Kasir" $(rm) 'x'`;
    const r = await openDrawer({ printerName: name, dataDir: 'C:\\Data', platform: 'win32', exec: fakeExec('ok\r\n', calls) });
    assert.deepStrictEqual(r, { ok: true, printer: name });
    const c = calls[0];
    assert.strictEqual(c.cmd, 'powershell.exe');
    assert.deepStrictEqual(c.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const script = Buffer.from(c.args[5], 'base64').toString('utf16le');
    assert.strictEqual(script, RAW_PRINT_PS);
    assert.ok(!script.includes('POS-58'));
    assert.match(script, /pDataType = "RAW"/);
    assert.match(script, /\$env:POS_RAW_PRINTER/);
    assert.strictEqual(c.opts.env.POS_RAW_PRINTER, name);
    assert.deepStrictEqual(Buffer.from(c.opts.env.POS_RAW_DATA, 'base64'), KICK);
    assert.strictEqual(c.opts.env.POS_RAW_DLL, path.join('C:\\Data', DLL_NAME));
    assert.ok(c.opts.windowsHide && c.opts.timeout > 0);
  });

  await t('hasil gagal: printer tidak ditemukan / tidak merespons / PowerShell gagal', async () => {
    const opt = { printerName: 'POS-58', platform: 'win32' };
    await rejectsMsg(openDrawer({ ...opt, exec: fakeExec('open:1801') }), /"POS-58" tidak ditemukan/);
    await rejectsMsg(openDrawer({ ...opt, exec: fakeExec('write:5') }), /tidak merespons/);
    await rejectsMsg(openDrawer({ ...opt, exec: fakeExec('', [], new Error('spawn powershell.exe ENOENT')) }), /gagal dijalankan/);
  });

  if (process.platform === 'win32') {
    await t('Windows sungguhan: kode C# terkompilasi (lalu dipakai ulang) dan printer yang tidak ada dilaporkan', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-laci-dll-'));
      const fake = `Printer Tidak Ada ${Date.now()}`;
      await rejectsMsg(openDrawer({ printerName: fake, dataDir: dir }), /tidak ditemukan/);
      assert.ok(fs.existsSync(path.join(dir, DLL_NAME)), 'DLL tersimpan untuk dipakai ulang');
      await rejectsMsg(openDrawer({ printerName: fake, dataDir: dir }), /tidak ditemukan/); // dari DLL tersimpan
    });
  }

  console.log(`\n${passed} tes laci kasir lulus${process.exitCode ? ', ada yang GAGAL' : ''}.`);
})();
