// Minimal animated-WebP muxer.
//
// Browsers can encode single WebP images (canvas.toBlob / convertToBlob) but
// not animations. An animated WebP is just a RIFF container holding one ANMF
// chunk per frame, and each ANMF chunk wraps the same VP8/VP8L bitstream that
// a still WebP contains. So: encode each frame as a still, lift out its
// bitstream chunks, and re-wrap them. Spec:
// https://developers.google.com/speed/webp/docs/riff_container

const ascii = (u8, a, b) => String.fromCharCode(...u8.subarray(a, b));
const readU32 = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;

function u24(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255]; }
function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Build one RIFF chunk: fourcc + size + payload + pad byte to even length. */
function chunk(fourcc, payload) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i);
  out.set(u32(payload.length), 4);
  out.set(payload, 8);
  return out;
}

/**
 * Pull the image-bitstream chunks (ALPH, VP8, VP8L) out of a still WebP file.
 * Returns them already framed (header + padding), ready to sit inside an ANMF.
 */
export function extractFrameChunks(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 20 || ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 12) !== 'WEBP') {
    throw new Error('Encoder did not return a WebP image');
  }
  const parts = [];
  let hasAlpha = false;
  let kind = null;
  let off = 12;
  while (off + 8 <= u8.length) {
    const fourcc = ascii(u8, off, off + 4);
    const size = readU32(u8, off + 4);
    const data = u8.subarray(off + 8, Math.min(off + 8 + size, u8.length));
    if (fourcc === 'ALPH') { parts.push(chunk('ALPH', data)); hasAlpha = true; }
    else if (fourcc === 'VP8 ' || fourcc === 'VP8L') { parts.push(chunk(fourcc, data)); kind = fourcc; }
    else if (fourcc === 'VP8X') { if (data[0] & 0x10) hasAlpha = true; }
    off += 8 + size + (size & 1);
  }
  if (!kind) throw new Error('No image data found in WebP frame');
  return { chunks: concat(parts), hasAlpha, kind };
}

/**
 * Assemble an animated WebP.
 * frames: [{ x, y, w, h, duration, chunks }]  (x/y are snapped down to even numbers)
 * Frames are written with blend=off, dispose=none, so each one simply
 * overwrites its rectangle on the canvas. That is what lets us store only the
 * region that changed.
 */
export function buildAnimatedWebP({ width, height, loopCount = 0, frames, hasAlpha = false }) {
  const flags = 0x02 | (hasAlpha ? 0x10 : 0); // animation (+ alpha)
  const vp8x = chunk('VP8X', new Uint8Array([flags, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]));
  // Background colour is [B,G,R,A]; viewers generally ignore it. Loop 0 = forever.
  const anim = chunk('ANIM', new Uint8Array([255, 255, 255, 255, loopCount & 255, (loopCount >> 8) & 255]));

  const anmf = frames.map((f) => {
    const head = new Uint8Array([
      ...u24(f.x >> 1), ...u24(f.y >> 1),
      ...u24(f.w - 1), ...u24(f.h - 1),
      ...u24(Math.max(1, Math.round(f.duration))),
      0b10, // reserved(6) | blend: do-not-blend(1) | dispose: none(0)
    ]);
    return chunk('ANMF', concat([head, f.chunks]));
  });

  const body = concat([vp8x, anim, ...anmf]);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  out.set(u32(4 + body.length), 4);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set(body, 12);
  return out;
}
