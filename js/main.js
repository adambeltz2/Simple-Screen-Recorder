// UI wiring: stage interactions, timeline, panels, recording, import, export.

import {
  S, subscribe, emit, setCur, selRange, commit, checkpoint, discardCheckpoint, touch,
  undo, redo, canUndo, canRedo, resetProject, disposeProject, frameBytes, totalMs, uid,
} from './state.js';
import { drawScene, drawOverlay, hitAnno, annoHandles, hitCrop, annoActive } from './render.js';
import * as ops from './ops.js';
import { Recorder, canRecord, canDecodeImages, openVideo, extractVideo, decodeAnimatedImage } from './ingest.js';
import { renderExport, cropRegion, outputDims, resampleFrames, webpSupported } from './exporter.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FAR = 1e12; // "to the end" for annotation ranges

function fmtTime(ms) {
  const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = 0;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 3200);
}

let lastFocus = 'stage'; // where the last click landed: decides what Delete removes

// ===========================================================================
// Stage (preview canvas)
// ===========================================================================

const view = $('view');
const vctx = view.getContext('2d');

/** The part of the frame the preview shows: the crop once applied, the whole frame while editing the crop. */
const isCropped = () => !!(S.crop && S.tool !== 'crop');
const viewRect = () => (isCropped() ? S.crop : { x: 0, y: 0, w: S.W, h: S.H });

function renderStage() {
  const f = S.frames[S.cur];
  view.classList.toggle('hidden', !f);
  $('empty').hidden = !!f;
  if (!f) return;
  const c = viewRect();
  if (view.width !== c.w || view.height !== c.h) { view.width = c.w; view.height = c.h; }
  drawScene(vctx, f, { sx: c.x, sy: c.y, sw: c.w, sh: c.h, dw: c.w, dh: c.h }, S.annos, S.bg);
  const k = c.w / (view.getBoundingClientRect().width || c.w);
  drawOverlay(vctx, S, k, { x: c.x, y: c.y, cropped: isCropped() });
}

// ===========================================================================
// Timeline strip (only the visible thumbnails exist in the DOM)
// ===========================================================================

const strip = $('strip');
const stripInner = $('stripInner');
const ITEM = 96, GAP = 6, STRIDE = ITEM + GAP, PADL = 10;
const stripNodes = new Map();

function makeFrameEl(f) {
  const el = document.createElement('div');
  el._fid = f.id;
  const c = document.createElement('canvas');
  c.width = 96; c.height = 60;
  const x = c.getContext('2d');
  x.fillStyle = '#0a0b0e';
  x.fillRect(0, 0, 96, 60);
  x.drawImage(f.thumb, Math.round((96 - f.thumb.width) / 2), Math.round((60 - f.thumb.height) / 2));
  const lab = document.createElement('div');
  lab.className = 'lab';
  el._a = document.createElement('span');
  el._b = document.createElement('span');
  lab.append(el._a, el._b);
  el.append(c, lab);
  return el;
}

function renderStrip() {
  const n = S.frames.length;
  stripInner.style.width = `${n * STRIDE + PADL * 2}px`;
  const left = strip.scrollLeft, vw = strip.clientWidth;
  const first = Math.max(0, Math.floor((left - PADL) / STRIDE) - 2);
  const last = Math.min(n - 1, Math.ceil((left + vw - PADL) / STRIDE) + 2);
  const [lo, hi] = selRange();
  for (const [i, el] of stripNodes) if (i < first || i > last || i >= n) { el.remove(); stripNodes.delete(i); }
  for (let i = first; i <= last; i++) {
    const f = S.frames[i];
    let el = stripNodes.get(i);
    if (!el || el._fid !== f.id) {
      if (el) el.remove();
      el = makeFrameEl(f);
      stripInner.appendChild(el);
      stripNodes.set(i, el);
    }
    el.style.left = `${PADL + i * STRIDE}px`;
    const cls = 'fr' + (i >= lo && i <= hi ? ' in' : '') + (i === S.cur ? ' cur' : '');
    if (el.className !== cls) el.className = cls;
    const a = String(i + 1), b = `${f.delay}ms`;
    if (el._a.textContent !== a) el._a.textContent = a;
    if (el._b.textContent !== b) el._b.textContent = b;
  }
}

function ensureVisible(i) {
  const x = PADL + i * STRIDE;
  if (x < strip.scrollLeft + 8) strip.scrollLeft = Math.max(0, x - 8);
  else if (x + ITEM > strip.scrollLeft + strip.clientWidth - 8) strip.scrollLeft = x + ITEM - strip.clientWidth + 8;
}

let stripRaf = 0;
strip.addEventListener('scroll', () => {
  if (stripRaf) return;
  stripRaf = requestAnimationFrame(() => { stripRaf = 0; renderStrip(); });
});
strip.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });

const indexAt = (clientX) => {
  const r = strip.getBoundingClientRect();
  return clamp(Math.floor((clientX - r.left + strip.scrollLeft - PADL) / STRIDE), 0, S.frames.length - 1);
};

let stripDrag = null;
strip.addEventListener('pointerdown', (e) => {
  if (!S.frames.length || e.button > 0) return;
  lastFocus = 'strip';
  stopPlayback();
  strip.focus({ preventScroll: true });
  if (e.pointerType === 'touch') { stripDrag = { touch: true, x: e.clientX, y: e.clientY }; return; } // taps only; panning scrolls natively
  setCur(indexAt(e.clientX), { extend: e.shiftKey });
  stripDrag = { touch: false };
  strip.setPointerCapture(e.pointerId);
});
strip.addEventListener('pointermove', (e) => {
  if (!stripDrag || stripDrag.touch) return;
  const i = indexAt(e.clientX);
  if (i !== S.cur || S.sel.b !== i) { S.cur = i; S.sel = { a: S.sel.a, b: i }; emit('view'); }
  const r = strip.getBoundingClientRect(); // auto-scroll near the edges
  if (e.clientX > r.right - 30) strip.scrollLeft += 14;
  else if (e.clientX < r.left + 30) strip.scrollLeft -= 14;
});
const endStripDrag = (e) => {
  if (stripDrag && stripDrag.touch && e.type === 'pointerup' && Math.hypot(e.clientX - stripDrag.x, e.clientY - stripDrag.y) < 8) {
    setCur(indexAt(e.clientX), { extend: e.shiftKey });
  }
  stripDrag = null;
};
strip.addEventListener('pointerup', endStripDrag);
strip.addEventListener('pointercancel', endStripDrag);

