// SPDX-License-Identifier: GPL-3.0-or-later
import './style.css';
import {
  AlignMode,
  ArrowEl,
  Dash,
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
  alignDeltas,
  arrowPathD,
  autoSelectableElements,
  bounds,
  boundsUnion,
  centerOf,
  cloneEl,
  cloneElements,
  dashArray,
  distToSegment,
  distributeDeltas,
  hitTest,
  inkAbsolutePoints,
  InkPathBuilder,
  moveEl,
  nearestPointOnRotatedRect,
  normalizeInk,
  polyPathD,
  rectsIntersect,
  rotatePoint,
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
  duplicatePage,
  historyEntries,
  historyStats,
  jumpToHistory,
  loadFromText,
  markDirty,
  markSaved,
  movePage,
  pruneSelection,
  pushPageUndo,
  recoveryDebug,
  removeElement,
  removePage,
  renamePage,
  resetDoc,
  redo as redoHistory,
  redoPage,
  serialize,
  setRecoverySnapshotProvider,
  setStatus,
  setStatusHook,
  snapshotDoc,
  state,
  syncActivePage,
  updateTitle,
  switchPage,
  undo as undoHistory,
  undoPage
} from './state';
import { FONT, describeEl, refreshConnectors, renderAll, setEditing, setRenderHook, syncNodes, updateElNode, updateElNodes, updateSelectionBox } from './render';
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
  exportAllPagesZip,
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
import { installContextMenu, hideContextMenu, showContextMenu } from './contextmenu';
import { openForm, openPrompt } from './dialogs';
import type { MenuItem } from './contextmenu';
import { installMinimap, requestMinimap, setMinimapHidden } from './minimap';
import { applyTheme, closeSettings, currentShortcuts, installSettings, openSettings } from './settings';
import { installPanels, refreshPanels, togglePanels } from './panels';
import { toolIcon } from './icons';
import { applyI18n, t } from './i18n';
import { setPointerWorld, updateStatusInfo } from './status';
import type { StartupResult, TestApi } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
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
const POLY_KEYS: Record<string, PolyKind> = {
  '1': 'triangle',
  '2': 'diamond',
  '3': 'star',
  '4': 'roundrect',
  '5': 'hexagon',
  '6': 'cylinder',
  '7': 'cloud',
  '8': 'lane'
};

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
const presentInfo = document.getElementById('present-info') as HTMLDivElement;
const presentLaser = document.getElementById('present-laser') as HTMLDivElement;
const presentBlack = document.getElementById('present-black') as HTMLDivElement;
const helpOverlay = document.getElementById('help') as HTMLDivElement;
const onboardingOverlay = document.getElementById('onboarding') as HTMLDivElement;
const onboardingClose = document.getElementById('onboarding-close') as HTMLButtonElement;
const helpBtn = document.getElementById('help-btn') as HTMLButtonElement;
const helpClose = document.getElementById('help-close') as HTMLButtonElement;
const settingsOverlay = document.getElementById('settings') as HTMLDivElement;
const pageSelect = document.getElementById('page-select') as HTMLSelectElement;
const pageAdd = document.getElementById('page-add') as HTMLButtonElement;
const pageMore = document.getElementById('page-more') as HTMLButtonElement;
const pageThumbsBtn = document.getElementById('page-thumbs-btn') as HTMLButtonElement;
const pageThumbs = document.getElementById('page-thumbs') as HTMLDivElement;
const searchAllPages = document.getElementById('search-all-pages') as HTMLInputElement;
const panelBtn = document.getElementById('panel-btn') as HTMLButtonElement;
const rulerBtn = document.getElementById('ruler-btn') as HTMLButtonElement;
const rulerH = document.getElementById('ruler-h') as HTMLDivElement;
const rulerV = document.getElementById('ruler-v') as HTMLDivElement;
const rulerHCanvas = document.getElementById('ruler-h-canvas') as HTMLCanvasElement;
const rulerVCanvas = document.getElementById('ruler-v-canvas') as HTMLCanvasElement;
const manualGuidesEl = document.getElementById('manual-guides') as HTMLDivElement;
const searchbar = document.getElementById('searchbar') as HTMLDivElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchCount = document.getElementById('search-count') as HTMLSpanElement;
const searchClose = document.getElementById('search-close') as HTMLButtonElement;
const replaceInput = document.getElementById('replace-input') as HTMLInputElement;
const replaceOneBtn = document.getElementById('replace-one') as HTMLButtonElement;
const replaceAllBtn = document.getElementById('replace-all') as HTMLButtonElement;

const RECENT_COLORS_KEY = 'wbc-recent-colors';
let recentColors: string[] = [];
try {
  const raw = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || '[]');
  if (Array.isArray(raw)) recentColors = raw.filter((value) => typeof value === 'string').slice(0, 8);
} catch {
  recentColors = [];
}

let colorRow: HTMLDivElement;
let recentRow: HTMLDivElement | null = null;
let widthRow: HTMLDivElement;
let dashRow: HTMLDivElement;
let eraserRow: HTMLDivElement;
let opacityRow: HTMLDivElement;
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
  dash: Dash;
  opacity: number;
  fontSize: number;
  fontFamily?: string;
  lineHeight?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  bullets?: boolean;
  numbered?: boolean;
  align?: TextEl['align'];
  stickyColor?: string;
}

let editingId: string | null = null;
let editBefore: Doc | null = null;
let editTextSnapshot = '';
let imageReplaceId: string | null = null;
let panMoved = false;
let lastBackupRevision = -1;
let searchResults: { page: number; id: string }[] = [];
let searchIndex = 0;
let lastPenAt = 0;
let inertiaFrame = 0;
let panSample = { x: 0, y: 0, t: 0, vx: 0, vy: 0 };
const GUIDES_KEY = 'wbc-manual-guides';
const RULERS_KEY = 'wbc-rulers';
let manualGuides: { axis: 'h' | 'v'; pos: number }[] = [];
try {
  const raw = JSON.parse(localStorage.getItem(GUIDES_KEY) || '[]');
  if (Array.isArray(raw)) {
    manualGuides = raw.filter(
      (item) => item && (item.axis === 'h' || item.axis === 'v') && typeof item.pos === 'number' && Number.isFinite(item.pos)
    );
  }
} catch {
  manualGuides = [];
}
let rulersVisible = localStorage.getItem(RULERS_KEY) === '1';
const touchPointers = new Map<number, Pt>();
let pinch: { distance: number; zoom: number; mid: Pt; pan: { x: number; y: number } } | null = null;
let presenting = false;
let presentTimer = 0;
let presentStart = 0;

function updatePresentInfo(): void {
  if (!presenting) return;
  const seconds = Math.floor((Date.now() - presentStart) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  presentInfo.textContent = `${state.activePage + 1} / ${state.pages.length} · ${mm}:${ss}`;
}
let presentView: { zoom: number; pan: { x: number; y: number } } | null = null;
let presentWasFullScreen = false;

type ElNode = HTMLElement | SVGSVGElement;

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; startClient: Pt; startPan: { x: number; y: number } }
  | { kind: 'move'; ids: string[]; start: Pt; before: Doc | null; dx: number; dy: number; orig: Rect; els: El[] }
  | { kind: 'resize'; ids: string[]; corner: string; before: Doc | null; orig: Rect; origins: Map<string, El>; changed: boolean }
  | { kind: 'rotate'; ids: string[]; center: Pt; startAngle: number; before: Doc | null; origins: Map<string, { center: Pt; rotation: number }>; changed: boolean }
  | { kind: 'endpoint'; id: string; which: 'p1' | 'p2'; before: Doc | null; changed: boolean }
  | { kind: 'pen'; points: Pt[]; before: Doc; preview: SVGPathElement; highlight: boolean; pressures: number[]; path: InkPathBuilder }
  | { kind: 'shape'; type: 'rect' | 'ellipse' | 'arrow' | 'line' | 'poly'; start: Pt; before: Doc | null; preview: ElNode }
  | { kind: 'marquee'; start: Pt; beforeSelection: string[]; preview: HTMLDivElement }
  | { kind: 'lasso'; points: Pt[]; beforeSelection: string[]; preview: SVGSVGElement }
  | { kind: 'erase'; before: Doc | null; deleted: boolean; object?: boolean };

let drag: DragState = { kind: 'none' };

function selectedElements(): El[] {
  const ids = new Set(state.selectedIds);
  return state.doc.elements.filter((el) => ids.has(el.id) && !el.hidden);
}

function currentDash(): Dash | undefined {
  return state.dash === 'solid' ? undefined : state.dash;
}

function currentOpacity(): number | undefined {
  return state.opacity < 1 ? state.opacity : undefined;
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
  return selectedElements().filter((el) => !el.locked && !el.hidden);
}

function setSelection(ids: string[], allowLocked = true): void {
  const alive = new Set(state.doc.elements.map((el) => el.id));
  const byId = new Map(state.doc.elements.map((el) => [el.id, el]));
  const expanded = expandGroupIds(Array.from(new Set(ids)).filter((id) => alive.has(id)));
  state.selectedIds = expanded.filter((id) => {
    const el = byId.get(id);
    return !!el && !el.hidden && (allowLocked || !el.locked);
  });
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
    state.dash = 'solid';
  } else if (el.type === 'ink') {
    state.color = el.color;
    if (!el.highlight) state.width = el.width;
    state.dash = 'solid';
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') {
    state.color = el.stroke;
    state.width = el.strokeWidth;
    state.fill = el.fill;
    state.dash = el.dash || 'solid';
  } else if (el.type === 'arrow') {
    state.color = el.stroke;
    state.width = el.strokeWidth;
    state.dash = el.dash || 'solid';
  }
  state.opacity = el.opacity ?? 1;
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
  const prev = { text: el.text, w: el.w, h: el.h };
  el.text = editor.value;
  const width = parseFloat(editor.style.width);
  if (Number.isFinite(width)) el.w = Math.max(60, width);
  el.h = Math.max(el.fontSize * 1.4, editor.scrollHeight);
  try {
    return serialize();
  } finally {
    el.text = prev.text;
    el.w = prev.w;
    el.h = prev.h;
  }
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
  if (!el || el.type !== 'text' || el.locked) return;
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
  if (blockReadOnly()) return;
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
    stickyColor: sticky ? '#fef3c7' : undefined,
    opacity: currentOpacity()
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
    highlight: d.highlight || undefined,
    opacity: currentOpacity()
  };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  commitMutation(d.before, true);
  renderAll();
  refreshPalette();
  updateStatusInfo();
}

