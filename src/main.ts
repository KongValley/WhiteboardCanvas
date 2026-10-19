// SPDX-License-Identifier: GPL-3.0-or-later
import './style.css';
import {
  ArrowEl,
  El,
  EllipseEl,
  ImageEl,
  InkEl,
  PolyEl,
  PolyKind,
  Pt,
  Rect,
  RectEl,
  TextEl,
  Tool,
  arrowPathD,
  bounds,
  boundsUnion,
  centerOf,
  distToSegment,
  hitTest,
  inkAbsolutePoints,
  moveEl,
  nearestPointOnRect,
  normalizeInk,
  polyPathD,
  rectsIntersect,
  rotatePoint,
  smoothPathD,
  uid,
  visualBounds
} from './model';
import {
  Doc,
  DEFAULT_SETTINGS,
  addPage,
  beginMutation,
  clearHistory,
  commitMutation,
  historyEntries,
  jumpToHistory,
  loadFromText,
  markDirty,
  markSaved,
  movePage,
  pruneSelection,
  removeElement,
  removePage,
  renamePage,
  resetDoc,
  redo as redoHistory,
  serialize,
  setRecoverySnapshotProvider,
  setStatus,
  setStatusHook,
  state,
  updateTitle,
  switchPage,
  undo as undoHistory
} from './state';
import { FONT, describeEl, refreshConnectors, renderAll, setEditing, setRenderHook, syncNodes, updateElNode, updateSelectionBox } from './render';
import {
  applyTransform,
  ensureVisible,
  fitSelection,
  fitToContent,
  screenToWorld,
  setTransformHook,
  setZoomAtWorld,
  view,
  viewport,
  viewportCenter,
  world,
  zoomAt,
  zoomToPercent
} from './view';
import {
  applyRecoveredDocument,
  backupNow,
  compressImage,
  cloneWithFreshIds,
  copySelectionPng,
  cropImage,
  exportAllPagesPdf,
  buildSvg,
  exportPng,
  exportSvg,
  renderElementsPng,
  imageSize,
  insertImage,
  installPasteAndDrop,
  openDocument,
  pasteFromClipboard,
  prepareImageFile,
  printCanvas,
  renderPng,
  replaceImageSource,
  restoreBackup,
  saveDocument,
  setEditHooks
} from './io';
import { installContextMenu, showContextMenu } from './contextmenu';
import { openForm, openPrompt } from './dialogs';
import type { MenuItem } from './contextmenu';
import { installMinimap, requestMinimap } from './minimap';
import { applyTheme, currentShortcuts, installSettings, openSettings } from './settings';
import { installPanels, refreshPanels, togglePanels } from './panels';
import { toolIcon } from './icons';
import { applyI18n, t } from './i18n';
import { setPointerWorld, updateStatusInfo } from './status';
import type { StartupResult, TestApi } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRID = 24;
const SNAP_PX = 6;
const COLORS = ['#1f2937', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];
const FILLS = ['', 'rgba(220,38,38,0.18)', 'rgba(37,99,235,0.18)', 'rgba(22,163,74,0.18)', 'rgba(217,119,6,0.18)', 'rgba(124,58,237,0.18)', 'rgba(107,114,128,0.18)'];
const WIDTHS = [2, 4, 8];
const SIZES = [16, 24, 32, 48];
const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  q: 'lasso',
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  t: 'text',
  s: 'sticky',
  r: 'rect',
  o: 'ellipse',
  a: 'arrow',
  l: 'line'
};
const POLY_KEYS: Record<string, PolyKind> = { '1': 'triangle', '2': 'diamond', '3': 'star', '4': 'roundrect' };

const editor = document.getElementById('editor') as HTMLTextAreaElement;
const toolbar = document.getElementById('toolbar') as HTMLDivElement;
const palette = document.getElementById('palette') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const imageReplaceInput = document.getElementById('image-replace-input') as HTMLInputElement;
const selectionBox = document.getElementById('selection') as HTMLDivElement;
const pickImageBtn = document.getElementById('pick-image') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
const zoomFitBtn = document.getElementById('zoom-fit') as HTMLButtonElement;
const zoomInput = document.getElementById('zoom-input') as HTMLInputElement;
const eraserRing = document.getElementById('eraser-ring') as HTMLDivElement;
const guidesEl = document.getElementById('guides') as HTMLDivElement;
const helpOverlay = document.getElementById('help') as HTMLDivElement;
const helpBtn = document.getElementById('help-btn') as HTMLButtonElement;
const helpClose = document.getElementById('help-close') as HTMLButtonElement;
const settingsOverlay = document.getElementById('settings') as HTMLDivElement;
const pageSelect = document.getElementById('page-select') as HTMLSelectElement;
const pageAdd = document.getElementById('page-add') as HTMLButtonElement;
const pageMore = document.getElementById('page-more') as HTMLButtonElement;
const panelBtn = document.getElementById('panel-btn') as HTMLButtonElement;
const searchbar = document.getElementById('searchbar') as HTMLDivElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchCount = document.getElementById('search-count') as HTMLSpanElement;
const searchClose = document.getElementById('search-close') as HTMLButtonElement;

let colorRow: HTMLDivElement;
let widthRow: HTMLDivElement;
let sizeRow: HTMLDivElement;
let fillRow: HTMLDivElement;
let styleRow: HTMLDivElement;
let fontRow: HTMLDivElement;

let polyKind: PolyKind = 'triangle';
let formatBrush: StyleSnapshot | null = null;

interface StyleSnapshot {
  color: string;
  stroke: string;
  fill: string;
  width: number;
  fontSize: number;
  fontFamily?: string;
  lineHeight?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  bullets?: boolean;
  align?: TextEl['align'];
  stickyColor?: string;
}

let editingId: string | null = null;
let editBefore: Doc | null = null;
let editTextSnapshot = '';
let imageReplaceId: string | null = null;
let panMoved = false;
let lastBackupRevision = -1;
let searchMatches: string[] = [];
let searchIndex = 0;
let lastPenAt = 0;
let inertiaFrame = 0;
let panSample = { x: 0, y: 0, t: 0, vx: 0, vy: 0 };

type ElNode = HTMLElement | SVGSVGElement;

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; startClient: Pt; startPan: { x: number; y: number } }
  | { kind: 'move'; ids: string[]; start: Pt; before: Doc; dx: number; dy: number; orig: Rect }
  | { kind: 'resize'; ids: string[]; corner: string; before: Doc; orig: Rect; origins: Map<string, El>; changed: boolean }
  | { kind: 'rotate'; ids: string[]; center: Pt; startAngle: number; before: Doc; origins: Map<string, { center: Pt; rotation: number }>; changed: boolean }
  | { kind: 'endpoint'; id: string; which: 'p1' | 'p2'; before: Doc; changed: boolean }
  | { kind: 'pen'; points: Pt[]; before: Doc; preview: SVGPathElement; highlight: boolean; pressures: number[] }
  | { kind: 'shape'; type: 'rect' | 'ellipse' | 'arrow' | 'line' | 'poly'; start: Pt; before: Doc; preview: ElNode }
  | { kind: 'marquee'; start: Pt; beforeSelection: string[]; preview: HTMLDivElement }
  | { kind: 'lasso'; points: Pt[]; beforeSelection: string[]; preview: SVGSVGElement }
  | { kind: 'erase'; before: Doc | null; deleted: boolean };

let drag: DragState = { kind: 'none' };

function selectedElements(): El[] {
  const ids = new Set(state.selectedIds);
  return state.doc.elements.filter((el) => ids.has(el.id));
}

/** 点击组内元素时整组选中 */
function expandGroupIds(ids: string[]): string[] {
  const wanted = new Set(ids);
  const groups = new Set<string>();
  for (const el of state.doc.elements) {
    if (wanted.has(el.id) && el.groupId) groups.add(el.groupId);
  }
  if (!groups.size) return ids;
  for (const el of state.doc.elements) {
    if (el.groupId && groups.has(el.groupId)) wanted.add(el.id);
  }
  return Array.from(wanted);
}

function canvasHit(p: Pt): El | null {
  return hitTest(state.doc.elements, p, 6 / view.zoom, { ignoreLocked: true, ignoreHidden: true });
}

function editableSelection(): El[] {
  return selectedElements().filter((el) => !el.locked);
}

function setSelection(ids: string[]): void {
  const alive = new Set(state.doc.elements.map((el) => el.id));
  state.selectedIds = expandGroupIds(Array.from(new Set(ids)).filter((id) => alive.has(id)));
  syncPaletteFromSelection();
  refreshPalette();
  updateSelectionBox();
  updateStatusInfo();
  requestMinimap();
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
    if (!el.highlight) state.width = el.width;
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') {
    state.color = el.stroke;
    state.width = el.strokeWidth;
    state.fill = el.fill;
  } else if (el.type === 'arrow') {
    state.color = el.stroke;
    state.width = el.strokeWidth;
  }
}

function editingTextEl(): TextEl | null {
  if (!editingId) return null;
  const el = state.doc.elements.find((item) => item.id === editingId);
  return el && el.type === 'text' ? el : null;
}

/** 恢复快照合入编辑器里尚未提交的文本，异常退出不丢当前输入 */
function recoverySnapshot(): string {
  const el = editingTextEl();
  if (!el) return serialize();
  const doc = structuredClone(state.doc);
  const target = doc.elements.find((item) => item.id === el.id);
  if (target && target.type === 'text') {
    target.text = editor.value;
    const width = parseFloat(editor.style.width);
    if (Number.isFinite(width)) target.w = Math.max(60, width);
    target.h = Math.max(target.fontSize * 1.4, editor.scrollHeight);
  }
  return JSON.stringify(doc);
}

function ensureEditorVisible(): void {
  const r = viewport.getBoundingClientRect();
  const e = editor.getBoundingClientRect();
  const margin = 24;
  let dx = 0;
  let dy = 0;
  if (e.left < r.left + margin) dx = r.left + margin - e.left;
  else if (e.right > r.right - margin) dx = r.right - margin - e.right;
  if (e.top < r.top + margin) dy = r.top + margin - e.top;
  else if (e.bottom > r.bottom - margin) dy = r.bottom - margin - e.bottom;
  if (dx || dy) {
    view.pan.x += dx;
    view.pan.y += dy;
    applyTransform();
    updateSelectionBox();
  }
}

function updateEditorGeometry(el: TextEl): void {
  editor.style.left = el.x + 'px';
  editor.style.top = el.y + 'px';
  editor.style.width = el.w + 'px';
  editor.style.fontFamily = FONT;
  editor.style.fontSize = el.fontSize + 'px';
  editor.style.color = el.color;
  editor.style.height = 'auto';
  editor.style.height = Math.max(el.fontSize * 1.4, editor.scrollHeight) + 'px';
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
  updateEditorGeometry(el);
  setEditing(true);
  updateSelectionBox();
  // UI-04：低缩放下自动放大并滚动，保证编辑可见
  if (view.zoom < 0.25) setZoomAtWorld(el.x + el.w / 2, el.y + el.h / 2, 0.5);
  editor.focus();
  const pos = editor.value.length;
  editor.setSelectionRange(pos, pos);
  updateEditorGeometry(el);
  ensureEditorVisible();
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
    updateStatusInfo();
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
  updateStatusInfo();
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
  updateStatusInfo();
}

