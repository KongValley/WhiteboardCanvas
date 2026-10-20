// SPDX-License-Identifier: GPL-3.0-or-later
// 性能基准：1000 元素 + 50 图片，记录保存/打开/平移/导出；与基线对比（>2.5x 视为回归）。
const fs = require('fs');
const path = require('path');
const { launch } = require('./cdp');

const repo = path.resolve(__dirname, '..');
const latestFile = path.join(repo, 'test', 'bench-latest.json');
const baselineFile = path.join(repo, 'test', 'bench-baseline.json');
const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function main() {
  const app = await launch();
  const savePath = path.join(app.tmp, 'bench.wbc');
  try {
    await app.eval('__test.reset()');
    const created = await app.eval(
      "(() => {const t=performance.now();for(let i=0;i<1000;i++){__test.addShape('rect',20000+i*40,20000+(i%10)*40,30,30);}" +
        'return {count:__test.count(),ms:performance.now()-t};})()'
    );
    for (let i = 0; i < 50; i++) {
      await app.eval(`(async()=>{await __test.addImage(${JSON.stringify(tiny)}, 1000+(${i}%10)*40, 1000+Math.floor(${i}/10)*40);})()`);
    }
    const total = await app.eval('__test.count()');
    const save = await app.eval(
      `(async()=>{const t=performance.now();const ok=await __test.saveTo(${JSON.stringify(savePath)});return {ok,ms:performance.now()-t};})()`
    );
    const open = await app.eval(
      `(async()=>{__test.reset();const t=performance.now();const ok=await __test.openFrom(${JSON.stringify(savePath)});return {ok,ms:performance.now()-t};})()`
    );
    const pan = await app.eval(
      '(()=>{const t=performance.now();for(let i=0;i<200;i++){__test.setView(1,-i*5,-i*2);}return performance.now()-t;})()'
    );
    // 拖拽 20 帧（真实拖拽路径：单次历史克隆 + 每帧增量更新）
    await app.eval('__test.selectAll()');
    const drag = await app.eval('__test.dragBench(20, 1)');
    const exportPng = await app.eval(
      '(async()=>{const t=performance.now();const data=await __test.pngData({selection:false});return {ms:performance.now()-t,bytes:data?data.length:0};})()'
    );
    const heap = await app.send('Runtime.getHeapUsage').catch(() => null);
    const result = {
      when: new Date().toISOString(),
      memoryMB: heap ? Math.round(heap.usedSize / 1024 / 1024) : null,
      machine: process.platform + '-' + process.arch,
      elements: total,
      created: created.ms,
      saveMs: save.ms,
      openMs: open.ms,
      pan200Ms: pan,
      dragMs: drag.ms,
      exportMs: exportPng.ms,
      exportBytes: exportPng.bytes
    };
    console.log(JSON.stringify(result, null, 2));
    fs.writeFileSync(latestFile, JSON.stringify(result, null, 2) + '\n');
    if (!fs.existsSync(baselineFile)) {
      fs.writeFileSync(baselineFile, JSON.stringify(result, null, 2) + '\n');
      console.log('BENCH baseline created: ' + baselineFile);
      console.log('BENCH PASS');
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    const metrics = ['saveMs', 'openMs', 'pan200Ms', 'exportMs'];
    let regressions = 0;
    for (const key of metrics) {
      const limit = (baseline[key] || 1) * 2.5;
      const ok = result[key] <= limit;
      console.log((ok ? 'PASS ' : 'FAIL ') + key + ' ' + result[key].toFixed(1) + 'ms (baseline ' + Number(baseline[key]).toFixed(1) + 'ms)');
      if (!ok) regressions++;
    }
    if (typeof baseline.dragMs === 'number') {
      const limit = baseline.dragMs * 2.5;
      const ok = result.dragMs <= limit;
      console.log((ok ? 'PASS ' : 'FAIL ') + 'dragMs ' + result.dragMs.toFixed(1) + 'ms (baseline ' + Number(baseline.dragMs).toFixed(1) + 'ms)');
      if (!ok) regressions++;
    }
    console.log('BENCH ' + (regressions === 0 ? 'PASS' : 'FAIL'));
    process.exitCode = regressions === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('BENCH ERROR ' + String((err && err.stack) || err));
  process.exit(1);
});
