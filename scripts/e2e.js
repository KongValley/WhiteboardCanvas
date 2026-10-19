// SPDX-License-Identifier: GPL-3.0-or-later
// E2E：CDP 驱动 ia32 打包产物完成绘制/保存/导出/拖放/快捷键；失败退出码 1。
const fs = require('fs');
const path = require('path');
const { launch } = require('./cdp');
const zip = require('../electron/zip');

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log('PASS ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + ' ' + JSON.stringify(detail));
  }
}

async function main() {
  const app = await launch();
  const savePath = path.join(app.tmp, 'e2e.wbc');
  const pngPath = path.join(app.tmp, 'e2e.png');
  const svgPath = path.join(app.tmp, 'e2e.svg');
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  try {
    await app.eval('__test.reset()');
    await app.eval("__test.addInk([[100,100],[160,140],[220,100]], '#111', 4)");
    await app.eval("__test.addText('E2E', 100, 200)");
    await app.eval("__test.addShape('rect', 300, 100, 160, 100)");
    const count = await app.eval('__test.count()');
    check('draw', count === 3, count);

    const polyId = await app.eval("__test.addPoly('star', 500, 300, 120, 120)");
    await app.eval(`__test.setRotation(${JSON.stringify(polyId)}, 30)`);
    const poly = await app.eval(`__test.el(${JSON.stringify(polyId)})`);
    check('shape-rotation', !!poly && Math.abs(poly.rotation - 30) < 0.001 && poly.kind === 'star', poly);

    const saved = await app.eval(`__test.saveTo(${JSON.stringify(savePath)})`);
    let doc = null;
    try {
      const files = zip.read(fs.readFileSync(savePath));
      doc = JSON.parse(files.get('doc.json').toString('utf8'));
    } catch {
      doc = null;
    }
    check('save-v3-zip', saved === true && !!doc && doc.version === 3 && Array.isArray(doc.pages) && doc.pages[0].elements.length === 4, {
      saved,
      version: doc && doc.version,
      pages: doc && doc.pages && doc.pages.length
    });

    const png = await app.eval(`__test.exportPngTo(${JSON.stringify(pngPath)})`);
    let signature = false;
    try {
      const buf = fs.readFileSync(pngPath);
      signature = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length > 1000;
    } catch {
      signature = false;
    }
    check('export-png', png === true && signature, { png, signature });

    const svg = await app.eval(`__test.exportSvgTo(${JSON.stringify(svgPath)})`);
    let svgOk = false;
    try {
      const text = fs.readFileSync(svgPath, 'utf8');
      svgOk = svg === true && text.startsWith('<?xml') && text.includes('<svg') && text.includes('<text');
    } catch {
      svgOk = false;
    }
    check('export-svg', svgOk, { svg });

    await app.eval('__test.reset()');
    const dropped = await app.eval(
      `(async () => {const dt=new DataTransfer();const f=new File(['x'],'saved.wbc',{type:'application/octet-stream'});` +
        `Object.defineProperty(f,'path',{value:${JSON.stringify(savePath)}});dt.items.add(f);` +
        `document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:400,clientY:300}));` +
        `await new Promise(r=>setTimeout(r,600));return __test.count();})()`
    );
    check('drop-open', dropped === 4, dropped);

    await app.eval('__test.reset()');
    const shortcut = await app.eval(
      "(() => {__test.addShape('rect', 100, 100, 80, 80);__test.selectAll();" +
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true,cancelable:true}));" +
        'return __test.count();})()'
    );
    check('shortcut-duplicate', shortcut === 2, shortcut);

    await app.eval('__test.reset()');
    const pages = await app.eval(
      "(() => {const a=__test.addPage('第二页');const names=__test.pageNames();__test.switchPage(1);" +
        "__test.addText('page2', 100, 100);return {names,active:__test.pageNames().length,count:__test.count()};})()"
    );
    check('pages', pages.names.length === 2 && pages.count === 1, pages);

    await app.eval('__test.reset()');
    const image = await app.eval(`(async () => {const id=await __test.addImage(${JSON.stringify(tiny)},100,100);return id;})()`);
    await app.eval(`__test.select([${JSON.stringify(image)}])`);
    const copied = await app.eval('__test.copySelectionPng()');
    check('clipboard-image', copied === true, copied);
  } finally {
    await app.close();
  }
  console.log('E2E ' + (failures === 0 ? 'PASS' : 'FAIL'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E ERROR ' + String((err && err.stack) || err));
  process.exit(1);
});
