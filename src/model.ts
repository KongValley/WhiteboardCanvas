// SPDX-License-Identifier: GPL-3.0-or-later
export type Pt = [number, number];
export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'rect' | 'ellipse' | 'arrow' | 'line';
export type ElType = 'text' | 'image' | 'ink' | 'rect' | 'ellipse' | 'arrow';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Base {
  id: string;
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
}

export interface ImageEl extends Base {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
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
}

export type El = TextEl | ImageEl | InkEl | RectEl | EllipseEl | ArrowEl;

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

export function boundsUnion(els: El[]): Rect | null {
  if (!els.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    const b = bounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0, points: [] };
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    points: points.map(([x, y]) => [x - minX, y - minY] as Pt)
  };
}

/** 判断点是否在形状内部（含填充时用于命中） */
function insideShape(el: RectEl | EllipseEl, p: Pt): boolean {
  const b = bounds(el);
  if (el.type === 'rect') {
    return p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
  }
  const rx = Math.max(b.w / 2, 0.001);
  const ry = Math.max(b.h / 2, 0.001);
  const k = Math.hypot((p[0] - (b.x + rx)) / rx, (p[1] - (b.y + ry)) / ry);
  return k <= 1;
}

function hitEl(el: El, p: Pt, tol: number): boolean {
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
      const ddx = Math.max(b.x - p[0], 0, p[0] - (b.x + b.w));
      const ddy = Math.max(b.y - p[1], 0, p[1] - (b.y + b.h));
      return Math.hypot(ddx, ddy) <= tol;
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

export function hitTest(els: El[], p: Pt, tol: number): El | null {
  for (let i = els.length - 1; i >= 0; i--) {
    if (hitEl(els[i], p, tol)) return els[i];
  }
  return null;
}

const MAX_TEXT = 200000;
const MAX_POINTS = 200000;
const MAX_SRC = 96 * 1024 * 1024;
const MAX_COORD = 1e7;
const COLOR_RE = /^(#(?:[0-9a-f]{3,8})|rgba?\([0-9.,%\s/]+\)|transparent)$/i;

function num(value: unknown, max = MAX_COORD): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max ? value : null;
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

export function sanitizeEl(raw: unknown): El | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const id = str(o.id, 64) || uid();
    const stroke = color(o.stroke);

    switch (o.type) {
      case 'text': {
        const x = num(o.x);
        const y = num(o.y);
        const w = num(o.w);
        const h = num(o.h);
        const fontSize = num(o.fontSize, 512);
        if (x === null || y === null || w === null || h === null || fontSize === null || fontSize < 1) return null;
        return {
          id,
          type: 'text',
          x,
          y,
          w,
          h,
          text: str(o.text, MAX_TEXT) ?? '',
          fontSize,
          color: color(o.color)
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
        return { id, type: 'image', x, y, w, h, src };
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
          id,
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
        return { id, type: o.type, x, y, w, h, stroke, strokeWidth, fill: fillColor(o.fill) };
      }
      case 'arrow': {
        const x1 = num(o.x1);
        const y1 = num(o.y1);
        const x2 = num(o.x2);
        const y2 = num(o.y2);
        const strokeWidth = num(o.strokeWidth, 100);
        if (x1 === null || y1 === null || x2 === null || y2 === null || strokeWidth === null || strokeWidth < 0.5) return null;
        return { id, type: 'arrow', x1, y1, x2, y2, stroke, strokeWidth, head: o.head !== false };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
