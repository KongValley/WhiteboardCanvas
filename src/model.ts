// SPDX-License-Identifier: GPL-3.0-or-later
export type Pt = [number, number];
export type Tool =
  | 'select'
  | 'lasso'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'sticky'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'poly';
export type PolyKind = 'triangle' | 'diamond' | 'star' | 'roundrect';
export type ElType = 'text' | 'image' | 'ink' | 'rect' | 'ellipse' | 'arrow' | 'poly';
export type Align = 'left' | 'center' | 'right';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
  /** 顺时针角度，写入文件 */
  rotation?: number;
  groupId?: string;
  locked?: boolean;
  hidden?: boolean;
  /** 图层面板显示名 */
  name?: string;
}

export interface TextEl extends Base {
  type: 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  color: string;
  fontFamily?: string;
  lineHeight?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  bullets?: boolean;
  align?: Align;
  sticky?: boolean;
  stickyColor?: string;
}

export interface ImageEl extends Base {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  /** 源图归一化裁剪区域（0..1） */
  crop?: Rect;
  flipH?: boolean;
  flipV?: boolean;
  mime?: string;
}

export interface InkEl extends Base {
  type: 'ink';
  x: number;
  y: number;
  w: number;
  h: number;
  points: Pt[];
  color: string;
  width: number;
  highlight?: boolean;
}

export interface RectEl extends Base {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  radius?: number;
}

export interface EllipseEl extends Base {
  type: 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
}

export interface ArrowEl extends Base {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  /** false 表示直线（无箭头）；旧文件缺省为 true */
  head: boolean;
  label?: string;
  fromId?: string;
  toId?: string;
}

export interface PolyEl extends Base {
  type: 'poly';
  x: number;
  y: number;
  w: number;
  h: number;
  kind: PolyKind;
  stroke: string;
  strokeWidth: number;
  fill: string;
  radius?: number;
}

export type El = TextEl | ImageEl | InkEl | RectEl | EllipseEl | ArrowEl | PolyEl;

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function rotationOf(el: El): number {
  return el.rotation || 0;
}

export function centerOf(el: El): Pt {
  const b = bounds(el);
  return [b.x + b.w / 2, b.y + b.h / 2];
}

export function rotatePoint(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
}

export function bounds(el: El): Rect {
  if (el.type === 'arrow') {
    return {
      x: Math.min(el.x1, el.x2),
      y: Math.min(el.y1, el.y2),
      w: Math.abs(el.x2 - el.x1),
      h: Math.abs(el.y2 - el.y1)
    };
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

/** 旋转后的轴对齐包围盒（选择框/导出/框选使用） */
export function visualBounds(el: El): Rect {
  const b = bounds(el);
  if (!el.rotation) return b;
  const c: Pt = [b.x + b.w / 2, b.y + b.h / 2];
  const pts: Pt[] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h]
  ].map((p) => rotatePoint(p as Pt, c, el.rotation || 0));
  return boundsOfPoints(pts);
}

export function boundsOfPoints(points: Pt[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function boundsUnion(els: El[]): Rect | null {
  if (!els.length) return null;
  const points: Pt[] = [];
  for (const el of els) {
    const b = bounds(el);
    const c: Pt = [b.x + b.w / 2, b.y + b.h / 2];
    const corners: Pt[] = [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h]
    ];
    if (el.rotation) corners.forEach((p) => points.push(rotatePoint(p, c, el.rotation || 0)));
    else points.push(...corners);
  }
  return boundsOfPoints(points);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

export function inkAbsolutePoints(el: InkEl): Pt[] {
  return el.points.map(([dx, dy]) => [el.x + dx, el.y + dy] as Pt);
}

export function smoothPathD(points: Pt[]): string {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]} l 0.01 0`;
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    d += ` Q ${points[i][0]} ${points[i][1]} ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

export function tracePoints(ctx: CanvasRenderingContext2D, points: Pt[]): void {
  if (!points.length) return;
  ctx.beginPath();
  if (points.length === 1) {
    ctx.moveTo(points[0][0], points[0][1]);
    ctx.lineTo(points[0][0] + 0.01, points[0][1]);
    return;
  }
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    ctx.quadraticCurveTo(points[i][0], points[i][1], mx, my);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
}

export function arrowHeadPoints(el: ArrowEl): [Pt, Pt] {
  const dx = el.x2 - el.x1;
  const dy = el.y2 - el.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = 10 + el.strokeWidth * 2;
  const angle = Math.PI / 7.2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const bx = el.x2 - ux * head;
  const by = el.y2 - uy * head;
  const rotate = (sign: number): Pt => {
    const vx = bx - el.x2;
    const vy = by - el.y2;
    return [el.x2 + vx * cos - sign * vy * sin, el.y2 + sign * vx * sin + vy * cos];
  };
  return [rotate(1), rotate(-1)];
}

export function arrowPathD(el: ArrowEl): string {
  if (!el.head) return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`;
  const [h1, h2] = arrowHeadPoints(el);
  return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2} M ${h1[0]} ${h1[1]} L ${el.x2} ${el.y2} M ${h2[0]} ${h2[1]} L ${el.x2} ${el.y2}`;
}

export function polyVertices(el: PolyEl): Pt[] {
  const b = bounds(el);
  const x = b.x;
  const y = b.y;
  const w = b.w;
  const h = b.h;
  if (el.kind === 'triangle') return [[x + w / 2, y], [x + w, y + h], [x, y + h]];
  if (el.kind === 'diamond') return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
  if (el.kind === 'star') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const pts: Pt[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? Math.min(w, h) / 2 : Math.min(w, h) / 5;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  }
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ];
}

