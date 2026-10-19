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
  const userData = app.getPath('userData');
  const backupsDir = path.join(userData, 'backups');
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
        const doc = files.get('doc.json');
        return doc ? JSON.parse(doc.toString('utf8')) : null;
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
  const clickWorld = (x, y, alt = false) =>
    "(function(){var vp=document.getElementById('viewport');var r=vp.getBoundingClientRect();" +
    `var fire=function(t,cx,cy,btn,buttons){vp.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:btn,buttons:buttons,pointerId:21,pointerType:'mouse',altKey:${alt}}));};` +
    `fire('pointerdown',r.left+${x},r.top+${y},0,1);` +
    `fire('pointermove',r.left+${x},r.top+${y},0,1);` +
    `fire('pointerup',r.left+${x},r.top+${y},0,0);return true;})()`;

  try {
    await run("new Promise(function(resolve){var t=setInterval(function(){if(window.__test){clearInterval(t);resolve(true);}},20);})");
    const buttons = await run("document.querySelectorAll('#toolbar button').length");
    check('toolbar-10-buttons', buttons === 10, buttons);

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

    // 崩溃恢复快照（3 秒内，含未提交的编辑草稿）与清除
    await run('__test.reset()');
    await run("__test.addText('恢复测试', 100, 100)");
    const editOpened = await run(
      "(() => {const vp=document.getElementById('viewport');const r=vp.getBoundingClientRect();" +
        "vp.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:r.left+150,clientY:r.top+115}));" +
        "const e=document.getElementById('editor');e.value='恢复测试草稿';e.dispatchEvent(new Event('input',{bubbles:true}));" +
        "return !e.hidden;})()"
    );
    await new Promise((resolve) => setTimeout(resolve, 3400));
    const recoveryFile = path.join(userData, 'recovery.wbc');
    const recoveryExists = fs.existsSync(recoveryFile);
    let recoveryOk = false;
    if (recoveryExists) {
      try {
        const doc = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
        recoveryOk = doc.elements.some((el) => el.type === 'text' && el.text === '恢复测试草稿');
      } catch {
        recoveryOk = false;
      }
    }
    await run("(() => {const e=document.getElementById('editor');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;})()");
    await run('window.api.clearRecovery()');
    await new Promise((resolve) => setTimeout(resolve, 120));
    check('recovery-snapshot', editOpened === true && recoveryExists && recoveryOk && !fs.existsSync(recoveryFile), {
      editOpened,
      recoveryExists,
      recoveryOk,
      cleared: !fs.existsSync(recoveryFile)
    });

    // 日志
    const logFile = path.join(userData, 'logs', 'main.log');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('local-log', logText.includes('应用启动') && logText.includes('保存文档'), { hasStartup: logText.includes('应用启动') });

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
  } catch (err) {
    failures++;
    console.log('FAIL smoke-exception ' + String((err && err.message) || err));
  }

  for (const file of [tmpWbc, tmpPng, tmpZip, tmpSelPng, tmpV1, tmpBad, tmpBadZip, tmpPdf]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略清理失败 */
    }
  }

  console.log('SMOKE ' + (failures === 0 ? 'PASS' : 'FAIL'));
  return failures === 0 ? 0 : 1;
};
