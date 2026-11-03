// Annotate tab: layer list and the properties of the selected annotation.

import { S, emit, selRange, commit, uid } from './state.js';
import { annoActive } from './render.js';
import { $, clamp, FAR, esc } from './ui.js';

export const curAnno = () => S.annos.find((a) => a.id === S.selAnno);
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
export function syncAnnoPanel(force = false) {
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