function constrainShapeEnd(start: Pt, end: Pt, shift: boolean, type: string): Pt {
  if (!shift) return end;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (type === 'arrow' || type === 'line') {
    const length = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [start[0] + Math.cos(angle) * length, start[1] + Math.sin(angle) * length];
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return [start[0] + (dx < 0 ? -size : size), start[1] + (dy < 0 ? -size : size)];
}

function commitShape(d: Extract<DragState, { kind: 'shape' }>, rawEnd: Pt, shift = false): void {
  d.preview.remove();
  const end = constrainShapeEnd(d.start, rawEnd, shift, d.type);
  if (d.type === 'poly') {
    const w = Math.abs(end[0] - d.start[0]);
    const h = Math.abs(end[1] - d.start[1]);
    if (w < 4 || h < 4) return;
    const before = d.before || beginMutation();
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
      fill: state.fill,
      dash: currentDash(),
      opacity: currentOpacity()
    };
    state.doc.elements.push(el);
    state.selectedIds = [el.id];
    commitMutation(before, true, '绘制' + describePoly(polyKind));
    renderAll();
    refreshPalette();
    updateStatusInfo();
    return;
  }
  if (d.type === 'arrow' || d.type === 'line') {
    if (Math.hypot(end[0] - d.start[0], end[1] - d.start[1]) < 4) return;
    const before = d.before || beginMutation();
    const el: ArrowEl = {
      id: uid(),
      type: 'arrow',
      x1: d.start[0],
      y1: d.start[1],
      x2: end[0],
      y2: end[1],
      stroke: state.color,
      strokeWidth: state.width,
      head: d.type === 'arrow',
      dash: currentDash(),
      opacity: currentOpacity()
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
    commitMutation(before, true);
    renderAll();
    refreshPalette();
    updateStatusInfo();
    return;
  }
  const w = Math.abs(end[0] - d.start[0]);
  const h = Math.abs(end[1] - d.start[1]);
  if (w < 4 || h < 4) return;
  const before = d.before || beginMutation();
  const x = Math.min(d.start[0], end[0]);
  const y = Math.min(d.start[1], end[1]);
  const el: RectEl | EllipseEl =
    d.type === 'rect'
      ? { id: uid(), type: 'rect', x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill, dash: currentDash(), opacity: currentOpacity() }
      : { id: uid(), type: 'ellipse', x, y, w, h, stroke: state.color, strokeWidth: state.width, fill: state.fill, dash: currentDash(), opacity: currentOpacity() };
  state.doc.elements.push(el);
  state.selectedIds = [el.id];
  commitMutation(before, true);
  renderAll();
  refreshPalette();
  updateStatusInfo();
}

function describePoly(kind: PolyKind): string {
  return {
    triangle: '三角形',
    diamond: '菱形',
    star: '五角星',
    roundrect: '圆角矩形',
    hexagon: '六边形',
    cylinder: '圆柱',
    cloud: '云',
    lane: '泳道'
  }[kind];
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
    // 低配模式：混合模式在软件光栅化下开销大
    if (!state.settings.lowSpec) svg.style.mixBlendMode = 'multiply';
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  const builder = new InkPathBuilder([at]);
  path.setAttribute('d', builder.value);
  svg.appendChild(path);
  world.appendChild(svg);
  return { kind: 'pen', points: [at], before: beginMutation(), preview: path, highlight, pressures: [], path: builder };
}

function startShape(type: 'rect' | 'ellipse' | 'arrow' | 'line' | 'poly', at: Pt): DragState {
  let preview: ElNode;
  if (type === 'poly') {
    const svg = createPreviewSvg(state.color, state.width);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', state.fill || 'none');
    path.setAttribute('stroke', state.color);
    path.setAttribute('stroke-width', String(state.width));
    path.setAttribute('stroke-linecap', 'round');
    const dash = dashArray(state.dash, state.width);
    if (dash) path.setAttribute('stroke-dasharray', dash.join(' '));
    svg.appendChild(path);
    preview = svg;
  } else if (type === 'arrow' || type === 'line') {
    const svg = createPreviewSvg(state.color, state.width);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('stroke', state.color);
    path.setAttribute('stroke-width', String(state.width));
    path.setAttribute('stroke-linecap', 'round');
    const dash = dashArray(state.dash, state.width);
    if (dash) path.setAttribute('stroke-dasharray', dash.join(' '));
    svg.appendChild(path);
    preview = svg;
  } else {
    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.boxSizing = 'border-box';
    div.style.border = state.width + 'px solid ' + state.color;
    div.style.borderStyle = state.dash === 'dash' ? 'dashed' : state.dash === 'dot' ? 'dotted' : 'solid';
    div.style.background = state.fill || 'transparent';
    div.style.opacity = String(state.opacity);
    div.style.pointerEvents = 'none';
    if (type === 'ellipse') div.style.borderRadius = '50%';
    preview = div;
  }
  world.appendChild(preview);
  return { kind: 'shape', type, start: at, before: null, preview };
}

function updateShapePreview(d: Extract<DragState, { kind: 'shape' }>, rawEnd: Pt, shift = false): void {
  const end = constrainShapeEnd(d.start, rawEnd, shift, d.type);
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
  const grid = state.settings.gridSize || 24;
  return [Math.round(p[0] / grid) * grid, Math.round(p[1] / grid) * grid];
}

function clearGuides(): void {
  guidesEl.replaceChildren();
}

function saveManualGuides(): void {
  try {
    localStorage.setItem(GUIDES_KEY, JSON.stringify(manualGuides));
  } catch {
    /* 存储不可用 */
  }
}

let guideEls = new Map<{ axis: 'h' | 'v'; pos: number }, HTMLDivElement>();

function renderManualGuides(): void {
  if (!manualGuides.length) {
    if (!manualGuidesEl.hidden || manualGuidesEl.childElementCount) {
      manualGuidesEl.hidden = true;
      manualGuidesEl.replaceChildren();
      guideEls.clear();
    }
    return;
  }
  manualGuidesEl.hidden = false;
  for (const [guide, line] of guideEls) {
    if (!manualGuides.includes(guide)) {
      line.remove();
      guideEls.delete(guide);
    }
  }
  for (const guide of manualGuides) {
    let line = guideEls.get(guide);
    if (!line) {
      line = document.createElement('div');
      line.className = 'manual-guide ' + guide.axis;
      line.title = '拖动移动，双击删除';
      line.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        startGuideDrag(guide, e);
      });
      line.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        manualGuides = manualGuides.filter((item) => item !== guide);
        saveManualGuides();
        renderManualGuides();
      });
      guideEls.set(guide, line);
      manualGuidesEl.appendChild(line);
    }
    const screen = guide.axis === 'v' ? view.pan.x + guide.pos * view.zoom : view.pan.y + guide.pos * view.zoom;
    if (guide.axis === 'v') line.style.left = screen + 'px';
    else line.style.top = screen + 'px';
  }
}

function startGuideDrag(guide: { axis: 'h' | 'v'; pos: number }, e: PointerEvent): void {
  e.preventDefault();
  const move = (ev: PointerEvent) => {
    const p = screenToWorld(ev.clientX, ev.clientY);
    guide.pos = guide.axis === 'v' ? p[0] : p[1];
    renderManualGuides();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    saveManualGuides();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

let rulerRaf = 0;

/** 标尺重绘按帧合并：一帧内多次平移只画一次，弱机显著减负 */
function drawRulers(): void {
  if (!rulersVisible || rulerRaf) return;
  rulerRaf = requestAnimationFrame(() => {
    rulerRaf = 0;
    paintRulers();
  });
}

function paintRulers(): void {
  if (!rulersVisible || state.settings.lowSpec) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const grid = state.settings.gridSize || 24;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (rulerHCanvas.width !== Math.round(width * dpr)) rulerHCanvas.width = Math.round(width * dpr);
  if (rulerVCanvas.height !== Math.round(height * dpr)) rulerVCanvas.height = Math.round(height * dpr);
  const hctx = rulerHCanvas.getContext('2d');
  const vctx = rulerVCanvas.getContext('2d');
  if (!hctx || !vctx) return;
  for (const ctx of [hctx, vctx]) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#94a3b8';
    ctx.fillStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.font = '9px "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'top';
  }
  const startX = Math.ceil((-view.pan.x / view.zoom) / grid) * grid;
  for (let x = startX; ; x += grid) {
    const sx = view.pan.x + x * view.zoom;
    if (sx > width) break;
    if (sx < 0) continue;
    const major = Math.abs(x % (grid * 5)) < 0.001;
    hctx.beginPath();
    hctx.moveTo(sx, 18);
    hctx.lineTo(sx, major ? 7 : 12);
    hctx.stroke();
    if (major) hctx.fillText(String(Math.round(x)), sx + 2, 1);
  }
  const startY = Math.ceil((-view.pan.y / view.zoom) / grid) * grid;
  for (let y = startY; ; y += grid) {
    const sy = view.pan.y + y * view.zoom;
    if (sy > height) break;
    if (sy < 0) continue;
    const major = Math.abs(y % (grid * 5)) < 0.001;
    vctx.beginPath();
    vctx.moveTo(18, sy);
    vctx.lineTo(major ? 7 : 12, sy);
    vctx.stroke();
    if (major) {
      vctx.save();
      vctx.translate(1, sy + 2);
      vctx.rotate(-Math.PI / 2);
      vctx.fillText(String(Math.round(y)), 0, 0);
      vctx.restore();
    }
  }
}

function setRulersVisible(on: boolean): void {
  rulersVisible = on;
  const shown = on && !state.settings.lowSpec;
  rulerH.hidden = !shown;
  rulerV.hidden = !shown;
  rulerBtn.classList.toggle('active', shown);
  rulerBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
  if (shown) paintRulers();
  try {
    localStorage.setItem(RULERS_KEY, on ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}

/** 低配模式：隐藏小地图与标尺等持续重绘元素，降低老机器的 CPU 占用 */
function applyLowSpec(): void {
  const low = state.settings.lowSpec;
  document.body.classList.toggle('low-spec', low);
  setMinimapHidden(low);
  rulerH.hidden = low || !rulersVisible;
  rulerV.hidden = low || !rulersVisible;
  // 重新渲染：便签阴影/荧光笔混合模式等效果随模式变化
  renderAll();
  if (!low) {
    requestMinimap();
    if (rulersVisible) paintRulers();
  }
}

function installRulers(): void {
  setRulersVisible(rulersVisible);
  rulerBtn.addEventListener('click', () => setRulersVisible(!rulersVisible));
  rulerH.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const p = screenToWorld(e.clientX, e.clientY);
    const guide = { axis: 'h' as const, pos: p[1] };
    manualGuides.push(guide);
    renderManualGuides();
    startGuideDrag(guide, e);
  });
  rulerV.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const p = screenToWorld(e.clientX, e.clientY);
    const guide = { axis: 'v' as const, pos: p[0] };
    manualGuides.push(guide);
    renderManualGuides();
    startGuideDrag(guide, e);
  });
  renderManualGuides();
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

