// Screen recording UI: the dialog, the status bar, pause/resume/stop, and the
// optional always-on-top Stop/Pause window (Document Picture-in-Picture).

import { Recorder, canRecord } from './ingest.js';
import { S } from './state.js';
import { $, fmtTime, fmtBytes, toast } from './ui.js';
import { stopPlayback } from './transport.js';
import { loadProject } from './project.js';

// ===========================================================================
// Recording
// ===========================================================================

let rec = null, recTimer = 0;
const recbar = $('recbar');

// ---- floating Stop / Pause window -------------------------------------------------
// Chromium's Document Picture-in-Picture gives a small always-on-top window we can
// put buttons in, so you can stop while working in another app. It has to be
// requested synchronously from a click, i.e. before the screen picker opens.

const pipSupported = () => 'documentPictureInPicture' in window;
if (pipSupported()) $('recPipRow').hidden = false;

let pip = null; // { win, time, pauseBtn, dot, flash }

function openPip() {
  if (!pipSupported() || !$('recPip').checked) return Promise.resolve(null);
  return window.documentPictureInPicture.requestWindow({ width: 300, height: 76 }).then(buildPip).catch(() => null);
}

function buildPip(win) {
  const d = win.document;
  d.title = 'Recording';
  const st = d.createElement('style');
  st.textContent = 'body{margin:0;height:100vh;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:0 12px;background:#191c25;color:#e9ebf1;font:13px system-ui,sans-serif}' +
    '.dot{width:10px;height:10px;border-radius:50%;background:#ff4d42;flex:none}.dot.paused{background:#ffa733}' +
    '#t{font:13px ui-monospace,Menlo,monospace;flex:1;white-space:nowrap}' +
    'button{font:inherit;font-weight:600;height:32px;padding:0 12px;border-radius:8px;border:1px solid #3a4050;background:#21252f;color:#e9ebf1;cursor:pointer}' +
    'button:hover{background:#2a2f3c}button.stop{color:#ff6b6b}';
  const dot = d.createElement('i'); dot.className = 'dot';
  const time = d.createElement('span'); time.id = 't'; time.textContent = '0:00';
  const pauseBtn = d.createElement('button'); pauseBtn.textContent = 'Pause'; pauseBtn.onclick = togglePause;
  const stop = d.createElement('button'); stop.className = 'stop'; stop.textContent = 'Stop'; stop.onclick = () => { if (rec) rec.stop(); };
  d.head.append(st);
  d.body.append(dot, time, pauseBtn, stop);
  const flash = (color) => { try { d.body.animate([{ background: color }, { background: '#191c25' }], { duration: 800 }); } catch { /* ignore */ } };
  const w = { win, time, pauseBtn, dot, flash };
  win.addEventListener('pagehide', () => { if (pip === w) pip = null; });
  return w;
}

function closePip() {
  if (pip) { try { pip.win.close(); } catch { /* already closed */ } pip = null; }
}

// ---- countdown ---------------------------------------------------------------------------
// The tool's own tab is usually behind the window being recorded, so the countdown is shown
// in four places: a full-page flash here, the tab title, the floating window (if open), and
// the status bar.

// Beeps: they keep playing when this tab is hidden, which the flash cannot. The audio context
// must be created or resumed inside the click that starts recording, or browsers keep it muted.
let audio = null;
function prepAudio() {
  if (!$('recBeep').checked) return;
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { audio = null; }
}
function beep(freq, secs) {
  if (!audio || !$('recBeep').checked) return;
  try {
    const t = audio.currentTime;
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + secs);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(t); osc.stop(t + secs + 0.02);
  } catch { /* sound is a nicety */ }
}

