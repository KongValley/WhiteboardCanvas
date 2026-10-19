// SPDX-License-Identifier: GPL-3.0-or-later
import { state } from './state';
import type { Language } from './types';

type Entry = [zh: string, en: string];
const DICT: Record<string, Entry> = {
  'tool.select': ['选择', 'Select'],
  'tool.lasso': ['套索', 'Lasso'],
  'tool.pen': ['画笔', 'Pen'],
  'tool.highlighter': ['荧光笔', 'Highlighter'],
  'tool.eraser': ['橡皮', 'Eraser'],
  'tool.text': ['文字', 'Text'],
  'tool.sticky': ['便签', 'Sticky note'],
  'tool.rect': ['矩形', 'Rectangle'],
  'tool.ellipse': ['椭圆', 'Ellipse'],
  'tool.arrow': ['箭头', 'Arrow'],
  'tool.line': ['直线', 'Line'],
  'tool.triangle': ['三角形', 'Triangle'],
  'tool.diamond': ['菱形', 'Diamond'],
  'tool.star': ['五角星', 'Star'],
  'tool.roundrect': ['圆角矩形', 'Rounded rectangle'],
  'tool.image': ['图片', 'Image'],
  hint: ['双击画布输入文字，或选择左侧工具开始', 'Double-click the canvas to type, or pick a tool'],
  'zoom.out': ['缩小', 'Zoom out'],
  'zoom.in': ['放大', 'Zoom in'],
  'zoom.fit': ['适应', 'Fit'],
  'panel.open': ['图层面板', 'Layers'],
  'help.open': ['快捷键 (F1)', 'Shortcuts (F1)'],
  'page.add': ['新建页面', 'New page'],
  'page.more': ['页面操作', 'Page actions'],
  'page.select': ['页面', 'Page'],
  'search.placeholder': ['搜索文字 / 标签', 'Search text / labels'],
  'search.close': ['关闭', 'Close'],
  'help.title': ['快捷键', 'Keyboard shortcuts'],
  'help.close': ['关闭', 'Close'],
  'settings.title': ['设置', 'Settings'],
  'settings.autosave': ['自动保存间隔（秒，0 为关闭）', 'Autosave interval (seconds, 0 = off)'],
  'settings.closeAsk': ['关闭窗口时', 'When closing the window'],
  'settings.closeAskOpt': ['询问是否保存', 'Ask to save'],
  'settings.closeSaveOpt': ['自动保存', 'Save automatically'],
  'settings.closeDiscardOpt': ['直接关闭', 'Close without saving'],
  'settings.gpu': ['禁用硬件加速（重启生效）', 'Disable hardware acceleration (restart)'],
  'settings.background': ['默认背景', 'Default background'],
  'bg.dots': ['点阵', 'Dots'],
  'bg.grid': ['网格', 'Grid'],
  'bg.plain': ['纯白', 'Plain white'],
  'bg.cream': ['米色', 'Cream'],
  'settings.theme': ['主题', 'Theme'],
  'theme.light': ['浅色', 'Light'],
  'theme.dark': ['深色', 'Dark'],
  'settings.language': ['界面语言', 'Language'],
  'settings.exportBg': ['PNG/PDF 导出包含背景', 'Include background in PNG/PDF export'],
  'settings.shortcuts': ['自定义工具快捷键', 'Custom tool shortcuts'],
  'settings.record': ['录制', 'Record'],
  'settings.default': ['默认', 'Default'],
  'settings.reset': ['恢复默认', 'Reset defaults'],
  'settings.save': ['保存', 'Save'],
  'settings.close': ['关闭', 'Close'],
  'assoc.title': ['.wbc 文件关联：', '.wbc association:'],
  'assoc.on': ['已注册（当前用户）', 'Registered (current user)'],
  'assoc.off': ['未注册', 'Not registered'],
  'assoc.onlyWin': ['仅 Windows 支持', 'Windows only'],
  'assoc.register': ['注册 .wbc 关联', 'Register .wbc association'],
  'assoc.remove': ['移除 .wbc 关联', 'Remove .wbc association'],
  'status.selected': ['选中', 'Selected'],
  'status.saved': ['已保存', 'Saved'],
  'status.unsaved': ['未保存', 'Unsaved'],
  'status.autosave': ['自动保存', 'Autosave'],
  'ctx.copy': ['复制', 'Copy'],
  'ctx.cut': ['剪切', 'Cut'],
  'ctx.duplicate': ['再制', 'Duplicate'],
  'ctx.front': ['置顶', 'Bring to front'],
  'ctx.back': ['置底', 'Send to back'],
  'ctx.group': ['分组', 'Group'],
  'ctx.ungroup': ['解组', 'Ungroup'],
  'ctx.lock': ['锁定', 'Lock'],
  'ctx.unlock': ['解锁', 'Unlock'],
  'ctx.hide': ['隐藏', 'Hide'],
  'ctx.alignLeft': ['左对齐', 'Align left'],
  'ctx.alignHCenter': ['水平居中', 'Align horizontal centers'],
  'ctx.alignRight': ['右对齐', 'Align right'],
  'ctx.alignTop': ['上对齐', 'Align top'],
  'ctx.alignVCenter': ['垂直居中', 'Align vertical centers'],
  'ctx.alignBottom': ['下对齐', 'Align bottom'],
  'ctx.distributeH': ['水平等距分布', 'Distribute horizontally'],
  'ctx.distributeV': ['垂直等距分布', 'Distribute vertically'],
  'ctx.copyFormat': ['复制格式', 'Copy format'],
  'ctx.pasteFormat': ['粘贴格式', 'Paste format'],
  'ctx.exportSelection': ['导出选中区域…', 'Export selection…'],
  'ctx.copyPng': ['复制选区为 PNG', 'Copy selection as PNG'],
  'ctx.delete': ['删除', 'Delete'],
  'ctx.newText': ['新建文字', 'New text'],
  'ctx.paste': ['粘贴', 'Paste'],
  'ctx.selectAll': ['全选', 'Select all'],
  'ctx.fit': ['适应内容', 'Fit content'],
  'ctx.imageOriginal': ['原始尺寸', 'Original size'],
  'ctx.imageFit': ['适应宽度', 'Fit width'],
  'ctx.crop': ['裁剪 / 翻转…', 'Crop / flip…'],
  'ctx.compress': ['压缩…', 'Compress…'],
  'ctx.replace': ['替换图片…', 'Replace image…'],
  'ctx.label': ['编辑连线标签…', 'Edit connector label…'],
  'page.new': ['新建页面', 'New page'],
  'page.rename': ['重命名页面…', 'Rename page…'],
  'page.up': ['上移页面', 'Move page up'],
  'page.down': ['下移页面', 'Move page down'],
  'page.delete': ['删除当前页面', 'Delete current page'],
  'page.export': ['导出所有页面 PDF…', 'Export all pages as PDF…'],
  'new.title': ['新建白板', 'New board'],
  'new.template': ['模板', 'Template'],
  'new.create': ['创建', 'Create'],
  'tpl.blank': ['空白', 'Blank'],
  'tpl.dots': ['点阵', 'Dots'],
  'tpl.meeting': ['会议', 'Meeting'],
  'tpl.todo': ['待办', 'To-do']
};