let snapCache: { key: string; xs: number[]; ys: number[] } | null = null;

function snapTargets(ids: Set<string>): { xs: number[]; ys: number[] } {
  const key = state.pages[state.activePage]?.id + ':' + state.revision + ':' + Array.from(ids).sort().join(',');
  if (snapCache && snapCache.key === key) return snapCache;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const el of state.doc.elements) {
    if (ids.has(el.id) || el.hidden) continue;
    const b = bounds(el);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  snapCache = { key, xs, ys };
  return snapCache;
}

function snapMove(orig: Rect, rawDx: number, rawDy: number, alt: boolean, ids: Set<string>): SnapMove {
  if (alt) return { dx: rawDx, dy: rawDy, guidesX: [], guidesY: [] };
  const tol = SNAP_PX / view.zoom;
  const grid = state.settings.gridSize || 24;
  const rect = { x: orig.x + rawDx, y: orig.y + rawDy, w: orig.w, h: orig.h };
  const targets = snapTargets(ids);
  const xs = targets.xs.concat(manualGuides.filter((guide) => guide.axis === 'v').map((guide) => guide.pos));
  const ys = targets.ys.concat(manualGuides.filter((guide) => guide.axis === 'h').map((guide) => guide.pos));
  const edgesX = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const edgesY = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  let bestX: { delta: number; guide: number | null } | null = null;
  let bestY: { delta: number; guide: number | null } | null = null;
  for (const edge of edgesX) {
    const gridDelta = Math.round(edge / grid) * grid - edge;
    if (Math.abs(gridDelta) <= tol && (!bestX || Math.abs(gridDelta) < Math.abs(bestX.delta))) bestX = { delta: gridDelta, guide: null };
    for (const target of xs) {
      const delta = target - edge;
      if (Math.abs(delta) <= tol && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, guide: target };
    }
  }
  for (const edge of edgesY) {
    const gridDelta = Math.round(edge / grid) * grid - edge;
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

function resizeElement(el: El, corner: string, orig: Rect, p: Pt, keepAspect = false): boolean {
  if (el.type === 'text') {
    if (corner === 'w') {
      const right = el.x + el.w;
      const x = Math.min(right - 60, p[0]);
      if (Math.abs(x - el.x) < 0.5) return false;
      el.x = x;
      el.w = right - x;
      return true;
    }
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
  if (el.type === 'image' || keepAspect) {
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

function scaleSelection(d: Extract<DragState, { kind: 'resize' }>, p: Pt, keepAspect = false): boolean {
  const next = resizedRect(d.orig, d.corner, p);
  if (keepAspect) {
    const ratio = d.orig.w / Math.max(d.orig.h, 0.001);
    if (next.w / Math.max(next.h, 0.001) > ratio) next.h = next.w / ratio;
    else next.w = next.h * ratio;
    if (d.corner === 'nw' || d.corner === 'sw') next.x = d.orig.x + d.orig.w - next.w;
    if (d.corner === 'nw' || d.corner === 'ne') next.y = d.orig.y + d.orig.h - next.h;
  }
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
    } else if (o.type === 'poly' && el.type === 'poly') {
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

function eraseObjectAt(p: Pt): boolean {
  const hit = hitTest(state.doc.elements, p, 6 / view.zoom, { ignoreHidden: true, ignoreLocked: true });
  if (!hit) return false;
  if (drag.kind === 'erase') {
    if (!drag.before) drag.before = beginMutation();
    drag.deleted = true;
  } else {
    const before = beginMutation();
    removeElement(hit.id);
    commitMutation(before, true, '对象橡皮');
    renderAll();
    refreshPalette();
    updateStatusInfo();
    return true;
  }
  removeElement(hit.id);
  renderAll();
  refreshPalette();
  updateStatusInfo();
  return true;
}

function deleteSelected(): void {
  if (blockReadOnly() || !state.selectedIds.length) return;
  const removable = selectedElements().filter((el) => !el.locked && !el.hidden).map((el) => el.id);
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
  if (blockReadOnly()) return;
  commitEdit();
  const sources = selectedElements().filter((el) => !el.locked && !el.hidden);
  if (!sources.length) return;
  const before = beginMutation();
  const clones = cloneWithFreshIds(sources, 16);
  state.doc.elements.push(...clones);
  setSelection(clones.map((clone) => clone.id));
  commitMutation(before, true, '再制');
  renderAll();
  setStatus(`已复制'${clones.length} 项`);
}

function nudgeSelected(dx: number, dy: number): void {
  if (blockReadOnly() || !state.selectedIds.length) return;
  commitEdit();
  const targets = editableSelection();
  if (!targets.length) return;
  const before = beginMutation();
  for (const el of targets) {
    moveEl(el, dx, dy);
    updateElNode(el);
  }
  commitMutation(before, true);
  updateSelectionBox();
  updateStatusInfo();
}

function reorderSelection(toFront: boolean): void {
  if (blockReadOnly()) return;
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
  setStatus(toFront ? '已置顶' : '已置顶');
}

function buildElementClipboard(elements: El[] = selectedElements()): string {
  return JSON.stringify({ app: 'whiteboard-canvas-elements', version: 1, clipId: uid(), elements });
}

function copySelected(cut: boolean): void {
  if (cut && blockReadOnly()) return;
  commitEdit();
  const sources = selectedElements();
  if (!sources.length) return;
  const removable = sources.filter((el) => !el.locked && !el.hidden);
  if (cut && !removable.length) {
    setStatus('锁定元素不可剪切');
    return;
  }
  window.api.writeClipboardElements(buildElementClipboard(cut ? removable : sources));
  if (cut) {
    const before = beginMutation();
    for (const el of removable) removeElement(el.id);
    commitMutation(before, true);
    renderAll();
    refreshPalette();
  }
  updateStatusInfo();
  setStatus((cut ? '已剪切' : '已复制') + (cut ? removable.length : sources.length) + ' 项');
}

function undoAction(): boolean {
  if (state.readOnly) return false;
  commitEdit();
  if (undoHistory()) {
    pruneSelection();
    syncPaletteFromSelection();
    refreshPalette();
    renderAll();
    updateStatusInfo();
    setStatus('');
    return true;
  }
  if (undoPage()) {
    afterPageChange();
    refreshPalette();
    setStatus('已恢复页面');
    return true;
  }
  return false;
}

function redoAction(): boolean {
  if (state.readOnly) return false;
  commitEdit();
  if (redoHistory()) {
    pruneSelection();
    syncPaletteFromSelection();
    refreshPalette();
    renderAll();
    updateStatusInfo();
    setStatus('');
    return true;
  }
  if (redoPage()) {
    afterPageChange();
    refreshPalette();
    setStatus('已重新删除页面');
    return true;
  }
  return false;
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

function blockReadOnly(): boolean {
  if (!state.readOnly) return false;
  setStatus('只读模式，无法编辑');
  return true;
}

function setReadOnly(on: boolean): void {
  if (state.readOnly === on) return;
  if (on) {
    commitEdit();
    state.readOnly = true;
    setTool('select');
    setSelection([]);
  } else {
    state.readOnly = false;
  }
  document.body.classList.toggle('readonly', on);
  updateTitle();
  refreshPalette();
  updateStatusInfo();
  setStatus(on ? '已进入只读模式' : '已退出只读模式');
}

function setTool(tool: Tool): void {
  if (state.readOnly && tool !== 'select') return;
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
  if (state.readOnly) {
    palette.hidden = true;
    return;
  }
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
  const showDash =
    tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'line' || tool === 'poly' ||
    (tool === 'select' && types.some((t) => t === 'rect' || t === 'ellipse' || t === 'arrow' || t === 'poly'));
  const showOpacity = isStrokeTool || tool === 'text' || tool === 'sticky' || (tool === 'select' && types.length > 0);
  palette.hidden = !showColors && !showFill && !showStyle && !showOpacity;
  colorRow.hidden = !showColors;
  widthRow.hidden = !showWidths;
  dashRow.hidden = !showDash;
  eraserRow.hidden = tool !== 'eraser';
  opacityRow.hidden = !showOpacity;
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
      (row === 'dash' && value === state.dash) ||
      (row === 'size' && Number(value) === state.fontSize) ||
      (row === 'fill' && value === state.fill) ||
      (row === 'recent' && value === state.color);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (recentRow) recentRow.hidden = !showColors || recentColors.length === 0;
  const customColor = document.getElementById('custom-color') as HTMLInputElement | null;
  if (customColor) customColor.value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#1f2937';
  const customWidth = document.getElementById('custom-width') as HTMLInputElement | null;
  if (customWidth) customWidth.value = String(state.width);
  const customSize = document.getElementById('custom-size') as HTMLInputElement | null;
  if (customSize) customSize.value = String(state.fontSize);
  for (const btn of Array.from(eraserRow.querySelectorAll<HTMLButtonElement>('button[data-eraser-mode]'))) {
    const active = btn.dataset.eraserMode === state.eraserMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const opacityInput = document.getElementById('opacity-range') as HTMLInputElement | null;
  const opacityValue = document.getElementById('opacity-value') as HTMLSpanElement | null;
  if (opacityInput) opacityInput.value = String(Math.round(state.opacity * 100));
  if (opacityValue) opacityValue.textContent = Math.round(state.opacity * 100) + '%';
  const text = firstText();
  for (const btn of Array.from(styleRow.querySelectorAll<HTMLButtonElement>('button[data-style]'))) {
    const key = btn.dataset.style as 'bold' | 'italic' | 'underline' | 'strike' | 'bullets' | 'numbered';
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

function rememberColor(color: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  recentColors = [color, ...recentColors.filter((value) => value.toLowerCase() !== color.toLowerCase())].slice(0, 8);
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recentColors));
  } catch {
    /* 存储不可用时仅保留本次会话 */
  }
  renderRecentColors();
}

function renderRecentColors(): void {
  if (!recentRow) return;
  recentRow.replaceChildren();
  for (const color of recentColors) {
    const btn = document.createElement('button');
    btn.className = 'swatch recent';
    btn.dataset.value = color;
    btn.style.background = color;
    btn.title = color;
    btn.setAttribute('aria-label', '最近颜色' + color);
    btn.addEventListener('click', () => applyColor(color));
    recentRow.appendChild(btn);
  }
  recentRow.hidden = recentColors.length === 0;
}

function applyColor(color: string): void {
  if (blockReadOnly()) return;
  state.color = color;
  rememberColor(color);
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
      if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = snapshotDoc();
    }
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function applyWidth(width: number): void {
  if (blockReadOnly()) return;
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

function applyDash(dash: Dash): void {
  if (blockReadOnly()) return;
  state.dash = dash;
  const targets = selectedElements().filter(
    (el): el is RectEl | EllipseEl | PolyEl | ArrowEl =>
      el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly' || el.type === 'arrow'
  );
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.locked) continue;
    const next = dash === 'solid' ? undefined : dash;
    if ((el.dash || 'solid') !== dash) {
      el.dash = next;
      changed = true;
    }
  }
  if (changed) {
    commitMutation(before, true, '线型');
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function applyOpacity(percent: number): void {
  if (blockReadOnly()) return;
  const value = Math.min(100, Math.max(10, Math.round(percent))) / 100;
  state.opacity = value;
  const targets = selectedElements();
  const before = beginMutation();
  let changed = false;
  for (const el of targets) {
    if (el.locked) continue;
    const next = value < 1 ? value : undefined;
    if ((el.opacity ?? 1) !== (next ?? 1)) {
      el.opacity = next;
      changed = true;
    }
  }
  if (changed) {
    commitMutation(before, true, '透明度');
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function applyFontSize(size: number): void {
  if (blockReadOnly()) return;
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
      if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = snapshotDoc();
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
  if (blockReadOnly()) return;
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
    if (editBefore && editBefore.elements.some((el) => el.id === editingId)) editBefore = snapshotDoc();
    renderAll();
    updateStatusInfo();
  }
  refreshPalette();
}

function firstText(): TextEl | null {
  return selectedElements().find((el): el is TextEl => el.type === 'text') || null;
}

function applyFill(fill: string): void {
  if (blockReadOnly()) return;
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
    btn.setAttribute('aria-label', '颜色 ' + color);
    btn.style.background = color;
    btn.addEventListener('click', () => applyColor(color));
    colorRow.appendChild(btn);
  }
  const customColor = document.createElement('input');
  customColor.id = 'custom-color';
  customColor.type = 'color';
  customColor.value = state.color;
  customColor.title = '自定义颜色';
  customColor.setAttribute('aria-label', '自定义颜色');
  customColor.addEventListener('change', () => applyColor(customColor.value));
  colorRow.appendChild(customColor);
  recentRow = document.createElement('div');
  recentRow.className = 'row recent-row';
  recentRow.dataset.row = 'recent';
  colorRow.parentElement?.insertBefore(recentRow, colorRow.nextSibling);
  renderRecentColors();
  for (const width of WIDTHS) {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.dataset.value = String(width);
    btn.textContent = String(width);
    btn.setAttribute('aria-label', '线宽 ' + width);
    btn.addEventListener('click', () => applyWidth(width));
    widthRow.appendChild(btn);
  }
  const customWidth = document.createElement('input');
  customWidth.id = 'custom-width';
  customWidth.type = 'number';
  customWidth.min = '1';
  customWidth.max = '100';
  customWidth.value = String(state.width);
  customWidth.title = '自定义线宽';
  customWidth.setAttribute('aria-label', '自定义线宽');
  customWidth.addEventListener('change', () => {
    const value = Math.max(1, Math.min(100, Math.round(Number(customWidth.value) || state.width)));
    customWidth.value = String(value);
    applyWidth(value);
  });
  widthRow.appendChild(customWidth);
  eraserRow = palette.querySelector('[data-row="eraser-mode"]') as HTMLDivElement;
  for (const mode of ['ink', 'object'] as const) {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.dataset.eraserMode = mode;
    btn.textContent = mode === 'ink' ? '笔迹' : '对象';
    btn.title = mode === 'ink' ? '分段擦除笔迹' : '删除整个元素';
    btn.addEventListener('click', () => {
      state.eraserMode = mode;
      refreshPalette();
      setStatus(mode === 'object' ? '橡皮：删除整个对象' : '橡皮：分段擦除笔迹');
    });
    eraserRow.appendChild(btn);
  }
  dashRow = palette.querySelector('[data-row="dash"]') as HTMLDivElement;
  const dashOptions: { value: Dash; label: string; title: string }[] = [
    { value: 'solid', label: '实', title: '实线' },
    { value: 'dash', label: '虚', title: '虚线' },
    { value: 'dot', label: '·', title: '点线' }
  ];
  for (const item of dashOptions) {
    const btn = document.createElement('button');
    btn.className = 'opt dash-btn';
    btn.dataset.value = item.value;
    btn.textContent = item.label;
    btn.title = item.title;
    btn.setAttribute('aria-label', item.title);
    btn.addEventListener('click', () => applyDash(item.value));
    dashRow.appendChild(btn);
  }
  opacityRow = palette.querySelector('[data-row="opacity"]') as HTMLDivElement;
  const opacityLabel = document.createElement('span');
  opacityLabel.textContent = '透明度';
  const opacityInput = document.createElement('input');
  opacityInput.id = 'opacity-range';
  opacityInput.type = 'range';
  opacityInput.setAttribute('aria-label', '透明度');
  opacityInput.min = '10';
  opacityInput.max = '100';
  opacityInput.step = '5';
  opacityInput.value = String(Math.round(state.opacity * 100));
  const opacityValue = document.createElement('span');
  opacityValue.id = 'opacity-value';
  opacityValue.textContent = Math.round(state.opacity * 100) + '%';
  opacityInput.addEventListener('input', () => {
    opacityValue.textContent = opacityInput.value + '%';
  });
  opacityInput.addEventListener('change', () => applyOpacity(Number(opacityInput.value)));
  opacityRow.append(opacityLabel, opacityInput, opacityValue);
  for (const size of SIZES) {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.dataset.value = String(size);
    btn.textContent = String(size);
    btn.setAttribute('aria-label', '字号 ' + size);
    btn.addEventListener('click', () => applyFontSize(size));
    sizeRow.appendChild(btn);
  }
  const customSize = document.createElement('input');
  customSize.id = 'custom-size';
  customSize.type = 'number';
  customSize.min = '4';
  customSize.max = '512';
  customSize.value = String(state.fontSize);
  customSize.title = '自定义字号';
  customSize.setAttribute('aria-label', '自定义字号');
  customSize.addEventListener('change', () => {
    const value = Math.max(4, Math.min(512, Math.round(Number(customSize.value) || state.fontSize)));
    customSize.value = String(value);
    applyFontSize(value);
  });
  sizeRow.appendChild(customSize);
  for (const fill of FILLS) {
    const btn = document.createElement('button');
    btn.className = 'swatch fill';
    btn.dataset.value = fill;
    btn.title = fill || '无填充';
    btn.setAttribute('aria-label', fill ? '填充 ' + fill : '无填充');
    if (fill) btn.style.background = fill;
    else btn.textContent = '无';
    btn.addEventListener('click', () => applyFill(fill));
    fillRow.appendChild(btn);
  }
  const toggles: { key: 'bold' | 'italic' | 'underline' | 'strike' | 'bullets' | 'numbered'; label: string; title: string }[] = [
    { key: 'bold', label: 'B', title: '粗体' },
    { key: 'italic', label: 'I', title: '斜体' },
    { key: 'underline', label: 'U', title: '下划线' },
    { key: 'strike', label: 'S', title: '删除线' },
    { key: 'bullets', label: '•', title: '项目符号' },
    { key: 'numbered', label: '1.', title: '数字编号' }
  ];
  for (const item of toggles) {
    const btn = document.createElement('button');
    btn.className = 'opt style-btn';
    btn.dataset.style = item.key;
    btn.textContent = item.label;
    btn.title = item.title;
    btn.setAttribute('aria-label', item.title);
    btn.addEventListener('click', () => {
      const el = firstText();
      const next = el ? !el[item.key] : true;
      if (item.key === 'numbered' && next) applyTextStyle({ numbered: true, bullets: undefined });
      else if (item.key === 'bullets' && next) applyTextStyle({ bullets: true, numbered: undefined });
      else applyTextStyle({ [item.key]: next } as Partial<TextEl>);
    });
    styleRow.appendChild(btn);
  }
  for (const align of ['left', 'center', 'right'] as const) {
    const btn = document.createElement('button');
    btn.className = 'opt style-btn';
    btn.dataset.align = align;
    btn.textContent = align === 'left' ? '左' : align === 'center' ? '中' : '右';
    btn.title = align === 'left' ? '左对齐' : align === 'center' ? '居中' : '右对齐';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', () => applyTextStyle({ align }));
    styleRow.appendChild(btn);
  }
  const fontSelect = document.createElement('select');
  fontSelect.id = 'font-family';
  fontSelect.setAttribute('aria-label', '字体');
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
  lineInput.setAttribute('aria-label', '行高');
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
  return { id: el.id, point: nearestPointOnRotatedRect(el, p) };
}

function captureStyle(el: El): StyleSnapshot {
  const snap: StyleSnapshot = {
    color: state.color,
    stroke: state.color,
    fill: '',
    width: state.width,
    dash: 'solid',
    opacity: el.opacity ?? 1,
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
    snap.numbered = el.numbered;
    snap.align = el.align;
    snap.stickyColor = el.stickyColor;
  } else if (el.type === 'ink') {
    snap.color = el.color;
    snap.width = el.width;
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') {
    snap.stroke = el.stroke;
    snap.fill = el.fill;
    snap.width = el.strokeWidth;
    snap.dash = el.dash || 'solid';
  } else if (el.type === 'arrow') {
    snap.stroke = el.stroke;
    snap.width = el.strokeWidth;
    snap.dash = el.dash || 'solid';
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
  if (state.readOnly || !formatBrush || el.locked) return;
  const before = beginMutation();
  const style = formatBrush;
  el.opacity = style.opacity < 1 ? style.opacity : undefined;
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
    el.numbered = style.numbered;
    el.align = style.align;
    if (el.sticky) el.stickyColor = style.stickyColor || el.stickyColor;
  } else if (el.type === 'ink') {
    el.color = style.color;
    if (!el.highlight) el.width = style.width;
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') {
    el.stroke = style.stroke;
    el.fill = style.fill;
    el.strokeWidth = style.width;
    el.dash = style.dash === 'solid' ? undefined : style.dash;
  } else if (el.type === 'arrow') {
    el.stroke = style.stroke;
    el.strokeWidth = style.width;
    el.dash = style.dash === 'solid' ? undefined : style.dash;
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
    { key: 'quality', label: '质量（0.1-1）', type: 'number', value: 0.8, min: 0.1, max: 1, step: 0.05 }
  ]);
  if (!result) return;
  await compressImage(id, String(result.format), Math.min(1, Math.max(0.1, Number(result.quality) || 0.8)));
}

async function editTextLink(id: string): Promise<void> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || el.type !== 'text') return;
  if (blockReadOnly()) return;
  const value = await openPrompt('文字链接（http/https）', el.link || '');
  if (value === null) return;
  const before = beginMutation();
  el.link = /^https?:\/\//i.test(value.trim()) ? value.trim().slice(0, 2000) : undefined;
  commitMutation(before, true, '文字链接');
  renderAll();
}

async function editShapeLabel(id: string): Promise<void> {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el || (el.type !== 'rect' && el.type !== 'ellipse' && el.type !== 'poly')) return;
  if (blockReadOnly()) return;
  setSelection([id]);
  const value = await openPrompt('形状文字', el.label || '');
  if (value === null) return;
  const before = beginMutation();
  el.label = value.trim() ? value.slice(0, 2000) : undefined;
  commitMutation(before, true, '形状文字');
  renderAll();
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
  if (presenting) {
    e.preventDefault();
    if (e.button === 0) presentPage(1);
    return;
  }
  // 输入控件（文本编辑器、搜索框等）内的指针事件交给控件本身
  if (isEditableTarget(e.target)) return;
  if (e.pointerType === 'touch' && Date.now() - lastPenAt < 700) return;
  if (e.pointerType === 'touch') {
    touchPointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (touchPointers.size === 2) {
      const points = Array.from(touchPointers.values());
      const mid: Pt = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
      pinch = {
        distance: Math.max(10, Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])),
        zoom: view.zoom,
        mid,
        pan: { x: view.pan.x, y: view.pan.y }
      };
      if (drag.kind === 'pen') drag.preview.parentElement?.remove();
      if (drag.kind === 'marquee' || drag.kind === 'lasso' || drag.kind === 'shape') drag.preview.remove();
      drag = { kind: 'none' };
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件 */
      }
      e.preventDefault();
      return;
    }
  }
  const target = e.target as HTMLElement;
  if (e.button === 0 && target.classList.contains('handle')) return;
  commitEdit();
  const p = screenToWorld(e.clientX, e.clientY);

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

  if (state.readOnly) {
    const hit = canvasHit(p);
    setSelection(hit ? [hit.id] : []);
    drag = { kind: 'none' };
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
      if (e.ctrlKey && hit.type === 'text' && hit.link) {
        void window.api.openExternal(hit.link);
        drag = { kind: 'none' };
        return;
      }
      if (!state.selectedIds.includes(hit.id)) setSelection([hit.id]);
      const selected = editableSelection();
      const orig = boundsUnion(selected);
      if (orig && selected.length)
        drag = { kind: 'move', ids: selected.map((el) => el.id), start: p, before: null, dx: 0, dy: 0, orig, els: selected };
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
    drag = { kind: 'erase', before: null, deleted: false, object: state.eraserMode === 'object' };
    if (state.eraserMode === 'object') eraseObjectAt(p);
    else eraseAt(p);
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
  if (presenting) {
    presentLaser.hidden = false;
    presentLaser.style.left = e.clientX + 'px';
    presentLaser.style.top = e.clientY + 'px';
    return;
  }
  updateEraserRing(e.clientX, e.clientY, state.tool === 'eraser' && drag.kind !== 'pan');
  if (e.pointerType === 'touch' && touchPointers.has(e.pointerId)) {
    touchPointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touchPointers.size >= 2) {
      const points = Array.from(touchPointers.values()).slice(0, 2);
      const mid: Pt = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
      const distance = Math.max(10, Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]));
      const r = viewport.getBoundingClientRect();
      const worldX = (pinch.mid[0] - r.left - pinch.pan.x) / pinch.zoom;
      const worldY = (pinch.mid[1] - r.top - pinch.pan.y) / pinch.zoom;
      const nextZoom = Math.min(4, Math.max(0.1, pinch.zoom * (distance / pinch.distance)));
      view.zoom = nextZoom;
      view.pan.x = mid[0] - r.left - worldX * nextZoom;
      view.pan.y = mid[1] - r.top - worldY * nextZoom;
      applyTransform();
      e.preventDefault();
      return;
    }
  }
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
    if (!d.before) d.before = beginMutation();
    const ids = new Set(d.ids);
    // 直接用拖拽开始时缓存的元素引用，避免每帧遍历全部元素（弱机上拖拽更跟手）
    for (const el of d.els) moveEl(el, stepX, stepY);
    updateElNodes(d.els);
    refreshConnectors(ids);
    d.dx = snapped.dx;
    d.dy = snapped.dy;
    renderGuides(snapped.guidesX, snapped.guidesY);
    updateSelectionBox();
    return;
  }
  if (d.kind === 'resize') {
    const snapped = snapPoint(p, e.altKey);
    if (!d.before) d.before = beginMutation();
    const changed = d.ids.length === 1 ? false : scaleSelection(d, snapped, e.shiftKey);
    if (d.ids.length === 1) {
      const el = state.doc.elements.find((item) => item.id === d.ids[0]);
      const target = el && el.rotation ? rotatePoint(snapped, centerOf(el), -el.rotation) : snapped;
      if (el && resizeElement(el, d.corner, d.orig, target, e.shiftKey)) {
        d.changed = true;
        updateElNode(el);
      }
    } else if (changed) {
      d.changed = true;
    }
    refreshConnectors(new Set(d.ids));
    if (d.changed) updateSelectionBox();
    return;
  }
  if (d.kind === 'rotate') {
    const angle = (Math.atan2(p[1] - d.center[1], p[0] - d.center[0]) * 180) / Math.PI;
    let delta = angle - d.startAngle;
    if (e.shiftKey) delta = Math.round(delta / 15) * 15;
    if (!d.before) d.before = beginMutation();
    const rotated: El[] = [];
    for (const [id, origin] of d.origins) {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el) continue;
      const next = rotatePoint(origin.center, d.center, delta);
      moveEl(el, next[0] - origin.center[0], next[1] - origin.center[1]);
      el.rotation = Math.round((origin.rotation + delta) * 100) / 100 || undefined;
      rotated.push(el);
    }
    updateElNodes(rotated);
    refreshConnectors(new Set(d.ids));
    d.changed = true;
    updateSelectionBox();
    return;
  }
  if (d.kind === 'endpoint') {
    const el = state.doc.elements.find((item) => item.id === d.id);
    if (!el || el.type !== 'arrow') return;
    const snapped = snapPoint(p, e.altKey);
    const target = el.rotation ? rotatePoint(snapped, centerOf(el), -el.rotation) : snapped;
    if (!d.before) d.before = beginMutation();
    if (d.which === 'p1') {
      el.x1 = target[0];
      el.y1 = target[1];
    } else {
      el.x2 = target[0];
      el.y2 = target[1];
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
      d.preview.setAttribute('d', d.path.push(p));
    }
    return;
  }
  if (d.kind === 'shape') {
    updateShapePreview(d, p, e.shiftKey);
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
    if (d.object) eraseObjectAt(p);
    else eraseAt(p);
  }
}

