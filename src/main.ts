// SPDX-License-Identifier: GPL-3.0-or-later
import './style.css';
import {
  ArrowEl,
  El,
  EllipseEl,
  ImageEl,
  InkEl,
  Pt,
  Rect,
  RectEl,
  TextEl,
  Tool,
  arrowHeadPoints,
  bounds,
  hitTest,
  moveEl,
  normalizeInk,
  rectsIntersect,
  smoothPathD,
  uid
} from './model';
import {
  Doc,
  beginMutation,
  clearHistory,
  commitMutation,
  loadFromText,
  markDirty,
  markSaved,
  pruneSelection,
  removeElement,
  resetDoc,
  redo as redoHistory,
  serialize,
  setStatus,
  state,
  undo as undoHistory
} from './state';
import { FONT, renderAll, setEditing, updateElNode, updateSelectionBox } from './render';
import { applyTransform, fitToContent, screenToWorld, view, viewport, viewportCenter, world, zoomAt } from './view';
import {
  exportPng,
  imageSize,
  insertImage,
  installPasteAndDrop,
  newDocument,
  openDocument,
  renderPng,
  saveDocument,
  setEditHooks
} from './io';
import type { TestApi } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#1f2937', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];
const WIDTHS = [2, 4, 8];
const SIZES = [16, 24, 32, 48];
const TOOL_KEYS: Record<string, Tool> = { v: 'select', p: 'pen', e: 'eraser', t: 'text', r: 'rect', o: 'ellipse', a: 'arrow' };

const editor = document.getElementById('editor') as HTMLTextAreaElement;
const toolbar = document.getElementById('toolbar') as HTMLDivElement;
const palette = document.getElementById('palette') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const selectionBox = document.getElementById('selection') as HTMLDivElement;
const pickImageBtn = document.getElementById('pick-image') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
const zoomFitBtn = document.getElementById('zoom-fit') as HTMLButtonElement;
const eraserRing = document.getElementById('eraser-ring') as HTMLDivElement;
const helpOverlay = document.getElementById('help') as HTMLDivElement;
const helpBtn = document.getElementById('help-btn') as HTMLButtonElement;
const helpClose = document.getElementById('help-close') as HTMLButtonElement;

let colorRow: HTMLDivElement;
let widthRow: HTMLDivElement;
let sizeRow: HTMLDivElement;

let editingId: string | null = null;
let editBefore: Doc | null = null;
let editTextSnapshot = '';

type ElNode = HTMLElement | SVGSVGElement;

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; startClient: Pt; startPan: { x: number; y: number } }
  | { kind: 'move'; ids: string[]; start: Pt; before: Doc; dx: number; dy: number }
  | { kind: 'resize'; id: string; corner: string; before: Doc; orig: Rect; changed: boolean }
  | { kind: 'pen'; points: Pt[]; before: Doc; preview: SVGPathElement }
  | { kind: 'shape'; type: 'rect' | 'ellipse' | 'arrow'; start: Pt; before: Doc; preview: ElNode }
  | { kind: 'marquee'; start: Pt; beforeSelection: string[]; preview: HTMLDivElement }
  | { kind: 'erase'; before: Doc | null; deleted: boolean };

let drag: DragState = { kind: 'none' };

function selectedElements(): El[] {
  const ids = new Set(state.selectedIds);
  return state.doc.elements.filter((el) => ids.has(el.id));
}

function setSelection(ids: string[]): void {
  const alive = new Set(state.doc.elements.map((el) => el.id));
  state.selectedIds = Array.from(new Set(ids)).filter((id) => alive.has(id));
  syncPaletteFromSelection();
  refreshPalette();
  updateSelectionBox();
}

function syncPaletteFromSelection(): void {
  if (editingId || state.selectedIds.length !== 1) return;
  const el = state.doc.elements.find((item) => item.id === state.selectedIds[0]);
  if (!el) return;
  if (el.type === 'text') {
    state.color = el.color;
    state.fontSize = el.fontSize;
  } else if (el.type === 'ink') {
    state.color = el.color;
    state.width = el.width;
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'arrow') {
    state.color = el.stroke;
    state.width = el.strokeWidth;
  }
}

function editingTextEl(): TextEl | null {
  if (!editingId) return null;
  const el = state.doc.elements.find((item) => item.id === editingId);
  return el && el.type === 'text' ? el : null;
}

