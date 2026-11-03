// Drawing: one frame plus the annotations active on it, used for both the
// live preview and the exported pixels (so what you see is what you get).
//
// Annotation shape (all coordinates are in source-frame pixels):
//   { id, type:'text'|'arrow'|'rect'|'ring'|'blur',
//     x1,y1,x2,y2, color, width, fill, text, size, bg, block,
//     fin, fout,          <- optional fade in/out, in milliseconds
//     from, to }          <- visible on frames whose `seq` is within [from,to]

export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const annoActive = (a, f) => f.seq >= a.from && f.seq <= a.to;

const rectOf = (a) => ({
  x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2),
  w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1),
});

const measureCtx = document.createElement('canvas').getContext('2d');
const scratch = document.createElement('canvas');
const scratchCtx = scratch.getContext('2d');

// ---- fades ----------------------------------------------------------------

/**
 * Fades are measured in time, not frames, so they stay correct after frames
 * are deleted, sped up or resampled. Build this once per list of
 * { frame, delay } items (the preview's frames, or an export's resampled
 * list); `.at(i)` then gives the per-frame timing drawScene needs.
 * Returns null when no annotation fades, which keeps the common case free.
 */
export function buildTiming(items, annos) {
  if (!annos.some((a) => a.fin > 0 || a.fout > 0)) return null;
  const spans = new Map();
  const mid = new Float64Array(items.length);
  let t = 0;
  items.forEach((it, i) => {
    mid[i] = t + it.delay / 2;
    for (const a of annos) {
      if (!(a.fin > 0 || a.fout > 0) || !annoActive(a, it.frame)) continue;
      const sp = spans.get(a.id);
      if (sp) sp.t1 = t + it.delay; else spans.set(a.id, { t0: t, t1: t + it.delay });
    }
    t += it.delay;
  });
  return { at: (i) => ({ t: mid[i], spans }) };
}

function fadeAlpha(a, tm) {
  if (!tm || !(a.fin > 0 || a.fout > 0)) return 1;
  const sp = tm.spans.get(a.id);
  if (!sp) return 1;
  let k = 1;
  if (a.fin > 0) k = Math.min(k, (tm.t - sp.t0) / a.fin);
  if (a.fout > 0) k = Math.min(k, (sp.t1 - tm.t) / a.fout);
  return Math.max(0, Math.min(1, k));
}

// ---- text geometry --------------------------------------------------------

export function textBox(a) {
  measureCtx.font = `700 ${a.size}px ${FONT_STACK}`;
  const lines = String(a.text || ' ').split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, measureCtx.measureText(l || ' ').width);
  const lh = a.size * 1.25;
  const pad = a.bg ? a.size * 0.35 : 0;
  return { x: a.x1, y: a.y1, w: w + pad * 2, h: lines.length * lh + pad * 2, lines, lh, pad };
}

// ---- drawing one annotation ----------------------------------------------

