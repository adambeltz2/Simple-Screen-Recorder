// Autosave: keeps the current project in IndexedDB so a crash, refresh or
// accidental tab close does not lose it. Everything stays on this device.
//
// Layout of the 'kv' store:
//   'meta'      -> { v, savedAt, W, H, bg, crop, annos, frames:[{k, seq, delay}] }
//   'b:<key>'   -> PNG Blob for one unique bitmap (duplicated frames share a key)
//
// Order matters: bitmaps are written first, then 'meta', then stale bitmaps
// are removed, so a crash mid-save leaves the previous save intact.

import { S, subscribe, restoreFrame, ensureIds } from './state.js';

const DB_NAME = 'ssr-project';
const STORE = 'kv';
const DEBOUNCE_MS = 2500;

let dbp = null;
const openDb = () => dbp || (dbp = new Promise((res, rej) => {
  if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB unavailable'));
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.onblocked = () => rej(new Error('IndexedDB blocked'));
}));

/** Run fn(store) in a transaction; resolves when the transaction commits. */
async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    let out;
    Promise.resolve(fn(tx.objectStore(STORE))).then((v) => { out = v; }, rej);
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function encodePng(bmp) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
}

// ---- status ---------------------------------------------------------------

/** 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'off' */
let state = 'idle';
let savedVersion = -1;
let failReason = '';
const statusListeners = new Set();
export const onSaveStatus = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); };
const setState = (s) => { state = s; statusListeners.forEach((fn) => fn(s, failReason)); };
export const saveStatus = () => ({ state, reason: failReason });
/** True while the current project exists only in memory. */
export const hasUnsavedWork = () => S.frames.length > 0 && S.version !== savedVersion;

// ---- saving ---------------------------------------------------------------

const stored = new WeakMap(); // ImageBitmap -> key it is stored under
let keyN = 0;
const newKey = () => `${Date.now().toString(36)}${(keyN++).toString(36)}`;
let timer = 0, running = false, again = false, disabled = false;
let everHadFrames = false; // an empty project only wipes the saved copy once the user has actually used this session

function schedule() {
  if (disabled) return;
  clearTimeout(timer);
  if (S.frames.length) everHadFrames = true;
  else { if (everHadFrames) timer = setTimeout(saveNow, 300); return; }
  setState('pending');
  timer = setTimeout(saveNow, DEBOUNCE_MS);
}

export async function saveNow() {
  clearTimeout(timer);
  if (disabled) return;
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      await saveOnce();
    } while (again);
  } finally { running = false; }
}

async function saveOnce() {
  const version = S.version;
  const frames = S.frames.slice();
  if (!frames.length) {
    try { await withStore('readwrite', (st) => { st.clear(); }); savedVersion = version; setState('idle'); } catch (e) { fail(e); }
    return;
  }
  const snapshot = {
    v: 1, savedAt: Date.now(), W: S.W, H: S.H, bg: S.bg,
    crop: S.crop && { ...S.crop }, annos: S.annos.map((a) => ({ ...a })),
  };
  setState('saving');
  try {
    // 1. encode bitmaps that are not stored yet (each unique bitmap once)
    const fresh = [];
    for (const f of frames) {
      if (!stored.has(f.bmp) && !fresh.some((x) => x.bmp === f.bmp)) fresh.push({ bmp: f.bmp, key: newKey() });
    }
    for (const item of fresh) {
      const blob = await encodePng(item.bmp);
      await withStore('readwrite', (st) => { st.put(blob, `b:${item.key}`); });
      stored.set(item.bmp, item.key);
      await new Promise((r) => setTimeout(r)); // keep the UI responsive
    }
    // 2. the project description
    snapshot.frames = frames.map((f) => ({ k: stored.get(f.bmp), seq: f.seq, delay: f.delay }));
    const keep = new Set(snapshot.frames.map((f) => `b:${f.k}`));
    await withStore('readwrite', (st) => { st.put(snapshot, 'meta'); });
    // 3. drop bitmaps no longer used
    await withStore('readwrite', async (st) => {
      const keys = await req(st.getAllKeys());
      for (const k of keys) if (k !== 'meta' && !keep.has(k)) st.delete(k);
    });
    savedVersion = version;
    failReason = '';
    if (S.version !== version) { again = true; setState('pending'); } else setState('saved');
  } catch (e) { fail(e); }
}

function fail(e) {
  console.warn('Autosave failed:', e);
  const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)));
  failReason = quota ? 'storage full' : 'unavailable';
  if (!quota) disabled = true; // e.g. private browsing: stop trying
  setState('failed');
}

// ---- restoring --------------------------------------------------------------

/** The saved project's description, or null. Does not load any images. */
export async function peekSaved() {
  try {
    const meta = await withStore('readonly', (st) => req(st.get('meta')));
    return meta && meta.frames && meta.frames.length ? meta : null;
  } catch { return null; }
}

/** Decode a saved project. onProgress(0..1). Returns { frames, W, H, crop, annos, bg }. */
export async function loadSaved(meta, onProgress) {
  const frames = [];
  const byKey = new Map();
  try {
    for (let i = 0; i < meta.frames.length; i++) {
      const { k, seq, delay } = meta.frames[i];
      let bmp = byKey.get(k);
      if (!bmp) {
        const blob = await withStore('readonly', (st) => req(st.get(`b:${k}`)));
        if (!blob) throw new Error('A saved frame is missing');
        bmp = await createImageBitmap(blob);
        byKey.set(k, bmp);
        stored.set(bmp, k);
      }
      frames.push(restoreFrame(bmp, delay, seq));
      onProgress && onProgress((i + 1) / meta.frames.length);
    }
  } catch (e) {
    byKey.forEach((b) => b.close && b.close());
    throw e;
  }
  ensureIds(meta.annos.reduce((m, a) => Math.max(m, a.id || 0), 0));
  return { frames, W: meta.W, H: meta.H, crop: meta.crop, annos: meta.annos, bg: meta.bg };
}

export async function discardSaved() {
  try { await withStore('readwrite', (st) => { st.clear(); }); } catch { /* nothing to discard */ }
  savedVersion = -1;
}

// ---- wiring -----------------------------------------------------------------

subscribe((what) => { if (what === 'change') schedule(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state === 'pending') saveNow(); });
window.addEventListener('pagehide', () => { if (state === 'pending') saveNow(); });
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* optional */ }