// ===========================================================================
// Transport & playback
// ===========================================================================

const seek = $('seek');
let loopOn = true;
let rafId = 0, lastT = 0, acc = 0;

function setPlayIcon() {
  $('btnPlay').querySelector('use').setAttribute('href', S.playing ? '#i-pause' : '#i-play');
  $('btnPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
}

function updateTransport() {
  const n = S.frames.length;
  seek.max = Math.max(0, n - 1);
  seek.value = S.cur;
  seek.disabled = !n;
  let before = 0;
  for (let i = 0; i < S.cur && i < n; i++) before += S.frames[i].delay;
  $('timeLabel').textContent = `${fmtTime(before)} / ${fmtTime(totalMs())}`;
  ['btnPrev', 'btnPlay', 'btnNext'].forEach((id) => { $(id).disabled = !n; });
  setPlayIcon();
}

function play() {
  if (!S.frames.length || S.playing) return;
  if (S.cur >= S.frames.length - 1) { S.cur = 0; }
  S.playing = true;
  lastT = performance.now();
  acc = 0;
  rafId = requestAnimationFrame(tick);
  setPlayIcon();
}

function stopPlayback() {
  if (!S.playing) return;
  S.playing = false;
  cancelAnimationFrame(rafId);
  setPlayIcon();
}

function tick(now) {
  if (!S.playing) return;
  const n = S.frames.length;
  if (!n) { stopPlayback(); return; }
  acc += now - lastT;
  lastT = now;
  let changed = false;
  while (S.frames[S.cur] && acc >= S.frames[S.cur].delay) {
    acc -= S.frames[S.cur].delay;
    if (S.cur >= n - 1) {
      if (loopOn) S.cur = 0; else { stopPlayback(); changed = true; break; }
    } else S.cur++;
    changed = true;
    if (acc > 5000) { acc = 0; break; }
  }
  if (changed) { renderStage(); ensureVisible(S.cur); renderStrip(); updateTransport(); }
  if (S.playing) rafId = requestAnimationFrame(tick);
}

$('btnPlay').onclick = () => (S.playing ? stopPlayback() : play());
$('btnPrev').onclick = () => { stopPlayback(); setCur(S.cur - 1); };
$('btnNext').onclick = () => { stopPlayback(); setCur(S.cur + 1); };
$('btnLoop').onclick = () => { loopOn = !loopOn; $('btnLoop').classList.toggle('on', loopOn); };
seek.addEventListener('input', () => { stopPlayback(); setCur(+seek.value); });

// ===========================================================================
// Tools & annotations on the stage
// ===========================================================================

function setTool(t) {
  S.tool = t;
  $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  emit('view');
}
$$('.tool').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
$$('[data-add]').forEach((b) => { b.onclick = () => { if (!S.frames.length) return; activateTab('annotate'); setTool(b.dataset.add); toast('Click or drag on the preview'); }; });

function makeAnno(type, x1, y1, x2, y2) {
  const [lo, hi] = selRange();
  const multi = hi > lo;
  const f = S.frames;
  return {
    id: uid(), type, x1, y1, x2, y2,
    color: $('toolColor').value, width: +$('toolWidth').value, fill: false,
    text: 'Text', size: Math.max(14, Math.round(S.H * 0.06)), bg: false,
    block: Math.max(6, Math.round(S.W / 80)),
    from: multi ? Math.min(f[lo].seq, f[hi].seq) : f[S.cur].seq,
    to: multi ? Math.max(f[lo].seq, f[hi].seq) : FAR,
  };
}

const toSrc = (e) => { // pointer position in full-frame pixels (the preview may show only the crop)
  const r = view.getBoundingClientRect(), c = viewRect();
  return { x: c.x + ((e.clientX - r.left) * c.w) / r.width, y: c.y + ((e.clientY - r.top) * c.h) / r.height, k: c.w / r.width };
};
const curAnno = () => S.annos.find((a) => a.id === S.selAnno);

let drag = null;

view.addEventListener('pointerdown', (e) => {
  const f = S.frames[S.cur];
  if (!f || e.button > 0) return;
  lastFocus = 'stage';
  stopPlayback();
  view.setPointerCapture(e.pointerId);
  const p = toSrc(e);

  if (S.tool === 'crop') {
    const hit = hitCrop(S.crop, p.x, p.y, p.k);
    checkpoint();
    if (hit && hit !== 'move') drag = { kind: 'crop-resize', h: hit, start: { ...S.crop }, p0: p, moved: false };
    else if (hit === 'move') drag = { kind: 'crop-move', start: { ...S.crop }, p0: p, moved: false };
    else drag = { kind: 'crop-new', p0: p, moved: false };
    return;
  }

  if (S.tool === 'select') {
    const sel = curAnno();
    if (sel && annoActive(sel, f)) {
      const h = annoHandles(sel).find((hd) => Math.hypot(hd.x - p.x, hd.y - p.y) <= 12 * p.k);
      if (h) { checkpoint(); drag = { kind: 'anno-handle', id: sel.id, h: h.id, p0: p, moved: false }; return; }
    }
    for (let i = S.annos.length - 1; i >= 0; i--) {
      const a = S.annos[i];
      if (annoActive(a, f) && hitAnno(a, p.x, p.y, 8 * p.k)) {
        S.selAnno = a.id;
        checkpoint();
        drag = { kind: 'anno-move', id: a.id, p0: p, orig: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 }, moved: false };
        emit('view');
        return;
      }
    }
    S.selAnno = null;
    emit('view');
    return;
  }

  if (S.tool === 'text') {
    checkpoint();
    const a = makeAnno('text', p.x, p.y, p.x, p.y);
    S.annos.push(a);
    S.selAnno = a.id;
    S.tool = 'select';
    $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === 'select'));
    touch();
    activateTab('annotate');
    setTimeout(() => { const t = $('pText'); if (t) { t.focus(); t.select(); } }, 0);
    return;
  }

  // arrow / rect / ring / blur: drag out the shape
  checkpoint();
  const a = makeAnno(S.tool, p.x, p.y, p.x, p.y);
  S.annos.push(a);
  S.selAnno = a.id;
  drag = { kind: 'anno-new', id: a.id, p0: p, moved: false };
  emit('view');
});

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

