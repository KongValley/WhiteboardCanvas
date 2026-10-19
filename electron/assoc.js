// SPDX-License-Identifier: GPL-3.0-or-later
// 可选的用户级 .wbc 文件关联（仅 HKCU，免安装）。
const { execFile } = require('child_process');

const PROGID = 'WhiteboardCanvas.wbc';
const CLASSES = 'HKCU\\Software\\Classes';

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || ''), error: err ? err.message : '' });
    });
  });
}

async function queryDefault(key) {
  const r = await reg(['query', key, '/ve']);
  if (!r.ok) return null;
  const match = /REG_SZ\s+(.+)/.exec(r.out);
  return match ? match[1].trim() : null;
}

async function getAssociation() {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  const value = await queryDefault(`${CLASSES}\\.wbc`);
  return { supported: true, enabled: value === PROGID };
}

async function setAssociation(enabled, exePath, appPath) {
  if (process.platform !== 'win32') return { supported: false, enabled: false, error: '仅支持 Windows' };
  const extKey = `${CLASSES}\\.wbc`;
  const progKey = `${CLASSES}\\${PROGID}`;
  const cmdKey = `${progKey}\\shell\\open\\command`;
  const command = appPath ? `"${exePath}" "${appPath}" "%1"` : `"${exePath}" "%1"`;
  if (enabled) {
    if (!exePath) return { supported: true, enabled: false, error: '无法定位可执行文件' };
    let r = await reg(['add', extKey, '/ve', '/d', PROGID, '/f']);
    if (!r.ok) return { supported: true, enabled: false, error: '写入关联失败：' + r.error };
    r = await reg(['add', progKey, '/ve', '/d', '白板画布文档', '/f']);
    if (!r.ok) return { supported: true, enabled: false, error: '写入关联失败：' + r.error };
    r = await reg(['add', `${progKey}\\DefaultIcon`, '/ve', '/d', `"${exePath}",0`, '/f']);
    r = await reg(['add', cmdKey, '/ve', '/d', command, '/f']);
    if (!r.ok) return { supported: true, enabled: false, error: '写入关联失败：' + r.error };
    const state = await getAssociation();
    return { ...state, ok: state.enabled };
  }
  const current = await queryDefault(extKey);
  if (current === PROGID) await reg(['delete', extKey, '/f']);
  await reg(['delete', progKey, '/f']);
  const state = await getAssociation();
  return { ...state, ok: !state.enabled };
}

module.exports = { getAssociation, setAssociation, PROGID };
