// SPDX-License-Identifier: GPL-3.0-or-later
// 多窗口恢复快照隔离：两个窗口分别编辑未命名文档，确认各自写入独立恢复快照。
const fs = require('fs');
const path = require('path');
const { launch, sleep, connect } = require('./cdp');

async function evalOn(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本异常');
  return result.result.value;
}

async function main() {
  const app = await launch();
  let second = null;
  try {
    await app.eval('__test.reset()');
    await app.eval("__test.addText('窗口 A', 100, 100)");

    await app.eval('window.api.testNewWindow()');
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      const response = await fetch(`http://127.0.0.1:${app.port}/json/list`);
      if (response.ok) {
        const list = await response.json();
        target = list.find((page) => page.type === 'page' && page.id !== app.pageId && String(page.url).includes('index.html'));
      }
      if (!target) await sleep(150);
    }
    if (!target) throw new Error('第二个窗口未就绪');
    second = await connect(target.webSocketDebuggerUrl);
    await second.send('Runtime.enable');
    for (let i = 0; i < 100; i++) {
      if (await evalOn(second, '!!window.__test')) break;
      await sleep(100);
    }
    await evalOn(second, '__test.reset()');
    await evalOn(second, "__test.addText('窗口 B', 200, 200)");

    await sleep(4200);
    const userData = await app.eval('window.api.testUserData()');
    const recoveryDir = path.join(userData, 'recovery');
    const files = fs.existsSync(recoveryDir)
      ? fs.readdirSync(recoveryDir).filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))
      : [];
    const texts = files.map((name) => {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(recoveryDir, name), 'utf8'));
        return (doc.pages || []).flatMap((page) => (page.elements || []).map((el) => el.text || '')).join('|');
      } catch {
        return '';
      }
    });
    const hasA = texts.some((text) => text.includes('窗口 A'));
    const hasB = texts.some((text) => text.includes('窗口 B'));
    console.log((files.length >= 2 && hasA && hasB ? 'PASS ' : 'FAIL ') + 'multi-window-recovery ' + JSON.stringify({ files, hasA, hasB }));
    if (!(files.length >= 2 && hasA && hasB)) process.exitCode = 1;
    else console.log('MULTI-WINDOW PASS');
  } finally {
    if (second) second.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error('MULTI-WINDOW ERROR ' + String((err && err.stack) || err));
  process.exit(1);
});