function finishDrag(e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    touchPointers.delete(e.pointerId);
    if (pinch) {
      if (touchPointers.size < 2) pinch = null;
      drag = { kind: 'none' };
      applyCursor();
      return;
    }
  }
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
    setSelection(d.beforeSelection.concat(hits), false);
  } else if (d.kind === 'pen') {
    commitPen(d);
  } else if (d.kind === 'shape') {
    commitShape(d, screenToWorld(e.clientX, e.clientY), e.shiftKey);
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
      setSelection(d.beforeSelection, false);
    } else {
      const hits = autoSelectableElements(state.doc.elements)
        .filter((el) => rectsIntersect(visualBounds(el), r))
        .map((el) => el.id);
      setSelection(d.beforeSelection.concat(hits), false);
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
  if (presenting || state.readOnly) return;
  if (isEditableTarget(e.target)) return;
  if (state.tool !== 'select') return;
  const p = screenToWorld(e.clientX, e.clientY);
  const hit = canvasHit(p);
  if (hit && hit.type === 'text') {
    setSelection([hit.id]);
    beginEdit(hit.id, null);
    return;
  }
  if (hit && (hit.type === 'rect' || hit.type === 'ellipse' || hit.type === 'poly')) {
    void editShapeLabel(hit.id);
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
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    if (presenting) return;
    if (panMoved) {
      panMoved = false;
      return;
    }
    const p = screenToWorld(e.clientX, e.clientY);
    const hit = hitTest(state.doc.elements, p, 6 / view.zoom, { ignoreHidden: true });
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
    if (state.readOnly) return;
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
        before: null,
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
        drag = { kind: 'endpoint', id: el.id, which: corner, before: null, changed: false };
      } else {
        if (el.type === 'ink') return;
        drag = {
          kind: 'resize',
          ids: [el.id],
          corner,
          before: null,
          orig: bounds(el),
          origins: new Map([[el.id, cloneEl(el)]]),
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
        before: null,
        orig,
        origins: new Map(selected.map((el) => [el.id, cloneEl(el)])),
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
      { label: t('ctx.selectAll'), action: () => setSelection(autoSelectableElements(state.doc.elements).map((el) => el.id), false) },
      { separator: true, label: '', action: () => {} },
      { label: t('ctx.fit'), action: () => { fitToContent(); updateSelectionBox(); } }
    );
    return items;
  }
  const hasSelection = state.selectedIds.length > 0;
  const editableCount = editableSelection().length;
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
    { label: t('ctx.alignLeft'), action: () => alignSelection('left'), disabled: editableCount < 2 },
    { label: t('ctx.alignHCenter'), action: () => alignSelection('hcenter'), disabled: editableCount < 2 },
    { label: t('ctx.alignRight'), action: () => alignSelection('right'), disabled: editableCount < 2 },
    { label: t('ctx.alignTop'), action: () => alignSelection('top'), disabled: editableCount < 2 },
    { label: t('ctx.alignVCenter'), action: () => alignSelection('vcenter'), disabled: editableCount < 2 },
    { label: t('ctx.alignBottom'), action: () => alignSelection('bottom'), disabled: editableCount < 2 },
    { label: t('ctx.distributeH'), action: () => distributeSelection('x'), disabled: editableCount < 3 },
    { label: t('ctx.distributeV'), action: () => distributeSelection('y'), disabled: editableCount < 3 },
    { separator: true, label: '', action: () => {} },
    { label: t('ctx.copyFormat'), action: () => copyFormatFromSelection(), disabled: !hasSelection },
    { label: t('ctx.pasteFormat'), action: applyFormatToSelection, disabled: !formatBrush || !hasSelection },
    { separator: true, label: '', action: () => {} },
    { label: t('ctx.exportSelection'), action: () => void exportPng(), disabled: !hasSelection },
    { label: t('ctx.exportSelectionSvg'), action: () => void exportSvg(), disabled: !hasSelection },
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
  if (state.selectedIds.length === 1 && hit.type === 'text') {
    items.push(
      { separator: true, label: '', action: () => {} },
    { label: '设置链接…', action: () => void editTextLink(hit.id) }
    );
  }
  if (state.selectedIds.length === 1 && hit.type === 'arrow') {
    items.push(
      { separator: true, label: '', action: () => {} },
      { label: t('ctx.label'), action: () => void editArrowLabel(hit.id) },
      {
        label: hit.routing === 'orthogonal' ? '改为直线' : '改为正交折线',
        action: () => {
          if (blockReadOnly()) return;
          const before = beginMutation();
          hit.routing = hit.routing === 'orthogonal' ? undefined : 'orthogonal';
          commitMutation(before, true, '连接线路由');
          renderAll();
        }
      }
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

function alignSelection(mode: AlignMode): void {
  if (blockReadOnly()) return;
  commitEdit();
  const targets = editableSelection();
  if (targets.length < 2) {
    setStatus('请至少选择两个未锁定元素');
    return;
  }
  const deltas = alignDeltas(targets.map(visualBounds), mode);
  const before = beginMutation();
  let changed = false;
  targets.forEach((el, index) => {
    const [dx, dy] = deltas[index];
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
    moveEl(el, dx, dy);
    updateElNode(el);
    changed = true;
  });
  if (!changed) return;
  refreshConnectors(new Set(targets.map((el) => el.id)));
  commitMutation(before, true, '对齐');
  updateSelectionBox();
  updateStatusInfo();
  setStatus('已对齐');
}

function distributeSelection(axis: 'x' | 'y'): void {
  if (blockReadOnly()) return;
  commitEdit();
  const targets = editableSelection();
  if (targets.length < 3) {
    setStatus('请至少选择三个未锁定元素');
    return;
  }
  const deltas = distributeDeltas(targets.map(visualBounds), axis);
  const before = beginMutation();
  let changed = false;
  targets.forEach((el, index) => {
    const [dx, dy] = deltas[index];
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
    moveEl(el, dx, dy);
    updateElNode(el);
    changed = true;
  });
  if (!changed) return;
  refreshConnectors(new Set(targets.map((el) => el.id)));
  commitMutation(before, true, '分布');
  updateSelectionBox();
  updateStatusInfo();
  setStatus(axis === 'x' ? '已水平等距分布' : '已垂直等距分布');
}

function groupSelection(): void {
  if (blockReadOnly()) return;
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
  if (blockReadOnly()) return;
  const targets = editableSelection().filter((el) => el.groupId);
  if (!targets.length) return;
  const before = beginMutation();
  for (const el of targets) el.groupId = undefined;
  commitMutation(before, true, '解组');
  renderAll();
  setStatus('已解组');
}

function setLockedSelection(locked: boolean): void {
  if (blockReadOnly()) return;
  const targets = selectedElements();
  if (!targets.length) return;
  const before = beginMutation();
  for (const el of targets) el.locked = locked || undefined;
  commitMutation(before, true, locked ? '锁定' : '解锁');
  renderAll();
  refreshPalette();
  setStatus(locked ? '已锁定' : '已解组');
}

function setHiddenSelection(hidden: boolean): void {
  if (blockReadOnly()) return;
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
  const els = autoSelectableElements(state.doc.elements);
  if (!els.length) return;
  if (!state.selectedIds.length) {
    const target = back ? els[els.length - 1] : els[0];
    setSelection([target.id], false);
    ensureVisible(bounds(target));
    focusNode(target.id);
    return;
  }
  const lastId = state.selectedIds[state.selectedIds.length - 1];
  let index = els.findIndex((el) => el.id === lastId);
  if (index < 0) index = back ? 0 : -1;
  const nextIndex = (index + (back ? -1 : 1) + els.length) % els.length;
  const target = els[nextIndex];
  setSelection([target.id], false);
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
  void refreshPageThumbs();
}

let pageThumbToken = 0;
async function refreshPageThumbs(): Promise<void> {
  if (pageThumbs.hidden) return;
  const token = ++pageThumbToken;
  pageThumbs.replaceChildren();
  for (let index = 0; index < state.pages.length; index++) {
    const page = state.pages[index];
    const button = document.createElement('button');
    button.className = 'page-thumb' + (index === state.activePage ? ' active' : '');
    button.draggable = true;
    button.dataset.index = String(index);
    button.title = page.name;
    const label = document.createElement('div');
    label.textContent = page.name;
    button.appendChild(label);
    const empty = document.createElement('div');
    empty.className = 'page-thumb-empty';
    empty.textContent = String(page.elements.length);
    button.appendChild(empty);
    button.addEventListener('click', () => {
      commitEdit();
      if (switchPage(index)) {
        markDirty({ autosave: false });
        afterPageChange();
      }
    });
    button.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', String(index)));
    button.addEventListener('dragover', (e) => e.preventDefault());
    button.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer?.getData('text/plain'));
      const to = index;
      if (!Number.isInteger(from) || from === to) return;
      pushPageUndo('调整页面顺序');
      if (movePage(from, to)) {
        clearHistory();
        markDirty({ autosave: false });
        afterPageChange();
      }
    });
    pageThumbs.appendChild(button);
    void renderElementsPng(page.elements, { scale: 0.1, background: false }).then((url) => {
      if (token !== pageThumbToken || !url) return;
      const img = document.createElement('img');
      img.src = url;
      img.alt = page.name;
      empty.replaceWith(img);
    });
  }
  pageThumbs.hidden = state.pages.length === 0;
}