view.addEventListener('pointermove', (e) => {
  if (!S.frames.length) return;
  const p = toSrc(e);
  if (!drag) { // hover feedback
    let cur = S.tool === 'select' ? 'default' : 'crosshair';
    const f = S.frames[S.cur];
    if (S.tool === 'crop') { const h = hitCrop(S.crop, p.x, p.y, p.k); if (h) cur = CURSORS[h]; }
    else if (S.tool === 'select' && f) {
      const sel = curAnno();
      if (sel && annoHandles(sel).some((hd) => Math.hypot(hd.x - p.x, hd.y - p.y) <= 12 * p.k)) cur = 'pointer';
      else if (S.annos.some((a) => annoActive(a, f) && hitAnno(a, p.x, p.y, 8 * p.k))) cur = 'move';
    }
    view.style.cursor = cur;
    return;
  }
  const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
  if (Math.hypot(dx, dy) > 3 * p.k) drag.moved = true;
  if (!drag.moved) return;
  const px = clamp(p.x, 0, S.W), py = clamp(p.y, 0, S.H);

  switch (drag.kind) {
    case 'crop-new': {
      const x1 = clamp(drag.p0.x, 0, S.W), y1 = clamp(drag.p0.y, 0, S.H);
      S.crop = { x: Math.round(Math.min(x1, px)), y: Math.round(Math.min(y1, py)), w: Math.max(8, Math.round(Math.abs(px - x1))), h: Math.max(8, Math.round(Math.abs(py - y1))) };
      break;
    }
    case 'crop-move': {
      const c = drag.start;
      S.crop = { ...c, x: Math.round(clamp(c.x + dx, 0, S.W - c.w)), y: Math.round(clamp(c.y + dy, 0, S.H - c.h)) };
      break;
    }
    case 'crop-resize': {
      const c = drag.start, h = drag.h;
      let x1 = c.x, y1 = c.y, x2 = c.x + c.w, y2 = c.y + c.h;
      if (h.includes('w')) x1 = clamp(c.x + dx, 0, x2 - 8);
      if (h.includes('e')) x2 = clamp(c.x + c.w + dx, x1 + 8, S.W);
      if (h.includes('n')) y1 = clamp(c.y + dy, 0, y2 - 8);
      if (h.includes('s')) y2 = clamp(c.y + c.h + dy, y1 + 8, S.H);
      S.crop = { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
      break;
    }
    case 'anno-new': {
      const a = S.annos.find((x) => x.id === drag.id);
      if (a) { a.x2 = px; a.y2 = py; }
      break;
    }
    case 'anno-handle': {
      const a = S.annos.find((x) => x.id === drag.id);
      if (a) { if (drag.h === 'p1') { a.x1 = px; a.y1 = py; } else { a.x2 = px; a.y2 = py; } }
      break;
    }
    case 'anno-move': {
      const a = S.annos.find((x) => x.id === drag.id), o = drag.orig;
      if (a) { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy; }
      break;
    }
  }
  emit('view');
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'anno-new') {
    const a = S.annos.find((x) => x.id === d.id);
    const len = a ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) : 0;
    if (a && a.type === 'ring' && len < 6) { a.x2 = a.x1 + Math.max(20, S.W * 0.03); a.y2 = a.y1; } // a plain click makes a default-size spot
    else if (!a || len < 6) {
      S.annos = S.annos.filter((x) => x.id !== d.id);
      S.selAnno = null;
      discardCheckpoint();
      emit('view');
      return;
    }
    S.tool = 'select';
    $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === 'select'));
    touch();
    return;
  }
  if (!d.moved) { discardCheckpoint(); emit('view'); return; }
  touch();
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

// colour / width in the toolbar also restyle the selected annotation
$('toolColor').addEventListener('input', () => {
  const a = curAnno();
  if (a) commit('tool-color', () => { a.color = $('toolColor').value; }, { soft: true });
});
$('toolWidth').addEventListener('input', () => {
  const a = curAnno();
  if (a) commit('tool-width', () => { a.width = +$('toolWidth').value; }, { soft: true });
});

// ===========================================================================
// Panel tabs
// ===========================================================================

function activateTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  ['edit', 'annotate', 'export'].forEach((t) => { $(`pane-${t}`).hidden = t !== name; });
  if (name === 'annotate') syncAnnoPanel(true);
}
$$('.tabs button').forEach((b) => { b.onclick = () => activateTab(b.dataset.tab); });
$('btnExportTop').onclick = () => { activateTab('export'); $('pane-export').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

// ===========================================================================
// Edit operations
// ===========================================================================

const scopeRange = () => ($('scope').value === 'all' ? [0, S.frames.length - 1] : selRange());

$('opSetStart').onclick = () => { S.sel = { a: S.cur, b: S.sel.b }; emit('view'); };
$('opSetEnd').onclick = () => { S.sel = { a: S.sel.a, b: S.cur }; emit('view'); };
$('opSelAll').onclick = () => { S.sel = { a: 0, b: S.frames.length - 1 }; emit('view'); };

$('opTrimBefore').onclick = () => {
  const i = S.cur;
  if (i === 0) return toast('Already at the first frame');
  commit('trim-before', (s) => { s.frames = ops.keep(s.frames, i, s.frames.length - 1); s.cur = 0; s.sel = { a: 0, b: 0 }; });
};
$('opTrimAfter').onclick = () => {
  const i = S.cur;
  if (i >= S.frames.length - 1) return toast('Already at the last frame');
  commit('trim-after', (s) => { s.frames = ops.keep(s.frames, 0, i); s.sel = { a: i, b: i }; });
};
$('opKeep').onclick = () => {
  const [lo, hi] = selRange();
  if (lo === 0 && hi === S.frames.length - 1) return toast('Select a range first');
  commit('keep', (s) => { s.frames = ops.keep(s.frames, lo, hi); s.cur = 0; s.sel = { a: 0, b: 0 }; });
};
function deleteSelection() {
  const [lo, hi] = selRange();
  if (hi - lo + 1 >= S.frames.length) return toast("Can't delete every frame. Use New to start over.");
  commit('delete', (s) => {
    s.frames = ops.del(s.frames, lo, hi);
    s.cur = Math.min(lo, s.frames.length - 1);
    s.sel = { a: s.cur, b: s.cur };
  });
}
$('opDelete').onclick = deleteSelection;
$('opDup').onclick = () => {
  const [lo, hi] = selRange();
  commit('dup', (s) => {
    s.frames = ops.duplicate(s.frames, lo, hi);
    s.cur = hi + 1;
    s.sel = { a: hi + 1, b: hi + (hi - lo + 1) };
  });
};
$('opSpeed').onclick = () => {
  const [lo, hi] = scopeRange(), f = parseFloat($('speedSel').value);
  commit('speed', (s) => { s.frames = ops.speed(s.frames, lo, hi, f); });
};
$('opDelay').onclick = () => {
  const [lo, hi] = scopeRange(), ms = parseInt($('delayMs').value, 10);
  if (!(ms >= 10)) return toast('Delay must be at least 10 ms', true);
  commit('delay', (s) => { s.frames = ops.setDelay(s.frames, lo, hi, ms); });
};
$('opReverse').onclick = () => {
  const [lo, hi] = scopeRange();
  commit('reverse', (s) => { s.frames = ops.reverse(s.frames, lo, hi); });
};
$('opPing').onclick = () => {
  if (S.frames.length < 3) return toast('Need at least 3 frames');
  const before = S.frames.length;
  commit('pingpong', (s) => { s.frames = ops.pingPong(s.frames); });
  toast(`Added ${S.frames.length - before} frames`);
};
$('opHalve').onclick = () => {
  const [lo, hi] = scopeRange();
  if (hi - lo < 1) return toast('Select at least two frames, or set Apply to: All frames');
  const before = S.frames.length;
  commit('halve', (s) => { s.frames = ops.dropEveryOther(s.frames, lo, hi); });
  toast(`Removed ${before - S.frames.length} frames (timing kept)`);
};
let busyOp = false;
$('opDedupe').onclick = async () => {
  if (busyOp || S.frames.length < 2) return;
  busyOp = true;
  const btn = $('opDedupe');
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const version = S.version;
    const res = await ops.dedupe(S.frames, parseFloat($('dupThr').value), (p) => { btn.textContent = `${Math.round(p * 100)}%`; });
    if (version !== S.version) return toast('Project changed while merging; try again');
    if (!res.removed) return toast('No duplicate frames found');
    commit('dedupe', (s) => { s.frames = res.frames; s.cur = 0; s.sel = { a: 0, b: 0 }; });
    toast(`Merged ${res.removed} duplicate frames`);
  } finally { busyOp = false; btn.disabled = false; btn.textContent = label; }
};

// ---- crop numbers -----------------------------------------------------------

['cropX', 'cropY', 'cropW', 'cropH'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if (!S.frames.length) return;
    let x = clamp(Math.round(+$('cropX').value || 0), 0, S.W - 8);
    let y = clamp(Math.round(+$('cropY').value || 0), 0, S.H - 8);
    const w = clamp(Math.round(+$('cropW').value || S.W), 8, S.W - x);
    const h = clamp(Math.round(+$('cropH').value || S.H), 8, S.H - y);
    commit('crop-num', (s) => { s.crop = x === 0 && y === 0 && w === s.W && h === s.H ? null : { x, y, w, h }; }, { soft: true });
  });
});
$('cropEdit').onclick = () => { if (S.frames.length) setTool('crop'); };
$('cropApply').onclick = () => {
  if (!S.crop) return toast('Draw a crop on the preview first (Crop tool)');
  setTool('select');
  toast(`Crop applied: ${S.crop.w}×${S.crop.h}. Reopen the Crop tool to adjust it.`);
};
$('cropReset').onclick = () => { if (S.crop) commit('crop-reset', (s) => { s.crop = null; }); };
$('cropAspect').onchange = () => {
  const r = parseFloat($('cropAspect').value);
  $('cropAspect').value = '';
  if (!r || !S.frames.length) return;
  let w, h;
  if (S.W / S.H > r) { h = S.H; w = Math.round(S.H * r); } else { w = S.W; h = Math.round(S.W / r); }
  commit('crop-aspect', (s) => { s.crop = { x: Math.round((s.W - w) / 2), y: Math.round((s.H - h) / 2), w, h }; });
};

// ===========================================================================
// Annotation panel
// ===========================================================================

const ANNO_NAMES = { text: 'Text', arrow: 'Arrow', rect: 'Box', ring: 'Spot', blur: 'Hidden area' };

function annoSpan(a) {
  let first = -1, last = -1;
  S.frames.forEach((f, i) => { if (annoActive(a, f)) { if (first < 0) first = i; last = i; } });
  return first < 0 ? null : [first, last];
}

function annoLabel(a) {
  if (a.type === 'text') return (String(a.text).split('\n')[0] || 'Text').slice(0, 24);
  return ANNO_NAMES[a.type];
}

