// Whole-project actions: undo/redo, new, and replacing the project with loaded frames.

import { S, undo, redo, resetProject, disposeProject, touch } from './state.js';
import { $, fmtTime, toast } from './ui.js';
import { peekSaved, loadSaved, discardSaved, onSaveStatus } from './persist.js';
import { stopPlayback } from './transport.js';
import { strip } from './timeline.js';
import { activateTab } from './panels.js';
import { clearResults } from './exportpanel.js';
import { syncAnnoPanel } from './annopanel.js';
import { clearClipboard } from './editpanel.js';

$('btnUndo').onclick = () => { stopPlayback(); undo(); syncAnnoPanel(true); };
$('btnRedo').onclick = () => { stopPlayback(); redo(); syncAnnoPanel(true); };
$('btnNew').onclick = () => {
  if (S.frames.length && !confirm('Start over? This clears the current project.')) return;
  loadProject({ frames: [], W: 0, H: 0 });
};

export function loadProject({ frames, W, H }) {
  stopPlayback();
  $('restoreBox').hidden = true;
  clearClipboard();
  clearResults();
  disposeProject();
  resetProject({ frames, W, H });
  activateTab('edit');
  strip.scrollLeft = 0;
}

// ---- autosave: indicator and restore prompt --------------------------------

const SAVE_TEXT = {
  idle: ['', ''], pending: ['Unsaved changes', ''], saving: ['Saving…', ''], saved: ['Autosaved', 'ok'],
};
onSaveStatus((state, reason) => {
  const el = $('saveInd');
  if (state === 'failed') { el.textContent = `Not autosaved (${reason})`; el.className = 'save warn'; return; }
  const [text, cls] = SAVE_TEXT[state] || ['', ''];
  el.textContent = S.frames.length ? text : '';
  el.className = `save ${cls}`;
});

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** If a previous session left a project behind, offer to bring it back (shown on the empty screen). */
export async function offerRestore() {
  if (S.frames.length) return;
  const meta = await peekSaved();
  if (!meta || S.frames.length) return;
  const dur = meta.frames.reduce((a, f) => a + f.delay, 0);
  $('restoreInfo').textContent = `${meta.frames.length} frames · ${fmtTime(dur)} · ${meta.W}×${meta.H} · saved ${ago(meta.savedAt)}`;
  $('restoreBox').hidden = false;
  const go = $('restoreGo');
  go.onclick = async () => {
    go.disabled = true;
    try {
      const res = await loadSaved(meta, (p) => { go.textContent = `Restoring ${Math.round(p * 100)}%`; });
      loadProject(res);
      S.crop = res.crop || null;
      S.annos = res.annos || [];
      if (res.bg) { S.bg = res.bg; $('expBg').value = res.bg; }
      touch();
      $('restoreBox').hidden = true;
      toast(`Restored ${res.frames.length} frames`);
    } catch (e) {
      console.error(e);
      toast(`Could not restore: ${e && e.message ? e.message : e}`, true);
      go.disabled = false;
      go.textContent = 'Restore';
    }
  };
  $('restoreDrop').onclick = async () => { await discardSaved(); $('restoreBox').hidden = true; };
}