async function setPresenting(on: boolean): Promise<boolean> {
  if (on === presenting) return presenting;
  if (on) {
    commitEdit();
    helpOverlay.hidden = true;
    closeSettings();
    closeSearch();
    hideContextMenu();
    setSelection([]);
    presentView = { zoom: view.zoom, pan: { x: view.pan.x, y: view.pan.y } };
    presenting = true;
    presentStart = Date.now();
    presentBlack.hidden = true;
    presentInfo.hidden = false;
    updatePresentInfo();
    presentTimer = window.setInterval(updatePresentInfo, 1000);
    document.body.classList.add('presenting');
    try {
      presentWasFullScreen = await window.api.setFullScreen(true);
    } catch {
      presentWasFullScreen = false;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    fitToContent();
    updateSelectionBox();
    return true;
  }
  presenting = false;
  window.clearInterval(presentTimer);
  presentInfo.hidden = true;
  presentLaser.hidden = true;
  presentBlack.hidden = true;
  document.body.classList.remove('presenting');
  if (presentView) {
    view.zoom = presentView.zoom;
    view.pan.x = presentView.pan.x;
    view.pan.y = presentView.pan.y;
    presentView = null;
  }
  applyTransform();
  updateSelectionBox();
  try {
    await window.api.setFullScreen(presentWasFullScreen);
  } catch {
    /* 无窗口 API 时只退出演示界面 */
  }
  return false;
}

function presentPage(delta: number): boolean {
  if (!presenting) return false;
  const next = state.activePage + delta;
  if (next < 0 || next >= state.pages.length) return false;
  if (!switchPage(next)) return false;
  afterPageChange();
  updatePresentInfo();
  setStatus(`第 ${next + 1} / ${state.pages.length} 页`);
  return true;
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
  if (blockReadOnly()) return;
  commitEdit();
  pushPageUndo('新建页面');
  addPage();
  switchPage(state.pages.length - 1);
  clearHistory();
  markDirty({ autosave: false });
  setSelection([]);
  afterPageChange();
  setStatus('已新建页面');
}

function duplicatePageAction(): void {
  if (blockReadOnly()) return;
  commitEdit();
  pushPageUndo('复制页面');
  const page = duplicatePage(state.activePage);
  if (!page) return;
  clearHistory();
  markDirty({ autosave: false });
  afterPageChange();
  setStatus('已复制页面：' + page.name);
}

async function renamePageAction(): Promise<void> {
  if (blockReadOnly()) return;
  const value = await openPrompt('重命名页面', state.pages[state.activePage]?.name || '');
  if (value === null || !value.trim()) return;
  pushPageUndo('重命名页面');
  renamePage(state.activePage, value);
  clearHistory();
  markDirty({ autosave: false });
  refreshPageBar();
  setStatus('已重命名页面');
}

async function deletePageAt(index: number): Promise<boolean> {
  if (index < 0 || index >= state.pages.length || state.pages.length <= 1) return false;
  const backedUp = await backupNow();
  if (!backedUp) {
    const proceed = await window.api.confirm('删除前备份失败', '未能写入删除前的备份。仍要删除该页面吗？');
    if (!proceed) {
      setStatus('已取消删除');
      return false;
    }
  }
  pushPageUndo('删除页面');
  if (!removePage(index)) return false;
  clearHistory();
  markDirty({ autosave: false });
  afterPageChange();
  refreshPalette();
  setStatus(backedUp ? '已删除页面，按 Ctrl+Z 恢复' : '已删除页面（备份失败），按 Ctrl+Z 恢复');
  return true;
}

async function deletePageAction(): Promise<void> {
  if (blockReadOnly()) return;
  if (state.pages.length <= 1) {
    setStatus('至少保留一个页面');
    return;
  }
  const ok = await window.api.confirm('删除当前页面', '该页面内容将一并删除，是否继续？');
  if (!ok) return;
  await deletePageAt(state.activePage);
}

function movePageAction(delta: number): void {
  if (blockReadOnly()) return;
  commitEdit();
  const target = state.activePage + delta;
  if (target < 0 || target >= state.pages.length) return;
  pushPageUndo('移动页面');
  if (movePage(state.activePage, target)) {
    clearHistory();
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
      { label: t('page.duplicate'), action: duplicatePageAction },
      { label: t('page.rename'), action: () => void renamePageAction() },
      { label: t('page.up'), action: () => movePageAction(-1) },
      { label: t('page.down'), action: () => movePageAction(1) },
      { separator: true, label: '', action: () => {} },
      { label: t('page.delete'), action: () => void deletePageAction() },
      { label: t('page.export'), action: () => void exportAllPagesPdf() },
      { label: '导出所有页面 PNG ZIP…', action: () => void exportAllPagesZip('png') },
      { label: '导出所有页面 SVG ZIP…', action: () => void exportAllPagesZip('svg') }
    ],
    rect.right,
    rect.bottom + 4
  );
}