function beginEdit(id: string, before: Doc | null): void {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'text') return;
  setSelection([id]);
  editingId = id;
  editBefore = before ?? beginMutation();
  editTextSnapshot = el.text;
  editor.hidden = false;
  editor.value = el.text;
  editor.style.left = el.x + 'px';
  editor.style.top = el.y + 'px';
  editor.style.width = el.w + 'px';
  editor.style.fontFamily = FONT;
  editor.style.fontSize = el.fontSize + 'px';
  editor.style.color = el.color;
  editor.style.height = 'auto';
  editor.style.height = Math.max(el.fontSize * 1.4, editor.scrollHeight) + 'px';
  setEditing(true);
  updateSelectionBox();
  editor.focus();
  const pos = editor.value.length;
  editor.setSelectionRange(pos, pos);
}

function commitEdit(): void {
  if (!editingId) return;
  const id = editingId;
  const before = editBefore;
  const el = state.doc.elements.find((item) => item.id === id);
  const text = editor.value;
  const wasNew = !before || !before.elements.some((item) => item.id === id);
  const width = parseFloat(editor.style.width);
  editingId = null;
  editBefore = null;
  editor.hidden = true;
  setEditing(false);
  if (!el || el.type !== 'text') {
    updateSelectionBox();
    return;
  }
  if (!text.trim()) {
    removeElement(id);
    renderAll();
    refreshPalette();
    return;
  }
  const widthChanged = Number.isFinite(width) && Math.abs(width - el.w) > 0.5;
  if (!wasNew && text === editTextSnapshot && !widthChanged) {
    updateSelectionBox();
    return;
  }
  el.text = text;
  if (Number.isFinite(width)) el.w = Math.max(60, width);
  renderAll();
  commitMutation(before, true);
}

function cancelEdit(): void {
  if (!editingId) return;
  const id = editingId;
  const before = editBefore;
  const wasNew = !before || !before.elements.some((item) => item.id === id);
  const el = state.doc.elements.find((item) => item.id === id);
  editingId = null;
  editBefore = null;
  editor.hidden = true;
  setEditing(false);
  if (el && el.type === 'text') el.text = editTextSnapshot;
  if (wasNew) removeElement(id);
  renderAll();
  refreshPalette();
}

function createTextAt(at: Pt): void {
  commitEdit();
  const before = beginMutation();
  const el: TextEl = {
    id: uid(),
    type: 'text',
    x: at[0],
    y: at[1],
    w: 320,
    h: state.fontSize * 1.4,
    text: '',
    fontSize: state.fontSize,
    color: state.color
  };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  renderAll();
  beginEdit(el.id, before);
}

function commitPen(d: Extract<DragState, { kind: 'pen' }>): void {
  d.preview.parentElement?.remove();
  if (!d.points.length) return;
  const norm = normalizeInk(d.points);
  const el: InkEl = {
    id: uid(),
    type: 'ink',
    x: norm.x,
    y: norm.y,
    w: norm.w,
    h: norm.h,
    points: norm.points,
    color: state.color,
    width: state.width
  };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  commitMutation(d.before, true);
  renderAll();
  refreshPalette();
}

function commitShape(d: Extract<DragState, { kind: 'shape' }>, end: Pt): void {
  d.preview.remove();
  const w = Math.abs(end[0] - d.start[0]);
  const h = Math.abs(end[1] - d.start[1]);
  if (d.type === 'arrow') {
    if (Math.hypot(w, h) < 4) return;
    const el: ArrowEl = {
      id: uid(),
      type: 'arrow',
      x1: d.start[0],
      y1: d.start[1],
      x2: end[0],
      y2: end[1],
      stroke: state.color,
      strokeWidth: state.width
    };
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
  } else if (w >= 4 && h >= 4) {
    const x = Math.min(d.start[0], end[0]);
    const y = Math.min(d.start[1], end[1]);
    const el: RectEl | EllipseEl =
      d.type === 'rect'
        ? { id: uid(), type: 'rect', x, y, w, h, stroke: state.color, strokeWidth: state.width }
        : { id: uid(), type: 'ellipse', x, y, w, h, stroke: state.color, strokeWidth: state.width };
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
  } else {
    return;
  }
  commitMutation(d.before, true);
  renderAll();
  refreshPalette();
}

function createPreviewSvg(stroke: string, strokeWidth: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.width = '1px';
  svg.style.height = '1px';
  svg.style.overflow = 'visible';
  svg.style.pointerEvents = 'none';
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', stroke);
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  return svg;
}

function startPen(at: Pt): DragState {
  const svg = createPreviewSvg(state.color, state.width);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('d', smoothPathD([at]));
  svg.appendChild(path);
  world.appendChild(svg);
  return { kind: 'pen', points: [at], before: beginMutation(), preview: path };
}

