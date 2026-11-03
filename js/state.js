// Project state, change notification and undo/redo.
//
// A "project" is a list of frames plus a crop rectangle and a list of
// annotations. Frame objects are treated as immutable (edits create new frame
// objects that share the same bitmap), so an undo snapshot is just a shallow
// copy of the array. That keeps undo cheap even with hundreds of frames.

export const THUMB_W = 96;
export const THUMB_H = 60;

export const S = {
  frames: [],       // { id, seq, bmp, delay(ms), thumb }
  W: 0, H: 0,       // size every frame is normalised to
  crop: null,       // { x, y, w, h } in frame pixels, or null
  annos: [],        // annotation objects (see render.js)
  cur: 0,           // frame shown in the preview
  sel: { a: 0, b: 0 }, // selected frame range (indices, inclusive; a may be > b)
  tool: 'select',
  selAnno: null,    // id of selected annotation
  playing: false,
  bg: '#ffffff',    // colour used under transparent pixels
  version: 0,       // bumps whenever project content changes
};

let _id = 1;
let _seq = 0;
export const uid = () => _id++;
export const nextSeq = () => _seq++;

/** `seq` identifies the original frame a copy came from; annotations use it
 *  so they keep their place when frames are reordered, reversed or deleted. */
export function makeFrame(bmp, delay) {
  return { id: uid(), seq: _seq++, bmp, delay: Math.max(10, Math.round(delay)), thumb: makeThumb(bmp) };
}

export function makeThumb(bmp) {
  const k = Math.min(THUMB_W / bmp.width, THUMB_H / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, w, h);
  x.drawImage(bmp, 0, 0, w, h);
  return c;
}

// ---- listeners ------------------------------------------------------------

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** 'change' = project content changed; 'view' = only cursor/selection/tool changed. */
export const emit = (what = 'change') => listeners.forEach((fn) => fn(what));

// ---- selection helpers ----------------------------------------------------

export const selRange = () => [Math.min(S.sel.a, S.sel.b), Math.max(S.sel.a, S.sel.b)];

export function clampState() {
  const n = S.frames.length;
  if (!n) { S.cur = 0; S.sel = { a: 0, b: 0 }; return; }
  const cl = (v) => Math.max(0, Math.min(n - 1, v | 0));
  S.cur = cl(S.cur);
  S.sel = { a: cl(S.sel.a), b: cl(S.sel.b) };
  if (S.selAnno != null && !S.annos.some((a) => a.id === S.selAnno)) S.selAnno = null;
}

export function setCur(i, { extend = false, collapse = true } = {}) {
  const n = S.frames.length;
  if (!n) return;
  const v = Math.max(0, Math.min(n - 1, i | 0));
  if (extend) S.sel = { a: S.sel.a, b: v };
  else if (collapse) S.sel = { a: v, b: v };
  S.cur = v;
  emit('view');
}

// ---- undo / redo ----------------------------------------------------------

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 40;
let lastKey = null, lastTime = 0;

function snap() {
  return {
    frames: S.frames.slice(),
    crop: S.crop && { ...S.crop },
    annos: S.annos.map((a) => ({ ...a })),
    W: S.W, H: S.H, cur: S.cur, sel: { ...S.sel }, selAnno: S.selAnno,
  };
}

function restore(s) {
  S.frames = s.frames.slice();
  S.crop = s.crop && { ...s.crop };
  S.annos = s.annos.map((a) => ({ ...a }));
  S.W = s.W; S.H = s.H; S.cur = s.cur; S.sel = { ...s.sel }; S.selAnno = s.selAnno;
  clampState();
}

/** Save the current state so the next change can be undone. */
export function checkpoint() {
  undoStack.push(snap());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  lastKey = null;
}

/** Throw away the checkpoint just taken (used when a drag turned out to change nothing). */
export function discardCheckpoint() { undoStack.pop(); }

/** Mark content as changed and notify. */
export function touch() { S.version++; clampState(); emit('change'); }

/**
 * Apply a change as one undo step. With `soft`, repeated calls with the same
 * key within ~1.2s share a step (typing in a field, dragging a slider).
 */
export function commit(key, mutate, { soft = false } = {}) {
  const now = performance.now();
  if (!(soft && key === lastKey && now - lastTime < 1200)) checkpoint();
  lastKey = soft ? key : null;
  lastTime = now;
  mutate(S);
  touch();
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snap());
  restore(undoStack.pop());
  lastKey = null;
  S.version++;
  emit('change');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snap());
  restore(redoStack.pop());
  lastKey = null;
  S.version++;
  emit('change');
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

// ---- replacing the whole project -----------------------------------------

/** Free every bitmap the old project (and its undo history) was holding. */
export function disposeProject() {
  const bitmaps = new Set();
  const add = (arr) => arr.forEach((f) => bitmaps.add(f.bmp));
  add(S.frames);
  undoStack.forEach((s) => add(s.frames));
  redoStack.forEach((s) => add(s.frames));
  undoStack.length = 0;
  redoStack.length = 0;
  bitmaps.forEach((b) => { try { b.close && b.close(); } catch { /* already closed */ } });
}

export function resetProject({ frames = [], W = 0, H = 0 } = {}) {
  Object.assign(S, {
    frames, W, H, crop: null, annos: [], cur: 0, sel: { a: 0, b: 0 },
    selAnno: null, playing: false, tool: 'select',
  });
  S.version++;
  emit('change');
}

export const frameBytes = () => S.frames.length * S.W * S.H * 4;
export const totalMs = () => S.frames.reduce((a, f) => a + f.delay, 0);
