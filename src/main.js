import { Machine } from './interpreter.js';
import { PatternBank } from './patterns.js';
import { Clock } from './clock.js';
import { MidiOut, PreviewSynth } from './midi.js';
import { GridUI } from './ui.js';
import { DEMO } from './demo.js';
import { charToCell, cellToChar, toB36Char, getType, TYPE } from './values.js';

const GRID_W = 32;
const GRID_H = 16;
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

const ui = new GridUI(canvas, machine, { onEdit: saveState });

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
  // any focused form control owns the keyboard; the grid only listens
  // when focus is on the canvas/body (click the grid to reclaim it)
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
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

function saveState() {
  const state = {
    bpm: Number(bpmInput.value) || 120,
    cells: serializeGrid(),
    wires: machine.allWires().map(({ from, to }) => [from.x, from.y, to.x, to.y]),
    slots: bank.slots.map((s) => ({ code: s.code, steps: s.stepsOverride })),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const state = JSON.parse(raw);
    bpmInput.value = state.bpm ?? 120;
    clearGrid();
    for (const [x, y, char, flags] of state.cells) {
      const cell = charToCell(char);
      if (cell) machine.grid.set(x, y, { flags: flags ?? cell.flags, letter: cell.letter });
    }
    for (const [fx, fy, tx, ty] of state.wires ?? []) {
      machine.ensureWire({ x: fx, y: fy }, { x: tx, y: ty });
    }
    state.slots?.forEach((s, i) => {
      if (s.code) bank.setSlot(i, s.code, s.steps ?? null);
    });
    return true;
  } catch {
    return false;
  }
}

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
  statusLine.textContent = playing
    ? `tick ${machine.metronome}`
    : statusLine.textContent.startsWith('tick') ? 'stopped' : statusLine.textContent;
  requestAnimationFrame(frame);
}

// ---- boot ----
initSlotSelect();
if (!loadState()) loadDemo();
showSlot(0);
initMidi();
frame();
