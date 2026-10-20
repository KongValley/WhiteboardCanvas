// SPDX-License-Identifier: GPL-3.0-or-later
// 用户数据：设置、日志、最近文件、自动备份、崩溃恢复快照。
const fs = require('fs');
const path = require('path');

const LOG_MAX = 1024 * 1024;
const RECENT_LIMIT = 10;
const BACKUP_LIMIT = 5;
const RECOVERY_TEXT_MAX = 120 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  autosaveDelay: 1,
  closeBehavior: 'ask',
  disableGpu: false,
  lowSpec: false,
  background: 'dots',
  gridSize: 24,
  theme: 'light',
  language: 'zh',
  exportBackground: true,
  printOrientation: 'landscape',
  printPageSize: 'A4',
  template: 'blank',
  shortcuts: {}
};

function cleanShortcuts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw).slice(0, 100)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(key)) continue;
    if (typeof value !== 'string' || value.length > 40) continue;
    out[key] = value;
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function validateSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  out.autosaveDelay = clampInt(raw.autosaveDelay, 0, 60, DEFAULT_SETTINGS.autosaveDelay);
  out.closeBehavior = ['ask', 'save', 'discard'].includes(raw.closeBehavior) ? raw.closeBehavior : DEFAULT_SETTINGS.closeBehavior;
  out.disableGpu = raw.disableGpu === true;
  out.lowSpec = raw.lowSpec === true;
  out.background = ['dots', 'grid', 'plain', 'cream'].includes(raw.background) ? raw.background : DEFAULT_SETTINGS.background;
  out.gridSize = [8, 16, 24, 32].includes(Number(raw.gridSize)) ? Number(raw.gridSize) : DEFAULT_SETTINGS.gridSize;
  out.theme = raw.theme === 'dark' ? 'dark' : 'light';
  out.language = raw.language === 'en' ? 'en' : 'zh';
  out.exportBackground = raw.exportBackground !== false;
  out.printOrientation = raw.printOrientation === 'portrait' ? 'portrait' : 'landscape';
  out.printPageSize = raw.printPageSize === 'Letter' ? 'Letter' : 'A4';
  out.template = typeof raw.template === 'string' ? raw.template.slice(0, 32) : 'blank';
  out.shortcuts = cleanShortcuts(raw.shortcuts);
  return out;
}

