// The mount document: live-codeable JavaScript defining LFOs (and, in doc
// seven's phase, patterns) mounted into device-qualified slots.
// Design: docs/griddle-lfo-mounts-design.md + griddle-pattern-mounts-design.md.
//
// Two-phase evaluation: arbitrary JS runs ONCE at mount time (impurity there
// is a livecoding gesture); only compiled artifacts run at query time. The
// runtime invariant is (grid, mounted artifacts, tick) -> identical output.

import { transpiler } from '@strudel/transpiler';
import { mini } from '@strudel/mini';
import { sine, cosine, saw, isaw, tri, square, perlin, rand } from '@strudel/core';
import { TICKS_PER_BEAT } from './clock.js';

const RADIX = 36;

// ---------------------------------------------------------------------------
// sigil pre-pass: `@a:` / `@2f:` at statement start -> legal JS label.
// Line-anchored so `@` inside string literals is untouched (accepted risk:
// pathological multi-line strings). After strudel's labelToP transform the
// label reaches us as `.p('$__at_a')`.
// ---------------------------------------------------------------------------
export const SIGILS = { '@': 'at', $: 'dollar' };

export function prepass(source) {
  return source.replace(
    /^(\s*)([@$])([0-9a-z]{1,2})(\s*):/gm,
    (m, ws, sigil, ref, sp) => `${ws}$__${SIGILS[sigil]}_${ref}${sp}:`,
  );
}

export function decodeLabel(label) {
  const m = /^\$__(at|dollar)_([0-9a-z]{1,2})$/.exec(label);
  if (!m) return null;
  const sigil = m[1] === 'at' ? '@' : '$';
  return { sigil, ref: m[2] };
}

// ---------------------------------------------------------------------------
// cycle spec: number = beats; "16t" ticks, "3.5b" beats, "2bar" bars
// ---------------------------------------------------------------------------
export function cycleTicks(spec) {
  if (typeof spec === 'number') return spec * TICKS_PER_BEAT;
  const m = /^\s*([\d.]+)\s*(t|b|bar)\s*$/.exec(String(spec));
  if (!m) throw new Error(`bad cycle spec: ${JSON.stringify(spec)} (use 16t / 3.5b / 2bar)`);
  const n = parseFloat(m[1]);
  return m[2] === 't' ? n : m[2] === 'b' ? n * TICKS_PER_BEAT : n * 4 * TICKS_PER_BEAT;
}

// geometric spread of n cycle specs between two durations
export function spread(lo, hi, n) {
  const a = cycleTicks(lo);
  const b = cycleTicks(hi);
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return `${(a * (b / a) ** t).toFixed(2)}t`;
  });
}

// ---------------------------------------------------------------------------
// shape sampling -> per-cycle piecewise-linear breakpoint table
// table: [[phase, value01], ...] with phase ascending in [0, 1]; the runtime
// interpolates linearly between consecutive points and wraps 1 -> point 0.
// Step edges are represented as duplicated phases (vertical segments).
// ---------------------------------------------------------------------------
const SIGNAL_SAMPLES = 64;

function isPattern(x) {
  return x && typeof x === 'object' && typeof x.queryArc === 'function';
}

function sampleSignal(pat) {
  const table = [];
  for (let k = 0; k <= SIGNAL_SAMPLES; k++) {
    const p = k / SIGNAL_SAMPLES;
    const q = Math.min(p, 1 - 1e-9);
    const haps = pat.queryArc(q, q + 1e-9);
    const v = haps.length ? Number(haps[0].value) : 0;
    table.push([p, Math.max(0, Math.min(1, v))]);
  }
  return table;
}

function sampleDiscrete(pat) {
  // V-wavetable interpretation: onset values (0-35 domain) become steps
  const haps = pat
    .queryArc(0, 1)
    .filter((h) => h.hasOnset())
    .sort((a, b) => a.part.begin.valueOf() - b.part.begin.valueOf());
  if (haps.length === 0) return [[0, 0], [1, 0]];
  const norm = (v) => {
    const n = typeof v === 'string' && /^[0-9a-z]$/.test(v) ? parseInt(v, 36) : Number(v);
    return Math.max(0, Math.min(1, (Number.isFinite(n) ? n : 0) / (RADIX - 1)));
  };
  const table = [];
  let last = norm(haps[haps.length - 1].value); // wrap: value sounding at 0
  if (haps[0].part.begin.valueOf() > 0) table.push([0, last]);
  for (const h of haps) {
    const p = h.part.begin.valueOf();
    const v = norm(h.value);
    if (table.length) table.push([p, table[table.length - 1][1]]); // step edge
    table.push([p, v]);
    last = v;
  }
  table.push([1, last]);
  return table;
}

function looksContinuous(pat) {
  const haps = pat.queryArc(0, 0.001);
  return haps.length > 0 && haps.every((h) => h.whole === undefined);
}

// ---------------------------------------------------------------------------
// lfo() builder
// ---------------------------------------------------------------------------
const MOD_NAMES = new Set(['phase', 'rate', 'skew', 'spread', 'smooth', 'depth', 'offset']);

class LfoDef {
  constructor(shape) {
    this._shape = shape;
    this._cycle = '4b';
    this._range = [0, 127];
    this._phase = 0;
    this._smooth = 0;
    this._mod = null;
    this._sync = false;
  }

  _clone() {
    return Object.assign(Object.create(LfoDef.prototype), this);
  }

  cycle(spec) {
    const d = this._clone();
    cycleTicks(spec); // validate now, at mount time
    d._cycle = spec;
    return d;
  }