/** 输入控件内的按键交给控件本身，避免 Delete/方向键/字母误触画布 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** 按钮/链接上的 Space、Enter、Tab 保留原生键盘行为 */
function isActionTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'A';
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

function focusSearchResult(result: { page: number; id: string }): void {
  if (result.page !== state.activePage) {
    if (!switchPage(result.page)) return;
    afterPageChange();
  }
  setSelection([result.id]);
  const el = state.doc.elements.find((item) => item.id === result.id);
  if (el) ensureVisible(visualBounds(el));
}

function runSearch(): void {
  const query = searchInput.value.trim().toLowerCase();
  searchResults = [];
  searchIndex = 0;
  if (query) {
    syncActivePage();
    const scope = searchAllPages.checked
      ? state.pages.map((page, pageIndex) => ({ page: pageIndex, elements: page.elements }))
      : [{ page: state.activePage, elements: state.doc.elements }];
    for (const group of scope) {
      for (const el of group.elements) {
        if (el.hidden) continue;
        let haystack = el.name || '';
        if (el.type === 'text') haystack += ' ' + el.text;
        else if (el.type === 'arrow') haystack += ' ' + (el.label || '');
        else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'poly') haystack += ' ' + (el.label || '');
        if (haystack.toLowerCase().includes(query)) searchResults.push({ page: group.page, id: el.id });
      }
    }
  }
  searchCount.textContent = searchResults.length ? `${searchIndex + 1}/${searchResults.length}` : '0/0';
  if (searchResults.length) focusSearchResult(searchResults[0]);
}

