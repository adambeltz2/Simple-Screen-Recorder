// Screen recording UI: the dialog, the floating status bar, start/stop.

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

function showRecbar(msg, running = false) {
  recbar.hidden = false;
  $('recMsg').textContent = msg;
  $('recTime').hidden = !running;
  $('recCount').hidden = !running;
  clearInterval(recTimer);
  if (running) {
    const upd = () => {
      if (!rec) return;
      const s = rec.stats();
      $('recTime').textContent = fmtTime(s.elapsedMs).replace(/\.\d$/, '');
      $('recCount').textContent = `${s.frames} frames · ${fmtBytes(s.bytes)}`;
    };
    upd();
    recTimer = setInterval(upd, 250);
  }
}
function hideRecbar() { recbar.hidden = true; clearInterval(recTimer); }

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
  const r = new Recorder(
    { fps: +$('recFps').value, maxW: +$('recW').value, delay: +$('recDelay').value, skipIdentical: $('recSkip').checked },
    {
      onCountdown: (n) => showRecbar(`Starting in ${n}…`),
      onStart: () => showRecbar('Recording', true),
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
  try {
    await r.start();
  } catch (e) {
    rec = null;
    hideRecbar();
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) toast('Screen capture was cancelled');
    else toast(`Could not start recording: ${e && e.message ? e.message : e}`, true);
  }
}
