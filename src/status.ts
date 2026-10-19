// SPDX-License-Identifier: GPL-3.0-or-later
import { Pt } from './model';
import { setStatusInfo, state } from './state';
import { view } from './view';
import { t } from './i18n';

let pointer: Pt | null = null;

export function setPointerWorld(p: Pt | null): void {
  pointer = p;
  updateStatusInfo();
}

export function updateStatusInfo(): void {
  const total = state.doc.elements.length;
  const selected = state.selectedIds.length;
  const coords = pointer ? `${Math.round(pointer[0])}, ${Math.round(pointer[1])}` : '—, —';
  const save = state.dirty ? t('status.unsaved') : t('status.saved');
  let auto = '—';
  if (state.autosaveAt) {
    const d = new Date(state.autosaveAt);
    auto = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  setStatusInfo(`${coords} · ${Math.round(view.zoom * 100)}% · ${t('status.selected')} ${selected}/${total} · ${save} · ${t('status.autosave')} ${auto}`);
}
