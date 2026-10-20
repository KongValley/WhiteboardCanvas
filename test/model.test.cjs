const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../test-dist/src/model.js');

test('incremental ink path matches the full rebuild', () => {
  const points = [];
  for (let i = 0; i < 60; i++) points.push([Math.sin(i / 3) * 50, i * 1.7]);
  const builder = new model.InkPathBuilder([points[0]]);
  for (let i = 1; i < points.length; i++) builder.push(points[i]);
  assert.equal(builder.value, model.smoothPathD(points));
  // 从中间状态恢复也应一致
  const half = new model.InkPathBuilder(points.slice(0, 20));
  assert.equal(half.value, model.smoothPathD(points.slice(0, 20)));
});

test('incremental ink path handles empty and single point', () => {
  const empty = new model.InkPathBuilder([]);
  assert.equal(empty.value, '');
  const one = new model.InkPathBuilder([[3, 4]]);
  assert.equal(one.value, model.smoothPathD([[3, 4]]));
  const fresh = new model.InkPathBuilder();
  assert.equal(fresh.push([1, 2]), model.smoothPathD([[1, 2]]));
  assert.equal(fresh.push([3, 4]), model.smoothPathD([[1, 2], [3, 4]]));
});

test('bounds and visual bounds with rotation', () => {
  const rect = { id: 'r', type: 'rect', x: 0, y: 0, w: 10, h: 20, stroke: '#000', strokeWidth: 1, fill: '' };
  assert.deepEqual(model.bounds(rect), { x: 0, y: 0, w: 10, h: 20 });
  rect.rotation = 90;
  const visual = model.visualBounds(rect);
  assert.ok(Math.abs(visual.w - 20) < 1e-6, 'width swaps after 90deg');
  assert.ok(Math.abs(visual.h - 10) < 1e-6, 'height swaps after 90deg');
  assert.ok(Math.abs(visual.x + 5) < 1e-6);
});

test('visible and auto-selectable helpers skip hidden/locked', () => {
  const visible = { id: 'v', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: '' };
  const hidden = { ...visible, id: 'h', hidden: true };
  const locked = { ...visible, id: 'l', locked: true };
  const both = { ...visible, id: 'b', hidden: true, locked: true };
  assert.deepEqual(model.visibleElements([visible, hidden, locked, both]).map((el) => el.id), ['v', 'l']);
  assert.deepEqual(model.autoSelectableElements([visible, hidden, locked, both]).map((el) => el.id), ['v']);
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
  assert.equal(model.sanitizeEl({ type: 'poly', kind: 'octagon', x: 0, y: 0, w: 1, h: 1, strokeWidth: 1 }), null);
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

test('align and distribute deltas use the selection bounds', () => {
  const rects = [
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 50, y: 20, w: 20, h: 10 },
    { x: 100, y: 40, w: 10, h: 10 }
  ];
  assert.deepEqual(model.alignDeltas(rects, 'left'), [[0, 0], [-50, 0], [-100, 0]]);
  assert.deepEqual(model.alignDeltas(rects, 'right'), [[100, 0], [40, 0], [0, 0]]);
  assert.deepEqual(model.alignDeltas(rects, 'hcenter'), [[50, 0], [-5, 0], [-50, 0]]);
  const distributed = model.distributeDeltas(rects, 'x');
  assert.ok(Math.abs(distributed[0][0]) < 1e-6);
  assert.ok(Math.abs(distributed[1][0] + 5) < 1e-6);
  assert.ok(Math.abs(distributed[2][0]) < 1e-6);
  assert.deepEqual(model.alignDeltas([rects[0]], 'left'), [[0, 0]]);
});

test('dash and opacity are sanitized', () => {
  assert.equal(model.dashArray('solid', 2), null);
  assert.deepEqual(model.dashArray('dash', 2), [8, 6]);
  assert.deepEqual(model.dashArray('dot', 2), [0.1, 4.4]);
  const styled = model.sanitizeEl({
    type: 'rect', x: 0, y: 0, w: 10, h: 10, strokeWidth: 2, dash: 'dot', opacity: 0.5
  });
  assert.equal(styled.dash, 'dot');
  assert.equal(styled.opacity, 0.5);
  const tooFaint = model.sanitizeEl({
    type: 'rect', x: 0, y: 0, w: 10, h: 10, strokeWidth: 2, opacity: 0.05
  });
  assert.equal(tooFaint.opacity, undefined);
  const full = model.sanitizeEl({
    type: 'rect', x: 0, y: 0, w: 10, h: 10, strokeWidth: 2, opacity: 1
  });
  assert.equal(full.opacity, undefined);
});
