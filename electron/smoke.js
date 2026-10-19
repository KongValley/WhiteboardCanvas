// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function runSmoke(win) {
  const tmpWbc = path.join(os.tmpdir(), 'wbc-smoke-' + process.pid + '.wbc');
  const tmpPng = path.join(os.tmpdir(), 'wbc-smoke-' + process.pid + '.png');
  let failures = 0;

  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, ok, actual) => {
    if (ok) {
      console.log('PASS ' + name);
    } else {
      failures++;
      console.log('FAIL ' + name + ' ' + JSON.stringify(actual));
    }
  };
  const j = (value) => JSON.stringify(value);
  const readDoc = () => {
    try {
      return JSON.parse(fs.readFileSync(tmpWbc, 'utf8'));
    } catch (err) {
      return null;
    }
  };

  try {
    const buttons = await run("document.querySelectorAll('#toolbar button').length");
    check('toolbar-8-buttons', buttons === 8, buttons);

    const initial = await run('__test.count()');
    check('initial-empty', initial === 0, initial);

    const inkId = await run("__test.addInk([[200,200],[260,240],[320,260]], '#111', 4)");
    await run("__test.addText('你好世界', 100, 120)");
    await run("__test.addShape('rect', 400, 200, 160, 100)");
    const count3 = await run('__test.count()');
    check('add-3-elements', count3 === 3, count3);

    const hitInk = await run('__test.hitTest(260, 240)');
    check('hit-ink', hitInk === 'ink', hitInk);

    const hitEmpty = await run('__test.hitTest(900, 900)');
    check('hit-empty-null', hitEmpty === null, hitEmpty);

    await run('__test.undo()');
    const afterUndo = await run('__test.count()');
    check('undo-count-2', afterUndo === 2, afterUndo);

    await run('__test.redo()');
    const afterRedo = await run('__test.count()');
    check('redo-count-3', afterRedo === 3, afterRedo);

    const saved = await run('__test.saveTo(' + j(tmpWbc) + ')');
    const savedDoc = readDoc();
    check('save-file', saved === true && !!savedDoc && savedDoc.app === 'whiteboard-canvas' && savedDoc.elements.length === 3, {
      saved: saved,
      elements: savedDoc && savedDoc.elements && savedDoc.elements.length
    });

    await run('__test.reset()');
    const opened = await run('__test.openFrom(' + j(tmpWbc) + ')');
    const afterOpen = await run('__test.count()');
    check('open-file', opened === true && afterOpen === 3, afterOpen);

    const exported = await run('__test.exportPngTo(' + j(tmpPng) + ')');
    try {
      const buf = fs.readFileSync(tmpPng);
      const signature = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
      check('export-png', exported === true && signature && buf.length > 1000, { exported: exported, size: buf.length });
    } catch (err) {
      check('export-png', false, String((err && err.message) || err));
    }

    const pixels = await run(
      "(async () => {\n" +
        "  const url = await __test.pngData();\n" +
        "  if (!url) return null;\n" +
        "  const img = new Image();\n" +
        "  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });\n" +
        "  const canvas = document.createElement('canvas');\n" +
        "  canvas.width = img.naturalWidth;\n" +
        "  canvas.height = img.naturalHeight;\n" +
        "  const ctx = canvas.getContext('2d');\n" +
        "  ctx.drawImage(img, 0, 0);\n" +
        "  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;\n" +
        "  let nonWhite = 0;\n" +
        "  for (let i = 0; i < data.length; i += 4) {\n" +
        "    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;\n" +
        "  }\n" +
        "  return { w: canvas.width, h: canvas.height, nonWhite: nonWhite, corner: [data[0], data[1], data[2]] };\n" +
        '})()'
    );
    check(
      'export-png-content',
      !!pixels && pixels.nonWhite > 800 && pixels.corner[0] === 255 && pixels.corner[1] === 255 && pixels.corner[2] === 255,
      pixels
    );

    const inkBefore = savedDoc && savedDoc.elements.find((el) => el.type === 'ink');
    await run('__test.move(' + j(inkId) + ', 10, 5)');
    const hitMoved = await run('__test.hitTest(270, 245)');
    check('move-ink', hitMoved === 'ink', hitMoved);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    const inkAfter = readDoc();
    const inkSaved = inkAfter && inkAfter.elements.find((el) => el.type === 'ink');
    check(
      'autosave-persist',
      !!inkBefore && !!inkSaved && Math.abs(inkSaved.x - (inkBefore.x + 10)) < 0.001 && Math.abs(inkSaved.y - (inkBefore.y + 5)) < 0.001,
      { before: inkBefore && [inkBefore.x, inkBefore.y], after: inkSaved && [inkSaved.x, inkSaved.y] }
    );

    await run('__test.reset()');
    await run("__test.addText('框选文字', 100, 120)");
    await run("__test.addInk([[200,200],[260,240],[320,260]], '#111', 4)");
    await run("__test.addShape('rect', 400, 200, 160, 100)");
    const marqueeSelected = await run(
      "(() => {\n" +
        "  const viewport = document.getElementById('viewport');\n" +
        "  const rect = viewport.getBoundingClientRect();\n" +
        "  const fire = (type, x, y, buttons) => viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: buttons, pointerId: 7, pointerType: 'mouse' }));\n" +
        "  fire('pointerdown', rect.left + 10, rect.top + 10, 1);\n" +
        "  fire('pointermove', rect.left + 400, rect.top + 300, 1);\n" +
        "  fire('pointermove', rect.left + 700, rect.top + 500, 1);\n" +
        "  fire('pointerup', rect.left + 700, rect.top + 500, 0);\n" +
        "  return __test.selectedIds().length;\n" +
        '})()'
    );
    check('multi-select-marquee', marqueeSelected === 3, marqueeSelected);

    const beforeNudge = await run('__test.elements()');
    await run('__test.nudge(5, 0)');
    const afterNudge = await run('__test.elements()');
    const nudgeOk =
      beforeNudge.length === 3 &&
      beforeNudge.every((el) => {
        const after = afterNudge.find((item) => item.id === el.id);
        return !!after && Math.abs(after.x - (el.x + 5)) < 0.001;
      });
    check('multi-nudge', nudgeOk, { before: beforeNudge.map((el) => el.x), after: afterNudge.map((el) => el.x) });

    const dupCount = await run('__test.duplicate()');
    const afterDup = await run('__test.elements()');
    const dupSelected = await run('__test.selectedIds()');
    const dupOk =
      dupCount === 6 &&
      dupSelected.length === 3 &&
      afterDup.every((el) => {
        if (afterNudge.some((item) => item.id === el.id)) return true;
        return afterNudge.some((item) => Math.abs(el.x - (item.x + 16)) < 0.001 && Math.abs(el.y - (item.y + 16)) < 0.001);
      });
    check('duplicate', dupOk, { count: dupCount, selected: dupSelected.length });

    await run('__test.reset()');
    await run("__test.addText('层', 100, 100)");
    await run("__test.addInk([[200,200],[260,240]], '#111', 4)");
    await run("__test.addShape('rect', 400, 200, 160, 100)");
    await run("__test.addShape('ellipse', 700, 200, 160, 100)");
    const orderElements = await run('__test.elements()');
    const firstThree = orderElements.slice(0, 3).map((el) => el.id);
    await run('__test.select(' + j(firstThree) + ')');
    await run('__test.bringToFront()');
    const frontOrder = await run('__test.order()');
    const frontOk = frontOrder.slice(-3).join(',') === firstThree.join(',');
    await run('__test.sendToBack()');
    const backOrder = await run('__test.order()');
    const backOk = backOrder.slice(0, 3).join(',') === firstThree.join(',');
    check('z-order', frontOk && backOk, { front: frontOrder, back: backOrder });

    await run('__test.reset()');
    const paletteTextId = await run("__test.addText('调色', 100, 120)");
    await run('__test.select(' + j([paletteTextId]) + ')');
    await run(`document.querySelector('.swatch[data-value="#dc2626"]').click()`);
    const colored = await run('__test.elements()');
    const redOk = colored.some((el) => el.id === paletteTextId && el.color === '#dc2626');
    await run('__test.undo()');
    const reverted = await run('__test.elements()');
    const revertOk = reverted.some((el) => el.id === paletteTextId && el.color === '#1f2937');
    check('palette-apply', redOk && revertOk, { red: redOk, revert: revertOk });

    await run('__test.reset()');
    const pasteTextId = await run("__test.addText('复制源', 100, 120)");
    const pasteRectId = await run("__test.addShape('rect', 400, 200, 160, 100)");
    await run('__test.select(' + j([pasteTextId, pasteRectId]) + ')');
    const clipJson = await run('__test.clipboardJson()');
    await run(
      "(() => {\n" +
        '  const dt = new DataTransfer();\n' +
        '  dt.setData(' + j('text/plain') + ', ' + j(clipJson) + ');\n' +
        "  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));\n" +
        '  return true;\n' +
        '})()'
    );
    const afterPaste = await run('__test.elements()');
    const fresh = afterPaste.filter((el) => el.id !== pasteTextId && el.id !== pasteRectId);
    const pasteOk =
      afterPaste.length === 4 &&
      fresh.length === 2 &&
      fresh.every((el) => {
        const source = afterPaste.find((item) => item.id === (el.type === 'text' ? pasteTextId : pasteRectId));
        return !!source && Math.abs(el.x - (source.x + 16)) < 0.001 && Math.abs(el.y - (source.y + 16)) < 0.001;
      });
    check('copy-paste', pasteOk, { count: afterPaste.length, fresh: fresh.length });

    await run('__test.reset()');
    const panTransform = await run(
      "(() => {\n" +
        "  const viewport = document.getElementById('viewport');\n" +
        "  const rect = viewport.getBoundingClientRect();\n" +
        "  const fire = (type, x, y) => viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: type === 'pointerup' ? 0 : 1, pointerId: 9, pointerType: 'mouse' }));\n" +
        "  fire('pointerdown', rect.left + 500, rect.top + 300);\n" +
        "  fire('pointermove', rect.left + 560, rect.top + 330);\n" +
        "  fire('pointerup', rect.left + 560, rect.top + 330);\n" +
        "  return document.getElementById('world').style.transform;\n" +
        '})()'
    );
    check('right-drag-pan', panTransform.includes('translate(60px, 30px)'), panTransform);
  } catch (err) {
    failures++;
    console.log('FAIL smoke-exception ' + String((err && err.message) || err));
  }

  try { fs.unlinkSync(tmpWbc); } catch (err) { /* 忽略清理失败 */ }
  try { fs.unlinkSync(tmpPng); } catch (err) { /* 忽略清理失败 */ }

  console.log('SMOKE ' + (failures === 0 ? 'PASS' : 'FAIL'));
  return failures === 0 ? 0 : 1;
};