const HELP_ROWS: [string, string][] = [
  ['V / P / E / T / R / O / A / L / I', 'V / P / E / T / R / O / A / L / I'],
  ['选择 / 画笔 / 橡皮 / 文字 / 矩形 / 椭圆 / 箭头 / 直线 / 图片', 'Select / pen / eraser / text / rectangle / ellipse / arrow / line / image'],
  ['双击 / Enter / F2', 'Double-click / Enter / F2'],
  ['编辑文字', 'Edit text'],
  ['Tab / Shift+Tab', 'Tab / Shift+Tab'],
  ['循环选中并滚入视口', 'Cycle selection and scroll into view'],
  ['Shift+点击 / 拖空白', 'Shift+click / drag empty area'],
  ['加选 / 框选（Shift 追加）', 'Add to selection / marquee (Shift adds)'],
  ['方向键 / Shift+方向键', 'Arrow keys / Shift+arrow'],
  ['微移 1px / 10px', 'Nudge 1px / 10px'],
  ['Ctrl+A / Ctrl+D', 'Ctrl+A / Ctrl+D'],
  ['全选 / 再制', 'Select all / duplicate'],
  ['Ctrl+C / Ctrl+X / Ctrl+V', 'Ctrl+C / Ctrl+X / Ctrl+V'],
  ['复制 / 剪切 / 粘贴', 'Copy / cut / paste'],
  ['Ctrl+Shift+C', 'Ctrl+Shift+C'],
  ['复制选区为透明 PNG', 'Copy selection as transparent PNG'],
  ['Ctrl+] / Ctrl+[', 'Ctrl+] / Ctrl+['],
  ['置顶 / 置底', 'Bring to front / send to back'],
  ['Ctrl+G / Ctrl+Shift+G', 'Ctrl+G / Ctrl+Shift+G'],
  ['分组 / 解组', 'Group / ungroup'],
  ['Ctrl+Shift+L / Ctrl+Shift+H', 'Ctrl+Shift+L / Ctrl+Shift+H'],
  ['锁定 / 隐藏', 'Lock / hide'],
  ['Ctrl+Shift+F / Ctrl+F', 'Ctrl+Shift+F / Ctrl+F'],
  ['缩放到选中 / 搜索画布', 'Zoom to selection / search canvas'],
  ['空格 / 中键 / 右键拖拽', 'Space / middle / right-drag'],
  ['平移画布（松手有惯性）', 'Pan canvas (with inertia)'],
  ['右键单击', 'Right-click'],
  ['上下文菜单', 'Context menu'],
  ['滚轮 / Ctrl+滚轮', 'Wheel / Ctrl+wheel'],
  ['滚动 / 缩放', 'Scroll / zoom'],
  ['移动 / 缩放 / 端点拖拽', 'Move / resize / drag endpoints'],
  ['吸附 24px 网格（Alt 临时关闭）', 'Snap to 24px grid (hold Alt to disable)'],
  ['Delete / Backspace / Esc', 'Delete / Backspace / Esc'],
  ['删除 / 结束当前工具', 'Delete / leave current tool'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Ctrl+Z / Ctrl+Shift+Z'],
  ['撤销 / 重做', 'Undo / redo'],
  ['Ctrl+S / Ctrl+O / Ctrl+N / Ctrl+E / Ctrl+P', 'Ctrl+S / Ctrl+O / Ctrl+N / Ctrl+E / Ctrl+P'],
  ['保存 / 打开 / 新建 / 导出 PNG / 打印', 'Save / open / new / export PNG / print'],
  ['F1', 'F1'],
  ['显示或关闭本帮助', 'Toggle this help']
];

export function language(): Language {
  return state.settings.language === 'en' ? 'en' : 'zh';
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key];
  let text = entry ? entry[language() === 'en' ? 1 : 0] : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), String(value));
  }
  return text;
}