function timestamp(now = Date.now()) {
  const date = new Date(now);
  const p = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`
  );
}

function safeBaseName(filePath) {
  if (!filePath) return '未命名';
  const base = path.basename(filePath).replace(/\.wbc$/i, '');
  return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名';
}

function safeKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function shortKey(value) {
  const key = safeKey(value);
  return key ? key.slice(-10) : '';
}

function createStore(userData) {
  const logsDir = path.join(userData, 'logs');
  const backupsDir = path.join(userData, 'backups');
  const recoveryDir = path.join(userData, 'recovery');
  const logFile = path.join(logsDir, 'main.log');
  const settingsFile = path.join(userData, 'settings.json');
  const recentFile = path.join(userData, 'recent.json');
  const sessionFile = path.join(userData, 'session.json');
  // 旧版单份快照，首次启动时迁移为按窗口/文档分文件
  const legacyRecoveryFile = path.join(userData, 'recovery.wbc');
  const legacyRecoveryMetaFile = path.join(userData, 'recovery.json');
  for (const dir of [logsDir, backupsDir, recoveryDir]) fs.mkdirSync(dir, { recursive: true });

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function log(level, message) {
    try {
      const line = `${new Date().toISOString()} [${String(level).toUpperCase()}] ${String(message).replace(/\r?\n/g, ' ')}\n`;
      let size = 0;
      try {
        size = fs.statSync(logFile).size;
      } catch {
        size = 0;
      }
      if (size + Buffer.byteLength(line) > LOG_MAX) {
        try {
          fs.unlinkSync(logFile + '.1');
        } catch {
          /* 无旧文件 */
        }
        try {
          fs.renameSync(logFile, logFile + '.1');
        } catch {
          /* 轮转失败则继续写当前文件 */
        }
      }
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  function loadSettings() {
    return validateSettings(readJson(settingsFile, {}));
  }

  function saveSettings(patch) {
    const merged = validateSettings({ ...loadSettings(), ...(patch || {}) });
    writeJson(settingsFile, merged);
    return merged;
  }

  function recent() {
    const list = readJson(recentFile, []);
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, RECENT_LIMIT) : [];
  }

  function addRecent(filePath) {
    if (typeof filePath !== 'string' || !filePath) return;
    const list = recent().filter((item) => item.toLowerCase() !== filePath.toLowerCase());
    list.unshift(filePath);
    try {
      writeJson(recentFile, list.slice(0, RECENT_LIMIT));
    } catch (err) {
      log('warn', '写入最近文件失败：' + err.message);
    }
  }

  function session() {
    const list = readJson(sessionFile, []);
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, 20) : [];
  }

  function addSession(filePath) {
    if (typeof filePath !== 'string' || !filePath) return;
    const list = session().filter((item) => item.toLowerCase() !== filePath.toLowerCase());
    list.unshift(filePath);
    try {
      writeJson(sessionFile, list.slice(0, 20));
    } catch {
      /* 忽略 */
    }
  }

  function clearRecent() {
    try {
      writeJson(recentFile, []);
    } catch {
      /* 忽略 */
    }
  }

  function pruneBackups(base) {
    try {
      const prefix = base + '-';
      const files = fs
        .readdirSync(backupsDir)
        .filter(
          (name) =>
            name.startsWith(prefix) && /^\d{8}-\d{6}(?:-\d{3})?(?:-\d+)?\.wbc$/i.test(name.slice(prefix.length))
        )
        .map((name) => ({ name, time: fs.statSync(path.join(backupsDir, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      for (const stale of files.slice(BACKUP_LIMIT)) {
        try {
          fs.unlinkSync(path.join(backupsDir, stale.name));
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  let backupSequence = 0;
  function backupBase(filePath, docKey) {
    const base = safeBaseName(filePath);
    // 未命名文档没有路径，用窗口/文档键隔离，避免多个未命名窗口互相覆盖
    return filePath ? base : `${base}-${shortKey(docKey) || 'unknown'}`;
  }

  function nextBackupName(base) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const sequence = backupSequence++;
      const file = path.join(backupsDir, `${base}-${timestamp()}${sequence ? '-' + sequence : ''}.wbc`);
      if (!fs.existsSync(file)) return file;
    }
    return null;
  }

  async function backupBuffer(buf, filePath, docKey) {
    const base = backupBase(filePath, docKey);
    for (let attempt = 0; attempt < 20; attempt++) {
      const file = nextBackupName(base);
      if (!file) break;
      try {
        await fs.promises.writeFile(file, buf, { flag: 'wx' });
        pruneBackups(base);
        return file;
      } catch (err) {
        if (err && err.code === 'EEXIST') continue;
        log('warn', '自动备份失败：' + err.message);
        return null;
      }
    }
    log('warn', '自动备份失败：无法生成唯一文件名');
    return null;
  }

  async function backupFile(filePath) {
    const base = backupBase(filePath, null);
    for (let attempt = 0; attempt < 20; attempt++) {
      const file = nextBackupName(base);
      if (!file) break;
      try {
        await fs.promises.copyFile(filePath, file, fs.constants.COPYFILE_EXCL);
        pruneBackups(base);
        return file;
      } catch (err) {
        if (err && err.code === 'EEXIST') continue;
        log('warn', '自动备份失败：' + err.message);
        return null;
      }
    }
    log('warn', '自动备份失败：无法生成唯一文件名');
    return null;
  }

  function listBackups() {
    try {
      return fs
        .readdirSync(backupsDir)
        .filter((name) => /\.wbc$/i.test(name))
        .map((name) => {
          const full = path.join(backupsDir, name);
          const stat = fs.statSync(full);
          return { path: full, name, mtime: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  // 恢复快照按窗口/文档键异步写，避免多窗口互相覆盖，也避免大文档阻塞主进程。
  const recoveryPending = new Map();
  const recoveryGeneration = new Map();
  let recoveryRunning = false;
  let recoveryFlushPromise = null;

  function recoveryPaths(key) {
    return {
      text: path.join(recoveryDir, key + '.json'),
      meta: path.join(recoveryDir, key + '.meta.json')
    };
  }

  function generationOf(key) {
    return recoveryGeneration.get(key) || 0;
  }

  function bumpGeneration(key) {
    recoveryGeneration.set(key, generationOf(key) + 1);
  }

  function flushRecovery() {
    if (recoveryFlushPromise) return recoveryFlushPromise;
    recoveryFlushPromise = (async () => {
      while (recoveryPending.size) {
        const batch = Array.from(recoveryPending.entries());
        recoveryPending.clear();
        for (const [key, job] of batch) {
          const files = recoveryPaths(key);
          const tmp = files.text + '.tmp';
          try {
            await fs.promises.writeFile(tmp, job.text, 'utf8');
            if (job.generation !== generationOf(key)) {
              await fs.promises.unlink(tmp).catch(() => {});
              continue;
            }
            await fs.promises.rename(tmp, files.text);
            if (job.generation !== generationOf(key)) {
              await fs.promises.unlink(files.text).catch(() => {});
              await fs.promises.unlink(files.meta).catch(() => {});
              continue;
            }
            await fs.promises.writeFile(
              files.meta,
              JSON.stringify({ path: job.path, stamp: job.stamp || null, at: Date.now() }),
              'utf8'
            );
          } catch (err) {
            log('warn', '写恢复快照失败：' + err.message);
          }
        }
      }
    })().finally(() => {
      recoveryFlushPromise = null;
      if (recoveryPending.size) void flushRecovery();
      else recoveryRunning = false;
    });
    return recoveryFlushPromise;
  }

  function writeRecovery(key, text, filePath, stamp) {
    const safe = safeKey(key);
    if (!safe || typeof text !== 'string' || text.length > RECOVERY_TEXT_MAX) return false;
    recoveryPending.set(safe, {
      text,
      path: typeof filePath === 'string' && filePath ? filePath : null,
      stamp:
        stamp && typeof stamp.mtimeMs === 'number' && typeof stamp.size === 'number'
          ? { mtimeMs: stamp.mtimeMs, size: stamp.size }
          : null,
      generation: generationOf(safe)
    });
    if (!recoveryRunning) {
      recoveryRunning = true;
      void flushRecovery();
    }
    return true;
  }

  function readRecovery(key) {
    const safe = safeKey(key);
    if (!safe) return null;
    const files = recoveryPaths(safe);
    try {
      const text = fs.readFileSync(files.text, 'utf8');
      const meta = readJson(files.meta, {});
      return {
        key: safe,
        text,
        path: typeof meta.path === 'string' && meta.path ? meta.path : null,
        stamp:
          meta.stamp && typeof meta.stamp.mtimeMs === 'number' && typeof meta.stamp.size === 'number'
            ? { mtimeMs: meta.stamp.mtimeMs, size: meta.stamp.size }
            : null,
        at: typeof meta.at === 'number' ? meta.at : 0
      };
    } catch {
      return null;
    }
  }

  function listRecoveries() {
    migrateLegacyRecovery();
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(recoveryDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const key = name.slice(0, -'.meta.json'.length);
      const safe = safeKey(key);
      if (!safe) continue;
      const files = recoveryPaths(safe);
      try {
        const stat = fs.statSync(files.text);
        const meta = readJson(files.meta, {});
        out.push({
          key: safe,
          path: typeof meta.path === 'string' && meta.path ? meta.path : null,
          stamp:
            meta.stamp && typeof meta.stamp.mtimeMs === 'number' && typeof meta.stamp.size === 'number'
              ? { mtimeMs: meta.stamp.mtimeMs, size: meta.stamp.size }
              : null,
          at: typeof meta.at === 'number' ? meta.at : stat.mtimeMs,
          size: stat.size
        });
      } catch {
        /* 快照文件缺失 */
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  function clearRecovery(key) {
    const safe = safeKey(key);
    if (!safe) return false;
    bumpGeneration(safe);
    recoveryPending.delete(safe);
    const files = recoveryPaths(safe);
    for (const file of [files.text, files.meta]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 不存在 */
      }
    }
    return true;
  }

  function migrateLegacyRecovery() {
    if (!fs.existsSync(legacyRecoveryFile)) return;
    const key = 'legacy-' + Date.now().toString(36);
    try {
      const text = fs.readFileSync(legacyRecoveryFile, 'utf8');
      const meta = readJson(legacyRecoveryMetaFile, {});
      const files = recoveryPaths(key);
      fs.writeFileSync(files.text, text, 'utf8');
      fs.writeFileSync(
        files.meta,
        JSON.stringify({
          path: typeof meta.path === 'string' ? meta.path : null,
          stamp: null,
          at: typeof meta.at === 'number' ? meta.at : Date.now()
        }),
        'utf8'
      );
      for (const file of [legacyRecoveryFile, legacyRecoveryMetaFile]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* 忽略 */
        }
      }
      log('info', '已迁移旧版恢复快照：' + key);
    } catch (err) {
      log('warn', '迁移旧版恢复快照失败：' + err.message);
    }
  }

  return {
    dirs: { userData, logsDir, backupsDir, recoveryDir },
    log,
    loadSettings,
    saveSettings,
    recent,
    addRecent,
    session,
    addSession,
    clearRecent,
    backupBuffer,
    backupFile,
    listBackups,
    writeRecovery,
    readRecovery,
    listRecoveries,
    clearRecovery,
    flushRecovery
  };
}

module.exports = { createStore, DEFAULT_SETTINGS, validateSettings };