let annoKey = '';
function syncAnnoPanel(force = false) {
  if ($('pane-annotate').hidden) return;
  $('annoCount').textContent = S.annos.length ? String(S.annos.length) : '';
  const list = $('annoList');
  list.innerHTML = '';
  S.annos.forEach((a) => {
    const li = document.createElement('li');
    li.className = a.id === S.selAnno ? 'on' : '';
    const span = annoSpan(a);
    li.innerHTML = `<i class="sw" style="background:${esc(a.color)}"></i><span class="nm">${esc(annoLabel(a))}</span><span class="rg">${span ? `${span[0] + 1}–${span[1] + 1}` : 'no frames'}</span>`;
    li.onclick = () => selectAnno(a.id);
    list.appendChild(li);
  });

  const key = `${S.annos.map((a) => a.id + a.type).join(',')}|${S.selAnno}`;
  if (!force && key === annoKey) { fillAnnoRange(); return; }
  annoKey = key;
  buildAnnoProps();
}

function selectAnno(id) {
  S.selAnno = id;
  const a = curAnno();
  const f = S.frames[S.cur];
  if (a && f && !annoActive(a, f)) { const sp = annoSpan(a); if (sp) { S.cur = sp[0]; S.sel = { a: sp[0], b: sp[0] }; } }
  emit('view');
}

function buildAnnoProps() {
  const box = $('annoProps');
  const a = curAnno();
  if (!a) { box.innerHTML = '<p class="hint">Select an annotation to edit it, or pick a tool and click on the preview.</p>'; return; }
  const t = a.type;
  box.innerHTML = `
    <h3>${ANNO_NAMES[t]}</h3>
    <div class="props">
      ${t === 'text' ? `<label>Text<textarea id="pText" rows="2"></textarea></label>
        <div class="two"><label>Size <input type="number" id="pSize" min="6" max="400"></label>
        <label class="check"><input type="checkbox" id="pBg"> Backdrop</label></div>` : ''}
      ${t !== 'blur' ? `<div class="two"><label>Colour <input type="color" id="pColor"></label>
        ${t !== 'text' ? '<label>Line width <input type="number" id="pWidth" min="1" max="60"></label>' : '<span></span>'}</div>` : ''}
      ${t === 'rect' || t === 'ring' ? `<label class="check"><input type="checkbox" id="pFill"> ${t === 'rect' ? 'Tinted fill' : 'Soft fill'}</label>` : ''}
      ${t === 'blur' ? '<label>Block size <input type="range" id="pBlock" min="4" max="60"></label>' : ''}
      <label>Shown on frames</label>
      <div class="two"><label>From <input type="number" id="pFrom" min="1"></label><label>To <input type="number" id="pTo" min="1"></label></div>
      <div class="quick">
        <button class="btn sm" data-range="all">Whole animation</button>
        <button class="btn sm" data-range="here">From here on</button>
        <button class="btn sm" data-range="sel">Selected frames</button>
        <button class="btn sm" data-range="only">This frame</button>
      </div>
      <div class="row"><button id="pDup" class="btn sm">Duplicate</button><button id="pDel" class="btn sm danger">Delete</button></div>
    </div>`;
  const set = (id, v) => { const el = $(id); if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } };
  set('pText', a.text); set('pSize', Math.round(a.size)); set('pBg', a.bg); set('pColor', a.color);
  set('pWidth', a.width); set('pFill', a.fill); set('pBlock', a.block);
  fillAnnoRange();
}

function fillAnnoRange() {
  const a = curAnno();
  if (!a) return;
  const sp = annoSpan(a);
  [['pFrom', sp ? sp[0] + 1 : ''], ['pTo', sp ? sp[1] + 1 : '']].forEach(([id, v]) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = v;
  });
}

$('annoProps').addEventListener('input', (e) => {
  const a = curAnno(), t = e.target;
  if (!a || !t.id) return;
  const edit = (fn) => commit(`anno-${a.id}-${t.id}`, (s) => fn(s.annos.find((x) => x.id === a.id)), { soft: true });
  switch (t.id) {
    case 'pText': edit((x) => { x.text = t.value; }); break;
    case 'pSize': edit((x) => { x.size = clamp(+t.value || 12, 6, 400); }); break;
    case 'pBg': edit((x) => { x.bg = t.checked; }); break;
    case 'pColor': edit((x) => { x.color = t.value; }); break;
    case 'pWidth': edit((x) => { x.width = clamp(+t.value || 1, 1, 60); }); break;
    case 'pFill': edit((x) => { x.fill = t.checked; }); break;
    case 'pBlock': edit((x) => { x.block = +t.value; }); break;
  }
});
$('annoProps').addEventListener('change', (e) => {
  const a = curAnno(), t = e.target;
  if (!a || (t.id !== 'pFrom' && t.id !== 'pTo')) return;
  const n = S.frames.length;
  const i1 = clamp((+$('pFrom').value || 1) - 1, 0, n - 1), i2 = clamp((+$('pTo').value || n) - 1, 0, n - 1);
  const s1 = S.frames[i1].seq, s2 = S.frames[i2].seq;
  commit(`anno-${a.id}-range`, (s) => { const x = s.annos.find((q) => q.id === a.id); x.from = Math.min(s1, s2); x.to = Math.max(s1, s2); });
});
$('annoProps').addEventListener('click', (e) => {
  const a = curAnno();
  if (!a) return;
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'pDel') { commit('anno-del', (s) => { s.annos = s.annos.filter((x) => x.id !== a.id); s.selAnno = null; }); return; }
  if (b.id === 'pDup') {
    commit('anno-dup', (s) => {
      const off = Math.round(s.W * 0.03);
      const c = { ...a, id: uid(), x1: a.x1 + off, y1: a.y1 + off, x2: a.x2 + off, y2: a.y2 + off };
      s.annos.push(c);
      s.selAnno = c.id;
    });
    return;
  }
  const r = b.dataset.range;
  if (!r) return;
  const f = S.frames;
  const [lo, hi] = selRange();
  commit('anno-range', (s) => {
    const x = s.annos.find((q) => q.id === a.id);
    if (r === 'all') { x.from = -1; x.to = FAR; }
    else if (r === 'here') { x.from = f[S.cur].seq; x.to = FAR; }
    else if (r === 'only') { x.from = x.to = f[S.cur].seq; }
    else { x.from = Math.min(f[lo].seq, f[hi].seq); x.to = Math.max(f[lo].seq, f[hi].seq); }
  });
});

