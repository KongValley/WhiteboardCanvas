// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_SETTINGS, state } from './state';
import { applyTransform } from './view';

const overlay = document.getElementById('settings') as HTMLDivElement;
const closeBtn = document.getElementById('settings-close') as HTMLButtonElement;
const saveBtn = document.getElementById('settings-save') as HTMLButtonElement;
const resetBtn = document.getElementById('settings-reset') as HTMLButtonElement;
const autosaveInput = document.getElementById('set-autosave') as HTMLInputElement;
const closeSelect = document.getElementById('set-close') as HTMLSelectElement;
const gpuInput = document.getElementById('set-gpu') as HTMLInputElement;
const backgroundSelect = document.getElementById('set-background') as HTMLSelectElement;
const assocBtn = document.getElementById('assoc-toggle') as HTMLButtonElement;
const assocState = document.getElementById('assoc-state') as HTMLSpanElement;
const formStatus = document.getElementById('settings-status') as HTMLDivElement;

let assocEnabled = false;
let assocSupported = false;
let onSaved: () => void = () => {};

function fillForm(): void {
  autosaveInput.value = String(state.settings.autosaveDelay);
  closeSelect.value = state.settings.closeBehavior;
  gpuInput.checked = state.settings.disableGpu;
  backgroundSelect.value = state.settings.background;
  void refreshAssociation();
}

async function refreshAssociation(): Promise<void> {
  try {
    const info = await window.api.getAssociation();
    assocSupported = info.supported;
    assocEnabled = info.enabled;
    assocBtn.disabled = !assocSupported;
    assocBtn.textContent = info.enabled ? '移除 .wbc 关联' : '注册 .wbc 关联';
    assocState.textContent = !assocSupported ? '仅 Windows 支持' : info.enabled ? '已注册（当前用户）' : '未注册';
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

function readForm(): { autosaveDelay: number; closeBehavior: 'ask' | 'save' | 'discard'; disableGpu: boolean; background: 'dots' | 'grid' | 'plain' | 'cream' } {
  const delay = Math.min(60, Math.max(0, Math.round(Number(autosaveInput.value) || 0)));
  const closeValue = closeSelect.value;
  const bg = backgroundSelect.value;
  return {
    autosaveDelay: delay,
    closeBehavior: closeValue === 'save' || closeValue === 'discard' ? closeValue : 'ask',
    disableGpu: gpuInput.checked,
    background: bg === 'dots' || bg === 'grid' || bg === 'plain' || bg === 'cream' ? bg : 'dots'
  };
}

function applyLocal(): void {
  applyTransform();
  onSaved();
}

export function installSettings(saved: () => void): void {
  onSaved = saved;
  closeBtn.addEventListener('click', closeSettings);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSettings();
    }
  });
  saveBtn.addEventListener('click', async () => {
    const patch = readForm();
    const result = await window.api.setSettings(patch);
    if ('error' in result) {
      formStatus.textContent = '保存失败：' + result.error;
      return;
    }
    state.settings = result;
    applyLocal();
    formStatus.textContent = '已保存' + (patch.disableGpu !== undefined ? '（GPU 设置重启后生效）' : '');
  });
  resetBtn.addEventListener('click', () => {
    autosaveInput.value = String(DEFAULT_SETTINGS.autosaveDelay);
    closeSelect.value = DEFAULT_SETTINGS.closeBehavior;
    gpuInput.checked = DEFAULT_SETTINGS.disableGpu;
    backgroundSelect.value = DEFAULT_SETTINGS.background;
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
