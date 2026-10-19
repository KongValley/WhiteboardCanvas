// SPDX-License-Identifier: GPL-3.0-or-later
import {
  El,
  ImageEl,
  Pt,
  TextEl,
  arrowHeadPoints,
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

async function prepareImage(file: File): Promise<{ src: string; w: number; h: number } | null> {
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

export async function insertImage(file: File, at: Pt): Promise<string | null> {
  const prepared = await prepareImage(file);
  if (!prepared) {
    window.api.showError('无法读取图片');
    return null;
  }
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

function parseElementClipboard(text: string): { elements: El[]; clipId: string } | null {
  if (!text.trim().startsWith('{') || !text.includes('"app":"whiteboard-canvas-elements"')) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as { app?: unknown; elements?: unknown; clipId?: unknown };
    if (obj.app !== CLIP_APP || !Array.isArray(obj.elements)) return null;
    const elements: El[] = [];
    for (const item of obj.elements as unknown[]) {
      const el = sanitizeEl(item);
      if (el) elements.push(el);
    }
    if (!elements.length) return null;
    return { elements, clipId: typeof obj.clipId === 'string' ? obj.clipId : '' };
  } catch {
    return null;
  }
}

function insertPastedElements(pasted: { elements: El[]; clipId: string }): void {
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
      text,
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
  try {
    const text = await file.text();
    const withPath = file as File & { path?: string };
    applyOpenedDocument(withPath.path || null, text);
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
      tracePoints(ctx, inkAbsolutePoints(el));
      ctx.stroke();
      break;
    }
    case 'rect': {
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      break;
    }
    case 'ellipse': {
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.beginPath();
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.max(el.w / 2, 0), Math.max(el.h / 2, 0), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arrow': {
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const [h1, h2] = arrowHeadPoints(el);
      ctx.beginPath();
      ctx.moveTo(el.x1, el.y1);
      ctx.lineTo(el.x2, el.y2);
      ctx.moveTo(h1[0], h1[1]);
      ctx.lineTo(el.x2, el.y2);
      ctx.moveTo(h2[0], h2[1]);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
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

export async function renderPng(): Promise<string | null> {
  const b = boundsUnion(state.doc.elements);
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
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-b.x + pad, -b.y + pad);
  for (const el of state.doc.elements) await drawElement(ctx, el);
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
  setStatus('已导出 PNG');
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

export async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return window.api.confirmDiscard();
}

function applyOpenedDocument(path: string | null, text: string): boolean {
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

export async function openDocument(): Promise<void> {
  if (!(await confirmDiscard())) return;
  cancelEditHook();
  const result = await window.api.openDoc();
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
