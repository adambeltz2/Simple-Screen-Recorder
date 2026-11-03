// Getting frames in: screen recording, video import, animated GIF/WebP import.

import { makeFrame } from './state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => new DOMException('Cancelled', 'AbortError');

export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
export const canDecodeImages = () => typeof ImageDecoder !== 'undefined';

const MAX_RECORD_BYTES = 1.2e9; // stop before the tab runs out of memory

// ---------------------------------------------------------------------------
// Screen recording
// ---------------------------------------------------------------------------

/**
 * Records the screen as discrete frames (not a video), so every frame can be
 * edited afterwards. Frames are read straight off the capture track with
 * MediaStreamTrackProcessor where available: unlike timers or
 * requestAnimationFrame, that keeps running while this tab is in the
 * background (which it will be, you are recording something else).
 */
export class Recorder {
  /**
   * opts:  { fps, maxW, skipIdentical, delay }
   * hooks: { onCountdown(n), onStart(), onDone({frames,W,H}), onCancel(), onLimit() }
   */
  constructor(opts, hooks = {}) {
    this.opts = opts;
    this.hooks = hooks;
    this.interval = 1000 / opts.fps;
    this.running = false;
    this.armed = false;
    this.finished = false;
    this.frames = [];
    this.t0 = null;
    this.lastKeptT = null;
    this.lastSeenT = 0;
    this.W = 0; this.H = 0;
    this.prev32 = null;
    this.startedAt = 0;
    this.busy = false;
    // pausing: frames keep arriving but are dropped; `offset` removes the paused span from the timeline
    this.paused = false;
    this.lastRaw = null;     // timestamp of the latest frame seen (paused or not)
    this.pauseRaw = null;    // ...as of the moment pause() was called
    this.offset = 0;
    this.resumePending = false;
    this.pausedMs = 0;       // wall-clock time spent paused (for the on-screen timer)
    this.pauseWall = 0;
  }

  pause() {
    if (!this.armed || this.paused || this.finished) return;
    this.paused = true;
    this.pauseRaw = this.lastRaw;
    this.pauseWall = performance.now();
  }

  resume() {
    if (!this.paused || this.finished) return;
    this.paused = false;
    this.resumePending = true;
    this.pausedMs += performance.now() - this.pauseWall;
  }

