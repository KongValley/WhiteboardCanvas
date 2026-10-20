// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Dash,
  El,
  ImageEl,
  PolyEl,
  Pt,
  TextEl,
  arrowHeadPathD,
  arrowPathD,
  arrowShaftD,
  bounds,
  boundsUnion,
  centerOf,
  cloneEl,
  dashArray,
  inkAbsolutePoints,
  listLines,
  moveEl,
  polyPathD,
  rectPathD,
  rotationOf,
  sanitizeEl,
  smoothPathD,
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
  setSaveStatus,
  setStatus,
  state,
  syncActivePage,
  updateTitle
} from './state';
import { FONT, renderAll } from './render';
import { applyTransform, fitToContent, screenToWorld, view, viewport, viewportCenter } from './view';
import { openForm } from './dialogs';
import type { FileStamp, OpenResult } from './types';

const progressEl = document.getElementById('progress') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLSpanElement;
const progressCancel = document.getElementById('progress-cancel') as HTMLButtonElement;
let progressToken = 0;
let progressCancelled = false;

function beginProgress(label: string): number {
  progressToken += 1;
  progressCancelled = false;
  progressText.textContent = label;
  progressEl.hidden = false;
  return progressToken;
}

function updateProgress(label: string): void {
  progressText.textContent = label;
}

function progressAborted(token: number): boolean {
  return progressCancelled || token !== progressToken;
}

function endProgress(token: number): void {
  if (token === progressToken) progressEl.hidden = true;
}

progressCancel.addEventListener('click', () => {
  progressCancelled = true;
  progressText.textContent = '正在取消…';
});

const CLIP_APP = 'whiteboard-canvas-elements';
const BIG_IMAGE = 50 * 1024 * 1024;
const MAX_TEXT = 200000;
const IMAGE_CACHE_BYTES = 128 * 1024 * 1024;
const imageCache = new Map<string, { img: HTMLImageElement; bytes: number }>();
let imageCacheBytes = 0;
let lastRenderScale = 1;

function touchImageCache(src: string, img: HTMLImageElement): void {
  const bytes = Math.max(1, img.naturalWidth * img.naturalHeight * 4);
  const old = imageCache.get(src);
  if (old) imageCacheBytes -= old.bytes;
  imageCache.delete(src);
  imageCache.set(src, { img, bytes });
  imageCacheBytes += bytes;
  while (imageCacheBytes > IMAGE_CACHE_BYTES && imageCache.size > 1) {
    const first = imageCache.keys().next().value as string | undefined;
    if (first === undefined) break;
    const entry = imageCache.get(first);
    if (entry) imageCacheBytes -= entry.bytes;
    imageCache.delete(first);
  }
}
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
  if (cached && cached.img.complete) {
    imageCache.delete(src);
    imageCache.set(src, cached);
    return Promise.resolve(cached.img);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      touchImageCache(src, img);
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
    // 小图/普通截图保留原始编码，避免把 JPEG 照片重编码成体积更大的 PNG
    if (maxSide <= 2000 && file.size <= 4 * 1024 * 1024) return { src: raw, w: size.w, h: size.h };
    const scale = 2000 / maxSide;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.w * scale));
    canvas.height = Math.max(1, Math.round(size.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { src: raw, w: size.w, h: size.h };
    ctx.drawImage(await loadImage(raw), 0, 0, canvas.width, canvas.height);
    const png = /^data:image\/png/i.test(raw) || /png$/i.test(file.type);
    return {
      src: canvas.toDataURL(png ? 'image/png' : 'image/jpeg', png ? undefined : 0.88),
      w: canvas.width,
      h: canvas.height
    };
  } catch {
    return null;
  }
}

export async function insertImage(file: File, at: Pt): Promise<string | null> {
  if (state.readOnly) {
    setStatus('只读模式，无法插入图片');
    return null;
  }
  const token = beginProgress('正在处理图片…');
  let prepared: { src: string; w: number; h: number } | null = null;
  try {
    prepared = await prepareImageFile(file);
  } finally {
    endProgress(token);
  }
  if (progressAborted(token)) {
    setStatus('已取消插入图片');
    return null;
  }
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
  commitMutation(before, true, '插入图片');
  renderAll();
  selectionChangedHook();
  return el.id;
}

export async function replaceImageSource(id: string, prepared: { src: string; w: number; h: number }): Promise<boolean> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'image') return false;
  const before = beginMutation();
  el.src = prepared.src;
  commitMutation(before, true, '替换图片');
  renderAll();
  return true;
}

export async function cropImage(id: string, crop: ImageEl['crop'], flipH: boolean, flipV: boolean): Promise<boolean> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'image') return false;
  const before = beginMutation();
  el.crop = crop;
  el.flipH = flipH || undefined;
  el.flipV = flipV || undefined;
  commitMutation(before, true, '裁剪/翻转图片');
  renderAll();
  return true;
}

