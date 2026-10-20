# 白板画布 / Whiteboard Canvas

面向 Windows 7 SP1 32 位的离线白板应用。Electron 22 + TypeScript + Vite，解压即用，无运行时服务依赖。

## 功能

- 画笔、荧光笔、整笔/局部/对象橡皮、直线、箭头、矩形、椭圆、三角形、菱形、五角星、圆角矩形、图片、文字、便签。
- 多选/框选/套索、移动缩放旋转、组合、锁定、隐藏、图层排序、对齐分布、复制粘贴、撤销重做。
- 页面、页面复制、缩略图、跨页搜索、演示模式、只读模式。
- 网格、标尺、手动参考线；PNG 1x/2x/3x、选区 PNG/SVG、PDF、全页 PNG/SVG ZIP 导出。
- `.wbc` v3 ZIP 容器（`doc.json` + 去重 `assets/`），自动保存、崩溃恢复、自动备份、最近文件、多窗口。
- 中英界面、深色主题、自定义工具快捷键；`.wbc` 文件关联可选写入 HKCU。

## 环境

- Windows 7 SP1 32 位（需 Platform Update / KB2670838 与 D3D11）
- Node.js 20（仅开发/构建）
- 发布产物为 `release/whiteboard-canvas-<version>-ia32.zip`

## 老旧电脑优化

针对 Win7 32 位低配机器（**无独显、仅核显或纯软件渲染**）做了专门优化：

### 1. 低配模式（设置 → 低配模式）

一键切换到针对"无 GPU"机器的渲染策略：

- **点阵背景移到变换图层内**：原本背景贴在视口上，平移时每帧都要重绘整块
  `radial-gradient`（软件光栅化下最贵的一项）。改到 `world` 层后，平移只需合成一次变换。
- **便签阴影改用边框**：`box-shadow: 0 0 0 10px` 这类扩散阴影在 CPU 光栅化下代价极高，
  低配模式改为等效的 10px 边框，视觉几乎一致。
- **关闭荧光笔混合模式**：`mix-blend-mode: multiply` 需要回读背景再混合，
  软件渲染下极慢；低配模式改用半透明叠加。
- **隐藏小地图与标尺**：这两处持续重绘区域在弱机上占用明显。

Win7 首次启动会主动提示开启，随时可在设置里关闭。

### 2. 无 GPU 时的自动降级

- 开启低配模式时，主进程自动追加 `--disable-gpu` / `--disable-gpu-compositing` /
  `--in-process-gpu` / `--disable-partial-raster` / `--disable-accelerated-2d-canvas`，
  让 Chromium 直接走软件光栅化，避免 GPU 进程反复重启。
- **GPU 进程看门狗**：核显驱动异常导致 GPU 进程崩溃两次时，自动写入"禁用硬件加速"并
  提示重启，避免窗口空白或持续卡顿。

命令行也可手动强制：`WhiteboardCanvas.exe --software-render`

### 3. 通用性能优化

- **视口剔除 + 增量渲染**：只挂载视口附近的元素；平移/缩放命中缓存范围时直接跳过扫描，
  不再每帧重建 DOM 顺序。
- **拖拽/旋转走批量更新**：缓存元素引用、统一测量文本高度，避免逐元素强制重排。
- **历史快照写时复制**：图片 data URL 共享引用，不再为每次编辑深拷贝数 MB 字符串。
- **绘制限流**：小地图约 8fps、标尺按帧合并、状态栏文本去重。

实测（1050 元素，win32-x64 基线机）：

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 平移 200 帧 | 288 ms | 12.5 ms |
| 拖拽 200 元素 × 20 帧 | 5788 ms | 66 ms |
| 新建 1000 元素 | 951 ms | 456 ms |

其他建议：确认已安装 Win7 SP1 + Platform Update（KB2670838），否则没有 D3D11 只能软件渲染；
关闭无关的后台程序；文档过大时拆分页面。

## 开发

```powershell
npm ci
npm run typecheck
npm test          # 单元测试
npm run build
npm start         # 构建后启动 Electron
npm run smoke     # 开发态冒烟
npm run e2e       # 需先 electron-builder --win dir --ia32
npm run visual    # PNG/SVG 视觉回归（基线 test/visual-baseline.json）
npm run multi-window
npm run bench     # 性能基准（对比 test/bench-baseline.json，>2.5x 视为回归）
npm run probe     # 交互探针：拖拽/缩放/绘制/打开耗时
```

发布：

```powershell
npm run dist
```

## 便携模式

- 启动参数 `--portable`，或 EXE 同级存在 `portable.txt` / `data/` 目录时，设置、最近文件、备份、恢复快照写入 EXE 同级 `data/`。
- 默认模式使用 `%APPDATA%/WhiteboardCanvas`，不写系统级注册表；文件关联仅在设置中显式开启时写 HKCU。

## 恢复与备份

- 恢复快照：每个窗口独立写入 `recovery/<key>.json`，3 秒防抖（大文档自动延后），崩溃后启动逐份提示恢复。
- 自动备份：保存前与每 10 分钟（有修改时）写入 `backups/`，默认保留 5 份；文件 → 恢复自动备份可查看时间/大小并删除。
- 自动保存：默认 1 秒；文件被外部修改时暂停并提示冲突。

## 文件格式 v3

`.wbc` 为 ZIP：`doc.json`（deflate）+ `assets/<sha1>.<ext>`（图片按内容去重）。旧 v1/v2 JSON 打开时自动迁移并备份原文件。

## 已知限制 / 安全说明

- Electron 22 是最后支持 Win7 的版本，已停止安全更新；本应用不加载远程内容，CSP 限制脚本/样式/图片来源，建议仅离线使用。
- 大文档（>100MB）打开、单张超大图片解码、完整空间索引/增量保存仍在后续优化范围。
- 视觉回归基线在 win32-x64 生成；Win7 字体回退矩阵需实机验证。
- 发布 ZIP 未签名时 SmartScreen 可能提示；可在 CI 提供 `CSC_LINK`/`CSC_KEY_PASSWORD` 签名。

## 许可证

GPL-3.0-or-later，见 `LICENSE`。
