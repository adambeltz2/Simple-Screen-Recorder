import { S, setCur, totalMs } from './state.js';
import { $, fmtTime } from './ui.js';
import { renderStage } from './stage.js';
import { renderStrip, ensureVisible } from './timeline.js';

// ===========================================================================
// Transport & playback
// ===========================================================================

const seek = $('seek');
let loopOn = true;
let rafId = 0, lastT = 0, acc = 0;

function setPlayIcon() {
  $('btnPlay').querySelector('use').setAttribute('href', S.playing ? '#i-pause' : '#i-play');
  $('btnPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
}

export function updateTransport() {
  const n = S.frames.length;
  seek.max = Math.max(0, n - 1);
  seek.value = S.cur;
  seek.disabled = !n;
  let before = 0;
  for (let i = 0; i < S.cur && i < n; i++) before += S.frames[i].delay;
  $('timeLabel').textContent = `${fmtTime(before)} / ${fmtTime(totalMs())}`;
  ['btnPrev', 'btnPlay', 'btnNext'].forEach((id) => { $(id).disabled = !n; });
  setPlayIcon();
}

export function play() {
  if (!S.frames.length || S.playing) return;
  if (S.cur >= S.frames.length - 1) { S.cur = 0; }
  S.playing = true;
  lastT = performance.now();
  acc = 0;
  rafId = requestAnimationFrame(tick);
  setPlayIcon();
}

export function stopPlayback() {
  if (!S.playing) return;
  S.playing = false;
  cancelAnimationFrame(rafId);
  setPlayIcon();
}

function tick(now) {
  if (!S.playing) return;
  const n = S.frames.length;
  if (!n) { stopPlayback(); return; }
  acc += now - lastT;
  lastT = now;
  let changed = false;
  while (S.frames[S.cur] && acc >= S.frames[S.cur].delay) {
    acc -= S.frames[S.cur].delay;
    if (S.cur >= n - 1) {
      if (loopOn) S.cur = 0; else { stopPlayback(); changed = true; break; }
    } else S.cur++;
    changed = true;
    if (acc > 5000) { acc = 0; break; }
  }
  if (changed) { renderStage(); ensureVisible(S.cur); renderStrip(); updateTransport(); }
  if (S.playing) rafId = requestAnimationFrame(tick);
}

$('btnPlay').onclick = () => (S.playing ? stopPlayback() : play());
$('btnPrev').onclick = () => { stopPlayback(); setCur(S.cur - 1); };
$('btnNext').onclick = () => { stopPlayback(); setCur(S.cur + 1); };
$('btnLoop').onclick = () => { loopOn = !loopOn; $('btnLoop').classList.toggle('on', loopOn); };
seek.addEventListener('input', () => { stopPlayback(); setCur(+seek.value); });
