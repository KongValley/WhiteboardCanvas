// SPDX-License-Identifier: GPL-3.0-or-later
import type { El, ElType } from './model';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface OpenResult {
  path?: string;
  text?: string;
  canceled?: boolean;
  error?: string;
  repaired?: boolean;
  stamp?: FileStamp | null;
  report?: string[];
}

export interface SaveResult {
  path?: string;
  canceled?: boolean;
  error?: string;
  stamp?: FileStamp | null;
  /** 文件在打开后被外部修改，需要用户处理 */
  conflict?: boolean;
  /** 用户选择重新载入外部版本 */
  reload?: boolean;
  text?: string;
}

export type Theme = 'light' | 'dark';
export type Language = 'zh' | 'en';

export interface Settings {
  autosaveDelay: number;
  closeBehavior: 'ask' | 'save' | 'discard';
  disableGpu: boolean;
  /** 低配模式：关闭小地图/标尺等重绘开销，适配老旧电脑 */
  lowSpec: boolean;
  background: 'dots' | 'grid' | 'plain' | 'cream';
  gridSize: number;
  theme: Theme;
  language: Language;
  exportBackground: boolean;
  printOrientation: 'landscape' | 'portrait';
  printPageSize: 'A4' | 'Letter';
  template: string;
  shortcuts: Record<string, string>;
}

export interface RecoveryData {
  text: string;
  path: string | null;
  key: string;
  stamp?: FileStamp | null;
  at?: number;
}

export interface StartupResult {
  settings: Settings;
  recovery: RecoveryData | null;
  openPath: string | null;
}

export interface AssociationState {
  supported: boolean;
  enabled: boolean;
  ok?: boolean;
  error?: string;
}

export interface ElementInfo {
  id: string;
  type: ElType;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  fontSize?: number;
  width?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  head?: boolean;
  highlight?: boolean;
  dash?: 'solid' | 'dash' | 'dot';
  opacity?: number;
}