function cycleSearch(delta: number): void {
  if (!searchResults.length) return;
  searchIndex = (searchIndex + delta + searchResults.length) % searchResults.length;
  focusSearchResult(searchResults[searchIndex]);
  searchCount.textContent = `${searchIndex + 1}/${searchResults.length}`;
}

function replaceText(query: string, replacement: string, all: boolean): number {
  const q = query.trim();
  if (!q || blockReadOnly()) return 0;
  const ids = new Set(searchResults.filter((result) => result.page === state.activePage).map((result) => result.id));
  const targets = state.doc.elements.filter(
    (el): el is TextEl =>
      el.type === 'text' &&
      !el.hidden &&
      !el.locked &&
      (all ? el.text.toLowerCase().includes(q.toLowerCase()) : ids.has(el.id))
  );
  if (!targets.length) {
    setStatus('没有可替换的文字');
    return 0;
  }
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), all ? 'gi' : 'i');
  const before = beginMutation();
  let count = 0;
  for (const el of targets) {
    const matches = el.text.match(pattern)?.length || 0;
    const next = el.text.replace(pattern, replacement);
    if (next !== el.text) {
      el.text = next;
      count += all ? matches : 1;
      if (!all) break;
    }
  }
  if (!count) return 0;
  commitMutation(before, true, '替换文字');
  renderAll();
  runSearch();
  setStatus(`已替换'${count} 处`);
  return count;
}

function replaceAction(all: boolean): void {
  replaceText(searchInput.value, replaceInput.value, all);
}

function openSearch(): void {
  searchbar.hidden = false;
  searchInput.focus();
  searchInput.select();
  runSearch();
}

