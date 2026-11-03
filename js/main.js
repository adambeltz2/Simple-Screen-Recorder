// Entry point: loads every module (each wires up its own part of the page),
// then handles keyboard shortcuts, the service worker and shared files.

import { S, emit, setCur, commit, undo, redo, touch } from './state.js';
import { canRecord } from './ingest.js';
import { $, ui, initTheme } from './ui.js';
import './timeline.js';
import './annopanel.js';
import './editpanel.js';
import './recording.js';
import './exportpanel.js';
import { renderStage } from './stage.js';
import { setTool } from './stage.js';
import { curAnno, syncAnnoPanel } from './annopanel.js';
import { renderStrip } from './timeline.js';
import { stopPlayback, play } from './transport.js';
import { deleteSelection, copyFrames, cutFrames, pasteFrames, openDelayDialog } from './editpanel.js';
import { refresh } from './panels.js';
import { loadProject, offerRestore } from './project.js';
import { openFile } from './importer.js';
import { hasUnsavedWork, saveNow } from './persist.js';

// ===========================================================================
// Keyboard
// ===========================================================================

window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector('dialog[open]')) return;

  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
    if (typing && tag === 'textarea') return; // let text fields keep their own undo
    e.preventDefault();
    stopPlayback();
    if (e.key === 'y' || e.shiftKey) redo(); else undo();
    syncAnnoPanel(true);
    return;
  }
  if (mod && !e.altKey && !typing && S.frames.length) {
    const k = e.key.toLowerCase();
    if (k === 'c') { e.preventDefault(); copyFrames(); return; }
    if (k === 'x') { e.preventDefault(); stopPlayback(); cutFrames(); return; }
    if (k === 'v') { e.preventDefault(); stopPlayback(); pasteFrames(); return; }
  }
  if (typing || mod || e.altKey || !S.frames.length) return;

  switch (e.key) {
    case ' ': e.preventDefault(); if (S.playing) stopPlayback(); else play(); break;
    case 'ArrowLeft': e.preventDefault(); stopPlayback(); setCur(S.cur - 1, { extend: e.shiftKey }); break;
    case 'ArrowRight': e.preventDefault(); stopPlayback(); setCur(S.cur + 1, { extend: e.shiftKey }); break;
    case 'Home': e.preventDefault(); stopPlayback(); setCur(0, { extend: e.shiftKey }); break;
    case 'End': e.preventDefault(); stopPlayback(); setCur(S.frames.length - 1, { extend: e.shiftKey }); break;
    case 'Delete': case 'Backspace': {
      e.preventDefault();
      const a = curAnno();
      if (a && ui.lastFocus === 'stage') commit('anno-del', (s) => { s.annos = s.annos.filter((x) => x.id !== a.id); s.selAnno = null; });
      else deleteSelection();
      break;
    }
    case 'Enter': if (S.tool === 'crop' && S.crop) { e.preventDefault(); setTool('select'); } break;
    case 'Escape': if (S.selAnno != null) { S.selAnno = null; emit('view'); } else if (S.tool !== 'select') setTool('select'); break;
    case 'v': case 'V': setTool('select'); break;
    case 'd': case 'D': openDelayDialog(S.cur); break;
  }
});

window.addEventListener('resize', () => { renderStage(); renderStrip(); });
window.addEventListener('beforeunload', (e) => { if (hasUnsavedWork()) { e.preventDefault(); e.returnValue = ''; } });

// ===========================================================================
// Boot
// ===========================================================================

if (!canRecord()) {
  $('btnRecord').title = $('emptyRecord').title = 'Screen capture is not available in this browser';
  $('btnRecord').style.opacity = $('emptyRecord').style.opacity = '.55';
  $('emptyHint').textContent = "Screen capture isn't available on this device, so record with your phone's built-in screen recorder and open the video here. You can also drop a file anywhere on this page.";
}

initTheme();
refresh('change');
offerRestore();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
}

// File shared into the installed app from another Android app (see sw.js / manifest share_target)
if (new URLSearchParams(location.search).get('shared') && window.caches) {
  const sharedUrl = new URL('shared-file', location.href).href;
  caches.open('ssr-share').then(async (c) => {
    const resp = await c.match(sharedUrl);
    if (!resp) return;
    const blob = await resp.blob();
    const name = resp.headers.get('x-filename') || 'shared-file';
    history.replaceState(null, '', location.pathname);
    await c.delete(sharedUrl);
    openFile(new File([blob], name, { type: blob.type }));
  }).catch(() => {});
}

window.__app = { S, openFile, loadProject, saveNow, setCur, touch }; // handy for debugging and tests
