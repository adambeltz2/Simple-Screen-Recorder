// Whole-project actions: undo/redo, new, and replacing the project with loaded frames.

import { S, undo, redo, resetProject, disposeProject } from './state.js';
import { $ } from './ui.js';
import { stopPlayback } from './transport.js';
import { strip } from './timeline.js';
import { activateTab } from './panels.js';
import { clearResults } from './exportpanel.js';
import { syncAnnoPanel } from './annopanel.js';

$('btnUndo').onclick = () => { stopPlayback(); undo(); syncAnnoPanel(true); };
$('btnRedo').onclick = () => { stopPlayback(); redo(); syncAnnoPanel(true); };
$('btnNew').onclick = () => {
  if (S.frames.length && !confirm('Start over? This clears the current project.')) return;
  loadProject({ frames: [], W: 0, H: 0 });
};

export function loadProject({ frames, W, H }) {
  stopPlayback();
  clearResults();
  disposeProject();
  resetProject({ frames, W, H });
  activateTab('edit');
  strip.scrollLeft = 0;
}