export interface Api {
  startup(): Promise<StartupResult>;
  openDoc(path?: string): Promise<OpenResult>;
  saveDoc(path: string | null, text: string, silent?: boolean, expected?: FileStamp | null): Promise<SaveResult>;
  savePng(dataUrl: string, path?: string): Promise<SaveResult>;
  printPng(dataUrl: string, mode: 'pdf' | 'print', target?: string): Promise<SaveResult>;
  printPages(dataUrls: string[], mode: 'pdf' | 'print', target?: string): Promise<SaveResult>;
  saveSvg(svg: string, path?: string): Promise<SaveResult>;
  exportZip(
    entries: { name: string; data: string; base64?: boolean }[],
    defaultName: string,
    path?: string
  ): Promise<SaveResult>;
  showError(message: string): void;
  showInfo(title: string, detail: string): Promise<void>;
  openExternal(url: string): Promise<{ ok?: boolean; error?: string }>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  confirm(message: string, detail?: string): Promise<boolean>;
  setFullScreen(on: boolean): Promise<boolean>;
  writeClipboardText(text: string): void;
  writeClipboardImage(dataUrl: string): void;
  writeClipboardElements(text: string): void;
  readClipboardElements(): Promise<string>;
  readClipboardText(): Promise<string>;
  confirmDiscard(): Promise<boolean>;
  setDirty(dirty: boolean): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings | { error: string }>;
  initRecovery(key: string): void;
  writeRecovery(text: string, path: string, key: string, stamp?: FileStamp | null): void;
  clearRecovery(key?: string): void;
  backupNow(text: string, path: string | null, docKey?: string): Promise<{ path?: string; error?: string }>;
  listBackups(): Promise<{ path: string; name: string; mtime: number; size: number }[]>;
  deleteBackup(path: string): Promise<{ ok?: boolean; error?: string }>;
  restoreBackup(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  getAssociation(): Promise<AssociationState>;
  setAssociation(enabled: boolean): Promise<AssociationState>;
  onMenu(cb: (action: string, arg?: string) => void): void;
  onRequestSave(cb: () => void): void;
  saveResult(ok: boolean): void;
  testNewWindow?(): Promise<boolean>;
  testUserData?(): Promise<string>;
  versions: { app: string; electron: string; chrome: string };
}

export interface TestApi {
  count(): number;
  elements(): ElementInfo[];
  selectedIds(): string[];
  order(): string[];
  select(ids: string[]): void;
  duplicate(): number;
  nudge(dx: number, dy: number): void;
  /** 拖拽性能测量：返回分段耗时（最多移动前 200 个选中元素） */
  dragBench(count: number, dx: number): { ms: number; tMove: number; tNodes: number; tConn: number; tSel: number; n: number; frames: number };
  align(mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): void;
  distribute(axis: 'x' | 'y'): void;
  bringToFront(): void;
  sendToBack(): void;
  clipboardJson(): string;
  addText(text: string, x: number, y: number): string;
  addInk(points: [number, number][], color: string, width: number, highlight?: boolean): string;
  addShape(type: 'rect' | 'ellipse' | 'arrow' | 'line', x: number, y: number, w: number, h: number): string;
  addImage(dataUrl: string, x: number, y: number): Promise<string | null>;
  hitTest(x: number, y: number): ElType | null;
  move(id: string, dx: number, dy: number): void;
  undo(): boolean;
  redo(): boolean;
  reset(): void;
  saveTo(path: string): Promise<boolean>;
  saveDetailed(path: string): Promise<SaveResult>;
  serialized(): string;
  historyStats(): { entries: number; bytes: number; limit: number; clones: number };
  recoveryDebug(): { scheduled: number; fired: number; writes: number };
  openFrom(path: string): Promise<boolean>;
  exportPngTo(path: string): Promise<boolean>;
  pngData(opts?: { selection?: boolean; background?: boolean; scale?: number }): Promise<string | null>;
  setFill(id: string, fill: string): void;
  eraseAt(x: number, y: number): number;
  eraseObjectAt(x: number, y: number): number;
  setEraserMode(mode: 'ink' | 'object'): void;
  el(id: string): unknown;
  setEndpoints(id: string, x1: number, y1: number, x2: number, y2: number): void;
  zoomPercent(): number;
  fitSelection(): void;
  selectAll(): void;
  statusInfo(): string;
  copySelectionPng(): Promise<boolean>;
  exportSelectionPngTo(path: string): Promise<boolean>;
  replaceImage(id: string, dataUrl: string): Promise<boolean>;
  imageFit(id: string, mode: 'original' | 'fit-width'): void;
  gridSnapEnabled(): boolean;
  setView(zoom: number, panX: number, panY: number): void;
  present(on: boolean): Promise<boolean>;
  setReadOnly(on: boolean): void;
  isReadOnly(): boolean;
  isPresenting(): boolean;
  presentPage(delta: number): boolean;
  mountedCount(): number;
  printPdfTo(path: string): Promise<boolean>;
  addPoly(kind: 'triangle' | 'diamond' | 'star' | 'roundrect', x: number, y: number, w: number, h: number): string;
  setRotation(id: string, deg: number): void;
  groupSelection(): void;
  ungroupSelection(): void;
  setLocked(id: string, locked: boolean): void;
  setHidden(id: string, hidden: boolean): void;
  setTextStyle(id: string, patch: Record<string, unknown>): void;
  addSticky(text: string, x: number, y: number): string;
  connect(fromId: string, toId: string): string;
  lasso(points: [number, number][], shift?: boolean): string[];
  setLabel(id: string, label: string): void;
  setShapeLabel(id: string, label: string): void;
  copyFormat(): boolean;
  pasteFormat(id: string): boolean;
  history(): { label: string; done: boolean }[];
  jumpHistory(index: number): void;
  search(text: string): string[];
  replace(query: string, replacement: string, all: boolean): number;
  exportSvgTo(path: string): Promise<boolean>;
  exportPagesZipTo(path: string, format: 'png' | 'svg'): Promise<boolean>;
  pageNames(): string[];
  activePage(): number;
  addPage(name: string): string;
  duplicatePage(index: number): string | null;
  removePage(index: number): boolean;
  deletePage(index: number): Promise<boolean>;
  switchPage(index: number): boolean;
  crop(id: string, crop: { x: number; y: number; w: number; h: number }, flipH: boolean, flipV: boolean): Promise<boolean>;
  compress(id: string, mime: string, quality: number): Promise<boolean>;
  printAllPagesTo(path: string): Promise<boolean>;
  elementLabel(id: string): string;
  focusElement(id: string): boolean;
  applySettings(patch: Partial<Settings>): Promise<boolean>;
}

declare global {
  interface Window {
    api: Api;
    __test?: TestApi;
  }
}

export type { El };