/** 重新编码图片；canvas 重绘会剥离 EXIF。体积明显下降时提示。 */
export async function compressImage(id: string, mime: string, quality: number): Promise<boolean> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'image') return false;
  const img = await loadImage(el.src).catch(() => null);
  if (!img) return false;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0);
  const next = canvas.toDataURL(mime, quality);
  const beforeBytes = Math.round((el.src.length * 3) / 4);
  const afterBytes = Math.round((next.length * 3) / 4);
  if (afterBytes >= beforeBytes * 0.98) {
    setStatus('压缩后体积未减小，已取消');
    return false;
  }
  if (afterBytes < beforeBytes * 0.7) {
    const ok = await window.api.confirm(
      '图片体积明显减小',
      `约 ${(beforeBytes / 1048576).toFixed(2)}MB → ${(afterBytes / 1048576).toFixed(2)}MB，是否替换？（EXIF 将被移除）`
    );
    if (!ok) return false;
  }
  const before = beginMutation();
  el.src = next;
  el.mime = mime;
  commitMutation(before, true, '压缩图片');
  renderAll();
  return true;
}

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
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

export function cloneWithFreshIds(sources: El[], offset = 16): El[] {
  const groupMap = new Map<string, string>();
  const idMap = new Map<string, string>();
  const clones = sources.map((el) => {
    const clone = cloneEl(el);
    clone.id = uid();
    idMap.set(el.id, clone.id);
    if (clone.groupId) {
      if (!groupMap.has(clone.groupId)) groupMap.set(clone.groupId, uid());
      clone.groupId = groupMap.get(clone.groupId);
    }
    moveEl(clone, offset, offset);
    return clone;
  });
  for (const clone of clones) {
    if (clone.type === 'arrow') {
      if (clone.fromId && idMap.has(clone.fromId)) clone.fromId = idMap.get(clone.fromId);
      if (clone.toId && idMap.has(clone.toId)) clone.toId = idMap.get(clone.toId);
    }
  }
  return clones;
}

export function insertPastedElements(pasted: { elements: El[]; clipId: string }): void {
  if (state.readOnly) {
    setStatus('只读模式，无法粘贴');
    return;
  }
  commitEditHook();
  if (pasted.clipId && pasted.clipId === lastClipId) pasteSerial += 1;
  else {
    lastClipId = pasted.clipId;
    pasteSerial = 1;
  }
  const offset = 16 * pasteSerial;
  const before = beginMutation();
  const clones = cloneWithFreshIds(pasted.elements, offset);
  state.doc.elements.push(...clones);
  state.selectedIds = clones.map((clone) => clone.id);
  commitMutation(before, true, '粘贴');
  renderAll();
  selectionChangedHook();
  setStatus(`已粘贴 ${clones.length} 项`);
}

/** 从剪贴板粘贴（右键菜单/快捷键用）；优先自定义元素格式 */
export async function pasteFromClipboard(): Promise<void> {
  if (state.readOnly) {
    setStatus('只读模式，无法粘贴');
    return;
  }
  const elementsText = await window.api.readClipboardElements();
  const elementPaste = elementsText ? parseElementClipboard(elementsText) : null;
  if (elementPaste) {
    insertPastedElements(elementPaste);
    return;
  }
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
  commitMutation(before, true, '粘贴文字');
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
    // 搜索框、重命名/设置弹窗等输入控件保留原生粘贴行为
    if (isTextEntry(target)) return;
    if (state.readOnly) {
      e.preventDefault();
      setStatus('只读模式，无法粘贴');
      return;
    }
    if (pasted) {
      e.preventDefault();
      insertPastedElements(pasted);
      return;
    }
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const imageFiles = items
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (imageFiles.length) {
      e.preventDefault();
      const at = lastPointerWorld ?? viewportCenter();
      imageFiles.forEach((file, index) => {
        void insertImage(file, [at[0] + index * 24, at[1] + index * 24]);
      });
      return;
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
    commitMutation(before, true, '粘贴文字');
    renderAll();
    selectionChangedHook();
  });

  document.addEventListener('dragover', (e) => {
    if (!isTextEntry(e.target)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (isTextEntry(e.target)) return;
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
    const images = files.filter((file) => file.type.startsWith('image/'));
    images.forEach((file, index) => {
      void insertImage(file, [at[0] + index * 24, at[1] + index * 24]);
    });
  });
}

