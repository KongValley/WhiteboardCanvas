// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_SETTINGS, state } from './state';
import { applyTransform } from './view';
import type { Settings } from './types';
import { applyI18n, t } from './i18n';

const overlay = document.getElementById('settings') as HTMLDivElement;
const closeBtn = document.getElementById('settings-close') as HTMLButtonElement;
const saveBtn = document.getElementById('settings-save') as HTMLButtonElement;
const resetBtn = document.getElementById('settings-reset') as HTMLButtonElement;
const autosaveInput = document.getElementById('set-autosave') as HTMLInputElement;
const closeSelect = document.getElementById('set-close') as HTMLSelectElement;
const gpuInput = document.getElementById('set-gpu') as HTMLInputElement;
const lowSpecInput = document.getElementById('set-low-spec') as HTMLInputElement;
const backgroundSelect = document.getElementById('set-background') as HTMLSelectElement;
const gridSizeSelect = document.getElementById('set-grid-size') as HTMLSelectElement;
const themeSelect = document.getElementById('set-theme') as HTMLSelectElement;
const languageSelect = document.getElementById('set-language') as HTMLSelectElement;
const exportBgInput = document.getElementById('set-export-bg') as HTMLInputElement;
const printSizeSelect = document.getElementById('set-print-size') as HTMLSelectElement;
const printOrientationSelect = document.getElementById('set-print-orientation') as HTMLSelectElement;
const assocBtn = document.getElementById('assoc-toggle') as HTMLButtonElement;
const assocState = document.getElementById('assoc-state') as HTMLSpanElement;
const formStatus = document.getElementById('settings-status') as HTMLDivElement;
const shortcutList = document.getElementById('shortcut-list') as HTMLDivElement;

let assocEnabled = false;
let assocSupported = false;
let onSaved: () => void = () => {};
let pendingShortcuts: Record<string, string> = {};
let recording: string | null = null;

const SHORTCUT_ACTIONS: { id: string; label: string; def: string }[] = [
  { id: 'select', label: '选择', def: 'v' },
  { id: 'lasso', label: '套索', def: 'q' },
  { id: 'pen', label: '画笔', def: 'p' },
  { id: 'highlighter', label: '荧光笔', def: 'h' },
  { id: 'eraser', label: '橡皮', def: 'e' },
  { id: 'text', label: '文字', def: 't' },
  { id: 'sticky', label: '便签', def: 's' },
  { id: 'rect', label: '矩形', def: 'r' },
  { id: 'ellipse', label: '椭圆', def: 'o' },
  { id: 'arrow', label: '箭头', def: 'a' },
  { id: 'line', label: '直线', def: 'l' }
];

const RESERVED = new Set([
  'ctrl+s', 'ctrl+o', 'ctrl+n', 'ctrl+z', 'ctrl+y', 'ctrl+a', 'ctrl+d', 'ctrl+c', 'ctrl+x', 'ctrl+v',
  'ctrl+e', 'ctrl+p', 'ctrl+f', 'ctrl+0', 'ctrl+=', 'ctrl+-', 'ctrl+shift+s', 'ctrl+shift+c', 'ctrl+shift+f',
  'ctrl+shift+z', 'ctrl+shift+g', 'ctrl+shift+l', 'ctrl+shift+h', 'ctrl+shift+n', 'ctrl+]', 'ctrl+[',
  'space', 'enter', 'tab', 'delete', 'backspace', 'i', '1', '2', '3', '4'
]);

export function applyTheme(theme: 'light' | 'dark'): void {
  document.body.classList.toggle('dark', theme === 'dark');
}

export function currentShortcuts(): Record<string, string> {
  const out: Record<string, string> = {};
  const saved = state.settings.shortcuts || {};
  for (const action of SHORTCUT_ACTIONS) out[action.id] = saved[action.id] || action.def;
  return out;
}

function fillForm(): void {
  autosaveInput.value = String(state.settings.autosaveDelay);
  closeSelect.value = state.settings.closeBehavior;
  gpuInput.checked = state.settings.disableGpu;
  lowSpecInput.checked = state.settings.lowSpec;
  backgroundSelect.value = state.settings.background;
  gridSizeSelect.value = String(state.settings.gridSize);
  themeSelect.value = state.settings.theme;
  languageSelect.value = state.settings.language;
  exportBgInput.checked = state.settings.exportBackground;
  printSizeSelect.value = state.settings.printPageSize;
  printOrientationSelect.value = state.settings.printOrientation;
  pendingShortcuts = { ...state.settings.shortcuts };
  renderShortcuts();
  void refreshAssociation();
}

function renderShortcuts(): void {
  shortcutList.replaceChildren();
  for (const action of SHORTCUT_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'shortcut-row' + (recording === action.id ? ' recording' : '');
    const label = document.createElement('span');
    label.textContent = action.label;
    const key = document.createElement('span');
    key.textContent = pendingShortcuts[action.id] || action.def;
    const button = document.createElement('button');
    button.textContent = recording === action.id ? '按键…' : t('settings.record');
    button.addEventListener('click', () => {
      recording = recording === action.id ? null : action.id;
      renderShortcuts();
    });
    const clear = document.createElement('button');
    clear.textContent = t('settings.default');
    clear.addEventListener('click', () => {
      delete pendingShortcuts[action.id];
      renderShortcuts();
    });
    row.append(label, key, button, clear);
    shortcutList.appendChild(row);
  }
}

