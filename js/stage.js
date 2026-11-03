// The preview canvas: drawing it, and the pointer tools that work on it
// (crop, select/move, and creating annotations).

import { S, emit, selRange, commit, checkpoint, discardCheckpoint, touch, uid } from './state.js';
import { drawScene, drawOverlay, hitAnno, annoHandles, hitCrop, annoActive, buildTiming, textBox } from './render.js';
import { $, $$, clamp, FAR, ui, toast, touchScale } from './ui.js';
import { stopPlayback } from './transport.js';
import { activateTab } from './panels.js';
import { curAnno } from './annopanel.js';

const view = $('view');
const vctx = view.getContext('2d');

/** The part of the frame the preview shows: the crop once applied, the whole frame while editing the crop. */
export const isCropped = () => !!(S.crop && S.tool !== 'crop');
export const viewRect = () => (isCropped() ? S.crop : { x: 0, y: 0, w: S.W, h: S.H });

// Fade timing for the preview, rebuilt only when the project changes.
let tmKey = { v: -1, frames: null, tm: null };
function previewTiming() {
  if (tmKey.v !== S.version || tmKey.frames !== S.frames) {
    tmKey = { v: S.version, frames: S.frames, tm: buildTiming(S.frames.map((f) => ({ frame: f, delay: f.delay })), S.annos) };
  }
  return tmKey.tm;
}

export function renderStage() {
  const f = S.frames[S.cur];
  view.classList.toggle('hidden', !f);
  $('empty').hidden = !!f;
  const showCrop = !!f && S.tool === 'crop' && !!S.crop;
  $('cropBar').hidden = !showCrop;
  if (showCrop) $('cropBarSize').textContent = `${S.crop.w}×${S.crop.h}`;
  if (!f) return;
  const c = viewRect();
  if (view.width !== c.w || view.height !== c.h) { view.width = c.w; view.height = c.h; }
  const tm = previewTiming();
  drawScene(vctx, f, { sx: c.x, sy: c.y, sw: c.w, sh: c.h, dw: c.w, dh: c.h }, S.annos, S.bg, tm && tm.at(S.cur));
  const k = c.w / (view.getBoundingClientRect().width || c.w);
  drawOverlay(vctx, S, k, { x: c.x, y: c.y, cropped: isCropped(), hs: touchScale() });
}

// ===========================================================================
// Tools & annotations on the stage
// ===========================================================================

export function setTool(t) {
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
    text: 'Text', size: Math.max(14, Math.round(S.H * 0.06)), bg: false, fin: 0, fout: 0,
    block: Math.max(6, Math.round(S.W / 80)),
    from: multi ? Math.min(f[lo].seq, f[hi].seq) : f[S.cur].seq,
    to: multi ? Math.max(f[lo].seq, f[hi].seq) : FAR,
  };
}

const toSrc = (e) => { // pointer position in full-frame pixels (the preview may show only the crop)
  const r = view.getBoundingClientRect(), c = viewRect();
  return { x: c.x + ((e.clientX - r.left) * c.w) / r.width, y: c.y + ((e.clientY - r.top) * c.h) / r.height, k: c.w / r.width };
};

let drag = null;

view.addEventListener('pointerdown', (e) => {
  const f = S.frames[S.cur];
  if (!f || e.button > 0) return;
  ui.lastFocus = 'stage';
  stopPlayback();
  view.setPointerCapture(e.pointerId);
  const p = toSrc(e);

  if (S.tool === 'crop') {
    const hit = hitCrop(S.crop, p.x, p.y, p.k, touchScale());
    checkpoint();
    if (hit && hit !== 'move') drag = { kind: 'crop-resize', h: hit, start: { ...S.crop }, p0: p, moved: false };
    else if (hit === 'move') drag = { kind: 'crop-move', start: { ...S.crop }, p0: p, moved: false };
    else drag = { kind: 'crop-new', p0: p, moved: false };
    return;
  }

  if (S.tool === 'select') {
    const sel = curAnno();
    if (sel && annoActive(sel, f)) {
      const h = annoHandles(sel).find((hd) => Math.hypot(hd.x - p.x, hd.y - p.y) <= 12 * p.k * touchScale());
      if (h) {
        checkpoint();
        drag = { kind: 'anno-handle', id: sel.id, h: h.id, p0: p, moved: false, start: { size: sel.size, w: sel.type === 'text' ? textBox(sel).w : 0 } };
        return;
      }
    }
    for (let i = S.annos.length - 1; i >= 0; i--) {
      const a = S.annos[i];
      if (annoActive(a, f) && hitAnno(a, p.x, p.y, 8 * p.k * touchScale())) {
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
    if (S.tool === 'crop') { const h = hitCrop(S.crop, p.x, p.y, p.k, touchScale()); if (h) cur = CURSORS[h]; }
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
      if (!a) break;
      if (drag.h === 'size') a.size = clamp(Math.round((drag.start.size * Math.max(8, px - a.x1)) / Math.max(1, drag.start.w)), 6, 400);
      else if (drag.h === 'p1') { a.x1 = px; a.y1 = py; } else { a.x2 = px; a.y2 = py; }
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
