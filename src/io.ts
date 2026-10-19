// SPDX-License-Identifier: GPL-3.0-or-later
import {
  El,
  ImageEl,
  Pt,
  TextEl,
  arrowPathD,
  boundsUnion,
  inkAbsolutePoints,
  moveEl,
  sanitizeEl,
  tracePoints,
  uid
} from './model';
import {
  beginMutation,
  clearHistory,
  commitMutation,
  loadFromText,
  markDirty,
  markSaved,
  resetDoc,
  serialize,
  setStatus,
  state,
  updateTitle
} from './state';
import { FONT, renderAll } from './render';
import { applyTransform, fitToContent, screenToWorld, view, viewport, viewportCenter } from './view';

const CLIP_APP = 'whiteboard-canvas-elements';
const BIG_IMAGE = 50 * 1024 * 1024;
const MAX_TEXT = 200000;
const imageCache = new Map<string, HTMLImageElement>();
let lastPointerWorld: Pt | null = null;
let commitEditHook: () => void = () => {};
let cancelEditHook: () => void = () => {};
let selectionChangedHook: () => void = () => {};
let lastClipId = '';
let pasteSerial = 0;

export function setEditHooks(commit: () => void, cancel: () => void, selectionChanged: () => void): void {
  commitEditHook = commit;
  cancelEditHook = cancel;
  selectionChangedHook = selectionChanged;
}

export function imageSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached && cached.complete) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 读取并（必要时）缩放大图；超过 50MB 时先征求确认 */
export async function prepareImageFile(file: File): Promise<{ src: string; w: number; h: number } | null> {
  if (file.size > BIG_IMAGE) {
    const ok = await window.api.confirm('图片超过 50MB', `文件大小约 ${(file.size / 1048576).toFixed(1)}MB，继续插入可能占用大量内存。`);
    if (!ok) return null;
  }
  try {
    const raw = await readFileAsDataUrl(file);
    const size = await imageSize(raw);
    if (!size || !size.w || !size.h) return null;
    const maxSide = Math.max(size.w, size.h);
    if (maxSide <= 1600) return { src: raw, w: size.w, h: size.h };
    const scale = 1600 / maxSide;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.w * scale));
    canvas.height = Math.max(1, Math.round(size.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { src: raw, w: size.w, h: size.h };
    ctx.drawImage(await loadImage(raw), 0, 0, canvas.width, canvas.height);
    return { src: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
  } catch {
    return null;
  }
}

export async function insertImage(file: File, at: Pt): Promise<string | null> {
  const prepared = await prepareImageFile(file);
  if (!prepared) {
    if (file.size <= BIG_IMAGE) window.api.showError('无法读取图片');
    return null;
  }
  return insertImageSource(prepared, at);
}

export function insertImageSource(prepared: { src: string; w: number; h: number }, at: Pt): string {
  const scale = Math.min(1, 480 / Math.max(prepared.w, prepared.h));
  const before = beginMutation();
  const el: ImageEl = {
    id: uid(),
    type: 'image',
    x: at[0] - (prepared.w * scale) / 2,
    y: at[1] - (prepared.h * scale) / 2,
    w: prepared.w * scale,
    h: prepared.h * scale,
    src: prepared.src
  };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  commitMutation(before, true);
  renderAll();
  selectionChangedHook();
  return el.id;
}

export async function replaceImageSource(id: string, prepared: { src: string; w: number; h: number }): Promise<boolean> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'image') return false;
  const before = beginMutation();
  el.src = prepared.src;
  commitMutation(before, true);
  renderAll();
  return true;
}

function parseElementClipboard(text: string): { elements: El[]; clipId: string } | null {
  if (!text.trim().startsWith('{') || !text.includes('"app":"whiteboard-canvas-elements"')) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as { app?: unknown; elements?: unknown; clipId?: unknown };
    if (obj.app !== CLIP_APP || !Array.isArray(obj.elements)) return null;
    const elements: El[] = [];
    for (const item of (obj.elements as unknown[]).slice(0, 100000)) {
      const el = sanitizeEl(item);
      if (el) elements.push(el);
    }
    if (!elements.length) return null;
    return { elements, clipId: typeof obj.clipId === 'string' ? obj.clipId : '' };
  } catch {
    return null;
  }
}

export function insertPastedElements(pasted: { elements: El[]; clipId: string }): void {
  commitEditHook();
  if (pasted.clipId && pasted.clipId === lastClipId) pasteSerial += 1;
  else {
    lastClipId = pasted.clipId;
    pasteSerial = 1;
  }
  const offset = 16 * pasteSerial;
  const before = beginMutation();
  const clones = pasted.elements.map((el) => {
    const clone = structuredClone(el);
    clone.id = uid();
    moveEl(clone, offset, offset);
    return clone;
  });
  state.doc.elements.push(...clones);
  state.selectedIds = clones.map((clone) => clone.id);
  commitMutation(before, true);
  renderAll();
  selectionChangedHook();
  setStatus(`已粘贴 ${clones.length} 项`);
}