async function openDroppedBoard(file: File): Promise<void> {
  if (!(await confirmDiscard())) return;
  cancelEditHook();
  const withPath = file as File & { path?: string };
  try {
    if (withPath.path) {
      const token = beginProgress('正在打开文件…');
      let result: OpenResult;
      try {
        result = await window.api.openDoc(withPath.path);
      } finally {
        endProgress(token);
      }
      if (progressAborted(token)) {
        setStatus('已取消打开');
        return;
      }
      if (result.error) {
        window.api.showError('无法打开文件：' + result.error);
        return;
      }
      if (result.canceled || !result.path || typeof result.text !== 'string') return;
      applyOpenedDocument(result.path, result.text, !!result.repaired, result.stamp || null, result.report || []);
      return;
    }
    const text = await file.text();
    applyOpenedDocument(null, text, false, null);
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

function textFont(el: TextEl): string {
  return `${el.italic ? 'italic ' : ''}${el.bold ? '700 ' : ''}${el.fontSize}px ${el.fontFamily || FONT}`;
}

async function drawElement(ctx: CanvasRenderingContext2D, el: El): Promise<void> {
  if (el.hidden) return;
  const rotation = rotationOf(el);
  const opacity = el.opacity ?? 1;
  const needsSave = !!rotation || opacity < 1;
  if (needsSave) ctx.save();
  if (rotation) {
    const c = centerOf(el);
    ctx.translate(c[0], c[1]);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-c[0], -c[1]);
  }
  if (opacity < 1) ctx.globalAlpha *= opacity;
  ctx.setLineDash([]);
  switch (el.type) {
    case 'ink': {
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (el.highlight) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha *= 0.35;
      }
      tracePoints(ctx, inkAbsolutePoints(el));
      ctx.stroke();
      if (el.highlight) ctx.restore();
      break;
    }
    case 'rect': {
      const path = new Path2D(rectPathD(el));
      if (el.fill) {
        ctx.fillStyle = el.fill;
        ctx.fill(path);
      }
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      const dash = dashArray(el.dash, el.strokeWidth);
      if (dash) {
        ctx.setLineDash(dash);
        ctx.lineCap = 'round';
      }
      ctx.stroke(path);
      ctx.setLineDash([]);
      break;
    }
    case 'poly': {
      const path = new Path2D(polyPathD(el as PolyEl));
      if (el.fill) {
        ctx.fillStyle = el.fill;
        ctx.fill(path);
      }
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      const dash = dashArray(el.dash, el.strokeWidth);
      if (dash) {
        ctx.setLineDash(dash);
        ctx.lineCap = 'round';
      }
      ctx.stroke(path);
      ctx.setLineDash([]);
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
      const dash = dashArray(el.dash, el.strokeWidth);
      if (dash) {
        ctx.setLineDash(dash);
        ctx.lineCap = 'round';
      }
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case 'arrow': {
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const dash = dashArray(el.dash, el.strokeWidth);
      if (dash) {
        ctx.setLineDash(dash);
        ctx.stroke(new Path2D(arrowShaftD(el)));
        ctx.setLineDash([]);
        const headD = arrowHeadPathD(el);
        if (headD) ctx.stroke(new Path2D(headD));
      } else {
        ctx.stroke(new Path2D(arrowPathD(el)));
      }
      if (el.label) {
        const mx = (el.x1 + el.x2) / 2;
        const my = (el.y1 + el.y2) / 2 - 6;
        ctx.font = `14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(el.label, mx, my);
        ctx.fillStyle = el.stroke;
        ctx.fillText(el.label, mx, my);
      }
      break;
    }
    case 'image': {
      const img = await loadImage(el.src).catch(() => null);
      if (!img) break;
      const crop = el.crop || { x: 0, y: 0, w: 1, h: 1 };
      const sx = crop.x * img.naturalWidth;
      const sy = crop.y * img.naturalHeight;
      const sw = Math.max(1, crop.w * img.naturalWidth);
      const sh = Math.max(1, crop.h * img.naturalHeight);
      if (el.flipH || el.flipV) {
        ctx.save();
        ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
        ctx.scale(el.flipH ? -1 : 1, el.flipV ? -1 : 1);
        ctx.drawImage(img, sx, sy, sw, sh, -el.w / 2, -el.h / 2, el.w, el.h);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx, sy, sw, sh, el.x, el.y, el.w, el.h);
      }
      break;
    }
    case 'text': {
      const lineHeight = el.fontSize * (el.lineHeight || 1.4);
      ctx.font = textFont(el);
      ctx.fillStyle = el.color;
      ctx.textBaseline = 'top';
      const lines = listLines(el.text, el.bullets, el.numbered).flatMap((line) => wrapText(ctx, line, el.w));
      if (el.sticky) {
        ctx.fillStyle = el.stickyColor || '#fef3c7';
        ctx.fillRect(el.x - 10, el.y - 10, el.w + 20, Math.max(el.h, lines.length * lineHeight) + 20);
      }
      ctx.fillStyle = el.color;
      const align = el.align || 'left';
      ctx.textAlign = align;
      const tx = align === 'center' ? el.x + el.w / 2 : align === 'right' ? el.x + el.w : el.x;
      lines.forEach((line, i) => {
        const y = el.y + i * lineHeight + (lineHeight - el.fontSize) / 2;
        ctx.fillText(line, tx, y);
        if (el.underline || el.strike) {
          const width = ctx.measureText(line).width;
          let startX = tx;
          if (align === 'center') startX = tx - width / 2;
          else if (align === 'right') startX = tx - width;
          ctx.strokeStyle = el.color;
          ctx.lineWidth = Math.max(1, el.fontSize / 16);
          if (el.underline) {
            ctx.beginPath();
            ctx.moveTo(startX, y + el.fontSize * 1.08);
            ctx.lineTo(startX + width, y + el.fontSize * 1.08);
            ctx.stroke();
          }
          if (el.strike) {
            ctx.beginPath();
            ctx.moveTo(startX, y + el.fontSize * 0.6);
            ctx.lineTo(startX + width, y + el.fontSize * 0.6);
            ctx.stroke();
          }
        }
      });
      break;
    }
  }
  if ((el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') && el.label) {
    const b = bounds(el);
    ctx.fillStyle = '#1f2937';
    ctx.font = `16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(el.label, b.x + b.w / 2, b.y + b.h / 2, Math.max(20, b.w - 12));
  }
  if (needsSave) ctx.restore();
}

export interface RenderOptions {
  selection?: boolean;
  background?: boolean;
  /** 按设置绘制点阵/网格/米色背景 */
  styleBackground?: boolean;
  /** 导出倍率，默认 2x；超过 8192px 时自动降级 */
  scale?: number;
  /** 进度/取消令牌 */
  token?: number;
}

function drawBackground(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, mode: string): void {
  ctx.fillStyle = mode === 'cream' ? '#faf6ee' : '#ffffff';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  if (mode === 'dots' || mode === 'grid') {
    ctx.strokeStyle = '#e5e7eb';
    ctx.fillStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    const grid = state.settings.gridSize || 24;
    const startX = Math.floor(b.x / grid) * grid;
    const startY = Math.floor(b.y / grid) * grid;
    for (let x = startX; x <= b.x + b.w; x += grid) {
      for (let y = startY; y <= b.y + b.h; y += grid) {
        if (mode === 'dots') {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (mode === 'grid') {
      for (let x = startX; x <= b.x + b.w; x += grid) {
        ctx.beginPath();
        ctx.moveTo(x, b.y);
        ctx.lineTo(x, b.y + b.h);
        ctx.stroke();
      }
      for (let y = startY; y <= b.y + b.h; y += grid) {
        ctx.beginPath();
        ctx.moveTo(b.x, y);
        ctx.lineTo(b.x + b.w, y);
        ctx.stroke();
      }
    }
  }
}

export async function renderElementsPng(elements: El[], opts: RenderOptions = {}): Promise<string | null> {
  const visible = elements.filter((el) => !el.hidden);
  const ids = new Set(state.selectedIds);
  const selected = visible.filter((el) => ids.has(el.id));
  const useSelection = opts.selection !== false && selected.length > 0;
  const target = useSelection ? selected : visible;
  const b = boundsUnion(target);
  if (!b) return null;
  const pad = 40;
  const width = Math.max(1, b.w + pad * 2);
  const height = Math.max(1, b.h + pad * 2);
  const requested = Math.max(0.1, Math.min(4, opts.scale ?? 2));
  const scale = Math.min(requested, 8192 / width, 8192 / height);
  lastRenderScale = scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (opts.background !== false) {
    if (opts.styleBackground) drawBackground(ctx, b, state.settings.background);
    else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
  ctx.scale(scale, scale);
  ctx.translate(-b.x + pad, -b.y + pad);
  for (let i = 0; i < target.length; i++) {
    if (opts.token && progressAborted(opts.token)) throw new Error('已取消');
    if (opts.token) updateProgress(`正在渲染 ${i + 1}/${target.length}…`);
    await drawElement(ctx, target[i]);
  }
  return canvas.toDataURL('image/png');
}

export async function renderPng(opts: RenderOptions = {}): Promise<string | null> {
  return renderElementsPng(state.doc.elements, opts);
}

let pngExportScale = 2;
let pngExportBackground = true;

export async function exportPng(): Promise<boolean> {
  commitEditHook();
  const form = await openForm(
    '导出 PNG',
    [
      {
        key: 'scale',
        label: '倍率',
        type: 'select',
        value: String(pngExportScale),
        options: [
          { value: '1', label: '1x' },
          { value: '2', label: '2x' },
          { value: '3', label: '3x' }
        ]
      },
      { key: 'background', label: '包含背景', type: 'checkbox', value: pngExportBackground }
    ],
    '导出'
  );
  if (!form) return false;
  pngExportScale = Math.max(1, Math.min(3, Number(form.scale) || 2));
  pngExportBackground = form.background === true;
  const token = beginProgress('正在渲染 PNG…');
  let dataUrl: string | null = null;
  try {
    dataUrl = await renderPng({
      scale: pngExportScale,
      background: pngExportBackground,
      styleBackground: pngExportBackground && state.settings.exportBackground,
      token
    });
  } catch {
    setStatus('已取消导出');
    return false;
  } finally {
    endProgress(token);
  }
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
  const actual = lastRenderScale < pngExportScale - 0.01 ? `，受 8192px 限制实际 ${lastRenderScale.toFixed(2)}x` : '';
  setStatus((state.selectedIds.length ? '已导出选中区域' : '已导出 PNG') + '（' + pngExportScale + 'x' + actual + '）');
  return true;
}

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
  const token = beginProgress(mode === 'pdf' ? '正在生成 PDF…' : '正在准备打印…');
  let dataUrl: string | null = null;
  try {
    dataUrl = await renderPng({ selection: false, background: true, styleBackground: state.settings.exportBackground, token });
  } catch {
    setStatus('已取消');
    return false;
  } finally {
    endProgress(token);
  }
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

/** 导出所有页面为多页 A4 横向 PDF */
export async function exportAllPagesZip(format: 'png' | 'svg', target?: string): Promise<boolean> {
  commitEditHook();
  syncActivePage();
  const entries: { name: string; data: string; base64?: boolean }[] = [];
  const token = beginProgress(`正在导出 ${format.toUpperCase()}…`);
  try {
    for (let i = 0; i < state.pages.length; i++) {
      if (progressAborted(token)) throw new Error('已取消');
      updateProgress(`正在导出 ${format.toUpperCase()} ${i + 1}/${state.pages.length}…`);
      const page = state.pages[i];
      const name = `page-${String(i + 1).padStart(2, '0')}.${format}`;
      if (format === 'png') {
        const dataUrl = await renderElementsPng(page.elements, {
          selection: false,
          background: true,
          styleBackground: state.settings.exportBackground,
          token
        });
        if (dataUrl) entries.push({ name, data: dataUrl, base64: true });
      } else {
        const svg = buildSvg(page.elements);
        if (svg) entries.push({ name, data: svg });
      }
    }
  } catch {
    setStatus('已取消导出');
    return false;
  } finally {
    endProgress(token);
  }
  if (!entries.length) {
    setStatus('所有页面为空');
    return false;
  }
  setStatus(`正在导出 ${entries.length} 页 ${format.toUpperCase()}…`);
  const result = await window.api.exportZip(entries, '白板页面-' + format, target);
  if (result.error) {
    setStatus('导出页面失败：' + result.error);
    return false;
  }
  if (result.canceled || !result.path) {
    setStatus('');
    return false;
  }
  setStatus(`已导出 ${entries.length} 页 ${format.toUpperCase()}`);
  return true;
}

export async function exportAllPagesPdf(): Promise<boolean> {
  commitEditHook();
  syncActivePage();
  const images: string[] = [];
  const token = beginProgress('正在生成多页 PDF…');
  try {
    for (let i = 0; i < state.pages.length; i++) {
      if (progressAborted(token)) throw new Error('已取消');
      updateProgress(`正在渲染第 ${i + 1}/${state.pages.length} 页…`);
      const dataUrl = await renderElementsPng(state.pages[i].elements, {
        selection: false,
        background: true,
        styleBackground: state.settings.exportBackground,
        token
      });
      if (dataUrl) images.push(dataUrl);
    }
  } catch {
    setStatus('已取消导出');
    return false;
  } finally {
    endProgress(token);
  }
  if (!images.length) {
    setStatus('所有页面为空');
    return false;
  }
  const result = await window.api.printPages(images, 'pdf');
  if (result.error) {
    setStatus('导出 PDF 失败：' + result.error);
    return false;
  }
  if (result.canceled) return false;
  setStatus(`已导出 ${images.length} 页 PDF`);
  return true;
}

function escXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] as string);
}

function svgDash(dash: Dash | undefined, width: number): string {
  const values = dashArray(dash, width);
  return values ? ` stroke-dasharray="${values.join(' ')}" stroke-linecap="round"` : '';
}

function svgElText(el: TextEl): string {
  const lh = el.fontSize * (el.lineHeight || 1.4);
  const lines: { text: string; width: number }[] = [];
  const measure = document.createElement('canvas').getContext('2d');
  if (measure) measure.font = textFont(el);
  for (const line of listLines(el.text, el.bullets, el.numbered)) {
    if (!measure) {
      lines.push({ text: line, width: 0 });
      continue;
    }
    let current = '';
    for (const ch of line) {
      if (current && measure.measureText(current + ch).width > el.w) {
        lines.push({ text: current, width: measure.measureText(current).width });
        current = ch;
      } else {
        current += ch;
      }
    }
    lines.push({ text: current, width: measure.measureText(current).width });
  }
  const align = el.align || 'left';
  const x = align === 'center' ? el.x + el.w / 2 : align === 'right' ? el.x + el.w : el.x;
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const fontAttrs =
    `font-family="${escXml(el.fontFamily || FONT)}" font-size="${el.fontSize}" ` +
    `font-weight="${el.bold ? '700' : '400'}" font-style="${el.italic ? 'italic' : 'normal'}"`;
  let out = '';
  if (el.sticky) {
    out += `<rect x="${el.x - 10}" y="${el.y - 10}" width="${el.w + 20}" height="${Math.max(el.h, lines.length * lh) + 20}" fill="${escXml(el.stickyColor || '#fef3c7')}" rx="4"/>`;
  }
  lines.forEach((line, i) => {
    const y = el.y + i * lh + (lh - el.fontSize) / 2 + el.fontSize * 0.8;
    out += `<text x="${x}" y="${y}" ${fontAttrs} fill="${escXml(el.color)}" text-anchor="${anchor}" xml:space="preserve">${escXml(line.text)}</text>`;
    if (el.underline) {
      const sx = align === 'center' ? x - line.width / 2 : align === 'right' ? x - line.width : x;
      out += `<line x1="${sx}" y1="${y + 1}" x2="${sx + line.width}" y2="${y + 1}" stroke="${escXml(el.color)}" stroke-width="1"/>`;
    }
    if (el.strike) {
      const sx = align === 'center' ? x - line.width / 2 : align === 'right' ? x - line.width : x;
      out += `<line x1="${sx}" y1="${y - el.fontSize * 0.3}" x2="${sx + line.width}" y2="${y - el.fontSize * 0.3}" stroke="${escXml(el.color)}" stroke-width="1"/>`;
    }
  });
  return out;
}

function svgBackground(b: { x: number; y: number; w: number; h: number }, pad: number, width: number, height: number): string {
  const mode = state.settings.background;
  const x = b.x - pad;
  const y = b.y - pad;
  const fill = mode === 'cream' ? '#faf6ee' : '#ffffff';
  let out = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/>`;
  if (mode !== 'dots' && mode !== 'grid') return out;
  const grid = state.settings.gridSize || 24;
  const startX = Math.floor(x / grid) * grid;
  const startY = Math.floor(y / grid) * grid;
  if (mode === 'grid') {
    out += `<g stroke="#e5e7eb" stroke-width="1">`;
    for (let gx = startX; gx <= x + width; gx += grid) out += `<line x1="${gx}" y1="${y}" x2="${gx}" y2="${y + height}"/>`;
    for (let gy = startY; gy <= y + height; gy += grid) out += `<line x1="${x}" y1="${gy}" x2="${x + width}" y2="${gy}"/>`;
    out += `</g>`;
  } else {
    out += `<g fill="#e5e7eb">`;
    for (let gx = startX; gx <= x + width; gx += grid) {
      for (let gy = startY; gy <= y + height; gy += grid) out += `<circle cx="${gx}" cy="${gy}" r="1"/>`;
    }
    out += `</g>`;
  }
  return out;
}

export function buildSvg(elements: El[]): string | null {
  const visible = elements.filter((el) => !el.hidden);
  const b = boundsUnion(visible);
  if (!b) return null;
  const pad = 40;
  const width = b.w + pad * 2;
  const height = b.h + pad * 2;
  let body = '';
  for (const el of visible) {
    const rot = rotationOf(el);
    const c = centerOf(el);
    const attrs: string[] = [];
    if (rot) attrs.push(`transform="rotate(${rot} ${c[0]} ${c[1]})"`);
    const opacity = el.opacity ?? 1;
    if (opacity < 1) attrs.push(`opacity="${opacity}"`);
    const open = attrs.length ? `<g ${attrs.join(' ')}>` : '';
    const close = attrs.length ? '</g>' : '';
    let part = '';
    switch (el.type) {
      case 'text':
        part = svgElText(el);
        break;
      case 'image': {
        const crop = el.crop || { x: 0, y: 0, w: 1, h: 1 };
        const cropped = crop.w < 1 || crop.h < 1 || crop.x > 0 || crop.y > 0;
        if (cropped || el.flipH || el.flipV) {
          const view = 1000;
          const cw = Math.max(0.001, crop.w);
          const ch = Math.max(0.001, crop.h);
          const ix = (-crop.x / cw) * view;
          const iy = (-crop.y / ch) * view;
          const iw = view / cw;
          const ih = view / ch;
          const sx = el.flipH ? -1 : 1;
          const sy = el.flipV ? -1 : 1;
          const tx = el.flipH ? view : 0;
          const ty = el.flipV ? view : 0;
          const transform = sx < 0 || sy < 0 ? ` transform="translate(${tx} ${ty}) scale(${sx} ${sy})"` : '';
          part =
            `<svg x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" viewBox="0 0 ${view} ${view}" preserveAspectRatio="none">` +
            `<g${transform}><image x="${ix}" y="${iy}" width="${iw}" height="${ih}" preserveAspectRatio="none" href="${escXml(el.src)}"/></g></svg>`;
        } else {
          part = `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" preserveAspectRatio="none" href="${escXml(el.src)}"/>`;
        }
        break;
      }
      case 'ink':
        part = `<path d="${smoothPathD(inkAbsolutePoints(el))}" fill="none" stroke="${escXml(el.color)}" stroke-width="${el.width}" stroke-linecap="round" stroke-linejoin="round"${el.highlight ? ' opacity="0.35" style="mix-blend-mode:multiply"' : ''}/>`;
        break;
      case 'rect':
        part = `<path d="${rectPathD(el)}" fill="${el.fill ? escXml(el.fill) : 'none'}" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}"${svgDash(el.dash, el.strokeWidth)}/>`;
        break;
      case 'poly':
        part = `<path d="${polyPathD(el)}" fill="${el.fill ? escXml(el.fill) : 'none'}" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}" stroke-linejoin="round"${svgDash(el.dash, el.strokeWidth)}/>`;
        break;
      case 'ellipse':
        part = `<ellipse cx="${el.x + el.w / 2}" cy="${el.y + el.h / 2}" rx="${Math.max(el.w / 2, 0)}" ry="${Math.max(el.h / 2, 0)}" fill="${el.fill ? escXml(el.fill) : 'none'}" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}"${svgDash(el.dash, el.strokeWidth)}/>`;
        break;
      case 'arrow': {
        if (el.dash && el.dash !== 'solid') {
          const headD = arrowHeadPathD(el);
          part = `<path d="${arrowShaftD(el)}" fill="none" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}"${svgDash(el.dash, el.strokeWidth)}/>`;
          if (headD) {
            part += `<path d="${headD}" fill="none" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
          }
        } else {
          part = `<path d="${arrowPathD(el)}" fill="none" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        if (el.label) {
          part += `<text x="${(el.x1 + el.x2) / 2}" y="${(el.y1 + el.y2) / 2 - 6}" text-anchor="middle" font-size="14" font-family="${escXml(FONT)}" fill="${escXml(el.stroke)}" stroke="#fff" stroke-width="3" paint-order="stroke">${escXml(el.label)}</text>`;
        }
        break;
      }
    }
    if ((el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') && el.label) {
      const lb = bounds(el);
      part +=
        `<text x="${lb.x + lb.w / 2}" y="${lb.y + lb.h / 2}" text-anchor="middle" dominant-baseline="middle" ` +
        `font-family="${escXml(FONT)}" font-size="16" fill="#1f2937">${escXml(el.label)}</text>`;
    }
    body += open + part + close;
  }
  const bg = state.settings.exportBackground ? svgBackground(b, pad, width, height) : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${b.x - pad} ${b.y - pad} ${width} ${height}">` +
    `<defs></defs>${bg}${body}</svg>`;
}

export async function exportSvg(): Promise<boolean> {
  commitEditHook();
  const ids = new Set(state.selectedIds);
  const selected = state.doc.elements.filter((el) => ids.has(el.id) && !el.hidden);
  const svg = buildSvg(selected.length ? selected : state.doc.elements);
  if (!svg) {
    setStatus('画布为空');
    return false;
  }
  const result = await window.api.saveSvg(svg);
  if (result.error) {
    setStatus('导出 SVG 失败：' + result.error);
    return false;
  }
  if (result.canceled || !result.path) return false;
  setStatus(selected.length ? '已导出选中区域 SVG' : '已导出 SVG');
  return true;
}

export async function saveDocument(forceDialog: boolean): Promise<boolean> {
  commitEditHook();
  const rev = state.revision;
  const text = serialize();
  const expected = !forceDialog && state.filePath ? state.fileStamp : null;
  setSaveStatus('saving');
  const result = await window.api.saveDoc(forceDialog ? null : state.filePath, text, false, expected);
  if (result.reload && result.path && typeof result.text === 'string') {
    applyOpenedDocument(result.path, result.text, false, result.stamp || null);
    setStatus('已重新载入磁盘上的版本');
    return false;
  }
  if (result.conflict) {
    state.autosaveBlocked = true;
    setSaveStatus('conflict');
    setStatus('文件已被外部修改，请另存为或重新打开');
    return false;
  }
  if (result.error) {
    setSaveStatus('error');
    setStatus('保存失败：' + result.error);
    return false;
  }
  if (result.canceled || !result.path) {
    setSaveStatus(state.dirty ? 'dirty' : 'saved');
    return false;
  }
  state.filePath = result.path;
  state.fileStamp = result.stamp || null;
  state.autosaveBlocked = false;
  if (state.revision === rev) markSaved();
  else markDirty();
  return true;
}

export async function backupNow(): Promise<boolean> {
  commitEditHook();
  const result = await window.api.backupNow(serialize(), state.filePath, state.recoveryKey);
  setStatus(result.path ? '已备份' : '备份失败');
  return !!result.path;
}

function pickBackup(): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    void window.api.listBackups().then((backups) => {
      if (!backups.length) {
        window.api.showError('没有可恢复的自动备份');
        resolve(null);
        return;
      }
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const panel = document.createElement('div');
      panel.className = 'help-panel modal-panel backup-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      const title = document.createElement('h2');
      title.textContent = '恢复自动备份';
      const list = document.createElement('div');
      list.className = 'backup-list';
      const close = (value: { path: string; name: string } | null) => {
        overlay.remove();
        resolve(value);
      };
      for (const backup of backups) {
        const row = document.createElement('div');
        row.className = 'backup-row';
        const info = document.createElement('div');
        info.className = 'backup-info';
        const name = document.createElement('strong');
        name.textContent = backup.name;
        const meta = document.createElement('span');
        meta.textContent = `${new Date(backup.mtime).toLocaleString()} · ${(backup.size / 1024).toFixed(0)} KB`;
        info.append(name, meta);
        const restore = document.createElement('button');
        restore.textContent = '恢复';
        restore.addEventListener('click', () => close({ path: backup.path, name: backup.name }));
        const remove = document.createElement('button');
        remove.textContent = '删除';
        remove.addEventListener('click', async () => {
          const result = await window.api.deleteBackup(backup.path);
          if (result.error) setStatus('删除备份失败：' + result.error);
          else row.remove();
        });
        row.append(info, restore, remove);
        list.appendChild(row);
      }
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => close(null));
      const actions = document.createElement('div');
      actions.className = 'settings-actions';
      actions.appendChild(cancel);
      panel.append(title, list, actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
    });
  });
}

