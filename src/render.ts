// SPDX-License-Identifier: GPL-3.0-or-later
import { El, arrowPathD, bounds, boundsUnion, inkAbsolutePoints, rectsIntersect, smoothPathD } from './model';
import { state } from './state';
import { view, world, worldViewRect } from './view';
import { requestMinimap } from './minimap';

const SVG_NS = 'http://www.w3.org/2000/svg';
const selectionBox = document.getElementById('selection') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;
const editor = document.getElementById('editor') as HTMLTextAreaElement;

export const FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';

type ElNode = HTMLElement | SVGSVGElement;

const nodeMap = new Map<string, ElNode>();
let editing = false;

export function setEditing(value: boolean): void {
  editing = value;
}

function nodePadding(el: El): number {
  if (el.type === 'arrow') return el.strokeWidth + 12;
  if (el.type === 'ink') return el.width + 12;
  return 24;
}

function visibleBounds(el: El) {
  const b = bounds(el);
  const pad = nodePadding(el);
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

function reorder(): void {
  for (const el of state.doc.elements) {
    const node = nodeMap.get(el.id);
    if (node) world.insertBefore(node, editor);
  }
}

/** 仅挂载视口附近的元素，千级元素时平移缩放不卡顿 */
export function syncNodes(): void {
  const vr = worldViewRect(160);
  const byId = new Map(state.doc.elements.map((el) => [el.id, el]));
  let changed = false;
  for (const [id, node] of Array.from(nodeMap)) {
    const el = byId.get(id);
    if (!el || !rectsIntersect(visibleBounds(el), vr)) {
      node.remove();
      nodeMap.delete(id);
      changed = true;
    }
  }
  for (const el of state.doc.elements) {
    if (nodeMap.has(el.id)) continue;
    if (!rectsIntersect(visibleBounds(el), vr)) continue;
    const node = createNode(el);
    world.insertBefore(node, editor);
    nodeMap.set(el.id, node);
    changed = true;
  }
  if (changed) reorder();
  hint.hidden = state.doc.elements.length !== 0;
  requestMinimap();
}

export function renderAll(): void {
  for (const child of Array.from(world.children)) {
    if (child !== editor) child.remove();
  }
  nodeMap.clear();
  syncNodes();
  updateSelectionBox();
}

export function updateElNode(el: El): void {
  const node = nodeMap.get(el.id);
  if (!node) {
    syncNodes();
    return;
  }
  applyNode(el, node);
  requestMinimap();
}

function createNode(el: El): ElNode {
  const node: ElNode =
    el.type === 'ink' || el.type === 'arrow'
      ? (document.createElementNS(SVG_NS, 'svg') as SVGSVGElement)
      : el.type === 'image'
        ? document.createElement('img')
        : document.createElement('div');
  node.style.position = 'absolute';
  node.style.pointerEvents = 'none';
  node.style.userSelect = 'none';
  applyNode(el, node);
  return node;
}

function applyNode(el: El, node: ElNode): void {
  const s = node.style;
  switch (el.type) {
    case 'text': {
      const div = node as HTMLDivElement;
      s.left = el.x + 'px';
      s.top = el.y + 'px';
      s.width = el.w + 'px';
      s.height = 'auto';
      s.minHeight = el.fontSize * 1.4 + 'px';
      s.whiteSpace = 'pre-wrap';
      s.wordBreak = 'break-all';
      s.lineHeight = '1.4';
      s.fontFamily = FONT;
      s.fontSize = el.fontSize + 'px';
      s.color = el.color;
      if (div.textContent !== el.text) div.textContent = el.text;
      const measured = Math.max(el.fontSize * 1.4, div.offsetHeight);
      if (Math.abs(el.h - measured) > 0.5) el.h = measured;
      break;
    }
    case 'image': {
      const img = node as HTMLImageElement;
      s.left = el.x + 'px';
      s.top = el.y + 'px';
      s.width = el.w + 'px';
      s.height = el.h + 'px';
      s.objectFit = 'fill';
      img.draggable = false;
      if (img.getAttribute('src') !== el.src) img.src = el.src;
      break;
    }
    case 'rect':
    case 'ellipse': {
      s.left = el.x + 'px';
      s.top = el.y + 'px';
      s.width = Math.max(el.w, 0) + 'px';
      s.height = Math.max(el.h, 0) + 'px';
      s.boxSizing = 'border-box';
      s.border = el.strokeWidth + 'px solid ' + el.stroke;
      s.borderRadius = el.type === 'ellipse' ? '50%' : '0';
      s.background = el.fill || 'transparent';
      break;
    }
    case 'ink': {
      const pad = el.width / 2 + 2;
      s.left = el.x - pad + 'px';
      s.top = el.y - pad + 'px';
      s.width = el.w + pad * 2 + 'px';
      s.height = el.h + pad * 2 + 'px';
      s.mixBlendMode = el.highlight ? 'multiply' : 'normal';
      s.opacity = el.highlight ? '0.35' : '1';
      const svg = node as SVGSVGElement;
      svg.setAttribute('viewBox', `${el.x - pad} ${el.y - pad} ${el.w + pad * 2} ${el.h + pad * 2}`);
      svg.setAttribute('overflow', 'visible');
      renderInkPath(svg, el);
      break;
    }
    case 'arrow': {
      const pad = el.strokeWidth + 10;
      const b = bounds(el);
      s.left = b.x - pad + 'px';
      s.top = b.y - pad + 'px';
      s.width = b.w + pad * 2 + 'px';
      s.height = b.h + pad * 2 + 'px';
      const svg = node as SVGSVGElement;
      svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
      svg.setAttribute('overflow', 'visible');
      renderArrowPath(svg, el);
      break;
    }
  }
}

function renderInkPath(svg: SVGSVGElement, el: Extract<El, { type: 'ink' }>): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', smoothPathD(inkAbsolutePoints(el)));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', el.color);
  path.setAttribute('stroke-width', String(el.width));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.replaceChildren(path);
}

