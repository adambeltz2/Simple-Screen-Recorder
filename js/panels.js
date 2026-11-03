// Tabs, status bar and the single place that re-renders everything on a state change.

import { S, subscribe, selRange, canUndo, canRedo, frameBytes, totalMs } from './state.js';
import { $, $$, fmtTime, fmtBytes, ui } from './ui.js';
import { renderStage } from './stage.js';
import { renderStrip, ensureVisible } from './timeline.js';
import { updateTransport } from './transport.js';
import { syncAnnoPanel, curAnno } from './annopanel.js';
import { syncExport, results, clearResults } from './exportpanel.js';

// ===========================================================================
// Panel tabs
// ===========================================================================

export function activateTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  ['edit', 'annotate', 'export'].forEach((t) => { $(`pane-${t}`).hidden = t !== name; });
  if (name === 'annotate') syncAnnoPanel(true);
}
$$('.tabs button').forEach((b) => { b.onclick = () => activateTab(b.dataset.tab); });
$('btnExportTop').onclick = () => { activateTab('export'); $('pane-export').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

// ===========================================================================
// Panel + status sync
// ===========================================================================

export function syncPanels() {
  const n = S.frames.length;
  const [lo, hi] = selRange();
  $('btnUndo').disabled = !canUndo();
  $('btnRedo').disabled = !canRedo();
  $('selInfo').textContent = n ? (hi > lo ? `${lo + 1}–${hi + 1} · ${hi - lo + 1} frames` : `frame ${lo + 1}`) : '';
  $$('.pane .btn, #btnExportTop, #btnNew').forEach((b) => {
    if (b.id === 'btnRenderGif' || b.id === 'btnRenderWebp' || b.id === 'btnRenderVideo' || b.id === 'btnCancel' || b.id === 'opDedupe') return;
    if (b.closest('#results')) return;
    b.disabled = !n && b.id !== 'btnNew';
  });
  $('opDedupe').disabled = n < 2 || ui.busyOp;
  $('btnNew').disabled = false;
  $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));

  const c = S.crop || { x: 0, y: 0, w: S.W, h: S.H };
  [['cropX', c.x], ['cropY', c.y], ['cropW', c.w], ['cropH', c.h]].forEach(([id, v]) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = n ? v : '';
  });

  const sa = curAnno();
  if (sa && sa.type !== 'blur' && document.activeElement !== $('toolColor')) $('toolColor').value = sa.color;

  // status bar
  const st = $('status');
  if (!n) st.textContent = 'No frames yet';
  else {
    const mem = frameBytes();
    st.innerHTML = `<span><b>${n}</b> frames</span><span>${S.W}×${S.H}</span><span>${fmtTime(totalMs())}</span>` +
      `<span class="${mem > 8e8 ? 'warn' : ''}">≈${fmtBytes(mem)} in memory${mem > 8e8 ? ' (getting large)' : ''}</span>` +
      (S.crop ? `<span>crop ${S.crop.w}×${S.crop.h}</span>` : '');
  }
  syncAnnoPanel();
  syncExport();
}

export function refresh(what) {
  renderStage();
  renderStrip();
  updateTransport();
  syncPanels();
  if (what === 'change' && results.version !== S.version) clearResults();
}
subscribe((what) => { if (!S.playing || what === 'change') { if (S.frames.length) ensureVisible(S.cur); refresh(what); } });
