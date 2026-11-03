// Export pipeline: render each frame (crop + resize + annotations) on the main
// thread, hand the pixels to an encoder, collect a Blob.
//
// The encoder runs in a Web Worker so the page stays responsive; if a worker
// can't be created it falls back to running on the main thread.

import { drawScene, buildTiming } from './render.js';

/** "Only store changes" presets -> per-channel tolerance (-1 = off). */
export const DIFF_TOL = { off: -1, exact: 0, light: 3, medium: 8 };

export const cropRegion = (S) => (S.crop ? { ...S.crop } : { x: 0, y: 0, w: S.W, h: S.H });

export function outputDims(S, width) {
  const r = cropRegion(S);
  const w = Math.max(8, Math.round(width || r.w));
  return { w, h: Math.max(8, Math.round((r.h * w) / r.w)) };
}

/**
 * Optionally cap the frame rate. Frames are picked on a fixed time grid and
 * each picked frame lasts until the next one, so total duration is preserved.
 */
export function resampleFrames(frames, fps) {
  if (!fps) return frames.map((f) => ({ frame: f, delay: f.delay }));
  const step = 1000 / fps;
  const picked = [];
  let t = 0, nextEmit = 0;
  for (const f of frames) {
    if (t >= nextEmit - 1e-6) {
      picked.push({ frame: f, start: t });
      nextEmit += step;
      while (nextEmit <= t) nextEmit += step;
    }
    t += f.delay;
  }
  return picked.map((p, i) => ({ frame: p.frame, delay: (i + 1 < picked.length ? picked[i + 1].start : t) - p.start }));
}

// ---- encoder transport -----------------------------------------------------

function workerEncoder() {
  const worker = new Worker(new URL('../encoder-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  let dead = null;
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.res(result); else p.rej(new Error(error));
  };
  worker.onerror = (e) => {
    dead = new Error('Encoder worker failed' + (e.message ? `: ${e.message}` : ''));
    pending.forEach((p) => p.rej(dead));
    pending.clear();
  };
  const call = (op, args, transfer = []) => {
    if (dead) return Promise.reject(dead);
    return new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      worker.postMessage({ id, op, args }, transfer);
    });
  };
  return {
    kind: 'worker',
    init: (cfg) => call('init', { cfg }),
    sample: (buf) => call('sample', { buf }, [buf]),
    palette: () => call('palette', {}),
    frame: (buf, delay) => call('frame', { buf, delay }, [buf]),
    size: () => call('size', {}),
    finish: () => call('finish', {}),
    terminate: () => worker.terminate(),
  };
}

async function localEncoder() {
  const { AnimEncoder } = await import('../lib/encoders.js');
  const e = new AnimEncoder();
  return {
    kind: 'main',
    init: (cfg) => e.init(cfg),
    sample: (buf) => e.addSample(new Uint8ClampedArray(buf)),
    palette: () => e.buildPalette(),
    frame: (buf, delay) => e.addFrame(new Uint8ClampedArray(buf), delay),
    size: () => e.size(),
    finish: () => e.finish(),
    terminate: () => {},
  };
}

async function makeEncoder(cfg) {
  if (typeof Worker !== 'undefined') {
    const w = workerEncoder();
    try { await w.init(cfg); return w; } catch (err) { console.warn('Worker unavailable, encoding on main thread:', err); w.terminate(); }
  }
  const l = await localEncoder();
  await l.init(cfg);
  return l;
}

// ---- main entry --------------------------------------------------------------

/** Thrown by renderExport when an attempt is clearly heading past its size budget. */
export class OverBudget extends Error {
  constructor(estimate) { super('Over the size budget'); this.name = 'OverBudget'; this.estimate = estimate; }
}

/**
 * X: { format:'gif'|'webp', width, fps, diff:'off'|..., loop, bg,
 *      gif:{colors,dither,palette}, webp:{quality,lossless} }
 * budget (bytes, optional): give up early, with OverBudget, once a quarter or
 * more of the frames are in and the projected size is well past the budget.
 */
