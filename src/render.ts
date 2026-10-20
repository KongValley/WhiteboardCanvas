// SPDX-License-Identifier: GPL-3.0-or-later
import {
  El,
  PolyEl,
  Rect,
  arrowHeadPathD,
  arrowPathD,
  arrowShaftD,
  bounds,
  boundsUnion,
  dashArray,
  inkAbsolutePoints,
  listLines,
  nearestPointOnRotatedRect,
  polyPathD,
  rectPathD,
  rectsIntersect,
  rotationOf,
  smoothPathD,
  visualBounds
} from './model';
import { state } from './state';
import { uiText } from './ui-text';
import { view, viewport, world, worldViewRect } from './view';
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

/** 上次全量同步覆盖的世界坐标范围（含预取边距）；平移时落在范围内可跳过扫描 */
let syncedRect: Rect | null = null;
let syncedElements: El[] | null = null;
let syncedLength = -1;

/** 文本节点待测量队列：先写样式后统一读 offsetHeight，避免逐个强制重排 */
const pendingMeasure = new Map<HTMLDivElement, Extract<El, { type: 'text' }>>();
const textSig = new WeakMap<HTMLDivElement, string>();

export function setRenderHook(fn: () => void): void {
  renderHook = fn;
}

export function setEditing(value: boolean): void {
  editing = value;
}

function nodePadding(el: El): number {
  if (el.type === 'arrow') return el.strokeWidth + 16;
  if (el.type === 'ink') return el.width + 12;
  if (el.type === 'poly' || el.type === 'rect' || el.type === 'ellipse') return el.strokeWidth + 8;
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
      return uiText((el.sticky ? '便签：' : '文字：') + (el.text || '空').slice(0, 40));
    case 'image':
      return uiText('图片');
    case 'ink':
      return uiText(el.highlight ? '荧光笔迹' : '画笔笔迹');
    case 'rect':
      return uiText(el.label ? '矩形：' + el.label.slice(0, 40) : '矩形');
    case 'ellipse':
      return uiText(el.label ? '椭圆：' + el.label.slice(0, 40) : '椭圆');
    case 'arrow':
      return uiText(el.head ? '箭头' : '直线');
    case 'poly': {
      const name = uiText(
        { triangle: '三角形', diamond: '菱形', star: '五角星', roundrect: '圆角矩形', hexagon: '六边形', cylinder: '圆柱', cloud: '云', lane: '泳道' }[
          el.kind
        ]
      );
      return el.label ? name + '：' + el.label.slice(0, 40) : name;
    }
  }
}

/** 连接线端点跟随被连接元素边缘 */
export function refreshConnectors(movedIds?: ReadonlySet<string>): void {
  const elements = state.doc.elements;
  // 快速路径：只处理与移动集合相关的连接线，避免每帧重建全量索引
  let byId: Map<string, El> | null = null;
  for (const el of elements) {
    if (el.type !== 'arrow' || (!el.fromId && !el.toId)) continue;
    if (movedIds && !(movedIds.has(el.fromId || '') || movedIds.has(el.toId || ''))) continue;
    if (!byId) {
      byId = new Map();
      for (const item of elements) byId.set(item.id, item);
    }
    const from = el.fromId ? byId.get(el.fromId) : null;
    const to = el.toId ? byId.get(el.toId) : null;
    if (from) {
      const point = nearestPointOnRotatedRect(from, [el.x2, el.y2]);
      el.x1 = point[0];
      el.y1 = point[1];
    }
    if (to) {
      const point = nearestPointOnRotatedRect(to, [el.x1, el.y1]);
      el.x2 = point[0];
      el.y2 = point[1];
    }
    const node = nodeMap.get(el.id);
    if (node) applyNode(el, node);
  }
}

/** 视口预取边距（屏幕像素）：略大于半屏，平移时可跳过多次全量扫描 */
function cullMargin(): number {
  const w = viewport.clientWidth || 1280;
  const h = viewport.clientHeight || 800;
  return Math.max(200, Math.min(w, h) * 0.5);
}