function createTextAt(at: Pt, sticky = false): void {
  commitEdit();
  const before = beginMutation();
  const el: TextEl = {
    id: uid(),
    type: 'text',
    x: at[0],
    y: at[1],
    w: sticky ? 220 : 320,
    h: state.fontSize * 1.4,
    text: '',
    fontSize: state.fontSize,
    color: state.color,
    sticky: sticky || undefined,
    stickyColor: sticky ? '#fef3c7' : undefined
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
    width: penWidth(d.highlight, d.pressures),
    highlight: d.highlight || undefined
  };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  commitMutation(d.before, true);
  renderAll();
  refreshPalette();
  updateStatusInfo();
}

function commitShape(d: Extract<DragState, { kind: 'shape' }>, end: Pt): void {
  d.preview.remove();
  if (d.type === 'poly') {
    const w = Math.abs(end[0] - d.start[0]);
    const h = Math.abs(end[1] - d.start[1]);
    if (w < 4 || h < 4) return;
    const el: PolyEl = {
      id: uid(),
      type: 'poly',
      kind: polyKind,
      x: Math.min(d.start[0], end[0]),
      y: Math.min(d.start[1], end[1]),
      w,
      h,
      stroke: state.color,
      strokeWidth: state.width,
      fill: state.fill
    };
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
    commitMutation(d.before, true, '绘制' + describePoly(polyKind));
    renderAll();
    refreshPalette();
    updateStatusInfo();
    return;
  }
  if (d.type === 'arrow' || d.type === 'line') {
    if (Math.hypot(end[0] - d.start[0], end[1] - d.start[1]) < 4) return;
    const el: ArrowEl = {
      id: uid(),
      type: 'arrow',
      x1: d.start[0],
      y1: d.start[1],
      x2: end[0],
      y2: end[1],
      stroke: state.color,
      strokeWidth: state.width,
      head: d.type === 'arrow'
    };
    const startTarget = connectTarget(d.start);
    const endTarget = connectTarget(end);
    if (startTarget) {
      el.fromId = startTarget.id;
      el.x1 = startTarget.point[0];
      el.y1 = startTarget.point[1];
    }
    if (endTarget && (!startTarget || endTarget.id !== startTarget.id)) {
      el.toId = endTarget.id;
      el.x2 = endTarget.point[0];
      el.y2 = endTarget.point[1];
    }
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
  } else {
    const w = Math.abs(end[0] - d.start[0]);
    const h = Math.abs(end[1] - d.start[1]);
    if (w < 4 || h < 4) return;
    const x = Math.min(d.start[0], end[0]);
    const y = Math.min(d.start[1], end[1]);
    const el: RectEl | EllipseEl =
      d.type === 'rect'
        ? { id: uid(), type: 'rect', x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill }
        : { id: uid(), type: 'ellipse', x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill };
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
  }
  commitMutation(d.before, true);
  renderAll();
  refreshPalette();
  updateStatusInfo();
}

function describePoly(kind: PolyKind): string {
  return { triangle: '三角形', diamond: '菱形', star: '五角星', roundrect: '圆角矩形' }[kind];
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

function stopInertia(): void {
  if (inertiaFrame) {
    cancelAnimationFrame(inertiaFrame);
    inertiaFrame = 0;
  }
}

function startInertia(vx: number, vy: number): void {
  stopInertia();
  let speedX = vx;
  let speedY = vy;
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(50, now - last);
    last = now;
    view.pan.x += speedX * dt;
    view.pan.y += speedY * dt;
    applyTransform();
    const decay = Math.pow(0.9, dt / 16);
    speedX *= decay;
    speedY *= decay;
    if (Math.hypot(speedX, speedY) > 0.02) inertiaFrame = requestAnimationFrame(step);
    else inertiaFrame = 0;
  };
  inertiaFrame = requestAnimationFrame(step);
}

function penWidth(highlight: boolean, pressures: number[]): number {
  if (highlight) return 16;
  if (!pressures.length) return state.width;
  const avg = pressures.reduce((sum, value) => sum + value, 0) / pressures.length;
  return Math.max(1, Math.min(60, state.width * (0.6 + avg * 0.9)));
}

function startPen(at: Pt, highlight: boolean): DragState {
  const svg = createPreviewSvg(state.color, highlight ? 16 : state.width);
  if (highlight) {
    svg.style.opacity = '0.35';
    svg.style.mixBlendMode = 'multiply';
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('d', smoothPathD([at]));
  svg.appendChild(path);
  world.appendChild(svg);
  return { kind: 'pen', points: [at], before: beginMutation(), preview: path, highlight, pressures: [] };
}

function startShape(type: 'rect' | 'ellipse' | 'arrow' | 'line' | 'poly', at: Pt): DragState {
  let preview: ElNode;
  if (type === 'poly') {
    const svg = createPreviewSvg(state.color, state.width);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', state.fill || 'none');
    svg.appendChild(path);
    preview = svg;
  } else if (type === 'arrow' || type === 'line') {
    const svg = createPreviewSvg(state.color, state.width);
    svg.appendChild(document.createElementNS(SVG_NS, 'path'));
    preview = svg;
  } else {
    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.boxSizing = 'border-box';
    div.style.border = state.width + 'px solid ' + state.color;
    div.style.background = state.fill || 'transparent';
    div.style.pointerEvents = 'none';
    if (type === 'ellipse') div.style.borderRadius = '50%';
    preview = div;
  }
  world.appendChild(preview);
  return { kind: 'shape', type, start: at, before: beginMutation(), preview };
}

function updateShapePreview(d: Extract<DragState, { kind: 'shape' }>, end: Pt): void {
  if (d.type === 'poly') {
    const path = (d.preview as SVGSVGElement).firstElementChild as SVGPathElement | null;
    if (!path) return;
    const temp: PolyEl = {
      id: 'preview',
      type: 'poly',
      kind: polyKind,
      x: Math.min(d.start[0], end[0]),
      y: Math.min(d.start[1], end[1]),
      w: Math.abs(end[0] - d.start[0]),
      h: Math.abs(end[1] - d.start[1]),
      stroke: state.color,
      strokeWidth: state.width,
      fill: state.fill
    };
    path.setAttribute('d', polyPathD(temp));
    return;
  }
  if (d.type === 'arrow' || d.type === 'line') {
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
      strokeWidth: state.width,
      head: d.type === 'arrow'
    };
    path.setAttribute('d', arrowPathD(temp));
    return;
  }
  const div = d.preview as HTMLDivElement;
  div.style.left = Math.min(d.start[0], end[0]) + 'px';
  div.style.top = Math.min(d.start[1], end[1]) + 'px';
  div.style.width = Math.abs(end[0] - d.start[0]) + 'px';
  div.style.height = Math.abs(end[1] - d.start[1]) + 'px';
}

function snapPoint(p: Pt, alt: boolean): Pt {
  if (alt) return p;
  return [Math.round(p[0] / GRID) * GRID, Math.round(p[1] / GRID) * GRID];
}

function clearGuides(): void {
  guidesEl.replaceChildren();
}

function renderGuides(xs: number[], ys: number[]): void {
  clearGuides();
  for (const x of xs) {
    const line = document.createElement('div');
    line.className = 'guide-v';
    line.style.left = view.pan.x + x * view.zoom + 'px';
    guidesEl.appendChild(line);
  }
  for (const y of ys) {
    const line = document.createElement('div');
    line.className = 'guide-h';
    line.style.top = view.pan.y + y * view.zoom + 'px';
    guidesEl.appendChild(line);
  }
}

interface SnapMove {
  dx: number;
  dy: number;
  guidesX: number[];
  guidesY: number[];
}

