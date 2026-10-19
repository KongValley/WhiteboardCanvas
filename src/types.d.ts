// SPDX-License-Identifier: GPL-3.0-or-later
import type { El, ElType } from './model';

export interface OpenResult {
  path?: string;
  text?: string;
  canceled?: boolean;
  error?: string;
}

export interface SaveResult {
  path?: string;
  canceled?: boolean;
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
}

export interface Api {
  openDoc(path?: string): Promise<OpenResult>;
  saveDoc(path: string | null, text: string, silent?: boolean): Promise<SaveResult>;
  savePng(dataUrl: string, path?: string): Promise<SaveResult>;
  showError(message: string): void;
  writeClipboardText(text: string): void;
  confirmDiscard(): Promise<boolean>;
  setDirty(dirty: boolean): void;
  onMenu(cb: (action: string) => void): void;
  onRequestSave(cb: () => void): void;
  saveResult(ok: boolean): void;
}

export interface TestApi {
  count(): number;
  elements(): ElementInfo[];
  selectedIds(): string[];
  order(): string[];
  select(ids: string[]): void;
  duplicate(): number;
  nudge(dx: number, dy: number): void;
  bringToFront(): void;
  sendToBack(): void;
  clipboardJson(): string;
  addText(text: string, x: number, y: number): string;
  addInk(points: [number, number][], color: string, width: number): string;
  addShape(type: 'rect' | 'ellipse' | 'arrow', x: number, y: number, w: number, h: number): string;
  addImage(dataUrl: string, x: number, y: number): Promise<string | null>;
  hitTest(x: number, y: number): ElType | null;
  move(id: string, dx: number, dy: number): void;
  undo(): boolean;
  redo(): boolean;
  reset(): void;
  saveTo(path: string): Promise<boolean>;
  openFrom(path: string): Promise<boolean>;
  exportPngTo(path: string): Promise<boolean>;
  pngData(): Promise<string | null>;
}

declare global {
  interface Window {
    api: Api;
    __test?: TestApi;
  }
}

export type { El };
