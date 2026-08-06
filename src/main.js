import { Machine } from './interpreter.js';
import { Clock } from './clock.js';
import { MidiOut } from './midi.js';
import { ensureSynth, playSynthNote } from './synthout.js';
import {
  evalVisuals, visualsTick, setVisualsDeps, setBypassed, isBypassed,
  visualsActive, DEFAULT_VISUALS_DOC,
} from './visuals.js';
import { GridUI } from './ui.js';
import { MountEditor } from './editor.js';
import { MountTable, tryEvaluate, DEFAULT_MOUNT_DOC } from './mounts.js';
import { gridToRows, rowsToGrid, cellsToGrid, textualizeSlots, looksLikePatch } from './patchfile.js';
import { describeAt } from './ports.js';
import { DEMO } from './demo.js';
import { charToCell } from './values.js';

const GRID_W = 64;
const GRID_H = 32;
const MAX_W = 128;
const MAX_H = 128; // raised from 64 (2026-08-05): CLAVIER ports arrive up to 48x96
const STORAGE_KEY = 'griddle-state-v1';

// patterns live in the mount document ($ mounts); the legacy slot-panel
// adapter is gone — old patches migrate by textualization at load
const machine = new Machine(GRID_W, GRID_H, null);
const midi = new MidiOut();

// ---- dom ----
const $ = (id) => document.getElementById(id);
const canvas = $('grid');
const playBtn = $('play');
const bpmInput = $('bpm');
const midiSelect = $('midi-out');
const statusLine = $('status');
const panicBtn = $('panic');
const demoBtn = $('demo');
const clearBtn = $('clear');
const gridWInput = $('grid-w');
const gridHInput = $('grid-h');
const savePatchBtn = $('save-patch');
const loadPatchInput = $('load-patch');

const ui = new GridUI(canvas, machine, { onEdit: saveState });

// ---- mount document (docs six/seven; LFO-only until doc seven phase 3) ----
const mountPane = $('mount-pane');
const mountBar = $('mount-bar');
let mounts = new MountTable();
let lastEvalSource = null; // what the current mount table was built from
let lastEvalError = null;

// the one path through which mount source becomes a mount table — keeps the
// dirty indicator truthful everywhere (⌘↵, defaults button, patch load, boot)
function evalMountSource(source, { flash = false } = {}) {
  const result = tryEvaluate(source, mounts);
  mounts = result.table;
  machine.mounts = mounts;
  lastEvalSource = source;
  lastEvalError = result.error;
  // patch-as-code initializers: bpm()/grid() statements apply on eval;
  // the widgets remain live nudgers between evals
  if (!result.error) {
    if (mounts.bpm !== null) bpmInput.value = mounts.bpm;
    // tick-grain indicator: visible only when a patch redeclares the beat
    $('tpb-ind').textContent = mounts.ticksPerBeat !== 4 ? `×${mounts.ticksPerBeat}t` : '';
    if (mounts.gridSize) {
      const { w, h } = mounts.gridSize;
      if (w !== machine.width || h !== machine.height) {
        machine.resize(w, h);
        gridWInput.value = w;
        gridHInput.value = h;
        ui.clampCamera();
      }
    }
  }
  if (flash) mountEditor.flash();
  renderMountBar();
}

const mountEditor = new MountEditor($('mount-editor'), {
  onEval: (source) => {
    evalMountSource(source, { flash: true });
    saveState();
  },
  onChange: () => renderMountBar(),
  onExit: () => canvas.focus(),
});

const visualsEditor = new MountEditor($('visuals-editor'), {
  onEval: (source) => {
    evalVisualsSource(source);
    saveState();
  },
  onExit: () => canvas.focus(),
});
visualsEditor.setSource(DEFAULT_VISUALS_DOC);

// visuals eval contract (doc ten §4): flash on success, keep-last-good +
// surfaced error on failure. Async: the first eval loads the hydra chunk.
function evalVisualsSource(source) {
  evalVisuals(source)
    .then(({ active }) => {
      visualsEditor.flash();
      if (active) statusLine.textContent = 'visuals mounted';
    })
    .catch((e) => {
      statusLine.textContent = `visuals: ${e.message || e}`;
    });
}

