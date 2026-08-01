// Hydra visuals over the grid panel (doc ten): the rendered 2D grid canvas
// feeds hydra as source s0; hydra's canvas sits beneath it while the grid
// canvas goes transparent (opacity 0 keeps hit-testing, so all interaction
// is untouched). hydra-synth loads lazily on first eval — no visuals, no
// engine. makeGlobal: false keeps hydra's vocabulary out of the globals;
// the eval scope is curated here, like the mount doc's.

import { lfoValue01 } from './mounts.js';
import { getType, TYPE } from './values.js';

let hydra = null;
let synth = null;
let lastGood = null; // last successfully evaluated non-empty source
let active = false; // a chain is live (grid canvas transparent)
let bypassed = false;
let deps = null; // injected by main.js: { getMachine, getMounts, tickFrac, gridCanvas }
let lastFrameMs = null;

export function setVisualsDeps(d) {
  deps = d;
}

export const visualsActive = () => active && !bypassed;

// per-frame accessors handed to chains as function-parameters (doc ten §5);
// read-only views of machine state — pure per frame, never write
export function makeAccessors(d) {
  const tickFloat = () => d.getMachine().metronome + d.tickFrac();
  const tpb = () => d.getTpb?.() ?? 4;
  return {
    tick: tickFloat,
    beat: () => (tickFloat() / tpb()) % 1,
    bar: () => (tickFloat() / (tpb() * 4)) % 1,
    gval: (ref) => {
      const slot = parseInt(String(ref).replace(/^@/, ''), 36);
      if (!Number.isFinite(slot)) return 0;
      return lfoValue01(d.getMounts()?.lookup('@', 0, slot), tickFloat());
    },
    gcell: (x, y) => {
      const c = d.getMachine().grid.get(x | 0, y | 0);
      return getType(c.flags) === TYPE.LITERAL ? c.letter : 0;
    },
  };
}

function sizeCanvases() {
  const grid = deps.gridCanvas;
  const c = document.getElementById('hydra-canvas');
  if (!c) return;
  if (c.width !== grid.width || c.height !== grid.height) {
    c.width = grid.width;
    c.height = grid.height;
    hydra?.setResolution(grid.width, grid.height);
  }
}

async function ensureHydra() {
  if (hydra) return;
  const { default: Hydra } = await import('hydra-synth');
  const grid = deps.gridCanvas;
  const c = document.createElement('canvas');
  c.id = 'hydra-canvas';
  grid.parentElement.insertBefore(c, grid);
  c.width = grid.width;
  c.height = grid.height;
  hydra = new Hydra({
    canvas: c,
    autoLoop: false,
    makeGlobal: false,
    detectAudio: false,
    precision: 'mediump',
  });
  hydra.synth.s0.init({ src: grid, dynamic: true });
  synth = hydra.synth;
}

// the curated eval scope: hydra sources/outputs/generators + the accessors
function buildScope() {
  const s = synth;
  const names = [
    'osc', 'gradient', 'noise', 'shape', 'solid', 'src', 'voronoi',
    'render', 'hush', 'setFunction',
    's0', 's1', 's2', 's3', 'o0', 'o1', 'o2', 'o3',
  ];
  const scope = {};
  for (const n of names) if (s[n] !== undefined) scope[n] = s[n];
  Object.assign(scope, makeAccessors(deps));
  return scope;
}

const isEmptySource = (src) =>
  src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .join('') === '';

function runChains(source) {
  const scope = buildScope();
  const fn = new Function(...Object.keys(scope), source);
  fn(...Object.values(scope));
}

// ⌘↵ contract (doc ten §4): empty/comment-only source = visuals off;
// eval error = restore last-good (re-run it — a failed eval may have
// half-applied chains before throwing); success = swap + activate.
export async function evalVisuals(source) {
  if (isEmptySource(source)) {
    if (hydra) synth.hush();
    active = false;
    return { active: false };
  }
  await ensureHydra();
  try {
    runChains(source);
    lastGood = source;
    active = true;
    return { active: true };
  } catch (e) {
    if (lastGood) {
      try {
        runChains(lastGood); // restore: partial application must not linger
      } catch {
        synth.hush();
        active = false;
      }
    } else {
      synth.hush();
      active = false;
    }
    throw e;
  }
}

export function setBypassed(b) {
  bypassed = b;
}

export const isBypassed = () => bypassed;

// called every frame from main's rAF loop; owns dt bookkeeping
export function visualsTick(nowMs) {
  if (!hydra || !active || bypassed) {
    lastFrameMs = nowMs;
    return;
  }
  sizeCanvases();
  const dt = lastFrameMs === null ? 16 : Math.min(nowMs - lastFrameMs, 100);
  lastFrameMs = nowMs;
  hydra.tick(dt);
}

export const DEFAULT_VISUALS_DOC = `// visuals — hydra chains over the grid · ⌘↵ to apply · empty = off
// s0 = the rendered grid · o0-o3 = feedback buffers · fx button bypasses
// accessors: tick() beat() bar() gval('@u') gcell(x, y)
//
// src(s0).out()                                        // passthrough
// src(s0).modulate(osc(6, 0.1), 0.05).out()            // wobble
// src(s0).blend(o0, 0.72).scale(1.003).out()           // trails
// src(s0).modulate(o0, () => gval('@u') * 0.2).out()   // lfo-driven feedback
// src(s0).saturate(() => 1 + beat() * 2).out()         // beat-pumped color
`;
