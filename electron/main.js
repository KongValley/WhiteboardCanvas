// SPDX-License-Identifier: GPL-3.0-or-later
const { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, nativeImage, shell } = require('electron');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const zip = require('./zip');
const assoc = require('./assoc');
const { createStore, DEFAULT_SETTINGS } = require('./store');

const isSmoke = process.argv.includes('--smoke');
const isE2E = process.argv.includes('--e2e');
const isTest = isSmoke || isE2E;
const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
if (isTest) {
  app.setPath('userData', path.join(app.getPath('temp'), 'wbc-test-userdata-' + process.pid));
}

const MAX_OPEN_SIZE = 100 * 1024 * 1024;
const MAX_DOC_TEXT = 256 * 1024 * 1024;
const MAX_IMAGE_URL = 300 * 1024 * 1024;

let primary = null;
const winStates = new Map();
const saveLocks = new Map();

function activeWin() {
  return BrowserWindow.getFocusedWindow() || primary;
}

function stateOf(w) {
  return w ? winStates.get(w.webContents.id) : null;
}

function portableRoot() {
  if (isTest) return null;
  if (process.argv.includes('--portable')) {
    return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  }
  const base = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  try {
    if (fs.existsSync(path.join(base, 'portable.txt')) || fs.existsSync(path.join(base, 'data'))) return base;
  } catch {
    /* 无便携标记 */
  }
  return null;
}

const portable = portableRoot();
const storeRoot = portable ? path.join(portable, 'data') : app.getPath('userData');
if (portable) fs.mkdirSync(storeRoot, { recursive: true });
const store = createStore(storeRoot);
process.on('uncaughtException', (err) => {
  store.log('error', '主进程未捕获异常：' + String((err && err.stack) || err));
});
process.on('unhandledRejection', (reason) => {
  store.log('error', '主进程未处理拒绝：' + String((reason && reason.stack) || reason));
});
let settings = store.loadSettings();
const startupState = { openPath: null };
if (settings.disableGpu || process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration();

// 无独显/核显不可用的老机器：让 Chromium 直接走软件光栅化，
// 避免 GPU 进程反复崩溃或合成器超时（表现为窗口黑屏/整体卡顿）。
if (process.argv.includes('--software-render') || settings.lowSpec) {
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-partial-raster');
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  app.disableHardwareAcceleration();
}

function errText(err) {
  return String((err && err.message) || err);
}

function sendMenu(action, arg, target) {
  const w = target || activeWin();
  if (w && !w.isDestroyed()) w.webContents.send('menu', action, arg);
}

function parseWbcArgs(argv) {
  const files = [];
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || !/\.wbc$/i.test(arg)) continue;
    try {
      const full = path.resolve(arg);
      if (fs.statSync(full).isFile() && !files.includes(full)) files.push(full);
    } catch {
      /* 不是可访问的路径 */
    }
  }
  return files;
}

function parseWbcArg(argv) {
  return parseWbcArgs(argv)[0] || null;
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

const ASSET_CACHE_BYTES = 128 * 1024 * 1024;
const assetCache = new Map();
let assetCacheBytes = 0;

function touchAssetCache(key, value) {
  const old = assetCache.get(key);
  if (old) assetCacheBytes -= old.data.length;
  assetCache.delete(key);
  assetCache.set(key, value);
  assetCacheBytes += value.data.length;
  while (assetCacheBytes > ASSET_CACHE_BYTES && assetCache.size > 1) {
    const first = assetCache.keys().next().value;
    const entry = assetCache.get(first);
    if (entry) assetCacheBytes -= entry.data.length;
    assetCache.delete(first);
  }
}

function docElementLists(doc) {
  if (Array.isArray(doc.pages)) {
    return doc.pages.map((page) => (page && Array.isArray(page.elements) ? page.elements : []));
  }
  if (Array.isArray(doc.elements)) return [doc.elements];
  return null;
}

/** v3：doc.json + assets/（按内容哈希去重；同一图片跨保存复用已解码数据） */
async function textToZip(text) {
  const doc = JSON.parse(text);
  const lists = doc && doc.app === 'whiteboard-canvas' ? docElementLists(doc) : null;
  if (!lists) throw new Error('文档格式不正确');
  doc.version = 3;
  const assets = new Map();
  for (const list of lists) {
    for (const el of list) {
      if (!el || el.type !== 'image' || typeof el.src !== 'string') continue;
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(el.src);
      if (!match) continue;
      const key = crypto.createHash('sha1').update(el.src).digest('hex');
      const cached = assetCache.get(key);
      if (cached) {
        assets.set(cached.name, cached.data);
        touchAssetCache(key, cached);
        el.src = 'asset:' + cached.name.slice(7);
        continue;
      }
      const data = Buffer.from(match[2], 'base64');
      const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 20);
      const name = `assets/${hash}.${extForMime(match[1])}`;
      assets.set(name, data);
      touchAssetCache(key, { name, data });
      el.src = 'asset:' + name.slice(7);
    }
  }
  const docBuf = Buffer.from(JSON.stringify(doc), 'utf8');
  const entries = [{ name: 'doc.json', data: docBuf, compress: true }];
  for (const [name, data] of assets) entries.push({ name, data });
  return { buffer: await zip.writeAsync(entries), jsonSize: docBuf.length, assets: assets.size };
}