$('visuals-bypass').addEventListener('click', () => {
  setBypassed(!isBypassed());
  $('visuals-bypass').classList.toggle('active', isBypassed());
  canvas.focus();
});

function renderMountBar() {
  const dirty = lastEvalSource !== null && mountEditor.getSource() !== lastEvalSource;
  mountPane.classList.toggle('dirty', dirty);
  const dirtyPrefix = dirty ? `<span class="dirty">● edited — ⌘↵ to mount</span> · ` : '';
  if (lastEvalError) {
    console.error('[griddle mount]', lastEvalError); // copyable from devtools too
    mountBar.innerHTML = `${dirtyPrefix}<span class="err">✗ ${lastEvalError.replace(/</g, '&lt;')}</span>`;
    return;
  }
  const refs = [...mounts.entries.keys()];
  const ats = refs.filter((r) => r[0] === '@').length;
  const dollars = refs.filter((r) => r[0] === '$').length;
  const devs = Object.keys(mounts.deviceMap).length;
  mountBar.innerHTML = refs.length
    ? `${dirtyPrefix}<span class="ok">✓ mounted</span> · ${ats} @lfo · ${dollars} $pattern` +
      (devs ? ` · ${devs} device${devs > 1 ? 's' : ''}` : '')
    : `${dirtyPrefix}mounts: none — ⌘↵ to evaluate`;
}

$('mount-defaults').addEventListener('click', () => {
  // replace the whole document with the canonical defaults and evaluate —
  // the recovery path when pasted/stale content won't parse
  mountEditor.setSource(DEFAULT_MOUNT_DOC);
  evalMountSource(DEFAULT_MOUNT_DOC, { flash: true });
  saveState();
  mountEditor.focus();
});

function toggleMountPane(show) {
  const hidden = mountPane.classList.contains('hidden');
  const next = show ?? hidden;
  mountPane.classList.toggle('hidden', !next);
  const btn = $('pane-toggle');
  btn.textContent = next ? '◨ code' : '◧ code';
  btn.classList.toggle('active', next);
  ui.resizeCanvas();
  if (next) mountEditor.focus();
  else canvas.focus();
}

$('pane-toggle').addEventListener('click', () => toggleMountPane());

// ---- transport ----
let playing = false;
const clock = new Clock({
  getBpm: () => Number(bpmInput.value) || 120,
  getTpb: () => mounts.ticksPerBeat || 4,
  onTick: (tick, timeMs) => {
    machine.step();
    const tickMs = clock.tickMs();
    // device routing (doc nine): a device whose mount is a synth definition
    // renders in-process via superdough; anything else goes to MIDI as before
    const routeNote = (e, at, durMs) => {
      const def = mounts.synthDef(e.device ?? 0, e.channel ?? 0);
      if (def) {
        playSynthNote(def, e, at, durMs);
        return;
      }
      midi.noteOn(e.channel, e.note, e.velocity, at);
      midi.noteOff(e.channel, e.note, at + durMs);
    };
    for (const e of machine.scanMidi()) {
      if (e.type === 'note') {
        routeNote(e, timeMs, Math.max(e.holdTicks, 0.25) * tickMs);
      } else if (e.type === 'cc') {
        midi.cc(e.channel, e.controller, e.value, timeMs);
      }
    }
    // mounted U/V MIDI faces: notes at true fractional times, durations
    // from hap whole spans
    for (const e of machine.noteEvents) {
      routeNote(e, timeMs + e.frac * tickMs, Math.max(e.durTicks * tickMs, 15));
    }
    // F/G smooth-CC crossings: sub-tick timestamps, thinned to >=5ms per
    // stream (always keeping each stream's final value of the tick)
    const MIN_CC_MS = 5;
    const lastSent = new Map();
    const finalIdx = new Map();
    machine.ccEvents.forEach((e, i) => finalIdx.set(`${e.device}:${e.channel}:${e.controller}`, i));
    machine.ccEvents.forEach((e, i) => {
      const key = `${e.device}:${e.channel}:${e.controller}`;
      const at = timeMs + e.frac * tickMs;
      const prev = lastSent.get(key);
      if (prev !== undefined && at - prev < MIN_CC_MS && finalIdx.get(key) !== i) return;
      lastSent.set(key, at);
      midi.cc(e.channel, e.controller, e.value7, at);
    });
  },
});

