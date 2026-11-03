// Export pipeline: render each frame (crop + resize + annotations) on the main
// thread, hand the pixels to an encoder, collect a Blob.
//
// The encoder runs in a Web Worker so the page stays responsive; if a worker
// can't be created it falls back to running on the main thread.

import { drawScene } from './render.js';

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

/**
 * X: { format:'gif'|'webp', width, fps, diff:'off'|..., loop, bg,
 *      gif:{colors,dither,palette}, webp:{quality,lossless} }
 */
export async function renderExport(S, X, { onProgress, signal } = {}) {
  const t0 = performance.now();
  const region = cropRegion(S);
  const { w, h } = outputDims(S, X.width);
  const list = resampleFrames(S.frames, X.fps);
  if (!list.length) throw new Error('Nothing to export.');

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const view = { sx: region.x, sy: region.y, sw: region.w, sh: region.h, dw: w, dh: h };
  const grab = (frame) => {
    drawScene(ctx, frame, view, S.annos, X.bg);
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
      await enc.sample(grab(list[Math.floor((i * list.length) / nSamples)].frame));
      onProgress && onProgress(++done / total);
      if (enc.kind === 'main') await tick();
    }
    if (needSamples) await enc.palette();

    const inflight = [];
    for (const item of list) {
      check();
      inflight.push(enc.frame(grab(item.frame), Math.max(10, Math.round(item.delay))));
      if (inflight.length >= 3) await inflight.shift(); // keep a few frames in flight, no more
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
