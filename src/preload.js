'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Ukuran tampilan (zoom halaman) per komputer: 0,8–2. Disimpan oleh common.js di localStorage['pos-zoom'].
const clampZoom = (f) => Math.min(2, Math.max(0.8, Number(f) || 1));

// Terapkan ukuran tersimpan sebelum halaman tampil (tanpa kedip 100% saat login / muat ulang)
try {
  const saved = Number(window.localStorage.getItem('pos-zoom'));
  if (saved) webFrame.setZoomFactor(clampZoom(saved));
} catch (_) { /* penyimpanan tidak tersedia: tetap 100% */ }

contextBridge.exposeInMainWorld('posBridge', {
  call: (channel, args) => ipcRenderer.invoke('api', channel, args),
  setZoom: (factor) => {
    const f = clampZoom(factor);
    webFrame.setZoomFactor(f);
    return f;
  },
  getZoom: () => webFrame.getZoomFactor(),
});