/** v3 容器 → 内联 data URL 的 JSON 文本 */
function zipToText(buffer, filePath, report = []) {
  const files = zip.read(buffer);
  const docBuf = files.get('doc.json');
  if (!docBuf) throw new Error('文件缺少 doc.json');
  const doc = JSON.parse(docBuf.toString('utf8'));
  const lists = doc && doc.app === 'whiteboard-canvas' ? docElementLists(doc) : null;
  if (!lists) throw new Error('文件格式不正确');
  const version = Number(doc.version) || 2;
  if (version > 3) throw new Error(`该文件由更高版本创建（v${version}），请升级应用后再打开。`);
  for (let listIndex = 0; listIndex < lists.length; listIndex++) {
    const list = lists[listIndex];
    const kept = [];
    for (const el of list) {
      if (el && el.type === 'image' && typeof el.src === 'string' && el.src.startsWith('asset:')) {
        const name = 'assets/' + el.src.slice(6);
        const data = files.get(name);
        if (!data) {
          store.log('warn', `缺少图片资源 ${name}（${filePath}），已跳过该元素`);
          report.push(`缺少图片资源：${name}，已跳过该图片`);
          continue;
        }
        el.src = `data:${mimeForExt(name.split('.').pop())};base64,${data.toString('base64')}`;
      }
      kept.push(el);
    }
    if (Array.isArray(doc.pages)) doc.pages[listIndex].elements = kept;
    else doc.elements = kept;
  }
  return JSON.stringify(doc);
}

function openInNewWindow() {
  dialog
    .showOpenDialog(activeWin(), {
      title: '在新窗口打开白板',
      filters: [
        { name: '白板画布', extensions: ['wbc'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    .then((r) => {
      if (!r.canceled && r.filePaths[0]) createWindow(r.filePaths[0]);
    });
}

function restoreSession() {
  const paths = store.session().filter((file) => fs.existsSync(file)).slice(0, 10);
  if (!paths.length) {
    dialog.showMessageBoxSync(activeWin(), {
      type: 'info',
      title: '恢复上次会话',
      message: '没有可恢复的会话',
      detail: '最近打开/保存的文件不存在。',
      buttons: ['确定']
    });
    return;
  }
  for (const file of paths) createWindow(file);
  store.log('info', '恢复会话：' + paths.length + ' 个文件');
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(Number);
  const pb = String(b).replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'whiteboard-canvas-' + app.getVersion(), Accept: 'application/vnd.github+json' } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          resolve(fetchJson(new URL(response.headers.location, url).href));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('HTTP ' + response.statusCode));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024) request.destroy(new Error('响应过大'));
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('连接超时')));
  });
}

function checkForUpdates() {
  const en = store.loadSettings().language === 'en';
  const api = process.env.WBC_UPDATE_API || 'https://api.github.com/repos/kongvalley/whiteboard-canvas/releases/latest';
  fetchJson(api)
    .then((data) => {
      const latest = String(data.tag_name || data.name || '');
      const current = app.getVersion();
      if (!latest) throw new Error(en ? 'No version info' : '响应缺少版本信息');
      if (compareVersions(latest, current) <= 0) {
        dialog.showMessageBox(activeWin(), {
          type: 'info',
          title: en ? 'Check for updates' : '检查更新',
          message: en ? 'You are up to date.' : '已是最新版本',
          detail: (en ? 'Current version: ' : '当前版本：') + current,
          buttons: ['OK']
        });
        return;
      }
      const asset = Array.isArray(data.assets) ? data.assets.find((item) => /\.zip$/i.test(item.name || '')) : null;
      const link = (asset && asset.browser_download_url) || data.html_url || '';
      const choice = dialog.showMessageBoxSync(activeWin(), {
        type: 'info',
        title: en ? 'Update available' : '发现新版本',
        message: (en ? 'New version: ' : '新版本：') + latest,
        detail: (en ? 'Download the portable ZIP manually:\n' : '请手动下载便携 ZIP：\n') + link,
        buttons: link ? [en ? 'Open download page' : '打开下载页', en ? 'Later' : '稍后'] : ['OK'],
        defaultId: 0,
        cancelId: link ? 1 : 0
      });
      if (choice === 0 && link) shell.openExternal(link);
    })
    .catch((err) => {
      dialog.showMessageBox(activeWin(), {
        type: 'warning',
        title: en ? 'Check for updates' : '检查更新',
        message: en ? 'Unable to check for updates (offline?)' : '无法检查更新（可能处于离线状态）',
        detail: String(err && err.message ? err.message : err),
        buttons: ['OK']
      });
    });
}

function checkSignature() {
  if (process.platform !== 'win32' || !app.isPackaged) return Promise.resolve({ signed: false, note: '' });
  const exe = process.execPath;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        const text = String(stdout || '').trim();
        if (err || !text) return resolve({ signed: false, note: '' });
        const [status, subject] = text.split('|');
        resolve({ signed: status === 'Valid', note: subject || status });
      }
    );
  });
}

function checkWin7Compat() {
  if (process.platform !== 'win32') return;
  const release = os.release();
  if (!release.startsWith('6.1.')) return;
  const sp1 = release === '6.1.7601';
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const platformUpdate = fs.existsSync(path.join(winDir, 'System32', 'D3D11.dll'));
  if (!sp1 || !platformUpdate) {
    const en = store.loadSettings().language === 'en';
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Windows 7',
      message: en ? 'Windows 7 requires SP1 and Platform Update (KB2670838)' : 'Windows 7 需要 SP1 与 Platform Update（KB2670838）',
      detail: en
        ? 'Detected: ' + release + (platformUpdate ? '' : ' (D3D11.dll missing)')
        : '检测到：' + release + (platformUpdate ? '' : '（缺少 D3D11.dll）') + '\n未安装补丁时可能出现白屏或崩溃。',
      buttons: ['OK']
    });
    store.log('warn', 'Win7 兼容检查未通过：' + release + ' platformUpdate=' + platformUpdate);
  } else {
    store.log('info', 'Win7 兼容检查通过：' + release + ' SP1 + Platform Update');
  }
  suggestLowSpec();
}

