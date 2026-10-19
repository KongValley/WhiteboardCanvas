// SPDX-License-Identifier: GPL-3.0-or-later
export interface Field {
  key: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select';
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

export function openForm(title: string, fields: Field[], okLabel = '确定'): Promise<Record<string, string | number | boolean> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const panel = document.createElement('div');
    panel.className = 'help-panel modal-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.textContent = title;
    panel.appendChild(h);
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const field of fields) {
      const row = document.createElement('label');
      row.className = 'setting-row';
      const label = document.createElement('span');
      label.textContent = field.label;
      row.appendChild(label);
      let input: HTMLInputElement | HTMLSelectElement;
      if (field.type === 'select') {
        const select = document.createElement('select');
        for (const option of field.options || []) {
          const opt = document.createElement('option');
          opt.value = option.value;
          opt.textContent = option.label;
          select.appendChild(opt);
        }
        select.value = String(field.value);
        input = select;
      } else {
        const el = document.createElement('input');
        el.type = field.type;
        if (field.type === 'checkbox') el.checked = field.value === true;
        else el.value = String(field.value);
        if (field.min !== undefined) el.min = String(field.min);
        if (field.max !== undefined) el.max = String(field.max);
        if (field.step !== undefined) el.step = String(field.step);
        input = el;
      }
      inputs.set(field.key, input);
      row.appendChild(input);
      panel.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    actions.append(cancel, ok);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = (value: Record<string, string | number | boolean> | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const submit = () => {
      const out: Record<string, string | number | boolean> = {};
      for (const field of fields) {
        const input = inputs.get(field.key);
        if (!input) continue;
        if (field.type === 'checkbox') out[field.key] = (input as HTMLInputElement).checked;
        else if (field.type === 'number') out[field.key] = Number(input.value);
        else out[field.key] = input.value;
      }
      close(out);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && document.activeElement !== cancel) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    const first = inputs.values().next().value as HTMLInputElement | HTMLSelectElement | undefined;
    if (first) first.focus();
  });
}

export async function openPrompt(title: string, value: string): Promise<string | null> {
  const result = await openForm(title, [{ key: 'value', label: '', type: 'text', value }]);
  if (!result) return null;
  return String(result.value ?? '');
}
