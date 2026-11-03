// Shared UI helpers and a few cross-module flags.

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const FAR = 1e12; // "to the end" for annotation ranges

/** Finger-sized targets: handles and hit areas are larger on touch screens. */
const coarseMq = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
export const touchScale = () => (coarseMq && coarseMq.matches ? 1.8 : 1);

/** lastFocus: where the last click landed (decides what Delete removes). busyOp: a long edit is running. */
export const ui = { lastFocus: 'stage', busyOp: false };

export function fmtTime(ms) {
  const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
export function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = 0;
export function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 3200);
}

// ---- colour theme: Auto (follow the system) -> Light -> Dark ----------------------------

const THEME_KEY = 'ssr.theme.v1';
const THEME_NAMES = { auto: 'automatic', light: 'light', dark: 'dark' };
const THEME_COLOR = { light: '#ffffff', dark: '#0f1115' };

export const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'auto';

function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* storage unavailable */ }
  // browser chrome colour: a forced theme overrides the media-query pair in the head
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => {
    if (t === 'auto') { m.content = m.media.includes('light') ? THEME_COLOR.light : THEME_COLOR.dark; m.media = m.dataset.media || m.media; }
    else { m.dataset.media = m.dataset.media || m.media; m.media = 'all'; m.content = THEME_COLOR[t]; }
  });
  const b = document.getElementById('btnTheme');
  if (b) {
    const label = `Colour theme: ${THEME_NAMES[t]}`;
    b.setAttribute('aria-label', label);
    b.title = `${label} (click to change)`;
  }
}

export function initTheme() {
  const b = document.getElementById('btnTheme');
  if (!b) return;
  applyTheme(currentTheme());
  b.onclick = () => applyTheme({ auto: 'light', light: 'dark', dark: 'auto' }[currentTheme()]);
}