// visuals accessors read machine state per frame (doc ten §5); tickFrac
// interpolates within the current tick from the clock's own schedule so
// beat()/bar() are smooth rather than steppy
setVisualsDeps({
  getMachine: () => machine,
  getMounts: () => mounts,
  getTpb: () => mounts.ticksPerBeat || 4,
  gridCanvas: canvas,
  tickFrac: () => {
    if (!playing) return 0;
    const remaining = (clock.nextTickTime - performance.now()) / clock.tickMs();
    return Math.max(0, Math.min(1, 1 - remaining));
  },
});

function setPlaying(next) {
  playing = next;
  playBtn.textContent = playing ? '■ stop' : '▶ play';
  if (playing) {
    machine.reset();
    // load the synth engine inside the user gesture so the AudioContext may
    // start; notes that arrive before it settles are dropped, not mistimed
    if (mounts.hasSynthDefs()) {
      ensureSynth().catch((e) => (statusLine.textContent = `synth engine failed: ${e.message}`));
    }
    clock.start();
  } else {
    clock.stop();
    midi.allNotesOff();
  }
}

playBtn.addEventListener('click', () => setPlaying(!playing));
panicBtn.addEventListener('click', () => midi.allNotesOff());

document.addEventListener('keydown', (e) => {
  // ⌘E toggles the mount editor from anywhere; ⌘. = panic everywhere
  if (e.key === 'e' && (e.metaKey || e.ctrlKey)) {
    toggleMountPane();
    e.preventDefault();
    return;
  }
  if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
    midi.allNotesOff();
    e.preventDefault();
    return;
  }
  // any focused form control owns the keyboard; the grid only listens
  // when focus is on the canvas/body. The CM6 editor is a contenteditable
  // div, so check for it explicitly (its own keymap consumes ⌘↵/Escape).
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.target.closest?.('.cm-editor')) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    setPlaying(!playing);
    e.preventDefault();
    return;
  }
  ui.handleKey(e);
});

// ---- midi devices ----
async function initMidi() {
  const ok = await midi.init();
  refreshMidiOutputs();
  if (!ok) {
    statusLine.textContent = `${midi.error} — synth devices (device z) still play`;
  }
  midi.onDevicesChanged = refreshMidiOutputs;
}

function refreshMidiOutputs() {
  const outputs = midi.outputs();
  midiSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = outputs.length ? '— select MIDI output —' : 'no MIDI outputs found';
  midiSelect.appendChild(none);
  for (const out of outputs) {
    const opt = document.createElement('option');
    opt.value = out.id;
    opt.textContent = out.name;
    midiSelect.appendChild(opt);
  }
  if (midi.output) midiSelect.value = midi.output.id;
  // port list with copy-name buttons: authoring support for devices()
  const portsEl = $('midi-ports');
  portsEl.innerHTML = '';
  for (const out of outputs) {
    const span = document.createElement('span');
    span.className = 'port';
    span.textContent = out.name;
    const btn = document.createElement('button');
    btn.textContent = 'copy';
    btn.addEventListener('click', () => navigator.clipboard?.writeText(out.name));
    portsEl.append(span, btn);
  }
}

$('midi-toggle').addEventListener('click', () => {
  const strip = $('midi-strip');
  strip.classList.toggle('collapsed');
  $('midi-toggle').textContent = strip.classList.contains('collapsed') ? 'midi ▸' : 'midi ▾';
  ui.resizeCanvas();
});