// ===========================================================================
// Panel + status sync
// ===========================================================================

function syncPanels() {
  const n = S.frames.length;
  const [lo, hi] = selRange();
  $('btnUndo').disabled = !canUndo();
  $('btnRedo').disabled = !canRedo();
  $('selInfo').textContent = n ? (hi > lo ? `${lo + 1}–${hi + 1} · ${hi - lo + 1} frames` : `frame ${lo + 1}`) : '';
  $$('.pane .btn, #btnExportTop, #btnNew').forEach((b) => {
    if (b.id === 'btnRenderGif' || b.id === 'btnRenderWebp' || b.id === 'btnCancel' || b.id === 'opDedupe') return;
    if (b.closest('#results')) return;
    b.disabled = !n && b.id !== 'btnNew';
  });
  $('opDedupe').disabled = n < 2 || busyOp;
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

function refresh(what) {
  renderStage();
  renderStrip();
  updateTransport();
  syncPanels();
  if (what === 'change' && results.version !== S.version) clearResults();
}
subscribe((what) => { if (!S.playing || what === 'change') { if (S.frames.length) ensureVisible(S.cur); refresh(what); } });

// ===========================================================================
// Undo / redo / new
// ===========================================================================

$('btnUndo').onclick = () => { stopPlayback(); undo(); annoKey = ''; syncAnnoPanel(true); };
$('btnRedo').onclick = () => { stopPlayback(); redo(); annoKey = ''; syncAnnoPanel(true); };
$('btnNew').onclick = () => {
  if (S.frames.length && !confirm('Start over? This clears the current project.')) return;
  loadProject({ frames: [], W: 0, H: 0 });
};

function loadProject({ frames, W, H }) {
  stopPlayback();
  clearResults();
  disposeProject();
  resetProject({ frames, W, H });
  annoKey = '';
  activateTab('edit');
  strip.scrollLeft = 0;
}

// ===========================================================================
// Recording
// ===========================================================================

let rec = null, recTimer = 0;
const recbar = $('recbar');

function showRecbar(msg, running = false) {
  recbar.hidden = false;
  $('recMsg').textContent = msg;
  $('recTime').hidden = !running;
  $('recCount').hidden = !running;
  clearInterval(recTimer);
  if (running) {
    const upd = () => {
      if (!rec) return;
      const s = rec.stats();
      $('recTime').textContent = fmtTime(s.elapsedMs).replace(/\.\d$/, '');
      $('recCount').textContent = `${s.frames} frames · ${fmtBytes(s.bytes)}`;
    };
    upd();
    recTimer = setInterval(upd, 250);
  }
}
function hideRecbar() { recbar.hidden = true; clearInterval(recTimer); }

function openRecDialog() {
  if (!canRecord()) return toast("Screen capture isn't available in this browser. Record with your device's screen recorder, then use Open.", true);
  if (rec) return;
  if (S.frames.length && !confirm('Recording starts a new project and replaces the current one. Continue?')) return;
  $('recDlg').showModal();
}
$('btnRecord').onclick = openRecDialog;
$('emptyRecord').onclick = openRecDialog;
$('recStop').onclick = () => { if (rec) rec.stop(); };

$('recStart').addEventListener('click', (e) => {
  e.preventDefault();
  $('recDlg').close();
  startRecording();
});

async function startRecording() {
  stopPlayback();
  const r = new Recorder(
    { fps: +$('recFps').value, maxW: +$('recW').value, delay: +$('recDelay').value, skipIdentical: $('recSkip').checked },
    {
      onCountdown: (n) => showRecbar(`Starting in ${n}…`),
      onStart: () => showRecbar('Recording', true),
      onDone: ({ frames, W, H }) => {
        rec = null;
        hideRecbar();
        loadProject({ frames, W, H });
        toast(`Captured ${frames.length} frames. Trim, crop and annotate, then export.`);
      },
      onCancel: (armed) => { rec = null; hideRecbar(); toast(armed ? 'Nothing was captured' : 'Recording cancelled'); },
      onLimit: () => toast('Memory limit reached, so recording was stopped. Lower the frame rate or width for longer clips.', true),
    },
  );
  rec = r;
  showRecbar('Waiting for you to choose a source…');
  try {
    await r.start();
  } catch (e) {
    rec = null;
    hideRecbar();
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) toast('Screen capture was cancelled');
    else toast(`Could not start recording: ${e && e.message ? e.message : e}`, true);
  }
}

// ===========================================================================
// Opening files (video, GIF, WebP)
// ===========================================================================

const fileInput = $('fileInput');
$('btnOpen').onclick = () => fileInput.click();
$('emptyOpen').onclick = () => fileInput.click();
fileInput.onchange = () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) openFile(f); };

const stage = $('stage');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; stage.classList.add('drop'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) stage.classList.remove('drop'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('drop');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) openFile(f);
});

let impAbort = null;
let impCtx = null; // { kind:'video'|'image', file, info }

