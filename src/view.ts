// SPDX-License-Identifier: GPL-3.0-or-later
import { Pt, Rect, boundsUnion, visibleElements } from './model';
import { state } from './state';

export const viewport = document.getElementById('viewport') as HTMLDivElement;
export const world = document.getElementById('world') as HTMLDivElement;
const zoomInput = document.getElementById('zoom-input') as HTMLInputElement;

export const view = { zoom: 1, pan: { x: 0, y: 0 } };

/** 缓存视口尺寸：平移/缩放热路径避免每帧 getBoundingClientRect 触发强制布局 */
const size = { w: viewport.clientWidth || 1280, h: viewport.clientHeight || 800 };

function syncSize(): void {
  size.w = viewport.clientWidth || size.w;
  size.h = viewport.clientHeight || size.h;
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(syncSize).observe(viewport);
} else {
  window.addEventListener('resize', syncSize);
}

let transformHook: () => void = () => {};

export function setTransformHook(fn: () => void): void {
  transformHook = fn;
}

export function screenToWorld(clientX: number, clientY: number): Pt {
  const r = viewport.getBoundingClientRect();
  return [(clientX - r.left - view.pan.x) / view.zoom, (clientY - r.top - view.pan.y) / view.zoom];
}

export function viewportCenter(): Pt {
  const r = viewport.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

export function worldViewRect(margin = 0): Rect {
  const pad = margin / view.zoom;
  return {
    x: -view.pan.x / view.zoom - pad,
    y: -view.pan.y / view.zoom - pad,
    w: size.w / view.zoom + pad * 2,
    h: size.h / view.zoom + pad * 2
  };
}

let appliedBackground = '';

function applyBackground(): void {
  const mode = state.settings.background;
  if (mode === appliedBackground) return;
  appliedBackground = mode;
  if (mode === 'plain') {
    viewport.style.backgroundImage = 'none';
    viewport.style.backgroundColor = '#fff';
    return;
  }
  if (mode === 'cream') {
    viewport.style.backgroundImage = 'none';
    viewport.style.backgroundColor = '#faf6ee';
    return;
  }
  viewport.style.backgroundColor = '#fff';
  viewport.style.backgroundImage = '';
  const isGrid = mode === 'grid';
  viewport.classList.toggle('grid-lines', isGrid);
  // 低配模式下点阵画在 world 层；网格线模式则由视口绘制，world 不再重复画点阵
  document.body.classList.toggle('grid-mode', isGrid);
}

export function applyTransform(): void {
  world.style.transform = `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`;
  const mode = state.settings.background;
  if (mode === 'dots' || mode === 'grid') {
    const step = (state.settings.gridSize || 24) * view.zoom;
    viewport.style.backgroundSize = `${step}px ${step}px`;
    viewport.style.backgroundPosition = `${view.pan.x}px ${view.pan.y}px`;
  }
  if (document.activeElement !== zoomInput) {
    const value = String(Math.round(view.zoom * 100));
    if (zoomInput.value !== value) zoomInput.value = value;
  }
  applyBackground();
  transformHook();
}

export function zoomAt(clientX: number, clientY: number, factor: number): void {
  const r = viewport.getBoundingClientRect();
  const prev = view.zoom;
  const next = Math.min(4, Math.max(0.1, prev * factor));
  if (next === prev) return;
  const wx = (clientX - r.left - view.pan.x) / prev;
  const wy = (clientY - r.top - view.pan.y) / prev;
  view.zoom = next;
  view.pan.x = clientX - r.left - wx * next;
  view.pan.y = clientY - r.top - wy * next;
  applyTransform();
}

/** 以世界坐标点为锚点设置缩放（用于编辑跟随/小地图） */
export function setZoomAtWorld(worldX: number, worldY: number, nextZoom: number): void {
  const z = Math.min(4, Math.max(0.1, nextZoom));
  view.pan.x = size.w / 2 - worldX * z;
  view.pan.y = size.h / 2 - worldY * z;
  view.zoom = z;
  applyTransform();
}

export function zoomToPercent(percent: number): void {
  const r = viewport.getBoundingClientRect();
  const next = Math.min(400, Math.max(10, percent)) / 100;
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, next / view.zoom);
}

export function fitToRect(b: Rect | null): void {
  if (!b || !state.doc.elements.length) {
    view.zoom = 1;
    view.pan.x = 0;
    view.pan.y = 0;
    applyTransform();
    return;
  }
  const zoom = Math.min(
    2,
    Math.max(0.1, Math.min((size.w - 80) / Math.max(b.w, 1), (size.h - 80) / Math.max(b.h, 1)))
  );
  view.zoom = zoom;
  view.pan.x = (size.w - b.w * zoom) / 2 - b.x * zoom;
  view.pan.y = (size.h - b.h * zoom) / 2 - b.y * zoom;
  applyTransform();
}

export function fitToContent(): void {
  fitToRect(boundsUnion(visibleElements(state.doc.elements)));
}

export function fitSelection(): void {
  const ids = new Set(state.selectedIds);
  const selected = state.doc.elements.filter((el) => ids.has(el.id) && !el.hidden);
  if (!selected.length) return;
  fitToRect(boundsUnion(selected));
}

export function ensureVisible(b: Rect): void {
  const margin = 40;
  let dx = 0;
  let dy = 0;
  const left = view.pan.x + b.x * view.zoom;
  const top = view.pan.y + b.y * view.zoom;
  const right = left + Math.max(b.w, 1) * view.zoom;
  const bottom = top + Math.max(b.h, 1) * view.zoom;
  if (left < margin) dx = margin - left;
  if (right > size.w - margin) dx = size.w - margin - right;
  if (top < margin) dy = margin - top;
  if (bottom > size.h - margin) dy = size.h - margin - bottom;
  if (dx || dy) {
    view.pan.x += dx;
    view.pan.y += dy;
    applyTransform();
  }
}
