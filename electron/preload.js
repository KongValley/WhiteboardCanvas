// SPDX-License-Identifier: GPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDoc: (path) => ipcRenderer.invoke('doc:open', path),
  saveDoc: (path, text, silent) => ipcRenderer.invoke('doc:save', { path, text, silent }),
  savePng: (dataUrl, path) => ipcRenderer.invoke('png:save', dataUrl, path),
  showError: (message) => ipcRenderer.send('app:error', message),
  writeClipboardText: (text) => ipcRenderer.send('clipboard:write-text', text),
  confirmDiscard: () => ipcRenderer.invoke('app:confirm-discard'),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onRequestSave: (cb) => ipcRenderer.on('request-save', () => cb()),
  saveResult: (ok) => ipcRenderer.send('save-result', ok)
});