export async function renderExport(S, X, { onProgress, signal, budget = 0 } = {}) {
  const t0 = performance.now();
  const region = cropRegion(S);
  const { w, h } = outputDims(S, X.width);
  const list = resampleFrames(S.frames, X.fps);
  if (!list.length) throw new Error('Nothing to export.');

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const view = { sx: region.x, sy: region.y, sw: region.w, sh: region.h, dw: w, dh: h };
  const tm = buildTiming(list.map((it) => ({ frame: it.frame, delay: it.delay })), S.annos);
  const grab = (frame, i) => {
    drawScene(ctx, frame, view, S.annos, X.bg, tm && tm.at(i));
    return ctx.getImageData(0, 0, w, h).data.buffer;
  };

  const cfg = {
    format: X.format, w, h, diff: DIFF_TOL[X.diff], loop: X.loop,
    gif: { ...X.gif }, webp: { ...X.webp },
  };
  const enc = await makeEncoder(cfg);
  const tick = () => new Promise((r) => setTimeout(r));
  const check = () => { if (signal && signal.aborted) { enc.terminate(); throw new DOMException('Cancelled', 'AbortError'); } };

  try {
    // GIF with one shared palette: build it from a spread of sample frames first.
    const needSamples = X.format === 'gif' && X.gif.palette === 'global';
    const nSamples = needSamples ? Math.min(10, list.length) : 0;
    const total = nSamples + list.length;
    let done = 0;
    for (let i = 0; i < nSamples; i++) {
      check();
      const si = Math.floor((i * list.length) / nSamples);
      await enc.sample(grab(list[si].frame, si));
      onProgress && onProgress(++done / total);
      if (enc.kind === 'main') await tick();
    }
    if (needSamples) await enc.palette();

    const inflight = [];
    for (let li = 0; li < list.length; li++) {
      const item = list[li];
      check();
      inflight.push(enc.frame(grab(item.frame, li), Math.max(10, Math.round(item.delay))));
      if (inflight.length >= 3) await inflight.shift(); // keep a few frames in flight, no more
      if (budget && li % 4 === 3 && li >= list.length * 0.25) {
        await Promise.all(inflight.splice(0));
        const so_far = await enc.size();
        const projected = (so_far * list.length) / (li + 1);
        if (projected > budget * 1.5) throw new OverBudget(projected);
      }
      onProgress && onProgress(++done / total);
      if (enc.kind === 'main') await tick();
    }
    await Promise.all(inflight);
    const blob = await enc.finish();
    return { blob, ms: performance.now() - t0, frames: list.length, w, h, where: enc.kind };
  } finally {
    enc.terminate();
  }
}

/** Can this browser encode WebP (canvas -> image/webp)? Safari can't. */
export async function webpSupported() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2);
    const blob = await new Promise((res) => c.toBlob(res, 'image/webp', 0.8));
    return !!blob && blob.type === 'image/webp';
  } catch { return false; }
}


// ---- fit under a size limit -------------------------------------------------------

const DIFF_ORDER = ['off', 'exact', 'light', 'medium'];
const atLeast = (cur, want) => (DIFF_ORDER.indexOf(cur) >= DIFF_ORDER.indexOf(want) ? cur : want);
const capFps = (cur, n) => (!cur || cur > n ? n : cur);
const capNum = (cur, n) => Math.min(cur, n);

/**
 * Settings to try, from "what you asked for" down to small and rough. Each
 * step trades a bit more quality for size: colours/quality first, then
 * frame rate and width.
 */
