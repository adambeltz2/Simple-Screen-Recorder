// Animation encoders (GIF + animated WebP). Runs in a Web Worker, or directly
// on the main thread as a fallback; it only needs OffscreenCanvas for WebP.
//
// Both formats share the same "changed region" idea: remember what each pixel
// last looked like, and for every new frame only store the bounding box of
// pixels that actually changed. For screen recordings (mostly static) that is
// where almost all the size savings come from.

import { GIFEncoder, quantize } from './gifenc/index.js';
import { extractFrameChunks, buildAnimatedWebP } from './webpmux.js';

// ---- palette mapping ------------------------------------------------------

function flattenPalette(pal) {
  const flat = new Uint8Array(pal.length * 3);
  pal.forEach((c, i) => { flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2]; });
  return flat;
}

function nearest(flat, n, r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dr = r - flat[i * 3], dg = g - flat[i * 3 + 1], db = b - flat[i * 3 + 2];
    const d = dr * dr * 2 + dg * dg * 4 + db * db * 3; // rough perceptual weighting
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Map RGBA pixels to palette indices, optionally with serpentine
 * Floyd-Steinberg error diffusion (amount 0..1). `lut` caches nearest-colour
 * lookups on a 15-bit colour key so we don't scan the palette per pixel.
 */
function mapToPalette(rgba, w, h, flat, n, lut, amount) {
  const out = new Uint8Array(w * h);
  if (amount <= 0) {
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let idx = lut[key];
      if (idx < 0) idx = lut[key] = nearest(flat, n, r, g, b);
      out[i] = idx;
    }
    return out;
  }
  let cur = new Float32Array((w + 2) * 3);
  let nxt = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    const ltr = (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    nxt.fill(0);
    for (let i = 0; i < w; i++) {
      const x = ltr ? i : w - 1 - i;
      const p = (y * w + x) * 4;
      const e = (x + 1) * 3;
      let r = rgba[p] + cur[e], g = rgba[p + 1] + cur[e + 1], b = rgba[p + 2] + cur[e + 2];
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      const ri = r | 0, gi = g | 0, bi = b | 0;
      const key = ((ri >> 3) << 10) | ((gi >> 3) << 5) | (bi >> 3);
      let idx = lut[key];
      if (idx < 0) idx = lut[key] = nearest(flat, n, ri, gi, bi);
      out[y * w + x] = idx;
      const er = (r - flat[idx * 3]) * amount;
      const eg = (g - flat[idx * 3 + 1]) * amount;
      const eb = (b - flat[idx * 3 + 2]) * amount;
      const a = (x + 1 + dir) * 3, bl = (x + 1 - dir) * 3, bm = (x + 1) * 3;
      cur[a] += er * 0.4375; cur[a + 1] += eg * 0.4375; cur[a + 2] += eb * 0.4375;   // 7/16
      nxt[bl] += er * 0.1875; nxt[bl + 1] += eg * 0.1875; nxt[bl + 2] += eb * 0.1875; // 3/16
      nxt[bm] += er * 0.3125; nxt[bm + 1] += eg * 0.3125; nxt[bm + 2] += eb * 0.3125; // 5/16
      nxt[a] += er * 0.0625; nxt[a + 1] += eg * 0.0625; nxt[a + 2] += eb * 0.0625;    // 1/16
    }
    const t = cur; cur = nxt; nxt = t;
  }
  return out;
}

function extractRegion(rgba, w, r) {
  if (r.x === 0 && r.w === w && r.y === 0 && rgba.length === r.w * r.h * 4) return rgba;
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * w + r.x) * 4;
    out.set(rgba.subarray(s, s + r.w * 4), y * r.w * 4);
  }
  return out;
}

