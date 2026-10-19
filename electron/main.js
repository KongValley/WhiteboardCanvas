// SPDX-License-Identifier: GPL-3.0-or-later
const { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const zip = require('./zip');
const assoc = require('./assoc');
const { createStore } = require('./store');

const isSmoke = process.argv.includes('--smoke');
const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
if (isSmoke) {
  app.setPath('userData', path.join(app.getPath('temp'), 'wbc-smoke-userdata-' + process.pid));
}

const MAX_OPEN_SIZE = 100 * 1024 * 1024;
const MAX_DOC_TEXT = 256 * 1024 * 1024;
const MAX_IMAGE_URL = 300 * 1024 * 1024;

let win = null;
let allowClose = false;
let closePending = false;
let dirty = false;

const store = createStore(app.getPath('userData'));
process.on('uncaughtException', (err) => {
  store.log('error', '主进程未捕获异常：' + String((err && err.stack) || err));
});
process.on('unhandledRejection', (reason) => {
  store.log('error', '主进程未处理拒绝：' + String((reason && reason.stack) || reason));
});
let settings = store.loadSettings();
const startupState = { recovery: null, openPath: null };
if (settings.disableGpu || process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration();

function errText(err) {
  return String((err && err.message) || err);
}

function sendMenu(action, arg) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', action, arg);
}

function parseWbcArg(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || !/\.wbc$/i.test(arg)) continue;
    try {
      const full = path.resolve(arg);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* 不是可访问的路径 */
    }
  }
  return null;
}

function extForMime(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
  };
  return map[String(mime).toLowerCase()] || 'png';
}

function mimeForExt(ext) {
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
  return map[String(ext).toLowerCase()] || 'image/png';
}

/** v2：doc.json + assets/（按内容哈希去重） */
function textToZip(text) {
  const doc = JSON.parse(text);
  if (!doc || doc.app !== 'whiteboard-canvas' || !Array.isArray(doc.elements)) throw new Error('文档格式不正确');
  doc.version = 2;
  const assets = new Map();
  for (const el of doc.elements) {
    if (!el || el.type !== 'image' || typeof el.src !== 'string') continue;
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(el.src);
    if (!match) continue;
    const data = Buffer.from(match[2], 'base64');
    const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 20);
    const name = `assets/${hash}.${extForMime(match[1])}`;
    assets.set(name, data);
    el.src = name.replace(/^assets\//, 'asset:');
  }
  const docBuf = Buffer.from(JSON.stringify(doc), 'utf8');
  const entries = [{ name: 'doc.json', data: docBuf }];
  for (const [name, data] of assets) entries.push({ name, data });
  return { buffer: zip.write(entries), jsonSize: docBuf.length, assets: assets.size };
}

/** v2 容器 → 内联 data URL 的 JSON 文本 */
function zipToText(buffer, filePath) {
  const files = zip.read(buffer);
  const docBuf = files.get('doc.json');
  if (!docBuf) throw new Error('文件缺少 doc.json');
  const doc = JSON.parse(docBuf.toString('utf8'));
  if (!doc || doc.app !== 'whiteboard-canvas' || !Array.isArray(doc.elements)) throw new Error('文件格式不正确');
  const version = Number(doc.version) || 2;
  if (version > 2) throw new Error(`该文件由更高版本创建（v${version}），请升级应用后再打开。`);
  const kept = [];
  for (const el of doc.elements) {
    if (el && el.type === 'image' && typeof el.src === 'string' && el.src.startsWith('asset:')) {
      const name = 'assets/' + el.src.slice(6);
      const data = files.get(name);
      if (!data) {
        store.log('warn', `缺少图片资源 ${name}（${filePath}），已跳过该元素`);
        continue;
      }
      el.src = `data:${mimeForExt(name.split('.').pop())};base64,${data.toString('base64')}`;
    }
    kept.push(el);
  }
  doc.elements = kept;
  return JSON.stringify(doc);
}

