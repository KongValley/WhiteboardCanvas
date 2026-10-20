const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStore } = require('../electron/store.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wbc-store-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('backup filenames stay unique within the same millisecond', async () => {
  const dir = tempDir();
  const store = createStore(dir);
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    for (let i = 0; i < 3; i++) await store.backupBuffer(Buffer.from('backup-' + i), null, 'untitledA');
  } finally {
    Date.now = realNow;
  }
  const names = fs.readdirSync(path.join(dir, 'backups')).filter((name) => /\.wbc$/i.test(name));
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  cleanup(dir);
});

test('untitled documents keep separate backup retention', async () => {
  const dir = tempDir();
  const store = createStore(dir);
  for (let i = 0; i < 7; i++) await store.backupBuffer(Buffer.from('A' + i), null, 'untitledA');
  for (let i = 0; i < 7; i++) await store.backupBuffer(Buffer.from('B' + i), null, 'untitledB');
  const names = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(names.filter((name) => name.startsWith('未命名-untitledA-')).length, 5);
  assert.equal(names.filter((name) => name.startsWith('未命名-untitledB-')).length, 5);
  cleanup(dir);
});

test('recovery snapshots are isolated by key', async () => {
  const dir = tempDir();
  const store = createStore(dir);
  store.writeRecovery('keyA', '{"doc":"A"}', 'C:/a.wbc', { mtimeMs: 10, size: 4 });
  store.writeRecovery('keyB', '{"doc":"B"}', null, null);
  await store.flushRecovery();

  const list = store.listRecoveries();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => item.key).sort(), ['keyA', 'keyB']);
  assert.equal(store.readRecovery('keyA').text, '{"doc":"A"}');
  assert.equal(store.readRecovery('keyA').path, 'C:/a.wbc');
  assert.equal(store.readRecovery('keyA').stamp.mtimeMs, 10);

  store.clearRecovery('keyA');
  assert.equal(store.readRecovery('keyA'), null);
  assert.equal(store.readRecovery('keyB').text, '{"doc":"B"}');
  assert.equal(store.listRecoveries().length, 1);
  cleanup(dir);
});

test('legacy single recovery is migrated without data loss', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'recovery.wbc'), '{"legacy":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'recovery.json'), JSON.stringify({ path: 'C:/legacy.wbc', at: 123 }), 'utf8');
  const store = createStore(dir);
  const list = store.listRecoveries();
  assert.equal(list.length, 1);
  assert.ok(list[0].key.startsWith('legacy-'));
  assert.equal(store.readRecovery(list[0].key).text, '{"legacy":true}');
  assert.equal(store.readRecovery(list[0].key).path, 'C:/legacy.wbc');
  assert.equal(fs.existsSync(path.join(dir, 'recovery.wbc')), false);
  assert.equal(fs.existsSync(path.join(dir, 'recovery.json')), false);
  cleanup(dir);
});