function startShape(type: 'rect' | 'ellipse' | 'arrow', at: Pt): DragState {
  let preview: ElNode;
  if (type === 'arrow') {
    const svg = createPreviewSvg(state.color, state.width);
    svg.appendChild(document.createElementNS(SVG_NS, 'path'));
    preview = svg;
  } else {
    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.boxSizing = 'border-box';
    div.style.border = state.width + 'px solid ' + state.color;
    div.style.pointerEvents = 'none';
    if (type === 'ellipse') div.style.borderRadius = '50%';
    preview = div;
  }
  world.appendChild(preview);
  return { kind: 'shape', type, start: at, before: beginMutation(), preview };
}

function updateShapePreview(d: Extract<DragState, { kind: 'shape' }>, end: Pt): void {
  if (d.type === 'arrow') {
    const path = (d.preview as SVGSVGElement).firstElementChild as SVGPathElement | null;
    if (!path) return;
    const temp: ArrowEl = {
      id: 'preview',
      type: 'arrow',
      x1: d.start[0],
      y1: d.start[1],
      x2: end[0],
      y2: end[1],
      stroke: state.color,
      strokeWidth: state.width
    };
    const [h1, h2] = arrowHeadPoints(temp);
    path.setAttribute(
      'd',
      `M ${d.start[0]} ${d.start[1]} L ${end[0]} ${end[1]} M ${h1[0]} ${h1[1]} L ${end[0]} ${end[1]} M ${h2[0]} ${h2[1]} L ${end[0]} ${end[1]}`
    );
    return;
  }
  const div = d.preview as HTMLDivElement;
  div.style.left = Math.min(d.start[0], end[0]) + 'px';
  div.style.top = Math.min(d.start[1], end[1]) + 'px';
  div.style.width = Math.abs(end[0] - d.start[0]) + 'px';
  div.style.height = Math.abs(end[1] - d.start[1]) + 'px';
}

function resizeElement(el: El, corner: string, orig: Rect, p: Pt): boolean {
  if (el.type === 'text') {
    const w = Math.max(60, p[0] - el.x);
    if (Math.abs(w - el.w) < 0.5) return false;
    el.w = w;
    return true;
  }
  if (el.type === 'ink' || el.type === 'arrow') return false;
  let left = orig.x;
  let top = orig.y;
  let right = orig.x + orig.w;
  let bottom = orig.y + orig.h;
  if (corner === 'nw' || corner === 'sw') left = p[0];
  if (corner === 'ne' || corner === 'se') right = p[0];
  if (corner === 'nw' || corner === 'ne') top = p[1];
  if (corner === 'sw' || corner === 'se') bottom = p[1];
  const min = el.type === 'image' ? 20 : 8;
  if (right - left < min) {
    if (corner === 'nw' || corner === 'sw') left = right - min;
    else right = left + min;
  }
  if (bottom - top < min) {
    if (corner === 'nw' || corner === 'ne') top = bottom - min;
    else bottom = top + min;
  }
  let w = right - left;
  let h = bottom - top;
  if (el.type === 'image') {
    const scale = Math.max(w / Math.max(orig.w, 0.001), h / Math.max(orig.h, 0.001));
    w = orig.w * scale;
    h = orig.h * scale;
    if (corner === 'nw' || corner === 'sw') left = right - w;
    if (corner === 'nw' || corner === 'ne') top = bottom - h;
  }
  if (Math.abs(el.x - left) < 0.5 && Math.abs(el.y - top) < 0.5 && Math.abs(el.w - w) < 0.5 && Math.abs(el.h - h) < 0.5) {
    return false;
  }
  el.x = left;
  el.y = top;
  el.w = w;
  el.h = h;
  return true;
}

function eraseAt(p: Pt): void {
  const hit = hitTest(state.doc.elements, p, 8 / view.zoom);
  if (!hit || hit.type !== 'ink') return;
  if (drag.kind === 'erase') {
    if (!drag.before) drag.before = beginMutation();
    drag.deleted = true;
  }
  removeElement(hit.id);
  renderAll();
}

function deleteSelected(): void {
  if (!state.selectedIds.length) return;
  const before = beginMutation();
  for (const id of [...state.selectedIds]) removeElement(id);
  commitMutation(before, true);
  renderAll();
  refreshPalette();
}

function duplicateSelected(): void {
  commitEdit();
  const sources = selectedElements();
  if (!sources.length) return;
  const before = beginMutation();
  const clones = sources.map((el) => {
    const clone = structuredClone(el);
    clone.id = uid();
    moveEl(clone, 16, 16);
    return clone;
  });
  state.doc.elements.push(...clones);
  setSelection(clones.map((clone) => clone.id));
  commitMutation(before, true);
  renderAll();
  setStatus(`已复制 ${clones.length} 项`);
}

