// SPDX-License-Identifier: GPL-3.0-or-later
export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean;
}

const menu = document.getElementById('context-menu') as HTMLDivElement;
let open = false;

export function hideContextMenu(): void {
  if (!open) return;
  open = false;
  menu.hidden = true;
  menu.replaceChildren();
}

function focusItem(index: number): void {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button.menu-item:not([disabled])'));
  if (!items.length) return;
  const next = ((index % items.length) + items.length) % items.length;
  items[next].focus();
}

export function showContextMenu(items: MenuItem[], clientX: number, clientY: number): void {
  hideContextMenu();
  open = true;
  menu.replaceChildren();
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-item';
    button.textContent = item.label;
    button.disabled = !!item.disabled;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      hideContextMenu();
      item.action();
    });
    menu.appendChild(button);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  const maxX = window.innerWidth - r.width - 8;
  const maxY = window.innerHeight - r.height - 8;
  menu.style.left = Math.max(8, Math.min(clientX, maxX)) + 'px';
  menu.style.top = Math.max(8, Math.min(clientY, maxY)) + 'px';
  focusItem(0);
}

export function installContextMenu(): void {
  menu.hidden = true;
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideContextMenu();
      return;
    }
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button.menu-item:not([disabled])'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(current + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (current <= 0) focusItem(buttons.length - 1);
      else focusItem(current - 1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      focusItem(current + (e.shiftKey ? -1 : 1));
    }
  });
  window.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (menu.contains(e.target as Node)) return;
    hideContextMenu();
  });
  window.addEventListener('blur', () => hideContextMenu());
}