/** 从剪贴板粘贴（右键菜单用） */
export async function pasteFromClipboard(): Promise<void> {
  const text = await window.api.readClipboardText();
  const pasted = text ? parseElementClipboard(text) : null;
  if (pasted) {
    insertPastedElements(pasted);
    return;
  }
  if (!text || !text.trim()) {
    setStatus('剪贴板为空');
    return;
  }
  commitEditHook();
  const at = lastPointerWorld ?? viewportCenter();
  const before = beginMutation();
  const el: TextEl = {
    id: uid(),
    type: 'text',
    x: at[0],
    y: at[1],
    w: 320,
    h: state.fontSize * 1.4,
    text: text.slice(0, MAX_TEXT),
    fontSize: state.fontSize,
    color: state.color
  };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  commitMutation(before, true);
  renderAll();
  selectionChangedHook();
}

export function installPasteAndDrop(): void {
  viewport.addEventListener('pointermove', (e) => {
    lastPointerWorld = screenToWorld(e.clientX, e.clientY);
  });

  document.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement | null;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    const pasted = text ? parseElementClipboard(text) : null;
    if (target && target.id === 'editor') {
      if (pasted) e.preventDefault();
      return;
    }
    if (pasted) {
      e.preventDefault();
      insertPastedElements(pasted);
      return;
    }
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void insertImage(file, lastPointerWorld ?? viewportCenter());
          return;
        }
      }
    }
    if (!text || !text.trim()) return;
    e.preventDefault();
    commitEditHook();
    const at = lastPointerWorld ?? viewportCenter();
    const before = beginMutation();
    const el: TextEl = {
      id: uid(),
      type: 'text',
      x: at[0],
      y: at[1],
      w: 320,
      h: state.fontSize * 1.4,
      text: text.slice(0, MAX_TEXT),
      fontSize: state.fontSize,
      color: state.color
    };
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
    commitMutation(before, true);
    renderAll();
    selectionChangedHook();
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files);
    const board = files.find((file) => /\.wbc$/i.test(file.name));
    if (board) {
      void openDroppedBoard(board);
      return;
    }
    const vp = viewport.getBoundingClientRect();
    const inside = e.clientX >= vp.left && e.clientX <= vp.right && e.clientY >= vp.top && e.clientY <= vp.bottom;
    const at = inside ? screenToWorld(e.clientX, e.clientY) : viewportCenter();
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        void insertImage(file, at);
        break;
      }
    }
  });
}

async function openDroppedBoard(file: File): Promise<void> {
  if (!(await confirmDiscard())) return;
  cancelEditHook();
  const withPath = file as File & { path?: string };
  try {
    if (withPath.path) {
      // 已保存文档（v2 zip 或 v1 JSON）交由主进程读取，避免把二进制当 JSON。
      const result = await window.api.openDoc(withPath.path);
      if (result.error) {
        window.api.showError('无法打开文件：' + result.error);
        return;
      }
      if (result.canceled || !result.path || typeof result.text !== 'string') return;
      applyOpenedDocument(result.path, result.text);
      return;
    }
    const text = await file.text();
    applyOpenedDocument(null, text);
  } catch (err) {
    window.api.showError('无法读取文件：' + String((err as Error).message || err));
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const ch of paragraph) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

async function drawElement(ctx: CanvasRenderingContext2D, el: El): Promise<void> {
  switch (el.type) {
    case 'ink': {
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (el.highlight) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.35;
      }
      tracePoints(ctx, inkAbsolutePoints(el));
      ctx.stroke();
      if (el.highlight) ctx.restore();
      break;
    }
    case 'rect': {
      if (el.fill) {
        ctx.fillStyle = el.fill;
        ctx.fillRect(el.x, el.y, el.w, el.h);
      }
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.max(el.w / 2, 0), Math.max(el.h / 2, 0), 0, 0, Math.PI * 2);
      if (el.fill) {
        ctx.fillStyle = el.fill;
        ctx.fill();
      }
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.stroke();
      break;
    }
    case 'arrow': {
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const d = arrowPathD(el);
      const path = new Path2D(d);
      ctx.stroke(path);
      break;
    }
    case 'image': {
      const img = await loadImage(el.src).catch(() => null);
      if (img) ctx.drawImage(img, el.x, el.y, el.w, el.h);
      break;
    }
    case 'text': {
      const lineHeight = el.fontSize * 1.4;
      ctx.font = `${el.fontSize}px ${FONT}`;
      ctx.fillStyle = el.color;
      ctx.textBaseline = 'top';
      const lines = wrapText(ctx, el.text, el.w);
      lines.forEach((line, i) => {
        ctx.fillText(line, el.x, el.y + i * lineHeight + (lineHeight - el.fontSize) / 2);
      });
      break;
    }
  }
}