export function polyPathD(el: PolyEl): string {
  if (el.kind === 'roundrect') {
    const b = bounds(el);
    const r = Math.min(el.radius || Math.min(b.w, b.h) * 0.15, b.w / 2, b.h / 2);
    return `M ${b.x + r} ${b.y} H ${b.x + b.w - r} Q ${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + r} V ${b.y + b.h - r} Q ${b.x + b.w} ${b.y + b.h} ${b.x + b.w - r} ${b.y + b.h} H ${b.x + r} Q ${b.x} ${b.y + b.h} ${b.x} ${b.y + b.h - r} V ${b.y + r} Q ${b.x} ${b.y} ${b.x + r} ${b.y} Z`;
  }
  return polyVertices(el)
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`)
    .join(' ') + ' Z';
}

export function rectPathD(el: RectEl): string {
  const b = bounds(el);
  const r = Math.min(el.radius || 0, b.w / 2, b.h / 2);
  if (r <= 0) return `M ${b.x} ${b.y} H ${b.x + b.w} V ${b.y + b.h} H ${b.x} Z`;
  return `M ${b.x + r} ${b.y} H ${b.x + b.w - r} Q ${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + r} V ${b.y + b.h - r} Q ${b.x + b.w} ${b.y + b.h} ${b.x + b.w - r} ${b.y + b.h} H ${b.x + r} Q ${b.x} ${b.y + b.h} ${b.x} ${b.y + b.h - r} V ${b.y + r} Q ${b.x} ${b.y} ${b.x + r} ${b.y} Z`;
}

function pointInPolygon(p: Pt, verts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 0.000001) + xi) inside = !inside;
  }
  return inside;
}

export function nearestPointOnRect(b: Rect, p: Pt): Pt {
  const cx = Math.max(b.x, Math.min(p[0], b.x + b.w));
  const cy = Math.max(b.y, Math.min(p[1], b.y + b.h));
  if (p[0] < b.x) return [b.x, cy];
  if (p[0] > b.x + b.w) return [b.x + b.w, cy];
  if (p[1] < b.y) return [cx, b.y];
  if (p[1] > b.y + b.h) return [cx, b.y + b.h];
  const d = [p[0] - b.x, b.x + b.w - p[0], p[1] - b.y, b.y + b.h - p[1]];
  const min = Math.min(...d);
  if (min === d[0]) return [b.x, p[1]];
  if (min === d[1]) return [b.x + b.w, p[1]];
  if (min === d[2]) return [p[0], b.y];
  return [p[0], b.y + b.h];
}

export function moveEl(el: El, dx: number, dy: number): void {
  if (el.type === 'arrow') {
    el.x1 += dx;
    el.y1 += dy;
    el.x2 += dx;
    el.y2 += dy;
    return;
  }
  el.x += dx;
  el.y += dy;
}

export function normalizeInk(points: Pt[]): { x: number; y: number; w: number; h: number; points: Pt[] } {
  const b = boundsOfPoints(points);
  if (!Number.isFinite(b.x)) return { x: 0, y: 0, w: 0, h: 0, points: [] };
  return {
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    points: points.map(([x, y]) => [x - b.x, y - b.y] as Pt)
  };
}

function insideShape(el: RectEl | EllipseEl | PolyEl, p: Pt): boolean {
  const b = bounds(el);
  if (el.type === 'poly') {
    if (el.kind === 'roundrect') {
      const r = Math.min(el.radius || Math.min(b.w, b.h) * 0.15, b.w / 2, b.h / 2);
      const cx = Math.max(b.x + r, Math.min(p[0], b.x + b.w - r));
      const cy = Math.max(b.y + r, Math.min(p[1], b.y + b.h - r));
      return Math.hypot(p[0] - cx, p[1] - cy) <= r + 0.001 || (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h);
    }
    return pointInPolygon(p, polyVertices(el));
  }
  if (el.type === 'rect') {
    return p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
  }
  const rx = Math.max(b.w / 2, 0.001);
  const ry = Math.max(b.h / 2, 0.001);
  const k = Math.hypot((p[0] - (b.x + rx)) / rx, (p[1] - (b.y + ry)) / ry);
  return k <= 1;
}

function hitEl(el: El, raw: Pt, tol: number): boolean {
  const p = el.rotation ? rotatePoint(raw, centerOf(el), -el.rotation) : raw;
  switch (el.type) {
    case 'text':
    case 'image':
      return p[0] >= el.x - 2 && p[0] <= el.x + el.w + 2 && p[1] >= el.y - 2 && p[1] <= el.y + el.h + 2;
    case 'rect': {
      if (el.fill && insideShape(el, p)) return true;
      const b = bounds(el);
      if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) {
        const d = Math.min(p[0] - b.x, b.x + b.w - p[0], p[1] - b.y, b.y + b.h - p[1]);
        return d <= tol;
      }
      return false;
    }
    case 'poly': {
      if (el.fill && insideShape(el, p)) return true;
      const verts = el.kind === 'roundrect' ? polyVertices(el) : polyVertices(el);
      for (let i = 0; i < verts.length; i++) {
        if (distToSegment(p, verts[i], verts[(i + 1) % verts.length]) <= tol) return true;
      }
      return false;
    }
    case 'ellipse': {
      const b = bounds(el);
      const rx = Math.max(b.w / 2, 0.001);
      const ry = Math.max(b.h / 2, 0.001);
      const k = Math.hypot((p[0] - (b.x + rx)) / rx, (p[1] - (b.y + ry)) / ry);
      if (el.fill && k <= 1) return true;
      return Math.abs(k - 1) * Math.min(rx, ry) <= tol;
    }
    case 'arrow':
      return distToSegment(p, [el.x1, el.y1], [el.x2, el.y2]) <= el.strokeWidth / 2 + tol;
    case 'ink': {
      const pts = inkAbsolutePoints(el);
      if (!pts.length) return false;
      if (pts.length === 1) {
        return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= el.width / 2 + tol;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(p, pts[i], pts[i + 1]) <= el.width / 2 + tol) return true;
      }
      return false;
    }
  }
}

export interface HitOptions {
  ignoreLocked?: boolean;
  ignoreHidden?: boolean;
}

export function hitTest(els: El[], p: Pt, tol: number, opts: HitOptions = {}): El | null {
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (opts.ignoreHidden && el.hidden) continue;
    if (opts.ignoreLocked && el.locked) continue;
    if (hitEl(el, p, tol)) return el;
  }
  return null;
}

const MAX_TEXT = 200000;
const MAX_POINTS = 200000;
const MAX_SRC = 96 * 1024 * 1024;
const MAX_COORD = 1e7;
const COLOR_RE = /^(#(?:[0-9a-f]{3,8})|rgba?\([0-9.,%\s/]+\)|transparent)$/i;
const ALIGN = ['left', 'center', 'right'];
const POLY_KINDS: PolyKind[] = ['triangle', 'diamond', 'star', 'roundrect'];

function num(value: unknown, max = MAX_COORD): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max ? value : null;
}

function bool(value: unknown): boolean | undefined {
  return value === true ? true : undefined;
}

function isPt(value: unknown): value is Pt {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number' &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= MAX_COORD && Math.abs(value[1]) <= MAX_COORD;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function color(value: unknown): string {
  return typeof value === 'string' && value.length <= 64 && COLOR_RE.test(value) ? value : '#1f2937';
}

function fillColor(value: unknown): string {
  return typeof value === 'string' && value.length <= 64 && COLOR_RE.test(value) ? value : '';
}

function base(raw: Record<string, unknown>, fallbackId: string): Omit<Base, never> {
  const out: Base = { id: str(raw.id, 64) || fallbackId };
  const rotation = num(raw.rotation, 3600);
  if (rotation) out.rotation = rotation;
  const groupId = str(raw.groupId, 64);
  if (groupId) out.groupId = groupId;
  const name = str(raw.name, 200);
  if (name) out.name = name;
  if (raw.locked === true) out.locked = true;
  if (raw.hidden === true) out.hidden = true;
  return out;
}

export function sanitizeEl(raw: unknown): El | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const id = str(o.id, 64) || uid();
    const common = base(o, id);
    const stroke = color(o.stroke);

    switch (o.type) {
      case 'text': {
        const x = num(o.x);
        const y = num(o.y);
        const w = num(o.w);
        const h = num(o.h);
        const fontSize = num(o.fontSize, 512);
        if (x === null || y === null || w === null || h === null || fontSize === null || fontSize < 1) return null;
        const align = typeof o.align === 'string' && ALIGN.includes(o.align) ? (o.align as Align) : undefined;
        const lineHeight = num(o.lineHeight, 2);
        return {
          ...common,
          type: 'text',
          x,
          y,
          w,
          h,
          text: str(o.text, MAX_TEXT) ?? '',
          fontSize,
          color: color(o.color),
          fontFamily: str(o.fontFamily, 80) || undefined,
          lineHeight: lineHeight !== null && lineHeight >= 1 ? lineHeight : undefined,
          bold: bool(o.bold),
          italic: bool(o.italic),
          underline: bool(o.underline),
          strike: bool(o.strike),
          bullets: bool(o.bullets),
          align,
          sticky: bool(o.sticky),
          stickyColor: str(o.stickyColor, 64) && COLOR_RE.test(String(o.stickyColor)) ? String(o.stickyColor) : undefined
        };
      }
      case 'image': {
        const x = num(o.x);
        const y = num(o.y);
        const w = num(o.w);
        const h = num(o.h);
        const src = str(o.src, MAX_SRC);
        if (x === null || y === null || w === null || h === null) return null;
        if (!src || !src.startsWith('data:image/')) return null;
        let crop: Rect | undefined;
        if (o.crop && typeof o.crop === 'object') {
          const c = o.crop as Record<string, unknown>;
          const cx = num(c.x, 1);
          const cy = num(c.y, 1);
          const cw = num(c.w, 1);
          const ch = num(c.h, 1);
          if (cx !== null && cy !== null && cw !== null && ch !== null && cw > 0 && ch > 0) {
            crop = { x: Math.max(0, cx), y: Math.max(0, cy), w: Math.min(cw, 1), h: Math.min(ch, 1) };
          }
        }
        return {
          ...common,
          type: 'image',
          x,
          y,
          w,
          h,
          src,
          crop,
          flipH: bool(o.flipH),
          flipV: bool(o.flipV),
          mime: str(o.mime, 64) || undefined
        };
      }
      case 'ink': {
        const x = num(o.x);
        const y = num(o.y);
        const w = num(o.w);
        const h = num(o.h);
        const width = num(o.width, 400);
        if (x === null || y === null || w === null || h === null || width === null || width < 1) return null;
        const points = Array.isArray(o.points) ? o.points.filter(isPt).slice(0, MAX_POINTS) : [];
        if (!points.length) return null;
        return {
          ...common,
          type: 'ink',
          x,
          y,
          w,
          h,
          points,
          color: color(o.color),
          width,
          highlight: o.highlight === true
        };
      }
      case 'rect':
      case 'ellipse': {
        const x = num(o.x);
        const y = num(o.y);
        const w = num(o.w);
        const h = num(o.h);
        const strokeWidth = num(o.strokeWidth, 100);
        if (x === null || y === null || w === null || h === null || strokeWidth === null || strokeWidth < 0.5) return null;
        const radius = num(o.radius, 100000);
        return {
          ...common,
          type: o.type,
          x,
          y,
          w,
          h,
          stroke,
          strokeWidth,
          fill: fillColor(o.fill),
          radius: o.type === 'rect' && radius !== null && radius > 0 ? radius : undefined
        };
      }
      case 'poly': {
        const x = num(o.x);
        const y = num(o.y);
        const w = num(o.w);
        const h = num(o.h);
        const strokeWidth = num(o.strokeWidth, 100);
        if (x === null || y === null || w === null || h === null || strokeWidth === null || strokeWidth < 0.5) return null;
        if (typeof o.kind !== 'string' || !POLY_KINDS.includes(o.kind as PolyKind)) return null;
        const radius = num(o.radius, 100000);
        return {
          ...common,
          type: 'poly',
          x,
          y,
          w,
          h,
          kind: o.kind as PolyKind,
          stroke,
          strokeWidth,
          fill: fillColor(o.fill),
          radius: radius !== null && radius > 0 ? radius : undefined
        };
      }
      case 'arrow': {
        const x1 = num(o.x1);
        const y1 = num(o.y1);
        const x2 = num(o.x2);
        const y2 = num(o.y2);
        const strokeWidth = num(o.strokeWidth, 100);
        if (x1 === null || y1 === null || x2 === null || y2 === null || strokeWidth === null || strokeWidth < 0.5) return null;
        return {
          ...common,
          type: 'arrow',
          x1,
          y1,
          x2,
          y2,
          stroke,
          strokeWidth,
          head: o.head !== false,
          label: str(o.label, 2000) || undefined,
          fromId: str(o.fromId, 64) || undefined,
          toId: str(o.toId, 64) || undefined
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