/** Win7 老机器：首次启动时提示开启低配模式（可随时在设置里修改） */
function suggestLowSpec() {
  const ps = store.loadSettings();
  if (ps.lowSpec) return;
  const marker = path.join(app.getPath('userData'), 'low-spec-prompted.txt');
  try {
    if (fs.existsSync(marker)) return;
    fs.writeFileSync(marker, String(Date.now()), 'utf8');
  } catch {
    /* 无法写入标记则不提示 */
    return;
  }
  const en = ps.language === 'en';
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: en ? 'Windows 7' : 'Windows 7',
    message: en ? 'Enable low-spec mode?' : '是否开启低配模式？',
    detail: en
      ? 'Low-spec mode hides the minimap and rulers to reduce CPU usage on older computers.\nYou can change this later in Settings.'
      : '低配模式会隐藏小地图与标尺，明显降低老旧电脑的 CPU 占用。\n之后仍可在「设置」中修改。',
    buttons: [en ? 'Enable' : '开启', en ? 'Later' : '暂不'],
    defaultId: 0,
    cancelId: 1
  });
  if (choice === 0) {
    store.saveSettings({ lowSpec: true });
    store.log('info', '已开启低配模式');
  }
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
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: '在新窗口打开…', click: () => openInNewWindow() },
        { label: '恢复上次会话', click: () => restoreSession() },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { label: '立即备份', click: () => sendMenu('backup-now') },
        { label: '恢复自动备份…', click: () => sendMenu('restore-backup') },
        { type: 'separator' },
        { label: '导出 PNG…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export-png') },
        { label: '导出 SVG…', click: () => sendMenu('export-svg') },
        { label: '导出 PDF…', click: () => sendMenu('export-pdf') },
        { label: '导出所有页面 PDF…', click: () => sendMenu('export-pages-pdf') },
        { label: '导出所有页面 PNG ZIP…', click: () => sendMenu('export-pages-png-zip') },
        { label: '导出所有页面 SVG ZIP…', click: () => sendMenu('export-pages-svg-zip') },
        { label: '打印…', accelerator: 'CmdOrCtrl+P', click: () => sendMenu('print') },
        { type: 'separator' },
        { label: '保存当前页为模板…', click: () => sendMenu('save-template') },
        { label: '设置…', click: () => sendMenu('settings') },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', click: () => sendMenu('undo') },
        { label: '重做', click: () => sendMenu('redo') },
        { type: 'separator' },
        { label: '剪切', click: () => sendMenu('cut') },
        { label: '复制', click: () => sendMenu('copy') },
        { label: '粘贴', click: () => sendMenu('paste') },
        { label: '删除', click: () => sendMenu('delete') },
        { label: '全选', click: () => sendMenu('select-all') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '图层面板', click: () => sendMenu('toggle-panels') },
        { label: '搜索画布', click: () => sendMenu('search') },
        { label: '标尺', click: () => sendMenu('toggle-rulers') },
        { label: '页面缩略图', click: () => sendMenu('toggle-page-thumbs') },
        { label: '只读模式', click: () => sendMenu('toggle-readonly') },
        { label: '演示模式', click: () => sendMenu('present') },
        { type: 'separator' },
        { label: '放大', click: () => sendMenu('zoom-in') },
        { label: '缩小', click: () => sendMenu('zoom-out') },
        { label: '适应内容', click: () => sendMenu('zoom-fit') }
      ]
    },
    {
      label: '页面',
      submenu: [
        { label: '新建页面', click: () => sendMenu('page-new') },
        { label: '复制当前页面', click: () => sendMenu('page-duplicate') },
        { label: '重命名页面…', click: () => sendMenu('page-rename') },
        { label: '上移页面', click: () => sendMenu('page-up') },
        { label: '下移页面', click: () => sendMenu('page-down') },
        { type: 'separator' },
        { label: '删除当前页面', click: () => sendMenu('page-delete') },
        { label: '导出所有页面 PDF…', click: () => sendMenu('export-pages-pdf') },
        { label: '导出所有页面 PNG ZIP…', click: () => sendMenu('export-pages-png-zip') },
        { label: '导出所有页面 SVG ZIP…', click: () => sendMenu('export-pages-svg-zip') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键', accelerator: 'F1', click: () => sendMenu('help') },
        { label: '检查更新…', click: () => checkForUpdates() },
        { label: '关于', click: () => showAbout() }
      ]
    }
  ];
  const lang = store.loadSettings().language;
  const enMenu = {
    '文件': 'File',
    '编辑': 'Edit',
    '视图': 'View',
    '撤销': 'Undo',
    '重做': 'Redo',
    '剪切': 'Cut',
    '复制': 'Copy',
    '粘贴': 'Paste',
    '删除': 'Delete',
    '全选': 'Select all',
    '放大': 'Zoom in',
    '缩小': 'Zoom out',
    '适应内容': 'Fit content',
    '检查更新…': 'Check for updates…',
    '新建': 'New',
    '打开…': 'Open…',
    '最近文件': 'Recent files',
    '（空）': '(empty)',
    '清除最近文件': 'Clear recent files',
    '新建窗口': 'New window',
    '在新窗口打开…': 'Open in new window…',
    '恢复上次会话': 'Restore last session',
    '保存': 'Save',
    '另存为…': 'Save as…',
    '立即备份': 'Back up now',
    '恢复自动备份…': 'Restore backup…',
    '导出 PNG…': 'Export PNG…',
    '导出 SVG…': 'Export SVG…',
    '导出 PDF…': 'Export PDF…',
    '导出所有页面 PDF…': 'Export all pages as PDF…',
    '导出所有页面 PNG ZIP…': 'Export all pages as PNG ZIP…',
    '导出所有页面 SVG ZIP…': 'Export all pages as SVG ZIP…',
    '打印…': 'Print…',
    '页面': 'Page',
    '新建页面': 'New page',
    '复制当前页面': 'Duplicate current page',
    '重命名页面…': 'Rename page…',
    '上移页面': 'Move page up',
    '下移页面': 'Move page down',
    '删除当前页面': 'Delete current page',
    '查看': 'View',
    '图层面板': 'Layers panel',
    '搜索画布': 'Search canvas',
    '标尺': 'Rulers',
    '页面缩略图': 'Page thumbnails',
    '只读模式': 'Read-only mode',
    '演示模式': 'Presentation mode',
    '保存当前页为模板…': 'Save current page as template…',
    '设置…': 'Settings…',
    '退出': 'Quit',
    '帮助': 'Help',
    '快捷键': 'Shortcuts',
    '关于': 'About',
    '缺失': 'missing'
  };
  const ml = (label) => (lang === 'en' ? enMenu[label] || label : label);
  const translateMenu = (items) => {
    for (const item of items) {
      if (item.label) item.label = ml(item.label);
      if (item.submenu) translateMenu(item.submenu);
    }
  };
  translateMenu(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showAbout() {
  const en = store.loadSettings().language === 'en';
  const signature = await checkSignature();
  const sigText = en
    ? (signature.signed ? 'Signed: ' + signature.note : 'Unsigned build: SmartScreen may warn; this is expected for the portable ZIP.')
    : (signature.signed ? '已签名：' + signature.note : '未签名构建：SmartScreen 可能提示，便携 ZIP 属正常现象。');
  dialog.showMessageBox(activeWin(), {
    type: 'info',
    title: en ? 'About Whiteboard Canvas' : '关于白板画布',
    message: (en ? 'Whiteboard Canvas v' : '白板画布 v') + app.getVersion(),
    detail: en
      ? 'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome + '\n' +
        'License: GPL-3.0-or-later\n' + sigText + '\n' +
        'Portable build: unzip and run; no system-level registry writes.'
      : 'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome + '\n' +
        '许可证：GPL-3.0-or-later\n' + sigText + '\n' +
        '免安装便携版：解压即用，不写系统级注册表。',
    buttons: [en ? 'OK' : '确定']
  });
}

function createWindow(filePath, recoveryKey) {
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
  const w = new BrowserWindow(opts);
  if (!primary) primary = w;
  const webContentsId = w.webContents.id;
  winStates.set(webContentsId, {
    win: w,
    dirty: false,
    allowClose: false,
    closePending: false,
    recoveryKey: typeof recoveryKey === 'string' ? recoveryKey : null
  });

  if (isSmoke) {
    w.webContents.once('did-finish-load', () => {
      require('./smoke')(w).then((code) => app.exit(code));
    });
    w.loadFile(indexPath, { query: { smoke: '1' } });
  } else {
    w.once('ready-to-show', () => w.show());
    const query = {};
    if (filePath) query.open = filePath;
    if (isE2E) query.smoke = '1';
    w.loadFile(indexPath, Object.keys(query).length ? { query } : undefined);
  }

  w.on('close', (e) => {
    const st = stateOf(w);
    if (isTest || !st || st.allowClose) return;
    if (!st.dirty) return;
    e.preventDefault();
    if (st.closePending) return;
    const behavior = store.loadSettings().closeBehavior;
    if (behavior === 'discard') {
      if (st.recoveryKey) store.clearRecovery(st.recoveryKey);
      st.allowClose = true;
      w.close();
      return;
    }
    if (behavior === 'ask') {
      const choice = dialog.showMessageBoxSync(w, {
        type: 'warning',
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        message: '文档尚未保存',
        detail: '是否保存更改？'
      });
      if (choice === 2) return;
      if (choice === 1) {
        if (st.recoveryKey) store.clearRecovery(st.recoveryKey);
        st.allowClose = true;
        w.close();
        return;
      }
    }
    st.closePending = true;
    void requestSave(w).then((ok) => {
      st.closePending = false;
      if (ok) {
        st.allowClose = true;
        w.close();
      }
    });
  });
  w.on('closed', () => {
    winStates.delete(webContentsId);
    if (w === primary) primary = null;
  });

  w.webContents.on('render-process-gone', (_e, details) => {
    store.log('error', '渲染进程退出：' + JSON.stringify(details));
  });
  w.webContents.on('did-fail-load', (_e, code, description) => {
    store.log('error', `页面加载失败 ${code} ${description}`);
  });
  return w;
}

function requestSave(w) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('save-result', handler);
      resolve(false);
    }, 60000);
    const handler = (e, result) => {
      if (e.sender.id !== w.webContents.id) return;
      clearTimeout(timer);
      ipcMain.removeListener('save-result', handler);
      resolve(!!result);
    };
    ipcMain.on('save-result', handler);
    w.webContents.send('request-save');
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
  const r = await dialog.showSaveDialog(activeWin(), {
    title,
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return null;
  let target = r.filePath;
  if (!new RegExp('\\.' + ext + '$', 'i').test(target)) target += '.' + ext;
  return target;
}

const ELEMENT_TYPES = new Set(['text', 'image', 'ink', 'rect', 'ellipse', 'arrow', 'poly']);

/** 从截断 JSON 中扫描完整元素对象 */
function salvageElements(text) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    const frag = text.slice(i, end + 1);
    try {
      const obj = JSON.parse(frag);
      if (obj && ELEMENT_TYPES.has(obj.type) && typeof obj.id === 'string' && !seen.has(obj.id)) {
        seen.add(obj.id);
        out.push(obj);
        i = end;
      }
    } catch {
      /* 继续扫描 */
    }
  }
  return out;
}

