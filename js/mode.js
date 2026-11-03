// Simple / Advanced mode.
//
// Advanced is the full editor. Simple hides the detail behind a three-step
// panel (Trim, Crop, Add a note) and an export screen that asks for a format
// and a goal. The goals do not have their own pipeline: they write into the
// same Export-tab fields Advanced shows, then render, so you can switch to
// Advanced and see (and tweak) exactly what was chosen.

import { S, subscribe } from './state.js';
import { $, $$, toast } from './ui.js';
import { cropRegion, webpSupported } from './exporter.js';
import { setTool } from './stage.js';
import { activateTab } from './panels.js';
import { runRender } from './exportpanel.js';

const MODE_KEY = 'ssr.mode.v1';
const SIMPLE_KEY = 'ssr.simple.v1';
const root = document.documentElement;

/** What each goal asks for. `fps: 0` keeps the original frame rate. */
export const GOALS = {
  chat: { name: 'Chat or email', sub: 'Fits under 10 MB.', badge: '≤ 10 MB', target: 10, maxW: 640, fps: 15 },
  web: { name: 'Web page or docs', sub: 'Small file, still sharp.', badge: 'Smaller', target: 0, maxW: 800, fps: 12 },
  best: { name: 'Best quality', sub: 'Full size, no size limit.', badge: 'Full quality', target: 0, maxW: Infinity, fps: 0 },
  tiny: { name: 'Tiny', sub: 'For tight limits. Under 1 MB.', badge: '≤ 1 MB', target: 1, maxW: 480, fps: 10 },
};

const GIF_TUNE = {
  chat: { colors: 256, dither: 'light', palette: 'global', diff: 'light' },
  web: { colors: 128, dither: 'light', palette: 'global', diff: 'light' },
  best: { colors: 256, dither: 'full', palette: 'local', diff: 'exact' },
  tiny: { colors: 64, dither: 'light', palette: 'global', diff: 'medium' },
};
const WEBP_TUNE = {
  chat: { quality: 75, lossless: false, diff: 'light' },
  web: { quality: 65, lossless: false, diff: 'light' },
  best: { quality: 90, lossless: true, diff: 'exact' },
  tiny: { quality: 50, lossless: false, diff: 'medium' },
};

/** The concrete settings for a format + goal. Pure, so tests can check it. */
export function presetSettings(format, goal, srcWidth) {
  const g = GOALS[goal];
  const out = {
    format, goal,
    width: Math.max(16, Math.min(srcWidth, g.maxW, 4096)),
    fps: g.fps,
    target: g.target,
    ...(format === 'webp' ? WEBP_TUNE[goal] : GIF_TUNE[goal]),
  };
  return out;
}

let saved = { format: 'gif', goal: 'chat' };
try { Object.assign(saved, JSON.parse(localStorage.getItem(SIMPLE_KEY) || '{}')); } catch { /* defaults */ }
if (!GOALS[saved.goal]) saved.goal = 'chat';
let webpOK = true;

const save = () => { try { localStorage.setItem(SIMPLE_KEY, JSON.stringify(saved)); } catch { /* ignore */ } };

// --- moving shared nodes between the Simple and Advanced panes -------------
// The properties editor and the render progress/results exist once. They live
// in the Advanced panes and are borrowed by Simple while it is showing.
const homes = new Map();
function borrow(node, host) {
  if (!homes.has(node)) {
    const marker = document.createComment(node.id);
    node.parentNode.insertBefore(marker, node);
    homes.set(node, marker);
  }
  host.appendChild(node);
}
function giveBack(node) {
  const marker = homes.get(node);
  if (marker && marker.parentNode) marker.parentNode.insertBefore(node, marker);
}

// --- mode + view ------------------------------------------------------------
export const getMode = () => root.getAttribute('data-mode') || 'simple';

export function setMode(m) {
  m = m === 'advanced' ? 'advanced' : 'simple';
  root.setAttribute('data-mode', m);
  try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  $('modeSimple').setAttribute('aria-pressed', String(m === 'simple'));
  $('modeAdvanced').setAttribute('aria-pressed', String(m === 'advanced'));
  if (m === 'simple') {
    setView('edit');
    borrow($('annoProps'), $('simpleNote'));
    borrow($('progress'), $('sHost'));
    borrow($('results'), $('sHost'));
  } else {
    giveBack($('annoProps'));
    giveBack($('progress'));
    giveBack($('results'));
  }
}

function setView(v) {
  root.setAttribute('data-sview', v);
  if (v === 'export') syncSimpleExport();
}

