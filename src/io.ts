// SPDX-License-Identifier: GPL-3.0-or-later
import {
  El,
  ImageEl,
  PolyEl,
  Pt,
  TextEl,
  arrowPathD,
  boundsUnion,
  centerOf,
  inkAbsolutePoints,
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
    const clone = structuredClone(el);
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
    commitMutation(before, true, '粘贴文字');
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
      const result = await window.api.openDoc(withPath.path);
      if (result.error) {
        window.api.showError('无法打开文件：' + result.error);
        return;
      }
      if (result.canceled || !result.path || typeof result.text !== 'string') return;
      applyOpenedDocument(result.path, result.text, !!result.repaired);
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

function textFont(el: TextEl): string {
  return `${el.italic ? 'italic ' : ''}${el.bold ? '700 ' : ''}${el.fontSize}px ${el.fontFamily || FONT}`;
}

async function drawElement(ctx: CanvasRenderingContext2D, el: El): Promise<void> {
  if (el.hidden) return;
  const rotation = rotationOf(el);
  if (rotation) {
    const c = centerOf(el);
    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-c[0], -c[1]);
  }
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
      const path = new Path2D(rectPathD(el));
      if (el.fill) {
        ctx.fillStyle = el.fill;
        ctx.fill(path);
      }
      ctx.strokeStyle = el.stroke;
      ctx.lineWidth = el.strokeWidth;
      ctx.stroke(path);
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
      ctx.stroke(path);
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
      ctx.stroke(new Path2D(arrowPathD(el)));
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
      const rawLines = el.text.split('\n');
      const lines = (el.bullets ? rawLines.map((line) => (line ? '• ' + line : line)) : rawLines).flatMap((line) =>
        wrapText(ctx, line, el.w)
      );
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
  if (rotation) ctx.restore();
}

export interface RenderOptions {
  selection?: boolean;
  background?: boolean;
  /** 按设置绘制点阵/网格/米色背景 */
  styleBackground?: boolean;
}

