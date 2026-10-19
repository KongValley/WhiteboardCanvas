// SPDX-License-Identifier: GPL-3.0-or-later
import { El } from './model';
import { beginMutation, commitMutation, historyEntries, jumpToHistory, state } from './state';
import { describeEl, renderAll } from './render';
import { openPrompt } from './dialogs';

interface Hooks {
  select(ids: string[]): void;
  changed(): void;
}

let hooks: Hooks = { select: () => {}, changed: () => {} };
let panel: HTMLDivElement | null = null;
let layersBody: HTMLDivElement | null = null;
let historyBody: HTMLDivElement | null = null;
let activeTab: 'layers' | 'history' = 'layers';
let dragIndex = -1;

export function installPanels(h: Hooks): void {
  hooks = h;
  panel = document.createElement('div');
  panel.id = 'sidepanel';
  panel.hidden = true;
  const head = document.createElement('div');
  head.className = 'panel-head';
  const close = document.createElement('button');
  close.className = 'panel-close';
  close.textContent = '×';
  close.title = '关闭面板';
  close.addEventListener('click', () => togglePanels(false));
  head.appendChild(close);
  const tabs = document.createElement('div');
  tabs.className = 'panel-tabs';
  for (const tab of ['layers', 'history'] as const) {
    const button = document.createElement('button');
    button.dataset.tab = tab;
    button.textContent = tab === 'layers' ? '图层' : '历史';
    button.addEventListener('click', () => {
      activeTab = tab;
      refreshPanels();
    });
    tabs.appendChild(button);
  }
  head.appendChild(tabs);
  panel.appendChild(head);
  layersBody = document.createElement('div');
  layersBody.className = 'panel-body';
  historyBody = document.createElement('div');
  historyBody.className = 'panel-body';
  panel.append(layersBody, historyBody);
  document.body.appendChild(panel);
}

export function togglePanels(show?: boolean): void {
  if (!panel) return;
  panel.hidden = show === undefined ? !panel.hidden : !show;
  if (!panel.hidden) refreshPanels();
}

export function panelsVisible(): boolean {
  return !!panel && !panel.hidden;
}

export function refreshPanels(): void {
  if (!panel || panel.hidden) return;
  if (layersBody) layersBody.hidden = activeTab !== 'layers';
  if (historyBody) historyBody.hidden = activeTab !== 'history';
  for (const button of Array.from(panel.querySelectorAll<HTMLButtonElement>('.panel-tabs button'))) {
    button.classList.toggle('active', button.dataset.tab === activeTab);
  }
  if (activeTab === 'layers' && layersBody) renderLayers(layersBody);
  if (activeTab === 'history' && historyBody) renderHistory(historyBody);
}

function makeIconButton(text: string, title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'panel-icon';
  button.textContent = text;
  button.title = title;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    action();
  });
  return button;
}

function renderLayers(body: HTMLDivElement): void {
  body.replaceChildren();
  const selected = new Set(state.selectedIds);
  if (!state.doc.elements.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = '当前页没有元素';
    body.appendChild(empty);
    return;
  }
  const rows = state.doc.elements.slice().reverse();
  rows.forEach((el, rowIndex) => {
    const index = state.doc.elements.length - 1 - rowIndex;
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.draggable = true;
    row.dataset.index = String(index);
    row.classList.toggle('selected', selected.has(el.id));
    row.classList.toggle('muted', !!el.hidden);
    row.classList.toggle('locked', !!el.locked);
    const eye = makeIconButton(el.hidden ? '○' : '●', el.hidden ? '显示' : '隐藏', () => {
      toggleLayer(el.id, 'hidden');
    });
    const lock = makeIconButton(el.locked ? '🔒' : '🔓', el.locked ? '解锁' : '锁定', () => {
      toggleLayer(el.id, 'locked');
    });
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = describeEl(el);
    name.title = '双击重命名';
    name.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const value = await openPrompt('重命名图层', el.name || describeEl(el));
      if (value === null || !value.trim()) return;
      const before = beginMutation();
      el.name = value.trim().slice(0, 200);
      commitMutation(before, true, '重命名图层');
      renderAll();
      refreshPanels();
    });
    row.addEventListener('click', () => hooks.select([el.id]));
    row.addEventListener('dragstart', (e) => {
      dragIndex = index;
      e.dataTransfer?.setData('text/plain', String(index));
    });
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = dragIndex;
      dragIndex = -1;
      if (from < 0 || from === index) return;
      reorderLayer(from, index);
    });
    row.append(eye, lock, name);
    body.appendChild(row);
  });
}

function toggleLayer(id: string, key: 'hidden' | 'locked'): void {
  const el = state.doc.elements.find((item) => item.id === id);
  if (!el) return;
  const before = beginMutation();
  if (key === 'hidden') el.hidden = el.hidden ? undefined : true;
  else el.locked = el.locked ? undefined : true;
  if (el.hidden) state.selectedIds = state.selectedIds.filter((selected) => selected !== id);
  commitMutation(before, true, key === 'hidden' ? '切换显隐' : '切换锁定');
  renderAll();
  hooks.changed();
  refreshPanels();
}

function reorderLayer(from: number, to: number): void {
  if (from === to) return;
  const before = beginMutation();
  const elements = state.doc.elements;
  const [el] = elements.splice(from, 1);
  elements.splice(to, 0, el);
  commitMutation(before, true, '调整图层顺序');
  renderAll();
  hooks.changed();
  refreshPanels();
}

function renderHistory(body: HTMLDivElement): void {
  body.replaceChildren();
  const entries = historyEntries();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = '暂无历史记录';
    body.appendChild(empty);
    return;
  }
  const doneCount = entries.filter((entry) => entry.done).length;
  const now = document.createElement('div');
  now.className = 'history-row current';
  now.textContent = '当前状态';
  body.appendChild(now);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const row = document.createElement('button');
    row.className = 'history-row' + (entry.done ? '' : ' undone');
    row.textContent = entry.label;
    row.title = entry.done ? '跳转到该步骤之后' : '重做至该步骤';
    row.addEventListener('click', () => {
      const target = i < doneCount ? i + 1 : doneCount;
      if (jumpToHistory(target)) {
        renderAll();
        hooks.changed();
      }
      refreshPanels();
    });
    body.appendChild(row);
  }
}

export function layerElements(): El[] {
  return state.doc.elements;
}