function nudgeSelected(dx: number, dy: number): void {
  if (!state.selectedIds.length) return;
  commitEdit();
  const before = beginMutation();
  for (const el of selectedElements()) {
    moveEl(el, dx, dy);
    updateElNode(el);
  }
  commitMutation(before, true);
  updateSelectionBox();
}

function reorderSelection(toFront: boolean): void {
  commitEdit();
  if (!state.selectedIds.length) return;
  const pickedIds = new Set(state.selectedIds);
  const picked = state.doc.elements.filter((el) => pickedIds.has(el.id));
  const rest = state.doc.elements.filter((el) => !pickedIds.has(el.id));
  const next = toFront ? rest.concat(picked) : picked.concat(rest);
  if (next.every((el, index) => el.id === state.doc.elements[index].id)) return;
  const before = beginMutation();
  state.doc.elements = next;
  commitMutation(before, true);
  renderAll();
  setStatus(toFront ? '已置顶' : '已置底');
}

function buildElementClipboard(): string {
  return JSON.stringify({ app: 'whiteboard-canvas-elements', version: 1, clipId: uid(), elements: selectedElements() });
}

function copySelected(cut: boolean): void {
  commitEdit();
  const sources = selectedElements();
  if (!sources.length) return;
  window.api.writeClipboardText(buildElementClipboard());
  if (cut) {
    const before = beginMutation();
    for (const el of sources) removeElement(el.id);
    commitMutation(before, true);
    renderAll();
    refreshPalette();
  }
  setStatus((cut ? '已剪切 ' : '已复制 ') + sources.length + ' 项');
}

function undoAction(): void {
  commitEdit();
  if (!undoHistory()) return;
  pruneSelection();
  syncPaletteFromSelection();
  refreshPalette();
  renderAll();
  setStatus('');
}

function redoAction(): void {
  commitEdit();
  if (!redoHistory()) return;
  pruneSelection();
  syncPaletteFromSelection();
  refreshPalette();
  renderAll();
  setStatus('');
}

function zoomAroundViewport(factor: number): void {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  updateSelectionBox();
}

function applyCursor(): void {
  const tool = state.tool;
  viewport.style.cursor = state.spaceDown
    ? 'grab'
    : tool === 'pen' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow'
      ? 'crosshair'
      : tool === 'text'
        ? 'text'
        : tool === 'eraser'
          ? 'cell'
          : '';
}

function setTool(tool: Tool): void {
  if (state.tool !== tool) commitEdit();
  state.tool = tool;
  for (const btn of Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]'))) {
    const active = btn.dataset.tool === tool;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (tool !== 'eraser') eraserRing.hidden = true;
  applyCursor();
  refreshPalette();
}

function refreshPalette(): void {
  const tool = state.tool;
  const types = selectedElements().map((el) => el.type);
  const styleable = types.some((t) => t === 'text' || t === 'ink' || t === 'rect' || t === 'ellipse' || t === 'arrow');
  const isShapeTool = tool === 'pen' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow';
  const showColors = isShapeTool || tool === 'text' || (tool === 'select' && styleable);
  const showWidths = isShapeTool || (tool === 'select' && types.some((t) => t === 'ink' || t === 'rect' || t === 'ellipse' || t === 'arrow'));
  const showSizes = tool === 'text' || (tool === 'select' && types.includes('text'));
  palette.hidden = !showColors;
  colorRow.hidden = !showColors;
  widthRow.hidden = !showWidths;
  sizeRow.hidden = !showSizes;
  for (const btn of Array.from(palette.querySelectorAll<HTMLButtonElement>('button[data-value]'))) {
    const row = btn.parentElement ? btn.parentElement.dataset.row : '';
    const value = btn.dataset.value || '';
    const active =
      (row === 'color' && value === state.color) ||
      (row === 'width' && Number(value) === state.width) ||
      (row === 'size' && Number(value) === state.fontSize);
    btn.classList.toggle('active', active);
  }
}

function applyColor(color: string): void {
  state.color = color;
  const targets = selectedElements();
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.type === 'text' || el.type === 'ink') {
      if (el.color !== color) {
        el.color = color;
        changed = true;
      }
    } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'arrow') {
      if (el.stroke !== color) {
        el.stroke = color;
        changed = true;
      }
    }
  }
  if (changed) {
    commitMutation(before, true);
    const editingEl = editingTextEl();
    if (editingEl && editingEl.color === color) {
      editor.style.color = color;
      if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = structuredClone(state.doc);
    }
    renderAll();
  }
  refreshPalette();
}

