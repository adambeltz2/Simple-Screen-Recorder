import { S, emit, setCur, selRange } from './state.js';
import { $, clamp, ui } from './ui.js';
import { stopPlayback } from './transport.js';

// ===========================================================================
// Timeline strip (only the visible thumbnails exist in the DOM)
// ===========================================================================

export const strip = $('strip');
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
    const cls = 'fr' + (i >= lo && i <= hi ? ' in' : '') + (i === S.cur ? ' cur' : '');
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
const endStripDrag = (e) => {
  if (stripDrag && stripDrag.touch && e.type === 'pointerup' && Math.hypot(e.clientX - stripDrag.x, e.clientY - stripDrag.y) < 8) {
    setCur(indexAt(e.clientX), { extend: e.shiftKey });
  }
  stripDrag = null;
};
strip.addEventListener('pointerup', endStripDrag);
strip.addEventListener('pointercancel', endStripDrag);
