// Video export (MP4 / WebM) with WebCodecs. Far smaller than GIF for long
// clips. The container is written by the vendored muxers in lib/muxers/.
//
// Frames keep their individual durations (variable frame rate), so a screen
// recording that sits still for five seconds costs almost nothing.

import { drawScene, buildTiming } from './render.js';
import { cropRegion, outputDims, resampleFrames } from './exporter.js';

const abortError = () => new DOMException('Cancelled', 'AbortError');

/** Codecs to try per container, best first. `level` picks an H.264 level that fits the frame size. */
function candidates(container, w, h) {
  const px = w * h;
  const level = px <= 921600 ? '1F' : px <= 2088960 ? '28' : '33'; // 3.1, 4.0, 5.1
  if (container === 'mp4') {
    return [
      { ext: 'mp4', mime: 'video/mp4', codec: `avc1.6400${level}`, mux: 'avc', name: 'H.264' },
      { ext: 'mp4', mime: 'video/mp4', codec: `avc1.4D40${level}`, mux: 'avc', name: 'H.264' },
      { ext: 'mp4', mime: 'video/mp4', codec: `avc1.4200${level}`, mux: 'avc', name: 'H.264' },
    ];
  }
  return [
    { ext: 'webm', mime: 'video/webm', codec: 'vp09.00.10.08', mux: 'V_VP9', name: 'VP9' },
    { ext: 'webm', mime: 'video/webm', codec: 'vp8', mux: 'V_VP8', name: 'VP8' },
  ];
}

const even = (n) => Math.max(32, Math.floor(n / 2) * 2);

async function pickCodec(container, w, h, bitrate, framerate) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const c of candidates(container, w, h)) {
    try {
      const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate };
      if (c.mux === 'avc') cfg.avc = { format: 'avc' };
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) return { ...c, cfg };
    } catch { /* try the next one */ }
  }
  return null;
}

/** Which containers can this browser write? { mp4: bool, webm: bool } */
let supportP = null;
export function videoSupport() {
  if (!supportP) {
    supportP = (async () => ({
      mp4: !!(await pickCodec('mp4', 640, 360, 1e6, 30)),
      webm: !!(await pickCodec('webm', 640, 360, 1e6, 30)),
    }))().catch(() => ({ mp4: false, webm: false }));
  }
  return supportP;
}

/** Bits per pixel per frame-second for the quality choices (screen content compresses well). */
const BPP = { low: 0.05, medium: 0.1, high: 0.2 };

/**
 * X: { width, fps, bg, vid:{ format:'mp4'|'webm', quality:'low'|'medium'|'high' } }
 * target (bytes, optional): choose the bitrate so the file lands under it.
 */
export async function renderVideo(S, X, { onProgress, signal, target = 0 } = {}) {
  const t0 = performance.now();
  const region = cropRegion(S);
  const dims = outputDims(S, X.width);
  const w = even(dims.w), h = even(dims.h);
  const list = resampleFrames(S.frames, X.fps);
  if (!list.length) throw new Error('Nothing to export.');
  const totalMs = list.reduce((a, it) => a + it.delay, 0);
  const seconds = Math.max(0.1, totalMs / 1000);
  const avgFps = Math.min(60, Math.max(1, list.length / seconds));

  let bitrate = target
    ? Math.max(20000, Math.round((target * 8 * 0.9) / seconds))
    : Math.round(w * h * Math.max(avgFps, 5) * (BPP[X.vid.quality] || BPP.medium));

  const choice = await pickCodec(X.vid.format, w, h, bitrate, avgFps);
  if (!choice) throw new Error(`This browser can't encode ${X.vid.format === 'mp4' ? 'MP4 (H.264)' : 'WebM'} video.`);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const view = { sx: region.x, sy: region.y, sw: region.w, sh: region.h, dw: w, dh: h };
  const tm = buildTiming(list.map((it) => ({ frame: it.frame, delay: it.delay })), S.annos);

  // Up to two passes: when aiming at a size, a second pass corrects the bitrate if the first missed.
  let blob = null;
  for (let pass = 0; pass < (target ? 2 : 1); pass++) {
    blob = await encodePass(choice, bitrate, { canvas, ctx, view, list, tm, annos: S.annos, bg: X.bg, w, h, avgFps, signal, onProgress: (p) => onProgress && onProgress((pass + p) / (target ? 2 : 1)) });
    if (!target || blob.size <= target) break;
    bitrate = Math.max(20000, Math.round(bitrate * (target / blob.size) * 0.9));
  }
  return { blob, ms: performance.now() - t0, frames: list.length, w, h, where: 'video', ext: choice.ext, codec: choice.name, bitrate };
}

async function encodePass(choice, bitrate, { canvas, ctx, view, list, tm, annos, bg, w, h, avgFps, signal, onProgress }) {
  const mod = choice.mux === 'avc' ? await import('../lib/muxers/mp4-muxer.mjs') : await import('../lib/muxers/webm-muxer.mjs');
  const target = new mod.ArrayBufferTarget();
  const muxer = choice.mux === 'avc'
    ? new mod.Muxer({ target, video: { codec: 'avc', width: w, height: h }, fastStart: 'in-memory' })
    : new mod.Muxer({ target, video: { codec: choice.mux, width: w, height: h, frameRate: Math.round(avgFps) }, firstTimestampBehavior: 'offset' });

  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { failure = failure || e; } },
    error: (e) => { failure = failure || e; },
  });
  encoder.configure({ ...choice.cfg, bitrate, framerate: avgFps, bitrateMode: 'variable' });

  try {
    let ts = 0, lastKey = -1e9;
    for (let i = 0; i < list.length; i++) {
      if (signal && signal.aborted) throw abortError();
      if (failure) throw failure;
      const it = list[i];
      drawScene(ctx, it.frame, view, annos, bg, tm && tm.at(i));
      const dur = Math.max(1000, Math.round(it.delay * 1000)); // microseconds
      const frame = new VideoFrame(canvas, { timestamp: Math.round(ts), duration: dur });
      const key = ts - lastKey >= 2e6; // a keyframe every ~2 s so players can seek
      if (key) lastKey = ts;
      encoder.encode(frame, { keyFrame: key || i === 0 });
      frame.close();
      ts += dur;
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4)); // let the encoder catch up
      if (i % 5 === 0) { onProgress && onProgress((i + 1) / list.length); await new Promise((r) => setTimeout(r)); }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    return new Blob([target.buffer], { type: choice.mime });
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch { /* already closed */ }
  }
}