// --- Simple: edit -----------------------------------------------------------
$('sKeep').onclick = () => $('opKeep').click();
$('sDel').onclick = () => $('opDelete').click();
$('sGoExport').onclick = () => { if (S.frames.length) setView('export'); };
$$('#sShapes [data-ratio]').forEach((b) => {
  b.onclick = () => {
    if (!S.frames.length) return;
    setTool('crop');
    const r = +b.dataset.ratio;
    $$('#sShapes .chip').forEach((c) => c.classList.toggle('on', c === b));
    if (r) { $('cropAspect').value = String(r); $('cropAspect').dispatchEvent(new Event('change')); }
    else toast('Drag on the preview to choose the crop');
  };
});
$$('[data-note]').forEach((b) => {
  b.onclick = () => { if (!S.frames.length) return; setTool(b.dataset.note); toast('Click or drag on the preview'); };
});

// --- Simple: export ---------------------------------------------------------
function buildGoals() {
  const box = $('sGoals');
  box.innerHTML = '';
  Object.entries(GOALS).forEach(([id, g]) => {
    const b = document.createElement('button');
    b.className = 'goal';
    b.dataset.goal = id;
    b.innerHTML = `<span class="gt"><b></b><small></small></span><span class="gb"></span>`;
    b.querySelector('b').textContent = g.name;
    b.querySelector('small').textContent = g.sub;
    b.querySelector('.gb').textContent = g.badge;
    b.onclick = () => { saved.goal = id; save(); syncSimpleExport(); };
    box.appendChild(b);
  });
}

function currentPreset() {
  const src = S.frames.length ? cropRegion(S).w : 640;
  return presetSettings(saved.format, saved.goal, src);
}

export function syncSimpleExport() {
  if (!webpOK && saved.format === 'webp') saved.format = 'gif';
  $$('#sFormat [data-fmt]').forEach((b) => {
    b.hidden = b.dataset.fmt === 'webp' && !webpOK;
    b.setAttribute('aria-pressed', String(b.dataset.fmt === saved.format));
  });
  $$('#sGoals .goal').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.goal === saved.goal)));
  const p = currentPreset();
  const FMT = p.format.toUpperCase();
  const bits = [FMT];
  if (p.format === 'webp') bits.push(p.lossless ? 'lossless' : `quality ${p.quality}`);
  else bits.push(`up to ${p.colors} colours`);
  bits.push(`${p.width} px wide`, p.fps ? `${p.fps} fps` : 'original frame rate');
  $('sSpec').textContent = bits.join(' · ');
  $('sAim').textContent = p.target ? `Aims for under ${p.target} MB` : 'No size limit';
  $('sRender').textContent = `Render ${FMT}`;
  $('sFmtHint').textContent = webpOK
    ? 'GIF plays everywhere. WebP is smaller and sharper.'
    : 'This browser can only make GIFs.';
  $('sNote').textContent = saved.goal === 'best' && p.format === 'gif' ? 'On GIF, Best quality means 256 colours at full size.' : '';
  $('sRender').disabled = !S.frames.length;
}

$$('#sFormat [data-fmt]').forEach((b) => { b.onclick = () => { saved.format = b.dataset.fmt; save(); syncSimpleExport(); }; });
$('sBack').onclick = () => setView('edit');
$('sAdv').onclick = () => { setMode('advanced'); activateTab('export'); };

/** Write a preset into the Advanced fields (and let their listeners store and sync it). */
function writeFields(p) {
  const set = (id, v) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  applying = true;
  set('expW', p.width); set('expFps', p.fps); set('expTarget', p.target); set('expDiff', p.diff);
  if (p.format === 'gif') { set('gifColors', p.colors); set('gifDither', p.dither); set('gifPalette', p.palette); }
  else { set('webpQuality', p.quality); set('webpLossless', p.lossless); }
  applying = false;
  const note = $('presetNote');
  note.textContent = `Started from ${GOALS[p.goal].name} (${p.format.toUpperCase()}).`;
  note.hidden = false;
  note.dataset.edited = '';
}
let applying = false;
$('pane-export').addEventListener('input', () => {
  const note = $('presetNote');
  if (applying || note.hidden || note.dataset.edited) return;
  note.dataset.edited = '1';
  note.textContent += ' You have changed some settings since.';
});

$('sRender').onclick = () => {
  if (!S.frames.length) return;
  const p = currentPreset();
  writeFields(p);
  runRender(p.format);
};

// --- wiring -----------------------------------------------------------------
$('modeSimple').onclick = () => setMode('simple');
$('modeAdvanced').onclick = () => setMode('advanced');

function syncSimple() {
  $('sSel').textContent = $('selInfo').textContent;
  if (getMode() === 'simple' && root.getAttribute('data-sview') === 'export') syncSimpleExport();
  if (S.tool !== 'crop') $$('#sShapes .chip').forEach((c) => c.classList.remove('on'));
}

buildGoals();
webpSupported().then((ok) => { webpOK = ok; syncSimpleExport(); });
subscribe(syncSimple);
setMode(getMode());
syncSimpleExport();
