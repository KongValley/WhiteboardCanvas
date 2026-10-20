// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clipboard, app } = require('electron');
const zip = require('./zip');

module.exports = async function runSmoke(win) {
  const stamp = process.pid + '-' + Date.now();
  const tmpWbc = path.join(os.tmpdir(), `wbc-smoke-${stamp}.wbc`);
  const tmpPng = path.join(os.tmpdir(), `wbc-smoke-${stamp}.png`);
  const tmpZip = path.join(os.tmpdir(), `wbc-smoke-${stamp}-zip.wbc`);
  const tmpSelPng = path.join(os.tmpdir(), `wbc-smoke-${stamp}-sel.png`);
  const tmpV1 = path.join(os.tmpdir(), `wbc-smoke-${stamp}-v1.wbc`);
  const tmpBad = path.join(os.tmpdir(), `wbc-smoke-${stamp}-bad.wbc`);
  const tmpBadZip = path.join(os.tmpdir(), `wbc-smoke-${stamp}-badzip.wbc`);
  const tmpPdf = path.join(os.tmpdir(), `wbc-smoke-${stamp}.pdf`);
  const tmpSvg = path.join(os.tmpdir(), `wbc-smoke-${stamp}.svg`);
  const tmpStyleSvg = path.join(os.tmpdir(), `wbc-smoke-${stamp}-style.svg`);
  const tmpPages = path.join(os.tmpdir(), `wbc-smoke-${stamp}-pages.wbc`);
  const tmpRepairJson = path.join(os.tmpdir(), `wbc-smoke-${stamp}-repair.wbc`);
  const tmpRepairZip = path.join(os.tmpdir(), `wbc-smoke-${stamp}-repairzip.wbc`);
  const tmpConflict = path.join(os.tmpdir(), `wbc-smoke-${stamp}-conflict.wbc`);
  const tmpConcurrent = path.join(os.tmpdir(), `wbc-smoke-${stamp}-concurrent.wbc`);
  const tmpPagesZip = path.join(os.tmpdir(), `wbc-smoke-${stamp}-pages.zip`);
  const tmpSvgSel = path.join(os.tmpdir(), `wbc-smoke-${stamp}-selsvg.svg`);
  const tmpCropSvg = path.join(os.tmpdir(), `wbc-smoke-${stamp}-cropsvg.svg`);
  const userData = app.getPath('userData');
  const backupsDir = path.join(userData, 'backups');
  const recoveryDir = path.join(userData, 'recovery');
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
  const readDoc = (file = tmpWbc) => {
    try {
      const buf = fs.readFileSync(file);
      if (zip.isZip(buf)) {
        const files = zip.read(buf);
        const parsed = files.get('doc.json');
        const doc = parsed ? JSON.parse(parsed.toString('utf8')) : null;
        if (doc && !doc.elements && Array.isArray(doc.pages)) doc.elements = doc.pages.flatMap((page) => page.elements || []);
        return doc;
      }
      return JSON.parse(buf.toString('utf8'));
    } catch (err) {
      return null;
    }
  };
  const pngSize = (file) => {
    const buf = fs.readFileSync(file);
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  const pngDataSize = (dataUrl) => {
    const buf = Buffer.from(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1), 'base64');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  const clickWorld = (x, y, alt = false) =>
    "(function(){var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
    `var fire=function(t,cx,cy,btn,buttons){vp.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:btn,buttons:buttons,pointerId:21,pointerType:'mouse',altKey:${alt}}));};` +
    `fire('pointerdown',r.left+${x},r.top+${y},0,1);` +
    `fire('pointermove',r.left+${x},r.top+${y},0,1);` +
    `fire('pointerup',r.left+${x},r.top+${y},0,0);return true;})()`;

  try {
    await run("new Promise(function(resolve){var t=setInterval(function(){if(window.__test){clearInterval(t);resolve(true);}},20);})");
    const buttons = await run("document.querySelectorAll('#toolbar button').length");
    check('toolbar-p2-buttons', buttons === 20, buttons);

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
    await new Promise((resolve) => setTimeout(resolve, 120));
    const recent = JSON.parse(fs.readFileSync(path.join(userData, 'recent.json'), 'utf8'));
    check('recent-files', Array.isArray(recent) && recent.includes(tmpWbc), recent);

    const backupsBefore = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
    await run('__test.saveTo(' + j(tmpWbc) + ')');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const backupsAfter = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
    check('pre-save-backup', backupsAfter > backupsBefore, { backupsBefore, backupsAfter });

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

    // DOM 顺序必须与元素顺序一致（增量渲染后仍需保持图层叠放次序）
    const domOrder = await run(
      "(() => {const w=document.getElementById('world');" +
        "const ids=[];for(const n of w.children){if(n.id==='editor')continue;if(n.dataset&&n.dataset.id)ids.push(n.dataset.id);}" +
        'return ids;})()'
    );
    const domMatches = (await run('__test.order()')).join(',') === domOrder.join(',');
    check('z-order-dom', domMatches, { dom: domOrder, expected: await run('__test.order()') });

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

    // 直线工具 + 端点编辑
    await run('__test.reset()');
    const lineId = await run("__test.addShape('line', 100, 100, 200, 80)");
    const lineEl = await run('__test.el(' + j(lineId) + ')');
    const lineHit = await run('__test.hitTest(200, 140)');
    await run('__test.setEndpoints(' + j(lineId) + ', 500, 500, 600, 600)');
    const movedHit = await run('__test.hitTest(550, 550)');
    await run('__test.undo()');
    const restored = await run('__test.el(' + j(lineId) + ')');
    check(
      'line-tool',
      lineEl && lineEl.head === false && lineHit === 'arrow' && movedHit === 'arrow' &&
        Math.abs(restored.x1 - 100) < 0.001 && Math.abs(restored.y2 - 180) < 0.001,
      { lineEl, lineHit, movedHit, restored }
    );

    // 端点手柄拖动
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const epId = await run("__test.addShape('line', 100, 100, 200, 100)");
    await run('__test.select(' + j([epId]) + ')');
    const endpointMoved = await run(
      "(() => {var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
        "var h=document.querySelector('#selection .handle.p2');if(!h)return null;" +
        "h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+300,clientY:r.top+200,button:0,buttons:1,pointerId:41,pointerType:'mouse'}));" +
        "vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:r.left+400,clientY:r.top+300,button:0,buttons:1,pointerId:41,pointerType:'mouse',altKey:true}));" +
        "vp.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+400,clientY:r.top+300,button:0,buttons:0,pointerId:41,pointerType:'mouse',altKey:true}));" +
        "return __test.el(" + j(epId) + ");})()"
    );
    await run('__test.undo()');
    const endpointUndone = await run('__test.el(' + j(epId) + ')');
    check(
      'endpoint-drag',
      endpointMoved && Math.abs(endpointMoved.x2 - 400) < 0.001 && Math.abs(endpointMoved.y2 - 300) < 0.001 &&
        Math.abs(endpointUndone.x2 - 300) < 0.001,
      { endpointMoved, endpointUndone }
    );

    // 形状填充
    await run('__test.reset()');
    const fillId = await run("__test.addShape('rect', 100, 100, 200, 100)");
    const beforeFillHit = await run('__test.hitTest(200, 150)');
    await run('__test.setFill(' + j(fillId) + ", 'rgba(37,99,235,0.18)')");
    const afterFillHit = await run('__test.hitTest(200, 150)');
    await run('__test.undo()');
    const undoFillHit = await run('__test.hitTest(200, 150)');
    check('shape-fill', beforeFillHit === null && afterFillHit === 'rect' && undoFillHit === null, {
      beforeFillHit,
      afterFillHit,
      undoFillHit
    });

    // 荧光笔
    await run('__test.reset()');
    const hiId = await run("__test.addInk([[100,100],[300,100]], '#f59e0b', 16, true)");
    const hiEl = await run('__test.el(' + j(hiId) + ')');
    check('highlighter', hiEl && hiEl.highlight === true && hiEl.width === 16, hiEl);

    // 局部橡皮：拆分 + 一次撤销
    await run('__test.reset()');
    const dense = [];
    for (let x = 100; x <= 300; x += 10) dense.push([x, 100]);
    await run('__test.addInk(' + j(dense) + ", '#111', 6)");
    await run('__test.eraseAt(200, 100)');
    const splitCount = await run('__test.count()');
    const splitEls = await run('__test.elements()');
    await run('__test.undo()');
    const restoredInk = await run('__test.count()');
    check('partial-eraser', splitCount === 2 && restoredInk === 1, { splitCount, restoredInk, widths: splitEls.map((el) => el.w) });

    // 网格吸附（Alt 关闭）
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const snapId = await run("__test.addShape('rect', 100, 100, 100, 100)");
    await run('__test.select(' + j([snapId]) + ')');
    await run(clickWorld(100, 150));
    await run(
      "(() => {var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
        "vp.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+100,clientY:r.top+150,button:0,buttons:1,pointerId:22,pointerType:'mouse'}));" +
        "vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:r.left+102,clientY:r.top+152,button:0,buttons:1,pointerId:22,pointerType:'mouse'}));" +
        "vp.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+102,clientY:r.top+152,button:0,buttons:0,pointerId:22,pointerType:'mouse'}));return true;})()"
    );
    const snapped = await run('__test.el(' + j(snapId) + ')');
    await run(
      "(() => {var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
        "vp.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+96,clientY:r.top+146,button:0,buttons:1,pointerId:23,pointerType:'mouse'}));" +
        "vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:r.left+98,clientY:r.top+148,button:0,buttons:1,pointerId:23,pointerType:'mouse',altKey:true}));" +
        "vp.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+98,clientY:r.top+148,button:0,buttons:0,pointerId:23,pointerType:'mouse',altKey:true}));return true;})()"
    );
    const altMoved = await run('__test.el(' + j(snapId) + ')');
    check(
      'grid-snap',
      Math.abs(snapped.x - 96) < 0.001 && Math.abs(snapped.y - 96) < 0.001 && Math.abs(altMoved.x - 98) < 0.001,
      { snapped: [snapped.x, snapped.y], alt: [altMoved.x, altMoved.y] }
    );

    // 多选缩放（联合框 + 一步撤销）
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    await run("__test.addShape('rect', 100, 100, 100, 100)");
    await run("__test.addShape('rect', 300, 100, 100, 100)");
    await run('__test.selectAll()');
    const resized = await run(
      "(() => {var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
        "var h=document.querySelector('#selection .handle.se');if(!h)return null;" +
        "h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+400,clientY:r.top+200,button:0,buttons:1,pointerId:31,pointerType:'mouse',altKey:true}));" +
        "vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:r.left+500,clientY:r.top+300,button:0,buttons:1,pointerId:31,pointerType:'mouse',altKey:true}));" +
        "vp.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+500,clientY:r.top+300,button:0,buttons:0,pointerId:31,pointerType:'mouse',altKey:true}));" +
        "return __test.elements();})()"
    );
    await run('__test.undo()');
    const unresized = await run('__test.elements()');
    const multiOk =
      Array.isArray(resized) &&
      Math.abs(resized[0].w - 133.333) < 0.5 &&
      Math.abs(resized[0].h - 200) < 0.5 &&
      Math.abs(resized[1].x - 366.667) < 0.5 &&
      unresized.length === 2 &&
      Math.abs(unresized[0].w - 100) < 0.001 &&
      Math.abs(unresized[1].x - 300) < 0.001;
    check('multi-resize', multiOk, { resized, unresized });

    // SEL-07：多选缩放必须包含 PolyEl
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    await run("__test.addPoly('triangle', 100, 100, 100, 100)");
    await run("__test.addShape('rect', 300, 100, 100, 100)");
    await run('__test.selectAll()');
    const polyResized = await run(
      "(() => {var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
        "var h=document.querySelector('#selection .handle.se');if(!h)return null;" +
        "h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+400,clientY:r.top+200,button:0,buttons:1,pointerId:32,pointerType:'mouse',altKey:true}));" +
        "vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:r.left+500,clientY:r.top+300,button:0,buttons:1,pointerId:32,pointerType:'mouse',altKey:true}));" +
        "vp.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+500,clientY:r.top+300,button:0,buttons:0,pointerId:32,pointerType:'mouse',altKey:true}));" +
        "return __test.elements();})()"
    );
    await run('__test.undo()');
    const polyUndone = await run('__test.elements()');
    const polyResizedEl = Array.isArray(polyResized) ? polyResized.find((el) => el.type === 'poly') : null;
    const polyUndoneEl = Array.isArray(polyUndone) ? polyUndone.find((el) => el.type === 'poly') : null;
    check(
      'multi-resize-poly',
      !!polyResizedEl && Math.abs(polyResizedEl.w - 133.333) < 0.5 && Math.abs(polyResizedEl.h - 200) < 0.5 &&
        !!polyUndoneEl && Math.abs(polyUndoneEl.w - 100) < 0.001,
      { polyResizedEl, polyUndoneEl }
    );

    // SEL-06：对齐 / 分布（一步撤销）
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    await run("__test.addShape('rect', 100, 100, 50, 50)");
    await run("__test.addShape('rect', 300, 120, 100, 60)");
    await run("__test.addShape('rect', 600, 400, 50, 50)");
    await run('__test.selectAll()');
    await run("__test.align('left')");
    const aligned = await run('__test.elements()');
    await run('__test.undo()');
    const alignUndone = await run('__test.elements()');
    await run('__test.selectAll()');
    await run("__test.distribute('x')");
    const distributed = await run('__test.elements()');
    const alignOk = aligned.every((el) => Math.abs(el.x - 100) < 0.001);
    const alignUndoOk = alignUndone.map((el) => Math.round(el.x)).join(',') === '100,300,600';
    const distributeOk =
      distributed.length === 3 &&
      Math.abs(distributed[0].x - 100) < 0.001 &&
      Math.abs(distributed[1].x - 325) < 0.001 &&
      Math.abs(distributed[2].x - 600) < 0.001;
    check('align-distribute', alignOk && alignUndoOk && distributeOk, { aligned, alignUndone, distributed });

    // 对齐后连接线端点必须跟随更新
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const alignA = await run("__test.addShape('rect', 100, 100, 80, 80)");
    const alignB = await run("__test.addShape('rect', 400, 300, 80, 80)");
    const alignConn = await run('__test.connect(' + j(alignA) + ',' + j(alignB) + ')');
    const connBeforeAlign = await run('__test.el(' + j(alignConn) + ')');
    await run('__test.select(' + j([alignA, alignB]) + ')');
    await run("__test.align('top')");
    const connAfterAlign = await run('__test.el(' + j(alignConn) + ')');
    await run('__test.undo()');
    const connUndone = await run('__test.el(' + j(alignConn) + ')');
    check(
      'align-connector',
      connBeforeAlign && connAfterAlign && connUndone &&
        Math.abs(connBeforeAlign.y2 - connAfterAlign.y2) > 100 &&
        Math.abs(connUndone.y2 - connBeforeAlign.y2) < 0.001,
      { connBeforeAlign, connAfterAlign, connUndone }
    );

    // EDT-19/20：线型与透明度贯通控件、DOM、SVG 与保存
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const styleId = await run("__test.addShape('rect', 100, 100, 100, 100)");
    await run('__test.select(' + j([styleId]) + ')');
    const dashValue = await run(
      "(() => {document.querySelector('[data-row=\"dash\"] button[data-value=\"dash\"]').click();return __test.el(" + j(styleId) + ").dash;})()"
    );
    const opacityValue = await run(
      "(() => {const r=document.getElementById('opacity-range');r.value='50';r.dispatchEvent(new Event('change'));return __test.el(" + j(styleId) + ").opacity;})()"
    );
    const styleDom = await run(
      "(() => {const n=document.querySelector('[data-id=\"" + styleId + "\"]');const p=n.querySelector('path');" +
        "return {opacity:n.style.opacity,dash:p?p.getAttribute('stroke-dasharray'):''};})()"
    );
    const styleSvg = await run('__test.exportSvgTo(' + j(tmpStyleSvg) + ')');
    let styleSvgOk = false;
    try {
      const text = fs.readFileSync(tmpStyleSvg, 'utf8');
      styleSvgOk = styleSvg === true && text.includes('stroke-dasharray') && text.includes('opacity="0.5"');
    } catch {
      styleSvgOk = false;
    }
    await run('__test.saveTo(' + j(tmpWbc) + ')');
    const styleSaved = readDoc();
    const savedStyle = styleSaved && styleSaved.elements && styleSaved.elements.find((el) => el.id === styleId);
    check(
      'stroke-dash-opacity',
      dashValue === 'dash' && opacityValue === 0.5 && styleDom.opacity === '0.5' && !!styleDom.dash &&
        styleSvgOk && savedStyle && savedStyle.dash === 'dash' && savedStyle.opacity === 0.5,
      { dashValue, opacityValue, styleDom, styleSvgOk, savedStyle }
    );

    // FILE-16：删除页面前备份 + 撤销/重做
    await run('__test.reset()');
    await run("__test.addText('页一', 100, 100)");
    await run("__test.addPage('第二页')");
    await run('__test.switchPage(1)');
    await run("__test.addText('页二', 100, 100)");
    const pageBackupsBefore = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
    const pageDeleted = await run('__test.deletePage(1)');
    const pageBackupsAfter = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
    const afterDelete = await run('({names:__test.pageNames(),active:__test.activePage(),count:__test.count()})');
    const pageUndone = await run('__test.undo()');
    const afterUndoPage = await run('({names:__test.pageNames(),active:__test.activePage(),count:__test.count()})');
    const pageRedone = await run('__test.redo()');
    const afterRedoPage = await run('({names:__test.pageNames(),active:__test.activePage()})');
    check(
      'page-delete-undo',
      pageDeleted === true && pageBackupsAfter > pageBackupsBefore && afterDelete.names.length === 1 &&
        pageUndone === true && afterUndoPage.names.length === 2 && afterUndoPage.active === 1 && afterUndoPage.count === 1 &&
        pageRedone === true && afterRedoPage.names.length === 1,
      { pageDeleted, pageBackupsBefore, pageBackupsAfter, afterDelete, pageUndone, afterUndoPage, pageRedone, afterRedoPage }
    );

    // UI-12：演示模式隐藏界面、翻页并恢复视图
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    await run("__test.addText('演示页', 100, 100)");
    await run("__test.addPage('第二页')");
    await run('__test.setView(1, 0, 0)');
    const presentZoom = await run('__test.zoomPercent()');
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'F5',bubbles:true,cancelable:true}))");
    let presentEntered = false;
    for (let i = 0; i < 40 && !presentEntered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      presentEntered = await run('__test.isPresenting()');
    }
    const presentDom = await run(
      "({active:__test.isPresenting(),body:document.body.classList.contains('presenting')," +
        "toolbar:getComputedStyle(document.getElementById('toolbar')).display," +
        "topbar:getComputedStyle(document.getElementById('topbar')).display})"
    );
    const presentMoved = await run('__test.presentPage(1)');
    const presentPageIndex = await run('__test.activePage()');
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    let presentExited = false;
    for (let i = 0; i < 40 && !presentExited; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      presentExited = !(await run('__test.isPresenting()'));
    }
    const presentRestored = await run(
      "({active:__test.isPresenting(),body:document.body.classList.contains('presenting'),zoom:__test.zoomPercent()})"
    );
    check(
      'presentation-mode',
      presentEntered === true && presentDom.active === true && presentDom.body === true &&
        presentDom.toolbar === 'none' && presentDom.topbar === 'none' && presentMoved === true && presentPageIndex === 1 &&
        presentExited === true && presentRestored.active === false && presentRestored.body === false && presentRestored.zoom === presentZoom,
      { presentZoom, presentEntered, presentDom, presentMoved, presentPageIndex, presentExited, presentRestored }
    );

    // 缩放到选中 + 百分比输入
    await run('__test.reset()');
    await run("__test.addShape('rect', 100, 100, 100, 100)");
    await run('__test.selectAll()');
    await run('__test.fitSelection()');
    const fitZoom = await run('__test.zoomPercent()');
    const typedZoom = await run(
      "(() => {const input=document.getElementById('zoom-input');input.value='200';input.dispatchEvent(new Event('change'));return __test.zoomPercent();})()"
    );
    check('zoom-selection-percent', fitZoom > 100 && typedZoom === 200, { fitZoom, typedZoom });
    await run('__test.setView(1, 0, 0)');

    // Tab 循环 / Esc
    await run('__test.reset()');
    await run("__test.addShape('rect', 100, 100, 60, 60)");
    await run("__test.addShape('rect', 300, 100, 60, 60)");
    const tabSelection = await run(
      "(() => {const fire=(key,shiftKey)=>window.dispatchEvent(new KeyboardEvent('keydown',{key:key,shiftKey:shiftKey,bubbles:true,cancelable:true}));" +
        "fire('Tab',false);const a=__test.selectedIds();fire('Tab',false);const b=__test.selectedIds();fire('Tab',true);const c=__test.selectedIds();" +
        "document.querySelector('button[data-tool=\"rect\"]').click();fire('Escape',false);" +
        "return {a:a,b:b,c:c,tool:document.querySelector('button[data-tool=\"select\"]').classList.contains('active')};})()"
    );
    check('tab-escape', tabSelection.a.length === 1 && tabSelection.b.length === 1 && tabSelection.a[0] !== tabSelection.b[0] &&
      tabSelection.c[0] === tabSelection.a[0] && tabSelection.tool === true, tabSelection);

    // 上下文菜单 + 键盘可达
    await run('__test.reset()');
    const menuState = await run(
      "(() => {const vp=document.getElementById('viewport');const r=vp.getBoundingClientRect();" +
        "vp.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+600,clientY:r.top+500}));" +
        "const menu=document.getElementById('context-menu');const labels=Array.from(menu.querySelectorAll('button')).map(b=>b.textContent);" +
        "const wasOpen=!menu.hidden;const focused=document.activeElement&&document.activeElement.className;" +
        "menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));" +
        "return {open:wasOpen, labels:labels, focused:focused, closed:menu.hidden};})()"
    );
    check('context-menu', menuState.open === true && menuState.closed === true && menuState.labels.includes('新建文字') && menuState.focused.includes('menu-item'), menuState);

    // 视口剔除
    await run('__test.reset()');
    await run(
      "(() => {for(let i=0;i<400;i++){__test.addShape('rect', 20000+i*40, 20000+(i%10)*40, 30, 30);}return __test.mountedCount();})()"
    );
    const mountedFar = await run('__test.mountedCount()');
    const mountedTotal = await run('__test.count()');
    await run('__test.setView(1, -20000, -20000)');
    const mountedNear = await run('__test.mountedCount()');
    check('viewport-culling', mountedTotal === 400 && mountedFar < 20 && mountedNear > 0 && mountedNear < 400, {
      mountedFar,
      mountedNear,
      mountedTotal
    });

    // 状态栏 + 小地图
    await run('__test.reset()');
    await run("__test.addText('状态', 100, 100)");
    await run('__test.selectAll()');
    const statusText = await run('__test.statusInfo()');
    const minimap = await run(
      "(() => {const c=document.getElementById('minimap-canvas');const b=document.getElementById('minimap-body');return {w:c.width,h:c.height,hidden:b.hidden};})()"
    );
    check('status-minimap', /选中 1\/1/.test(statusText) && minimap.w > 0 && minimap.h > 0, { statusText, minimap });

    // 低配模式：隐藏小地图与标尺，且不影响文档操作
    const lowSpecApplied = await run(
      "(async()=>{const ok=await __test.applySettings({lowSpec:true});" +
        "const m=document.getElementById('minimap');const r=document.getElementById('ruler-h');" +
        "return {ok,minimapHidden:m.hidden,rulerHidden:r.hidden};})()"
    );
    await run('__test.reset()');
    await run("__test.addShape('rect', 100, 100, 80, 60)");
    const lowSpecCount = await run('__test.count()');
    const lowSpecOff = await run("(async()=>{await __test.applySettings({lowSpec:false});return true;})()");
    check(
      'low-spec-mode',
      lowSpecApplied.ok === true && lowSpecApplied.minimapHidden === true && lowSpecApplied.rulerHidden === true &&
        lowSpecCount === 1 && lowSpecOff === true,
      { lowSpecApplied, lowSpecCount, lowSpecOff }
    );

    // 低配模式：便签阴影改用边框、荧光笔混合模式关闭（软件光栅化下成本高）
    await run('__test.reset()');
    await run("__test.addSticky('便签', 100, 100)");
    await run("__test.addInk([[200,200],[260,240]], '#111', 4, true)");
    const effects = async () =>
      run(
        "(() => {const nodes=[...document.getElementById('world').children].filter(n=>n.id!=='editor');" +
          "let shadow='none',blend='normal',border='';" +
          "for(const n of nodes){const s=n.style;" +
          "if(s.boxShadow&&s.boxShadow!=='none')shadow=s.boxShadow;" +
          "if(s.mixBlendMode)blend=s.mixBlendMode;" +
          "if(s.border)border=s.border;}" +
          'return {shadow,blend,border};})()'
      );
    const effectsNormal = await effects();
    await run("(async()=>{await __test.applySettings({lowSpec:true});return 1;})()");
    const effectsLow = await effects();
    await run("(async()=>{await __test.applySettings({lowSpec:false});return 1;})()");
    check(
      'low-spec-effects',
      /10px/.test(effectsNormal.shadow) && effectsNormal.blend === 'multiply' &&
        effectsLow.shadow === 'none' && effectsLow.blend === 'normal' && /10px/.test(effectsLow.border),
      { effectsNormal, effectsLow }
    );

    // 导出选中区域 + 复制选区 PNG
    await run('__test.reset()');
    await run("__test.addShape('rect', 100, 100, 100, 100)");
    await run("__test.addShape('rect', 500, 500, 100, 100)");
    const firstId = await run('__test.order()');
    await run('__test.select(' + j(firstId.slice(0, 1)) + ')');
    const selExported = await run('__test.exportSelectionPngTo(' + j(tmpSelPng) + ')');
    const selSize = selExported ? pngSize(tmpSelPng) : null;
    const copied = await run('__test.copySelectionPng()');
    await run('__test.select([])');
    await run('__test.exportPngTo(' + j(tmpPng) + ')');
    const fullSize = pngSize(tmpPng);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const clipImage = clipboard.readImage();
    check(
      'export-selection-copy',
      !!selSize && selSize.w === 360 && selSize.h === 360 && fullSize.w > selSize.w && copied === true && !clipImage.isEmpty(),
      { selSize, fullSize, copied, clipEmpty: clipImage.isEmpty() }
    );

    // 图片操作 + v2 图片去重
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await run('__test.reset()');
    const imgId = await run('__test.addImage(' + j(tinyPng) + ', 100, 100)');
    await run('__test.addImage(' + j(tinyPng) + ', 300, 100)');
    await run('__test.saveTo(' + j(tmpZip) + ')');
    const zipFiles = zip.read(fs.readFileSync(tmpZip));
    const docJson = zipFiles.get('doc.json').toString('utf8');
    const assetNames = Array.from(zipFiles.keys()).filter((name) => name.startsWith('assets/'));
    check(
      'v2-zip-dedupe',
      !!imgId && assetNames.length === 1 && docJson.length < 1024 * 1024 && docJson.includes('asset:') && !docJson.includes('base64,'),
      { assets: assetNames, jsonSize: docJson.length }
    );
    await run('__test.select(' + j([imgId]) + ')');
    await run("__test.imageFit(" + j(imgId) + ", 'fit-width')");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fitted = await run('__test.el(' + j(imgId) + ')');
    const replaced = await run('__test.replaceImage(' + j(imgId) + ', ' + j(tinyPng) + ')');
    check('image-fit-replace', fitted && fitted.w > 100 && replaced === true, { fitted, replaced });

    // 拖入已保存的 v2（zip）文档：必须走主进程读取而不是 File.text()
    await run('__test.reset()');
    const dropped = await run(
      "(async () => {const dt=new DataTransfer();const f=new File(['x'],'saved.wbc',{type:'application/octet-stream'});" +
        "Object.defineProperty(f,'path',{value:" + j(tmpZip) + "});dt.items.add(f);" +
        "document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:400,clientY:300}));" +
        "await new Promise(r=>setTimeout(r,600));return {count:__test.count(),types:__test.elements().map(e=>e.type)};})()"
    );
    check('drop-v2-open', dropped.count === 2 && dropped.types.every((type) => type === 'image'), dropped);

    // v1 迁移（备份原文件后打开）
    const beforeBackups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
    fs.writeFileSync(
      tmpV1,
      JSON.stringify({ app: 'whiteboard-canvas', version: 1, elements: [{ id: 'v1rect', type: 'rect', x: 10, y: 10, w: 50, h: 50, stroke: '#1f2937', strokeWidth: 2 }] }),
      'utf8'
    );
    await run('__test.reset()');
    const v1Opened = await run('__test.openFrom(' + j(tmpV1) + ')');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterBackups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
    const v1Count = await run('__test.count()');
    check('v1-migration-backup', v1Opened === true && v1Count === 1 && afterBackups > beforeBackups, {
      v1Opened,
      v1Count,
      beforeBackups,
      afterBackups
    });

    // 设置（隔离 userData）与关联状态（只读）
    const settingsRoundTrip = await run(
      "(async () => {const before=await window.api.getSettings();const saved=await window.api.setSettings({autosaveDelay:2});" +
        "const after=await window.api.getSettings();await window.api.setSettings({autosaveDelay:1});" +
        "const assoc=await window.api.getAssociation();return {before:before.autosaveDelay,saved:saved.autosaveDelay,after:after.autosaveDelay,assoc:assoc.supported};})()"
    );
    check(
      'settings-association',
      settingsRoundTrip.before === 1 && settingsRoundTrip.saved === 2 && settingsRoundTrip.after === 2 && settingsRoundTrip.assoc === true,
      settingsRoundTrip
    );

    // 崩溃恢复快照（3 秒内，含未提交的编辑草稿与多页结构）与清除
    await run('__test.reset()');
    await run("__test.addText('恢复测试', 100, 100)");
    await run("__test.addPage('第二页')");
    const editOpened = await run(
      "(() => {const vp=document.getElementById('viewport');const r=vp.getBoundingClientRect();" +
        "vp.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:r.left+150,clientY:r.top+115}));" +
        "const e=document.getElementById('editor');e.value='恢复测试草稿';e.dispatchEvent(new Event('input',{bubbles:true}));" +
        "return !e.hidden;})()"
    );
    await new Promise((resolve) => setTimeout(resolve, 3800));
    const recoveryList = () =>
      fs.existsSync(recoveryDir)
        ? fs.readdirSync(recoveryDir).filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))
        : [];
    const recoveryFiles = recoveryList();
    const recoveryExists = recoveryFiles.length > 0;
    let recoveryOk = false;
    if (recoveryExists) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(recoveryDir, recoveryFiles[0]), 'utf8'));
        recoveryOk =
          doc.pages && doc.pages.length === 2 && doc.activePage === 0 &&
          doc.pages[0].elements.some((el) => el.type === 'text' && el.text === '恢复测试草稿');
      } catch {
        recoveryOk = false;
      }
    }
    await run("(() => {const e=document.getElementById('editor');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;})()");
    await run('window.api.clearRecovery()');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const recoveryDbg = await run('__test.recoveryDebug()');
    check('recovery-snapshot', editOpened === true && recoveryExists && recoveryOk && recoveryList().length === 0, {
      editOpened,
      recoveryExists,
      recoveryOk,
      cleared: recoveryList().length === 0,
      recoveryDbg
    });

    // 多窗口/多文档恢复快照互不覆盖（按 key 隔离）
    await run(
      "(async () => {await window.api.writeRecovery('{\"doc\":\"A\"}', '', 'smokeKeyA', null);" +
        "await window.api.writeRecovery('{\"doc\":\"B\"}', '', 'smokeKeyB', null);return true;})()"
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    const isolated = recoveryList();
    const hasA = isolated.includes('smokeKeyA.json');
    const hasB = isolated.includes('smokeKeyB.json');
    await run("window.api.clearRecovery('smokeKeyA')");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterClearA = recoveryList();
    await run("window.api.clearRecovery('smokeKeyB')");
    check('recovery-isolation', hasA && hasB && !afterClearA.includes('smokeKeyA.json') && afterClearA.includes('smokeKeyB.json'), {
      isolated,
      afterClearA
    });

    // 日志
    const logFile = path.join(userData, 'logs', 'main.log');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('local-log', logText.includes('应用启动') && logText.includes('保存文档'), { hasStartup: logText.includes('应用启动') });

    // P2：更多形状 / 旋转 / 分组 / 锁定 / 面板 / 搜索 / 套索 / 格式刷 / 便签 / 富文本 / 连接线 / 页面 / SVG / 裁剪
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const p2poly = await run("__test.addPoly('triangle', 100, 100, 100, 100)");
    await run('__test.setFill(' + j(p2poly) + ", 'rgba(37,99,235,0.3)')");
    const p2hit = await run('__test.hitTest(150, 160)');
    await run('__test.setRotation(' + j(p2poly) + ', 45)');
    const p2rot = await run('__test.el(' + j(p2poly) + ')');
    const p2groupA = await run("__test.addShape('rect', 300, 100, 80, 80)");
    const p2groupB = await run("__test.addShape('rect', 420, 100, 80, 80)");
    await run('__test.select(' + j([p2groupA, p2groupB]) + ')');
    await run('__test.groupSelection()');
    await run('__test.select(' + j([p2groupA]) + ')');
    await run('__test.nudge(5, 0)');
    const p2grouped = await run('__test.elements()');
    const p2moved = p2grouped.filter((el) => el.id === p2groupA || el.id === p2groupB).map((el) => el.x);
    await run('__test.setLocked(' + j(p2groupA) + ', true)');
    await run('__test.select(' + j([p2groupA]) + ')');
    const p2lockedHit = await run('__test.hitTest(400, 140)');
    await run('__test.setLocked(' + j(p2groupA) + ', false)');
    check(
      'p2-shape-rotation-group-lock',
      p2hit === 'poly' && p2rot && Math.abs(p2rot.rotation - 45) < 0.001 && p2moved[0] > 300 && p2lockedHit === null,
      { p2hit, p2rot, p2moved, p2lockedHit }
    );

    await run('__test.reset()');
    await run("__test.addText('搜索目标', 100, 100)");
    await run("__test.addShape('rect', 300, 100, 80, 80)");
    const p2search = await run("__test.search('搜索目标')");
    await run('togglePanels = true');
    const p2panels = await run(
      "(() => {document.getElementById('panel-btn').click();const rows=document.querySelectorAll('.layer-row').length;" +
        "const tabs=document.querySelectorAll('.panel-tabs button');const icons=document.querySelectorAll('#sidepanel svg').length;" +
        "tabs[1].click();const history=document.querySelectorAll('.history-row').length;" +
        "document.getElementById('panel-btn').click();return {rows,history,icons,label:__test.elementLabel(__test.order()[0])};})()"
    );
    const p2lasso = await run(
      '__test.lasso([[90,90],[280,90],[280,220],[90,220]], false)'
    );
    check('p2-panels-search-lasso', p2search.length === 1 && p2panels.rows === 2 && p2panels.history > 0 && p2panels.icons >= 6 && p2lasso.length >= 1, { p2search, p2panels, p2lasso });

    await run('__test.reset()');
    const fmtA = await run("__test.addShape('rect', 100, 100, 80, 80)");
    await run('__test.setFill(' + j(fmtA) + ", 'rgba(220,38,38,0.3)')");
    await run('__test.select(' + j([fmtA]) + ')');
    await run('__test.copyFormat()');
    const fmtB = await run("__test.addShape('rect', 300, 100, 80, 80)");
    await run('__test.pasteFormat(' + j(fmtB) + ')');
    const fmtEl = await run('__test.el(' + j(fmtB) + ')');
    const stickyId = await run("__test.addSticky('便签内容', 500, 100)");
    const stickyEl = await run('__test.el(' + j(stickyId) + ')');
    const richId = await run("__test.addText('富文本', 100, 300)");
    await run('__test.setTextStyle(' + j(richId) + ", {bold:true, align:'center', underline:true})");
    const richEl = await run('__test.el(' + j(richId) + ')');
    check(
      'p2-format-sticky-rich',
      fmtEl && fmtEl.fill === 'rgba(220,38,38,0.3)' && stickyEl && stickyEl.sticky === true && richEl && richEl.bold === true && richEl.align === 'center',
      { fmtEl, stickyEl, richEl }
    );

    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const connA = await run("__test.addShape('rect', 100, 100, 80, 80)");
    const connB = await run("__test.addShape('rect', 400, 100, 80, 80)");
    const connId = await run('__test.connect(' + j(connA) + ',' + j(connB) + ')');
    const connBefore = await run('__test.el(' + j(connId) + ')');
    await run('__test.move(' + j(connA) + ', 0, 100)');
    const connAfter = await run('__test.el(' + j(connId) + ')');
    check(
      'p2-connector-follow',
      connBefore && connAfter && Math.abs(connBefore.y1 - connAfter.y1) > 10 && connAfter.fromId === connA && connAfter.toId === connB,
      { connBefore, connAfter }
    );

    await run('__test.reset()');
    await run("__test.addText('页一', 100, 100)");
    await run("__test.addPage('第二页')");
    await run('__test.switchPage(1)');
    await run("__test.addText('页二', 100, 100)");
    const p2pages = await run('__test.pageNames()');
    await run('__test.saveTo(' + j(tmpPages) + ')');
    const pagesDoc = readDoc(tmpPages);
    const p2history = await run(
      '(() => {const labels=__test.history();__test.jumpHistory(0);return {labels,count:__test.count()};})()'
    );
    check(
      'p2-pages-history',
      p2pages.length === 2 && pagesDoc && pagesDoc.pages && pagesDoc.pages.length === 2 &&
        pagesDoc.pages[1].elements.length === 1 && p2history.labels.length > 0 && p2history.count === 0,
      { p2pages, pages: pagesDoc && pagesDoc.pages && pagesDoc.pages.length, p2history }
    );

    await run('__test.reset()');
    await run("__test.addShape('ellipse', 100, 100, 120, 80)");
    const p2svg = await run('__test.exportSvgTo(' + j(tmpSvg) + ')');
    let svgOk = false;
    try {
      const text = fs.readFileSync(tmpSvg, 'utf8');
      svgOk = p2svg === true && text.startsWith('<?xml') && text.includes('<svg') && text.includes('<ellipse');
    } catch {
      svgOk = false;
    }
    const tinyImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const cropId = await run('__test.addImage(' + j(tinyImg) + ', 300, 300)');
    const cropped = await run('__test.crop(' + j(cropId) + ', {x:0,y:0,w:0.5,h:0.5}, true, false)');
    const cropEl = await run('__test.el(' + j(cropId) + ')');
    check('p2-svg-crop', svgOk && cropped === true && cropEl && cropEl.crop && cropEl.crop.w === 0.5, { svgOk, cropped, cropEl });

    await run('__test.reset()');
    const svgTextId = await run("__test.addText('SVG 字体', 100, 100)");
    await run('__test.setTextStyle(' + j(svgTextId) + ", {bold:true, fontFamily:'SimSun', fontSize:32})");
    const svgTextExport = await run('__test.exportSvgTo(' + j(tmpStyleSvg) + ')');
    let svgTextOk = false;
    try {
      const text = fs.readFileSync(tmpStyleSvg, 'utf8');
      svgTextOk = svgTextExport === true && text.includes('font-size="32"') && text.includes('font-family="SimSun"') &&
        text.includes('font-weight="700"') && !text.includes(' font="');
    } catch {
      svgTextOk = false;
    }
    check('svg-text-font', svgTextOk, { svgTextOk });

    // P2：主题/语言/图标/无障碍/设置持久化
    await run('__test.reset()');
    const focusId = await run("__test.addText('焦点', 100, 100)");
    const uiState = await run(
      "(async () => {const ok=await __test.applySettings({theme:'dark',language:'en'});" +
        "const dark=document.body.classList.contains('dark');" +
        "const label=document.querySelector('button[data-tool=\"pen\"]').title;" +
        "const icons=document.querySelectorAll('#toolbar svg').length;" +
        "const focus=__test.focusElement(" + j(focusId) + ");" +
        "const aria=document.querySelector('[data-id=\"" + focusId + "\"]').getAttribute('aria-label');" +
        "const focusAttr=document.querySelector('[data-id=\"" + focusId + "\"]').tabIndex;" +
        "await __test.applySettings({theme:'light',language:'zh'});" +
        "return {ok,dark,label,icons,focus,aria,focusAttr,restored:!document.body.classList.contains('dark')};})()"
    );
    check(
      'p2-theme-lang-icons-a11y',
      uiState.ok === true && uiState.dark === true && uiState.label === 'Pen' && uiState.icons >= 16 &&
        uiState.focus === true && uiState.focusAttr === -1 && uiState.restored === true,
      uiState
    );

    // P2：损坏文件修复（截断 JSON 与截断 ZIP）
    fs.writeFileSync(
      tmpRepairJson,
      '{"app":"whiteboard-canvas","version":3,"elements":[' +
        '{"id":"r1","type":"rect","x":0,"y":0,"w":50,"h":50,"stroke":"#000","strokeWidth":2},' +
        '{"id":"r2","type":"ellipse","x":60,"y":0,"w":50,"h":50,"stroke":"#000","strokeWidth":2}',
      'utf8'
    );
    const repairDoc = {
      app: 'whiteboard-canvas',
      version: 3,
      pages: [{ id: 'x', name: '页', elements: [{ id: 'z', type: 'rect', x: 0, y: 0, w: 20, h: 20, stroke: '#000', strokeWidth: 1 }] }]
    };
    const completeZip = zip.write([{ name: 'doc.json', data: Buffer.from(JSON.stringify(repairDoc)) }]);
    fs.writeFileSync(tmpRepairZip, completeZip.subarray(0, completeZip.length - 8));
    await run('__test.reset()');
    const repair1 = await run('__test.openFrom(' + j(tmpRepairJson) + ')');
    const repair1Count = await run('__test.count()');
    await run('__test.reset()');
    const repair2 = await run('__test.openFrom(' + j(tmpRepairZip) + ')');
    const repair2Count = await run('__test.count()');
    check('p2-corruption-repair', repair1 === true && repair1Count === 2 && repair2 === true && repair2Count === 1, {
      repair1,
      repair1Count,
      repair2,
      repair2Count
    });

    // 打印参数校验（真实打印对话框由人工验证）
    const badPrint = await run("window.api.printPng('bad', 'pdf')");
    check('print-validation', !!badPrint && typeof badPrint.error === 'string', badPrint);

    // PDF 生成（打印对话框由人工在 Windows 上验证）
    const pdfOk = await run('__test.printPdfTo(' + j(tmpPdf) + ')');
    let pdfHeader = false;
    try {
      const buf = fs.readFileSync(tmpPdf);
      pdfHeader = buf.slice(0, 4).toString() === '%PDF' && buf.length > 1000;
    } catch {
      pdfHeader = false;
    }
    check('print-pdf', pdfOk === true && pdfHeader, { pdfOk, pdfHeader });

    const collapse = await run(
      "(() => {const b=document.getElementById('minimap-body');const t=document.getElementById('minimap-toggle');" +
        "const before=b.hidden;t.click();const after=b.hidden;t.click();return {before:before,after:after,restored:b.hidden};})()"
    );
    check('minimap-collapse', collapse.before === false && collapse.after === true && collapse.restored === false, collapse);
    // 恶意/非法输入加固（SEC-07）
    fs.writeFileSync(
      tmpBad,
      JSON.stringify({
        app: 'whiteboard-canvas',
        version: 2,
        elements: [
          { id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 123, fontSize: 12 },
          { id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' },
          { id: 'k', type: 'ink', x: 0, y: 0, w: 10, h: 10, width: 3, points: [['a', 'b']] },
          { id: 'r', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000', strokeWidth: 2 }
        ]
      }),
      'utf8'
    );
    fs.writeFileSync(tmpBadZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]));
    await run('__test.reset()');
    const sanitizedOpen = await run('__test.openFrom(' + j(tmpBad) + ')');
    const sanitizedCount = await run('__test.count()');
    const badZipOpen = await run('__test.openFrom(' + j(tmpBadZip) + ')');
    const invalidIpc = await run(
      "(async () => ({save: await window.api.saveDoc(null, 123), png: await window.api.savePng('x')}))()"
    );
    check(
      'input-hardening',
      sanitizedOpen === true && sanitizedCount === 2 && badZipOpen === false &&
        !!invalidIpc.save && typeof invalidIpc.save.error === 'string' &&
        !!invalidIpc.png && typeof invalidIpc.png.error === 'string',
      { sanitizedOpen, sanitizedCount, badZipOpen, invalidIpc }
    );

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

    // BUG-04：输入框/输入法组合期间不触发画布快捷键
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const kbText = await run("__test.addText('键盘隔离', 100, 100)");
    await run('__test.select(' + j([kbText]) + ')');
    const kb = await run(
      "(() => {const bar=document.getElementById('searchbar');const input=document.getElementById('search-input');" +
        "bar.hidden=false;input.focus();" +
        "const activeTool=()=>{const b=document.querySelector('#toolbar button.active');return b?b.dataset.tool:'';};" +
        "const before={count:__test.count(),selected:__test.selectedIds().length,tool:activeTool()};" +
        "const fire=(key,extra)=>input.dispatchEvent(new KeyboardEvent('keydown',Object.assign({key,bubbles:true,cancelable:true},extra||{})));" +
        "['Delete','Backspace','ArrowRight','r','1',' '].forEach(k=>fire(k));fire('r',{isComposing:true,keyCode:229});" +
        "const dt=new DataTransfer();dt.setData('text/plain','不应写入画布');" +
        "input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));" +
        "const after={count:__test.count(),selected:__test.selectedIds().length,tool:activeTool()};" +
        "input.value='';input.blur();bar.hidden=true;" +
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));" +
        "const afterIme=activeTool();return {before,after,afterIme};})()"
    );
    check(
      'keyboard-input-isolation',
      kb.before.count === 1 && kb.after.count === 1 && kb.before.selected === 1 && kb.after.selected === 1 &&
        kb.before.tool === kb.after.tool && kb.afterIme === kb.before.tool,
      kb
    );

    // BUG-05：隐藏/锁定元素不参与全选、框选、Tab；锁定元素不可剪切
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    const selA = await run("__test.addShape('rect', 100, 100, 80, 80)");
    const selHidden = await run("__test.addShape('rect', 220, 100, 80, 80)");
    const selLocked = await run("__test.addShape('rect', 340, 100, 80, 80)");
    const selB = await run("__test.addShape('rect', 460, 100, 80, 80)");
    const selFar = await run("__test.addShape('rect', 5000, 5000, 80, 80)");
    await run('__test.setHidden(' + j(selHidden) + ', true)');
    await run('__test.setLocked(' + j(selFar) + ', false)');
    await run('__test.setHidden(' + j(selFar) + ', true)');
    await run('__test.setLocked(' + j(selLocked) + ', true)');
    const selectAllIds = await run('__test.selectAll(); __test.selectedIds()');
    const marqueeIds = await run(
      "(() => {const vp=document.getElementById('viewport');const r=vp.getBoundingClientRect();" +
        "const fire=(t,x,y,b,bs)=>vp.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:r.left+x,clientY:r.top+y,button:b,buttons:bs,pointerId:41,pointerType:'mouse'}));" +
        "__test.select([]);fire('pointerdown',50,50,0,1);fire('pointermove',600,300,0,1);fire('pointerup',600,300,0,0);return __test.selectedIds();})()"
    );
    const tabIds = await run(
      "(() => {__test.select([]);document.body.tabIndex=-1;document.body.focus();const out=[];" +
        "for(let i=0;i<6;i++){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));out.push(__test.selectedIds()[0]);}" +
        "return out;})()"
    );
    await run("__test.select([]);document.getElementById('zoom-fit').click()");
    const hiddenFitZoom = await run('__test.zoomPercent()');
    await run('__test.select(' + j([selLocked]) + ')');
    const beforeCut = await run('__test.count()');
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'x',ctrlKey:true,bubbles:true,cancelable:true}))");
    const afterCut = await run('__test.count()');
    const selFilterOk = (ids) => ids.length === 2 && ids.includes(selA) && ids.includes(selB) && !ids.includes(selHidden) && !ids.includes(selLocked);
    check(
      'selection-visibility',
      selFilterOk(selectAllIds) && selFilterOk(marqueeIds) &&
        tabIds.every((id) => id === selA || id === selB) &&
        hiddenFitZoom > 50 && beforeCut === afterCut,
      { selectAllIds, marqueeIds, tabIds, fitZoom: hiddenFitZoom, beforeCut, afterCut }
    );

    // BUG-06：单击选中不创建历史快照
    await run('__test.reset()');
    await run('__test.setView(1, 0, 0)');
    await run("__test.addShape('rect', 300, 140, 80, 80)");
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    const beforeClick = await run('__test.historyStats()');
    const afterDown = await run(
      "(function(){var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();vp.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+340,clientY:r.top+180,button:0,buttons:1,pointerId:42,pointerType:'mouse'}));return __test.historyStats();})()"
    );
    const afterClick = await run(
      "(function(){var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();vp.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+340,clientY:r.top+180,button:0,buttons:0,pointerId:42,pointerType:'mouse'}));return __test.historyStats();})()"
    );
    check('history-no-clone-on-click', afterClick.clones === beforeClick.clones && afterClick.entries === beforeClick.entries, { beforeClick, afterDown, afterClick });

    // BUG-03：外部修改检测 + 并发保存不损坏文件
    await run('__test.reset()');
    await run("__test.addText('外部修改', 100, 100)");
    const firstSave = await run('__test.saveDetailed(' + j(tmpConflict) + ')');
    fs.writeFileSync(tmpConflict, 'external-change', 'utf8');
    const secondSave = await run('__test.saveDetailed(' + j(tmpConflict) + ')');
    const concurrentText = await run('__test.serialized()');
    const concurrent = await run(
      "(async () => {const a=await window.api.saveDoc(" + j(tmpConcurrent) + "," + j(concurrentText) + ",false,null);" +
        "const b=await window.api.saveDoc(" + j(tmpConcurrent) + "," + j(concurrentText) + ",false,null);" +
        "return {a:!!a.path,b:!!b.path};})()"
    );
    const concurrentDoc = readDoc(tmpConcurrent);
    check(
      'save-conflict-and-lock',
      firstSave && !!firstSave.path && !!firstSave.stamp && secondSave && secondSave.conflict === true &&
        concurrent.a === true && concurrent.b === true && !!concurrentDoc && concurrentDoc.app === 'whiteboard-canvas',
      { firstSave, secondSave, concurrent, concurrentDoc: !!concurrentDoc }
    );

    // P1：页面复制、只读模式、查找替换、编号列表
    await run('__test.reset()');
    await run("__test.addText('页一', 100, 100)");
    const dupPageId = await run('__test.duplicatePage(0)');
    const dupPages = await run('__test.pageNames()');
    await run('__test.switchPage(1)');
    await run("__test.addText('副本新增', 100, 200)");
    await run('__test.switchPage(0)');
    const dupCounts = await run('({first:__test.count(),pages:__test.pageNames().length})');
    check('page-duplicate', !!dupPageId && dupPages.length === 2 && dupCounts.first === 1 && dupCounts.pages === 2, { dupPageId, dupPages, dupCounts });

    await run('__test.reset()');
    await run("__test.addShape('rect', 100, 100, 80, 80)");
    await run('__test.selectAll()');
    await run('__test.setReadOnly(true);__test.setEraserMode("object")');
    const readOnlyState = await run(
      "(() => {const before=__test.count();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));" +
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true,cancelable:true}));" +
        "return {readonly:__test.isReadOnly(),count:__test.count(),before};})()"
    );
    await run('__test.setReadOnly(false);__test.selectAll()');
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))");
    const afterUnlockDelete = await run('__test.count()');
    check('readonly-mode', readOnlyState.readonly === true && readOnlyState.count === readOnlyState.before && afterUnlockDelete === 0, {
      readOnlyState,
      afterUnlockDelete
    });

    await run('__test.reset()');
    const replaceA = await run("__test.addText('foo one', 100, 100)");
    const replaceB = await run("__test.addText('foo two', 100, 200)");
    const replacedCount = await run("__test.replace('foo','bar',true)");
    const replacedTexts = await run('__test.elements().map(e=>e.type==="text"?__test.el(e.id).text:"")');
    check('find-replace', replacedCount === 2 && replacedTexts.includes('bar one') && replacedTexts.includes('bar two'), { replaceA, replaceB, replacedCount, replacedTexts });

    await run('__test.reset()');
    const numberedId = await run("__test.addText('第一行\\n第二行', 100, 100)");
    await run('__test.setTextStyle(' + j(numberedId) + ", {numbered:true})");
    const numberedEl = await run('__test.el(' + j(numberedId) + ')');
    check('numbered-list', numberedEl && numberedEl.numbered === true, numberedEl);

    // P1：PNG 倍率、选区 SVG、裁剪翻转 SVG
    await run('__test.reset()');
    await run('__test.setView(1,0,0)');
    await run("__test.addShape('rect', 100, 100, 100, 80)");
    const png1 = await run('__test.pngData({scale:1,background:true})');
    const png3 = await run('__test.pngData({scale:3,background:true})');
    const s1 = pngDataSize(png1);
    const s3 = pngDataSize(png3);
    check('png-export-scale', s3.w >= s1.w * 2.9 && s3.h >= s1.h * 2.9, { s1, s3 });

    await run('__test.reset()');
    await run("__test.addShape('rect', 100, 100, 80, 80)");
    await run("__test.addShape('rect', 500, 100, 80, 80)");
    const selOnly = await run('__test.select([__test.order()[0]])');
    const selSvg = await run('__test.exportSvgTo(' + j(tmpSvgSel) + ')');
    let selSvgOk = false;
    try {
      const text = fs.readFileSync(tmpSvgSel, 'utf8');
      selSvgOk = selSvg === true && /width="160"/.test(text);
    } catch {
      selSvgOk = false;
    }
    check('svg-selection', selOnly === undefined && selSvgOk, { selOnly, selSvgOk });

    const tinyCrop = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await run('__test.reset()');
    const cropImg = await run('__test.addImage(' + j(tinyCrop) + ', 100, 100)');
    await run('__test.crop(' + j(cropImg) + ', {x:0,y:0,w:0.5,h:0.5}, true, false)');
    const cropSvg = await run('__test.exportSvgTo(' + j(tmpCropSvg) + ')');
    let cropSvgOk = false;
    try {
      const text = fs.readFileSync(tmpCropSvg, 'utf8');
      cropSvgOk = cropSvg === true && text.includes('viewBox="0 0 1000 1000"') && text.includes('scale(-1 1)');
    } catch {
      cropSvgOk = false;
    }
    check('svg-crop-flip', cropSvgOk, { cropSvgOk });

    // P1：对象橡皮、自定义样式、全页 ZIP
    await run('__test.reset()');
    const objectRect = await run("__test.addShape('rect', 100, 100, 80, 80)");
    await run('__test.setEraserMode("object")');
    const erasedObjects = await run('__test.eraseObjectAt(140, 140)');
    check('object-eraser', erasedObjects === 1 && (await run('__test.count()')) === 0, { objectRect, erasedObjects });

    await run('__test.reset()');
    const styleTarget = await run("__test.addShape('rect', 100, 100, 80, 80)");
    await run('__test.select(' + j([styleTarget]) + ')');
    const customStyle = await run(
      "(() => {const w=document.getElementById('custom-width');w.value='17';w.dispatchEvent(new Event('change'));" +
        "const c=document.getElementById('custom-color');c.value='#123456';c.dispatchEvent(new Event('change'));" +
        "return __test.el(" + j(styleTarget) + ");})()"
    );
    check('custom-style-inputs', customStyle && customStyle.strokeWidth === 17 && customStyle.stroke === '#123456', customStyle);

    await run('__test.reset()');
    await run("__test.addText('页一', 100, 100)");
    await run('__test.addPage("第二页")');
    await run('__test.switchPage(1)');
    await run("__test.addText('页二', 100, 100)");
    const pagesZipOk = await run('__test.exportPagesZipTo(' + j(tmpPagesZip) + ',"png")');
    let zipEntries = 0;
    try {
      zipEntries = [...zip.read(fs.readFileSync(tmpPagesZip)).keys()].length;
    } catch {
      zipEntries = 0;
    }
    check('export-pages-zip', pagesZipOk === true && zipEntries === 2, { pagesZipOk, zipEntries });

    // P1：旋转元素缩放、文本左/右手柄、输入焦点边界
    await run('__test.reset()');
    await run('__test.setView(1,0,0)');
    const rotateId = await run("__test.addShape('rect', 100, 100, 100, 60)");
    await run('__test.setRotation(' + j(rotateId) + ', 90)');
    await run('__test.select(' + j([rotateId]) + ')');
    const rotatedBefore = await run('__test.el(' + j(rotateId) + ')');
    const rotatedBox = await run("document.getElementById('selection').style.transform");
    const rotatedAfter = await run(
      "(() => {const vp=document.getElementById('viewport');const h=document.querySelector('#selection .handle.se');" +
        "if(!h)return null;const r=h.getBoundingClientRect();" +
        "const fire=(t,x,y,b,bs,target)=>target.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:b,buttons:bs,pointerId:77,pointerType:'mouse',altKey:true}));" +
        "fire('pointerdown',r.left+r.width/2,r.top+r.height/2,0,1,h);" +
        "fire('pointermove',r.left+r.width/2+40,r.top+r.height/2+30,0,1,vp);" +
        "fire('pointerup',r.left+r.width/2+40,r.top+r.height/2+30,0,0,vp);" +
        "return __test.el(" + j(rotateId) + ");})()"
    );
    check(
      'rotated-resize',
      !!rotatedBefore && !!rotatedAfter && rotatedBox.includes('rotate(90deg)') &&
        Number.isFinite(rotatedAfter.w) && Number.isFinite(rotatedAfter.h) &&
        (Math.abs(rotatedAfter.w - rotatedBefore.w) > 0.5 || Math.abs(rotatedAfter.h - rotatedBefore.h) > 0.5),
      { rotatedBefore, rotatedAfter, rotatedBox }
    );

    await run('__test.reset()');
    const textHandleId = await run("__test.addText('边界文本', 100, 100)");
    await run('__test.select(' + j([textHandleId]) + ')');
    const textHandles = await run(
      '({w:!!document.querySelector(\'#selection .handle.w\'),e:!!document.querySelector(\'#selection .handle.e\')})'
    );
    const textWidths = await run(
      "(() => {const vp=document.getElementById('viewport');const h=document.querySelector('#selection .handle.w');" +
        "if(!h)return null;const r=h.getBoundingClientRect();" +
        "const fire=(t,x,y,b,bs,target)=>target.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:b,buttons:bs,pointerId:78,pointerType:'mouse',altKey:true}));" +
        "const before=__test.el(" + j(textHandleId) + ");" +
        "fire('pointerdown',r.left+r.width/2,r.top+r.height/2,0,1,h);" +
        "fire('pointermove',r.left+r.width/2-40,r.top+r.height/2,0,1,vp);" +
        "fire('pointerup',r.left+r.width/2-40,r.top+r.height/2,0,0,vp);" +
        "const after=__test.el(" + j(textHandleId) + ");return {before,after};})()"
    );
    check(
      'text-edit-boundaries',
      textHandles.w && textHandles.e && textWidths && textWidths.after.w > textWidths.before.w,
      { textHandles, textWidths }
    );

    const clipFormat = await run(
      "(async () => {await window.api.writeClipboardElements('{\\\"app\\\":\\\"whiteboard-canvas-elements\\\",\\\"elements\\\":[]}');" +
        "const custom=await window.api.readClipboardElements();const text=await window.api.readClipboardText();" +
        "return {custom,text};})()"
    );
    check('clipboard-format', clipFormat.custom.includes('whiteboard-canvas-elements') && !clipFormat.text.includes('whiteboard-canvas-elements'), clipFormat);

    const a11y = await run(
      "(() => ({color:document.getElementById('custom-color').getAttribute('aria-label')," +
        "width:document.getElementById('custom-width').getAttribute('aria-label')," +
        "opacity:document.getElementById('opacity-range').getAttribute('aria-label')," +
        "replace:document.getElementById('replace-input').getAttribute('aria-label')}))()"
    );
    check('a11y-controls', !!a11y.color && !!a11y.width && !!a11y.opacity && !!a11y.replace, a11y);

    // P1：形状文字、标尺/参考线/网格、页面缩略图、跨页搜索
    await run('__test.reset()');
    const labelShapeId = await run("__test.addShape('rect', 100, 100, 160, 90)");
    await run('__test.setShapeLabel(' + j(labelShapeId) + ", '流程图')");
    const labelShape = await run('__test.el(' + j(labelShapeId) + ')');
    check('shape-label', labelShape && labelShape.label === '流程图', labelShape);

    await run('__test.reset()');
    await run('__test.applySettings({gridSize:8})');
    const gridStyle = await run("document.getElementById('viewport').style.backgroundSize");
    const rulerState = await run(
      "(() => {document.getElementById('ruler-btn').click();const h=document.getElementById('ruler-h');" +
        "const r=h.getBoundingClientRect();h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+300,clientY:r.top+8,button:0,buttons:1,pointerId:91,pointerType:'mouse'}));" +
        "window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+300,clientY:r.top+8,button:0,buttons:0,pointerId:91,pointerType:'mouse'}));" +
        "return {visible:!h.hidden,guides:document.querySelectorAll('#manual-guides .manual-guide').length,canvas:h.querySelector('canvas').width};})()"
    );
    await run('__test.applySettings({gridSize:24})');
    check('rulers-guides-grid', gridStyle === '8px 8px' && rulerState.visible && rulerState.guides >= 1 && rulerState.canvas > 0, { gridStyle, rulerState });

    await run('__test.reset()');
    await run("__test.addText('页一', 100, 100)");
    await run("__test.addPage('第二页')");
    await run('__test.switchPage(1)');
    await run("__test.addText('页二', 100, 100)");
    const thumbs = await run(
      "(async () => {document.getElementById('page-thumbs-btn').click();await new Promise(r=>setTimeout(r,400));" +
        "return document.querySelectorAll('.page-thumb').length;})()"
    );
    const crossSearch = await run(
      "(() => {const input=document.getElementById('search-input');input.value='页';input.dispatchEvent(new Event('input',{bubbles:true}));" +
        "const all=document.getElementById('search-all-pages');all.checked=true;all.dispatchEvent(new Event('change',{bubbles:true}));" +
        "return {count:document.getElementById('search-count').textContent,page:__test.activePage()};})()"
    );
    check('page-thumbs-cross-search', thumbs === 2 && crossSearch.count.startsWith('1/2') && crossSearch.page === 0, { thumbs, crossSearch });

    await run('__test.reset()');
    await run('__test.setView(1,0,0)');
    const pinchBefore = await run('__test.zoomPercent()');
    const pinchAfter = await run(
      "(() => {const vp=document.getElementById('viewport');const r=vp.getBoundingClientRect();" +
        "const fire=(t,id,x,y,b,bs)=>vp.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:r.left+x,clientY:r.top+y,button:b,buttons:bs,pointerId:id,pointerType:'touch',isPrimary:id===101}));" +
        "fire('pointerdown',101,400,300,0,1);fire('pointerdown',102,600,300,0,1);" +
        "fire('pointermove',101,350,300,0,1);fire('pointermove',102,650,300,0,1);" +
        "fire('pointerup',101,350,300,0,0);fire('pointerup',102,650,300,0,0);" +
        "return {zoom:__test.zoomPercent(),count:__test.count()};})()"
    );
    check('pinch-pan', pinchAfter.zoom > pinchBefore + 20 && pinchAfter.count === 0, { pinchBefore, pinchAfter });
  } catch (err) {
    failures++;
    console.log('FAIL smoke-exception ' + String((err && err.message) || err));
  }

  for (const file of [tmpWbc, tmpPng, tmpZip, tmpSelPng, tmpV1, tmpBad, tmpBadZip, tmpPdf, tmpSvg, tmpStyleSvg, tmpPages, tmpRepairJson, tmpRepairZip, tmpConflict, tmpConcurrent, tmpPagesZip, tmpSvgSel, tmpCropSvg]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略清理失败 */
    }
  }

  console.log('SMOKE ' + (failures === 0 ? 'PASS' : 'FAIL'));
  return failures === 0 ? 0 : 1;
};
