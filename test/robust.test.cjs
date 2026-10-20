const assert = require('node:assert/strict');
const test = require('node:test');
const zip = require('../electron/zip.js');
const model = require('../test-dist/src/model.js');

test('async deflated zip round-trip and truncation recovery', async () => {
  const buffer = await zip.writeAsync([
    { name: 'doc.json', data: Buffer.from('{"app":"whiteboard-canvas"}'), compress: true },
    { name: 'assets/a.png', data: Buffer.alloc(64, 3) }
  ]);
  const files = zip.read(buffer);
  assert.equal(files.get('doc.json').toString(), '{"app":"whiteboard-canvas"}');
  const truncated = buffer.subarray(0, buffer.length - 10);
  assert.throws(() => zip.read(truncated));
  const recovered = zip.readLenient(truncated);
  assert.equal(recovered.get('doc.json').toString(), '{"app":"whiteboard-canvas"}');
});

test('sanitizer tolerates fuzzed shapes without throwing', () => {
  const inputs = [
    null,
    {},
    { type: 'rect', x: -1e20, y: 0, w: -5, h: 1, strokeWidth: 1 },
    { type: 'text', x: 0, y: 0, w: 1, h: 1, text: 123, fontSize: -1 },
    { type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'javascript:alert(1)' },
    { type: 'poly', kind: 'hexagon', x: 0, y: 0, w: 10, h: 10, strokeWidth: 1 },
    { type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, strokeWidth: 1, routing: 'orthogonal', startHead: true }
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => model.sanitizeEl(input));
  }
  assert.equal(model.sanitizeEl(inputs[5]).kind, 'hexagon');
});

test('arrow orthogonal route and heads are finite', () => {
  const arrow = {
    id: 'a', type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 60,
    stroke: '#000', strokeWidth: 2, head: true, routing: 'orthogonal'
  };
  const path = model.arrowPathD(arrow);
  assert.ok(path.includes('L 50 0'));
  assert.ok(path.endsWith('Z') === false);
  const [h1, h2] = model.arrowHeadPoints(arrow);
  assert.ok(Number.isFinite(h1[0]) && Number.isFinite(h2[1]));
});