function applyWidth(width: number): void {
  state.width = width;
  const targets = selectedElements();
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.type === 'ink') {
      if (el.width !== width) {
        el.width = width;
        changed = true;
      }
    } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'arrow') {
      if (el.strokeWidth !== width) {
        el.strokeWidth = width;
        changed = true;
      }
    }
  }
  if (changed) {
    commitMutation(before, true);
    renderAll();
  }
  refreshPalette();
}

function applyFontSize(size: number): void {
  state.fontSize = size;
  const targets = selectedElements().filter((el): el is TextEl => el.type === 'text');
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.fontSize !== size) {
      el.fontSize = size;
      changed = true;
    }
  }
  if (changed) {
    commitMutation(before, true);
    const editingEl = editingTextEl();
    if (editingEl && editingEl.fontSize === size) {
      editor.style.fontSize = size + 'px';
      editor.style.height = 'auto';
      editor.style.height = Math.max(size * 1.4, editor.scrollHeight) + 'px';
      if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = structuredClone(state.doc);
    }
    renderAll();
  }
  refreshPalette();
}

function buildPalette(): void {
  colorRow = palette.querySelector('[data-row="color"]') as HTMLDivElement;
  widthRow = palette.querySelector('[data-row="width"]') as HTMLDivElement;
  sizeRow = palette.querySelector('[data-row="size"]') as HTMLDivElement;
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.dataset.value = color;
    btn.title = color;
    btn.style.background = color;
    btn.addEventListener('click', () => applyColor(color));
    colorRow.appendChild(btn);
  }
  for (const width of WIDTHS) {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.dataset.value = String(width);
    btn.textContent = String(width);
    btn.addEventListener('click', () => applyWidth(width));
    widthRow.appendChild(btn);
  }
  for (const size of SIZES) {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.dataset.value = String(size);
    btn.textContent = String(size);
    btn.addEventListener('click', () => applyFontSize(size));
    sizeRow.appendChild(btn);
  }
}

function updateEraserRing(clientX: number, clientY: number, visible: boolean): void {
  if (!visible) {
    eraserRing.hidden = true;
    return;
  }
  const r = viewport.getBoundingClientRect();
  eraserRing.hidden = false;
  eraserRing.style.left = clientX - r.left + 'px';
  eraserRing.style.top = clientY - r.top + 'px';
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
  const target = e.target as HTMLElement;
  if (e.button === 0 && target.classList.contains('handle')) return;
  commitEdit();
  const p = screenToWorld(e.clientX, e.clientY);

  if (e.button === 1 || e.button === 2 || state.spaceDown) {
    eraserRing.hidden = true;
    drag = { kind: 'pan', startClient: [e.clientX, e.clientY], startPan: { x: view.pan.x, y: view.pan.y } };
    viewport.style.cursor = 'grabbing';
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有活动指针 */
    }
    e.preventDefault();
    return;
  }

  if (state.tool === 'select') {
    const hit = hitTest(state.doc.elements, p, 6 / view.zoom);
    if (hit && e.shiftKey) {
      const next = state.selectedIds.includes(hit.id)
        ? state.selectedIds.filter((id) => id !== hit.id)
        : state.selectedIds.concat(hit.id);
      setSelection(next);
      drag = { kind: 'none' };
    } else if (hit) {
      if (!state.selectedIds.includes(hit.id)) setSelection([hit.id]);
      drag = { kind: 'move', ids: [...state.selectedIds], start: p, before: beginMutation(), dx: 0, dy: 0 };
    } else {
      const beforeSelection = e.shiftKey ? [...state.selectedIds] : [];
      if (!e.shiftKey) setSelection([]);
      const preview = document.createElement('div');
      preview.className = 'marquee';
      viewport.appendChild(preview);
      drag = { kind: 'marquee', start: p, beforeSelection, preview };
    }
    updateSelectionBox();
  } else if (state.tool === 'pen') {
    drag = startPen(p);
  } else if (state.tool === 'eraser') {
    drag = { kind: 'erase', before: null, deleted: false };
    eraseAt(p);
  } else if (state.tool === 'text') {
    drag = { kind: 'none' };
    createTextAt(p);
    return;
  } else if (state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'arrow') {
    drag = startShape(state.tool, p);
  }
  try {
    viewport.setPointerCapture(e.pointerId);
  } catch {
    /* 合成事件没有活动指针 */
  }
}

