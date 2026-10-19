// SPDX-License-Identifier: GPL-3.0-or-later
import type { El, ElType } from './model';

export interface OpenResult {
  path?: string;
  text?: string;
  canceled?: boolean;
  error?: string;
  repaired?: boolean;
}

export interface SaveResult {
  path?: string;
  canceled?: boolean;
  error?: string;
}

export type Theme = 'light' | 'dark';
export type Language = 'zh' | 'en';

export interface Settings {
  autosaveDelay: number;
  closeBehavior: 'ask' | 'save' | 'discard';
  disableGpu: boolean;
  background: 'dots' | 'grid' | 'plain' | 'cream';
  theme: Theme;
  language: Language;
  exportBackground: boolean;
  template: string;
  shortcuts: Record<string, string>;
}

export interface RecoveryData {
  text: string;
  path: string | null;
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
  saveDoc(path: string | null, text: string, silent?: boolean): Promise<SaveResult>;
  savePng(dataUrl: string, path?: string): Promise<SaveResult>;
  printPng(dataUrl: string, mode: 'pdf' | 'print', target?: string): Promise<SaveResult>;
  printPages(dataUrls: string[], mode: 'pdf' | 'print', target?: string): Promise<SaveResult>;
  saveSvg(svg: string, path?: string): Promise<SaveResult>;
  showError(message: string): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  confirm(message: string, detail?: string): Promise<boolean>;
  setFullScreen(on: boolean): Promise<boolean>;
  writeClipboardText(text: string): void;
  writeClipboardImage(dataUrl: string): void;
  readClipboardText(): Promise<string>;
  confirmDiscard(): Promise<boolean>;
  setDirty(dirty: boolean): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings | { error: string }>;
  writeRecovery(text: string, path: string): void;
  clearRecovery(): void;
  backupNow(text: string, path: string | null): Promise<{ path?: string; error?: string }>;
  restoreBackup(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  getAssociation(): Promise<AssociationState>;
  setAssociation(enabled: boolean): Promise<AssociationState>;
  onMenu(cb: (action: string, arg?: string) => void): void;
  onRequestSave(cb: () => void): void;
  saveResult(ok: boolean): void;
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
  openFrom(path: string): Promise<boolean>;
  exportPngTo(path: string): Promise<boolean>;
  pngData(opts?: { selection?: boolean; background?: boolean }): Promise<string | null>;
  setFill(id: string, fill: string): void;
  eraseAt(x: number, y: number): number;
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
  copyFormat(): boolean;
  pasteFormat(id: string): boolean;
  history(): { label: string; done: boolean }[];
  jumpHistory(index: number): void;
  search(text: string): string[];
  exportSvgTo(path: string): Promise<boolean>;
  pageNames(): string[];
  activePage(): number;
  addPage(name: string): string;
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
