// SPDX-License-Identifier: GPL-3.0-or-later
// 导出视觉回归：固定样例导出 PNG/SVG，按 SHA-256 对比基线。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { launch, repo } = require('./cdp');

const baselineFile = path.join(repo, 'test', 'visual-baseline.json');

async function main() {
  const app = await launch();
  const pngPath = path.join(app.tmp, 'visual.png');
  const svgPath = path.join(app.tmp, 'visual.svg');
  try {
    await app.eval('__test.reset()');
    await app.eval('__test.setView(1,0,0)');
    const textId = await app.eval("__test.addText('视觉回归\\n第二行', 80, 80)");
    await app.eval(`__test.setTextStyle(${JSON.stringify(textId)}, {bold:true, underline:true, numbered:true, fontSize:24})`);
    const rectId = await app.eval("__test.addShape('rect', 320, 80, 160, 100)");
    await app.eval(`__test.setFill(${JSON.stringify(rectId)}, 'rgba(37,99,235,0.2)')`);
    await app.eval(`__test.setShapeLabel(${JSON.stringify(rectId)}, '形状文字')`);
    const polyId = await app.eval("__test.addPoly('star', 540, 80, 100, 100)");
    await app.eval(`__test.setRotation(${JSON.stringify(polyId)}, 30)`);
    const stickyId = await app.eval("__test.addSticky('便签', 80, 300)");
    const inkId = await app.eval("__test.addInk([[300,300],[380,340],[460,300]], '#dc2626', 16, true)");
    const a = await app.eval("__test.addShape('rect', 560, 300, 80, 60)");
    const b = await app.eval("__test.addShape('ellipse', 760, 300, 100, 80)");
    const link = await app.eval(`__test.connect(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    await app.eval(`__test.setLabel(${JSON.stringify(link)}, '连接')`);
    await app.eval(`__test.select([${JSON.stringify(a)},${JSON.stringify(b)},${JSON.stringify(link)}])`);
    const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const img = await app.eval(`__test.addImage(${JSON.stringify(tiny)}, 80, 470)`);
    await app.eval(`__test.crop(${JSON.stringify(img)}, {x:0,y:0,w:0.5,h:0.5}, true, false)`);
    await app.eval('__test.select([])');
    const pngOk = await app.eval(`__test.exportPngTo(${JSON.stringify(pngPath)})`);
    const svgOk = await app.eval(`__test.exportSvgTo(${JSON.stringify(svgPath)})`);
    const result = {
      when: new Date().toISOString(),
      machine: process.platform + '-' + process.arch,
      png: hashFile(pngPath),
      svg: hashFile(svgPath),
      pngOk,
      svgOk
    };
    if (!result.pngOk || !result.svgOk) throw new Error('导出失败');
    if (!fs.existsSync(baselineFile)) {
      fs.writeFileSync(baselineFile, JSON.stringify(result, null, 2) + '\n');
      console.log('VISUAL baseline created: ' + baselineFile);
      console.log('VISUAL PASS');
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    const pngOkMatch = baseline.png === result.png;
    const svgOkMatch = baseline.svg === result.svg;
    console.log((pngOkMatch ? 'PASS ' : 'FAIL ') + 'png ' + result.png.slice(0, 16));
    console.log((svgOkMatch ? 'PASS ' : 'FAIL ') + 'svg ' + result.svg.slice(0, 16));
    if (!pngOkMatch || !svgOkMatch) process.exitCode = 1;
    console.log('VISUAL ' + (pngOkMatch && svgOkMatch ? 'PASS' : 'FAIL'));
  } finally {
    await app.close();
  }
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

main().catch((err) => {
  console.error('VISUAL ERROR ' + String((err && err.stack) || err));
  process.exit(1);
});
