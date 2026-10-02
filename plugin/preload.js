'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('portal', {
  state: call('app:state'),
  login: call('auth:login'),
  logout: call('auth:logout'),
  saveSettings: call('settings:save'),
  search: call('portal:search'),
  savedSearches: call('portal:savedSearches'),
  runSaved: call('portal:runSaved'),
  collections: call('portal:collections'),
  collectionItems: call('portal:collectionItems'),
  collectionAll: call('portal:collectionAll'),
  thumbnail: call('portal:thumbnail'),
  testPaths: call('paths:test'),
  currentBin: call('resolve:bin'),
  importItems: call('resolve:import'),
  openInPortal: call('shell:openPortal'),
  reveal: call('shell:reveal'),
  onImportProgress: (cb) => ipcRenderer.on('import:progress', (_e, data) => cb(data)),
});
