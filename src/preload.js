'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posBridge', {
  call: (channel, args) => ipcRenderer.invoke('api', channel, args),
});