function renderArrowPath(svg: SVGSVGElement, el: Extract<El, { type: 'arrow' }>): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', arrowPathD(el));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', el.stroke);
  path.setAttribute('stroke-width', String(el.strokeWidth));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.replaceChildren(path);
}

function makeHandle(cls: string, cursor: string, left?: number, top?: number): HTMLDivElement {
  const handle = document.createElement('div');
  handle.className = 'handle ' + cls;
  handle.style.cursor = cursor;
  if (left !== undefined && top !== undefined) {
    handle.style.left = left + 'px';
    handle.style.top = top + 'px';
    handle.style.transform = 'translate(-50%, -50%)';
  }
  return handle;
}

export function updateSelectionBox(): void {
  if (editing) {
    selectionBox.hidden = true;
    return;
  }
  const selected = state.doc.elements.filter((el) => state.selectedIds.includes(el.id));
  if (!selected.length) {
    selectionBox.hidden = true;
    selectionBox.replaceChildren();
    return;
  }
  const b = boundsUnion(selected);
  if (!b) {
    selectionBox.hidden = true;
    selectionBox.replaceChildren();
    return;
  }
  selectionBox.hidden = false;
  selectionBox.classList.toggle('multi', selected.length > 1);
  selectionBox.style.left = view.pan.x + b.x * view.zoom + 'px';
  selectionBox.style.top = view.pan.y + b.y * view.zoom + 'px';
  selectionBox.style.width = Math.max(b.w * view.zoom, 1) + 'px';
  selectionBox.style.height = Math.max(b.h * view.zoom, 1) + 'px';
  const handles: HTMLDivElement[] = [];
  if (selected.length > 1) {
    handles.push(
      makeHandle('nw', 'nwse-resize'),
      makeHandle('ne', 'nesw-resize'),
      makeHandle('sw', 'nesw-resize'),
      makeHandle('se', 'nwse-resize')
    );
  } else {
    const only = selected[0];
    if (only.type === 'text') {
      handles.push(makeHandle('e', 'ew-resize'));
    } else if (only.type === 'arrow') {
      handles.push(
        makeHandle('p1', 'crosshair', (only.x1 - b.x) * view.zoom, (only.y1 - b.y) * view.zoom),
        makeHandle('p2', 'crosshair', (only.x2 - b.x) * view.zoom, (only.y2 - b.y) * view.zoom)
      );
    } else if (only.type === 'image' || only.type === 'rect' || only.type === 'ellipse') {
      handles.push(
        makeHandle('nw', 'nwse-resize'),
        makeHandle('ne', 'nesw-resize'),
        makeHandle('sw', 'nesw-resize'),
        makeHandle('se', 'nwse-resize')
      );
    }
  }
  selectionBox.replaceChildren(...handles);
}