function buildMenu() {
  const recent = store.recent();
  const recentItems = recent.length
    ? recent.map((file) => {
        const missing = !fs.existsSync(file);
        return {
          label: path.basename(file) + (missing ? '（缺失）' : `  —  ${path.dirname(file)}`),
          enabled: !missing,
          click: () => sendMenu('open-path', file)
        };
      })
    : [{ label: '（空）', enabled: false }];
  if (recent.length) {
    recentItems.push({ type: 'separator' }, { label: '清除最近文件', click: () => { store.clearRecent(); buildMenu(); } });
  }

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: '最近文件', submenu: recentItems },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { label: '立即备份', click: () => sendMenu('backup-now') },
        { label: '恢复自动备份…', click: () => sendMenu('restore-backup') },
        { type: 'separator' },
        { label: '导出 PNG…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export-png') },
        { label: '导出 PDF…', click: () => sendMenu('export-pdf') },
        { label: '打印…', accelerator: 'CmdOrCtrl+P', click: () => sendMenu('print') },
        { type: 'separator' },
        { label: '设置…', click: () => sendMenu('settings') },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键', accelerator: 'F1', click: () => sendMenu('help') },
        { label: '关于', click: () => showAbout() }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于白板画布',
    message: '白板画布 v' + app.getVersion(),
    detail:
      'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome + '\n' +
      '许可证：GPL-3.0-or-later\n' +
      '免安装便携版：解压即用，不写系统级注册表。',
    buttons: ['确定']
  });
}

function createWindow() {
  const opts = {
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
      backgroundThrottling: false,
      zoomFactor: 1
    }
  };
  try {
    if (fs.existsSync(iconPath)) opts.icon = iconPath;
  } catch {
    /* 图标缺失不阻塞启动 */
  }
  win = new BrowserWindow(opts);

  if (isSmoke) {
    win.webContents.once('did-finish-load', () => {
      require('./smoke')(win).then((code) => app.exit(code));
    });
    win.loadFile(indexPath, { query: { smoke: '1' } });
  } else {
    win.once('ready-to-show', () => win.show());
    win.loadFile(indexPath);
  }

  win.on('close', (e) => {
    if (isSmoke || allowClose) return;
    if (!dirty) return;
    e.preventDefault();
    if (closePending) return;
    const behavior = store.loadSettings().closeBehavior;
    if (behavior === 'discard') {
      store.clearRecovery();
      allowClose = true;
      win.close();
      return;
    }
    if (behavior === 'ask') {
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
        store.clearRecovery();
        allowClose = true;
        win.close();
        return;
      }
    }
    closePending = true;
    void requestSave().then((ok) => {
      closePending = false;
      if (ok) {
        allowClose = true;
        win.close();
      }
    });
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    store.log('error', '渲染进程退出：' + JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_e, code, description) => {
    store.log('error', `页面加载失败 ${code} ${description}`);
  });
}

function requestSave() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 60000);
    ipcMain.once('save-result', (_e, result) => {
      clearTimeout(timer);
      resolve(!!result);
    });
    win.webContents.send('request-save');
  });
}

function asString(value, max, name, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value)) throw new Error('参数无效：' + name);
  return value;
}

function asBool(value, name) {
  if (typeof value !== 'boolean') throw new Error('参数无效：' + name);
  return value;
}

function isZipFile(buffer) {
  return zip.isZip(buffer);
}