// right-pane tabs: code editor / visuals editor / reference card
$('tab-code').addEventListener('click', () => setPaneTab('code'));
$('tab-visuals').addEventListener('click', () => setPaneTab('visuals'));
$('tab-ref').addEventListener('click', () => setPaneTab('ref'));
function setPaneTab(which) {
  mountPane.classList.toggle('show-ref', which === 'ref');
  mountPane.classList.toggle('show-visuals', which === 'visuals');
  $('tab-code').classList.toggle('active', which === 'code');
  $('tab-visuals').classList.toggle('active', which === 'visuals');
  $('tab-ref').classList.toggle('active', which === 'ref');
  if (which === 'code') mountEditor.focus();
  if (which === 'visuals') visualsEditor.focus();
}

midiSelect.addEventListener('change', () => midi.select(midiSelect.value));

// ---- persistence ----

function buildState() {
  const { rows, cellFlags } = gridToRows(machine);
  return {
    version: 2,
    size: { w: machine.width, h: machine.height },
    bpm: Number(bpmInput.value) || 120,
    rows,
    cellFlags,
    wires: machine.allWires().map(({ from, to }) => [from.x, from.y, to.x, to.y]),
    mount: mountEditor.getSource().split('\n'),
    visuals: visualsEditor.getSource().split('\n'),
  };
}

function applyState(state) {
  bpmInput.value = state.bpm ?? 120;
  const w = Math.min(MAX_W, state.size?.w ?? GRID_W);
  const h = Math.min(MAX_H, state.size?.h ?? GRID_H);
  clearGrid();
  if (w !== machine.width || h !== machine.height) machine.resize(w, h);
  gridWInput.value = machine.width;
  gridHInput.value = machine.height;
  // v2: rows + cellFlags sidecar; older saves: cells array
  if (state.rows) rowsToGrid(machine, state.rows, state.cellFlags ?? []);
  else if (state.cells) cellsToGrid(machine, state.cells);
  for (const [fx, fy, tx, ty] of state.wires ?? []) {
    machine.ensureWire({ x: fx, y: fy }, { x: tx, y: ty });
  }
  // legacy slot-panel patterns migrate into the mount document
  const migrated = textualizeSlots(state.slots);
  let mountSource =
    state.mount !== undefined
      ? Array.isArray(state.mount)
        ? state.mount.join('\n')
        : (state.mount ?? '')
      : null;
  if (migrated.length) {
    mountSource = `${mountSource ?? DEFAULT_MOUNT_DOC}\n${migrated.join('\n')}\n`;
    statusLine.textContent = `migrated ${migrated.length - 1} legacy slot(s) into the mount doc`;
  }
  if (mountSource !== null) {
    mountEditor.setSource(mountSource);
    if (mountSource.trim()) {
      evalMountSource(mountSource);
    } else {
      mounts = new MountTable();
      machine.mounts = mounts;
      lastEvalSource = '';
      lastEvalError = null;
      renderMountBar();
    }
  }
  // state.mount undefined AND no slots: preserve current mounts (old fix)

  // visuals source rides like mount: absent key preserves the current buffer
  if (state.visuals !== undefined) {
    const src = Array.isArray(state.visuals) ? state.visuals.join('\n') : (state.visuals ?? '');
    visualsEditor.setSource(src);
    evalVisualsSource(src);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildState()));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    applyState(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

// ---- patch files (export/import survive storage clears, live in git) ----
// save uses the OS save-as picker where available (Chrome/Edge), seeded
// with the last saved/loaded name so versioning a patch is a small edit
// instead of a rename-in-Downloads hunt; falls back to a plain download
const PATCH_NAME_KEY = 'griddle-last-patch-name';
async function exportPatch() {
  const json = JSON.stringify(buildState(), null, 2);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const suggested = localStorage.getItem(PATCH_NAME_KEY) || `griddle-patch-${stamp}.json`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'griddle patch', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      localStorage.setItem(PATCH_NAME_KEY, handle.name);
      statusLine.textContent = `saved ${handle.name}`;
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled the picker
      // picker failed for a real reason: fall through to the download path
    }
  }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggested;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importPatch(file) {
  try {
    const state = JSON.parse(await file.text());
    if (!looksLikePatch(state)) throw new Error('not a griddle patch (no rows or cells)');
    applyState(state);
    saveState();
    localStorage.setItem(PATCH_NAME_KEY, file.name); // next save-as suggests it
    statusLine.textContent = `loaded ${file.name}`;
  } catch (e) {
    statusLine.textContent = `import failed: ${e.message}`;
  }
}

