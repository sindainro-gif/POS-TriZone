'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Ukuran tampilan (zoom halaman) per komputer: 0,8–2. Disimpan & diterapkan oleh common.js (localStorage['pos-zoom']).
// JANGAN dipanggil di sini saat preload: zoom sebelum halaman pertama digambar membuat event ready-to-show
// tidak pernah terpicu sehingga jendela aplikasi tidak pernah tampil.
const clampZoom = (f) => Math.min(2, Math.max(0.8, Number(f) || 1));

contextBridge.exposeInMainWorld('posBridge', {
  call: (channel, args) => ipcRenderer.invoke('api', channel, args),
  setZoom: (factor) => {
    const f = clampZoom(factor);
    webFrame.setZoomFactor(f);
    return f;
  },
  getZoom: () => webFrame.getZoomFactor(),
});
