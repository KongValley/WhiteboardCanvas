// SPDX-License-Identifier: GPL-3.0-or-later
import { El, InkEl, arrowHeadPoints, bounds, boundsUnion, inkAbsolutePoints, smoothPathD } from './model';
import { state } from './state';
import { view, world } from './view';

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

export function renderAll(): void {
  for (const child of Array.from(world.children)) {
    if (child !== editor) child.remove();
  }
  nodeMap.clear();
  for (const el of state.doc.elements) {
    const node = createNode(el);
    world.insertBefore(node, editor);
    nodeMap.set(el.id, node);
  }
  hint.hidden = state.doc.elements.length !== 0;
  updateSelectionBox();
}

export function updateElNode(el: El): void {
  const node = nodeMap.get(el.id);
  if (!node) {
    renderAll();
    return;
  }
  applyNode(el, node);
}

function createNode(el: El): ElNode {
  const node: ElNode =
    el.type === 'ink' || el.type === 'arrow'
      ? document.createElementNS(SVG_NS, 'svg')
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
      break;
    }
    case 'ink': {
      const pad = el.width / 2 + 2;
      s.left = el.x - pad + 'px';
      s.top = el.y - pad + 'px';
      s.width = el.w + pad * 2 + 'px';
      s.height = el.h + pad * 2 + 'px';
      const svg = node as SVGSVGElement;
      svg.setAttribute('viewBox', `${el.x - pad} ${el.y - pad} ${el.w + pad * 2} ${el.h + pad * 2}`);
      svg.setAttribute('overflow', 'visible');
      renderInkPath(svg, el);
      break;
    }
    case 'arrow': {
      const pad = el.strokeWidth + 8;
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

function renderInkPath(svg: SVGSVGElement, el: InkEl): void {
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
  const [h1, h2] = arrowHeadPoints(el);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2} M ${h1[0]} ${h1[1]} L ${el.x2} ${el.y2} M ${h2[0]} ${h2[1]} L ${el.x2} ${el.y2}`
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', el.stroke);
  path.setAttribute('stroke-width', String(el.strokeWidth));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.replaceChildren(path);
}

function makeHandle(cls: string, cursor: string): HTMLDivElement {
  const handle = document.createElement('div');
  handle.className = 'handle ' + cls;
  handle.style.cursor = cursor;
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
  const only = selected.length === 1 ? selected[0] : null;
  if (only && only.type === 'text') {
    handles.push(makeHandle('e', 'ew-resize'));
  } else if (only && (only.type === 'image' || only.type === 'rect' || only.type === 'ellipse')) {
    handles.push(
      makeHandle('nw', 'nwse-resize'),
      makeHandle('ne', 'nesw-resize'),
      makeHandle('sw', 'nesw-resize'),
      makeHandle('se', 'nwse-resize')
    );
  }
  selectionBox.replaceChildren(...handles);
}
