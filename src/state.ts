// SPDX-License-Identifier: GPL-3.0-or-later
import { El, Tool, sanitizeEl } from './model';
import type { Settings } from './types';

export interface Doc {
  app: 'whiteboard-canvas';
  version: 2;
  elements: El[];
}

export const HISTORY_LIMIT = 100;
export const RECOVERY_DELAY = 3000;
const MAX_ELEMENTS = 100000;

export const DEFAULT_SETTINGS: Settings = {
  autosaveDelay: 1,
  closeBehavior: 'ask',
  disableGpu: false,
  background: 'dots'
};

export const state = {
  doc: { app: 'whiteboard-canvas', version: 2, elements: [] } as Doc,
  filePath: null as string | null,
  dirty: false,
  revision: 0,
  selectedIds: [] as string[],
  tool: 'select' as Tool,
  color: '#1f2937',
  width: 3,
  fontSize: 24,
  fill: '',
  spaceDown: false,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  autosaveAt: 0
};

const titleEl = document.getElementById('title') as HTMLDivElement;
const statusMsgEl = document.getElementById('status-msg') as HTMLSpanElement;
const statusInfoEl = document.getElementById('status-info') as HTMLSpanElement;

const undoStack: Doc[] = [];
const redoStack: Doc[] = [];
let autosaveTimer: number | null = null;
let recoveryTimer: number | null = null;
let statusHook: () => void = () => {};
let recoverySnapshotProvider: (() => string) | null = null;

export function setStatusHook(fn: () => void): void {
  statusHook = fn;
}

/** 允许把正在编辑的文本草稿合入恢复快照 */
export function setRecoverySnapshotProvider(fn: () => string): void {
  recoverySnapshotProvider = fn;
}

export function setStatus(text: string): void {
  statusMsgEl.textContent = text;
}

export function setStatusInfo(text: string): void {
  statusInfoEl.textContent = text;
}

export function fileName(): string {
  if (!state.filePath) return '未命名.wbc';
  const parts = state.filePath.split(/[\\/]/);
  return parts[parts.length - 1] || '未命名.wbc';
}

export function updateTitle(): void {
  const name = fileName();
  const prefix = state.dirty ? '• ' : '';
  titleEl.textContent = prefix + name;
  document.title = prefix + name + ' — 白板画布';
}

export function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

export function beginMutation(): Doc {
  return structuredClone(state.doc);
}

export function commitMutation(before: Doc | null, changed = true): void {
  if (!before || !changed) return;
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  markDirty();
}

export function undo(): boolean {
  const prev = undoStack.pop();
  if (!prev) return false;
  redoStack.push(structuredClone(state.doc));
  state.doc = prev;
  markDirty();
  return true;
}

export function redo(): boolean {
  const next = redoStack.pop();
  if (!next) return false;
  undoStack.push(structuredClone(state.doc));
  state.doc = next;
  markDirty();
  return true;
}

export function serialize(): string {
  return JSON.stringify(state.doc);
}

export function loadFromText(text: string): void {
  const clean = String(text).replace(/^\uFEFF/, '');
  const raw: unknown = JSON.parse(clean);
  if (!raw || typeof raw !== 'object') throw new Error('文件格式不正确');
  const obj = raw as { app?: unknown; version?: unknown; elements?: unknown };
  if (obj.app !== 'whiteboard-canvas' || !Array.isArray(obj.elements)) throw new Error('文件格式不正确');
  const version = Number(obj.version) || 1;
  if (version > 2) throw new Error(`该文件由更高版本创建（v${version}），请升级应用后再打开。`);
  const elements: El[] = [];
  const ids = new Set<string>();
  for (const item of (obj.elements as unknown[]).slice(0, MAX_ELEMENTS)) {
    const el = sanitizeEl(item);
    if (!el) continue;
    if (ids.has(el.id)) el.id = el.id + '-' + elements.length;
    ids.add(el.id);
    elements.push(el);
  }
  state.doc = { app: 'whiteboard-canvas', version: 2, elements };
}

export function resetDoc(): void {
  state.doc = { app: 'whiteboard-canvas', version: 2, elements: [] };
  state.filePath = null;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
}

export function pruneSelection(): void {
  const alive = new Set(state.doc.elements.map((el) => el.id));
  state.selectedIds = state.selectedIds.filter((id) => alive.has(id));
}

export function removeElement(id: string): void {
  const index = state.doc.elements.findIndex((el) => el.id === id);
  if (index >= 0) state.doc.elements.splice(index, 1);
  state.selectedIds = state.selectedIds.filter((selected) => selected !== id);
}

export function markDirty(opts?: { autosave?: boolean }): void {
  state.revision++;
  state.dirty = true;
  window.api.setDirty(true);
  updateTitle();
  scheduleRecovery();
  statusHook();
  if (!opts || opts.autosave !== false) scheduleAutosave();
}

export function markSaved(): void {
  state.dirty = false;
  window.api.setDirty(false);
  window.api.clearRecovery();
  if (recoveryTimer !== null) {
    window.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  updateTitle();
  setStatus('已保存');
  statusHook();
}

export function scheduleAutosave(): void {
  if (!state.filePath) return;
  const delay = state.settings.autosaveDelay;
  if (!delay) return;
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(runAutosave, Math.max(200, delay * 1000));
}

async function runAutosave(): Promise<void> {
  autosaveTimer = null;
  const editor = document.getElementById('editor') as HTMLTextAreaElement | null;
  if (editor && !editor.hidden) {
    scheduleAutosave();
    return;
  }
  if (!state.filePath) return;
  const rev = state.revision;
  const text = serialize();
  const result = await window.api.saveDoc(state.filePath, text, true);
  if (result.error) {
    setStatus('自动保存失败');
    window.api.log('warn', '自动保存失败：' + result.error);
    return;
  }
  if (result.canceled) return;
  if (result.path) state.filePath = result.path;
  state.autosaveAt = Date.now();
  if (state.revision === rev) markSaved();
  else scheduleAutosave();
}

export function scheduleRecovery(): void {
  if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => {
    recoveryTimer = null;
    const text = recoverySnapshotProvider ? recoverySnapshotProvider() : serialize();
    window.api.writeRecovery(text, state.filePath || '');
  }, RECOVERY_DELAY);
}