async function openFile(file) {
  if (S.frames.length && !confirm('Opening a file replaces the current project. Continue?')) return;
  stopPlayback();
  const isImage = /^image\/(gif|webp)$/.test(file.type) || /\.(gif|webp)$/i.test(file.name);
  const dlg = $('impDlg');
  $('impFile').textContent = `${file.name} · ${fmtBytes(file.size)}`;
  $('impProgWrap').hidden = true;
  $('impBar').style.width = '0';
  $('impGo').disabled = false;

  if (isImage) {
    if (!canDecodeImages()) return toast("This browser can't open GIF/WebP animations. Try a video file.", true);
    impCtx = { kind: 'image', file };
    $('impTitle').textContent = 'Open animation';
    $('impVideo').hidden = true;
    $('impVideoOpts').hidden = true;
    $('impImgOpts').hidden = false;
    dlg.showModal();
    return;
  }
  toast('Reading video…');
  try {
    const info = await openVideo(file);
    impCtx = { kind: 'video', file, info };
    $('impTitle').textContent = 'Open video';
    $('impVideo').hidden = false;
    $('impVideo').src = info.url;
    $('impVideoOpts').hidden = false;
    $('impImgOpts').hidden = true;
    const d = info.duration;
    const step = d > 20 ? 0.1 : 0.05;
    ['impStart', 'impEnd'].forEach((id) => { $(id).max = d; $(id).step = step; });
    $('impStart').value = 0;
    $('impEnd').value = d;
    updateImpEstimate();
    dlg.showModal();
  } catch (e) {
    toast(e.message || String(e), true);
  }
}

function updateImpEstimate() {
  if (!impCtx || impCtx.kind !== 'video') return;
  const { info } = impCtx;
  const t0 = +$('impStart').value, t1 = +$('impEnd').value;
  $('impStartVal').textContent = fmtTime(t0 * 1000);
  $('impEndVal').textContent = fmtTime(t1 * 1000);
  const fps = +$('impFps').value;
  const k = Math.min(1, +$('impW').value / info.w);
  const w = Math.round(info.w * k), h = Math.round(info.h * k);
  const count = Math.max(1, Math.floor((t1 - t0) * fps));
  const mem = count * w * h * 4;
  $('impEst').textContent = `${count} frames at ${w}×${h} · ≈${fmtBytes(mem)} in memory` + (mem > 1.2e9 ? ' · too large: lower the frame rate or width' : mem > 6e8 ? ' · large' : '');
  $('impGo').disabled = mem > 1.6e9;
}
['impStart', 'impEnd', 'impFps', 'impW'].forEach((id) => { $(id).addEventListener('input', updateImpEstimate); });
$('impStart').addEventListener('input', () => { if (+$('impStart').value > +$('impEnd').value - 0.1) $('impStart').value = Math.max(0, +$('impEnd').value - 0.1); updateImpEstimate(); });
$('impEnd').addEventListener('input', () => { if (+$('impEnd').value < +$('impStart').value + 0.1) $('impEnd').value = +$('impStart').value + 0.1; updateImpEstimate(); });

$('impCancel').addEventListener('click', () => { if (impAbort) impAbort.abort(); });
$('impDlg').addEventListener('close', () => {
  if (impAbort) impAbort.abort();
  const v = $('impVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (impCtx && impCtx.info) URL.revokeObjectURL(impCtx.info.url);
  impCtx = null;
});

$('impGo').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!impCtx) return;
  const ctx = impCtx;
  impAbort = new AbortController();
  const signal = impAbort.signal;
  $('impProgWrap').hidden = false;
  $('impGo').disabled = true;
  const onProgress = (p) => { $('impBar').style.width = `${Math.round(p * 100)}%`; };
  try {
    let res;
    if (ctx.kind === 'video') {
      res = await extractVideo(ctx.info.video, {
        fps: +$('impFps').value, maxW: +$('impW').value, t0: +$('impStart').value, t1: +$('impEnd').value,
      }, { onProgress, signal });
    } else {
      res = await decodeAnimatedImage(ctx.file, { maxW: +$('impImgW').value }, { onProgress, signal });
    }
    impAbort = null;
    $('impDlg').close();
    loadProject(res);
    toast(`Loaded ${res.frames.length} frames`);
  } catch (err) {
    impAbort = null;
    if (err && err.name === 'AbortError') return;
    console.error(err);
    toast(`Could not read that file: ${err && err.message ? err.message : err}`, true);
    $('impProgWrap').hidden = true;
    $('impGo').disabled = false;
  }
});

// ===========================================================================
// Export panel
// ===========================================================================

const STORE_KEY = 'ssr.export.v1';
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } })();
const EXPORT_FIELDS = ['expFps', 'expLoop', 'expBg', 'expDiff', 'gifColors', 'gifDither', 'gifPalette', 'webpQuality', 'webpLossless'];
EXPORT_FIELDS.forEach((id) => {
  const el = $(id);
  if (saved[id] !== undefined) { if (el.type === 'checkbox') el.checked = !!saved[id]; else el.value = saved[id]; }
  el.addEventListener('input', () => {
    try {
      const o = {};
      EXPORT_FIELDS.forEach((k) => { const e2 = $(k); o[k] = e2.type === 'checkbox' ? e2.checked : e2.value; });
      localStorage.setItem(STORE_KEY, JSON.stringify(o));
    } catch { /* storage unavailable */ }
  });
});
S.bg = $('expBg').value;
$('expBg').addEventListener('input', () => { S.bg = $('expBg').value; touch(); });
$('webpQuality').addEventListener('input', () => { $('webpQVal').textContent = $('webpQuality').value; });
$('webpQVal').textContent = $('webpQuality').value;
$('webpLossless').addEventListener('input', () => { $('webpQuality').disabled = $('webpLossless').checked; });
$('webpQuality').disabled = $('webpLossless').checked;

let regionKey = '';
function syncExport() {
  const n = S.frames.length;
  const r = cropRegion(S);
  const key = `${r.w}x${r.h}`;
  if (n && key !== regionKey) { regionKey = key; $('expW').value = Math.min(r.w, 4096); }
  if (!n) { regionKey = ''; $('expSummary').textContent = 'Nothing to export yet.'; $('expDims').textContent = ''; return; }
  const { w, h } = outputDims(S, +$('expW').value);
  const list = resampleFrames(S.frames, +$('expFps').value);
  const dur = list.reduce((a, x) => a + x.delay, 0);
  $('expDims').textContent = `→ ${w}×${h}`;
  $('expSummary').textContent = `${list.length} frames · ${fmtTime(dur)} · ${w}×${h}`;
}
['expW', 'expFps'].forEach((id) => $(id).addEventListener('input', syncExport));
$$('[data-scale]').forEach((b) => {
  b.onclick = () => { if (S.frames.length) { $('expW').value = Math.max(16, Math.round((cropRegion(S).w * +b.dataset.scale) / 100)); syncExport(); } };
});