function onPointerMove(e: PointerEvent): void {
  updateEraserRing(e.clientX, e.clientY, state.tool === 'eraser' && drag.kind !== 'pan');
  const d = drag;
  const p = screenToWorld(e.clientX, e.clientY);
  if (d.kind === 'pan') {
    view.pan.x = d.startPan.x + (e.clientX - d.startClient[0]);
    view.pan.y = d.startPan.y + (e.clientY - d.startClient[1]);
    applyTransform();
    updateSelectionBox();
    return;
  }
  if (d.kind === 'move') {
    const dx = p[0] - d.start[0];
    const dy = p[1] - d.start[1];
    const stepX = dx - d.dx;
    const stepY = dy - d.dy;
    if (stepX === 0 && stepY === 0) return;
    const ids = new Set(d.ids);
    for (const el of state.doc.elements) {
      if (!ids.has(el.id)) continue;
      moveEl(el, stepX, stepY);
      updateElNode(el);
    }
    d.dx = dx;
    d.dy = dy;
    updateSelectionBox();
    return;
  }
  if (d.kind === 'resize') {
    const el = state.doc.elements.find((item) => item.id === d.id);
    if (!el) return;
    if (resizeElement(el, d.corner, d.orig, p)) {
      d.changed = true;
      updateElNode(el);
      updateSelectionBox();
    }
    return;
  }
  if (d.kind === 'pen') {
    const last = d.points[d.points.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5 / view.zoom) {
      d.points.push(p);
      d.preview.setAttribute('d', smoothPathD(d.points));
    }
    return;
  }
  if (d.kind === 'shape') {
    updateShapePreview(d, p);
    return;
  }
  if (d.kind === 'marquee') {
    const x = Math.min(d.start[0], p[0]);
    const y = Math.min(d.start[1], p[1]);
    d.preview.style.left = view.pan.x + x * view.zoom + 'px';
    d.preview.style.top = view.pan.y + y * view.zoom + 'px';
    d.preview.style.width = Math.abs(p[0] - d.start[0]) * view.zoom + 'px';
    d.preview.style.height = Math.abs(p[1] - d.start[1]) * view.zoom + 'px';
    return;
  }
  if (d.kind === 'erase') {
    eraseAt(p);
  }
}

function finishDrag(e: PointerEvent): void {
  const d = drag;
  drag = { kind: 'none' };
  if (d.kind === 'pan') {
    applyTransform();
  } else if (d.kind === 'move') {
    if (d.dx !== 0 || d.dy !== 0) commitMutation(d.before, true);
  } else if (d.kind === 'resize') {
    const el = state.doc.elements.find((item) => item.id === d.id);
    if (el) updateElNode(el);
    if (d.changed) commitMutation(d.before, true);
  } else if (d.kind === 'pen') {
    commitPen(d);
  } else if (d.kind === 'shape') {
    commitShape(d, screenToWorld(e.clientX, e.clientY));
  } else if (d.kind === 'marquee') {
    d.preview.remove();
    const end = screenToWorld(e.clientX, e.clientY);
    const r: Rect = {
      x: Math.min(d.start[0], end[0]),
      y: Math.min(d.start[1], end[1]),
      w: Math.abs(end[0] - d.start[0]),
      h: Math.abs(end[1] - d.start[1])
    };
    if (Math.max(r.w, r.h) * view.zoom < 4) {
      setSelection(d.beforeSelection);
    } else {
      const hits = state.doc.elements.filter((el) => rectsIntersect(bounds(el), r)).map((el) => el.id);
      setSelection(d.beforeSelection.concat(hits));
    }
  } else if (d.kind === 'erase') {
    if (d.deleted && d.before) commitMutation(d.before, true);
  }
  applyCursor();
  updateSelectionBox();
  try {
    viewport.releasePointerCapture(e.pointerId);
  } catch {
    /* 捕获可能已释放 */
  }
}

function onDoubleClick(e: MouseEvent): void {
  if (state.tool !== 'select') return;
  const p = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(state.doc.elements, p, 6 / view.zoom);
  if (hit && hit.type === 'text') {
    setSelection([hit.id]);
    beginEdit(hit.id, null);
    return;
  }
  if (!hit) createTextAt(p);
}

function installPointerEvents(): void {
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', finishDrag);
  viewport.addEventListener('pointercancel', finishDrag);
  viewport.addEventListener('pointerleave', () => {
    eraserRing.hidden = true;
  });
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
      } else {
        view.pan.x -= e.deltaX;
        view.pan.y -= e.deltaY;
        applyTransform();
      }
      updateSelectionBox();
    },
    { passive: false }
  );
  selectionBox.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('handle')) return;
    if (state.selectedIds.length !== 1) return;
    const el = state.doc.elements.find((item) => item.id === state.selectedIds[0]);
    if (!el || el.type === 'ink' || el.type === 'arrow') return;
    commitEdit();
    drag = {
      kind: 'resize',
      id: el.id,
      corner: target.classList[1] || 'se',
      before: beginMutation(),
      orig: bounds(el),
      changed: false
    };
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有活动指针 */
    }
    e.preventDefault();
  });
}

