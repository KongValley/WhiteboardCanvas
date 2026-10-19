// SPDX-License-Identifier: GPL-3.0-or-later
import { bounds, boundsUnion } from './model';
import { state } from './state';
import { setZoomAtWorld, view, viewport, worldViewRect } from './view';

const box = document.getElementById('minimap') as HTMLDivElement;
const canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
const body = document.getElementById('minimap-body') as HTMLDivElement;
const toggle = document.getElementById('minimap-toggle') as HTMLButtonElement;

const WIDTH = 180;
const HEIGHT = 120;
let raf = 0;
let collapsing = localStorage.getItem('wbc-minimap-collapsed') === '1';
let lastRect = { x: 0, y: 0, w: 1, h: 1, scale: 1, ox: 0, oy: 0 };

export function requestMinimap(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

function applyCollapsed(): void {
  body.hidden = collapsing;
  toggle.textContent = collapsing ? '+' : '−';
  toggle.setAttribute('aria-expanded', collapsing ? 'false' : 'true');
}

function draw(): void {
  if (body.hidden) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (canvas.width !== Math.round(WIDTH * dpr)) canvas.width = Math.round(WIDTH * dpr);
  if (canvas.height !== Math.round(HEIGHT * dpr)) canvas.height = Math.round(HEIGHT * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = 'rgba(248,250,252,0.95)';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const vr = worldViewRect(0);
  const content = boundsUnion(state.doc.elements);
  const left = content ? Math.min(content.x, vr.x) : vr.x;
  const top = content ? Math.min(content.y, vr.y) : vr.y;
  const right = content ? Math.max(content.x + content.w, vr.x + vr.w) : vr.x + vr.w;
  const bottom = content ? Math.max(content.y + content.h, vr.y + vr.h) : vr.y + vr.h;
  const pad = Math.max(20, Math.min(right - left, bottom - top) * 0.05);
  const rect = { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
  const scale = Math.min(WIDTH / Math.max(rect.w, 1), HEIGHT / Math.max(rect.h, 1));
  const ox = (WIDTH - rect.w * scale) / 2;
  const oy = (HEIGHT - rect.h * scale) / 2;
  lastRect = { ...rect, scale, ox, oy };

  const toX = (x: number) => ox + (x - rect.x) * scale;
  const toY = (y: number) => oy + (y - rect.y) * scale;

  const selected = new Set(state.selectedIds);
  for (const el of state.doc.elements) {
    const b = bounds(el);
    const accent = selected.has(el.id);
    ctx.strokeStyle = accent ? '#2563eb' : 'rgba(71,85,105,0.75)';
    ctx.fillStyle = accent ? 'rgba(37,99,235,0.25)' : 'rgba(100,116,139,0.18)';
    ctx.lineWidth = 1;
    if (el.type === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(toX(el.x1), toY(el.y1));
      ctx.lineTo(toX(el.x2), toY(el.y2));
      ctx.stroke();
      continue;
    }
    if (el.type === 'ink' || el.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(toX(b.x + b.w / 2), toY(b.y + b.h / 2), Math.max((b.w * scale) / 2, 1), Math.max((b.h * scale) / 2, 1), 0, 0, Math.PI * 2);
      if (el.type === 'ink') ctx.stroke();
      else {
        ctx.fill();
        ctx.stroke();
      }
      continue;
    }
    ctx.fillRect(toX(b.x), toY(b.y), Math.max(b.w * scale, 1.5), Math.max(b.h * scale, 1.5));
    if (el.type === 'rect') ctx.strokeRect(toX(b.x), toY(b.y), Math.max(b.w * scale, 1), Math.max(b.h * scale, 1));
  }

  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(toX(vr.x), toY(vr.y), Math.max(vr.w * scale, 2), Math.max(vr.h * scale, 2));
}

function jumpTo(clientX: number, clientY: number): void {
  const r = canvas.getBoundingClientRect();
  const mx = clientX - r.left;
  const my = clientY - r.top;
  const wx = lastRect.x + (mx - lastRect.ox) / lastRect.scale;
  const wy = lastRect.y + (my - lastRect.oy) / lastRect.scale;
  setZoomAtWorld(wx, wy, view.zoom);
  requestMinimap();
}

export function installMinimap(): void {
  applyCollapsed();
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    collapsing = !collapsing;
    localStorage.setItem('wbc-minimap-collapsed', collapsing ? '1' : '0');
    applyCollapsed();
    requestMinimap();
  });
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    jumpTo(e.clientX, e.clientY);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件 */
    }
    const move = (ev: PointerEvent) => jumpTo(ev.clientX, ev.clientY);
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  });
  requestMinimap();
}

export function minimapVisible(): boolean {
  return !!viewport && !body.hidden;
}
