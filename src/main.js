import { Machine } from './interpreter.js';
import { PatternBank } from './patterns.js';
import { Clock } from './clock.js';
import { MidiOut, PreviewSynth } from './midi.js';
import { GridUI } from './ui.js';
import { MountEditor } from './editor.js';
import { MountTable, tryEvaluate, DEFAULT_MOUNT_DOC } from './mounts.js';
import { DEMO } from './demo.js';
import { charToCell, cellToChar, toB36Char, getType, TYPE } from './values.js';

const GRID_W = 64;
const GRID_H = 32;
const MAX_W = 128;
const MAX_H = 64;
const STORAGE_KEY = 'griddle-state-v1';

const bank = new PatternBank();
const machine = new Machine(GRID_W, GRID_H, {
  bang: (slot, pos) => bank.bang(slot, pos),
  value: (slot, pos) => bank.value(slot, pos),
});
const midi = new MidiOut();
const synth = new PreviewSynth();

// ---- dom ----
const $ = (id) => document.getElementById(id);
const canvas = $('grid');
const playBtn = $('play');
const bpmInput = $('bpm');
const midiSelect = $('midi-out');
const previewCheck = $('preview');
const slotSelect = $('slot-select');
const slotCode = $('slot-code');
const slotSteps = $('slot-steps');
const slotStatus = $('slot-status');
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

const mountEditor = new MountEditor($('mount-editor'), {
  onEval: (source) => {
    const result = tryEvaluate(source, mounts);
    mounts = result.table;
    machine.mounts = mounts; // consumed by F once step 2 lands
    renderMountBar(result.error);
    saveState();
  },
  onExit: () => canvas.focus(),
});

function renderMountBar(error) {
  if (error) {
    console.error('[griddle mount]', error); // copyable from devtools too
    mountBar.innerHTML = `<span class="err">✗ ${error.replace(/</g, '&lt;')}</span>`;
    return;
  }
  const refs = [...mounts.entries.keys()].sort();
  const devs = Object.keys(mounts.deviceMap).length;
  mountBar.innerHTML = refs.length
    ? `<span class="ok">✓</span> ${refs.map((r) => `<span class="ref">${r}</span>`).join('')}` +
      (devs ? ` · ${devs} device${devs > 1 ? 's' : ''}` : '')
    : 'mounts: none — ⌘↵ to evaluate';
}

$('mount-defaults').addEventListener('click', () => {
  // replace the whole document with the canonical defaults and evaluate —
  // the recovery path when pasted/stale content won't parse
  mountEditor.setSource(DEFAULT_MOUNT_DOC);
  const result = tryEvaluate(DEFAULT_MOUNT_DOC, mounts);
  mounts = result.table;
  machine.mounts = mounts;
  renderMountBar(result.error);
  saveState();
  mountEditor.focus();
});

function toggleMountPane(show) {
  const hidden = mountPane.classList.contains('hidden');
  const next = show ?? hidden;
  mountPane.classList.toggle('hidden', !next);
  ui.resizeCanvas();
  if (next) mountEditor.focus();
  else canvas.focus();
}

