// SPDX-License-Identifier: GPL-3.0-or-later
const { app, BrowserWindow, Menu, dialog, ipcMain, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const isSmoke = process.argv.includes('--smoke');
const indexPath = path.join(__dirname, '..', 'dist', 'index.html');

let win = null;
let allowClose = false;
let closePending = false;
let dirty = false;

function errText(err) {
  return String((err && err.message) || err);
}

function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('save-as') },
        { label: '导出 PNG…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export-png') },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '白板画布',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  if (isSmoke) {
    win.webContents.once('did-finish-load', () => {
      require('./smoke')(win).then((code) => app.exit(code));
    });
    win.loadFile(indexPath, { query: { smoke: '1' } });
  } else {
    win.once('ready-to-show', () => win.show());
    win.loadFile(indexPath);
  }

  win.on('close', async (e) => {
    if (allowClose || !dirty) return;
    e.preventDefault();
    if (closePending) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '文档尚未保存',
      detail: '是否保存更改？'
    });
    if (choice === 2) return;
    if (choice === 1) {
      allowClose = true;
      win.close();
      return;
    }
    closePending = true;
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 60000);
      ipcMain.once('save-result', (_e, result) => {
        clearTimeout(timer);
        resolve(!!result);
      });
      win.webContents.send('request-save');
    });
    closePending = false;
    if (ok) {
      allowClose = true;
      win.close();
    }
  });
}

function registerIpc() {
  ipcMain.handle('doc:open', async (_e, filePath) => {
    try {
      let target = filePath || null;
      if (!target) {
        const r = await dialog.showOpenDialog(win, {
          title: '打开白板',
          filters: [
            { name: '白板画布', extensions: ['wbc'] },
            { name: '所有文件', extensions: ['*'] }
          ],
          properties: ['openFile']
        });
        if (r.canceled || !r.filePaths[0]) return { canceled: true };
        target = r.filePaths[0];
      }
      const text = await fs.promises.readFile(target, 'utf8');
      return { path: target, text };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('doc:save', async (_e, args) => {
    const { path: given, text, silent } = args || {};
    try {
      let target = given || null;
      if (!target) {
        if (silent) return { error: '未指定保存路径' };
        const r = await dialog.showSaveDialog(win, {
          title: '保存白板',
          defaultPath: '未命名.wbc',
          filters: [{ name: '白板画布', extensions: ['wbc'] }]
        });
        if (r.canceled || !r.filePath) return { canceled: true };
        target = r.filePath;
        if (!/\.wbc$/i.test(target)) target += '.wbc';
      }
      await fs.promises.writeFile(target, String(text || ''), 'utf8');
      return { path: target };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('png:save', async (_e, dataUrl, given) => {
    try {
      let target = given || null;
      if (!target) {
        const r = await dialog.showSaveDialog(win, {
          title: '导出 PNG',
          defaultPath: '白板.png',
          filters: [{ name: 'PNG 图片', extensions: ['png'] }]
        });
        if (r.canceled || !r.filePath) return { canceled: true };
        target = r.filePath;
        if (!/\.png$/i.test(target)) target += '.png';
      }
      const b64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
      await fs.promises.writeFile(target, Buffer.from(b64, 'base64'));
      return { path: target };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.on('app:error', (_e, message) => {
    dialog.showErrorBox('白板画布', String(message || '未知错误'));
  });

  ipcMain.on('clipboard:write-text', (_e, text) => {
    clipboard.writeText(String(text || ''));
  });

  ipcMain.handle('app:confirm-discard', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['继续', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '未保存的更改将丢失',
      detail: '是否继续？'
    });
    return r.response === 0;
  });

  ipcMain.on('doc:dirty', (_e, value) => {
    dirty = !!value;
  });

  ipcMain.on('save-result', () => {
    /* 由 close 流程中的 ipcMain.once 消费 */
  });
}

app.whenReady().then(() => {
  buildMenu();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