export async function restoreBackup(): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  cancelEditHook();
  const picked = await pickBackup();
  if (!picked) return false;
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
  state.fileStamp = null;
  state.autosaveBlocked = false;
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

const KNOWN_FONTS = ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'Segoe UI', 'Arial', 'Courier New'];

function warnMissingFonts(report?: string[]): void {
  const missing = new Set<string>();
  for (const el of state.doc.elements) {
    if (el.type === 'text' && el.fontFamily && !KNOWN_FONTS.includes(el.fontFamily)) missing.add(el.fontFamily);
  }
  if (missing.size) {
    const text = '缺少字体，已回退：' + Array.from(missing).join(', ');
    setStatus(text);
    report?.push(text);
  }
}

function showOpenReport(report: string[]): void {
  if (!report.length) return;
  void window.api.showInfo('打开报告', report.join('\n'));
}

export function applyOpenedDocument(
  path: string | null,
  text: string,
  repaired = false,
  stamp: FileStamp | null = null,
  extraReport: string[] = []
): boolean {
  const report = [...extraReport];
  try {
    loadFromText(text, report);
  } catch (err) {
    window.api.showError('无法打开文件：' + String((err as Error).message || err));
    return false;
  }
  state.filePath = repaired ? null : path;
  state.fileStamp = repaired ? null : stamp;
  state.autosaveBlocked = false;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
  renderAll();
  fitToContent();
  if (repaired) {
    markDirty({ autosave: false });
    setStatus('文件已损坏，已恢复部分内容，请另存为');
  } else {
    markSaved();
    warnMissingFonts(report);
  }
  showOpenReport(report);
  selectionChangedHook();
  return true;
}