savePatchBtn.addEventListener('click', exportPatch);
$('load-patch-btn').addEventListener('click', () => loadPatchInput.click());
loadPatchInput.addEventListener('change', () => {
  if (loadPatchInput.files[0]) importPatch(loadPatchInput.files[0]);
  loadPatchInput.value = '';
});

// ---- grid size ----
function applyGridSize() {
  const w = Math.max(8, Math.min(MAX_W, Number(gridWInput.value) || GRID_W));
  const h = Math.max(8, Math.min(MAX_H, Number(gridHInput.value) || GRID_H));
  gridWInput.value = w;
  gridHInput.value = h;
  if (w !== machine.width || h !== machine.height) {
    machine.resize(w, h);
    ui.cursor.x = Math.min(ui.cursor.x, w - 1);
    ui.cursor.y = Math.min(ui.cursor.y, h - 1);
    ui.box = { w: 1, h: 1 };
    ui.clampCamera();
    saveState();
  }
}

gridWInput.addEventListener('change', applyGridSize);
gridHInput.addEventListener('change', applyGridSize);

function clearGrid() {
  machine.grid.clear();
  machine.clearWires();
  machine.reset();
}

// ---- demo ----
function loadDemo() {
  clearGrid();
  bpmInput.value = DEMO.bpm;
  DEMO.rows.forEach((row, dy) => {
    [...row].forEach((char, dx) => {
      if (char === '.') return;
      const cell = charToCell(char);
      if (cell) machine.grid.set(DEMO.origin.x + dx, DEMO.origin.y + dy, cell);
    });
  });
  for (const [fx, fy, tx, ty] of DEMO.wires ?? []) {
    machine.ensureWire(
      { x: DEMO.origin.x + fx, y: DEMO.origin.y + fy },
      { x: DEMO.origin.x + tx, y: DEMO.origin.y + ty },
    );
  }
  // demo overrides ride on the default tables (later lines win), keeping the
  // demo's slots 0/1 meaning what the legacy panel said they meant
  const demoMounts =
    DEFAULT_MOUNT_DOC +
    `\n// demo overrides\n$0: pat('x(5,8)').gsteps(8)\n$1: "0 2 4 <7 9> 4 2"\n`;
  mountEditor.setSource(demoMounts);
  evalMountSource(demoMounts);
  saveState();
}

demoBtn.addEventListener('click', loadDemo);
clearBtn.addEventListener('click', () => {
  clearGrid();
  saveState();
});
bpmInput.addEventListener('change', saveState);

// ---- render loop ----
const contextLine = $('context');
let lastContext = '';

function frame() {
  ui.render();
  // visuals layer: hydra samples the freshly-rendered grid canvas; the grid
  // canvas goes transparent (but stays interactive) while a chain is live
  visualsTick(performance.now());
  canvas.classList.toggle('visuals-under', visualsActive());
  const pos = `${ui.cursor.x},${ui.cursor.y}`;
  statusLine.textContent = playing
    ? `tick ${machine.metronome} · ${pos}`
    : /^(tick|stopped)/.test(statusLine.textContent) || statusLine.textContent.includes(',')
      ? `stopped · ${pos}`
      : statusLine.textContent;
  // the context line: live inspector for the cell under the cursor
  const desc = `${pos} · ${describeAt(machine, ui.cursor.x, ui.cursor.y)}`;
  if (desc !== lastContext) {
    lastContext = desc;
    contextLine.textContent = desc;
  }
  requestAnimationFrame(frame);
}

// ---- boot ----
if (!loadState()) loadDemo();
// seed empty mount editors with the default document (defaults are code:
// visible, editable, erasable — never hidden engine behavior)
if (!mountEditor.getSource().trim()) {
  mountEditor.setSource(DEFAULT_MOUNT_DOC);
  evalMountSource(DEFAULT_MOUNT_DOC);
}
gridWInput.value = machine.width;
gridHInput.value = machine.height;
initMidi();
frame();
