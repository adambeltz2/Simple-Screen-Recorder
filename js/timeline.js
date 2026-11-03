import { S, emit, setCur, selRange, THUMB_W, THUMB_H } from './state.js';
import { $, clamp, ui } from './ui.js';
import { stopPlayback } from './transport.js';
import { openDelayDialog } from './editpanel.js';

// ===========================================================================
// Timeline strip (only the visible thumbnails exist in the DOM)
// ===========================================================================

export const strip = $('strip');
const stripInner = $('stripInner');
const GAP = 6, PADL = 10;
let ITEM = 96, STRIDE = ITEM + GAP;

// ---- zoom: thumbnail size ----------------------------------------------------
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];
const ZOOM_KEY = 'ssr.zoom.v1';
let zoomI = 2;
try { const v = parseInt(localStorage.getItem(ZOOM_KEY), 10); if (v >= 0 && v < ZOOMS.length) zoomI = v; } catch { /* storage unavailable */ }

function applyZoom() {
  const z = ZOOMS[zoomI];
  ITEM = Math.round(96 * z);
  STRIDE = ITEM + GAP;
  strip.style.setProperty('--fw', `${ITEM}px`);
  strip.style.setProperty('--fh', `${Math.round(60 * z)}px`);
  $('zoomOut').disabled = zoomI === 0;
  $('zoomIn').disabled = zoomI === ZOOMS.length - 1;
}

/** Change thumbnail size, keeping the frame in the middle of the view where it was. */
export function setZoom(i) {
  i = clamp(i, 0, ZOOMS.length - 1);
  if (i === zoomI) return;
  const mid = (strip.scrollLeft + strip.clientWidth / 2 - PADL) / STRIDE;
  zoomI = i;
  try { localStorage.setItem(ZOOM_KEY, String(i)); } catch { /* storage unavailable */ }
  applyZoom();
  renderStrip();
  strip.scrollLeft = Math.max(0, mid * STRIDE + PADL - strip.clientWidth / 2);
  renderStrip();
}
$('zoomOut').onclick = () => setZoom(zoomI - 1);
$('zoomIn').onclick = () => setZoom(zoomI + 1);
const stripNodes = new Map();
applyZoom();

function makeFrameEl(f) {
  const el = document.createElement('div');
  el._fid = f.id;
  const c = document.createElement('canvas');
  c.width = THUMB_W; c.height = THUMB_H;
  const x = c.getContext('2d');
  x.fillStyle = '#0a0b0e';
  x.fillRect(0, 0, THUMB_W, THUMB_H);
  x.drawImage(f.thumb, Math.round((THUMB_W - f.thumb.width) / 2), Math.round((THUMB_H - f.thumb.height) / 2));
  const lab = document.createElement('div');
  lab.className = 'lab';
  el._a = document.createElement('span');
  el._b = document.createElement('span');
  lab.append(el._a, el._b);
  el.append(c, lab);
  return el;
}

export function renderStrip() {
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
    const cls = 'fr' + (i >= lo && i <= hi ? ' in' : '') + (i === S.cur ? ' cur' : '') + (ITEM < 70 ? ' tiny' : '');
    if (el.className !== cls) el.className = cls;
    const a = String(i + 1), b = `${f.delay}ms`;
    if (el._a.textContent !== a) el._a.textContent = a;
    if (el._b.textContent !== b) el._b.textContent = b;
  }
}

export function ensureVisible(i) {
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
  if (e.ctrlKey) { e.preventDefault(); setZoom(zoomI + (e.deltaY < 0 ? 1 : -1)); return; } // ctrl+wheel (and trackpad pinch) zooms
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });

const indexAt = (clientX) => {
  const r = strip.getBoundingClientRect();
  return clamp(Math.floor((clientX - r.left + strip.scrollLeft - PADL) / STRIDE), 0, S.frames.length - 1);
};

let stripDrag = null;
strip.addEventListener('pointerdown', (e) => {
  if (!S.frames.length || e.button > 0) return;
  ui.lastFocus = 'strip';
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
let lastTap = { t: 0, i: -1 };
const endStripDrag = (e) => {
  if (stripDrag && stripDrag.touch && e.type === 'pointerup' && Math.hypot(e.clientX - stripDrag.x, e.clientY - stripDrag.y) < 8) {
    const i = indexAt(e.clientX);
    setCur(i, { extend: e.shiftKey });
    const now = performance.now();
    if (i === lastTap.i && now - lastTap.t < 380) { lastTap = { t: 0, i: -1 }; openDelayDialog(i); } // double-tap
    else lastTap = { t: now, i };
  }
  stripDrag = null;
};
strip.addEventListener('dblclick', (e) => { if (S.frames.length) openDelayDialog(indexAt(e.clientX)); });
strip.addEventListener('pointerup', endStripDrag);
strip.addEventListener('pointercancel', endStripDrag);