export function applyRecoveredDocument(text: string, path: string | null, stamp: FileStamp | null = null): boolean {
  const report: string[] = [];
  try {
    loadFromText(text, report);
  } catch (err) {
    window.api.showError('无法恢复未保存内容：' + String((err as Error).message || err));
    return false;
  }
  state.filePath = path || null;
  state.fileStamp = stamp || null;
  // 没有时间戳的旧快照无法判断磁盘文件是否被外部修改，先暂停自动保存
  state.autosaveBlocked = !!path && !stamp;
  state.selectedIds = [];
  state.revision = 0;
  clearHistory();
  renderAll();
  fitToContent();
  markDirty({ autosave: false });
  warnMissingFonts(report);
  setStatus(state.autosaveBlocked ? '已恢复未保存内容；自动保存已暂停，请手动保存' : '已恢复上次未保存的编辑内容');
  showOpenReport(report);
  selectionChangedHook();
  return true;
}

export async function openDocument(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  cancelEditHook();
  const token = beginProgress('正在打开文件…');
  let result: OpenResult;
  try {
    result = await window.api.openDoc(path);
  } finally {
    endProgress(token);
  }
  if (progressAborted(token)) {
    setStatus('已取消打开');
    return;
  }
  if (result.error) {
    window.api.showError('无法打开文件：' + result.error);
    return;
  }
  if (result.canceled || !result.path || typeof result.text !== 'string') return;
  applyOpenedDocument(result.path, result.text, !!result.repaired, result.stamp || null, result.report || []);
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