// ---- transport ----
let playing = false;
const clock = new Clock({
  getBpm: () => Number(bpmInput.value) || 120,
  onTick: (tick, timeMs) => {
    machine.step();
    const tickMs = clock.tickMs();
    for (const e of machine.scanMidi()) {
      if (e.type === 'note') {
        const durMs = Math.max(e.holdTicks, 0.25) * tickMs;
        midi.noteOn(e.channel, e.note, e.velocity, timeMs);
        midi.noteOff(e.channel, e.note, timeMs + durMs);
        if (previewCheck.checked) synth.note(e.note, e.velocity, timeMs, durMs);
      } else if (e.type === 'cc') {
        midi.cc(e.channel, e.controller, e.value, timeMs);
      }
    }
    // mounted U/V MIDI faces: notes at true fractional times, durations
    // from hap whole spans
    for (const e of machine.noteEvents) {
      const at = timeMs + e.frac * tickMs;
      const durMs = Math.max(e.durTicks * tickMs, 15);
      midi.noteOn(e.channel, e.note, e.velocity, at);
      midi.noteOff(e.channel, e.note, at + durMs);
      if (previewCheck.checked) synth.note(e.note, e.velocity, at, durMs);
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

function setPlaying(next) {
  playing = next;
  playBtn.textContent = playing ? '■ stop' : '▶ play';
  if (playing) {
    machine.reset();
    if (previewCheck.checked) synth.ensure();
    clock.start();
  } else {
    clock.stop();
    midi.allNotesOff();
  }
}

playBtn.addEventListener('click', () => setPlaying(!playing));
panicBtn.addEventListener('click', () => midi.allNotesOff());

document.addEventListener('keydown', (e) => {
  // ⌘E toggles the mount editor from anywhere
  if (e.key === 'e' && (e.metaKey || e.ctrlKey)) {
    toggleMountPane();
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
    statusLine.textContent = `${midi.error} — preview synth enabled`;
    previewCheck.checked = true;
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
  if (!outputs.length) previewCheck.checked = true;
}

midiSelect.addEventListener('change', () => midi.select(midiSelect.value));

// ---- slot editor ----
let currentSlot = 0;

function initSlotSelect() {
  for (let i = 0; i < 36; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = toB36Char(i);
    slotSelect.appendChild(opt);
  }
}

function showSlot(i) {
  currentSlot = i;
  const slot = bank.slots[i];
  slotSelect.value = i;
  slotCode.value = slot.code;
  slotSteps.value = slot.stepsOverride ?? '';
  updateSlotStatus();
}

function updateSlotStatus() {
  const slot = bank.slots[currentSlot];
  if (slot.error) {
    slotStatus.textContent = `✗ ${slot.error}`;
    slotStatus.className = 'error';
  } else if (slot.pattern) {
    slotStatus.textContent = `✓ steps: ${bank.steps(currentSlot)}${slot.stepsOverride ? ' (override)' : ' (auto)'}`;
    slotStatus.className = 'ok';
  } else {
    slotStatus.textContent = 'empty';
    slotStatus.className = '';
  }
}

function applySlotEdit() {
  const steps = slotSteps.value.trim() === '' ? null : Math.max(1, Number(slotSteps.value));
  bank.setSlot(currentSlot, slotCode.value, Number.isFinite(steps) ? steps : null);
  updateSlotStatus();
  saveState();
}

let slotDebounce = null;
const debouncedApply = () => {
  clearTimeout(slotDebounce);
  slotDebounce = setTimeout(applySlotEdit, 300);
};
slotCode.addEventListener('input', debouncedApply);
slotSteps.addEventListener('input', debouncedApply);
slotSelect.addEventListener('change', () => showSlot(Number(slotSelect.value)));

// ---- persistence ----
function serializeGrid() {
  const cells = [];
  const grid = machine.grid;
  for (let y = 0; y < machine.height; y++) {
    for (let x = 0; x < machine.width; x++) {
      const cell = grid.get(x, y);
      if (getType(cell.flags) === TYPE.NONE) continue;
      cells.push([x, y, cellToChar(cell.flags, cell.letter), cell.flags]);
    }
  }
  return cells;
}

function buildState() {
  return {
    version: 1,
    size: { w: machine.width, h: machine.height },
    bpm: Number(bpmInput.value) || 120,
    cells: serializeGrid(),
    wires: machine.allWires().map(({ from, to }) => [from.x, from.y, to.x, to.y]),
    slots: bank.slots.map((s) => ({ code: s.code, steps: s.stepsOverride })),
    mount: mountEditor.getSource().split('\n'),
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
  for (const [x, y, char, flags] of state.cells) {
    const cell = charToCell(char);
    if (cell) machine.grid.set(x, y, { flags: flags ?? cell.flags, letter: cell.letter });
  }
  for (const [fx, fy, tx, ty] of state.wires ?? []) {
    machine.ensureWire({ x: fx, y: fy }, { x: tx, y: ty });
  }
  for (let i = 0; i < 36; i++) bank.setSlot(i, '');
  state.slots?.forEach((s, i) => {
    if (s.code) bank.setSlot(i, s.code, s.steps ?? null);
  });
  showSlot(currentSlot);
  // v1 patches have no mount field: PRESERVE whatever is currently mounted
  // rather than wiping the bank the user may have just evaluated
  if (state.mount !== undefined) {
    const mountSource = Array.isArray(state.mount) ? state.mount.join('\n') : (state.mount ?? '');
    mountEditor.setSource(mountSource);
    if (mountSource.trim()) {
      const result = tryEvaluate(mountSource, mounts);
      mounts = result.table;
      machine.mounts = mounts;
      renderMountBar(result.error);
    } else {
      mounts = new MountTable();
      machine.mounts = mounts;
      renderMountBar(null);
    }
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
function exportPatch() {
  const blob = new Blob([JSON.stringify(buildState(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  a.download = `griddle-patch-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importPatch(file) {
  try {
    const state = JSON.parse(await file.text());
    if (!Array.isArray(state.cells)) throw new Error('not a griddle patch');
    applyState(state);
    saveState();
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
  for (let i = 0; i < 36; i++) bank.setSlot(i, '');
  for (const [key, { code, steps }] of Object.entries(DEMO.slots)) {
    bank.setSlot(Number(key), code, steps);
  }
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
  const seeded = tryEvaluate(demoMounts, mounts);
  mounts = seeded.table;
  machine.mounts = mounts;
  renderMountBar(seeded.error);
  showSlot(0);
  saveState();
}

demoBtn.addEventListener('click', loadDemo);
clearBtn.addEventListener('click', () => {
  clearGrid();
  saveState();
});
bpmInput.addEventListener('change', saveState);

// ---- render loop ----
function frame() {
  ui.render();
  const pos = `${ui.cursor.x},${ui.cursor.y}`;
  statusLine.textContent = playing
    ? `tick ${machine.metronome} · ${pos}`
    : /^(tick|stopped)/.test(statusLine.textContent) || statusLine.textContent.includes(',')
      ? `stopped · ${pos}`
      : statusLine.textContent;
  requestAnimationFrame(frame);
}

// ---- boot ----
initSlotSelect();
if (!loadState()) loadDemo();
// seed empty mount editors with the default document (defaults are code:
// visible, editable, erasable — never hidden engine behavior)
if (!mountEditor.getSource().trim()) {
  mountEditor.setSource(DEFAULT_MOUNT_DOC);
  const seeded = tryEvaluate(DEFAULT_MOUNT_DOC, mounts);
  mounts = seeded.table;
  machine.mounts = mounts;
  renderMountBar(seeded.error);
}
gridWInput.value = machine.width;
gridHInput.value = machine.height;
showSlot(0);
initMidi();
frame();
