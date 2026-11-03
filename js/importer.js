// Opening files: video, animated GIF/WebP, drag and drop.

import { S, commit, frameBytes } from './state.js';
import * as ops from './ops.js';
import { canDecodeImages, openVideo, extractVideo, decodeAnimatedImage, fitFrames } from './ingest.js';
import { $, fmtTime, fmtBytes, toast } from './ui.js';
import { stopPlayback } from './transport.js';
import { loadProject } from './project.js';

// ===========================================================================
// Opening files (video, GIF, WebP)
// ===========================================================================

const fileInput = $('fileInput');
$('btnOpen').onclick = () => fileInput.click();
$('emptyOpen').onclick = () => fileInput.click();
fileInput.onchange = () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) openFile(f); };

// "Add a clip" in the Edit tab: a separate picker, so cancelling it can never turn a later Open into an add.
$('opAddClip').onclick = () => { if (S.frames.length) $('fileInputAdd').click(); };
$('fileInputAdd').onchange = () => { const f = $('fileInputAdd').files[0]; $('fileInputAdd').value = ''; if (f) openFile(f, { add: true }); };

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

export async function openFile(file, { add = false } = {}) {
  if (add && !S.frames.length) add = false;
  if (!add && S.frames.length && !confirm('Opening a file replaces the current project. Continue?')) return;
  stopPlayback();
  const isImage = /^image\/(gif|webp)$/.test(file.type) || /\.(gif|webp)$/i.test(file.name);
  const dlg = $('impDlg');
  $('impFile').textContent = `${file.name} · ${fmtBytes(file.size)}`;
  $('impProgWrap').hidden = true;
  $('impBar').style.width = '0';
  $('impGo').disabled = false;

  if (isImage) {
    if (!canDecodeImages()) return toast("This browser can't open GIF/WebP animations. Try a video file.", true);
    impCtx = { kind: 'image', file, add };
    $('impTitle').textContent = add ? 'Add animation' : 'Open animation';
    $('impGo').textContent = add ? 'Add' : 'Import';
    $('impImgW').parentElement.hidden = add;
    $('impVideo').hidden = true;
    $('impVideoOpts').hidden = true;
    $('impImgOpts').hidden = false;
    dlg.showModal();
    return;
  }
  toast('Reading video…');
  try {
    const info = await openVideo(file);
    impCtx = { kind: 'video', file, info, add };
    $('impTitle').textContent = add ? 'Add video' : 'Open video';
    $('impGo').textContent = add ? 'Add' : 'Import';
    $('impW').parentElement.hidden = add;
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
  const add = impCtx.add;
  const k = Math.min(1, (add ? S.W : +$('impW').value) / info.w);
  const w = add ? S.W : Math.round(info.w * k), h = add ? S.H : Math.round(info.h * k);
  const count = Math.max(1, Math.floor((t1 - t0) * fps));
  const mem = count * w * h * 4 + (add ? frameBytes() : 0);
  $('impEst').textContent = `${count} frames at ${w}×${h} · ≈${fmtBytes(mem)} in memory${add ? ' in total' : ''}` + (mem > 1.2e9 ? ' · too large: lower the frame rate' + (add ? '' : ' or width') : mem > 6e8 ? ' · large' : '');
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
  $('impW').parentElement.hidden = false;
  $('impImgW').parentElement.hidden = false;
  $('impGo').textContent = 'Import';
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
        fps: +$('impFps').value, maxW: ctx.add ? S.W : +$('impW').value, t0: +$('impStart').value, t1: +$('impEnd').value,
      }, { onProgress, signal });
    } else {
      res = await decodeAnimatedImage(ctx.file, { maxW: ctx.add ? S.W : +$('impImgW').value }, { onProgress, signal });
    }
    impAbort = null;
    if (ctx.add) {
      if (!S.frames.length) throw new Error('The project was cleared while the clip was loading');
      const fitted = await fitFrames(res.frames, S.W, S.H);
      const where = $('addWhere').value;
      const at = where === 'start' ? 0 : where === 'end' ? S.frames.length : Math.min(S.frames.length, S.cur + 1);
      $('impDlg').close();
      commit('add-clip', (s) => {
        s.frames = ops.insertAt(s.frames, at, fitted);
        s.cur = at;
        s.sel = { a: at, b: at + fitted.length - 1 };
      });
      toast(`Added ${fitted.length} frames`);
    } else {
      $('impDlg').close();
      loadProject(res);
      toast(`Loaded ${res.frames.length} frames`);
    }
  } catch (err) {
    impAbort = null;
    if (err && err.name === 'AbortError') return;
    console.error(err);
    toast(`Could not read that file: ${err && err.message ? err.message : err}`, true);
    $('impProgWrap').hidden = true;
    $('impGo').disabled = false;
  }
});
