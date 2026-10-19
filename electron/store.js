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
  background: 'dots'
};

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
  out.background = ['dots', 'grid', 'plain', 'cream'].includes(raw.background) ? raw.background : DEFAULT_SETTINGS.background;
  return out;
}

function timestamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function safeBaseName(filePath) {
  if (!filePath) return '未命名';
  const base = path.basename(filePath).replace(/\.wbc$/i, '');
  return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名';
}

function createStore(userData) {
  const logsDir = path.join(userData, 'logs');
  const backupsDir = path.join(userData, 'backups');
  const logFile = path.join(logsDir, 'main.log');
  const settingsFile = path.join(userData, 'settings.json');
  const recentFile = path.join(userData, 'recent.json');
  const recoveryFile = path.join(userData, 'recovery.wbc');
  const recoveryMetaFile = path.join(userData, 'recovery.json');
  for (const dir of [logsDir, backupsDir]) fs.mkdirSync(dir, { recursive: true });

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

  function clearRecent() {
    try {
      writeJson(recentFile, []);
    } catch {
      /* 忽略 */
    }
  }

  function pruneBackups(base) {
    try {
      const files = fs
        .readdirSync(backupsDir)
        .filter((name) => name.startsWith(base + '-') && /\.wbc$/i.test(name))
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

  async function backupBuffer(buf, filePath) {
    try {
      const base = safeBaseName(filePath);
      const file = path.join(backupsDir, `${base}-${timestamp(new Date())}.wbc`);
      await fs.promises.writeFile(file, buf);
      pruneBackups(base);
      return file;
    } catch (err) {
      log('warn', '自动备份失败：' + err.message);
      return null;
    }
  }

  async function backupFile(filePath) {
    try {
      const base = safeBaseName(filePath);
      const file = path.join(backupsDir, `${base}-${timestamp(new Date())}.wbc`);
      await fs.promises.copyFile(filePath, file);
      pruneBackups(base);
      return file;
    } catch (err) {
      log('warn', '自动备份失败：' + err.message);
      return null;
    }
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

  // 恢复快照异步写，只保留最新一份，避免大文档阻塞主进程。
  let recoveryPending = null;
  let recoveryRunning = false;
  let recoveryGeneration = 0;

  async function flushRecovery() {
    while (recoveryPending) {
      const job = recoveryPending;
      recoveryPending = null;
      try {
        const tmp = recoveryFile + '.tmp';
        await fs.promises.writeFile(tmp, job.text, 'utf8');
        if (job.generation !== recoveryGeneration) {
          await fs.promises.unlink(tmp).catch(() => {});
          continue;
        }
        await fs.promises.rename(tmp, recoveryFile);
        await fs.promises.writeFile(recoveryMetaFile, JSON.stringify({ path: job.path, at: Date.now() }), 'utf8');
      } catch (err) {
        log('warn', '写恢复快照失败：' + err.message);
      }
      if (job.generation !== recoveryGeneration) {
        for (const file of [recoveryFile, recoveryMetaFile]) {
          await fs.promises.unlink(file).catch(() => {});
        }
      }
    }
    recoveryRunning = false;
  }

  function writeRecovery(text, filePath) {
    if (typeof text !== 'string' || text.length > RECOVERY_TEXT_MAX) return false;
    recoveryPending = {
      text,
      path: typeof filePath === 'string' && filePath ? filePath : null,
      generation: recoveryGeneration
    };
    if (!recoveryRunning) {
      recoveryRunning = true;
      void flushRecovery();
    }
    return true;
  }

  function readRecovery() {
    try {
      const text = fs.readFileSync(recoveryFile, 'utf8');
      const meta = readJson(recoveryMetaFile, {});
      return { text, path: typeof meta.path === 'string' && meta.path ? meta.path : null };
    } catch {
      return null;
    }
  }

  function clearRecovery() {
    recoveryGeneration += 1;
    recoveryPending = null;
    for (const file of [recoveryFile, recoveryMetaFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 不存在 */
      }
    }
  }

  return {
    dirs: { userData, logsDir, backupsDir },
    log,
    loadSettings,
    saveSettings,
    recent,
    addRecent,
    clearRecent,
    backupBuffer,
    backupFile,
    listBackups,
    writeRecovery,
    readRecovery,
    clearRecovery
  };
}

module.exports = { createStore, DEFAULT_SETTINGS, validateSettings };