async function webpBlob(rgba, w, h, quality) {
  const img = new ImageData(rgba, w, h);
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(w, h);
    oc.getContext('2d').putImageData(img, 0, 0);
    return oc.convertToBlob({ type: 'image/webp', quality });
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(img, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/webp', quality));
}

// ---- encoder --------------------------------------------------------------

/**
 * cfg: { format:'gif'|'webp', w, h,
 *        diff: -1 (off) or per-channel tolerance 0..n,
 *        loop: 0 = forever,
 *        gif:  { colors, dither:'none'|'light'|'full', palette:'global'|'local' },
 *        webp: { quality 0-100, lossless } }
 * Usage: init -> [addSample* -> buildPalette] (gif/global) -> addFrame* -> finish
 */
export class AnimEncoder {
  async init(cfg) {
    this.cfg = cfg;
    this.w = cfg.w; this.h = cfg.h;
    this.ref = null;        // what each pixel last looked like (source RGBA)
    this.pending = null;    // gif frame held back so unchanged frames can extend it
    this.frames = [];       // webp frames
    this.samples = [];
    this.palColors = null;
    this.cumMs = 0; this.emittedCs = 0; // gif delay rounding with carry
    this.count = 0;
    if (cfg.format === 'gif') this.gif = GIFEncoder({ auto: true, initialCapacity: 1 << 20 });
  }

  // -- shared change detection
  _diff(rgba, tol, align) {
    const { w, h, ref } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      let p = y * w * 4, rowMin = -1, rowMax = -1;
      for (let x = 0; x < w; x++, p += 4) {
        let d = rgba[p] - ref[p]; if (d < 0) d = -d;
        let e = rgba[p + 1] - ref[p + 1]; if (e < 0) e = -e;
        let f = rgba[p + 2] - ref[p + 2]; if (f < 0) f = -f;
        if (d > tol || e > tol || f > tol) { if (rowMin < 0) rowMin = x; rowMax = x; }
      }
      if (rowMax >= 0) {
        if (y < minY) minY = y;
        maxY = y;
        if (rowMin < minX) minX = rowMin;
        if (rowMax > maxX) maxX = rowMax;
      }
    }
    if (maxX < 0) return null;
    if (align) { minX &= ~1; minY &= ~1; } // WebP frame offsets must be even
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // -- gif palette
  addSample(rgba) { this.samples.push(rgba); }

  async buildPalette() {
    const g = this.cfg.gif;
    const useDiff = this.cfg.diff >= 0;
    const maxColors = Math.max(2, Math.min(256, g.colors)) - (useDiff ? 1 : 0);
    let src = this.samples;
    this.samples = [];
    if (!src.length) return;
    // Cap the number of pixels fed to the quantiser so it stays fast.
    const totalPx = src.reduce((a, s) => a + s.length / 4, 0);
    const step = Math.max(1, Math.ceil(totalPx / 250000));
    const buf = new Uint8Array(Math.ceil(totalPx / step) * 4 + 4);
    let o = 0;
    for (const s of src) {
      for (let i = 0; i < s.length; i += 4 * step) {
        buf[o++] = s[i]; buf[o++] = s[i + 1]; buf[o++] = s[i + 2]; buf[o++] = 255;
      }
    }
    this._setPalette(quantize(buf.subarray(0, o), maxColors, { format: 'rgb565' }));
  }

  _setPalette(colors) {
    this.palColors = colors.map((c) => [c[0], c[1], c[2]]);
    this.flat = flattenPalette(this.palColors);
    this.lut = new Int16Array(32768).fill(-1);
  }

  async addFrame(rgba, delayMs) {
    this.count++;
    if (this.cfg.format === 'gif') return this._gifFrame(rgba, delayMs);
    return this._webpFrame(rgba, delayMs);
  }

  // -- GIF
  _flushGif() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    // GIF delays are whole centiseconds; carry the rounding error forward so
    // total duration stays right, and never go below 2cs (browsers treat
    // anything faster as 10 fps).
    this.cumMs += p.delayMs;
    let cs = Math.round(this.cumMs / 10) - this.emittedCs;
    if (cs < 2) cs = 2;
    this.emittedCs += cs;
    const loop = this.cfg.loop; // 0 = forever, 1 = play once, n = n plays
    this.gif.writeFrame(p.index, p.w, p.h, {
      // First frame's palette becomes the global table; later frames only
      // carry their own table in per-frame-palette mode.
      palette: p.first || p.local ? p.palette : null,
      delay: cs * 10, // gifenc divides by 10 itself
      transparent: p.transparent,
      transparentIndex: p.tIndex,
      dispose: p.transparent ? 1 : -1,
      repeat: loop === 0 ? 0 : loop === 1 ? -1 : loop - 1,
      colorDepth: p.depth,
      left: p.x, top: p.y,
    });
  }

  _gifFrame(rgba, delayMs) {
    const { w, h, cfg } = this;
    const g = cfg.gif;
    const useDiff = cfg.diff >= 0;
    const amount = g.dither === 'full' ? 1 : g.dither === 'light' ? 0.55 : 0;

    let region = { x: 0, y: 0, w, h };
    const isFirst = this.count === 1;
    const local = g.palette === 'local';
    if (useDiff) {
      if (!this.ref) this.ref = new Uint8ClampedArray(rgba);
      else {
        region = this._diff(rgba, cfg.diff, false);
        if (!region) { if (this.pending) this.pending.delayMs += delayMs; return; } // nothing changed
      }
    }

    const pix = extractRegion(rgba, w, region);
    if (local || !this.palColors) { // (global mode without samples falls back to the first frame)
      const maxColors = Math.max(2, Math.min(256, g.colors)) - (useDiff ? 1 : 0);
      this._setPalette(quantize(pix, maxColors, { format: 'rgb565' }));
    }
    const n = this.palColors.length;
    const idx = mapToPalette(pix, region.w, region.h, this.flat, n, this.lut, amount);

    let transparent = false;
    const tIndex = n; // one spare slot appended after the real colours
    if (useDiff && !isFirst) {
      // Pixels inside the box that did not really change stay transparent,
      // so they keep whatever was drawn there before.
      const { ref } = this;
      for (let y = 0; y < region.h; y++) {
        let sp = ((region.y + y) * w + region.x) * 4;
        for (let x = 0; x < region.w; x++, sp += 4) {
          const t = cfg.diff;
          let d = rgba[sp] - ref[sp]; if (d < 0) d = -d;
          let e = rgba[sp + 1] - ref[sp + 1]; if (e < 0) e = -e;
          let f = rgba[sp + 2] - ref[sp + 2]; if (f < 0) f = -f;
          if (d > t || e > t || f > t) {
            ref[sp] = rgba[sp]; ref[sp + 1] = rgba[sp + 1]; ref[sp + 2] = rgba[sp + 2]; ref[sp + 3] = rgba[sp + 3];
          } else { idx[y * region.w + x] = tIndex; transparent = true; }
        }
      }
    }

    this._flushGif();
    const palette = useDiff ? this.palColors.concat([[0, 0, 0]]) : this.palColors;
    this.pending = {
      index: idx, w: region.w, h: region.h, x: region.x, y: region.y,
      palette, first: isFirst, local, transparent, tIndex, delayMs,
      depth: Math.max(2, Math.ceil(Math.log2(palette.length))),
    };
  }

  // -- WebP
  async _webpFrame(rgba, delayMs) {
    const { w, h, cfg } = this;
    const useDiff = cfg.diff >= 0;
    let region = { x: 0, y: 0, w, h };
    if (useDiff) {
      if (!this.ref) this.ref = new Uint8ClampedArray(rgba);
      else {
        region = this._diff(rgba, cfg.diff, true);
        if (!region) { this.frames[this.frames.length - 1].duration += delayMs; return; }
        for (let y = 0; y < region.h; y++) { // the whole box gets overwritten, so refresh it all
          const s = ((region.y + y) * w + region.x) * 4;
          this.ref.set(rgba.subarray(s, s + region.w * 4), s);
        }
      }
    }
    const pix = extractRegion(rgba, w, region);
    const q = cfg.webp.lossless ? 1 : Math.min(0.99, Math.max(0.01, cfg.webp.quality / 100));
    const blob = await webpBlob(pix, region.w, region.h, q);
    if (!blob || blob.type !== 'image/webp') throw new Error("This browser can't encode WebP");
    const { chunks, hasAlpha } = extractFrameChunks(await blob.arrayBuffer());
    if (hasAlpha) this.hasAlpha = true;
    this.frames.push({ ...region, duration: delayMs, chunks });
  }

  /** Bytes written so far (a lower bound: a held-back GIF frame is not counted yet). */
  size() {
    if (this.cfg.format === 'gif') return this.gif.bytesView().length;
    return this.frames.reduce((a, f) => a + f.chunks.byteLength, 0);
  }

  async finish() {
    if (this.cfg.format === 'gif') {
      this._flushGif();
      this.gif.finish();
      return new Blob([this.gif.bytes()], { type: 'image/gif' });
    }
    const bytes = buildAnimatedWebP({
      width: this.w, height: this.h, loopCount: this.cfg.loop,
      frames: this.frames, hasAlpha: !!this.hasAlpha,
    });
    return new Blob([bytes], { type: 'image/webp' });
  }
}