  /** Resolves true once recording is armed, false if cancelled. Throws if the picker is refused. */
  async start() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: Math.max(this.opts.fps, 15), max: 60 }, cursor: 'always' },
      audio: false,
    });
    this.track = this.stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => this.stop());
    this.running = true;
    if (typeof MediaStreamTrackProcessor !== 'undefined') this._loopProcessor();
    else this._loopVideo();

    for (let n = this.opts.delay; n > 0 && this.running; n--) {
      this.hooks.onCountdown && this.hooks.onCountdown(n);
      await sleep(1000);
    }
    if (!this.running) return false;
    this.armed = true;
    this.startedAt = performance.now();
    this.hooks.onStart && this.hooks.onStart();
    return true;
  }

  stats() {
    return {
      frames: this.frames.length,
      bytes: this.frames.length * this.W * this.H * 4,
      paused: this.paused,
      elapsedMs: this.armed ? (this.paused ? this.pauseWall : performance.now()) - this.startedAt - this.pausedMs : 0,
    };
  }

  stop() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this._teardown();
    if (!this.armed || !this.frames.length) { this.hooks.onCancel && this.hooks.onCancel(this.armed); return; }
    const last = this.frames[this.frames.length - 1];
    const tail = Math.min(2000, Math.max(this.interval, this.lastSeenT - this.lastKeptT));
    this.frames[this.frames.length - 1] = { ...last, delay: Math.round(tail) };
    this.hooks.onDone && this.hooks.onDone({ frames: this.frames, W: this.W, H: this.H });
  }

  discard() {
    this.finished = true;
    this.running = false;
    this._teardown();
    this.frames.forEach((f) => f.bmp.close && f.bmp.close());
    this.frames = [];
  }

  _teardown() {
    try { this.reader && this.reader.cancel(); } catch { /* ignore */ }
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    clearInterval(this.timer);
    try { this.audio && this.audio.close(); } catch { /* ignore */ }
    if (this.video) this.video.srcObject = null;
  }

  async _loopProcessor() {
    const proc = new MediaStreamTrackProcessor({ track: this.track });
    this.reader = proc.readable.getReader();
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        try { await this._onFrame(value, value.timestamp / 1000, value.displayWidth, value.displayHeight); }
        catch (e) { console.error(e); }
        finally { value.close(); }
      }
    } catch { /* reader cancelled on stop */ }
    this.stop();
  }

  // Fallback for browsers without MediaStreamTrackProcessor (e.g. Firefox).
  async _loopVideo() {
    const v = document.createElement('video');
    this.video = v;
    v.muted = true; v.playsInline = true;
    v.srcObject = this.stream;
    await v.play();
    try { // a (silent) playing AudioContext keeps the tab from being throttled in the background
      this.audio = new AudioContext();
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
    } catch { /* optional */ }
    if ('requestVideoFrameCallback' in v) {
      const cb = async (now) => {
        if (!this.running) return;
        await this._onFrame(v, now, v.videoWidth, v.videoHeight);
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    } else {
      this.timer = setInterval(() => this._onFrame(v, performance.now(), v.videoWidth, v.videoHeight), this.interval);
    }
  }

  async _onFrame(src, tsMs, sw, sh) {
    if (!this.armed || this.finished || this.busy) return;
    this.lastRaw = tsMs;
    if (this.paused) return;
    if (this.t0 === null) this.t0 = tsMs;
    if (this.resumePending) {
      this.resumePending = false;
      if (this.pauseRaw !== null) this.offset += tsMs - this.pauseRaw; // the paused span never happened
    }
    const t = tsMs - this.t0 - this.offset;
    this.lastSeenT = t;
    if (this.lastKeptT !== null && t - this.lastKeptT < this.interval * 0.8) return; // over the fps cap
    if (!sw || !sh) return;

    if (!this.canvas) {
      const k = Math.min(1, this.opts.maxW / sw);
      this.W = Math.max(2, Math.round(sw * k));
      this.H = Math.max(2, Math.round(sh * k));
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.W; this.canvas.height = this.H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.ctx.drawImage(src, 0, 0, this.W, this.H);

    if (this.opts.skipIdentical) {
      const d = this.ctx.getImageData(0, 0, this.W, this.H).data;
      const d32 = new Uint32Array(d.buffer);
      if (this.prev32) {
        let same = true;
        for (let i = 0; i < d32.length; i++) if (d32[i] !== this.prev32[i]) { same = false; break; }
        if (same) return; // the previous frame simply lasts longer
      }
      this.prev32 = d32;
    }

    this.busy = true;
    try {
      const bmp = await createImageBitmap(this.canvas);
      if (this.finished) { bmp.close(); return; }
      if (this.frames.length) {
        const last = this.frames[this.frames.length - 1];
        this.frames[this.frames.length - 1] = { ...last, delay: Math.max(10, Math.round(t - this.lastKeptT)) };
      }
      this.frames.push(makeFrame(bmp, this.interval));
      this.lastKeptT = t;
    } finally { this.busy = false; }

    if (this.frames.length * this.W * this.H * 4 > MAX_RECORD_BYTES) {
      this.hooks.onLimit && this.hooks.onLimit();
      this.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// Video import
// ---------------------------------------------------------------------------

export async function openVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error("This browser can't play that video. MP4 (H.264) and WebM files usually work."));
  });
  if (!isFinite(video.duration)) { // some recordings have no duration header; seeking far forward reveals it
    await new Promise((res) => {
      const t = setTimeout(res, 3000);
      video.ondurationchange = () => { if (isFinite(video.duration)) { clearTimeout(t); res(); } };
      video.currentTime = 1e7;
    });
    video.ondurationchange = null;
    video.currentTime = 0;
  }
  if (!video.videoWidth) throw new Error('That file has no video track.');
  return { video, url, duration: video.duration, w: video.videoWidth, h: video.videoHeight };
}