function repairDocumentBuffer(buffer, target) {
  try {
    let text = null;
    let files = null;
    if (isZipFile(buffer)) {
      try {
        files = zip.read(buffer);
      } catch {
        files = zip.readLenient(buffer);
      }
      const docBuf = files.get('doc.json');
      if (docBuf) text = docBuf.toString('utf8');
    } else {
      text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    }
    if (!text) return null;
    const elements = salvageElements(text);
    if (!elements.length) return null;
    if (files) {
      for (const el of elements) {
        if (el.type !== 'image' || typeof el.src !== 'string' || !el.src.startsWith('asset:')) continue;
        const data = files.get('assets/' + el.src.slice(6));
        if (data) el.src = 'data:' + mimeForExt(String(el.src).split('.').pop()) + ';base64,' + data.toString('base64');
        else delete el.src;
      }
    }
    store.log('warn', `文件损坏，已恢复 ${elements.length} 个元素：${target}`);
    return {
      app: 'whiteboard-canvas',
      version: 3,
      pages: [{ id: 'recovered-' + Date.now().toString(36), name: '恢复页面', elements }]
    };
  } catch {
    return null;
  }
}

async function readDocumentFile(target) {
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) throw new Error('不是有效文件');
  if (stat.size > MAX_OPEN_SIZE) {
    const choice = dialog.showMessageBoxSync(activeWin(), {
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
  const stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  const report = [];
  try {
    if (isZipFile(buffer)) {
      return { path: target, text: zipToText(buffer, target, report), stamp, report };
    }
    let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.app !== 'whiteboard-canvas' ||
      (!Array.isArray(parsed.elements) && !Array.isArray(parsed.pages))) {
      throw new Error('文件格式不正确');
    }
    const version = Number(parsed.version) || 1;
    if (version > 3) {
      return { error: `该文件由更高版本创建（v${version}），请升级应用后再打开。` };
    }
    if (version < 3) {
      await store.backupBuffer(buffer, target);
      parsed.version = 3;
      text = JSON.stringify(parsed);
      report.push(`已从 v${version} 迁移为 v3，原文件已备份`);
      store.log('info', `已将 v${version} JSON 文件迁移为 v3：${target}`);
    }
    return { path: target, text, stamp, report };
  } catch (err) {
    const repaired = repairDocumentBuffer(buffer, target);
    if (repaired) {
      const count = Array.isArray(repaired.pages) ? repaired.pages.reduce((sum, page) => sum + (page.elements ? page.elements.length : 0), 0) : 0;
      report.push(`文件损坏，已尽力恢复 ${count} 个元素；请另存为`);
      return { path: target, text: JSON.stringify(repaired), repaired: true, stamp, report };
    }
    throw err;
  }
}

function asStamp(value) {
  if (!value || typeof value !== 'object') return null;
  const mtimeMs = Number(value.mtimeMs);
  const size = Number(value.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size) || mtimeMs < 0 || size < 0) return null;
  return { mtimeMs, size };
}