function drawBackground(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, mode: string): void {
  ctx.fillStyle = mode === 'cream' ? '#faf6ee' : '#ffffff';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  if (mode === 'dots' || mode === 'grid') {
    ctx.strokeStyle = '#e5e7eb';
    ctx.fillStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    const startX = Math.floor(b.x / 24) * 24;
    const startY = Math.floor(b.y / 24) * 24;
    for (let x = startX; x <= b.x + b.w; x += 24) {
      for (let y = startY; y <= b.y + b.h; y += 24) {
        if (mode === 'dots') {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (mode === 'grid') {
      for (let x = startX; x <= b.x + b.w; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x, b.y);
        ctx.lineTo(x, b.y + b.h);
        ctx.stroke();
      }
      for (let y = startY; y <= b.y + b.h; y += 24) {
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
  const scale = Math.min(2, 8192 / width, 8192 / height);
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
  for (const el of target) await drawElement(ctx, el);
  return canvas.toDataURL('image/png');
}

export async function renderPng(opts: RenderOptions = {}): Promise<string | null> {
  return renderElementsPng(state.doc.elements, opts);
}

export async function exportPng(): Promise<boolean> {
  commitEditHook();
  const dataUrl = await renderPng({ styleBackground: state.settings.exportBackground });
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
  const dataUrl = await renderPng({ selection: false, background: true, styleBackground: state.settings.exportBackground });
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
export async function exportAllPagesPdf(): Promise<boolean> {
  commitEditHook();
  const images: string[] = [];
  for (const page of state.pages) {
    const dataUrl = await renderElementsPng(page.elements, { selection: false, background: true, styleBackground: state.settings.exportBackground });
    if (dataUrl) images.push(dataUrl);
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

function svgElText(el: TextEl): string {
  const lh = el.fontSize * (el.lineHeight || 1.4);
  const raw = el.text.split('\n');
  const lines: { text: string; width: number }[] = [];
  const measure = document.createElement('canvas').getContext('2d');
  if (measure) measure.font = textFont(el);
  for (const line of (el.bullets ? raw.map((l) => (l ? '• ' + l : l)) : raw)) {
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
  const font = `${el.italic ? 'italic ' : ''}${el.bold ? '700 ' : ''}${el.fontSize}px ${escXml(el.fontFamily || FONT)}`;
  let out = '';
  if (el.sticky) {
    out += `<rect x="${el.x - 10}" y="${el.y - 10}" width="${el.w + 20}" height="${Math.max(el.h, lines.length * lh) + 20}" fill="${escXml(el.stickyColor || '#fef3c7')}" rx="4"/>`;
  }
  lines.forEach((line, i) => {
    const y = el.y + i * lh + (lh - el.fontSize) / 2 + el.fontSize * 0.8;
    out += `<text x="${x}" y="${y}" font="${font}" fill="${escXml(el.color)}" text-anchor="${anchor}" xml:space="preserve">${escXml(line.text)}</text>`;
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
    const open = rot ? `<g transform="rotate(${rot} ${c[0]} ${c[1]})">` : '';
    const close = rot ? '</g>' : '';
    let part = '';
    switch (el.type) {
      case 'text':
        part = svgElText(el);
        break;
      case 'image': {
        const crop = el.crop || { x: 0, y: 0, w: 1, h: 1 };
        part = `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" preserveAspectRatio="none" href="${escXml(el.src)}"/>`;
        if (crop.w < 1 || crop.h < 1 || crop.x > 0 || crop.y > 0 || el.flipH || el.flipV) {
          part = `<g clip-path="url(#clip-${escXml(el.id)})">${part}</g>`;
        }
        break;
      }
      case 'ink':
        part = `<path d="${smoothPathD(inkAbsolutePoints(el))}" fill="none" stroke="${escXml(el.color)}" stroke-width="${el.width}" stroke-linecap="round" stroke-linejoin="round"${el.highlight ? ' opacity="0.35" style="mix-blend-mode:multiply"' : ''}/>`;
        break;
      case 'rect':
        part = `<path d="${rectPathD(el)}" fill="${el.fill ? escXml(el.fill) : 'none'}" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}"/>`;
        break;
      case 'poly':
        part = `<path d="${polyPathD(el)}" fill="${el.fill ? escXml(el.fill) : 'none'}" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}" stroke-linejoin="round"/>`;
        break;
      case 'ellipse':
        part = `<ellipse cx="${el.x + el.w / 2}" cy="${el.y + el.h / 2}" rx="${Math.max(el.w / 2, 0)}" ry="${Math.max(el.h / 2, 0)}" fill="${el.fill ? escXml(el.fill) : 'none'}" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}"/>`;
        break;
      case 'arrow':
        part = `<path d="${arrowPathD(el)}" fill="none" stroke="${escXml(el.stroke)}" stroke-width="${el.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
        if (el.label) {
          part += `<text x="${(el.x1 + el.x2) / 2}" y="${(el.y1 + el.y2) / 2 - 6}" text-anchor="middle" font-size="14" font-family="${escXml(FONT)}" fill="${escXml(el.stroke)}" stroke="#fff" stroke-width="3" paint-order="stroke">${escXml(el.label)}</text>`;
        }
        break;
    }
    body += open + part + close;
  }
  const clipDefs = visible
    .filter((el): el is ImageEl => el.type === 'image' && !!(el.crop && (el.crop.w < 1 || el.crop.h < 1 || el.crop.x > 0 || el.crop.y > 0)))
    .map((el) => `<clipPath id="clip-${escXml(el.id)}"><rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}"/></clipPath>`)
    .join('');
  const bg = state.settings.exportBackground
    ? `<rect x="${b.x - pad}" y="${b.y - pad}" width="${width}" height="${height}" fill="#ffffff"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${b.x - pad} ${b.y - pad} ${width} ${height}">` +
    `<defs>${clipDefs}</defs>${bg}${body}</svg>`;
}

export async function exportSvg(): Promise<boolean> {
  commitEditHook();
  const svg = buildSvg(state.doc.elements);
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
  setStatus('已导出 SVG');
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

const KNOWN_FONTS = ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'Segoe UI', 'Arial', 'Courier New'];

function warnMissingFonts(): void {
  const missing = new Set<string>();
  for (const el of state.doc.elements) {
    if (el.type === 'text' && el.fontFamily && !KNOWN_FONTS.includes(el.fontFamily)) missing.add(el.fontFamily);
  }
  if (missing.size) setStatus('缺少字体，已回退：' + Array.from(missing).join(', '));
}

export function applyOpenedDocument(path: string | null, text: string, repaired = false): boolean {
  try {
    loadFromText(text);
  } catch (err) {
    window.api.showError('无法打开文件：' + String((err as Error).message || err));
    return false;
  }
  state.filePath = repaired ? null : path;
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
    warnMissingFonts();
  }
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
  warnMissingFonts();
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
  applyOpenedDocument(result.path, result.text, !!result.repaired);
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