function viewInsideSynced(): boolean {
  if (!syncedRect || syncedElements !== state.doc.elements || syncedLength !== state.doc.elements.length) return false;
  const vr = worldViewRect(0);
  return (
    vr.x >= syncedRect.x &&
    vr.y >= syncedRect.y &&
    vr.x + vr.w <= syncedRect.x + syncedRect.w &&
    vr.y + vr.h <= syncedRect.y + syncedRect.h
  );
}

function flushTextMeasure(): void {
  if (!pendingMeasure.size) return;
  for (const [div, el] of pendingMeasure) {
    if (!div.isConnected) continue;
    const measured = Math.max(el.fontSize * 1.4, div.offsetHeight);
    if (Math.abs(el.h - measured) > 0.5) el.h = measured;
  }
  pendingMeasure.clear();
}

/** 仅挂载视口附近的元素，千级元素时平移缩放不卡顿 */
export function syncNodes(force = false): void {
  const elements = state.doc.elements;
  if (!force && viewInsideSynced()) {
    hint.hidden = elements.length !== 0;
    return;
  }
  const vr = worldViewRect(cullMargin());
  const byId = new Map(elements.map((el) => [el.id, el]));
  for (const [id, node] of nodeMap) {
    const el = byId.get(id);
    if (!el || el.hidden || !rectsIntersect(visibleBounds(el), vr)) {
      node.remove();
      nodeMap.delete(id);
      pendingMeasure.delete(node as HTMLDivElement);
    }
  }
  // 新增节点按文档顺序就地插入（借用后一个已挂载节点作为锚点），避免整表 reorder
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.hidden || nodeMap.has(el.id)) continue;
    if (!rectsIntersect(visibleBounds(el), vr)) continue;
    const node = createNode(el);
    let anchor: ElNode | null = null;
    for (let j = i + 1; j < elements.length; j++) {
      const next = nodeMap.get(elements[j].id);
      if (next) {
        anchor = next;
        break;
      }
    }
    world.insertBefore(node, anchor ?? editor);
    nodeMap.set(el.id, node);
  }
  flushTextMeasure();
  syncedRect = vr;
  syncedElements = elements;
  syncedLength = elements.length;
  hint.hidden = elements.length !== 0;
  requestMinimap();
}

export function renderAll(): void {
  refreshConnectors();
  // 增量更新：复用已有 DOM 节点，避免整表重建（千级元素时明显更快）
  const elements = state.doc.elements;
  const alive = new Set<string>();
  for (const el of elements) alive.add(el.id);
  for (const [id, node] of nodeMap) {
    if (!alive.has(id)) {
      node.remove();
      nodeMap.delete(id);
      pendingMeasure.delete(node as HTMLDivElement);
    }
  }
  for (const el of elements) {
    const node = nodeMap.get(el.id);
    if (!node) continue;
    applyNode(el, node);
  }
  syncedRect = null;
  syncedElements = null;
  syncedLength = -1;
  syncNodes(true);
  ensureOrder();
  updateSelectionBox();
  renderHook();
}

/** 保证 DOM 顺序与元素顺序一致（图层顺序改变后调用）；元素节点位于 editor 之前 */
function ensureOrder(): void {
  let prev: ElNode | null = null;
  for (const el of state.doc.elements) {
    const node = nodeMap.get(el.id);
    if (!node) continue;
    const expected: ChildNode | null = prev ? prev.nextSibling : world.firstChild;
    if (expected !== node) {
      world.insertBefore(node, expected);
    }
    prev = node;
  }
}

export function updateElNode(el: El): void {
  const node = nodeMap.get(el.id);
  if (!node || el.hidden) {
    syncNodes(true);
    return;
  }
  applyNode(el, node);
  requestMinimap();
}

/** 批量更新：统一测量文本高度，避免逐个强制重排；未挂载元素只触发一次全量同步 */
export function updateElNodes(els: El[]): void {
  let missing = false;
  for (const el of els) {
    const node = nodeMap.get(el.id);
    if (!node || el.hidden) {
      missing = true;
      continue;
    }
    applyNode(el, node);
  }
  if (missing) syncNodes(true);
  flushTextMeasure();
  requestMinimap();
}