async function chooseSavePath(title, defaultName, ext) {
  const r = await dialog.showSaveDialog(win, {
    title,
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return null;
  let target = r.filePath;
  if (!new RegExp('\\.' + ext + '$', 'i').test(target)) target += '.' + ext;
  return target;
}

async function readDocumentFile(target) {
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error('不是有效文件');
  if (stat.size > MAX_OPEN_SIZE) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['仍要打开', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '文件超过 100MB',
      detail: '打开大文档可能占用大量内存，是否继续？'
    });
    if (choice !== 0) return { canceled: true };
  }
  const buffer = await fs.promises.readFile(target);
  if (isZipFile(buffer)) {
    return { path: target, text: zipToText(buffer, target) };
  }
  let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || parsed.app !== 'whiteboard-canvas' || !Array.isArray(parsed.elements)) {
    throw new Error('文件格式不正确');
  }
  const version = Number(parsed.version) || 1;
  if (version > 2) {
    return { error: `该文件由更高版本创建（v${version}），请升级应用后再打开。` };
  }
  if (version < 2) {
    await store.backupBuffer(buffer, target);
    parsed.version = 2;
    text = JSON.stringify(parsed);
    store.log('info', `已将 v${version} 文件迁移为 v2：${target}`);
  }
  return { path: target, text };
}

async function saveDocument(args) {
  const given = args.path === null || args.path === undefined ? null : asString(args.path, 4096, 'path');
  let text = asString(args.text, MAX_DOC_TEXT, 'text');
  const silent = args.silent === undefined ? false : asBool(args.silent, 'silent');
  let target = given;
  if (!target) {
    if (silent) return { error: '未指定保存路径' };
    target = await chooseSavePath('保存白板', '未命名.wbc', 'wbc');
    if (!target) return { canceled: true };
  } else if (!silent) {
    try {
      if (fs.statSync(target).isFile()) await store.backupFile(target);
    } catch {
      /* 新文件无备份 */
    }
  }

  // 只读/占用预检（仅对已存在的文件探测；新文件由父目录权限决定）
  let exists = false;
  try {
    exists = fs.statSync(target).isFile();
  } catch {
    exists = false;
  }
  if (!silent && exists) {
    try {
      await fs.promises.access(target, fs.constants.W_OK);
    } catch {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['另存为…', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: '文件不可写',
        detail: '文件可能是只读或被占用：' + target
      });
      if (choice !== 0) return { canceled: true };
      const alt = await chooseSavePath('另存为白板', path.basename(target), 'wbc');
      if (!alt) return { canceled: true };
      target = alt;
    }
  }

  let payload;
  try {
    payload = textToZip(text).buffer;
  } catch (err) {
    return { error: '文档序列化失败：' + errText(err) };
  }

  for (;;) {
    const tmp = target + '.tmp-' + process.pid;
    try {
      await fs.promises.writeFile(tmp, payload);
      await fs.promises.rename(tmp, target);
      store.clearRecovery();
      store.addRecent(target);
      store.log('info', '保存文档：' + target);
      buildMenu();
      return { path: target };
    } catch (err) {
      store.log('error', '保存失败：' + errText(err));
      try {
        await fs.promises.unlink(tmp);
      } catch {
        /* 临时文件可能不存在 */
      }
      if (silent) return { error: errText(err) };
      const choice = dialog.showMessageBoxSync(win, {
        type: 'error',
        buttons: ['重试', '另存为…', '取消'],
        defaultId: 0,
        cancelId: 2,
        message: '保存失败',
        detail: errText(err) + '\n编辑内容仍保留在内存中。'
      });
      if (choice === 0) continue;
      if (choice === 1) {
        const alt = await chooseSavePath('另存为白板', path.basename(target), 'wbc');
        if (alt) {
          target = alt;
          continue;
        }
      }
      return { canceled: true, error: errText(err) };
    }
  }
}