function installEditor(): void {
  editor.addEventListener('input', () => {
    const el = editingTextEl();
    const fontSize = el ? el.fontSize : state.fontSize;
    editor.style.height = 'auto';
    editor.style.height = Math.max(fontSize * 1.4, editor.scrollHeight) + 'px';
    markDirty({ autosave: false });
  });
  editor.addEventListener('blur', () => commitEdit());
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commitEdit();
    }
  });
}

function toggleHelp(show: boolean): void {
  helpOverlay.hidden = !show;
  if (show) helpClose.focus();
  else helpBtn.focus();
}

function installHelp(): void {
  helpBtn.addEventListener('click', () => toggleHelp(helpOverlay.hidden));
  helpClose.addEventListener('click', () => toggleHelp(false));
  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) toggleHelp(false);
  });
}

function installKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      toggleHelp(helpOverlay.hidden);
      return;
    }
    if (!helpOverlay.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleHelp(false);
      }
      return;
    }
    if (document.activeElement === editor) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoAction();
        else undoAction();
        return;
      }
      if (key === 'y') {
        e.preventDefault();
        redoAction();
        return;
      }
      if (key === 'a') {
        e.preventDefault();
        setSelection(state.doc.elements.map((el) => el.id));
        return;
      }
      if (key === 'd') {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (key === 'c') {
        if (state.selectedIds.length) {
          e.preventDefault();
          copySelected(false);
        }
        return;
      }
      if (key === 'x') {
        if (state.selectedIds.length) {
          e.preventDefault();
          copySelected(true);
        }
        return;
      }
      if (e.code === 'BracketRight') {
        e.preventDefault();
        reorderSelection(true);
        return;
      }
      if (e.code === 'BracketLeft') {
        e.preventDefault();
        reorderSelection(false);
        return;
      }
      if (key === '0') {
        e.preventDefault();
        zoomAroundViewport(1 / view.zoom);
        return;
      }
      if (key === '=' || key === '+') {
        e.preventDefault();
        zoomAroundViewport(1.2);
        return;
      }
      if (key === '-') {
        e.preventDefault();
        zoomAroundViewport(1 / 1.2);
        return;
      }
      return;
    }
    if (e.key.startsWith('Arrow')) {
      if (!state.selectedIds.length) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudgeSelected(-step, 0);
      else if (e.key === 'ArrowRight') nudgeSelected(step, 0);
      else if (e.key === 'ArrowUp') nudgeSelected(0, -step);
      else nudgeSelected(0, step);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (e.key === 'Escape') {
      setSelection([]);
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      if (state.selectedIds.length === 1) {
        const el = state.doc.elements.find((item) => item.id === state.selectedIds[0]);
        if (el && el.type === 'text') {
          e.preventDefault();
          beginEdit(el.id, null);
        }
      }
      return;
    }
    if (e.key === ' ') {
      state.spaceDown = true;
      applyCursor();
      e.preventDefault();
      return;
    }
    const tool = TOOL_KEYS[key];
    if (tool) {
      setTool(tool);
      return;
    }
    if (key === 'i') fileInput.click();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      state.spaceDown = false;
      applyCursor();
    }
  });
}

function installMenu(): void {
  window.api.onMenu((action) => {
    if (action === 'new') void newDocument();
    else if (action === 'open') void openDocument();
    else if (action === 'save') void saveDocument(false);
    else if (action === 'save-as') void saveDocument(true);
    else if (action === 'export-png') void exportPng();
  });
  window.api.onRequestSave(async () => {
    window.api.saveResult(await saveDocument(false));
  });
}

function installToolbar(): void {
  for (const btn of Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]'))) {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool as Tool | undefined;
      if (tool) setTool(tool);
    });
  }
  pickImageBtn.addEventListener('click', () => fileInput.click());
  zoomInBtn.addEventListener('click', () => zoomAroundViewport(1.2));
  zoomOutBtn.addEventListener('click', () => zoomAroundViewport(1 / 1.2));
  zoomFitBtn.addEventListener('click', () => {
    fitToContent();
    updateSelectionBox();
  });
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files ?? []);
    const at = viewportCenter();
    for (const file of files) await insertImage(file, at);
    fileInput.value = '';
  });
}

