const assert = require('node:assert/strict');
const test = require('node:test');
const zip = require('../electron/zip.js');

test('zip round-trip with dedupe-friendly entries', () => {
  const buf = zip.write([
    { name: 'doc.json', data: Buffer.from('{"hello":"world"}') },
    { name: 'assets/a.png', data: Buffer.from([1, 2, 3, 4]) }
  ]);
  assert.equal(zip.isZip(buf), true);
  const files = zip.read(buf);
  assert.equal(files.get('doc.json').toString(), '{"hello":"world"}');
  assert.deepEqual([...files.get('assets/a.png')], [1, 2, 3, 4]);
});

test('lenient reader recovers entries from a truncated archive', () => {
  const buf = zip.write([
    { name: 'doc.json', data: Buffer.from('{"app":"whiteboard-canvas"}') },
    { name: 'assets/a.png', data: Buffer.alloc(100, 7) }
  ]);
  const truncated = buf.subarray(0, buf.length - 12);
  assert.throws(() => zip.read(truncated));
  const files = zip.readLenient(truncated);
  assert.equal(files.get('doc.json').toString(), '{"app":"whiteboard-canvas"}');
});
