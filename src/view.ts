// SPDX-License-Identifier: GPL-3.0-or-later
import { Pt, boundsUnion } from './model';
import { state } from './state';

export const viewport = document.getElementById('viewport') as HTMLDivElement;
export const world = document.getElementById('world') as HTMLDivElement;
const zoomLabel = document.getElementById('zoom-label') as HTMLSpanElement;

export const view = { zoom: 1, pan: { x: 0, y: 0 } };

export function screenToWorld(clientX: number, clientY: number): Pt {
  const r = viewport.getBoundingClientRect();
  return [(clientX - r.left - view.pan.x) / view.zoom, (clientY - r.top - view.pan.y) / view.zoom];
}

export function viewportCenter(): Pt {
  const r = viewport.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

export function applyTransform(): void {
  world.style.transform = `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`;
  const step = 24 * view.zoom;
  viewport.style.backgroundSize = `${step}px ${step}px`;
  viewport.style.backgroundPosition = `${view.pan.x}px ${view.pan.y}px`;
  viewport.style.backgroundImage = view.zoom < 0.4 ? 'none' : '';
  zoomLabel.textContent = Math.round(view.zoom * 100) + '%';
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

export function fitToContent(): void {
  const b = boundsUnion(state.doc.elements);
  const r = viewport.getBoundingClientRect();
  if (!b) {
    view.zoom = 1;
    view.pan.x = 0;
    view.pan.y = 0;
    applyTransform();
    return;
  }
  const zoom = Math.min(
    2,
    Math.max(0.1, Math.min((r.width - 80) / Math.max(b.w, 1), (r.height - 80) / Math.max(b.h, 1)))
  );
  view.zoom = zoom;
  view.pan.x = (r.width - b.w * zoom) / 2 - b.x * zoom;
  view.pan.y = (r.height - b.h * zoom) / 2 - b.y * zoom;
  applyTransform();
}
