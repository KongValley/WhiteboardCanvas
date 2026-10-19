// SPDX-License-Identifier: GPL-3.0-or-later
const svg = (body: string, size = 20): string =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS: Record<string, string> = {
  select: '<path d="M4 3l11 5-5 1.6L8 15z"/>',
  lasso: '<ellipse cx="10" cy="8.5" rx="7" ry="4.5" stroke-dasharray="2.5 2"/><path d="M6 12.5c-1 2-1 3.5 0 4.5"/>',
  pen: '<path d="M4 16l1.2-4L14 3.2a1.6 1.6 0 012.3 0l.5.5a1.6 1.6 0 010 2.3L8 15z"/><path d="M12.5 4.5l3 3"/>',
  highlighter: '<path d="M5 15l2-5 7-7 4 4-7 7z"/><path d="M5 15h-2v3h5v-2"/>',
  eraser: '<path d="M4 14l6-9 7 5-5.5 7H7z"/><path d="M7 17h10"/>',
  text: '<path d="M4 4h12M10 4v13M7 17h6"/>',
  sticky: '<path d="M4 4h12v8l-4 5H4z"/><path d="M12 17v-5h4"/>',
  rect: '<rect x="3.5" y="5" width="13" height="10" rx="1"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="6.5" ry="5"/>',
  arrow: '<path d="M3 17L17 3M10 3h7v7"/>',
  line: '<path d="M3 17L17 3"/>',
  triangle: '<path d="M10 3l7 13H3z"/>',
  diamond: '<path d="M10 3l7 7-7 7-7-7z"/>',
  star: '<path d="M10 2.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4L5.5 16l.9-5L2.8 7.8l5-.7z"/>',
  roundrect: '<rect x="3.5" y="5" width="13" height="10" rx="4"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="1"/><circle cx="7.5" cy="8" r="1.2"/><path d="M4 14l4-4 3 3 2-2 3 3"/>'
};

export function toolIcon(tool: string, shape?: string | null): string {
  return svg(ICONS[shape || tool] || ICONS[tool] || ICONS.rect);
}

const UI_ICONS: Record<string, string> = {
  layers: '<path d="M10 3l7 4-7 4-7-4z"/><path d="M3 10l7 4 7-4"/><path d="M3 13l7 4 7-4"/>',
  history: '<path d="M10 5a5 5 0 11-5 5"/><path d="M10 2v3M5 10H2"/><path d="M10 7v4l3 2"/>',
  eye: '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.2"/>',
  eyeOff: '<path d="M3 3l14 14"/><path d="M7 5.6C8 5.2 9 5 10 5c5 0 8 5 8 5s-1 1.7-2.6 3.1"/><path d="M5.5 7.2C4 8.4 2 10 2 10s3 5 8 5c1.2 0 2.3-.3 3.3-.7"/>',
  lock: '<rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7.5 9V7a2.5 2.5 0 015 0v2"/>',
  unlock: '<rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7.5 9V7a2.5 2.5 0 014.6-1.3"/>'
};

export function uiIcon(name: string, size = 16): string {
  return svg(UI_ICONS[name] || UI_ICONS.eye, size);
}
