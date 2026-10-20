// SPDX-License-Identifier: GPL-3.0-or-later
// 性能探针：测量弱机上最常见的交互（拖拽移动元素、缩放、绘制笔迹）
const path = require('path');
const { launch } = require('./cdp');

async function main() {
  const app = await launch();
  try {
    await app.eval('__test.reset()');
    // 600 个元素分布在视口内（模拟真实画板密度）
    await app.eval(
      "(() => {for(let i=0;i<600;i++){__test.addShape('rect', 100+(i%30)*40, 100+Math.floor(i/30)*40, 30, 30);}return __test.count();})()"
    );
    const total = await app.eval('__test.count()');
    const mounted = await app.eval('__test.mountedCount()');

    // 拖拽 200 个选中元素 20 帧（走真实拖拽路径：单次历史克隆 + 每帧增量更新）
    await app.eval('__test.selectAll()');
    const drag = await app.eval('__test.dragBench(20, 1)');
    const dragMs = typeof drag === 'number' ? drag : drag.ms;

    // 缩放 100 次
    const zoom = await app.eval(
      '(() => {const t=performance.now();for(let i=0;i<100;i++){__test.setView(1+i*0.01,-i*10,-i*5);}return performance.now()-t;})()'
    );

    // 绘制 200 点笔迹
    const ink = await app.eval(
      "(() => {const pts=[];for(let i=0;i<200;i++)pts.push([200+i*3,300+Math.sin(i/5)*40]);" +
        'const t=performance.now();__test.addInk(pts,"#111",3);return performance.now()-t;})()'
    );

    // 打开大文档
    const savePath = path.join(app.tmp, 'probe.wbc');
    await app.eval(`(async()=>{await __test.saveTo(${JSON.stringify(savePath)});return true;})()`);
    const open = await app.eval(
      `(async()=>{__test.reset();const t=performance.now();await __test.openFrom(${JSON.stringify(savePath)});return performance.now()-t;})()`
    );

    const heap = await app.send('Runtime.getHeapUsage').catch(() => null);
    console.log(
      JSON.stringify(
        {
          elements: total,
          mounted,
          drag200x20ms: Math.round(dragMs),
          zoom100Ms: Math.round(zoom),
          ink200Ms: Math.round(ink),
          openMs: Math.round(open),
          memoryMB: heap ? Math.round(heap.usedSize / 1024 / 1024) : null
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('PROBE ERROR ' + String((err && err.stack) || err));
  process.exit(1);
});