let webpOK = true;
webpSupported().then((ok) => {
  webpOK = ok;
  $('btnRenderWebp').disabled = !ok;
  $('webpWarn').hidden = ok;
});

const results = { version: -1, gif: null, webp: null };
function clearResults() {
  ['gif', 'webp'].forEach((k) => { if (results[k]) URL.revokeObjectURL(results[k].url); results[k] = null; });
  results.version = -1;
  renderResults();
}

function stamp() {
  const d = new Date(), p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function renderResults() {
  const box = $('results');
  box.innerHTML = '';
  const have = ['gif', 'webp'].filter((k) => results[k]);
  have.forEach((k) => {
    const r = results[k];
    const name = `screen-${r.stamp}.${k}`;
    const card = document.createElement('div');
    card.className = 'res';
    card.innerHTML = `<header><b>${k.toUpperCase()}</b><span class="mono">${fmtBytes(r.blob.size)}</span></header>
      <img alt="${k} preview" src="${r.url}">
      <div class="meta">${r.w}×${r.h} · ${r.frames} frames · encoded in ${(r.ms / 1000).toFixed(1)}s${r.where === 'main' ? ' (main thread)' : ''}</div>
      <div class="acts"><a class="btn primary" download="${name}" href="${r.url}">Download</a></div>`;
    const file = new File([r.blob], name, { type: r.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const sb = document.createElement('button');
      sb.className = 'btn';
      sb.textContent = 'Share';
      sb.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
      card.querySelector('.acts').appendChild(sb);
    }
    box.appendChild(card);
  });
  if (have.length === 2) {
    const g = results.gif.blob.size, w = results.webp.blob.size;
    const p = document.createElement('div');
    p.className = 'cmp';
    p.textContent = w < g ? `WebP is ${Math.round((1 - w / g) * 100)}% smaller than the GIF.` : `The GIF is ${Math.round((1 - g / w) * 100)}% smaller here.`;
    box.appendChild(p);
  }
}

function readSettings(format) {
  return {
    format,
    width: +$('expW').value || cropRegion(S).w,
    fps: +$('expFps').value,
    diff: $('expDiff').value,
    loop: +$('expLoop').value,
    bg: $('expBg').value,
    gif: { colors: +$('gifColors').value, dither: $('gifDither').value, palette: $('gifPalette').value },
    webp: { quality: +$('webpQuality').value, lossless: $('webpLossless').checked },
  };
}

let exportAbort = null;
async function runRender(format) {
  if (!S.frames.length || exportAbort) return;
  if (format === 'webp' && !webpOK) return toast("This browser can't encode WebP.", true);
  stopPlayback();
  exportAbort = new AbortController();
  const label = format.toUpperCase();
  $('btnRenderGif').disabled = $('btnRenderWebp').disabled = true;
  $('progress').hidden = false;
  $('progBar').style.width = '0';
  $('progText').textContent = `Preparing ${label}…`;
  const version = S.version;
  try {
    const r = await renderExport(S, readSettings(format), {
      signal: exportAbort.signal,
      onProgress: (p) => { $('progBar').style.width = `${Math.round(p * 100)}%`; $('progText').textContent = `Encoding ${label}… ${Math.round(p * 100)}%`; },
    });
    if (version !== S.version) { toast('The project changed while rendering, so the result was dropped.'); return; }
    if (results.version !== version) { clearResults(); results.version = version; }
    if (results[format]) URL.revokeObjectURL(results[format].url);
    results[format] = { ...r, url: URL.createObjectURL(r.blob), stamp: stamp() };
    renderResults();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    if (e && e.name === 'AbortError') toast('Export cancelled');
    else { console.error(e); toast(`Export failed: ${e && e.message ? e.message : e}`, true); }
  } finally {
    exportAbort = null;
    $('progress').hidden = true;
    $('btnRenderGif').disabled = false;
    $('btnRenderWebp').disabled = !webpOK;
  }
}
$('btnRenderGif').onclick = () => runRender('gif');
$('btnRenderWebp').onclick = () => runRender('webp');
$('btnCancel').onclick = () => { if (exportAbort) exportAbort.abort(); };

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
    annoKey = '';
    syncAnnoPanel(true);
    return;
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
      if (a && lastFocus === 'stage') commit('anno-del', (s) => { s.annos = s.annos.filter((x) => x.id !== a.id); s.selAnno = null; });
      else deleteSelection();
      break;
    }
    case 'Enter': if (S.tool === 'crop' && S.crop) { e.preventDefault(); setTool('select'); } break;
    case 'Escape': if (S.selAnno != null) { S.selAnno = null; emit('view'); } else if (S.tool !== 'select') setTool('select'); break;
    case 'v': case 'V': setTool('select'); break;
  }
});

window.addEventListener('resize', () => { renderStage(); renderStrip(); });
window.addEventListener('beforeunload', (e) => { if (S.frames.length) { e.preventDefault(); e.returnValue = ''; } });

// ===========================================================================
// Boot
// ===========================================================================

if (!canRecord()) {
  $('btnRecord').title = $('emptyRecord').title = 'Screen capture is not available in this browser';
  $('btnRecord').style.opacity = $('emptyRecord').style.opacity = '.55';
  $('emptyHint').textContent = "Screen capture isn't available on this device, so record with your phone's built-in screen recorder and open the video here. You can also drop a file anywhere on this page.";
}

refresh('change');

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

window.__app = { S, openFile, loadProject }; // handy for debugging and tests