function installTestHooks(): void {
  const testApi: TestApi = {
    count: () => state.doc.elements.length,
    elements: () =>
      state.doc.elements.map((el) => {
        const b = bounds(el);
        const base = { id: el.id, type: el.type, x: b.x, y: b.y, w: b.w, h: b.h };
        if (el.type === 'text') return { ...base, color: el.color, fontSize: el.fontSize };
        if (el.type === 'ink') return { ...base, color: el.color, width: el.width };
        if (el.type === 'image') return base;
        return { ...base, stroke: el.stroke, strokeWidth: el.strokeWidth };
      }),
    selectedIds: () => [...state.selectedIds],
    order: () => state.doc.elements.map((el) => el.id),
    select: (ids) => setSelection(ids),
    duplicate: () => {
      duplicateSelected();
      return state.doc.elements.length;
    },
    nudge: (dx, dy) => nudgeSelected(dx, dy),
    bringToFront: () => reorderSelection(true),
    sendToBack: () => reorderSelection(false),
    clipboardJson: () => buildElementClipboard(),
    addText: (text, x, y) => {
      commitEdit();
      const before = beginMutation();
      const el: TextEl = {
        id: uid(),
        type: 'text',
        x,
        y,
        w: 320,
        h: state.fontSize * 1.4,
        text,
        fontSize: state.fontSize,
        color: state.color
      };
      state.doc.elements.push(el);
      commitMutation(before, true);
      renderAll();
      return el.id;
    },
    addInk: (points, color, width) => {
      const norm = normalizeInk(points);
      const before = beginMutation();
      const el: InkEl = {
        id: uid(),
        type: 'ink',
        x: norm.x,
        y: norm.y,
        w: norm.w,
        h: norm.h,
        points: norm.points,
        color,
        width
      };
      state.doc.elements.push(el);
      commitMutation(before, true);
      renderAll();
      return el.id;
    },
    addShape: (type, x, y, w, h) => {
      const before = beginMutation();
      if (type === 'arrow') {
        const el: ArrowEl = {
          id: uid(),
          type: 'arrow',
          x1: x,
          y1: y,
          x2: x + w,
          y2: y + h,
          stroke: state.color,
          strokeWidth: state.width
        };
        state.doc.elements.push(el);
        commitMutation(before, true);
        renderAll();
        return el.id;
      }
      const el: RectEl | EllipseEl =
        type === 'rect'
          ? { id: uid(), type: 'rect', x, y, w, h, stroke: state.color, strokeWidth: state.width }
          : { id: uid(), type: 'ellipse', x, y, w, h, stroke: state.color, strokeWidth: state.width };
      state.doc.elements.push(el);
      commitMutation(before, true);
      renderAll();
      return el.id;
    },
    addImage: async (dataUrl, x, y) => {
      const size = await imageSize(dataUrl);
      if (!size) return null;
      const scale = Math.min(1, 480 / Math.max(size.w, size.h));
      const before = beginMutation();
      const el: ImageEl = { id: uid(), type: 'image', x, y, w: size.w * scale, h: size.h * scale, src: dataUrl };
      state.doc.elements.push(el);
      commitMutation(before, true);
      renderAll();
      return el.id;
    },
    hitTest: (x, y) => {
      const hit = hitTest(state.doc.elements, [x, y], 6);
      return hit ? hit.type : null;
    },
    move: (id, dx, dy) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) return;
      const before = beginMutation();
      moveEl(el, dx, dy);
      commitMutation(before, true);
      updateElNode(el);
      updateSelectionBox();
    },
    undo: () => {
      const ok = undoHistory();
      if (ok) renderAll();
      return ok;
    },
    redo: () => {
      const ok = redoHistory();
      if (ok) renderAll();
      return ok;
    },
    reset: () => {
      cancelEdit();
      resetDoc();
      view.zoom = 1;
      view.pan.x = 0;
      view.pan.y = 0;
      applyTransform();
      renderAll();
      markSaved();
      setStatus('');
      refreshPalette();
    },
    saveTo: async (path) => {
      const result = await window.api.saveDoc(path, serialize(), false);
      return !!result.path;
    },
    openFrom: async (path) => {
      const result = await window.api.openDoc(path);
      if (!result.text) return false;
      try {
        loadFromText(result.text);
      } catch {
        return false;
      }
      state.filePath = result.path ?? null;
      state.selectedIds = [];
      state.revision = 0;
      clearHistory();
      renderAll();
      refreshPalette();
      return true;
    },
    exportPngTo: async (path) => {
      const dataUrl = await renderPng();
      if (!dataUrl) return false;
      const result = await window.api.savePng(dataUrl, path);
      return !!result.path;
    },
    pngData: () => renderPng()
  };
  window.__test = testApi;
}

function init(): void {
  buildPalette();
  setEditHooks(commitEdit, cancelEdit, refreshPalette);
  setTool('select');
  installPointerEvents();
  installPasteAndDrop();
  installEditor();
  installKeyboard();
  installHelp();
  installMenu();
  installToolbar();
  applyTransform();
  renderAll();
  setStatus('');
  if (new URLSearchParams(location.search).has('smoke')) installTestHooks();
}

init();
