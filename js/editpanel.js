// Edit tab: selection, timing and crop controls.

import { S, emit, selRange, commit } from './state.js';
import * as ops from './ops.js';
import { $, clamp, ui, toast } from './ui.js';
import { setTool } from './stage.js';

// ---- clipboard ------------------------------------------------------------------

let clip = null; // frames copied with Copy/Cut (frame objects are immutable, so sharing them is safe)
export const clearClipboard = () => { clip = null; };

export function copyFrames() {
  const [lo, hi] = selRange();
  clip = S.frames.slice(lo, hi + 1);
  toast(`Copied ${clip.length} frame${clip.length === 1 ? '' : 's'}`);
}
export function cutFrames() {
  const [lo, hi] = selRange();
  if (hi - lo + 1 >= S.frames.length) return toast("Can't cut every frame");
  clip = S.frames.slice(lo, hi + 1);
  deleteSelection(true);
  toast(`Cut ${clip.length} frame${clip.length === 1 ? '' : 's'}`);
}
export function pasteFrames() {
  if (!clip || !clip.length) return toast('Nothing copied yet');
  const [, hi] = selRange();
  const at = hi + 1;
  commit('paste', (s) => {
    const items = ops.cloneFrames(clip);
    s.frames = ops.insertAt(s.frames, at, items);
    s.cur = at;
    s.sel = { a: at, b: at + items.length - 1 };
  });
  toast(`Pasted ${clip.length} frame${clip.length === 1 ? '' : 's'}`);
}
$('opCopy').onclick = copyFrames;
$('opCut').onclick = cutFrames;
$('opPaste').onclick = pasteFrames;

// ---- one-off frame delay dialog (double-click a frame in the timeline) --------------

let delayRange = null;
export function openDelayDialog(i = S.cur) {
  if (!S.frames.length) return;
  const [lo, hi] = selRange();
  const inSel = i >= lo && i <= hi;
  const a = inSel ? lo : i, b = inSel ? hi : i;
  delayRange = [a, b];
  $('delayWho').textContent = a === b ? `Frame ${a + 1}` : `Frames ${a + 1} to ${b + 1}`;
  $('delayDlgMs').value = S.frames[i].delay;
  $('delayDlg').showModal();
  $('delayDlgMs').select();
}
$('delayDlgCancel').onclick = () => $('delayDlg').close();
$('delayDlgOk').addEventListener('click', (e) => {
  e.preventDefault();
  const ms = parseInt($('delayDlgMs').value, 10);
  if (!(ms >= 10)) return toast('Delay must be at least 10 ms', true);
  const [a, b] = delayRange;
  $('delayDlg').close();
  commit('delay-one', (s) => { s.frames = ops.setDelay(s.frames, a, b, ms); });
});

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
export function deleteSelection(quiet = false) {
  const [lo, hi] = selRange();
  if (hi - lo + 1 >= S.frames.length) return quiet || toast("Can't delete every frame. Use New to start over.");
  commit(quiet ? 'cut' : 'delete', (s) => {
    s.frames = ops.del(s.frames, lo, hi);
    s.cur = Math.min(lo, s.frames.length - 1);
    s.sel = { a: s.cur, b: s.cur };
  });
}
$('opDelete').onclick = () => deleteSelection();
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
$('opDedupe').onclick = async () => {
  if (ui.busyOp || S.frames.length < 2) return;
  ui.busyOp = true;
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
  } finally { ui.busyOp = false; btn.disabled = false; btn.textContent = label; }
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