  range(lo, hi) {
    const d = this._clone();
    d._range = [lo, hi];
    return d;
  }

  phase(p) {
    const d = this._clone();
    d._phase = p;
    return d;
  }

  smooth(s) {
    const d = this._clone();
    d._smooth = s;
    return d;
  }

  sync() {
    const d = this._clone();
    d._sync = true;
    return d;
  }

  mod(name, ...args) {
    if (!MOD_NAMES.has(name)) throw new Error(`unknown mod: ${name}`);
    const d = this._clone();
    d._mod = { name, args };
    return d;
  }

  // strudel's labelToP transform calls this with the (pre-passed) label
  p(label) {
    const decoded = decodeLabel(label);
    if (!decoded) throw new Error(`lfo mounted with bad label: ${label}`);
    if (decoded.sigil !== '@') throw new Error(`lfo must mount with @, got ${decoded.sigil}${decoded.ref}`);
    activeCollector().add('@' + decoded.ref, this.compile());
    return this;
  }

  compile() {
    let shape = this._shape;
    let procedural = null;
    let table = null;
    if (shape === 'noise' || shape === rand) {
      procedural = 'noise';
    } else {
      if (typeof shape === 'string') shape = mini(shape);
      if (!isPattern(shape)) throw new Error('lfo shape must be a signal, pattern, mini-string, or "noise"');
      table = looksContinuous(shape) ? sampleSignal(shape) : sampleDiscrete(shape);
    }
    return {
      kind: 'lfo',
      table,
      procedural,
      cycleTicks: cycleTicks(this._cycle),
      phase0: this._phase,
      range: [...this._range],
      smooth: this._smooth,
      mod: this._mod,
      sync: this._sync,
    };
  }
}

export const lfo = (shape) => new LfoDef(shape);

// ---------------------------------------------------------------------------
// mount table: device-qualified lookup, specific ?? global
// ---------------------------------------------------------------------------
export class MountTable {
  constructor() {
    this.entries = new Map(); // '@a' | '@2a' -> artifact
    this.deviceMap = {}; // logical device -> output name (null = black hole)
    this.source = '';
    this.errors = [];
  }

  // F with device port d, slot s: '@<d><s>' ?? '@<s>'
  lookup(sigil, device, slot) {
    const d = device.toString(36);
    const s = slot.toString(36);
    return this.entries.get(sigil + d + s) ?? this.entries.get(sigil + s) ?? null;
  }
}

// mount-time collection context (single-threaded eval)
let collector = null;
const activeCollector = () => {
  if (!collector) throw new Error('mount() called outside document evaluation');
  return collector;
};

// ---------------------------------------------------------------------------
// document evaluation: prepass -> strudel transpiler -> Function(scope)
// Last-good retention lives in the caller: evaluate() returns a fresh table
// or throws; the caller keeps the previous table on failure.
// ---------------------------------------------------------------------------
export function evaluateMountDoc(source) {
  const table = new MountTable();
  table.source = source;

  const scope = {
    // griddle
    lfo,
    spread,
    devices: (map) => {
      Object.assign(table.deviceMap, map);
    },
    mount: (ref, def) => {
      if (!/^[@$][0-9a-z]{1,2}$/.test(ref)) throw new Error(`bad mount ref: ${ref}`);
      if (ref[0] === '@') {
        if (!(def instanceof LfoDef)) throw new Error(`${ref}: @ mounts take lfo(...) definitions`);
        table.entries.set(ref, def.compile());
      } else {
        throw new Error(`$ pattern mounts not yet implemented (doc seven, phase 3)`);
      }
    },
    // strudel shapes
    sine, cosine, saw, isaw, tri, square, perlin, rand,
    noise: 'noise',
    mini,
  };

  const local = {
    add: (ref, artifact) => table.entries.set(ref, artifact),
  };

  const pre = prepass(source);
  if (/\$__dollar_/.test(pre)) {
    throw new Error('$ pattern mounts not yet implemented (doc seven, phase 3) — patterns still live in the slot panel');
  }
  const { output } = transpiler(pre, { wrapAsync: false, addReturn: false, emitMiniLocations: false });

  collector = local;
  try {
    const fn = new Function(...Object.keys(scope), `'use strict';\n${output}`);
    fn(...Object.values(scope));
  } finally {
    collector = null;
  }
  return table;
}

// The default mount document, seeded into empty patches: every slot 0-z is
// mounted, so the F slot port acts as a coarse frequency knob following the
// pre-mount quadratic curve (period 4·r² ticks; slot 0 = slowest, per
// CLAVIER's map_zero convention). Later statements override earlier ones, so
// per-slot customizations go below the loop. Defaults are code, not magic.
export const DEFAULT_MOUNT_DOC = `// griddle mounts — edit freely, ⌘↵ to apply (later lines override earlier)
// slot glyph = coarse rate knob: period 4·r² ticks (slot 0 = slowest)
"0123456789abcdefghijklmnopqrstuvwxyz".split("").forEach((ch, r) =>
  mount("@" + ch, lfo(tri).cycle((4 * (r === 0 ? 36 : r) ** 2) + "t")))

// per-slot overrides go here, e.g.:
// @p: lfo(tri).cycle("196t").phase(0.42)
// @n: lfo(noise).cycle("2bar").smooth(0.5)
`;

// convenience: evaluate with last-good retention + error capture
export function tryEvaluate(source, previous) {
  try {
    return { table: evaluateMountDoc(source), error: null };
  } catch (e) {
    return { table: previous ?? new MountTable(), error: e.message || String(e) };
  }
}