function snapMove(orig: Rect, rawDx: number, rawDy: number, alt: boolean, ids: Set<string>): SnapMove {
  if (alt) return { dx: rawDx, dy: rawDy, guidesX: [], guidesY: [] };
  const tol = SNAP_PX / view.zoom;
  const rect = { x: orig.x + rawDx, y: orig.y + rawDy, w: orig.w, h: orig.h };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const el of state.doc.elements) {
    if (ids.has(el.id)) continue;
    const b = bounds(el);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  const edgesX = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const edgesY = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  let bestX: { delta: number; guide: number | null } | null = null;
  let bestY: { delta: number; guide: number | null } | null = null;
  for (const edge of edgesX) {
    const gridDelta = Math.round(edge / GRID) * GRID - edge;
    if (Math.abs(gridDelta) <= tol && (!bestX || Math.abs(gridDelta) < Math.abs(bestX.delta))) bestX = { delta: gridDelta, guide: null };
    for (const target of xs) {
      const delta = target - edge;
      if (Math.abs(delta) <= tol && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, guide: target };
    }
  }
  for (const edge of edgesY) {
    const gridDelta = Math.round(edge / GRID) * GRID - edge;
    if (Math.abs(gridDelta) <= tol && (!bestY || Math.abs(gridDelta) < Math.abs(bestY.delta))) bestY = { delta: gridDelta, guide: null };
    for (const target of ys) {
      const delta = target - edge;
      if (Math.abs(delta) <= tol && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, guide: target };
    }
  }
  return {
    dx: rawDx + (bestX ? bestX.delta : 0),
    dy: rawDy + (bestY ? bestY.delta : 0),
    guidesX: bestX && bestX.guide !== null ? [bestX.guide] : [],
    guidesY: bestY && bestY.guide !== null ? [bestY.guide] : []
  };
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

function resizedRect(orig: Rect, corner: string, p: Pt): Rect {
  let left = orig.x;
  let top = orig.y;
  let right = orig.x + orig.w;
  let bottom = orig.y + orig.h;
  if (corner === 'nw' || corner === 'sw') left = p[0];
  if (corner === 'ne' || corner === 'se') right = p[0];
  if (corner === 'nw' || corner === 'ne') top = p[1];
  if (corner === 'sw' || corner === 'se') bottom = p[1];
  if (right - left < 20) {
    if (corner === 'nw' || corner === 'sw') left = right - 20;
    else right = left + 20;
  }
  if (bottom - top < 20) {
    if (corner === 'nw' || corner === 'ne') top = bottom - 20;
    else bottom = top + 20;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function scaleSelection(d: Extract<DragState, { kind: 'resize' }>, p: Pt): boolean {
  const next = resizedRect(d.orig, d.corner, p);
  const sx = d.orig.w > 1 ? next.w / d.orig.w : 1;
  const sy = d.orig.h > 1 ? next.h / d.orig.h : 1;
  let changed = false;
  for (const [id, o] of d.origins) {
    const el = state.doc.elements.find((item) => item.id === id);
    if (!el || el.type !== o.type) continue;
    if (o.type === 'arrow' && el.type === 'arrow') {
      el.x1 = next.x + (o.x1 - d.orig.x) * sx;
      el.y1 = next.y + (o.y1 - d.orig.y) * sy;
      el.x2 = next.x + (o.x2 - d.orig.x) * sx;
      el.y2 = next.y + (o.y2 - d.orig.y) * sy;
    } else if (o.type === 'ink' && el.type === 'ink') {
      el.x = next.x + (o.x - d.orig.x) * sx;
      el.y = next.y + (o.y - d.orig.y) * sy;
      el.w = o.w * sx;
      el.h = o.h * sy;
      el.points = o.points.map(([px, py]) => [px * sx, py * sy] as Pt);
    } else if (o.type === 'text' && el.type === 'text') {
      el.x = next.x + (o.x - d.orig.x) * sx;
      el.y = next.y + (o.y - d.orig.y) * sy;
      el.w = Math.max(60, o.w * sx);
      el.fontSize = Math.min(512, Math.max(4, Math.round(o.fontSize * Math.min(sx, sy))));
    } else if (
      (o.type === 'image' || o.type === 'rect' || o.type === 'ellipse') &&
      (el.type === 'image' || el.type === 'rect' || el.type === 'ellipse')
    ) {
      el.x = next.x + (o.x - d.orig.x) * sx;
      el.y = next.y + (o.y - d.orig.y) * sy;
      el.w = Math.max(8, o.w * sx);
      el.h = Math.max(8, o.h * sy);
    }
    changed = true;
    updateElNode(el);
  }
  return changed;
}

function splitInk(el: InkEl, p: Pt, radius: number): Pt[][] | null {
  const pts = inkAbsolutePoints(el);
  const n = pts.length;
  if (!n) return null;
  const reach = radius + el.width / 2;
  const cut = new Array<boolean>(n).fill(false);
  if (n === 1) cut[0] = Math.hypot(pts[0][0] - p[0], pts[0][1] - p[1]) <= reach;
  for (let i = 0; i < n - 1; i++) {
    if (distToSegment(p, pts[i], pts[i + 1]) <= reach) {
      cut[i] = true;
      cut[i + 1] = true;
    }
  }
  if (!cut.some(Boolean)) return null;
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  for (let i = 0; i < n; i++) {
    if (cut[i]) {
      if (run.length >= 2) runs.push(run);
      run = [];
    } else {
      run.push(pts[i]);
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** 只删除扫过的笔迹段，剩余部分拆分为多段 */
function eraseAt(p: Pt): boolean {
  const radius = 8 / view.zoom;
  const affected: { index: number; el: InkEl; runs: Pt[][] }[] = [];
  state.doc.elements.forEach((el, index) => {
    if (el.type !== 'ink') return;
    const runs = splitInk(el, p, radius);
    if (runs) affected.push({ index, el, runs });
  });
  if (!affected.length) return false;
  let before: Doc | null = null;
  if (drag.kind === 'erase') {
    if (!drag.before) drag.before = beginMutation();
    drag.deleted = true;
  } else {
    before = beginMutation();
  }
  affected.sort((a, b) => b.index - a.index);
  for (const item of affected) {
    const pieces = item.runs.map((run) => {
      const norm = normalizeInk(run);
      const piece: InkEl = {
        id: uid(),
        type: 'ink',
        x: norm.x,
        y: norm.y,
        w: norm.w,
        h: norm.h,
        points: norm.points,
        color: item.el.color,
        width: item.el.width,
        highlight: item.el.highlight
      };
      return piece;
    });
    state.doc.elements.splice(item.index, 1, ...pieces);
    state.selectedIds = state.selectedIds.filter((id) => id !== item.el.id);
  }
  if (before) commitMutation(before, true);
  renderAll();
  refreshPalette();
  updateStatusInfo();
  return true;
}

function deleteSelected(): void {
  if (!state.selectedIds.length) return;
  const removable = selectedElements().filter((el) => !el.locked).map((el) => el.id);
  if (!removable.length) {
    setStatus('锁定元素不可删除');
    return;
  }
  const before = beginMutation();
  for (const id of removable) removeElement(id);
  commitMutation(before, true, '删除');
  renderAll();
  refreshPalette();
  updateStatusInfo();
}

function duplicateSelected(): void {
  commitEdit();
  const sources = selectedElements().filter((el) => !el.locked);
  if (!sources.length) return;
  const before = beginMutation();
  const clones = cloneWithFreshIds(sources, 16);
  state.doc.elements.push(...clones);
  setSelection(clones.map((clone) => clone.id));
  commitMutation(before, true, '再制');
  renderAll();
  setStatus(`已复制 ${clones.length} 项`);
}

function nudgeSelected(dx: number, dy: number): void {
  if (!state.selectedIds.length) return;
  commitEdit();
  const before = beginMutation();
  for (const el of editableSelection()) {
    moveEl(el, dx, dy);
    updateElNode(el);
  }
  commitMutation(before, true);
  updateSelectionBox();
  updateStatusInfo();
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
  updateStatusInfo();
  setStatus((cut ? '已剪切 ' : '已复制 ') + sources.length + ' 项');
}

function undoAction(): void {
  commitEdit();
  if (!undoHistory()) return;
  pruneSelection();
  syncPaletteFromSelection();
  refreshPalette();
  renderAll();
  updateStatusInfo();
  setStatus('');
}

function redoAction(): void {
  commitEdit();
  if (!redoHistory()) return;
  pruneSelection();
  syncPaletteFromSelection();
  refreshPalette();
  renderAll();
  updateStatusInfo();
  setStatus('');
}

function zoomAroundViewport(factor: number): void {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  updateSelectionBox();
  updateStatusInfo();
}

function applyCursor(): void {
  const tool = state.tool;
  viewport.style.cursor = state.spaceDown
    ? 'grab'
    : tool === 'pen' || tool === 'highlighter' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'line'
      ? 'crosshair'
      : tool === 'text' || tool === 'sticky'
        ? 'text'
        : tool === 'eraser'
          ? 'cell'
          : tool === 'lasso'
            ? 'crosshair'
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
  const styleable = types.some((t) => t === 'text' || t === 'ink' || t === 'rect' || t === 'ellipse' || t === 'arrow' || t === 'poly');
  const isStrokeTool =
    tool === 'pen' || tool === 'highlighter' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'line' || tool === 'poly';
  const showColors = isStrokeTool || tool === 'text' || tool === 'sticky' || (tool === 'select' && styleable);
  const showWidths =
    tool === 'pen' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'line' || tool === 'poly' ||
    (tool === 'select' && types.some((t) => t === 'ink' || t === 'rect' || t === 'ellipse' || t === 'arrow' || t === 'poly'));
  const showSizes = tool === 'text' || tool === 'sticky' || (tool === 'select' && types.includes('text'));
  const showFill =
    tool === 'rect' || tool === 'ellipse' || tool === 'poly' ||
    (tool === 'select' && types.some((t) => t === 'rect' || t === 'ellipse' || t === 'poly'));
  const showStyle = tool === 'text' || tool === 'sticky' || (tool === 'select' && types.includes('text'));
  palette.hidden = !showColors && !showFill && !showStyle;
  colorRow.hidden = !showColors;
  widthRow.hidden = !showWidths;
  sizeRow.hidden = !showSizes;
  fillRow.hidden = !showFill;
  styleRow.hidden = !showStyle;
  fontRow.hidden = !showStyle;
  for (const btn of Array.from(palette.querySelectorAll<HTMLButtonElement>('button[data-value]'))) {
    const row = btn.parentElement ? btn.parentElement.dataset.row : '';
    const value = btn.dataset.value || '';
    const active =
      (row === 'color' && value === state.color) ||
      (row === 'width' && Number(value) === state.width) ||
      (row === 'size' && Number(value) === state.fontSize) ||
      (row === 'fill' && value === state.fill);
    btn.classList.toggle('active', active);
  }
  const text = firstText();
  for (const btn of Array.from(styleRow.querySelectorAll<HTMLButtonElement>('button[data-style]'))) {
    const key = btn.dataset.style as 'bold' | 'italic' | 'underline' | 'strike' | 'bullets';
    btn.classList.toggle('active', !!(text && text[key]));
  }
  for (const btn of Array.from(styleRow.querySelectorAll<HTMLButtonElement>('button[data-align]'))) {
    btn.classList.toggle('active', !!text && (text.align || 'left') === btn.dataset.align);
  }
  const fontSelect = document.getElementById('font-family') as HTMLSelectElement | null;
  if (fontSelect && text) fontSelect.value = text.fontFamily || 'Microsoft YaHei';
  const lineInput = document.getElementById('line-height') as HTMLInputElement | null;
  if (lineInput && text) lineInput.value = String(text.lineHeight || 1.4);
}

function applyColor(color: string): void {
  state.color = color;
  const targets = selectedElements();
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.locked) continue;
    if (el.type === 'text' || el.type === 'ink') {
      if (el.color !== color) {
        el.color = color;
        changed = true;
      }
    } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly' || el.type === 'arrow') {
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
    updateStatusInfo();
  }
  refreshPalette();
}

function applyWidth(width: number): void {
  state.width = width;
  const targets = selectedElements();
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.locked) continue;
    if (el.type === 'ink') {
      if (!el.highlight && el.width !== width) {
        el.width = width;
        changed = true;
      }
    } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly' || el.type === 'arrow') {
      if (el.strokeWidth !== width) {
        el.strokeWidth = width;
        changed = true;
      }
    }
  }
  if (changed) {
    commitMutation(before, true);
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function applyFontSize(size: number): void {
  state.fontSize = size;
  const targets = selectedElements().filter((el): el is TextEl => el.type === 'text');
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.locked) continue;
    if (el.fontSize !== size) {
      el.fontSize = size;
      changed = true;
    }
  }
  if (changed) {
    commitMutation(before, true);
    const editingEl = editingTextEl();
    if (editingEl) {
      updateEditorGeometry(editingEl);
      if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = structuredClone(state.doc);
    }
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function updateEditorStyle(el: TextEl): void {
  if (editingId !== el.id) return;
  editor.style.fontFamily = el.fontFamily || FONT;
  editor.style.fontSize = el.fontSize + 'px';
  editor.style.fontWeight = el.bold ? '700' : '400';
  editor.style.fontStyle = el.italic ? 'italic' : 'normal';
  editor.style.textDecorationLine = [el.underline ? 'underline' : '', el.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  editor.style.textAlign = el.align || 'left';
  editor.style.color = el.color;
  editor.style.lineHeight = String(el.lineHeight || 1.4);
  updateEditorGeometry(el);
}

function applyTextStyle(patch: Partial<TextEl>): void {
  const targets = selectedElements().filter((el): el is TextEl => el.type === 'text' && !el.locked);
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    let dirty = false;
    for (const [key, value] of Object.entries(patch)) {
      if ((el as unknown as Record<string, unknown>)[key] !== value) {
        (el as unknown as Record<string, unknown>)[key] = value;
        dirty = true;
      }
    }
    if (dirty) {
      changed = true;
      updateEditorStyle(el);
    }
  }
  if (changed) {
    commitMutation(before, true, '文字样式');
    if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = structuredClone(state.doc);
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function firstText(): TextEl | null {
  return selectedElements().find((el): el is TextEl => el.type === 'text') || null;
}

function applyFill(fill: string): void {
  state.fill = fill;
  const targets = selectedElements().filter(
    (el): el is RectEl | EllipseEl | PolyEl => el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly'
  );
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.locked) continue;
    if (el.fill !== fill) {
      el.fill = fill;
      changed = true;
    }
  }
  if (changed) {
    commitMutation(before, true);
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function buildPalette(): void {
  colorRow = palette.querySelector('[data-row="color"]') as HTMLDivElement;
  widthRow = palette.querySelector('[data-row="width"]') as HTMLDivElement;
  sizeRow = palette.querySelector('[data-row="size"]') as HTMLDivElement;
  fillRow = palette.querySelector('[data-row="fill"]') as HTMLDivElement;
  styleRow = palette.querySelector('[data-row="style"]') as HTMLDivElement;
  fontRow = palette.querySelector('[data-row="font"]') as HTMLDivElement;
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
  for (const fill of FILLS) {
    const btn = document.createElement('button');
    btn.className = 'swatch fill';
    btn.dataset.value = fill;
    btn.title = fill || '无填充';
    if (fill) btn.style.background = fill;
    else btn.textContent = '无';
    btn.addEventListener('click', () => applyFill(fill));
    fillRow.appendChild(btn);
  }
  const toggles: { key: 'bold' | 'italic' | 'underline' | 'strike' | 'bullets'; label: string; title: string }[] = [
    { key: 'bold', label: 'B', title: '粗体' },
    { key: 'italic', label: 'I', title: '斜体' },
    { key: 'underline', label: 'U', title: '下划线' },
    { key: 'strike', label: 'S', title: '删除线' },
    { key: 'bullets', label: '•', title: '项目符号' }
  ];
  for (const item of toggles) {
    const btn = document.createElement('button');
    btn.className = 'opt style-btn';
    btn.dataset.style = item.key;
    btn.textContent = item.label;
    btn.title = item.title;
    btn.addEventListener('click', () => {
      const el = firstText();
      const next = el ? !el[item.key] : true;
      applyTextStyle({ [item.key]: next } as Partial<TextEl>);
    });
    styleRow.appendChild(btn);
  }
  for (const align of ['left', 'center', 'right'] as const) {
    const btn = document.createElement('button');
    btn.className = 'opt style-btn';
    btn.dataset.align = align;
    btn.textContent = align === 'left' ? '⇤' : align === 'center' ? '↔' : '⇥';
    btn.title = align === 'left' ? '左对齐' : align === 'center' ? '居中' : '右对齐';
    btn.addEventListener('click', () => applyTextStyle({ align }));
    styleRow.appendChild(btn);
  }
  const fontSelect = document.createElement('select');
  fontSelect.id = 'font-family';
  for (const font of ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'Segoe UI', 'Arial', 'Courier New']) {
    const option = document.createElement('option');
    option.value = font;
    option.textContent = font;
    fontSelect.appendChild(option);
  }
  fontSelect.addEventListener('change', () => applyTextStyle({ fontFamily: fontSelect.value }));
  const fontLabel = document.createElement('span');
  fontLabel.textContent = '字体';
  fontRow.appendChild(fontLabel);
  fontRow.appendChild(fontSelect);
  const lineInput = document.createElement('input');
  lineInput.id = 'line-height';
  lineInput.type = 'number';
  lineInput.min = '1';
  lineInput.max = '2';
  lineInput.step = '0.1';
  lineInput.value = '1.4';
  lineInput.title = '行高';
  lineInput.addEventListener('change', () => {
    const value = Math.min(2, Math.max(1, Number(lineInput.value) || 1.4));
    lineInput.value = String(value);
    applyTextStyle({ lineHeight: value });
  });
  fontRow.appendChild(lineInput);
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

function pointInPath(points: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 0.000001) + xi) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p1: Pt, p2: Pt) => (p1[0] - o[0]) * (p2[1] - o[1]) - (p1[1] - o[1]) * (p2[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function lassoTouches(points: Pt[], el: El): boolean {
  const b = visualBounds(el);
  const corners: Pt[] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h]
  ];
  if (corners.some((corner) => pointInPath(points, corner)) || pointInPath(points, [b.x + b.w / 2, b.y + b.h / 2])) return true;
  if (points.some(([x, y]) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)) return true;
  const rectEdges: [Pt, Pt][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]]
  ];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const c = points[(i + 1) % points.length];
    for (const [e1, e2] of rectEdges) {
      if (segmentsIntersect(a, c, e1, e2)) return true;
    }
  }
  return false;
}