async function handlePrint(dataUrl, mode, givenTarget) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_URL || !dataUrl.startsWith('data:image/png;base64,')) {
    return { error: '参数无效：dataUrl' };
  }
  if (mode !== 'pdf' && mode !== 'print') return { error: '参数无效：mode' };
  const stamp = `${process.pid}-${Date.now()}`;
  const pngPath = path.join(app.getPath('temp'), `wbc-print-${stamp}.png`);
  const htmlPath = path.join(app.getPath('temp'), `wbc-print-${stamp}.html`);
  const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await fs.promises.writeFile(pngPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      '@page{size:A4 landscape;margin:8mm}html,body{margin:0;width:100%;height:100%}' +
      'img{width:100%;height:100%;object-fit:contain}</style></head><body>' +
      `<img src="${pathToFileURL(pngPath).href}"></body></html>`;
    await fs.promises.writeFile(htmlPath, html, 'utf8');
    await printWin.loadFile(htmlPath);
    if (mode === 'pdf') {
      const pdf = await printWin.webContents.printToPDF({
        landscape: true,
        pageSize: 'A4',
        printBackground: true,
        margins: { marginType: 'default' }
      });
      let target = typeof givenTarget === 'string' && givenTarget ? asString(givenTarget, 4096, 'target') : null;
      if (!target) target = await chooseSavePath('导出 PDF', '白板.pdf', 'pdf');
      if (!target) return { canceled: true };
      await fs.promises.writeFile(target, pdf);
      store.log('info', '导出 PDF：' + target);
      return { path: target };
    }
    return await new Promise((resolve) => {
      printWin.webContents.print({ silent: false, printBackground: true, landscape: true, pageSize: 'A4' }, (success, reason) => {
        if (success) resolve({ path: '打印' });
        else if (reason === 'cancelled' || reason === 'Print job canceled') resolve({ canceled: true });
        else resolve({ error: String(reason || '打印失败') });
      });
    });
  } catch (err) {
    return { error: errText(err) };
  } finally {
    try {
      printWin.destroy();
    } catch {
      /* 已销毁 */
    }
    try {
      await fs.promises.unlink(pngPath);
    } catch {
      /* 忽略 */
    }
    try {
      await fs.promises.unlink(htmlPath);
    } catch {
      /* 忽略 */
    }
  }
}