function closeSearch(): void {
  searchbar.hidden = true;
  searchResults = [];
  searchInput.value = '';
  replaceInput.value = '';
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
        mk('议', 120, 240, 20),
        mk('决', 520, 240, 20),
        mk('行', 920, 240, 20)
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

interface CustomTemplate {
  name: string;
  elements: El[];
}

function readCustomTemplates(): CustomTemplate[] {
  try {
    const raw = JSON.parse(localStorage.getItem('wbc-custom-templates') || '[]');
    return Array.isArray(raw) ? raw.filter((item) => item && typeof item.name === 'string' && Array.isArray(item.elements)) : [];
  } catch {
    return [];
  }
}

async function saveTemplateAction(): Promise<void> {
  const name = await openPrompt('模板名称', '自定义模板');
  if (name === null || !name.trim()) return;
  const templates = readCustomTemplates();
  templates.unshift({ name: name.trim().slice(0, 40), elements: cloneElements(state.doc.elements) });
  try {
    localStorage.setItem('wbc-custom-templates', JSON.stringify(templates.slice(0, 20)));
  } catch {
    /* 忽略 */
  }
  setStatus('已保存模板：' + name.trim());
}

async function newWithTemplate(): Promise<void> {
  const custom = readCustomTemplates();
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
          { value: 'todo', label: t('tpl.todo') },
          ...custom.map((item, index) => ({ value: 'custom:' + index, label: item.name }))
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
  } else if (template.startsWith('custom:')) {
    const item = custom[Number(template.slice(7))];
    if (item) {
      state.doc.elements.push(...cloneElements(item.elements));
      state.pages[0].elements = state.doc.elements;
      state.pages[0].name = item.name;
      state.selectedIds = [];
    }
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

function installOnboarding(): void {
  const done = localStorage.getItem('wbc-onboarding-done') === '1';
  onboardingOverlay.hidden = done;
  const close = () => {
    onboardingOverlay.hidden = true;
    try {
      localStorage.setItem('wbc-onboarding-done', '1');
    } catch {
      /* 忽略 */
    }
  };
  onboardingClose.addEventListener('click', close);
  onboardingOverlay.addEventListener('click', (e) => {
    if (e.target === onboardingOverlay) close();
  });
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
    if (presenting) {
      e.preventDefault();
      if (e.key === 'F5' || e.key === 'Escape') {
        void setPresenting(false);
      } else if (e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        presentPage(1);
      } else if (e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        presentPage(-1);
      } else if (e.key === ' ') {
        presentPage(e.shiftKey ? -1 : 1);
      } else if (e.key.toLowerCase() === 'b') {
        presentBlack.hidden = !presentBlack.hidden;
      } else if (e.key.toLowerCase() === 't') {
        presentStart = Date.now();
        presentBlack.hidden = false;
        window.setTimeout(() => {
          presentBlack.hidden = true;
          updatePresentInfo();
        }, 3000);
      }
      return;
    }
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
    // 输入法组合期间不响应画布快捷键
    if (e.isComposing || e.keyCode === 229) return;
    const active = document.activeElement;
    if (isEditableTarget(active) || isEditableTarget(e.target)) return;
    if (e.key === 'Tab' && isActionTarget(active)) return;
    if ((e.key === ' ' || e.key === 'Enter') && isActionTarget(active)) return;
    if (e.key === 'F5') {
      e.preventDefault();
      void setPresenting(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
      return;
    }
    const custom = customToolFor(e);
    if (custom) {
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
        setSelection(autoSelectableElements(state.doc.elements).map((el) => el.id), false);
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
      if (key === 'v') {
        e.preventDefault();
        void pasteFromClipboard();
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
    else if (action === 'export-pages-png-zip') void exportAllPagesZip('png');
    else if (action === 'export-pages-svg-zip') void exportAllPagesZip('svg');
    else if (action === 'print') void printCanvas('print');
    else if (action === 'page-new') addPageAction();
    else if (action === 'page-duplicate') duplicatePageAction();
    else if (action === 'page-rename') void renamePageAction();
    else if (action === 'page-delete') void deletePageAction();
    else if (action === 'page-up') movePageAction(-1);
    else if (action === 'page-down') movePageAction(1);
    else if (action === 'toggle-panels') togglePanels();
    else if (action === 'search') openSearch();
    else if (action === 'present') void setPresenting(!presenting);
    else if (action === 'backup-now') void backupNow();
    else if (action === 'restore-backup') void restoreBackup();
    else if (action === 'save-template') void saveTemplateAction();
    else if (action === 'settings') openSettings();
    else if (action === 'toggle-readonly') setReadOnly(!state.readOnly);
    else if (action === 'toggle-rulers') setRulersVisible(!rulersVisible);
    else if (action === 'toggle-page-thumbs') {
      pageThumbs.hidden = !pageThumbs.hidden;
      pageThumbsBtn.classList.toggle('active', !pageThumbs.hidden);
      if (!pageThumbs.hidden) void refreshPageThumbs();
    }
    else if (action === 'undo') undoAction();
    else if (action === 'redo') redoAction();
    else if (action === 'cut') copySelected(true);
    else if (action === 'copy') copySelected(false);
    else if (action === 'paste') void pasteFromClipboard();
    else if (action === 'delete') deleteSelected();
    else if (action === 'select-all') setSelection(autoSelectableElements(state.doc.elements).map((el) => el.id), false);
    else if (action === 'zoom-in') zoomAroundViewport(1.2);
    else if (action === 'zoom-out') zoomAroundViewport(1 / 1.2);
    else if (action === 'zoom-fit') { fitToContent(); updateSelectionBox(); updateStatusInfo(); }
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
    commitEdit();
    switchPage(Number(pageSelect.value));
    markDirty({ autosave: false });
    afterPageChange();
  });
  pageAdd.addEventListener('click', addPageAction);
  pageMore.addEventListener('click', pageMenu);
  pageThumbsBtn.addEventListener('click', () => {
    pageThumbs.hidden = !pageThumbs.hidden;
    pageThumbsBtn.classList.toggle('active', !pageThumbs.hidden);
    if (!pageThumbs.hidden) void refreshPageThumbs();
  });
  panelBtn.addEventListener('click', () => togglePanels());
  searchClose.addEventListener('click', closeSearch);
  replaceOneBtn.addEventListener('click', () => replaceAction(false));
  replaceAllBtn.addEventListener('click', () => replaceAction(true));
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceAction(false);
    }
  });
  searchInput.addEventListener('input', runSearch);
  searchAllPages.addEventListener('change', runSearch);
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
      if (el.hidden) return false;
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
        const meta = { rotation: el.rotation, groupId: el.groupId, locked: el.locked, hidden: el.hidden, name: el.name, opacity: el.opacity };
        if (el.type === 'text') return { ...base, ...meta, color: el.color, fontSize: el.fontSize, bold: el.bold, italic: el.italic, align: el.align, fontFamily: el.fontFamily, lineHeight: el.lineHeight, sticky: el.sticky };
        if (el.type === 'ink') return { ...base, ...meta, color: el.color, width: el.width, highlight: el.highlight };
        if (el.type === 'image') return { ...base, ...meta };
        if (el.type === 'arrow') return { ...base, ...meta, stroke: el.stroke, strokeWidth: el.strokeWidth, head: el.head, dash: el.dash };
        if (el.type === 'poly') return { ...base, ...meta, stroke: el.stroke, strokeWidth: el.strokeWidth, fill: el.fill, kind: el.kind, dash: el.dash };
        return { ...base, ...meta, stroke: el.stroke, strokeWidth: el.strokeWidth, fill: el.fill, dash: (el as RectEl | EllipseEl).dash };
      }),
    selectedIds: () => [...state.selectedIds],
    order: () => state.doc.elements.map((el) => el.id),
    select: (ids) => setSelection(ids),
    duplicate: () => {
      duplicateSelected();
      return state.doc.elements.length;
    },
    nudge: (dx, dy) => nudgeSelected(dx, dy),
    align: (mode) => alignSelection(mode),
    distribute: (axis) => distributeSelection(axis),
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
      refreshConnectors(new Set([id]));
      updateSelectionBox();
      updateStatusInfo();
    },
    /** 模拟真实拖拽：一次克隆 + N 帧移动（不含每帧历史克隆） */
    dragBench: (count: number, dx: number) => {
      const targets = editableSelection().slice(0, 200);
      if (!targets.length) return { ms: 0, tMove: 0, tNodes: 0, tConn: 0, tSel: 0, n: 0, frames: 0 };
      const before = beginMutation();
      const ids = new Set(targets.map((el) => el.id));
      const t = performance.now();
      let tNodes = 0;
      let tConn = 0;
      let tSel = 0;
      let tMove = 0;
      for (let i = 0; i < count; i++) {
        const m0 = performance.now();
        for (const el of targets) moveEl(el, dx, 0);
        const a = performance.now();
        updateElNodes(targets);
        const b = performance.now();
        refreshConnectors(ids);
        const c = performance.now();
        updateSelectionBox();
        const d = performance.now();
        tMove += a - m0;
        tNodes += b - a;
        tConn += c - b;
        tSel += d - c;
      }
      const ms = performance.now() - t;
      commitMutation(before, true, '拖拽');
      return { ms, tMove, tNodes, tConn, tSel, n: targets.length, frames: count };
    },
    undo: () => undoAction(),
    redo: () => redoAction(),
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
      const result = await window.api.saveDoc(path, serialize(), false, state.filePath === path ? state.fileStamp : null);
      if (result.path && !result.conflict) {
        state.filePath = result.path;
        state.fileStamp = result.stamp || null;
        state.autosaveBlocked = false;
      }
      return !!result.path && !result.conflict;
    },
    saveDetailed: async (path) => {
      const result = await window.api.saveDoc(path, serialize(), false, state.filePath === path ? state.fileStamp : null);
      if (result.path && !result.conflict && !result.reload) {
        state.filePath = result.path;
        state.fileStamp = result.stamp || null;
        state.autosaveBlocked = false;
      }
      return result;
    },
    serialized: () => serialize(),
    historyStats: () => historyStats(),
    recoveryDebug: () => ({ ...recoveryDebug }),
    openFrom: async (path) => {
      const result = await window.api.openDoc(path);
      if (!result.text) return false;
      try {
        loadFromText(result.text);
      } catch {
        return false;
      }
      state.filePath = result.repaired ? null : result.path ?? null;
      state.fileStamp = result.repaired ? null : result.stamp || null;
      state.autosaveBlocked = false;
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
    eraseObjectAt: (x, y) => {
      const before = state.doc.elements.length;
      const changed = eraseObjectAt([x, y]);
      return changed ? before - state.doc.elements.length : 0;
    },
    setEraserMode: (mode) => {
      state.eraserMode = mode === 'object' ? 'object' : 'ink';
      refreshPalette();
    },
    el: (id) => {
      const el = state.doc.elements.find((item) => item.id === id);
      return el ? cloneEl(el) : null;
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
    selectAll: () => setSelection(autoSelectableElements(state.doc.elements).map((el) => el.id), false),
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
      const start = nearestPointOnRotatedRect(a, bc);
      const end = nearestPointOnRotatedRect(b, ac);
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
      setSelection(shift ? state.selectedIds.concat(hits) : hits, false);
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
    setShapeLabel: (id, label) => {
      const el = state.doc.elements.find((item) => item.id === id);
      if (!el || (el.type !== 'rect' && el.type !== 'ellipse' && el.type !== 'poly')) return;
      const before = beginMutation();
      el.label = label || undefined;
      commitMutation(before, true, '形状文字');
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
    replace: (query, replacement, all) => {
      searchResults = searchIds(query).map((id) => ({ page: state.activePage, id }));
      searchIndex = 0;
      return replaceText(query, replacement, all);
    },
    exportSvgTo: async (path) => {
      const ids = new Set(state.selectedIds);
      const selected = state.doc.elements.filter((el) => ids.has(el.id) && !el.hidden);
      const svg = buildSvg(selected.length ? selected : state.doc.elements);
      if (!svg) return false;
      const result = await window.api.saveSvg(svg, path);
      return !!result.path;
    },
    exportPagesZipTo: (path, format) => exportAllPagesZip(format, path),
    pageNames: () => state.pages.map((page) => page.name),
    activePage: () => state.activePage,
    addPage: (name) => {
      const page = addPage(name);
      markDirty({ autosave: false });
      refreshPageBar();
      return page.id;
    },
    duplicatePage: (index) => {
      commitEdit();
      pushPageUndo('复制页面');
      const page = duplicatePage(index);
      if (!page) return null;
      clearHistory();
      markDirty({ autosave: false });
      afterPageChange();
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
    deletePage: (index) => deletePageAt(index),
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
      applyLowSpec();
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
    present: (on) => setPresenting(on),
    isPresenting: () => presenting,
    setReadOnly,
    isReadOnly: () => state.readOnly,
    presentPage: (delta) => presentPage(delta),
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
    void window.api.backupNow(serialize(), state.filePath, state.recoveryKey);
  }, 10 * 60 * 1000);
}

async function init(): Promise<void> {
  let boot: StartupResult = { settings: { ...DEFAULT_SETTINGS }, recovery: null, openPath: null };
  try {
    boot = await window.api.startup();
    state.settings = boot.settings || { ...DEFAULT_SETTINGS };
    if (boot.recovery?.key) state.recoveryKey = boot.recovery.key;
  } catch (err) {
    window.api.log('error', '启动信息读取失败：' + String(err));
  }
  window.api.initRecovery(state.recoveryKey);
  buildPalette();
  setEditHooks(commitEdit, cancelEdit, refreshPalette);
  setRenderHook(refreshPanels);
  installPanels({ select: (ids) => setSelection(ids), changed: () => refreshPanels(), commit: () => commitEdit() });
  applyTheme(state.settings.theme);
  setStatusHook(updateStatusInfo);
  setRecoverySnapshotProvider(recoverySnapshot);
  applyI18n();
  setTransformHook(() => {
    syncNodes();
    updateSelectionBox();
    updateStatusInfo();
    if (state.settings.lowSpec) return;
    drawRulers();
    renderManualGuides();
  });
  installContextMenu();
  installMinimap();
  installRulers();
  window.addEventListener('resize', () => {
    drawRulers();
    renderManualGuides();
  });
  installSettings(() => {
    applyTheme(state.settings.theme);
    applyI18n();
    applyTransform();
    updateTitle();
    refreshPalette();
    refreshPanels();
    applyLowSpec();
  });
  installZoomInput();
  setTool('select');
  installPointerEvents();
  installPasteAndDrop();
  installEditor();
  installKeyboard();
  installHelp();
  installOnboarding();
  installMenu();
  installToolbar();
  installTestHooksSafe();
  applyLowSpec();
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
      applyRecoveredDocument(boot.recovery.text, boot.recovery.path, boot.recovery.stamp || null);
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