function connectTarget(p: Pt): { id: string; point: Pt } | null {
  const el = hitTest(state.doc.elements, p, 4 / view.zoom, { ignoreHidden: true });
  if (!el || el.type === 'arrow') return null;
  return { id: el.id, point: nearestPointOnRect(visualBounds(el), p) };
}

function captureStyle(el: El): StyleSnapshot {
  const snap: StyleSnapshot = {
    color: state.color,
    stroke: state.color,
    fill: '',
    width: state.width,
    fontSize: state.fontSize
  };
  if (el.type === 'text') {
    snap.color = el.color;
    snap.fontSize = el.fontSize;
    snap.fontFamily = el.fontFamily;
    snap.lineHeight = el.lineHeight;
    snap.bold = el.bold;
    snap.italic = el.italic;
    snap.underline = el.underline;
    snap.strike = el.strike;
    snap.bullets = el.bullets;
    snap.align = el.align;
    snap.stickyColor = el.stickyColor;
  } else if (el.type === 'ink') {
    snap.color = el.color;
    snap.width = el.width;
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') {
    snap.stroke = el.stroke;
    snap.fill = el.fill;
    snap.width = el.strokeWidth;
  } else if (el.type === 'arrow') {
    snap.stroke = el.stroke;
    snap.width = el.strokeWidth;
  }
  return snap;
}

function copyFormatFromSelection(): boolean {
  const el = selectedElements().find((item) => !item.locked);
  if (!el) {
    setStatus('请先选择元素');
    return false;
  }
  formatBrush = captureStyle(el);
  setStatus('格式刷已复制样式，点击目标应用，Esc 退出');
  refreshPalette();
  return true;
}

function applyFormatTo(el: El): void {
  if (!formatBrush || el.locked) return;
  const before = beginMutation();
  const style = formatBrush;
  if (el.type === 'text') {
    el.color = style.color;
    el.fontSize = style.fontSize;
    el.fontFamily = style.fontFamily;
    el.lineHeight = style.lineHeight;
    el.bold = style.bold;
    el.italic = style.italic;
    el.underline = style.underline;
    el.strike = style.strike;
    el.bullets = style.bullets;
    el.align = style.align;
    if (el.sticky) el.stickyColor = style.stickyColor || el.stickyColor;
  } else if (el.type === 'ink') {
    el.color = style.color;
    if (!el.highlight) el.width = style.width;
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') {
    el.stroke = style.stroke;
    el.fill = style.fill;
    el.strokeWidth = style.width;
  } else if (el.type === 'arrow') {
    el.stroke = style.stroke;
    el.strokeWidth = style.width;
  }
  commitMutation(before, true, '应用格式');
  updateElNode(el);
  setStatus('已应用格式');
}

function applyFormatToSelection(): void {
  if (!formatBrush) {
    setStatus('请先复制格式');
    return;
  }
  for (const el of selectedElements()) applyFormatTo(el);
}

function clearFormatBrush(): void {
  if (!formatBrush) return;
  formatBrush = null;
  setStatus('已退出格式刷');
}

async function editImageCrop(id: string): Promise<void> {
  const el = imageElById(id);
  if (!el) return;
  const crop = el.crop || { x: 0, y: 0, w: 1, h: 1 };
  const result = await openForm('裁剪 / 翻转图片', [
    { key: 'x', label: '左（%）', type: 'number', value: Math.round(crop.x * 100), min: 0, max: 99, step: 1 },
    { key: 'y', label: '上（%）', type: 'number', value: Math.round(crop.y * 100), min: 0, max: 99, step: 1 },
    { key: 'w', label: '宽（%）', type: 'number', value: Math.round(crop.w * 100), min: 1, max: 100, step: 1 },
    { key: 'h', label: '高（%）', type: 'number', value: Math.round(crop.h * 100), min: 1, max: 100, step: 1 },
    { key: 'flipH', label: '水平翻转', type: 'checkbox', value: !!el.flipH },
    { key: 'flipV', label: '垂直翻转', type: 'checkbox', value: !!el.flipV }
  ]);
  if (!result) return;
  const x = Math.min(1, Math.max(0, Number(result.x) / 100));
  const y = Math.min(1, Math.max(0, Number(result.y) / 100));
  const w = Math.min(1 - x, Math.max(0.01, Number(result.w) / 100));
  const h = Math.min(1 - y, Math.max(0.01, Number(result.h) / 100));
  await cropImage(id, { x, y, w, h }, !!result.flipH, !!result.flipV);
}

async function editImageCompress(id: string): Promise<void> {
  const result = await openForm('压缩图片（自动剥离 EXIF）', [
    {
      key: 'format',
      label: '格式',
      type: 'select',
      value: 'image/jpeg',
      options: [
        { value: 'image/jpeg', label: 'JPEG' },
        { value: 'image/png', label: 'PNG' }
      ]
    },
    { key: 'quality', label: '质量（0.1–1）', type: 'number', value: 0.8, min: 0.1, max: 1, step: 0.05 }
  ]);
  if (!result) return;
  await compressImage(id, String(result.format), Math.min(1, Math.max(0.1, Number(result.quality) || 0.8)));
}