function seekTo(v, t) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 1e-4) { res(); return; }
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, 4000); // never hang on a stubborn seek
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = t;
  });
}

/** Step through the video at a fixed frame rate by seeking, grabbing each frame. */
export async function extractVideo(video, { fps, maxW, t0, t1 }, { onProgress, signal } = {}) {
  const k = Math.min(1, maxW / video.videoWidth);
  const W = Math.max(2, Math.round(video.videoWidth * k));
  const H = Math.max(2, Math.round(video.videoHeight * k));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const step = 1 / fps;
  const count = Math.max(1, Math.floor((t1 - t0) * fps + 1e-6));
  const frames = [];
  try {
    for (let i = 0; i < count; i++) {
      if (signal && signal.aborted) throw abortError();
      await seekTo(video, Math.min(t0 + i * step, Math.max(0, video.duration - 0.04)));
      x.drawImage(video, 0, 0, W, H);
      frames.push(makeFrame(await createImageBitmap(c), step * 1000));
      onProgress && onProgress((i + 1) / count);
    }
  } catch (e) {
    frames.forEach((f) => f.bmp.close && f.bmp.close());
    throw e;
  }
  return { frames, W, H };
}

// ---------------------------------------------------------------------------
// Animated GIF / WebP import (WebCodecs ImageDecoder)
// ---------------------------------------------------------------------------

export async function decodeAnimatedImage(file, { maxW }, { onProgress, signal } = {}) {
  if (!canDecodeImages()) throw new Error("This browser can't open GIF/WebP animations. Try a video file instead.");
  const type = file.type || (/\.gif$/i.test(file.name) ? 'image/gif' : 'image/webp');
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
  await dec.tracks.ready;
  const n = dec.tracks.selectedTrack.frameCount;
  const frames = [];
  let W = 0, H = 0, c, x;
  try {
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) throw abortError();
      const { image } = await dec.decode({ frameIndex: i });
      if (!c) {
        const k = Math.min(1, maxW / image.displayWidth);
        W = Math.max(2, Math.round(image.displayWidth * k));
        H = Math.max(2, Math.round(image.displayHeight * k));
        c = document.createElement('canvas');
        c.width = W; c.height = H;
        x = c.getContext('2d');
      }
      x.clearRect(0, 0, W, H);
      x.drawImage(image, 0, 0, W, H);
      const delay = (image.duration || 100000) / 1000;
      image.close();
      frames.push(makeFrame(await createImageBitmap(c), delay));
      onProgress && onProgress((i + 1) / n);
    }
  } catch (e) {
    frames.forEach((f) => f.bmp.close && f.bmp.close());
    throw e;
  } finally { dec.close(); }
  return { frames, W, H };
}

// ---------------------------------------------------------------------------
// Fitting a second clip into an existing project
// ---------------------------------------------------------------------------

/**
 * Scale frames to fit (contain) inside W x H, letterboxed on `bg`. Used when
 * adding another clip to a project, since all frames must share one size.
 * The input frames' bitmaps are closed; new frames are returned.
 */
export async function fitFrames(frames, W, H, bg = '#000', onProgress) {
  if (frames.every((f) => f.bmp.width === W && f.bmp.height === H)) return frames;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const k = Math.min(W / f.bmp.width, H / f.bmp.height);
    const w = Math.max(1, Math.round(f.bmp.width * k)), h = Math.max(1, Math.round(f.bmp.height * k));
    x.fillStyle = bg;
    x.fillRect(0, 0, W, H);
    x.drawImage(f.bmp, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
    out.push(makeFrame(await createImageBitmap(c), f.delay));
    f.bmp.close && f.bmp.close();
    onProgress && onProgress((i + 1) / frames.length);
  }
  return out;
}
