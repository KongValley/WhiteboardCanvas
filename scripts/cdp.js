// SPDX-License-Identifier: GPL-3.0-or-later
// 通过 CDP 驱动打包后的 ia32 应用（Windows）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');

function defaultExe() {
  return process.env.WBC_EXE || path.join(repo, 'release', 'win-ia32-unpacked', 'WhiteboardCanvas.exe');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error('CDP 超时：' + method));
            }, 30000);
            pending.set(id, { res, rej, timer });
            try {
              ws.send(JSON.stringify({ id, method, params: params || {} }));
            } catch (err) {
              clearTimeout(timer);
              pending.delete(id);
              rej(err);
            }
          });
        },
        close() {
          ws.close();
        }
      });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('close', () => {
      for (const [id, item] of pending) {
        clearTimeout(item.timer);
        item.rej(new Error('CDP 连接已关闭'));
        pending.delete(id);
      }
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.rej(new Error(message.error.message || 'CDP error'));
      else item.res(message.result);
    });
  });
}

async function launch(options = {}) {
  const exe = options.exe || defaultExe();
  if (!fs.existsSync(exe)) {
    throw new Error('未找到打包产物：' + exe + '（先运行 npm run dist）');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbc-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const args = ['--e2e', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(tmp, 'chromium')];
  if (options.extraArgs) args.push(...options.extraArgs);
  const child = spawn(exe, args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  let page = null;
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      if (response.ok) {
        const list = await response.json();
        page = list.find((item) => item.type === 'page' && String(item.url).includes('index.html'));
        if (page) break;
      }
    } catch {
      /* 等待启动 */
    }
    await sleep(200);
  }
  if (!page) {
    child.kill();
    throw new Error('CDP 未就绪');
  }
  console.log('E2E launch: page found');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const evalFn = async (expression) => {
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(detail || result.exceptionDetails.text || '页面脚本异常');
    }
    return result.result.value;
  };
  for (let i = 0; i < 100; i++) {
    if (await evalFn('!!window.__test')) break;
    await sleep(100);
  }
  if (!(await evalFn('!!window.__test'))) {
    child.kill();
    throw new Error('页面未暴露 __test');
  }
  console.log('E2E launch: hooks ready');
  return {
    eval: evalFn,
    send: client.send,
    tmp,
    exe,
    port,
    pageUrl: page.url,
    pageId: page.id,
    close: async () => {
      try {
        client.send('Browser.close').catch(() => {});
      } catch {
        /* 已关闭 */
      }
      client.close();
      await sleep(300);
      if (child.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  };
}

module.exports = { launch, repo, sleep, connect };