const BASE_TITLE = document.title;
const cd = $('cdOverlay');
let cdTimer = 0;
function retrigger(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

function cdTick(n) {
  clearTimeout(cdTimer);
  cd.hidden = false;
  cd.classList.remove('go');
  $('cdLabel').textContent = 'Recording starts in';
  $('cdNum').textContent = n;
  retrigger(cd, 'tick');
  retrigger($('cdNum'), 'pop');
  document.title = `${n}… ${BASE_TITLE}`;
  beep(660, 0.14);
  if (pip) { pip.time.textContent = `Starting in ${n}…`; pip.flash('#ffa733'); }
}

function cdGo() {
  clearTimeout(cdTimer);
  cd.hidden = false;
  cd.classList.remove('tick');
  $('cdLabel').textContent = 'Recording!';
  $('cdNum').textContent = '●';
  retrigger(cd, 'go');
  document.title = `● REC ${BASE_TITLE}`;
  beep(1100, 0.4);
  if (pip) pip.flash('#ff4d42');
  cdTimer = setTimeout(() => { cd.hidden = true; }, 900);
}

function cdHide() {
  clearTimeout(cdTimer);
  cd.hidden = true;
  cd.classList.remove('tick', 'go');
  document.title = BASE_TITLE;
}
$('cdCancel').onclick = () => { if (rec) rec.stop(); };

// ---- status bar ------------------------------------------------------------------------

function showRecbar(msg, running = false) {
  recbar.hidden = false;
  $('recMsg').textContent = msg;
  $('recTime').hidden = !running;
  $('recCount').hidden = !running;
  $('recPause').hidden = !running;
  recbar.classList.remove('paused');
  clearInterval(recTimer);
  if (running) {
    const upd = () => {
      if (!rec) return;
      const s = rec.stats();
      const t = fmtTime(s.elapsedMs).replace(/\.\d$/, '');
      $('recTime').textContent = t;
      $('recCount').textContent = `${s.frames} frames · ${fmtBytes(s.bytes)}`;
      if (pip) pip.time.textContent = `${t} · ${s.frames} frames`;
    };
    upd();
    recTimer = setInterval(upd, 250);
  }
}
function hideRecbar() { cdHide(); recbar.hidden = true; recbar.classList.remove('paused'); clearInterval(recTimer); closePip(); }

function syncPause() {
  const p = !!(rec && rec.paused);
  recbar.classList.toggle('paused', p);
  $('recMsg').textContent = p ? 'Paused' : 'Recording';
  $('recPause').textContent = p ? 'Resume' : 'Pause';
  if (pip) { pip.pauseBtn.textContent = p ? 'Resume' : 'Pause'; pip.dot.className = p ? 'dot paused' : 'dot'; }
}

function togglePause() {
  if (!rec || !rec.armed) return;
  if (rec.paused) rec.resume(); else rec.pause();
  syncPause();
}
$('recPause').onclick = togglePause;

function openRecDialog() {
  if (!canRecord()) return toast("Screen capture isn't available in this browser. Record with your device's screen recorder, then use Open.", true);
  if (rec) return;
  if (S.frames.length && !confirm('Recording starts a new project and replaces the current one. Continue?')) return;
  $('recDlg').showModal();
}
$('btnRecord').onclick = openRecDialog;
$('emptyRecord').onclick = openRecDialog;
$('recStop').onclick = () => { if (rec) rec.stop(); };

$('recStart').addEventListener('click', (e) => {
  e.preventDefault();
  $('recDlg').close();
  startRecording();
});

async function startRecording() {
  stopPlayback();
  prepAudio();
  const pipReady = openPip(); // must happen now, while the click still counts as a user gesture
  const r = new Recorder(
    { fps: +$('recFps').value, maxW: +$('recW').value, delay: +$('recDelay').value, skipIdentical: $('recSkip').checked },
    {
      onCountdown: (n) => { showRecbar(`Starting in ${n}…`); cdTick(n); },
      onStart: () => { showRecbar('Recording', true); cdGo(); },
      onDone: ({ frames, W, H }) => {
        rec = null;
        hideRecbar();
        loadProject({ frames, W, H });
        toast(`Captured ${frames.length} frames. Trim, crop and annotate, then export.`);
      },
      onCancel: (armed) => { rec = null; hideRecbar(); toast(armed ? 'Nothing was captured' : 'Recording cancelled'); },
      onLimit: () => toast('Memory limit reached, so recording was stopped. Lower the frame rate or width for longer clips.', true),
    },
  );
  rec = r;
  showRecbar('Waiting for you to choose a source…');
  pipReady.then((w) => {
    if (!w) return;
    if (rec !== r || r.finished) { try { w.win.close(); } catch { /* ignore */ } return; } // recording ended or was refused first
    pip = w;
    syncPause();
  });
  try {
    await r.start();
  } catch (e) {
    rec = null;
    hideRecbar();
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) toast('Screen capture was cancelled');
    else toast(`Could not start recording: ${e && e.message ? e.message : e}`, true);
  }
}