async function editArrowLabel(id: string): Promise<void> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'arrow') return;
  const value = await openPrompt('连接线标签', el.label || '');
  if (value === null) return;
  const before = beginMutation();
  el.label = value.trim() ? value.slice(0, 2000) : undefined;
  commitMutation(before, true, '编辑标签');
  renderAll();
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
  const target = e.target as HTMLElement;
  if (e.button === 0 && target.classList.contains('handle')) return;
  commitEdit();
  const p = screenToWorld(e.clientX, e.clientY);

  if (e.pointerType === 'touch' && Date.now() - lastPenAt < 700) return;
  if (e.pointerType === 'pen') lastPenAt = Date.now();
  stopInertia();
  if (e.button === 1 || e.button === 2 || state.spaceDown) {
    eraserRing.hidden = true;
    panMoved = false;
    panSample = { x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
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
    const hit = canvasHit(p);
    if (formatBrush && hit) {
      applyFormatTo(hit);
      drag = { kind: 'none' };
      return;
    }
    if (hit && e.shiftKey) {
      const groupIds = expandGroupIds([hit.id]);
      const allSelected = groupIds.every((id) => state.selectedIds.includes(id));
      const next = allSelected
        ? state.selectedIds.filter((id) => !groupIds.includes(id))
        : state.selectedIds.concat(groupIds);
      setSelection(next);
      drag = { kind: 'none' };
    } else if (hit) {
      if (!state.selectedIds.includes(hit.id)) setSelection([hit.id]);
      const selected = editableSelection();
      const orig = boundsUnion(selected);
      if (orig && selected.length) drag = { kind: 'move', ids: selected.map((el) => el.id), start: p, before: beginMutation(), dx: 0, dy: 0, orig };
    } else {
      const beforeSelection = e.shiftKey ? [...state.selectedIds] : [];
      if (!e.shiftKey) setSelection([]);
      const preview = document.createElement('div');
      preview.className = 'marquee';
      viewport.appendChild(preview);
      drag = { kind: 'marquee', start: p, beforeSelection, preview };
    }
    updateSelectionBox();
  } else if (state.tool === 'lasso') {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '3';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'rgba(37,99,235,0.08)');
    path.setAttribute('stroke', '#2563eb');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-dasharray', '5 3');
    svg.appendChild(path);
    viewport.appendChild(svg);
    drag = { kind: 'lasso', points: [p], beforeSelection: e.shiftKey ? [...state.selectedIds] : [], preview: svg };
  } else if (state.tool === 'pen' || state.tool === 'highlighter') {
    drag = startPen(p, state.tool === 'highlighter');
  } else if (state.tool === 'eraser') {
    drag = { kind: 'erase', before: null, deleted: false };
    eraseAt(p);
  } else if (state.tool === 'text') {
    drag = { kind: 'none' };
    createTextAt(p);
    return;
  } else if (state.tool === 'sticky') {
    drag = { kind: 'none' };
    createTextAt(p, true);
    return;
  } else if (state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'arrow' || state.tool === 'line' || state.tool === 'poly') {
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
  setPointerWorld(p);
  if (d.kind === 'pan') {
    const dx = e.clientX - d.startClient[0];
    const dy = e.clientY - d.startClient[1];
    if (Math.abs(dx) + Math.abs(dy) > 3) panMoved = true;
    const now = performance.now();
    const dt = Math.max(1, now - panSample.t);
    panSample.vx = (e.clientX - panSample.x) / dt;
    panSample.vy = (e.clientY - panSample.y) / dt;
    panSample.x = e.clientX;
    panSample.y = e.clientY;
    panSample.t = now;
    view.pan.x = d.startPan.x + dx;
    view.pan.y = d.startPan.y + dy;
    applyTransform();
    return;
  }
  if (d.kind === 'move') {
    const snapped = snapMove(d.orig, p[0] - d.start[0], p[1] - d.start[1], e.altKey, new Set(d.ids));
    const stepX = snapped.dx - d.dx;
    const stepY = snapped.dy - d.dy;
    if (stepX === 0 && stepY === 0) {
      renderGuides(snapped.guidesX, snapped.guidesY);
      return;
    }
    const ids = new Set(d.ids);
    for (const el of state.doc.elements) {
      if (!ids.has(el.id)) continue;
      moveEl(el, stepX, stepY);
      updateElNode(el);
    }
    refreshConnectors();
    d.dx = snapped.dx;
    d.dy = snapped.dy;
    renderGuides(snapped.guidesX, snapped.guidesY);
    updateSelectionBox();
    return;
  }
  if (d.kind === 'resize') {
    const snapped = snapPoint(p, e.altKey);
    const changed = d.ids.length === 1 ? false : scaleSelection(d, snapped);
    if (d.ids.length === 1) {
      const el = state.doc.elements.find((item) => item.id === d.ids[0]);
      if (el && resizeElement(el, d.corner, d.orig, snapped)) {
        d.changed = true;
        updateElNode(el);
      }
    } else if (changed) {
      d.changed = true;
    }
    refreshConnectors();
    if (d.changed) updateSelectionBox();
    return;
  }
  if (d.kind === 'rotate') {
    const angle = (Math.atan2(p[1] - d.center[1], p[0] - d.center[0]) * 180) / Math.PI;
    let delta = angle - d.startAngle;
    if (e.shiftKey) delta = Math.round(delta / 15) * 15;
    for (const [id, origin] of d.origins) {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) continue;
      const next = rotatePoint(origin.center, d.center, delta);
      moveEl(el, next[0] - origin.center[0], next[1] - origin.center[1]);
      el.rotation = Math.round((origin.rotation + delta) * 100) / 100 || undefined;
      updateElNode(el);
    }
    refreshConnectors();
    d.changed = true;
    updateSelectionBox();
    return;
  }
  if (d.kind === 'endpoint') {
    const el = state.doc.elements.find((item) => item.id === d.id);
    if (!el || el.type !== 'arrow') return;
    const snapped = snapPoint(p, e.altKey);
    if (d.which === 'p1') {
      el.x1 = snapped[0];
      el.y1 = snapped[1];
    } else {
      el.x2 = snapped[0];
      el.y2 = snapped[1];
    }
    d.changed = true;
    updateElNode(el);
    updateSelectionBox();
    return;
  }
  if (d.kind === 'pen') {
    const last = d.points[d.points.length - 1];
    if (e.pointerType === 'pen') {
      lastPenAt = Date.now();
      d.pressures.push(e.pressure || 0.5);
    }
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
  if (d.kind === 'lasso') {
    const last = d.points[d.points.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2 / view.zoom) d.points.push(p);
    const path = d.preview.firstElementChild as SVGPathElement | null;
    if (path) {
      const pts = d.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${view.pan.x + x * view.zoom} ${view.pan.y + y * view.zoom}`).join(' ');
      path.setAttribute('d', pts + ' Z');
    }
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
    if (Math.hypot(panSample.vx, panSample.vy) > 0.25) startInertia(panSample.vx * 8, panSample.vy * 8);
  } else if (d.kind === 'move') {
    clearGuides();
    if (d.dx !== 0 || d.dy !== 0) commitMutation(d.before, true);
  } else if (d.kind === 'resize') {
    for (const id of d.ids) {
      const el = state.doc.elements.find((item) => item.id === id);
      if (el) updateElNode(el);
    }
    if (d.changed) commitMutation(d.before, true);
  } else if (d.kind === 'rotate') {
    if (d.changed) commitMutation(d.before, true, '旋转');
  } else if (d.kind === 'endpoint') {
    if (d.changed) commitMutation(d.before, true);
  } else if (d.kind === 'lasso') {
    d.preview.remove();
    const hits =
      d.points.length >= 3
        ? state.doc.elements
            .filter((el) => !el.hidden && !el.locked && lassoTouches(d.points, el))
            .map((el) => el.id)
        : [];
    setSelection(d.beforeSelection.concat(hits));
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
    updateStatusInfo();
  }
  clearGuides();
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
    setPointerWorld(null);
  });
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (panMoved) {
      panMoved = false;
      return;
    }
    const p = screenToWorld(e.clientX, e.clientY);
    const hit = hitTest(state.doc.elements, p, 6 / view.zoom);
    if (hit && !state.selectedIds.includes(hit.id)) setSelection([hit.id]);
    if (!hit && state.selectedIds.length) setSelection([]);
    showContextMenu(buildContextMenu(p, hit), e.clientX, e.clientY);
  });
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
    },
    { passive: false }
  );
  selectionBox.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('handle')) return;
    commitEdit();
    const corner = Array.from(target.classList).find((cls) => cls !== 'handle') || 'se';
    if (corner === 'rot') {
      const selected = editableSelection();
      if (!selected.length) return;
      const orig = boundsUnion(selected);
      if (!orig) return;
      const center: Pt = [orig.x + orig.w / 2, orig.y + orig.h / 2];
      const p0 = screenToWorld(e.clientX, e.clientY);
      drag = {
        kind: 'rotate',
        ids: selected.map((el) => el.id),
        center,
        startAngle: (Math.atan2(p0[1] - center[1], p0[0] - center[0]) * 180) / Math.PI,
        before: beginMutation(),
        origins: new Map(selected.map((el) => [el.id, { center: centerOf(el), rotation: el.rotation || 0 }])),
        changed: false
      };
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件 */
      }
      e.preventDefault();
      return;
    }
    if (state.selectedIds.length === 1) {
      const el = state.doc.elements.find((item) => item.id === state.selectedIds[0]);
      if (!el) return;
      if (el.locked) return;
      if (el.type === 'arrow') {
        if (corner !== 'p1' && corner !== 'p2') return;
        drag = { kind: 'endpoint', id: el.id, which: corner, before: beginMutation(), changed: false };
      } else {
        if (el.type === 'ink') return;
        drag = {
          kind: 'resize',
          ids: [el.id],
          corner,
          before: beginMutation(),
          orig: bounds(el),
          origins: new Map([[el.id, structuredClone(el)]]),
          changed: false
        };
      }
    } else {
      const selected = editableSelection();
      const orig = boundsUnion(selected);
      if (!orig || !selected.length) return;
      drag = {
        kind: 'resize',
        ids: selected.map((el) => el.id),
        corner,
        before: beginMutation(),
        orig,
        origins: new Map(selected.map((el) => [el.id, structuredClone(el)])),
        changed: false
      };
    }
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有活动指针 */
    }
    e.preventDefault();
  });
}

function imageElById(id: string): ImageEl | null {
  const el = state.doc.elements.find((item) => item.id === id);
  return el && el.type === 'image' ? el : null;
}

async function imageOriginalSize(id: string): Promise<void> {
  const el = imageElById(id);
  if (!el) return;
  const size = await imageSize(el.src);
  if (!size) return;
  const before = beginMutation();
  el.w = size.w;
  el.h = size.h;
  commitMutation(before, true);
  updateElNode(el);
  updateSelectionBox();
  updateStatusInfo();
}

function imageFitWidth(id: string): void {
  const el = imageElById(id);
  if (!el) return;
  const available = Math.max(120, viewport.getBoundingClientRect().width / view.zoom - 80);
  const before = beginMutation();
  el.h = available * (el.h / Math.max(el.w, 1));
  el.w = available;
  commitMutation(before, true);
  updateElNode(el);
  updateSelectionBox();
  updateStatusInfo();
}

function imageReplace(id: string): void {
  imageReplaceId = id;
  imageReplaceInput.value = '';
  imageReplaceInput.click();
}

function buildContextMenu(p: Pt, hit: El | null): MenuItem[] {
  const items: MenuItem[] = [];
  if (!hit) {
    items.push(
      { label: t('ctx.newText'), action: () => createTextAt(p) },
      { label: t('ctx.paste'), action: () => void pasteFromClipboard() },
      { label: t('ctx.selectAll'), action: () => setSelection(state.doc.elements.map((el) => el.id)) },
      { separator: true, label: '', action: () => {} },
      { label: t('ctx.fit'), action: () => { fitToContent(); updateSelectionBox(); } }
    );
    return items;
  }
  const hasSelection = state.selectedIds.length > 0;
  items.push(
    { label: t('ctx.copy'), action: () => copySelected(false), disabled: !hasSelection },
    { label: t('ctx.cut'), action: () => copySelected(true), disabled: !hasSelection },
    { label: t('ctx.duplicate'), action: duplicateSelected, disabled: !hasSelection },
    { separator: true, label: '', action: () => {} },
    { label: t('ctx.front'), action: () => reorderSelection(true) },
    { label: t('ctx.back'), action: () => reorderSelection(false) },
    {
      label: selectedElements().some((el) => el.groupId) ? t('ctx.ungroup') : t('ctx.group'),
      action: () => (selectedElements().some((el) => el.groupId) ? ungroupSelection() : groupSelection()),
      disabled: !hasSelection
    },
    {
      label: selectedElements().every((el) => el.locked) ? t('ctx.unlock') : t('ctx.lock'),
      action: () => setLockedSelection(!selectedElements().every((el) => el.locked)),
      disabled: !hasSelection
    },
    { label: t('ctx.hide'), action: () => setHiddenSelection(true), disabled: !hasSelection },
    { separator: true, label: '', action: () => {} },
    { label: t('ctx.copyFormat'), action: () => copyFormatFromSelection(), disabled: !hasSelection },
    { label: t('ctx.pasteFormat'), action: applyFormatToSelection, disabled: !formatBrush || !hasSelection },
    { separator: true, label: '', action: () => {} },
    { label: t('ctx.exportSelection'), action: () => void exportPng(), disabled: !hasSelection },
    { label: t('ctx.copyPng'), action: () => void copySelectionPng(), disabled: !hasSelection },
    { separator: true, label: '', action: () => {} },
    { label: t('ctx.delete'), action: deleteSelected }
  );
  const stickyTarget = state.selectedIds.length === 1 ? selectedElements()[0] : null;
  if (stickyTarget && stickyTarget.type === 'text' && stickyTarget.sticky) {
    const setSticky = (color: string) => {
      const before = beginMutation();
      stickyTarget.stickyColor = color;
      commitMutation(before, true, '便签颜色');
      renderAll();
    };
    items.push(
      { separator: true, label: '', action: () => {} },
      { label: '便签：黄色', action: () => setSticky('#fef3c7') },
      { label: '便签：蓝色', action: () => setSticky('#dbeafe') },
      { label: '便签：绿色', action: () => setSticky('#dcfce7') }
    );
  }
  if (state.selectedIds.length === 1 && hit.type === 'arrow') {
    items.push(
      { separator: true, label: '', action: () => {} },
      { label: t('ctx.label'), action: () => void editArrowLabel(hit.id) }
    );
  }
  if (state.selectedIds.length === 1 && hit.type === 'image') {
    items.push(
      { separator: true, label: '', action: () => {} },
      { label: t('ctx.imageOriginal'), action: () => void imageOriginalSize(hit.id) },
      { label: t('ctx.imageFit'), action: () => imageFitWidth(hit.id) },
      { label: t('ctx.crop'), action: () => void editImageCrop(hit.id) },
      { label: t('ctx.compress'), action: () => void editImageCompress(hit.id) },
      { label: t('ctx.replace'), action: () => imageReplace(hit.id) }
    );
  }
  return items;
}

function groupSelection(): void {
  const targets = editableSelection();
  if (targets.length < 2) {
    setStatus('请至少选择两个元素');
    return;
  }
  const before = beginMutation();
  const groupId = uid();
  for (const el of targets) el.groupId = groupId;
  commitMutation(before, true, '分组');
  renderAll();
  setStatus('已分组');
}

function ungroupSelection(): void {
  const targets = editableSelection().filter((el) => el.groupId);
  if (!targets.length) return;
  const before = beginMutation();
  for (const el of targets) el.groupId = undefined;
  commitMutation(before, true, '解组');
  renderAll();
  setStatus('已解组');
}

function setLockedSelection(locked: boolean): void {
  const targets = selectedElements();
  if (!targets.length) return;
  const before = beginMutation();
  for (const el of targets) el.locked = locked || undefined;
  commitMutation(before, true, locked ? '锁定' : '解锁');
  renderAll();
  refreshPalette();
  setStatus(locked ? '已锁定' : '已解锁');
}

function setHiddenSelection(hidden: boolean): void {
  const targets = selectedElements();
  if (!targets.length) return;
  const before = beginMutation();
  for (const el of targets) el.hidden = hidden || undefined;
  if (hidden) state.selectedIds = [];
  commitMutation(before, true, hidden ? '隐藏' : '显示');
  renderAll();
  setSelection(state.selectedIds);
  setStatus(hidden ? '已隐藏（可在图层面板恢复）' : '已显示');
}

function focusNode(id: string): void {
  const node = world.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node) node.focus();
}

function cycleSelection(back: boolean): void {
  const els = state.doc.elements;
  if (!els.length) return;
  if (!state.selectedIds.length) {
    const target = back ? els[els.length - 1] : els[0];
    setSelection([target.id]);
    ensureVisible(bounds(target));
    focusNode(target.id);
    return;
  }
  const lastId = state.selectedIds[state.selectedIds.length - 1];
  let index = els.findIndex((el) => el.id === lastId);
  if (index < 0) index = back ? 0 : -1;
  const nextIndex = (index + (back ? -1 : 1) + els.length) % els.length;
  const target = els[nextIndex];
  setSelection([target.id]);
  ensureVisible(bounds(target));
  focusNode(target.id);
}

function refreshPageBar(): void {
  pageSelect.replaceChildren();
  state.pages.forEach((page, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = page.name;
    pageSelect.appendChild(option);
  });
  pageSelect.value = String(state.activePage);
}

function afterPageChange(): void {
  renderAll();
  fitToContent();
  refreshPageBar();
  refreshPanels();
  updateTitle();
  updateStatusInfo();
}

function addPageAction(): void {
  commitEdit();
  addPage();
  switchPage(state.pages.length - 1);
  markDirty({ autosave: false });
  setSelection([]);
  afterPageChange();
  setStatus('已新建页面');
}

async function renamePageAction(): Promise<void> {
  const value = await openPrompt('重命名页面', state.pages[state.activePage]?.name || '');
  if (value === null || !value.trim()) return;
  renamePage(state.activePage, value);
  markDirty({ autosave: false });
  refreshPageBar();
  setStatus('已重命名页面');
}

async function deletePageAction(): Promise<void> {
  if (state.pages.length <= 1) {
    setStatus('至少保留一个页面');
    return;
  }
  const ok = await window.api.confirm('删除当前页面', '该页面内容将一并删除，是否继续？');
  if (!ok) return;
  if (removePage(state.activePage)) {
    markDirty({ autosave: false });
    afterPageChange();
    setStatus('已删除页面');
  }
}

function movePageAction(delta: number): void {
  const target = state.activePage + delta;
  if (movePage(state.activePage, target)) {
    markDirty({ autosave: false });
    afterPageChange();
    setStatus('已调整页面顺序');
  }
}

function pageMenu(): void {
  const rect = pageMore.getBoundingClientRect();
  showContextMenu(
    [
      { label: t('page.new'), action: addPageAction },
      { label: t('page.rename'), action: () => void renamePageAction() },
      { label: t('page.up'), action: () => movePageAction(-1) },
      { label: t('page.down'), action: () => movePageAction(1) },
      { separator: true, label: '', action: () => {} },
      { label: t('page.delete'), action: () => void deletePageAction() },
      { label: t('page.export'), action: () => void exportAllPagesPdf() }
    ],
    rect.right,
    rect.bottom + 4
  );
}

function shortcutCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.toLowerCase();
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

function customToolFor(e: KeyboardEvent): Tool | null {
  const combo = shortcutCombo(e);
  const map = currentShortcuts();
  for (const [action, value] of Object.entries(map)) {
    if (value === combo) return action as Tool;
  }
  return null;
}

function runSearch(): void {
  const query = searchInput.value.trim().toLowerCase();
  searchMatches = [];
  searchIndex = 0;
  if (query) {
    for (const el of state.doc.elements) {
      if (el.hidden) continue;
      let haystack = el.name || '';
      if (el.type === 'text') haystack += ' ' + el.text;
      else if (el.type === 'arrow') haystack += ' ' + (el.label || '');
      if (haystack.toLowerCase().includes(query)) searchMatches.push(el.id);
    }
  }
  searchCount.textContent = searchMatches.length ? `${searchIndex + 1}/${searchMatches.length}` : '0/0';
  if (searchMatches.length) {
    const id = searchMatches[0];
    setSelection([id]);
    const el = state.doc.elements.find((item) => item.id === id);
    if (el) ensureVisible(visualBounds(el));
  }
}

function cycleSearch(delta: number): void {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + delta + searchMatches.length) % searchMatches.length;
  const id = searchMatches[searchIndex];
  setSelection([id]);
  const el = state.doc.elements.find((item) => item.id === id);
  if (el) ensureVisible(visualBounds(el));
  searchCount.textContent = `${searchIndex + 1}/${searchMatches.length}`;
}

function openSearch(): void {
  searchbar.hidden = false;
  searchInput.focus();
  searchInput.select();
  runSearch();
}

function closeSearch(): void {
  searchbar.hidden = true;
  searchMatches = [];
  searchInput.value = '';
}

const TEMPLATES: Record<string, { width: number; height: number; make: () => TextEl[] }> = {
  blank: { width: 0, height: 0, make: () => [] },
  dots: { width: 0, height: 0, make: () => [] },
  meeting: {
    width: 0,
    height: 0,
    make: () => {
      const mk = (text: string, x: number, y: number, size: number): TextEl => ({
        id: uid(), type: 'text', x, y, w: 360, h: size * 1.6, text, fontSize: size, color: '#1f2937', bold: size > 20 ? true : undefined
      });
      return [
        mk('会议纪要', 120, 100, 36),
        mk('议题', 120, 190, 24),
        mk('结论', 520, 190, 24),
        mk('待办', 920, 190, 24),
        mk('• ', 120, 240, 20),
        mk('• ', 520, 240, 20),
        mk('• ', 920, 240, 20)
      ];
    }
  },
  todo: {
    width: 0,
    height: 0,
    make: () => [
      { id: uid(), type: 'text', x: 140, y: 120, w: 420, h: 60, text: '待办清单', fontSize: 36, color: '#1f2937', bold: true },
      { id: uid(), type: 'text', x: 140, y: 200, w: 460, h: 200, text: '第一项\n第二项\n第三项', fontSize: 22, color: '#1f2937', bullets: true }
    ]
  }
};

async function newWithTemplate(): Promise<void> {
  const result = await openForm(
    t('new.title'),
    [
      {
        key: 'template',
        label: t('new.template'),
        type: 'select',
        value: state.settings.template,
        options: [
          { value: 'blank', label: t('tpl.blank') },
          { value: 'dots', label: t('tpl.dots') },
          { value: 'meeting', label: t('tpl.meeting') },
          { value: 'todo', label: t('tpl.todo') }
        ]
      }
    ],
    t('new.create')
  );
  if (!result) return;
  const template = String(result.template);
  await window.api.setSettings({ template });
  state.settings.template = template;
  if (!(await window.api.confirmDiscard())) return;
  cancelEdit();
  resetDoc();
  if (template === 'dots') state.settings.background = 'dots';
  if (template === 'meeting' || template === 'todo') {
    const elements = TEMPLATES[template].make();
    state.doc.elements.push(...elements);
    state.pages[0].elements = state.doc.elements;
    state.selectedIds = [];
  }
  view.zoom = 1;
  view.pan.x = 0;
  view.pan.y = 0;
  applyTransform();
  renderAll();
  updateTitle();
  refreshPageBar();
  markDirty({ autosave: false });
  setStatus(template === 'blank' ? '已新建空白白板' : '已应用模板');
}

function installEditor(): void {
  editor.addEventListener('input', () => {
    const el = editingTextEl();
    const fontSize = el ? el.fontSize : state.fontSize;
    editor.style.height = 'auto';
    editor.style.height = Math.max(fontSize * 1.4, editor.scrollHeight) + 'px';
    ensureEditorVisible();
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
    if (!settingsOverlay.hidden) return;
    if (document.activeElement === editor) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
      return;
    }
    const custom = customToolFor(e);
    if (custom && !(document.activeElement instanceof HTMLInputElement)) {
      e.preventDefault();
      setTool(custom);
      return;
    }
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
      if (key === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (key === 'l' && e.shiftKey) {
        e.preventDefault();
        setLockedSelection(!selectedElements().every((el) => el.locked));
        return;
      }
      if (key === 'h' && e.shiftKey) {
        e.preventDefault();
        setHiddenSelection(true);
        return;
      }
      if (key === 'c') {
        if (e.shiftKey) {
          e.preventDefault();
          void copySelectionPng();
          return;
        }
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
      if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        fitSelection();
        return;
      }
      if (key === 'p') {
        e.preventDefault();
        void printCanvas('print');
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
        zoomToPercent(100);
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
    if (e.key === 'Tab') {
      e.preventDefault();
      cycleSelection(e.shiftKey);
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
      if (formatBrush) {
        clearFormatBrush();
        return;
      }
      if (state.tool !== 'select') {
        setTool('select');
      } else {
        setSelection([]);
      }
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
    const poly = POLY_KEYS[key];
    if (poly) {
      polyKind = poly;
      setTool('poly');
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
  window.api.onMenu((action, arg) => {
    if (action === 'new') void newWithTemplate();
    else if (action === 'open') void openDocument();
    else if (action === 'open-path' && arg) void openDocument(arg);
    else if (action === 'save') void saveDocument(false);
    else if (action === 'save-as') void saveDocument(true);
    else if (action === 'export-png') void exportPng();
    else if (action === 'export-svg') void exportSvg();
    else if (action === 'export-pdf') void printCanvas('pdf');
    else if (action === 'export-pages-pdf') void exportAllPagesPdf();
    else if (action === 'print') void printCanvas('print');
    else if (action === 'page-new') addPageAction();
    else if (action === 'page-rename') void renamePageAction();
    else if (action === 'page-delete') void deletePageAction();
    else if (action === 'page-up') movePageAction(-1);
    else if (action === 'page-down') movePageAction(1);
    else if (action === 'toggle-panels') togglePanels();
    else if (action === 'search') openSearch();
    else if (action === 'backup-now') void backupNow();
    else if (action === 'restore-backup') void restoreBackup();
    else if (action === 'settings') openSettings();
    else if (action === 'help') toggleHelp(true);
  });
  window.api.onRequestSave(async () => {
    window.api.saveResult(await saveDocument(false));
  });
}

function installZoomInput(): void {
  const commitZoom = () => {
    const value = Number(zoomInput.value);
    if (!Number.isFinite(value)) {
      zoomInput.value = String(Math.round(view.zoom * 100));
      return;
    }
    zoomToPercent(value);
    updateStatusInfo();
  };
  zoomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitZoom();
      zoomInput.blur();
    } else if (e.key === 'Escape') {
      zoomInput.value = String(Math.round(view.zoom * 100));
      zoomInput.blur();
    }
  });
  zoomInput.addEventListener('change', commitZoom);
  zoomInput.addEventListener('focus', () => zoomInput.select());
}

function installToolbar(): void {
  for (const btn of Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]'))) {
    const toolName = btn.dataset.shape || btn.dataset.tool || 'rect';
    btn.innerHTML = toolIcon(btn.dataset.tool || 'rect', btn.dataset.shape);
    btn.classList.add('icon-btn');
    btn.setAttribute('aria-label', btn.title || toolName);
    btn.addEventListener('click', () => {
      const shape = btn.dataset.shape as PolyKind | undefined;
      if (shape) {
        polyKind = shape;
        setTool('poly');
        return;
      }
      const tool = btn.dataset.tool as Tool | undefined;
      if (tool) setTool(tool);
    });
  }
  pageSelect.addEventListener('change', () => {
    switchPage(Number(pageSelect.value));
    markDirty({ autosave: false });
    afterPageChange();
  });
  pageAdd.addEventListener('click', addPageAction);
  pageMore.addEventListener('click', pageMenu);
  panelBtn.addEventListener('click', () => togglePanels());
  searchClose.addEventListener('click', closeSearch);
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      cycleSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
  pickImageBtn.innerHTML = toolIcon('image');
  pickImageBtn.classList.add('icon-btn');
  pickImageBtn.setAttribute('aria-label', pickImageBtn.title || '图片');
  pickImageBtn.addEventListener('click', () => fileInput.click());
  zoomInBtn.addEventListener('click', () => zoomAroundViewport(1.2));
  zoomOutBtn.addEventListener('click', () => zoomAroundViewport(1 / 1.2));
  zoomFitBtn.addEventListener('click', () => {
    fitToContent();
    updateSelectionBox();
    updateStatusInfo();
  });
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files ?? []);
    const at = viewportCenter();
    for (const file of files) await insertImage(file, at);
    fileInput.value = '';
  });
  imageReplaceInput.addEventListener('change', async () => {
    const file = imageReplaceInput.files && imageReplaceInput.files[0];
    const id = imageReplaceId;
    imageReplaceId = null;
    imageReplaceInput.value = '';
    if (!file || !id) return;
    const prepared = await prepareImageFile(file);
    if (!prepared) return;
    if (await replaceImageSource(id, prepared)) setStatus('已替换图片');
  });
}

function setTextStyleById(id: string, patch: Record<string, unknown>): void {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'text') return;
  const before = beginMutation();
  Object.assign(el, patch);
  commitMutation(before, true, '文字样式');
  renderAll();
}

function stateHistory(): { label: string; done: boolean }[] {
  return historyEntries();
}

function searchIds(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return state.doc.elements
    .filter((el) => {
      let haystack = el.name || '';
      if (el.type === 'text') haystack += ' ' + el.text;
      else if (el.type === 'arrow') haystack += ' ' + (el.label || '');
      return haystack.toLowerCase().includes(q);
    })
    .map((el) => el.id);
}

function installTestHooks(): void {
  const testApi: TestApi = {
    count: () => state.doc.elements.length,
    elements: () =>
      state.doc.elements.map((el) => {
        const b = bounds(el);
        const base = { id: el.id, type: el.type, x: b.x, y: b.y, w: b.w, h: b.h };
        const meta = { rotation: el.rotation, groupId: el.groupId, locked: el.locked, hidden: el.hidden, name: el.name };
        if (el.type === 'text') return { ...base, ...meta, color: el.color, fontSize: el.fontSize, bold: el.bold, italic: el.italic, align: el.align, fontFamily: el.fontFamily, lineHeight: el.lineHeight, sticky: el.sticky };
        if (el.type === 'ink') return { ...base, ...meta, color: el.color, width: el.width, highlight: el.highlight };
        if (el.type === 'image') return { ...base, ...meta };
        if (el.type === 'arrow') return { ...base, ...meta, stroke: el.stroke, strokeWidth: el.strokeWidth, head: el.head };
        if (el.type === 'poly') return { ...base, ...meta, stroke: el.stroke, strokeWidth: el.strokeWidth, fill: el.fill, kind: el.kind };
        return { ...base, ...meta, stroke: el.stroke, strokeWidth: el.strokeWidth, fill: el.fill };
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
    addInk: (points, color, width, highlight) => {
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
        width,
        highlight: highlight || undefined
      };
      state.doc.elements.push(el);
      commitMutation(before, true);
      renderAll();
      return el.id;
    },
    addShape: (type, x, y, w, h) => {
      const before = beginMutation();
      if (type === 'arrow' || type === 'line') {
        const el: ArrowEl = {
          id: uid(),
          type: 'arrow',
          x1: x,
          y1: y,
          x2: x + w,
          y2: y + h,
          stroke: state.color,
          strokeWidth: state.width,
          head: type === 'arrow'
        };
        state.doc.elements.push(el);
        commitMutation(before, true);
        renderAll();
        return el.id;
      }
      const el: RectEl | EllipseEl =
        type === 'rect'
          ? { id: uid(), type: 'rect', x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill }
          : { id: uid(), type: 'ellipse', x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill };
      state.doc.elements.push(el);
      commitMutation(before, true);
      renderAll();
      return el.id;
    },
    addImage: async (dataUrl, x, y) => {
      const size = await imageSize(dataUrl);
      if (!size) return null;
      return insertImageSourceDirect(dataUrl, size, x, y);
    },
    hitTest: (x, y) => {
      const hit = canvasHit([x, y]);
      return hit ? hit.type : null;
    },
    move: (id, dx, dy) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) return;
      const before = beginMutation();
      moveEl(el, dx, dy);
      commitMutation(before, true);
      updateElNode(el);
      refreshConnectors();
      updateSelectionBox();
      updateStatusInfo();
    },
    undo: () => {
      const ok = undoHistory();
      if (ok) {
        renderAll();
        updateStatusInfo();
      }
      return ok;
    },
    redo: () => {
      const ok = redoHistory();
      if (ok) {
        renderAll();
        updateStatusInfo();
      }
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
      updateStatusInfo();
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
      state.filePath = result.repaired ? null : result.path ?? null;
      state.selectedIds = [];
      state.revision = 0;
      clearHistory();
      renderAll();
      refreshPalette();
      updateStatusInfo();
      return true;
    },
    exportPngTo: async (path) => {
      const dataUrl = await renderPng();
      if (!dataUrl) return false;
      const result = await window.api.savePng(dataUrl, path);
      return !!result.path;
    },
    pngData: (opts) => renderPng(opts),
    setFill: (id, fill) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el || (el.type !== 'rect' && el.type !== 'ellipse' && el.type !== 'poly')) return;
      const before = beginMutation();
      el.fill = fill;
      commitMutation(before, true);
      renderAll();
    },
    eraseAt: (x, y) => {
      const before = state.doc.elements.length;
      eraseAt([x, y]);
      return before - state.doc.elements.length;
    },
    el: (id) => {
      const el = state.doc.elements.find((item) => item.id === id);
      return el ? structuredClone(el) : null;
    },
    setEndpoints: (id, x1, y1, x2, y2) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el || el.type !== 'arrow') return;
      const before = beginMutation();
      el.x1 = x1;
      el.y1 = y1;
      el.x2 = x2;
      el.y2 = y2;
      commitMutation(before, true);
      updateElNode(el);
      updateSelectionBox();
    },
    zoomPercent: () => Math.round(view.zoom * 100),
    fitSelection: () => {
      fitSelection();
      updateStatusInfo();
    },
    selectAll: () => setSelection(state.doc.elements.map((el) => el.id)),
    statusInfo: () => (document.getElementById('status-info') as HTMLSpanElement).textContent || '',
    copySelectionPng: () => copySelectionPng(),
    exportSelectionPngTo: async (path) => {
      const dataUrl = await renderPng({ selection: true, background: true });
      if (!dataUrl) return false;
      const result = await window.api.savePng(dataUrl, path);
      return !!result.path;
    },
    replaceImage: async (id, dataUrl) => {
      const size = await imageSize(dataUrl);
      if (!size) return false;
      return replaceImageSource(id, { src: dataUrl, w: size.w, h: size.h });
    },
    imageFit: (id, mode) => {
      if (mode === 'original') void imageOriginalSize(id);
      else imageFitWidth(id);
    },
    addPoly: (kind, x, y, w, h) => {
      const before = beginMutation();
      const el: PolyEl = { id: uid(), type: 'poly', kind, x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill };
      state.doc.elements.push(el);
      commitMutation(before, true, '绘制' + describePoly(kind));
      renderAll();
      return el.id;
    },
    setRotation: (id, deg) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) return;
      const before = beginMutation();
      el.rotation = deg || undefined;
      commitMutation(before, true, '旋转');
      updateElNode(el);
      updateSelectionBox();
    },
    groupSelection,
    ungroupSelection,
    setLocked: (id, locked) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) return;
      const before = beginMutation();
      el.locked = locked || undefined;
      commitMutation(before, true, locked ? '锁定' : '解锁');
      renderAll();
    },
    setHidden: (id, hidden) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) return;
      const before = beginMutation();
      el.hidden = hidden || undefined;
      commitMutation(before, true, hidden ? '隐藏' : '显示');
      renderAll();
    },
    setTextStyle: setTextStyleById,
    addSticky: (text, x, y) => {
      const before = beginMutation();
      const el: TextEl = {
        id: uid(), type: 'text', x, y, w: 220, h: state.fontSize * 1.4, text, fontSize: state.fontSize,
        color: state.color, sticky: true, stickyColor: '#fef3c7'
      };
      state.doc.elements.push(el);
      commitMutation(before, true, '插入便签');
      renderAll();
      return el.id;
    },
    connect: (fromId, toId) => {
      const a = state.doc.elements.find((item) => item.id === fromId);
      const b = state.doc.elements.find((item) => item.id === toId);
      if (!a || !b) return '';
      const ac = centerOf(a);
      const bc = centerOf(b);
      const start = nearestPointOnRect(visualBounds(a), bc);
      const end = nearestPointOnRect(visualBounds(b), ac);
      const before = beginMutation();
      const el: ArrowEl = {
        id: uid(), type: 'arrow', x1: start[0], y1: start[1], x2: end[0], y2: end[1],
        stroke: state.color, strokeWidth: state.width, head: true, fromId, toId
      };
      state.doc.elements.push(el);
      commitMutation(before, true, '连接线');
      renderAll();
      return el.id;
    },
    lasso: (points, shift) => {
      const hits = state.doc.elements
        .filter((el) => !el.hidden && !el.locked && lassoTouches(points.map(([x, y]) => [x, y] as Pt), el))
        .map((el) => el.id);
      setSelection(shift ? state.selectedIds.concat(hits) : hits);
      return state.selectedIds.slice();
    },
    setLabel: (id, label) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el || el.type !== 'arrow') return;
      const before = beginMutation();
      el.label = label || undefined;
      commitMutation(before, true, '编辑标签');
      renderAll();
    },
    copyFormat: () => copyFormatFromSelection(),
    pasteFormat: (id) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) return false;
      applyFormatTo(el);
      return true;
    },
    history: () => stateHistory(),
    jumpHistory: (index) => {
      jumpToHistory(index);
      renderAll();
      refreshPanels();
    },
    search: (text) => searchIds(text),
    exportSvgTo: async (path) => {
      const svg = buildSvg(state.doc.elements);
      if (!svg) return false;
      const result = await window.api.saveSvg(svg, path);
      return !!result.path;
    },
    pageNames: () => state.pages.map((page) => page.name),
    addPage: (name) => {
      const page = addPage(name);
      markDirty({ autosave: false });
      refreshPageBar();
      return page.id;
    },
    removePage: (index) => {
      const ok = removePage(index);
      if (ok) {
        markDirty({ autosave: false });
        afterPageChange();
      }
      return ok;
    },
    switchPage: (index) => {
      const ok = switchPage(index);
      if (ok) afterPageChange();
      return ok;
    },
    crop: (id, cropRect, flipH, flipV) => cropImage(id, cropRect, flipH, flipV),
    compress: (id, mime, quality) => compressImage(id, mime, quality),
    printAllPagesTo: async (path) => {
      const images: string[] = [];
      for (const page of state.pages) {
        const url = await renderElementsPng(page.elements, { selection: false, background: true });
        if (url) images.push(url);
      }
      if (!images.length) return false;
      const result = await window.api.printPages(images, 'pdf', path);
      return !!result.path;
    },
    elementLabel: (id) => {
      const el = state.doc.elements.find((item) => item.id === id);
      return el ? describeEl(el) : '';
    },
    focusElement: (id) => {
      focusNode(id);
      const node = world.querySelector<HTMLElement>(`[data-id="${id}"]`);
      return !!node && document.activeElement === node;
    },
    applySettings: async (patch) => {
      const result = await window.api.setSettings(patch);
      if (!result || 'error' in result) return false;
      state.settings = result;
      applyTheme(state.settings.theme);
      applyI18n();
      applyTransform();
      refreshPalette();
      refreshPageBar();
      updateStatusInfo();
      return true;
    },
    gridSnapEnabled: () => true,
    printPdfTo: async (path) => {
      const dataUrl = await renderPng({ selection: false, background: true });
      if (!dataUrl) return false;
      const result = await window.api.printPng(dataUrl, 'pdf', path);
      return !!result.path;
    },
    setView: (zoom, panX, panY) => {
      view.zoom = Math.min(4, Math.max(0.1, zoom));
      view.pan.x = panX;
      view.pan.y = panY;
      applyTransform();
    },
    mountedCount: () => world.querySelectorAll(':scope > *:not(#editor)').length
  };
  window.__test = testApi;
}

function insertImageSourceDirect(dataUrl: string, size: { w: number; h: number }, x: number, y: number): string {
  const scale = Math.min(1, 480 / Math.max(size.w, size.h));
  const before = beginMutation();
  const el: ImageEl = { id: uid(), type: 'image', x, y, w: size.w * scale, h: size.h * scale, src: dataUrl };
  state.doc.elements.push(el);
  commitMutation(before, true);
  renderAll();
  return el.id;
}

function installBackupTimer(): void {
  window.setInterval(() => {
    if (state.revision === lastBackupRevision) return;
    lastBackupRevision = state.revision;
    void window.api.backupNow(serialize(), state.filePath);
  }, 10 * 60 * 1000);
}

async function init(): Promise<void> {
  let boot: StartupResult = { settings: { ...DEFAULT_SETTINGS }, recovery: null, openPath: null };
  try {
    boot = await window.api.startup();
    state.settings = boot.settings || { ...DEFAULT_SETTINGS };
  } catch (err) {
    window.api.log('error', '启动信息读取失败：' + String(err));
  }
  buildPalette();
  setEditHooks(commitEdit, cancelEdit, refreshPalette);
  setRenderHook(refreshPanels);
  installPanels({ select: (ids) => setSelection(ids), changed: () => refreshPanels() });
  applyTheme(state.settings.theme);
  setStatusHook(updateStatusInfo);
  setRecoverySnapshotProvider(recoverySnapshot);
  applyI18n();
  setTransformHook(() => {
    syncNodes();
    updateSelectionBox();
    updateStatusInfo();
  });
  installContextMenu();
  installMinimap();
  installSettings(() => {
    applyTheme(state.settings.theme);
    applyI18n();
    applyTransform();
    refreshPalette();
    refreshPanels();
  });
  installZoomInput();
  setTool('select');
  installPointerEvents();
  installPasteAndDrop();
  installEditor();
  installKeyboard();
  installHelp();
  installMenu();
  installToolbar();
  installTestHooksSafe();
  applyTransform();
  renderAll();
  refreshPageBar();
  setStatus('');
  updateStatusInfo();
  installBackupTimer();

  window.addEventListener('error', (e) => {
    window.api.log('error', '渲染错误：' + (e.message || String(e.error || '未知')));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.api.log('error', '未处理拒绝：' + String(e.reason));
  });

  try {
    if (boot.recovery) {
      applyRecoveredDocument(boot.recovery.text, boot.recovery.path);
    } else if (boot.openPath) {
      await openDocument(boot.openPath);
    } else {
      const fromQuery = new URLSearchParams(location.search).get('open');
      if (fromQuery) await openDocument(fromQuery);
    }
  } catch (err) {
    window.api.log('error', '启动恢复失败：' + String(err));
  }
}

function installTestHooksSafe(): void {
  if (new URLSearchParams(location.search).has('smoke')) installTestHooks();
}

void init();
