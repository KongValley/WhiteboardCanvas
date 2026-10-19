const assert = require('node:assert/strict');
const test = require('node:test');

function stubEl() {
  return { textContent: '', setAttribute() {}, classList: { toggle() {} }, style: {} };
}

global.document = {
  getElementById: () => stubEl(),
  title: ''
};
global.window = {
  api: {
    setDirty() {},
    clearRecovery() {},
    writeRecovery() {}
  },
  setTimeout: () => 0,
  clearTimeout: () => {}
};

const stateMod = require('../test-dist/src/state.js');

test('undo and redo keep history labels', () => {
  stateMod.resetDoc();
  const before = stateMod.beginMutation();
  stateMod.state.doc.elements.push({ id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: '' });
  stateMod.commitMutation(before, true, '添加矩形');
  assert.equal(stateMod.state.doc.elements.length, 1);
  assert.equal(stateMod.undo(), true);
  assert.equal(stateMod.state.doc.elements.length, 0);
  assert.equal(stateMod.redo(), true);
  assert.equal(stateMod.state.doc.elements.length, 1);
  assert.equal(stateMod.historyEntries()[0].label, '添加矩形');
});

test('jumpToHistory moves to an earlier step', () => {
  stateMod.resetDoc();
  for (let i = 0; i < 3; i++) {
    const before = stateMod.beginMutation();
    stateMod.state.doc.elements.push({ id: 'e' + i, type: 'ellipse', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 1, fill: '' });
    stateMod.commitMutation(before, true, '步骤' + i);
  }
  assert.equal(stateMod.jumpToHistory(1), true);
  assert.equal(stateMod.state.doc.elements.length, 1);
});

test('serialize/load round-trips multiple pages', () => {
  stateMod.resetDoc();
  stateMod.addPage('第二页');
  stateMod.state.doc.elements.push({ id: 'p2', type: 'text', x: 0, y: 0, w: 100, h: 20, text: 'hi', fontSize: 12, color: '#000' });
  stateMod.switchPage(1);
  stateMod.state.doc.elements.push({ id: 'p3', type: 'text', x: 0, y: 0, w: 100, h: 20, text: 'world', fontSize: 12, color: '#000' });
  const text = stateMod.serialize();
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.pages.length, 2);
  stateMod.resetDoc();
  stateMod.loadFromText(text);
  assert.equal(stateMod.state.pages.length, 2);
  assert.equal(stateMod.state.activePage, 1);
  assert.equal(stateMod.state.doc.elements[0].text, 'world');
});

test('page deletion can be undone and redone', () => {
  stateMod.resetDoc();
  stateMod.addPage('可恢复页');
  stateMod.switchPage(1);
  stateMod.state.doc.elements.push({ id: 'keep', type: 'text', x: 0, y: 0, w: 100, h: 20, text: '保留内容', fontSize: 12, color: '#000' });
  stateMod.pushPageUndo('删除页面');
  assert.equal(stateMod.removePage(1), true);
  assert.equal(stateMod.state.pages.length, 1);
  assert.equal(stateMod.undoPage(), true);
  assert.equal(stateMod.state.pages.length, 2);
  assert.equal(stateMod.state.pages[1].name, '可恢复页');
  assert.equal(stateMod.state.doc.elements[0].text, '保留内容');
  assert.equal(stateMod.redoPage(), true);
  assert.equal(stateMod.state.pages.length, 1);
});

test('page operations keep active page in range', () => {
  stateMod.resetDoc();
  stateMod.addPage('A');
  stateMod.addPage('B');
  assert.equal(stateMod.state.pages.length, 3);
  stateMod.renamePage(2, 'B2');
  assert.equal(stateMod.state.pages[2].name, 'B2');
  assert.equal(stateMod.movePage(2, 0), true);
  assert.equal(stateMod.removePage(0), true);
  assert.ok(stateMod.state.activePage < stateMod.state.pages.length);
});