function comboFromEvent(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.toLowerCase();
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return null;
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

async function refreshAssociation(): Promise<void> {
  try {
    const info = await window.api.getAssociation();
    assocSupported = info.supported;
    assocEnabled = info.enabled;
    assocBtn.disabled = !assocSupported;
    assocBtn.textContent = info.enabled ? t('assoc.remove') : t('assoc.register');
    assocState.textContent = !assocSupported ? t('assoc.onlyWin') : info.enabled ? t('assoc.on') : t('assoc.off');
  } catch {
    assocSupported = false;
    assocBtn.disabled = true;
    assocState.textContent = '无法读取关联状态';
  }
}

export function openSettings(): void {
  fillForm();
  formStatus.textContent = '';
  overlay.hidden = false;
  autosaveInput.focus();
}

export function closeSettings(): void {
  overlay.hidden = true;
}

function readForm(): Partial<Settings> {
  const delay = Math.min(60, Math.max(0, Math.round(Number(autosaveInput.value) || 0)));
  const closeValue = closeSelect.value;
  const bg = backgroundSelect.value;
  return {
    autosaveDelay: delay,
    closeBehavior: closeValue === 'save' || closeValue === 'discard' ? closeValue : 'ask',
    disableGpu: gpuInput.checked,
    lowSpec: lowSpecInput.checked,
    background: bg === 'dots' || bg === 'grid' || bg === 'plain' || bg === 'cream' ? bg : 'dots',
    gridSize: [8, 16, 24, 32].includes(Number(gridSizeSelect.value)) ? Number(gridSizeSelect.value) : 24,
    theme: themeSelect.value === 'dark' ? 'dark' : 'light',
    language: languageSelect.value === 'en' ? 'en' : 'zh',
    exportBackground: exportBgInput.checked,
    printPageSize: printSizeSelect.value === 'Letter' ? 'Letter' : 'A4',
    printOrientation: printOrientationSelect.value === 'portrait' ? 'portrait' : 'landscape',
    shortcuts: { ...pendingShortcuts }
  };
}

function applyLocal(): void {
  applyTheme(state.settings.theme);
  applyTransform();
  onSaved();
}

export function installSettings(saved: () => void): void {
  onSaved = saved;
  closeBtn.addEventListener('click', closeSettings);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });
  overlay.addEventListener(
    'keydown',
    (e) => {
      if (!recording) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSettings();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        recording = null;
        formStatus.textContent = '';
        renderShortcuts();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      if (RESERVED.has(combo)) {
        formStatus.textContent = `“${combo}” 已被系统快捷键占用`;
        return;
      }
      const conflict = SHORTCUT_ACTIONS.find(
        (action) => action.id !== recording && (pendingShortcuts[action.id] || action.def) === combo
      );
      if (conflict) {
        formStatus.textContent = `“${combo}” 已用于“${conflict.label}”`;
        return;
      }
      if (recording) pendingShortcuts[recording] = combo;
      recording = null;
      formStatus.textContent = '已记录快捷键，点击“保存”生效';
      renderShortcuts();
    },
    true
  );
  saveBtn.addEventListener('click', async () => {
    const patch = readForm();
    const result = await window.api.setSettings(patch);
    if ('error' in result) {
      formStatus.textContent = '保存失败：' + result.error;
      return;
    }
    state.settings = result;
    applyLocal();
    applyI18n();
    formStatus.textContent = '已保存' + (patch.disableGpu !== undefined ? '（GPU 设置重启后生效）' : '');
  });
  resetBtn.addEventListener('click', () => {
    autosaveInput.value = String(DEFAULT_SETTINGS.autosaveDelay);
    closeSelect.value = DEFAULT_SETTINGS.closeBehavior;
    gpuInput.checked = DEFAULT_SETTINGS.disableGpu;
    lowSpecInput.checked = DEFAULT_SETTINGS.lowSpec;
    backgroundSelect.value = DEFAULT_SETTINGS.background;
    gridSizeSelect.value = String(DEFAULT_SETTINGS.gridSize);
    themeSelect.value = DEFAULT_SETTINGS.theme;
    languageSelect.value = DEFAULT_SETTINGS.language;
    exportBgInput.checked = DEFAULT_SETTINGS.exportBackground;
    printSizeSelect.value = DEFAULT_SETTINGS.printPageSize;
    printOrientationSelect.value = DEFAULT_SETTINGS.printOrientation;
    pendingShortcuts = {};
    renderShortcuts();
    formStatus.textContent = '已恢复默认值，点击“保存”生效';
  });
  assocBtn.addEventListener('click', async () => {
    if (!assocSupported) return;
    assocBtn.disabled = true;
    const result = await window.api.setAssociation(!assocEnabled);
    assocBtn.disabled = false;
    if (result.error) formStatus.textContent = '关联设置失败：' + result.error;
    else formStatus.textContent = result.enabled ? '已注册 .wbc 文件关联' : '已移除 .wbc 文件关联';
    await refreshAssociation();
  });
}
