// Frame-list operations. Each takes the current frames and returns a new
// array; frame objects are never mutated (bitmaps are shared between copies).
// lo/hi are inclusive indices.

import { uid } from './state.js';

const copy = (f) => ({ ...f, id: uid() });
const MIN_DELAY = 10;

export const del = (fr, lo, hi) => [...fr.slice(0, lo), ...fr.slice(hi + 1)];
export const keep = (fr, lo, hi) => fr.slice(lo, hi + 1);
export const duplicate = (fr, lo, hi) => [...fr.slice(0, hi + 1), ...fr.slice(lo, hi + 1).map(copy), ...fr.slice(hi + 1)];
export const reverse = (fr, lo, hi) => [...fr.slice(0, lo), ...fr.slice(lo, hi + 1).reverse(), ...fr.slice(hi + 1)];

/** Play forward, then back (without repeating the end frames) so the loop is seamless. */
export const pingPong = (fr) => (fr.length < 3 ? fr : [...fr, ...fr.slice(1, -1).reverse().map(copy)]);

export const speed = (fr, lo, hi, factor) =>
  fr.map((f, i) => (i >= lo && i <= hi ? { ...f, delay: Math.max(MIN_DELAY, Math.round(f.delay / factor)) } : f));

export const setDelay = (fr, lo, hi, ms) =>
  fr.map((f, i) => (i >= lo && i <= hi ? { ...f, delay: Math.max(MIN_DELAY, Math.round(ms)) } : f));

/** Halve the frame rate of a range. Dropped frames hand their time to the one before, so duration is unchanged. */
export function dropEveryOther(fr, lo, hi) {
  const out = [];
  fr.forEach((f, i) => {
    if (i > lo && i <= hi && (i - lo) % 2 === 1) {
      const last = out[out.length - 1];
      out[out.length - 1] = { ...last, delay: last.delay + f.delay };
    } else out.push(f);
  });
  return out;
}

/**
 * Merge runs of (nearly) identical frames into one longer frame.
 * thr = fraction of pixels allowed to differ from the last kept frame.
 */
export async function dedupe(frames, thr, onProgress) {
  if (frames.length < 2) return { frames, removed: 0 };
  const sw = frames[0].bmp.width, sh = frames[0].bmp.height;
  const k = Math.min(1, 640 / sw);
  const cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d', { willReadFrequently: true });
  const grab = (f) => { x.drawImage(f.bmp, 0, 0, cw, ch); return x.getImageData(0, 0, cw, ch).data; };

  let prev = grab(frames[0]);
  const out = [frames[0]];
  const limit = Math.floor(thr * cw * ch);
  for (let i = 1; i < frames.length; i++) {
    const d = grab(frames[i]);
    let changed = 0;
    for (let p = 0; p < d.length; p += 4) {
      const a = d[p] - prev[p], b = d[p + 1] - prev[p + 1], e = d[p + 2] - prev[p + 2];
      if (a > 3 || a < -3 || b > 3 || b < -3 || e > 3 || e < -3) { if (++changed > limit) break; }
    }
    if (changed <= limit) {
      const last = out[out.length - 1];
      out[out.length - 1] = { ...last, delay: last.delay + frames[i].delay };
    } else { out.push(frames[i]); prev = d; }
    if (i % 25 === 0) {
      if (onProgress) onProgress(i / frames.length);
      await new Promise((r) => setTimeout(r)); // let the UI breathe
    }
  }
  return { frames: out, removed: frames.length - out.length };
}