function createNode(el: El): ElNode {
  const node: ElNode =
    el.type === 'ink' || el.type === 'arrow' || el.type === 'poly' || el.type === 'rect' || el.type === 'ellipse'
      ? (document.createElementNS(SVG_NS, 'svg') as SVGSVGElement)
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
      s.opacity = String(el.opacity ?? 1);
      s.left = el.x + 'px';
      s.top = el.y + 'px';
      s.width = el.w + 'px';
      s.height = 'auto';
      s.minHeight = el.fontSize * 1.4 + 'px';
      applyTextStyle(el, s);
      s.background = el.sticky ? el.stickyColor || '#fef3c7' : 'transparent';
      s.borderRadius = el.sticky ? '4px' : '0';
      // 低配模式：10px 扩散阴影在软件光栅化下代价极高，改用等效边框
      s.boxShadow = el.sticky && !state.settings.lowSpec ? `0 0 0 10px ${el.stickyColor || '#fef3c7'}` : 'none';
      s.border = el.sticky && state.settings.lowSpec ? `10px solid ${el.stickyColor || '#fef3c7'}` : '';
      s.boxSizing = el.sticky && state.settings.lowSpec ? 'border-box' : '';
      s.padding = '0';
      const text = listLines(el.text, el.bullets, el.numbered).join('\n');
      if (div.textContent !== text) div.textContent = text;
      const sig =
        el.w + '|' + el.fontSize + '|' + (el.lineHeight || 1.4) + '|' + (el.fontFamily || '') + '|' +
        (el.bold ? 1 : 0) + (el.italic ? 1 : 0) + (el.underline ? 1 : 0) + (el.strike ? 1 : 0) + '|' +
        (el.align || 'left') + '|' + text;
      if (textSig.get(div) !== sig) {
        textSig.set(div, sig);
        pendingMeasure.set(div, el);
      }
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
      break;
    }
    case 'image': {
      s.opacity = String(el.opacity ?? 1);
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
      const pad = el.strokeWidth + 4;
      const b = bounds(el);
      s.left = b.x - pad + 'px';
      s.top = b.y - pad + 'px';
      s.width = Math.max(b.w + pad * 2, 1) + 'px';
      s.height = Math.max(b.h + pad * 2, 1) + 'px';
      const svg = node as SVGSVGElement;
      svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${Math.max(b.w + pad * 2, 1)} ${Math.max(b.h + pad * 2, 1)}`);
      svg.setAttribute('overflow', 'visible');
      s.opacity = String(el.opacity ?? 1);
      renderShape(svg, el);
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
      s.opacity = String(el.opacity ?? 1);
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
      // 低配模式：mix-blend-mode 需回读背景，软件光栅化下极慢，改用半透明叠加
      s.mixBlendMode = el.highlight && !state.settings.lowSpec ? 'multiply' : 'normal';
      s.opacity = String((el.opacity ?? 1) * (el.highlight ? 0.35 : 1));
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
      s.opacity = String(el.opacity ?? 1);
      renderArrowPath(svg, el);
      s.transform = rotation ? `rotate(${rotation}deg)` : '';
      break;
    }
  }
}

function svgChild(svg: SVGSVGElement, index: number, tag: string): SVGElement {
  const current = svg.childNodes[index] as SVGElement | undefined;
  if (current && current.nodeName.toLowerCase() === tag) return current;
  const node = document.createElementNS(SVG_NS, tag);
  if (current) svg.replaceChild(node, current);
  else svg.appendChild(node);
  return node;
}

function shrinkSvg(svg: SVGSVGElement, count: number): void {
  while (svg.childNodes.length > count) svg.removeChild(svg.lastChild as Node);
}

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function dropAttr(node: Element, name: string): void {
  if (node.hasAttribute(name)) node.removeAttribute(name);
}

function renderInkPath(svg: SVGSVGElement, el: Extract<El, { type: 'ink' }>): void {
  const path = svgChild(svg, 0, 'path');
  setAttr(path, 'd', smoothPathD(inkAbsolutePoints(el)));
  setAttr(path, 'fill', 'none');
  setAttr(path, 'stroke', el.color);
  setAttr(path, 'stroke-width', String(el.width));
  setAttr(path, 'stroke-linecap', 'round');
  setAttr(path, 'stroke-linejoin', 'round');
  shrinkSvg(svg, 1);
}

function renderShape(svg: SVGSVGElement, el: Extract<El, { type: 'rect' | 'ellipse' }>): void {
  const b = bounds(el);
  const shape = svgChild(svg, 0, el.type === 'rect' ? 'path' : 'ellipse');
  if (el.type === 'rect') {
    setAttr(shape, 'd', rectPathD(el));
  } else {
    setAttr(shape, 'cx', String(b.x + b.w / 2));
    setAttr(shape, 'cy', String(b.y + b.h / 2));
    setAttr(shape, 'rx', String(Math.max(b.w / 2, 0)));
    setAttr(shape, 'ry', String(Math.max(b.h / 2, 0)));
  }
  setAttr(shape, 'fill', el.fill || 'none');
  setAttr(shape, 'stroke', el.stroke);
  setAttr(shape, 'stroke-width', String(el.strokeWidth));
  setAttr(shape, 'stroke-linejoin', 'round');
  const dash = dashArray(el.dash, el.strokeWidth);
  if (dash) {
    setAttr(shape, 'stroke-dasharray', dash.join(' '));
    setAttr(shape, 'stroke-linecap', 'round');
  } else {
    dropAttr(shape, 'stroke-dasharray');
    dropAttr(shape, 'stroke-linecap');
  }
  let count = 1;
  if (el.label) {
    const text = svgChild(svg, 1, 'text');
    setAttr(text, 'x', String(b.x + b.w / 2));
    setAttr(text, 'y', String(b.y + b.h / 2));
    setAttr(text, 'text-anchor', 'middle');
    setAttr(text, 'dominant-baseline', 'middle');
    setAttr(text, 'font-family', FONT);
    setAttr(text, 'font-size', '16');
    setAttr(text, 'fill', '#1f2937');
    if (text.textContent !== el.label) text.textContent = el.label;
    count = 2;
  }
  shrinkSvg(svg, count);
}

function renderPolyPath(svg: SVGSVGElement, el: PolyEl): void {
  const path = svgChild(svg, 0, 'path');
  setAttr(path, 'd', polyPathD(el));
  setAttr(path, 'fill', el.fill || 'none');
  setAttr(path, 'stroke', el.stroke);
  setAttr(path, 'stroke-width', String(el.strokeWidth));
  setAttr(path, 'stroke-linejoin', 'round');
  const dash = dashArray(el.dash, el.strokeWidth);
  if (dash) {
    setAttr(path, 'stroke-dasharray', dash.join(' '));
    setAttr(path, 'stroke-linecap', 'round');
  } else {
    dropAttr(path, 'stroke-dasharray');
    dropAttr(path, 'stroke-linecap');
  }
  let count = 1;
  const b = bounds(el);
  if (el.label) {
    const text = svgChild(svg, 1, 'text');
    setAttr(text, 'x', String(b.x + b.w / 2));
    setAttr(text, 'y', String(b.y + b.h / 2));
    setAttr(text, 'text-anchor', 'middle');
    setAttr(text, 'dominant-baseline', 'middle');
    setAttr(text, 'font-family', FONT);
    setAttr(text, 'font-size', '16');
    setAttr(text, 'fill', '#1f2937');
    if (text.textContent !== el.label) text.textContent = el.label;
    count = 2;
  }
  shrinkSvg(svg, count);
}

function renderArrowPath(svg: SVGSVGElement, el: Extract<El, { type: 'arrow' }>): void {
  const dash = dashArray(el.dash, el.strokeWidth);
  const path = svgChild(svg, 0, 'path');
  setAttr(path, 'd', dash ? arrowShaftD(el) : arrowPathD(el));
  setAttr(path, 'fill', 'none');
  setAttr(path, 'stroke', el.stroke);
  setAttr(path, 'stroke-width', String(el.strokeWidth));
  setAttr(path, 'stroke-linecap', 'round');
  setAttr(path, 'stroke-linejoin', 'round');
  if (dash) setAttr(path, 'stroke-dasharray', dash.join(' '));
  else dropAttr(path, 'stroke-dasharray');
  let count = 1;
  if (dash) {
    const headD = arrowHeadPathD(el);
    if (headD) {
      const head = svgChild(svg, 1, 'path');
      setAttr(head, 'd', headD);
      setAttr(head, 'fill', 'none');
      setAttr(head, 'stroke', el.stroke);
      setAttr(head, 'stroke-width', String(el.strokeWidth));
      setAttr(head, 'stroke-linecap', 'round');
      setAttr(head, 'stroke-linejoin', 'round');
      count = 2;
    }
  }
  if (el.label) {
    const text = svgChild(svg, count, 'text');
    const mx = (el.x1 + el.x2) / 2;
    const my = (el.y1 + el.y2) / 2;
    setAttr(text, 'x', String(mx));
    setAttr(text, 'y', String(my - 6));
    setAttr(text, 'text-anchor', 'middle');
    setAttr(text, 'font-size', '14');
    setAttr(text, 'fill', el.stroke);
    setAttr(text, 'stroke', '#ffffff');
    setAttr(text, 'stroke-width', '3');
    setAttr(text, 'paint-order', 'stroke');
    setAttr(text, 'font-family', FONT);
    if (text.textContent !== el.label) text.textContent = el.label;
    count += 1;
  }
  shrinkSvg(svg, count);
}

function makeHandle(cls: string, cursor: string, left?: number, top?: number): HTMLDivElement {
  const handle = document.createElement('div');
  handle.className = 'handle ' + cls;
  handle.style.cursor = cursor;
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', cls === 'rot' ? '旋转' : cls === 'p1' || cls === 'p2' ? '端点' : '缩放');
  if (left !== undefined && top !== undefined) {
    handle.style.left = left + 'px';
    handle.style.top = top + 'px';
    handle.style.transform = 'translate(-50%, -50%)';
  }
  return handle;
}

let selectionSig = '';

export function updateSelectionBox(): void {
  if (editing) {
    selectionBox.hidden = true;
    return;
  }
  const ids = new Set(state.selectedIds);
  const selected = state.doc.elements.filter((el) => ids.has(el.id) && !el.hidden);
  if (!selected.length) {
    if (!selectionBox.hidden || selectionBox.childElementCount) {
      selectionBox.hidden = true;
      selectionBox.replaceChildren();
    }
    selectionSig = '';
    return;
  }
  const only = selected.length === 1 ? selected[0] : null;
  const rotation = only ? rotationOf(only) : 0;
  const b = rotation && only ? bounds(only) : boundsUnion(selected);
  if (!b) {
    selectionBox.hidden = true;
    selectionBox.replaceChildren();
    return;
  }
  selectionBox.hidden = false;
  selectionBox.classList.toggle('multi', selected.length > 1);
  selectionBox.classList.toggle('locked', selected.every((el) => el.locked));
  selectionBox.style.transformOrigin = '50% 50%';
  selectionBox.style.transform = rotation ? `rotate(${rotation}deg)` : '';
  selectionBox.style.left = view.pan.x + b.x * view.zoom + 'px';
  selectionBox.style.top = view.pan.y + b.y * view.zoom + 'px';
  selectionBox.style.width = Math.max(b.w * view.zoom, 1) + 'px';
  selectionBox.style.height = Math.max(b.h * view.zoom, 1) + 'px';
  const handles: HTMLDivElement[] = [];
  const onlySel = selected.length === 1 ? selected[0] : null;
  const sig =
    selected.map((el) => el.id).join(',') +
    '|' + (state.readOnly ? 1 : 0) +
    '|' + (selected.every((el) => el.locked) ? 1 : 0) +
    '|' + (onlySel && onlySel.type === 'arrow' ? `${onlySel.x1},${onlySel.y1},${onlySel.x2},${onlySel.y2}` : '');
  if (sig === selectionSig) return;
  selectionSig = sig;
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
      handles.push(makeHandle('w', 'ew-resize'), makeHandle('e', 'ew-resize'));
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
  selectionBox.replaceChildren(...(state.readOnly ? [] : handles));
}

/** 供导出使用：绘制矩形/多边形路径 */
export function rectOrPolyPath(el: El): string | null {
  if (el.type === 'rect') return rectPathD(el);
  if (el.type === 'poly') return polyPathD(el);
  return null;
}
