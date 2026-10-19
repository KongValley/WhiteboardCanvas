// SPDX-License-Identifier: GPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startup: () => ipcRenderer.invoke('app:startup'),
  openDoc: (path) => ipcRenderer.invoke('doc:open', path),
  saveDoc: (path, text, silent) => ipcRenderer.invoke('doc:save', { path, text, silent }),
  savePng: (dataUrl, path) => ipcRenderer.invoke('png:save', dataUrl, path),
  printPng: (dataUrl, mode, target) => ipcRenderer.invoke('print:png', dataUrl, mode, target),
  showError: (message) => ipcRenderer.send('app:error', message),
  log: (level, message) => ipcRenderer.send('app:log', level, message),
  confirm: (message, detail) => ipcRenderer.invoke('app:confirm', message, detail),
  writeClipboardText: (text) => ipcRenderer.send('clipboard:write-text', text),
  writeClipboardImage: (dataUrl) => ipcRenderer.send('clipboard:write-image', dataUrl),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  confirmDiscard: () => ipcRenderer.invoke('app:confirm-discard'),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  writeRecovery: (text, path) => ipcRenderer.send('recovery:write', text, path),
  clearRecovery: () => ipcRenderer.send('recovery:clear'),
  backupNow: (text, path) => ipcRenderer.invoke('backup:now', text, path),
  restoreBackup: () => ipcRenderer.invoke('backup:restore'),
  getAssociation: () => ipcRenderer.invoke('assoc:get'),
  setAssociation: (enabled) => ipcRenderer.invoke('assoc:set', enabled),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action, arg) => cb(action, arg)),
  onRequestSave: (cb) => ipcRenderer.on('request-save', () => cb()),
  saveResult: (ok) => ipcRenderer.send('save-result', ok),
  versions: {
    app: '',
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }
});