function setText(selector: string, value: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) el.textContent = value;
}

function setTitle(selector: string, value: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) el.setAttribute('title', value);
}

function labelText(inputId: string, value: string): void {
  const input = document.getElementById(inputId);
  const label = input?.closest('label');
  if (!label) return;
  for (const node of Array.from(label.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim()) {
      node.textContent = value + ' ';
      return;
    }
  }
}

function optionText(selectId: string, values: Record<string, string>): void {
  const select = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!select) return;
  for (const option of Array.from(select.options)) {
    if (values[option.value]) option.textContent = values[option.value];
  }
}

export function applyI18n(): void {
  document.documentElement.lang = language() === 'en' ? 'en' : 'zh-CN';
  const toggles = document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-tool]');
  for (const btn of Array.from(toggles)) {
    const key = btn.dataset.shape ? 'tool.' + btn.dataset.shape : 'tool.' + (btn.dataset.tool || 'rect');
    const label = t(key);
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  setTitle('#pick-image', t('tool.image'));
  setText('#zoom-fit', t('zoom.fit'));
  setTitle('#zoom-out', t('zoom.out'));
  setTitle('#zoom-in', t('zoom.in'));
  setText('#panel-btn', t('panel.open'));
  setTitle('#help-btn', t('help.open'));
  setTitle('#page-add', t('page.add'));
  setTitle('#page-more', t('page.more'));
  const pageSelect = document.getElementById('page-select');
  if (pageSelect) pageSelect.setAttribute('aria-label', t('page.select'));
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.setAttribute('placeholder', t('search.placeholder'));
  setTitle('#search-close', t('search.close'));
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = t('hint');
  // 帮助
  setText('#help .help-panel h2', t('help.title'));
  setText('#help-close', t('help.close'));
  const dl = document.querySelector('#help dl');
  if (dl) {
    dl.replaceChildren();
    for (let i = 0; i < HELP_ROWS.length; i += 2) {
      const dt = document.createElement('dt');
      dt.textContent = language() === 'en' ? HELP_ROWS[i][1] : HELP_ROWS[i][0];
      const dd = document.createElement('dd');
      dd.textContent = language() === 'en' ? HELP_ROWS[i + 1][1] : HELP_ROWS[i + 1][0];
      dl.append(dt, dd);
    }
  }
  // 设置
  setText('#settings .help-panel h2', t('settings.title'));
  labelText('set-autosave', t('settings.autosave'));
  labelText('set-close', t('settings.closeAsk'));
  optionText('set-close', { ask: t('settings.closeAskOpt'), save: t('settings.closeSaveOpt'), discard: t('settings.closeDiscardOpt') });
  labelText('set-gpu', t('settings.gpu'));
  labelText('set-background', t('settings.background'));
  optionText('set-background', { dots: t('bg.dots'), grid: t('bg.grid'), plain: t('bg.plain'), cream: t('bg.cream') });
  labelText('set-theme', t('settings.theme'));
  optionText('set-theme', { light: t('theme.light'), dark: t('theme.dark') });
  labelText('set-language', t('settings.language'));
  labelText('set-export-bg', t('settings.exportBg'));
  setText('#settings-reset', t('settings.reset'));
  setText('#settings-save', t('settings.save'));
  setText('#settings-close', t('settings.close'));
  const assoc = document.querySelector('#settings .setting-assoc span');
  if (assoc) {
    const stateText = assoc.querySelector('#assoc-state');
    assoc.textContent = t('assoc.title');
    if (stateText) assoc.appendChild(stateText);
  }
  setText('#shortcut-record', t('settings.record'));
}