export function fitLadder(X) {
  const steps = [{ label: 'your settings', f: (x) => x }];
  const scaled = (x, k) => ({ ...x, width: Math.max(16, Math.round(x.width * k)) });
  if (X.format === 'gif') {
    steps.push({ label: '128 colours', f: (x) => ({ ...x, diff: atLeast(x.diff, 'light'), gif: { ...x.gif, colors: capNum(x.gif.colors, 128) } }) });
    steps.push({ label: 'stronger change detection', f: (x) => ({ ...x, diff: 'medium', gif: { ...x.gif, colors: capNum(x.gif.colors, 128), palette: 'global' } }) });
    steps.push({ label: '85% size, 15 fps', f: (x) => scaled({ ...x, fps: capFps(x.fps, 15), diff: 'medium', gif: { ...x.gif, colors: capNum(x.gif.colors, 128), palette: 'global' } }, 0.85) });
    steps.push({ label: '70% size, 12 fps, 64 colours', f: (x) => scaled({ ...x, fps: capFps(x.fps, 12), diff: 'medium', gif: { ...x.gif, colors: 64, palette: 'global' } }, 0.7) });
    steps.push({ label: '55% size, 10 fps', f: (x) => scaled({ ...x, fps: capFps(x.fps, 10), diff: 'medium', gif: { ...x.gif, colors: 64, dither: 'none', palette: 'global' } }, 0.55) });
    steps.push({ label: '40% size, 8 fps, 32 colours', f: (x) => scaled({ ...x, fps: capFps(x.fps, 8), diff: 'medium', gif: { ...x.gif, colors: 32, dither: 'none', palette: 'global' } }, 0.4) });
    steps.push({ label: '30% size, 6 fps, 16 colours', f: (x) => scaled({ ...x, fps: capFps(x.fps, 6), diff: 'medium', gif: { ...x.gif, colors: 16, dither: 'none', palette: 'global' } }, 0.3) });
  } else {
    const q = (x, n) => ({ ...x.webp, lossless: false, quality: Math.min(x.webp.lossless ? 100 : x.webp.quality, n) });
    steps.push({ label: 'quality 70', f: (x) => ({ ...x, diff: atLeast(x.diff, 'light'), webp: q(x, 70) }) });
    steps.push({ label: 'quality 55', f: (x) => ({ ...x, diff: 'medium', webp: q(x, 55) }) });
    steps.push({ label: '85% size, 15 fps, quality 50', f: (x) => scaled({ ...x, fps: capFps(x.fps, 15), diff: 'medium', webp: q(x, 50) }, 0.85) });
    steps.push({ label: '70% size, 12 fps, quality 40', f: (x) => scaled({ ...x, fps: capFps(x.fps, 12), diff: 'medium', webp: q(x, 40) }, 0.7) });
    steps.push({ label: '55% size, 10 fps, quality 35', f: (x) => scaled({ ...x, fps: capFps(x.fps, 10), diff: 'medium', webp: q(x, 35) }, 0.55) });
    steps.push({ label: '40% size, 8 fps, quality 30', f: (x) => scaled({ ...x, fps: capFps(x.fps, 8), diff: 'medium', webp: q(x, 30) }, 0.4) });
  }
  return steps.map((st) => ({ label: st.label, X: st.f(X) }));
}

/**
 * Try progressively smaller settings until the file fits `target` bytes.
 * onAttempt({ i, n, label }) is called before each try. If nothing fits, the
 * smallest finished result is returned with fit.reached = false.
 */
export async function renderFit(S, X, target, { onProgress, onAttempt, signal } = {}) {
  const ladder = fitLadder(X);
  let best = null;
  for (let i = 0; i < ladder.length; i++) {
    const last = i === ladder.length - 1;
    onAttempt && onAttempt({ i, n: ladder.length, label: ladder[i].label });
    try {
      const r = await renderExport(S, ladder[i].X, { onProgress, signal, budget: last && !best ? 0 : target });
      const fit = { target, attempt: i + 1, attempts: ladder.length, label: ladder[i].label, reached: r.blob.size <= target };
      if (fit.reached) return { ...r, fit };
      if (!best || r.blob.size < best.blob.size) best = { ...r, fit };
    } catch (e) {
      if (!(e instanceof OverBudget)) throw e;
    }
  }
  if (best) return best;
  throw new Error('Could not produce a result');
}
