// Export tab: settings, rendering, results.

import { S, touch } from './state.js';
import { renderExport, cropRegion, outputDims, resampleFrames, webpSupported } from './exporter.js';
import { $, $$, fmtTime, fmtBytes, toast } from './ui.js';
import { stopPlayback } from './transport.js';

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
export function syncExport() {
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

export const results = { version: -1, gif: null, webp: null };
export function clearResults() {
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
