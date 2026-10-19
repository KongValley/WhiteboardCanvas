const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../test-dist/src/model.js');

test('bounds and visual bounds with rotation', () => {
  const rect = { id: 'r', type: 'rect', x: 0, y: 0, w: 10, h: 20, stroke: '#000', strokeWidth: 1, fill: '' };
  assert.deepEqual(model.bounds(rect), { x: 0, y: 0, w: 10, h: 20 });
  rect.rotation = 90;
  const visual = model.visualBounds(rect);
  assert.ok(Math.abs(visual.w - 20) < 1e-6, 'width swaps after 90deg');
  assert.ok(Math.abs(visual.h - 10) < 1e-6, 'height swaps after 90deg');
  assert.ok(Math.abs(visual.x + 5) < 1e-6);
});

test('hit test respects hidden/locked options and rotation', () => {
  const rect = { id: 'r', type: 'rect', x: 0, y: 0, w: 100, h: 50, stroke: '#000', strokeWidth: 2, fill: 'rgba(0,0,0,0.2)' };
  assert.equal(model.hitTest([rect], [50, 25], 4).id, 'r');
  rect.locked = true;
  assert.equal(model.hitTest([rect], [50, 25], 4, { ignoreLocked: true }), null);
  assert.equal(model.hitTest([rect], [50, 25], 4).id, 'r');
  rect.locked = false;
  rect.hidden = true;
  assert.equal(model.hitTest([rect], [50, 25], 4, { ignoreHidden: true }), null);
  assert.equal(model.hitTest([rect], [50, 25], 4).id, 'r');
});

test('polygon shapes are selectable and exportable paths', () => {
  const star = { id: 's', type: 'poly', kind: 'star', x: 0, y: 0, w: 100, h: 100, stroke: '#000', strokeWidth: 2, fill: 'rgba(0,0,0,0.3)' };
  assert.equal(model.hitTest([star], [50, 50], 2).id, 's');
  assert.ok(model.polyPathD(star).startsWith('M '));
  const round = { ...star, kind: 'roundrect' };
  assert.ok(model.polyPathD(round).includes('Q'));
});

test('normalizeInk and smooth path', () => {
  const norm = model.normalizeInk([[10, 20], [30, 40]]);
  assert.deepEqual([norm.x, norm.y, norm.w, norm.h], [10, 20, 20, 20]);
  assert.deepEqual(norm.points, [[0, 0], [20, 20]]);
  assert.match(model.smoothPathD([[0, 0], [10, 10], [20, 0]]), /^M 0 0 Q 10 10/);
});

test('sanitizeEl rejects oversized or invalid input', () => {
  assert.equal(model.sanitizeEl({ type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'javascript:alert(1)' }), null);
  assert.equal(model.sanitizeEl({ type: 'poly', kind: 'hexagon', x: 0, y: 0, w: 1, h: 1, strokeWidth: 1 }), null);
  const text = model.sanitizeEl({ type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'a'.repeat(200001), fontSize: 12 });
  assert.equal(text.text.length, 0);
  const rotated = model.sanitizeEl({ type: 'rect', x: 0, y: 0, w: 10, h: 10, strokeWidth: 2, rotation: 9999 });
  assert.equal(rotated.rotation, undefined);
  const crop = model.sanitizeEl({
    type: 'image', x: 0, y: 0, w: 10, h: 10,
    src: 'data:image/png;base64,AA==', crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, flipH: true
  });
  assert.deepEqual(crop.crop, { x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  assert.equal(crop.flipH, true);
});