function registerIpc() {
  ipcMain.handle('app:startup', async () => {
    const state = {
      settings: isSmoke ? { autosaveDelay: 1, closeBehavior: 'ask', disableGpu: false, background: 'dots' } : store.loadSettings(),
      recovery: startupState.recovery,
      openPath: startupState.openPath
    };
    startupState.recovery = null;
    startupState.openPath = null;
    return state;
  });

  ipcMain.handle('doc:open', async (_e, filePath) => {
    try {
      let target = filePath === undefined || filePath === null ? null : asString(filePath, 4096, 'path', false);
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
      const result = await readDocumentFile(target);
      if (result.path && result.text) {
        store.addRecent(result.path);
        store.log('info', '打开文档：' + result.path);
        buildMenu();
      }
      return result;
    } catch (err) {
      store.log('error', '打开失败：' + errText(err));
      return { error: errText(err) };
    }
  });

  ipcMain.handle('doc:save', async (_e, args) => {
    if (!args || typeof args !== 'object') return { error: '参数无效：args' };
    try {
      return await saveDocument(args);
    } catch (err) {
      store.log('error', '保存失败：' + errText(err));
      return { error: errText(err) };
    }
  });

  ipcMain.handle('png:save', async (_e, dataUrl, given) => {
    try {
      if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_URL || !dataUrl.startsWith('data:image/png;base64,')) {
        return { error: '参数无效：图片数据' };
      }
      let target = given === undefined || given === null ? null : asString(given, 4096, 'path', false);
      if (!target) target = await chooseSavePath('导出 PNG', '白板.png', 'png');
      if (!target) return { canceled: true };
      await fs.promises.writeFile(target, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      store.log('info', '导出 PNG：' + target);
      return { path: target };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.on('app:error', (_e, message) => {
    dialog.showErrorBox('白板画布', String(message || '未知错误').slice(0, 4000));
  });

  ipcMain.on('app:log', (_e, level, message) => {
    if (typeof message !== 'string') return;
    store.log(['info', 'warn', 'error'].includes(level) ? level : 'info', message.slice(0, 8000));
  });

  ipcMain.handle('app:confirm', async (_e, message, detail) => {
    const msg = typeof message === 'string' ? message.slice(0, 1000) : '';
    if (!msg) return false;
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['继续', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: msg,
      detail: typeof detail === 'string' ? detail.slice(0, 2000) : ''
    });
    return r.response === 0;
  });

  ipcMain.on('clipboard:write-text', (_e, text) => {
    clipboard.writeText(String(text || '').slice(0, 32 * 1024 * 1024));
  });

  ipcMain.on('clipboard:write-image', (_e, dataUrl) => {
    try {
      if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_URL || !dataUrl.startsWith('data:image/png;base64,')) return;
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    } catch (err) {
      store.log('warn', '写剪贴板图片失败：' + errText(err));
    }
  });

  ipcMain.handle('clipboard:read-text', async () => clipboard.readText().slice(0, 32 * 1024 * 1024));

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
    dirty = value === true;
  });

  ipcMain.on('save-result', () => {
    /* 由 close 流程中的 ipcMain.once 消费 */
  });

  ipcMain.handle('settings:get', async () => store.loadSettings());

  ipcMain.handle('settings:set', async (_e, patch) => {
    if (!patch || typeof patch !== 'object') return { error: '参数无效' };
    try {
      settings = store.saveSettings(patch);
      store.log('info', '更新设置：' + JSON.stringify(settings));
      return settings;
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.on('recovery:write', (_e, text, filePath) => {
    if (typeof text !== 'string' || typeof filePath !== 'string') return;
    store.writeRecovery(text, filePath || null);
  });

  ipcMain.on('recovery:clear', () => store.clearRecovery());

  ipcMain.handle('backup:now', async (_e, text, filePath) => {
    try {
      const safeText = asString(text, MAX_DOC_TEXT, 'text');
      const safePath = typeof filePath === 'string' ? asString(filePath, 4096, 'path') : null;
      const file = await store.backupBuffer(textToZip(safeText).buffer, safePath);
      return file ? { path: file } : { error: '备份失败' };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('backup:restore', async () => {
    const backups = store.listBackups();
    const r = await dialog.showOpenDialog(win, {
      title: '恢复自动备份',
      defaultPath: backups.length ? backups[0].path : store.dirs.backupsDir,
      filters: [{ name: '白板备份', extensions: ['wbc'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return { path: r.filePaths[0] };
  });

  ipcMain.handle('print:png', async (_e, dataUrl, mode, target) => {
    try {
      return await handlePrint(dataUrl, mode, target);
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('assoc:get', async () => assoc.getAssociation());

  ipcMain.handle('assoc:set', async (_e, enabled) => {
    if (typeof enabled !== 'boolean') return { error: '参数无效' };
    const appPath = app.isPackaged ? null : app.getAppPath();
    const result = await assoc.setAssociation(enabled, process.execPath, appPath);
    store.log('info', '文件关联：' + (enabled ? '注册' : '移除') + ' ' + JSON.stringify(result));
    return result;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const file = parseWbcArg(argv);
    if (file) sendMenu('open-path', file);
  });

  app.whenReady().then(async () => {
    store.log('info', '应用启动 v' + app.getVersion());
    if (!isSmoke) {
      const recovery = store.readRecovery();
      if (recovery) {
        const choice = dialog.showMessageBoxSync({
          type: 'question',
          buttons: ['恢复', '丢弃'],
          defaultId: 0,
          cancelId: 1,
          message: '发现未保存的编辑内容',
          detail: recovery.path ? '文件：' + recovery.path : '该内容来自上次异常退出。'
        });
        if (choice === 0) {
          startupState.recovery = recovery;
        } else {
          store.clearRecovery();
        }
      }
      if (!startupState.recovery) {
        const launchPath = parseWbcArg(process.argv);
        if (launchPath) startupState.openPath = launchPath;
      }
    }
    buildMenu();
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