export async function renderPng(opts: { selection?: boolean; background?: boolean } = {}): Promise<string | null> {
  const ids = new Set(state.selectedIds);
  const selected = state.doc.elements.filter((el) => ids.has(el.id));
  const useSelection = opts.selection !== false && selected.length > 0;
  const elements = useSelection ? selected : state.doc.elements;
  const b = boundsUnion(elements);
  if (!b) return null;
  const pad = 40;
  const width = Math.max(1, b.w + pad * 2);
  const height = Math.max(1, b.h + pad * 2);
  const scale = Math.min(2, 8192 / width, 8192 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (opts.background !== false) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.translate(-b.x + pad, -b.y + pad);
  for (const el of elements) await drawElement(ctx, el);
  return canvas.toDataURL('image/png');
}

export async function exportPng(): Promise<boolean> {
  commitEditHook();
  const dataUrl = await renderPng();
  if (!dataUrl) {
    setStatus('画布为空');
    return false;
  }
  const result = await window.api.savePng(dataUrl);
  if (result.error) {
    setStatus('导出失败：' + result.error);
    return false;
  }
  if (result.canceled || !result.path) return false;
  setStatus(state.selectedIds.length ? '已导出选中区域' : '已导出 PNG');
  return true;
}

/** 复制选中元素为透明 PNG（Ctrl+Shift+C） */
export async function copySelectionPng(): Promise<boolean> {
  if (!state.selectedIds.length) {
    setStatus('请先选择元素');
    return false;
  }
  const dataUrl = await renderPng({ selection: true, background: false });
  if (!dataUrl) return false;
  window.api.writeClipboardImage(dataUrl);
  setStatus('已复制选区 PNG');
  return true;
}

export async function printCanvas(mode: 'pdf' | 'print'): Promise<boolean> {
  commitEditHook();
  const dataUrl = await renderPng({ selection: false, background: true });
  if (!dataUrl) {
    setStatus('画布为空');
    return false;
  }
  const result = await window.api.printPng(dataUrl, mode);
  if (result.error) {
    setStatus((mode === 'pdf' ? '导出 PDF 失败：' : '打印失败：') + result.error);
    return false;
  }
  if (result.canceled) return false;
  setStatus(mode === 'pdf' ? '已导出 A4 横向 PDF' : '已发送到打印机');
  return true;
}

export async function saveDocument(forceDialog: boolean): Promise<boolean> {
  commitEditHook();
  const rev = state.revision;
  const text = serialize();
  const result = await window.api.saveDoc(forceDialog ? null : state.filePath, text, false);
  if (result.error) {
    setStatus('保存失败：' + result.error);
    return false;
  }
  if (result.canceled || !result.path) return false;
  state.filePath = result.path;
  if (state.revision === rev) markSaved();
  else markDirty();
  return true;
}

export async function backupNow(): Promise<void> {
  commitEditHook();
  const result = await window.api.backupNow(serialize(), state.filePath);
  setStatus(result.path ? '已备份' : '备份失败');
}

export async function restoreBackup(): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  cancelEditHook();
  const picked = await window.api.restoreBackup();
  if (picked.error) {
    window.api.showError('无法恢复备份：' + picked.error);
    return false;
  }
  if (picked.canceled || !picked.path) return false;
  const result = await window.api.openDoc(picked.path);
  if (result.error || typeof result.text !== 'string') {
    window.api.showError('无法恢复备份：' + (result.error || '文件为空'));
    return false;
  }
  try {
    loadFromText(result.text);
  } catch (err) {
    window.api.showError('无法恢复备份：' + String((err as Error).message || err));
    return false;
  }
  state.filePath = null;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
  renderAll();
  fitToContent();
  markDirty({ autosave: false });
  setStatus('已恢复备份，请另存为');
  selectionChangedHook();
  return true;
}

export async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return window.api.confirmDiscard();
}

export function applyOpenedDocument(path: string | null, text: string): boolean {
  try {
    loadFromText(text);
  } catch (err) {
    window.api.showError('无法打开文件：' + String((err as Error).message || err));
    return false;
  }
  state.filePath = path;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
  renderAll();
  fitToContent();
  markSaved();
  selectionChangedHook();
  return true;
}

export function applyRecoveredDocument(text: string, path: string | null): boolean {
  try {
    loadFromText(text);
  } catch (err) {
    window.api.showError('无法恢复未保存内容：' + String((err as Error).message || err));
    return false;
  }
  state.filePath = path || null;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
  renderAll();
  fitToContent();
  markDirty({ autosave: false });
  setStatus('已恢复上次未保存的编辑内容');
  selectionChangedHook();
  return true;
}

export async function openDocument(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  cancelEditHook();
  const result = await window.api.openDoc(path);
  if (result.error) {
    window.api.showError('无法打开文件：' + result.error);
    return;
  }
  if (result.canceled || !result.path || typeof result.text !== 'string') return;
  applyOpenedDocument(result.path, result.text);
}

export async function newDocument(): Promise<void> {
  if (!(await confirmDiscard())) return;
  cancelEditHook();
  resetDoc();
  view.zoom = 1;
  view.pan.x = 0;
  view.pan.y = 0;
  applyTransform();
  renderAll();
  updateTitle();
  setStatus('');
  markSaved();
  selectionChangedHook();
}
