// SPDX-License-Identifier: GPL-3.0-or-later
import {
  El,
  PolyEl,
  arrowPathD,
  bounds,
  boundsUnion,
  inkAbsolutePoints,
  nearestPointOnRect,
  polyPathD,
  rectPathD,
  rectsIntersect,
  rotationOf,
  smoothPathD,
  visualBounds
} from './model';
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
let renderHook: () => void = () => {};

export function setRenderHook(fn: () => void): void {
  renderHook = fn;
}

export function setEditing(value: boolean): void {
  editing = value;
}

function nodePadding(el: El): number {
  if (el.type === 'arrow') return el.strokeWidth + 16;
  if (el.type === 'ink') return el.width + 12;
  if (el.type === 'poly') return el.strokeWidth + 4;
  return 24;
}

function visibleBounds(el: El) {
  const b = visualBounds(el);
  const pad = nodePadding(el);
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

export function describeEl(el: El): string {
  if (el.name) return el.name;
  switch (el.type) {
    case 'text':
      return (el.sticky ? '便签：' : '文字：') + (el.text || '空').slice(0, 40);
    case 'image':
      return '图片';
    case 'ink':
      return el.highlight ? '荧光笔迹' : '画笔笔迹';
    case 'rect':
      return '矩形';
    case 'ellipse':
      return '椭圆';
    case 'arrow':
      return el.head ? '箭头' : '直线';
    case 'poly':
      return { triangle: '三角形', diamond: '菱形', star: '五角星', roundrect: '圆角矩形' }[el.kind];
  }
}

/** 连接线端点跟随被连接元素边缘 */
export function refreshConnectors(): void {
  const byId = new Map(state.doc.elements.map((el) => [el.id, el]));
  for (const el of state.doc.elements) {
    if (el.type !== 'arrow' || (!el.fromId && !el.toId)) continue;
    const from = el.fromId ? byId.get(el.fromId) : null;
    const to = el.toId ? byId.get(el.toId) : null;
    if (from) {
      const target: [number, number] = to ? [el.x2, el.y2] : [el.x2, el.y2];
      const point = nearestPointOnRect(visualBounds(from), target);
      el.x1 = point[0];
      el.y1 = point[1];
    }
    if (to) {
      const target: [number, number] = from ? [el.x1, el.y1] : [el.x1, el.y1];
      const point = nearestPointOnRect(visualBounds(to), target);
      el.x2 = point[0];
      el.y2 = point[1];
    }
    const node = nodeMap.get(el.id);
    if (node) applyNode(el, node);
  }
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
    if (!el || el.hidden || !rectsIntersect(visibleBounds(el), vr)) {
      node.remove();
      nodeMap.delete(id);
      changed = true;
    }
  }
  for (const el of state.doc.elements) {
    if (el.hidden || nodeMap.has(el.id)) continue;
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
  refreshConnectors();
  for (const child of Array.from(world.children)) {
    if (child !== editor) child.remove();
  }
  nodeMap.clear();
  syncNodes();
  updateSelectionBox();
  renderHook();
}

export function updateElNode(el: El): void {
  const node = nodeMap.get(el.id);
  if (!node || el.hidden) {
    syncNodes();
    return;
  }
  applyNode(el, node);
  requestMinimap();
}

function createNode(el: El): ElNode {
  const node: ElNode =
    el.type === 'ink' || el.type === 'arrow' || el.type === 'poly'
      ? (document.createElementNS(SVG_NS, 'svg') as SVGSVGElement)
      : el.type === 'image'
        ? document.createElement('div')
        : document.createElement('div');
  node.style.position = 'absolute';
  node.style.pointerEvents = 'none';
  node.style.userSelect = 'none';
  node.setAttribute('aria-label', describeEl(el));
  node.setAttribute('role', 'img');
  node.tabIndex = -1;
  node.dataset.id = el.id;
  applyNode(el, node);
  return node;
}

function applyTextStyle(el: Extract<El, { type: 'text' }>, s: CSSStyleDeclaration): void {
  s.whiteSpace = 'pre-wrap';
  s.wordBreak = 'break-all';
  s.lineHeight = String(el.lineHeight || 1.4);
  s.fontFamily = (el.fontFamily || FONT).includes(',') ? el.fontFamily || FONT : `"${el.fontFamily || 'Microsoft YaHei'}", ${FONT}`;
  s.fontSize = el.fontSize + 'px';
  s.fontWeight = el.bold ? '700' : '400';
  s.fontStyle = el.italic ? 'italic' : 'normal';
  s.textDecorationLine = [el.underline ? 'underline' : '', el.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  s.textAlign = el.align || 'left';
  s.color = el.color;
}

function applyNode(el: El, node: ElNode): void {
  const s = node.style;
  const rotation = rotationOf(el);
  s.transformOrigin = '50% 50%';
  node.setAttribute('aria-label', describeEl(el));
  node.classList.toggle('locked', !!el.locked);
  switch (el.type) {
    case 'text': {
      const div = node as HTMLDivElement;
      s.left = el.x + 'px';
      s.top = el.y + 'px';
      s.width = el.w + 'px';
      s.height = 'auto';
      s.minHeight = el.fontSize * 1.4 + 'px';
      applyTextStyle(el, s);
      s.background = el.sticky ? el.stickyColor || '#fef3c7' : 'transparent';
      s.borderRadius = el.sticky ? '4px' : '0';
      s.boxShadow = el.sticky ? `0 0 0 10px ${el.stickyColor || '#fef3c7'}` : 'none';
      s.padding = '0';
      const text = el.bullets
        ? el.text
            .split('\n')
            .map((line) => (line ? '• ' + line : line))
            .join('\n')
        : el.text;
      if (div.textContent !== text) div.textContent = text;
      const measured = Math.max(el.fontSize * 1.4, div.offsetHeight);
      if (Math.abs(el.h - measured) > 0.5) el.h = measured;
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
      break;
    }
    case 'image': {
      s.left = el.x + 'px';
      s.top = el.y + 'px';
      s.width = el.w + 'px';
      s.height = el.h + 'px';
      s.backgroundImage = `url("${el.src}")`;
      s.backgroundRepeat = 'no-repeat';
      const crop = el.crop || { x: 0, y: 0, w: 1, h: 1 };
      const cw = Math.max(0.001, Math.min(1, crop.w));
      const ch = Math.max(0.001, Math.min(1, crop.h));
      s.backgroundSize = `${100 / cw}% ${100 / ch}%`;
      s.backgroundPosition = `${cw >= 0.999 ? 0 : (crop.x / (1 - cw)) * 100}% ${ch >= 0.999 ? 0 : (crop.y / (1 - ch)) * 100}%`;
      const sx = el.flipH ? -1 : 1;
      const sy = el.flipV ? -1 : 1;
      s.transform = `rotate(${rotation}deg) scale(${sx}, ${sy})`;
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
      s.borderRadius = el.type === 'ellipse' ? '50%' : (el.radius || 0) + 'px';
      s.background = el.fill || 'transparent';
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
      break;
    }
    case 'poly': {
      const pad = el.strokeWidth + 4;
      const b = bounds(el);
      void (node as SVGSVGElement);
      s.left = b.x - pad + 'px';
      s.top = b.y - pad + 'px';
      s.width = b.w + pad * 2 + 'px';
      s.height = b.h + pad * 2 + 'px';
      const svg = node as SVGSVGElement;
      svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
      svg.setAttribute('overflow', 'visible');
      renderPolyPath(svg, el);
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
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
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
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
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
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

function renderPolyPath(svg: SVGSVGElement, el: PolyEl): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', polyPathD(el));
  path.setAttribute('fill', el.fill || 'none');
  path.setAttribute('stroke', el.stroke);
  path.setAttribute('stroke-width', String(el.strokeWidth));
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
  const children: SVGElement[] = [path];
  if (el.label) {
    const text = document.createElementNS(SVG_NS, 'text');
    const mx = (el.x1 + el.x2) / 2;
    const my = (el.y1 + el.y2) / 2;
    text.setAttribute('x', String(mx));
    text.setAttribute('y', String(my - 6));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '14');
    text.setAttribute('fill', el.stroke);
    text.setAttribute('stroke', '#ffffff');
    text.setAttribute('stroke-width', '3');
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('font-family', FONT);
    text.textContent = el.label;
    children.push(text);
  }
  svg.replaceChildren(...children);
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
  selectionBox.classList.toggle('locked', selected.every((el) => el.locked));
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
    } else if (only.type === 'image' || only.type === 'rect' || only.type === 'ellipse' || only.type === 'poly') {
      handles.push(
        makeHandle('nw', 'nwse-resize'),
        makeHandle('ne', 'nesw-resize'),
        makeHandle('sw', 'nesw-resize'),
        makeHandle('se', 'nwse-resize')
      );
    }
  }
  if (!selected.every((el) => el.locked) && selected.length >= 1) {
    const rot = makeHandle('rot', 'grab');
    rot.style.left = '50%';
    rot.style.top = '-24px';
    rot.style.transform = 'translate(-50%, -50%)';
    handles.push(rot);
  }
  selectionBox.replaceChildren(...handles);
}

/** 供导出使用：绘制矩形/多边形路径 */
export function rectOrPolyPath(el: El): string | null {
  if (el.type === 'rect') return rectPathD(el);
  if (el.type === 'poly') return polyPathD(el);
  return null;
}