function sameStamp(a, b) {
  if (!a || !b) return false;
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 0.5;
}

async function fileStamp(target) {
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function lockKeyFor(target) {
  try {
    return fs.realpathSync.native(target).toLowerCase();
  } catch {
    return path.resolve(target).toLowerCase();
  }
}

function withPathLock(key, task) {
  const prev = saveLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  saveLocks.set(key, tail);
  tail.finally(() => {
    if (saveLocks.get(key) === tail) saveLocks.delete(key);
  });
  return run;
}

async function saveDocument(args) {
  const rawPath = args.path === null || args.path === undefined ? null : asString(args.path, 4096, 'path');
  if (!rawPath) return saveDocumentUnlocked(args);
  return withPathLock(lockKeyFor(rawPath), () => saveDocumentUnlocked(args));
}

async function saveDocumentUnlocked(args) {
  const given = args.path === null || args.path === undefined ? null : asString(args.path, 4096, 'path');
  let text = asString(args.text, MAX_DOC_TEXT, 'text');
  const silent = args.silent === undefined ? false : asBool(args.silent, 'silent');
  const expected = asStamp(args.expected);
  let target = given;
  if (!target) {
    if (silent) return { error: '未指定保存路径' };
    target = await chooseSavePath('保存白板', '未命名.wbc', 'wbc');
    if (!target) return { canceled: true };
    return withPathLock(lockKeyFor(target), () => saveDocumentUnlocked({ ...args, path: target }));
  }

  // 外部修改检测：打开/上次保存后文件被其他程序改过，先让用户决定
  if (expected) {
    const current = await fileStamp(target);
    if (!sameStamp(current, expected)) {
      if (silent) return { conflict: true, stamp: current, error: '文件已被外部修改' };
      if (isTest) return { conflict: true, stamp: current, path: target };
      const buttons = current ? ['重新载入', '另存为…', '覆盖', '取消'] : ['另存为…', '覆盖', '取消'];
      const reloadIndex = current ? 0 : -1;
      const saveAsIndex = current ? 1 : 0;
      const cancelIndex = current ? 3 : 2;
      const choice = dialog.showMessageBoxSync(activeWin(), {
        type: 'warning',
        buttons,
        defaultId: cancelIndex,
        cancelId: cancelIndex,
        message: '文件已被外部修改',
        detail:
          (current
            ? '磁盘上的文件与打开时不一致：' + target + '\n请选择重新载入外部版本、另存为或覆盖。'
            : '磁盘上的文件已被删除或移动：' + target + '\n请选择另存为或覆盖。')
      });
      if (choice === cancelIndex) return { canceled: true };
      if (choice === reloadIndex) {
        const loaded = await readDocumentFile(target);
        if (loaded.error || typeof loaded.text !== 'string') return { error: loaded.error || '重新载入失败' };
        return { reload: true, path: target, text: loaded.text, stamp: loaded.stamp || (await fileStamp(target)) };
      }
      if (choice === saveAsIndex) {
        const alt = await chooseSavePath('另存为白板', path.basename(target), 'wbc');
        if (!alt) return { canceled: true };
        target = alt;
      }
      /* overwrite：继续写入 */
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
      const choice = dialog.showMessageBoxSync(activeWin(), {
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

  // 覆盖前先备份磁盘上的版本（包含被外部修改的情况）
  if (!silent) {
    try {
      if (fs.statSync(target).isFile()) await store.backupFile(target);
    } catch {
      /* 新文件无备份 */
    }
  }

  let payload;
  try {
    payload = (await textToZip(text)).buffer;
  } catch (err) {
    return { error: '文档序列化失败：' + errText(err) };
  }

  for (;;) {
    const tmp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    try {
      const handle = await fs.promises.open(tmp, 'w');
      try {
        await handle.writeFile(payload);
        // 部分网络盘/文件系统不支持 fsync，失败不影响原子改名
        await handle.sync().catch(() => {});
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tmp, target);
      const stamp = await fileStamp(target);
      store.addRecent(target);
      store.addSession(target);
      store.log('info', '保存文档：' + target);
      buildMenu();
      return { path: target, stamp };
    } catch (err) {
      store.log('error', '保存失败：' + errText(err));
      try {
        await fs.promises.unlink(tmp);
      } catch {
        /* 临时文件可能不存在 */
      }
      if (silent) return { error: errText(err) };
      const choice = dialog.showMessageBoxSync(activeWin(), {
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

function validPngUrl(value) {
  return typeof value === 'string' && value.length <= MAX_IMAGE_URL && value.startsWith('data:image/png;base64,');
}

async function handlePrintPages(dataUrls, mode, givenTarget) {
  if (!Array.isArray(dataUrls) || !dataUrls.length || dataUrls.length > 200 || !dataUrls.every(validPngUrl)) {
    return { error: '参数无效：图片列表' };
  }
  if (mode !== 'pdf' && mode !== 'print') return { error: '参数无效：mode' };
  const ps = store.loadSettings();
  const landscape = ps.printOrientation !== 'portrait';
  const pageSize = ps.printPageSize === 'Letter' ? 'Letter' : 'A4';
  const stamp = `${process.pid}-${Date.now()}`;
  const files = [];
  const htmlPath = path.join(app.getPath('temp'), `wbc-print-${stamp}.html`);
  const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const images = [];
    for (let i = 0; i < dataUrls.length; i++) {
      const file = path.join(app.getPath('temp'), `wbc-print-${stamp}-${i}.png`);
      await fs.promises.writeFile(file, Buffer.from(dataUrls[i].slice(dataUrls[i].indexOf(',') + 1), 'base64'));
      files.push(file);
      images.push(`<img class="page" src="${pathToFileURL(file).href}">`);
    }
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      `@page{size:${pageSize} ${landscape ? 'landscape' : 'portrait'};margin:8mm}html,body{margin:0;padding:0}` +
      '.page{display:block;width:100%;height:100vh;object-fit:contain;page-break-after:always}' +
      '.page:last-child{page-break-after:auto}</style></head><body>' + images.join('') + '</body></html>';
    await fs.promises.writeFile(htmlPath, html, 'utf8');
    await printWin.loadFile(htmlPath);
    if (mode === 'pdf') {
      const pdf = await printWin.webContents.printToPDF({
        landscape,
        pageSize,
        printBackground: true,
        margins: { marginType: 'default' }
      });
      let target = typeof givenTarget === 'string' && givenTarget ? asString(givenTarget, 4096, 'target') : null;
      if (!target) target = await chooseSavePath('导出 PDF', '白板.pdf', 'pdf');
      if (!target) return { canceled: true };
      await fs.promises.writeFile(target, pdf);
      store.log('info', '导出多页 PDF：' + target);
      return { path: target };
    }
    return await new Promise((resolve) => {
      printWin.webContents.print({ silent: false, printBackground: true, landscape, pageSize }, (success, reason) => {
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
    for (const file of [...files, htmlPath]) {
      try {
        await fs.promises.unlink(file);
      } catch {
        /* 忽略 */
      }
    }
  }
}

async function handlePrint(dataUrl, mode, givenTarget) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_URL || !dataUrl.startsWith('data:image/png;base64,')) {
    return { error: '参数无效：dataUrl' };
  }
  if (mode !== 'pdf' && mode !== 'print') return { error: '参数无效：mode' };
  const ps = store.loadSettings();
  const landscape = ps.printOrientation !== 'portrait';
  const pageSize = ps.printPageSize === 'Letter' ? 'Letter' : 'A4';
  const stamp = `${process.pid}-${Date.now()}`;
  const pngPath = path.join(app.getPath('temp'), `wbc-print-${stamp}.png`);
  const htmlPath = path.join(app.getPath('temp'), `wbc-print-${stamp}.html`);
  const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await fs.promises.writeFile(pngPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      `@page{size:${pageSize} ${landscape ? 'landscape' : 'portrait'};margin:8mm}html,body{margin:0;width:100%;height:100%}` +
      'img{width:100%;height:100%;object-fit:contain}</style></head><body>' +
      `<img src="${pathToFileURL(pngPath).href}"></body></html>`;
    await fs.promises.writeFile(htmlPath, html, 'utf8');
    await printWin.loadFile(htmlPath);
    if (mode === 'pdf') {
      const pdf = await printWin.webContents.printToPDF({
        landscape,
        pageSize,
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
      printWin.webContents.print({ silent: false, printBackground: true, landscape, pageSize }, (success, reason) => {
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
  if (isTest) {
    ipcMain.handle('test:new-window', async () => {
      createWindow();
      return true;
    });
    ipcMain.handle('test:user-data', async () => app.getPath('userData'));
  }

  ipcMain.handle('app:startup', async (e) => {
    const windowState = winStates.get(e.sender.id);
    const isPrimary = primary && e.sender.id === primary.webContents.id;
    const recovery = windowState && windowState.recoveryKey ? store.readRecovery(windowState.recoveryKey) : null;
    const state = {
      settings: isTest ? { ...DEFAULT_SETTINGS } : store.loadSettings(),
      recovery,
      openPath: isPrimary && !recovery ? startupState.openPath : null
    };
    if (isPrimary && !recovery) startupState.openPath = null;
    return state;
  });

  ipcMain.handle('doc:open', async (_e, filePath) => {
    try {
      let target = filePath === undefined || filePath === null ? null : asString(filePath, 4096, 'path', false);
      if (!target) {
        const r = await dialog.showOpenDialog(activeWin(), {
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
        store.addSession(result.path);
        store.log('info', '打开文档：' + result.path);
        buildMenu();
      }
      return result;
    } catch (err) {
      store.log('error', '打开失败：' + errText(err));
      return { error: errText(err) };
    }
  });

  ipcMain.handle('doc:save', async (e, args) => {
    if (!args || typeof args !== 'object') return { error: '参数无效：args' };
    try {
      const result = await saveDocument(args);
      if (result.path && !result.reload && !result.conflict) {
        const windowState = winStates.get(e.sender.id);
        if (windowState && windowState.recoveryKey) store.clearRecovery(windowState.recoveryKey);
      }
      return result;
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

  ipcMain.handle('shell:open-external', async (_e, url) => {
    try {
      const target = asString(url, 2048, 'url', false);
      if (!/^https?:\/\//i.test(target)) return { error: '仅支持 http/https' };
      await shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('app:info', async (_e, title, detail) => {
    if (isTest) {
      store.log('info', '打开报告：' + String(title) + ' ' + String(detail).slice(0, 1000));
      return;
    }
    await dialog.showMessageBox(activeWin(), {
      type: 'info',
      title: typeof title === 'string' ? title.slice(0, 200) : '提示',
      message: typeof title === 'string' ? title.slice(0, 200) : '提示',
      detail: typeof detail === 'string' ? detail.slice(0, 8000) : '',
      buttons: ['确定']
    });
  });

  ipcMain.on('app:log', (_e, level, message) => {
    if (typeof message !== 'string') return;
    store.log(['info', 'warn', 'error'].includes(level) ? level : 'info', message.slice(0, 8000));
  });

  ipcMain.handle('app:confirm', async (_e, message, detail) => {
    const msg = typeof message === 'string' ? message.slice(0, 1000) : '';
    if (!msg) return false;
    const r = await dialog.showMessageBox(activeWin(), {
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

  ipcMain.on('clipboard:write-elements', (_e, text) => {
    if (typeof text !== 'string' || text.length > 32 * 1024 * 1024) return;
    clipboard.writeBuffer('application/x-whiteboard-canvas-elements', Buffer.from(text, 'utf8'));
  });

  ipcMain.handle('clipboard:read-elements', async () => {
    try {
      const buffer = clipboard.readBuffer('application/x-whiteboard-canvas-elements');
      if (buffer && buffer.length) return buffer.toString('utf8').slice(0, 32 * 1024 * 1024);
    } catch {
      /* 无自定义格式 */
    }
    return clipboard.readText().slice(0, 32 * 1024 * 1024);
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
    const r = await dialog.showMessageBox(activeWin(), {
      type: 'question',
      buttons: ['继续', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '未保存的更改将丢失',
      detail: '是否继续？'
    });
    return r.response === 0;
  });

  ipcMain.on('doc:dirty', (e, value) => {
    const st = winStates.get(e.sender.id);
    if (st) st.dirty = value === true;
  });

  ipcMain.on('save-result', () => {
    /* 由 close 流程中的 ipcMain.once 消费 */
  });

  ipcMain.handle('win:set-fullscreen', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return false;
    const was = w.isFullScreen();
    w.setFullScreen(on === true);
    return was;
  });

  ipcMain.handle('settings:get', async () => store.loadSettings());

  ipcMain.handle('settings:set', async (_e, patch) => {
    if (!patch || typeof patch !== 'object') return { error: '参数无效' };
    try {
      settings = store.saveSettings(patch);
      store.log('info', '更新设置：' + JSON.stringify(settings));
      buildMenu();
      return settings;
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.on('recovery:init', (e, key) => {
    const windowState = winStates.get(e.sender.id);
    if (!windowState) return;
    if (typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key)) windowState.recoveryKey = key;
  });

  ipcMain.on('recovery:write', (e, text, filePath, key, stamp) => {
    if (typeof text !== 'string' || typeof filePath !== 'string') return;
    const windowState = winStates.get(e.sender.id);
    const targetKey = typeof key === 'string' && key ? key : windowState && windowState.recoveryKey;
    if (!targetKey) return;
    if (windowState && !windowState.recoveryKey) windowState.recoveryKey = targetKey;
    store.writeRecovery(targetKey, text, filePath || null, stamp);
  });

  ipcMain.on('recovery:clear', (e, key) => {
    const windowState = winStates.get(e.sender.id);
    const targetKey = typeof key === 'string' && key ? key : windowState && windowState.recoveryKey;
    if (targetKey) store.clearRecovery(targetKey);
  });

  ipcMain.handle('backup:now', async (e, text, filePath, docKey) => {
    try {
      const safeText = asString(text, MAX_DOC_TEXT, 'text');
      const safePath = typeof filePath === 'string' ? asString(filePath, 4096, 'path') : null;
      const windowState = winStates.get(e.sender.id);
      const key = typeof docKey === 'string' && docKey ? docKey : windowState && windowState.recoveryKey;
      const payload = await textToZip(safeText);
      const file = await store.backupBuffer(payload.buffer, safePath, key);
      return file ? { path: file } : { error: '备份失败' };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('backup:list', async () => store.listBackups());

  ipcMain.handle('backup:delete', async (_e, target) => {
    try {
      const file = asString(target, 4096, 'path', false);
      const backupsDir = path.resolve(store.dirs.backupsDir);
      if (path.dirname(path.resolve(file)) !== backupsDir) return { error: '参数无效：路径' };
      await fs.promises.unlink(file);
      return { ok: true };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('backup:restore', async () => {
    const backups = store.listBackups();
    const r = await dialog.showOpenDialog(activeWin(), {
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

  ipcMain.handle('print:pages', async (_e, dataUrls, mode, target) => {
    try {
      return await handlePrintPages(dataUrls, mode, target);
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('export:zip', async (_e, entries, defaultName, given) => {
    try {
      if (!Array.isArray(entries) || !entries.length || entries.length > 500) return { error: '参数无效：文件列表' };
      const files = [];
      for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.data !== 'string') return { error: '参数无效：文件项' };
        const name = entry.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const data = entry.base64
          ? Buffer.from(entry.data.slice(entry.data.indexOf(',') + 1), 'base64')
          : Buffer.from(entry.data, 'utf8');
        files.push({ name, data });
      }
      let target = typeof given === 'string' && given ? asString(given, 4096, 'path', false) : null;
      if (!target) {
        target = await chooseSavePath('导出所有页面', (defaultName || '白板页面') + '.zip', 'zip');
        if (!target) return { canceled: true };
      }
      await fs.promises.writeFile(target, zip.write(files));
      store.log('info', '导出页面 ZIP：' + target);
      return { path: target };
    } catch (err) {
      return { error: errText(err) };
    }
  });

  ipcMain.handle('svg:save', async (_e, svg, given) => {
    try {
      const text = asString(svg, 64 * 1024 * 1024, 'svg', false);
      let target = given === undefined || given === null ? null : asString(given, 4096, 'path', false);
      if (!target) target = await chooseSavePath('导出 SVG', '白板.svg', 'svg');
      if (!target) return { canceled: true };
      await fs.promises.writeFile(target, text, 'utf8');
      store.log('info', '导出 SVG：' + target);
      return { path: target };
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

/**
 * GPU 进程看门狗：核显驱动异常时 GPU 进程会反复退出，
 * 此时自动切换到软件光栅化并提示用户，避免窗口空白或持续卡顿。
 */
function installGpuWatchdog() {
  let gpuCrashes = 0;
  let warned = false;
  app.on('gpu-process-crashed', (_e, details) => {
    gpuCrashes += 1;
    store.log('error', 'GPU 进程崩溃：' + JSON.stringify(details));
    if (gpuCrashes < 2 || warned) return;
    warned = true;
    const en = store.loadSettings().language === 'en';
    store.saveSettings({ disableGpu: true });
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: en ? 'Graphics' : '显卡',
      message: en ? 'Graphics acceleration crashed. Switch to software rendering?' : '硬件加速已崩溃，是否切换为软件渲染？',
      detail: en
        ? 'Your graphics driver may be outdated. Software rendering is slower but stable.\nThe app will restart.'
        : '显卡驱动可能过旧或不稳定。软件渲染速度较慢但更稳定。\n应用将自动重启。',
      buttons: [en ? 'Restart now' : '立即重启', en ? 'Later' : '稍后'],
      defaultId: 0,
      cancelId: 1
    });
    if (choice === 0) {
      app.relaunch();
      app.exit(0);
    }
  });
}

const gotLock = app.requestSingleInstanceLock();if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const w = activeWin();
    if (!w) {
      const file = parseWbcArg(argv);
      app.whenReady().then(() => createWindow(file));
      return;
    }
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    const file = parseWbcArg(argv);
    if (file) sendMenu('open-path', file, w);
  });

  app.whenReady().then(async () => {
    store.log('info', '应用启动 v' + app.getVersion());
    checkWin7Compat();
    buildMenu();
    registerIpc();
    installGpuWatchdog();
    if (isTest) {
      createWindow();
      return;
    }

    const recoveries = store.listRecoveries();
    let restored = 0;
    for (const recovery of recoveries) {
      const when = recovery.at ? new Date(recovery.at).toLocaleString() : '未知时间';
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['恢复', '丢弃'],
        defaultId: 0,
        cancelId: 1,
        message: '发现未保存的编辑内容',
        detail: (recovery.path ? '文件：' + recovery.path : '未命名文档') + '\n时间：' + when + '\n恢复后将打开独立窗口。'
      });
      if (choice === 0) {
        createWindow(null, recovery.key);
        restored += 1;
      } else {
        store.clearRecovery(recovery.key);
      }
    }
    if (restored > 0) {
      store.log('info', '恢复未保存窗口：' + restored);
      return;
    }

    const launchFiles = parseWbcArgs(process.argv).slice(0, 11);
    if (launchFiles[0]) startupState.openPath = launchFiles[0];
    createWindow();
    for (const file of launchFiles.slice(1)) createWindow(file);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