function drawAnno(ctx, a, frame, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width;
  switch (a.type) {
    case 'rect': {
      const r = rectOf(a);
      if (a.fill) { ctx.globalAlpha = alpha * 0.28; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.globalAlpha = alpha; }
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'arrow': {
      const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1) break;
      const ux = dx / len, uy = dy / len;
      const hl = Math.min(len, Math.max(14, a.width * 4.5));
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2 - ux * hl * 0.8, a.y2 - uy * hl * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - ux * hl - uy * hl * 0.45, a.y2 - uy * hl + ux * hl * 0.45);
      ctx.lineTo(a.x2 - ux * hl + uy * hl * 0.45, a.y2 - uy * hl - ux * hl * 0.45);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'ring': {
      const r = Math.max(4, Math.hypot(a.x2 - a.x1, a.y2 - a.y1));
      ctx.beginPath();
      ctx.arc(a.x1, a.y1, r, 0, Math.PI * 2);
      ctx.globalAlpha = alpha * 0.2;
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.stroke();
      break;
    }
    case 'blur': { // pixelate the area underneath
      const r = rectOf(a);
      if (r.w < 2 || r.h < 2) break;
      const block = Math.max(2, a.block || 12);
      const tw = Math.max(1, Math.ceil(r.w / block)), th = Math.max(1, Math.ceil(r.h / block));
      scratch.width = tw; scratch.height = th;
      scratchCtx.imageSmoothingEnabled = true;
      scratchCtx.drawImage(frame.bmp, r.x, r.y, r.w, r.h, 0, 0, tw, th);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, tw, th, r.x, r.y, r.w, r.h);
      break;
    }
    case 'text': {
      const t = textBox(a);
      ctx.font = `700 ${a.size}px ${FONT_STACK}`;
      ctx.textBaseline = 'top';
      if (a.bg) {
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(t.x, t.y, t.w, t.h, a.size * 0.3);
        else ctx.rect(t.x, t.y, t.w, t.h);
        ctx.fill();
      }
      t.lines.forEach((line, i) => {
        const ty = t.y + t.pad + i * t.lh + (t.lh - a.size) / 2;
        if (!a.bg) { // outline keeps text readable on any background
          ctx.lineWidth = Math.max(2, a.size * 0.16);
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.strokeText(line, t.x + t.pad, ty);
        }
        ctx.fillStyle = a.color;
        ctx.fillText(line, t.x + t.pad, ty);
      });
      break;
    }
  }
  ctx.restore();
}

/**
 * Draw `frame` into ctx's top-left (dw x dh) pixels, showing source rect
 * (sx,sy,sw,sh), then the annotations active on that frame.
 */
export function drawScene(ctx, frame, view, annos, bg, tm = null) {
  const { sx, sy, sw, sh, dw, dh } = view;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bg || '#fff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame.bmp, sx, sy, sw, sh, 0, 0, dw, dh);
  const kx = dw / sw, ky = dh / sh;
  ctx.setTransform(kx, 0, 0, ky, -sx * kx, -sy * ky);
  for (const a of annos) {
    if (!annoActive(a, frame)) continue;
    const alpha = fadeAlpha(a, tm);
    if (alpha > 0.004) drawAnno(ctx, a, frame, alpha);
  }
  ctx.restore();
}

// ---- hit testing & handles (preview only) ---------------------------------

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitAnno(a, px, py, tol) {
  switch (a.type) {
    case 'rect': case 'blur': {
      const r = rectOf(a);
      return px >= r.x - tol && px <= r.x + r.w + tol && py >= r.y - tol && py <= r.y + r.h + tol;
    }
    case 'arrow':
      return distToSegment(px, py, a.x1, a.y1, a.x2, a.y2) <= Math.max(tol, a.width / 2 + tol);
    case 'ring': {
      const r = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      return Math.hypot(px - a.x1, py - a.y1) <= r + tol;
    }
    case 'text': {
      const t = textBox(a);
      return px >= t.x - tol && px <= t.x + t.w + tol && py >= t.y - tol && py <= t.y + t.h + tol;
    }
  }
  return false;
}

/** Draggable points of an annotation: id says which coordinate pair moves. */
export function annoHandles(a) {
  if (a.type === 'text') { const t = textBox(a); return [{ id: 'size', x: t.x + t.w, y: t.y + t.h }]; } // drag to resize the text
  if (a.type === 'ring') return [{ id: 'p2', x: a.x2, y: a.y2 }];
  return [{ id: 'p1', x: a.x1, y: a.y1 }, { id: 'p2', x: a.x2, y: a.y2 }];
}

export function annoBounds(a) {
  if (a.type === 'text') { const t = textBox(a); return { x: t.x, y: t.y, w: t.w, h: t.h }; }
  if (a.type === 'ring') { const r = Math.hypot(a.x2 - a.x1, a.y2 - a.y1); return { x: a.x1 - r, y: a.y1 - r, w: r * 2, h: r * 2 }; }
  if (a.type === 'arrow') return rectOf(a);
  return rectOf(a);
}

