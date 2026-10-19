// SPDX-License-Identifier: GPL-3.0-or-later
import { El, Tool, sanitizeEl } from './model';
import type { Settings } from './types';

export interface Page {
  id: string;
  name: string;
  elements: El[];
}

export interface Doc {
  app: 'whiteboard-canvas';
  version: 3;
  elements: El[];
}

interface HistEntry {
  doc: Doc;
  label: string;
}

export const HISTORY_LIMIT = 100;
export const RECOVERY_DELAY = 3000;
const MAX_ELEMENTS = 100000;

export const DEFAULT_SETTINGS: Settings = {
  autosaveDelay: 1,
  closeBehavior: 'ask',
  disableGpu: false,
  background: 'dots',
  theme: 'light',
  language: 'zh',
  exportBackground: true,
  template: 'blank',
  shortcuts: {}
};

export function uidPage(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const state = {
  doc: { app: 'whiteboard-canvas', version: 3, elements: [] } as Doc,
  pages: [{ id: 'p1', name: '页面 1', elements: [] }] as Page[],
  activePage: 0,
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

let undoStack: HistEntry[] = [];
let redoStack: HistEntry[] = [];
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

/** 把当前编辑区同步回当前页 */
export function syncActivePage(): void {
  const page = state.pages[state.activePage];
  if (page) page.elements = state.doc.elements;
}

export function clearHistory(): void {
  undoStack = [];
  redoStack = [];
}

export function beginMutation(): Doc {
  return structuredClone(state.doc);
}

export function commitMutation(before: Doc | null, changed = true, label = '编辑'): void {
  if (!before || !changed) return;
  undoStack.push({ doc: before, label });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  markDirty();
}

export function undo(): boolean {
  const prev = undoStack.pop();
  if (!prev) return false;
  redoStack.push({ doc: structuredClone(state.doc), label: prev.label });
  state.doc = prev.doc;
  markDirty();
  return true;
}

export function redo(): boolean {
  const next = redoStack.pop();
  if (!next) return false;
  undoStack.push({ doc: structuredClone(state.doc), label: next.label });
  state.doc = next.doc;
  markDirty();
  return true;
}

export interface HistoryEntry {
  label: string;
  done: boolean;
}

/** 历史面板数据：已做步骤 + 可重做步骤 */
export function historyEntries(): HistoryEntry[] {
  const done = undoStack.map((entry) => ({ label: entry.label, done: true }));
  const undone = redoStack
    .slice()
    .reverse()
    .map((entry) => ({ label: entry.label, done: false }));
  return done.concat(undone);
}

/** 跳转到第 index 个已完成步骤之后的状态（0 = 初始） */
export function jumpToHistory(index: number): boolean {
  const target = Math.max(0, Math.min(undoStack.length + redoStack.length, index));
  let changed = false;
  while (undoStack.length > target) {
    if (!undo()) break;
    changed = true;
  }
  while (undoStack.length < target) {
    if (!redo()) break;
    changed = true;
  }
  return changed;
}

export function serialize(): string {
  syncActivePage();
  return JSON.stringify({
    app: 'whiteboard-canvas',
    version: 3,
    pages: state.pages.map((page) => ({ id: page.id, name: page.name, elements: page.elements })),
    activePage: state.activePage
  });
}

function parseElements(raw: unknown[]): El[] {
  const elements: El[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_ELEMENTS)) {
    const el = sanitizeEl(item);
    if (!el) continue;
    if (ids.has(el.id)) el.id = el.id + '-' + elements.length;
    ids.add(el.id);
    elements.push(el);
  }
  return elements;
}

export function loadFromText(text: string): void {
  const clean = String(text).replace(/^\uFEFF/, '');
  const raw: unknown = JSON.parse(clean);
  if (!raw || typeof raw !== 'object') throw new Error('文件格式不正确');
  const obj = raw as { app?: unknown; version?: unknown; elements?: unknown; pages?: unknown; activePage?: unknown };
  if (obj.app !== 'whiteboard-canvas') throw new Error('文件格式不正确');
  const version = Number(obj.version) || 1;
  if (version > 3) throw new Error(`该文件由更高版本创建（v${version}），请升级应用后再打开。`);
  let pages: Page[] = [];
  if (Array.isArray(obj.pages)) {
    for (const item of obj.pages.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const p = item as { id?: unknown; name?: unknown; elements?: unknown };
      pages.push({
        id: typeof p.id === 'string' && p.id ? p.id : uidPage(),
        name: typeof p.name === 'string' ? p.name.slice(0, 100) : `页面 ${pages.length + 1}`,
        elements: Array.isArray(p.elements) ? parseElements(p.elements) : []
      });
    }
  } else if (Array.isArray(obj.elements)) {
    pages.push({ id: uidPage(), name: '页面 1', elements: parseElements(obj.elements) });
  }
  if (!pages.length) throw new Error('文件格式不正确');
  const active = Math.min(pages.length - 1, Math.max(0, Number(obj.activePage) || 0));
  state.pages = pages;
  state.activePage = active;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: pages[active].elements };
}

export function resetDoc(): void {
  state.pages = [{ id: uidPage(), name: '页面 1', elements: [] }];
  state.activePage = 0;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[0].elements };
  state.filePath = null;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
}

export function addPage(name?: string): Page {
  syncActivePage();
  const page: Page = { id: uidPage(), name: name || `页面 ${state.pages.length + 1}`, elements: [] };
  state.pages.push(page);
  return page;
}

export function removePage(index: number): boolean {
  if (state.pages.length <= 1) return false;
  if (index < 0 || index >= state.pages.length) return false;
  syncActivePage();
  state.pages.splice(index, 1);
  if (state.activePage >= state.pages.length) state.activePage = state.pages.length - 1;
  else if (index < state.activePage) state.activePage -= 1;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[state.activePage].elements };
  state.selectedIds = [];
  clearHistory();
  return true;
}

export function switchPage(index: number): boolean {
  if (index < 0 || index >= state.pages.length || index === state.activePage) return false;
  syncActivePage();
  state.activePage = index;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[index].elements };
  state.selectedIds = [];
  clearHistory();
  return true;
}

export function movePage(from: number, to: number): boolean {
  if (from === to || from < 0 || from >= state.pages.length || to < 0 || to >= state.pages.length) return false;
  syncActivePage();
  const [page] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, page);
  if (state.activePage === from) state.activePage = to;
  else if (from < state.activePage && to >= state.activePage) state.activePage -= 1;
  else if (from > state.activePage && to <= state.activePage) state.activePage += 1;
  return true;
}

export function renamePage(index: number, name: string): void {
  const page = state.pages[index];
  if (!page) return;
  const clean = name.trim().slice(0, 100);
  if (clean) page.name = clean;
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
