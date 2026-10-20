// SPDX-License-Identifier: GPL-3.0-or-later
import { Dash, El, Tool, cloneElements, sanitizeEl, uid } from './model';
import { uiText } from './ui-text';
import type { FileStamp, Settings } from './types';

export interface Page {
  id: string;
  name: string;
  elements: El[];
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface Doc {
  app: 'whiteboard-canvas';
  version: 3;
  elements: El[];
}

interface HistEntry {
  doc: Doc;
  label: string;
  bytes: number;
}

interface PageSnapshot {
  pages: Page[];
  activePage: number;
  label: string;
  bytes: number;
}

export const HISTORY_LIMIT = 100;
/** 历史快照内存上限（近似值，按元素字符串与点数量估算） */
export const HISTORY_BYTES_LIMIT = 64 * 1024 * 1024;
const PAGE_HISTORY_LIMIT = 50;
export const RECOVERY_DELAY = 3000;
const MAX_ELEMENTS = 100000;

export const DEFAULT_SETTINGS: Settings = {
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

export function uidPage(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 每个窗口/文档独立的恢复快照键 */
export function newRecoveryKey(): string {
  return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const state = {
  doc: { app: 'whiteboard-canvas', version: 3, elements: [] } as Doc,
  pages: [{ id: 'p1', name: '页面 1', elements: [] }] as Page[],
  activePage: 0,
  filePath: null as string | null,
  fileStamp: null as FileStamp | null,
  recoveryKey: newRecoveryKey(),
  autosaveBlocked: false,
  saveStatus: 'saved' as SaveStatus,
  readOnly: false,
  eraserMode: 'ink' as 'ink' | 'object',
  dirty: false,
  revision: 0,
  selectedIds: [] as string[],
  tool: 'select' as Tool,
  color: '#1f2937',
  width: 3,
  dash: 'solid' as Dash,
  opacity: 1,
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
const historyByPage = new Map<string, { undo: HistEntry[]; redo: HistEntry[]; undoBytes: number; redoBytes: number }>();
let pageUndoStack: PageSnapshot[] = [];
let pageRedoStack: PageSnapshot[] = [];
let undoBytes = 0;
let redoBytes = 0;
let pageUndoBytes = 0;
let pageRedoBytes = 0;
let mutationClones = 0;
let autosaveTimer: number | null = null;
let autosaveRunning = false;
let recoveryTimer: number | null = null;
let statusHook: () => void = () => {};
let recoverySnapshotProvider: (() => string) | null = null;

/** 诊断计数器（测试/日志用） */
export const recoveryDebug = { scheduled: 0, fired: 0, writes: 0 };

export function setStatusHook(fn: () => void): void {
  statusHook = fn;
}

/** 允许把正在编辑的文本草稿合入恢复快照 */
export function setRecoverySnapshotProvider(fn: () => string): void {
  recoverySnapshotProvider = fn;
}

export function setStatus(text: string): void {
  statusMsgEl.textContent = uiText(text);
}

let lastStatusInfo = '';

export function setStatusInfo(text: string): void {
  if (text === lastStatusInfo) return;
  lastStatusInfo = text;
  statusInfoEl.textContent = text;
}

export function fileName(): string {
  if (!state.filePath) return uiText('未命名.wbc');
  const parts = state.filePath.split(/[\\/]/);
  return parts[parts.length - 1] || uiText('未命名.wbc');
}

export function updateTitle(): void {
  const name = fileName();
  const prefix =
    (state.readOnly ? (state.settings.language === 'en' ? '[Read-only] ' : '[只读] ') : '') +
    (state.saveStatus === 'conflict' ? (state.settings.language === 'en' ? '[Conflict] ' : '[冲突] ') : '') +
    (state.dirty ? '• ' : '');
  titleEl.textContent = prefix + name;
  document.title = prefix + name + ' ' + uiText('— 白板画布');
}

export function setSaveStatus(status: SaveStatus): void {
  state.saveStatus = status;
  statusHook();
}

/** 把当前编辑区同步回当前页 */
export function syncActivePage(): void {
  const page = state.pages[state.activePage];
  if (page) page.elements = state.doc.elements;
}

const SIZE_STRING_KEYS = ['id', 'name', 'color', 'stroke', 'fill', 'src', 'text', 'label', 'fontFamily', 'stickyColor', 'groupId'];

function approxElBytes(el: El): number {
  let bytes = 160;
  const record = el as unknown as Record<string, unknown>;
  for (const key of SIZE_STRING_KEYS) {
    const value = record[key];
    if (typeof value === 'string') bytes += value.length * 2;
  }
  if (el.type === 'ink') bytes += el.points.length * 16;
  return bytes;
}

function docBytes(doc: Doc): number {
  let bytes = 128;
  for (const el of doc.elements) bytes += approxElBytes(el);
  return bytes;
}

function pagesBytes(pages: Page[]): number {
  let bytes = 128;
  for (const page of pages) {
    bytes += (page.id.length + page.name.length) * 2 + docBytes({ app: 'whiteboard-canvas', version: 3, elements: page.elements });
  }
  return bytes;
}

function trimUndo(): void {
  while (undoStack.length > 1 && (undoStack.length > HISTORY_LIMIT || undoBytes > HISTORY_BYTES_LIMIT)) {
    undoBytes -= undoStack.shift()?.bytes || 0;
  }
}

function trimRedo(): void {
  while (redoStack.length > 1 && (redoStack.length > HISTORY_LIMIT || redoBytes > HISTORY_BYTES_LIMIT)) {
    redoBytes -= redoStack.shift()?.bytes || 0;
  }
}

function trimPageUndo(): void {
  while (pageUndoStack.length > 1 && (pageUndoStack.length > PAGE_HISTORY_LIMIT || pageUndoBytes > HISTORY_BYTES_LIMIT)) {
    pageUndoBytes -= pageUndoStack.shift()?.bytes || 0;
  }
}

function trimPageRedo(): void {
  while (pageRedoStack.length > 1 && (pageRedoStack.length > PAGE_HISTORY_LIMIT || pageRedoBytes > HISTORY_BYTES_LIMIT)) {
    pageRedoBytes -= pageRedoStack.shift()?.bytes || 0;
  }
}

function activePageId(): string {
  return state.pages[state.activePage]?.id || '';
}

function stashPageHistory(): void {
  const id = activePageId();
  if (!id) return;
  historyByPage.set(id, { undo: undoStack, redo: redoStack, undoBytes, redoBytes });
}

function loadPageHistory(id: string): void {
  const entry = historyByPage.get(id);
  undoStack = entry ? entry.undo : [];
  redoStack = entry ? entry.redo : [];
  undoBytes = entry ? entry.undoBytes : 0;
  redoBytes = entry ? entry.redoBytes : 0;
}

function clearCurrentHistory(): void {
  undoStack = [];
  redoStack = [];
  undoBytes = 0;
  redoBytes = 0;
}

export function clearHistory(): void {
  clearCurrentHistory();
  historyByPage.clear();
}

export function clearPageHistory(): void {
  pageUndoStack = [];
  pageRedoStack = [];
  pageUndoBytes = 0;
  pageRedoBytes = 0;
}

function pageSnapshot(label: string): PageSnapshot {
  syncActivePage();
  const pages: Page[] = state.pages.map((page) => ({
    id: page.id,
    name: page.name,
    elements: cloneElements(page.elements)
  }));
  return { pages, activePage: state.activePage, label, bytes: pagesBytes(pages) };
}

function restorePageSnapshot(snapshot: PageSnapshot): void {
  state.pages = snapshot.pages;
  state.activePage = Math.min(snapshot.pages.length - 1, Math.max(0, snapshot.activePage));
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[state.activePage].elements };
  state.selectedIds = [];
  clearHistory();
  markDirty();
}

/** 记录页面级操作（如删除），与元素历史独立，由 Ctrl+Z 在元素历史为空时回退 */
export function pushPageUndo(label: string): void {
  const snapshot = pageSnapshot(label);
  pageUndoStack.push(snapshot);
  pageUndoBytes += snapshot.bytes;
  trimPageUndo();
  pageRedoStack = [];
  pageRedoBytes = 0;
}

export function undoPage(): boolean {
  const prev = pageUndoStack.pop();
  if (!prev) return false;
  const current = pageSnapshot(prev.label);
  pageRedoStack.push(current);
  pageRedoBytes += current.bytes;
  trimPageRedo();
  pageUndoBytes -= prev.bytes;
  restorePageSnapshot(prev);
  return true;
}

export function redoPage(): boolean {
  const next = pageRedoStack.pop();
  if (!next) return false;
  const current = pageSnapshot(next.label);
  pageUndoStack.push(current);
  pageUndoBytes += current.bytes;
  trimPageUndo();
  pageRedoBytes -= next.bytes;
  restorePageSnapshot(next);
  return true;
}

export function beginMutation(): Doc {
  mutationClones += 1;
  return { app: 'whiteboard-canvas', version: 3, elements: cloneElements(state.doc.elements) };
}

/** 重新取一份当前文档快照（编辑过程中元素被就地修改后刷新历史基线） */
export function snapshotDoc(): Doc {
  return { app: 'whiteboard-canvas', version: 3, elements: cloneElements(state.doc.elements) };
}

export function commitMutation(before: Doc | null, changed = true, label = '编辑'): void {
  if (!before || !changed) return;
  const bytes = docBytes(before);
  undoStack.push({ doc: before, label, bytes });
  undoBytes += bytes;
  trimUndo();
  redoStack = [];
  redoBytes = 0;
  pageRedoStack = [];
  pageRedoBytes = 0;
  markDirty();
}

export function undo(): boolean {
  const prev = undoStack.pop();
  if (!prev) return false;
  const current: HistEntry = { doc: { app: 'whiteboard-canvas', version: 3, elements: cloneElements(state.doc.elements) }, label: prev.label, bytes: docBytes(state.doc) };
  redoStack.push(current);
  redoBytes += current.bytes;
  trimRedo();
  undoBytes -= prev.bytes;
  state.doc = prev.doc;
  syncActivePage();
  markDirty();
  return true;
}

export function redo(): boolean {
  const next = redoStack.pop();
  if (!next) return false;
  const current: HistEntry = { doc: { app: 'whiteboard-canvas', version: 3, elements: cloneElements(state.doc.elements) }, label: next.label, bytes: docBytes(state.doc) };
  undoStack.push(current);
  undoBytes += current.bytes;
  trimUndo();
  redoBytes -= next.bytes;
  state.doc = next.doc;
  syncActivePage();
  markDirty();
  return true;
}

/** 供测试/状态栏观察历史内存与懒克隆次数 */
/** 当前文档近似体积，用于自动保存/恢复快照节流 */
export function docWeight(): number {
  syncActivePage();
  return pagesBytes(state.pages);
}

export function historyStats(): { entries: number; bytes: number; limit: number; clones: number } {
  return {
    entries: undoStack.length + redoStack.length,
    bytes: undoBytes + redoBytes,
    limit: HISTORY_BYTES_LIMIT,
    clones: mutationClones
  };
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

function parseElements(raw: unknown[], report?: string[]): El[] {
  const elements: El[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  for (const item of raw.slice(0, MAX_ELEMENTS)) {
    const el = sanitizeEl(item);
    if (!el) {
      dropped += 1;
      continue;
    }
    if (ids.has(el.id)) el.id = el.id + '-' + elements.length;
    ids.add(el.id);
    elements.push(el);
  }
  if (raw.length > MAX_ELEMENTS) report?.push(`元素数量超过 ${MAX_ELEMENTS}，已截断 ${raw.length - MAX_ELEMENTS} 个`);
  if (dropped > 0) report?.push(`有 ${dropped} 个元素格式无效，已跳过`);
  return elements;
}

export function loadFromText(text: string, report?: string[]): void {
  const clean = String(text).replace(/^\uFEFF/, '');
  const raw: unknown = JSON.parse(clean);
  if (!raw || typeof raw !== 'object') throw new Error('文件格式不正确');
  const obj = raw as { app?: unknown; version?: unknown; elements?: unknown; pages?: unknown; activePage?: unknown };
  if (obj.app !== 'whiteboard-canvas') throw new Error('文件格式不正确');
  const version = Number(obj.version) || 1;
  if (version > 3) throw new Error(`该文件由更高版本创建（v${version}），请升级应用后再打开。`);
  let pages: Page[] = [];
  if (Array.isArray(obj.pages)) {
    if (obj.pages.length > 200) report?.push(`页面数量超过 200，已截断 ${obj.pages.length - 200} 页`);
    for (const item of obj.pages.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const p = item as { id?: unknown; name?: unknown; elements?: unknown };
      pages.push({
        id: typeof p.id === 'string' && p.id ? p.id : uidPage(),
        name: typeof p.name === 'string' ? p.name.slice(0, 100) : `页面 ${pages.length + 1}`,
        elements: Array.isArray(p.elements) ? parseElements(p.elements, report) : []
      });
    }
  } else if (Array.isArray(obj.elements)) {
    pages.push({ id: uidPage(), name: '页面 1', elements: parseElements(obj.elements, report) });
  }
  if (!pages.length) throw new Error('文件格式不正确');
  const active = Math.min(pages.length - 1, Math.max(0, Number(obj.activePage) || 0));
  state.pages = pages;
  state.activePage = active;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: pages[active].elements };
  clearHistory();
  clearPageHistory();
}

export function resetDoc(): void {
  state.pages = [{ id: uidPage(), name: '页面 1', elements: [] }];
  state.activePage = 0;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[0].elements };
  state.filePath = null;
  state.fileStamp = null;
  state.autosaveBlocked = false;
  state.selectedIds = [];
  state.revision = 0;
  if (recoveryTimer !== null) {
    window.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  window.api.clearRecovery(state.recoveryKey);
  clearHistory();
  clearPageHistory();
}

export function addPage(name?: string): Page {
  syncActivePage();
  const page: Page = { id: uidPage(), name: name || uiText(`页面 ${state.pages.length + 1}`), elements: [] };
  state.pages.push(page);
  return page;
}

export function duplicatePage(index: number): Page | null {
  syncActivePage();
  const source = state.pages[index];
  if (!source) return null;
  const clone: Page = { id: uidPage(), name: (source.name + ' 副本').slice(0, 100), elements: cloneElements(source.elements) };
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const el of clone.elements) {
    const next = uid();
    idMap.set(el.id, next);
    el.id = next;
    if (el.groupId) {
      if (!groupMap.has(el.groupId)) groupMap.set(el.groupId, uid());
      el.groupId = groupMap.get(el.groupId);
    }
  }
  for (const el of clone.elements) {
    if (el.type === 'arrow') {
      if (el.fromId && idMap.has(el.fromId)) el.fromId = idMap.get(el.fromId);
      if (el.toId && idMap.has(el.toId)) el.toId = idMap.get(el.toId);
    }
  }
  state.pages.splice(index + 1, 0, clone);
  return clone;
}

export function removePage(index: number): boolean {
  if (state.pages.length <= 1) return false;
  if (index < 0 || index >= state.pages.length) return false;
  syncActivePage();
  stashPageHistory();
  const [removed] = state.pages.splice(index, 1);
  if (removed) historyByPage.delete(removed.id);
  if (state.activePage >= state.pages.length) state.activePage = state.pages.length - 1;
  else if (index < state.activePage) state.activePage -= 1;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[state.activePage].elements };
  state.selectedIds = [];
  loadPageHistory(state.pages[state.activePage].id);
  return true;
}

export function switchPage(index: number): boolean {
  if (index < 0 || index >= state.pages.length || index === state.activePage) return false;
  syncActivePage();
  stashPageHistory();
  state.activePage = index;
  state.doc = { app: 'whiteboard-canvas', version: 3, elements: state.pages[index].elements };
  state.selectedIds = [];
  loadPageHistory(state.pages[index].id);
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
  const alive = new Set(state.doc.elements.filter((el) => !el.hidden).map((el) => el.id));
  state.selectedIds = state.selectedIds.filter((id) => alive.has(id));
}

export function removeElement(id: string): void {
  const index = state.doc.elements.findIndex((el) => el.id === id);
  if (index >= 0) state.doc.elements.splice(index, 1);
  for (const el of state.doc.elements) {
    if (el.type !== 'arrow') continue;
    if (el.fromId === id) el.fromId = undefined;
    if (el.toId === id) el.toId = undefined;
  }
  state.selectedIds = state.selectedIds.filter((selected) => selected !== id);
}

export function markDirty(opts?: { autosave?: boolean }): void {
  state.revision++;
  state.dirty = true;
  state.saveStatus = 'dirty';
  window.api.setDirty(true);
  updateTitle();
  scheduleRecovery();
  statusHook();
  if (!opts || opts.autosave !== false) scheduleAutosave();
}

export function markSaved(): void {
  state.dirty = false;
  state.saveStatus = 'saved';
  state.autosaveBlocked = false;
  window.api.setDirty(false);
  window.api.clearRecovery(state.recoveryKey);
  if (recoveryTimer !== null) {
    window.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  updateTitle();
  setStatus('已保存');
  statusHook();
}

export function scheduleAutosave(): void {
  if (!state.filePath || state.autosaveBlocked) return;
  const delay = state.settings.autosaveDelay;
  if (!delay) return;
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(runAutosave, Math.max(200, delay * 1000));
}

async function runAutosave(): Promise<void> {
  if (autosaveRunning) return;
  autosaveRunning = true;
  try {
    await runAutosaveInner();
  } finally {
    autosaveRunning = false;
  }
}

async function runAutosaveInner(): Promise<void> {
  autosaveTimer = null;
  const editor = document.getElementById('editor') as HTMLTextAreaElement | null;
  if (editor && !editor.hidden) {
    scheduleAutosave();
    return;
  }
  if (!state.filePath || state.autosaveBlocked) return;
  const rev = state.revision;
  const text = serialize();
  setSaveStatus('saving');
  const result = await window.api.saveDoc(state.filePath, text, true, state.fileStamp);
  if (result.conflict) {
    state.autosaveBlocked = true;
    state.saveStatus = 'conflict';
    setStatus('自动保存已暂停：文件已被外部修改，请手动保存');
    window.api.log('warn', '自动保存暂停：文件已被外部修改 ' + state.filePath);
    statusHook();
    return;
  }
  if (result.error) {
    state.saveStatus = 'error';
    setStatus('自动保存失败');
    window.api.log('warn', '自动保存失败：' + result.error);
    statusHook();
    return;
  }
  if (result.canceled) {
    state.saveStatus = state.dirty ? 'dirty' : 'saved';
    statusHook();
    return;
  }
  if (result.path) state.filePath = result.path;
  if (result.stamp) state.fileStamp = result.stamp;
  state.autosaveAt = Date.now();
  if (state.revision === rev) markSaved();
  else scheduleAutosave();
}

export function scheduleRecovery(): void {
  recoveryDebug.scheduled += 1;
  if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
  const weight = docWeight();
  const delay = RECOVERY_DELAY + Math.min(12000, Math.floor(weight / (1024 * 1024)) * 400);
  recoveryTimer = window.setTimeout(() => {
    recoveryTimer = null;
    if (autosaveRunning) {
      scheduleRecovery();
      return;
    }
    recoveryDebug.fired += 1;
    const text = recoverySnapshotProvider ? recoverySnapshotProvider() : serialize();
    recoveryDebug.writes += 1;
    window.api.writeRecovery(text, state.filePath || '', state.recoveryKey, state.fileStamp);
  }, delay);
}