export function cropHandles(c) {
  const mx = c.x + c.w / 2, my = c.y + c.h / 2, r = c.x + c.w, b = c.y + c.h;
  return [
    { id: 'nw', x: c.x, y: c.y }, { id: 'n', x: mx, y: c.y }, { id: 'ne', x: r, y: c.y },
    { id: 'e', x: r, y: my }, { id: 'se', x: r, y: b }, { id: 's', x: mx, y: b },
    { id: 'sw', x: c.x, y: b }, { id: 'w', x: c.x, y: my },
  ];
}

/** Which crop handle (or 'move') is under the pointer? k = frame px per CSS px. */
export function hitCrop(c, px, py, k, scale = 1) {
  if (!c) return null;
  const tol = 12 * k * scale;
  for (const h of cropHandles(c)) if (Math.abs(px - h.x) <= tol && Math.abs(py - h.y) <= tol) return h.id;
  if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) return 'move';
  return null;
}

// ---- preview overlay ------------------------------------------------------

/**
 * Crop shading, crop handles and selection handles. Not part of exports.
 * off = { x, y, cropped }: when the preview shows only the cropped region,
 * (x,y) is that region's origin and the crop shading is skipped.
 */
export function drawOverlay(ctx, S, k, off = { x: 0, y: 0, cropped: false }) {
  const hs = off.hs || 1; // handle size multiplier (bigger on touch screens)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, -off.x, -off.y);
  const W = S.W, H = S.H;
  if (S.crop && !off.cropped) {
    const c = S.crop;
    ctx.fillStyle = 'rgba(8,10,14,0.62)';
    ctx.fillRect(0, 0, W, c.y);
    ctx.fillRect(0, c.y + c.h, W, H - c.y - c.h);
    ctx.fillRect(0, c.y, c.x, c.h);
    ctx.fillRect(c.x + c.w, c.y, W - c.x - c.w, c.h);
    ctx.lineWidth = 1.5 * k;
    ctx.strokeStyle = '#ffb347';
    ctx.setLineDash([6 * k, 4 * k]);
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.setLineDash([]);
    if (S.tool === 'crop') {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 * k;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(c.x + (c.w * i) / 3, c.y); ctx.lineTo(c.x + (c.w * i) / 3, c.y + c.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(c.x, c.y + (c.h * i) / 3); ctx.lineTo(c.x + c.w, c.y + (c.h * i) / 3); ctx.stroke();
      }
      for (const h of cropHandles(c)) {
        ctx.fillStyle = '#ffb347';
        ctx.strokeStyle = '#14161a';
        ctx.lineWidth = 1.5 * k;
        ctx.fillRect(h.x - 5 * k * hs, h.y - 5 * k * hs, 10 * k * hs, 10 * k * hs);
        ctx.strokeRect(h.x - 5 * k * hs, h.y - 5 * k * hs, 10 * k * hs, 10 * k * hs);
      }
    }
  }
  const a = S.annos.find((x) => x.id === S.selAnno);
  const f = S.frames[S.cur];
  if (a && f && annoActive(a, f)) {
    const b = annoBounds(a);
    ctx.strokeStyle = '#5ec8ff';
    ctx.lineWidth = 1.5 * k;
    ctx.setLineDash([5 * k, 4 * k]);
    ctx.strokeRect(b.x - 3 * k, b.y - 3 * k, b.w + 6 * k, b.h + 6 * k);
    ctx.setLineDash([]);
    for (const h of annoHandles(a)) {
      ctx.fillStyle = '#5ec8ff';
      ctx.strokeStyle = '#14161a';
      ctx.beginPath();
      ctx.arc(h.x, h.y, 6 * k * hs, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
