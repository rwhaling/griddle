// The mount document: live-codeable JavaScript defining LFOs (and, in doc
// seven's phase, patterns) mounted into device-qualified slots.
// Design: docs/griddle-lfo-mounts-design.md + griddle-pattern-mounts-design.md.
//
// Two-phase evaluation: arbitrary JS runs ONCE at mount time (impurity there
// is a livecoding gesture); only compiled artifacts run at query time. The
// runtime invariant is (grid, mounted artifacts, tick) -> identical output.

import { transpiler } from '@strudel/transpiler';
import '@strudel/transpiler/plugin-mini.mjs'; // side effect: "..." -> m(...) (mini)
import { mini } from '@strudel/mini';
import * as strudel from '@strudel/core';
import { TICKS_PER_BEAT } from './clock.js';

const { Pattern, Fraction, sine, cosine, saw, isaw, tri, square, perlin, rand } = strudel;

const RADIX = 36;
const isStrudelPattern = (x) => x && typeof x === 'object' && typeof x.queryArc === 'function';

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
  if (isStrudelPattern(spec)) {
    throw new Error("cycle spec got a pattern — use single quotes: .cycle('4b') (double quotes are mini-notation)");
  }
  const m = /^\s*([\d.]+)\s*(t|b|bar)\s*$/.exec(String(spec));
  if (!m) throw new Error(`bad cycle spec: ${JSON.stringify(spec)} (use '16t' / '3.5b' / '2bar')`);
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

// signals are shared objects (36 mounts of lfo(tri) sample tri once)
const signalTableCache = new WeakMap();

function sampleSignal(pat) {
  if (signalTableCache.has(pat)) return signalTableCache.get(pat);
  const table = [];
  for (let k = 0; k <= SIGNAL_SAMPLES; k++) {
    const p = k / SIGNAL_SAMPLES;
    const q = Math.min(p, 1 - 1e-9);
    const haps = pat.queryArc(q, q + 1e-9);
    const v = haps.length ? Number(haps[0].value) : 0;
    table.push([p, Math.max(0, Math.min(1, v))]);
  }
  signalTableCache.set(pat, table);
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
    if (isStrudelPattern(name)) {
      throw new Error("mod name got a pattern — use single quotes: .mod('rate') (double quotes are mini-notation)");
    }
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
// pattern mounts ($) — doc seven: the mount decides the time model. Bare
// mount = positional (drive port = position); .cycle() = rate-driven (drive
// port = mod). U/V are the whole/part projections of one mount.
// ---------------------------------------------------------------------------
const PATTERN_MODS = new Set(['rate', 'phase', 'transpose', 'degrade', 'velocity']);

class PatternDef {
  constructor(pattern) {
    this._pattern = typeof pattern === 'string' ? mini(pattern) : pattern;
    if (!isStrudelPattern(this._pattern)) throw new Error('pat() needs a pattern or mini-string');
    this._cycle = null;
    this._gsteps = null;
    this._base = 48;
    this._vel = 96;
    this._note = null;
    this._mod = null;
    this._sync = false;
  }

  _clone() {
    return Object.assign(Object.create(PatternDef.prototype), this);
  }

  cycle(spec) {
    const d = this._clone();
    cycleTicks(spec); // validate at mount time
    d._cycle = spec;
    return d;
  }

  gsteps(n) {
    const d = this._clone();
    d._gsteps = Math.max(1, Math.round(n));
    return d;
  }

  base(n) {
    const d = this._clone();
    d._base = Math.round(n);
    return d;
  }

  oct(n) {
    const d = this._clone();
    d._base = Math.round(n) * 12;
    return d;
  }

  vel(v) {
    const d = this._clone();
    d._vel = Math.max(0, Math.min(127, Math.round(v)));
    return d;
  }

  note(n) {
    const d = this._clone();
    d._note = Math.max(0, Math.min(127, Math.round(n)));
    return d;
  }

  sync() {
    const d = this._clone();
    d._sync = true;
    return d;
  }

  mod(name, ...args) {
    if (isStrudelPattern(name)) {
      throw new Error("mod name got a pattern — use single quotes: .mod('rate') (double quotes are mini-notation)");
    }
    if (!PATTERN_MODS.has(name)) throw new Error(`unknown pattern mod: ${name}`);
    const d = this._clone();
    d._mod = { name, args };
    return d;
  }

  p(label) {
    const decoded = decodeLabel(label);
    if (!decoded) throw new Error(`pattern mounted with bad label: ${label}`);
    if (decoded.sigil !== '$') throw new Error(`patterns must mount with $, got ${decoded.sigil}${decoded.ref}`);
    activeCollector().add('$' + decoded.ref, this.compile());
    return this;
  }

  compile() {
    const auto = Number(this._pattern._steps);
    return {
      kind: 'pattern',
      pattern: this._pattern,
      steps: this._gsteps ?? (Number.isFinite(auto) && auto >= 1 ? Math.round(auto) : null),
      cycleTicks: this._cycle !== null ? cycleTicks(this._cycle) : null,
      base: this._base,
      vel: this._vel,
      note: this._note,
      mod: this._mod,
      sync: this._sync,
    };
  }
}

export const pat = (p) => new PatternDef(p);

// Pattern.prototype extensions — ONLY names verified free of strudel claims
// (note/vel/oct/sync collide with strudel controls, so they live on the
// wrapper: start a griddle chain with cycle/gsteps/base/mod or pat()).
for (const name of ['cycle', 'gsteps', 'base', 'mod']) {
  try {
    Object.defineProperty(Pattern.prototype, name, {
      value: function (...args) {
        return new PatternDef(this)[name](...args);
      },
      writable: true,
      configurable: true,
    });
  } catch {
    // name not overridable in this strudel version: reachable via pat()
  }
}
// labels route raw patterns into $ mounts (overrides strudel's repl .p)
Pattern.prototype.p = function (label) {
  return new PatternDef(this).p(label);
};

// ---------------------------------------------------------------------------
// query-time helpers for U/V (pure; consumed by the interpreter)
// ---------------------------------------------------------------------------
const FALSY = new Set([false, 0, 'f', 'false', '~', '']);
export const isFalsyValue = (v) => FALSY.has(v);

export const coercePatternValue = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return ((Math.round(v) % RADIX) + RADIX) % RADIX;
  if (typeof v === 'string') {
    if (/^[0-9a-zA-Z]$/.test(v)) {
      const n = parseInt(v.toLowerCase(), 36);
      return n < RADIX ? n : null;
    }
    const n = Number(v);
    if (Number.isFinite(n)) return ((Math.round(n) % RADIX) + RADIX) % RADIX;
  }
  if (v && typeof v === 'object' && v.note != null) return coercePatternValue(Number(v.note) % RADIX);
  return null;
};

// positional window (quadrant ①/②): Fraction-exact [p/S, (p+1)/S) — same
// semantics as the legacy PatternBank, plus onset list for the MIDI face
export function positionalWindow(art, pos) {
  const S = art.steps ?? 36;
  let haps;
  try {
    haps = art.pattern.queryArc(Fraction(pos).div(S), Fraction(pos + 1).div(S));
  } catch {
    return { onsets: [], activeVal: null, bang: false };
  }
  const onsetHaps = haps
    .filter((h) => h.hasOnset())
    .sort((a, b) => a.part.begin.valueOf() - b.part.begin.valueOf());
  const a = pos / S;
  const w = 1 / S;
  const onsets = onsetHaps.map((h) => ({
    value: h.value,
    frac: (h.part.begin.valueOf() - a) / w,
    durCycles: h.whole ? h.whole.end.valueOf() - h.whole.begin.valueOf() : 0,
  }));
  let activeVal = null;
  if (onsetHaps.length) activeVal = onsetHaps[0].value;
  else {
    const continuous = haps.find((h) => h.whole === undefined);
    if (continuous && typeof continuous.value === 'number') {
      activeVal = Math.max(0, Math.min(RADIX - 1, Math.floor(continuous.value * RADIX)));
    }
  }
  const bang = onsetHaps.some((h) => !FALSY.has(h.value));
  return { onsets, activeVal, bang };
}

// rate-driven sweep (quadrant ③/④): floats; V face = active at end boundary
export function sweepWindow(art, a, inc) {
  const b = a + inc;
  let haps;
  try {
    haps = art.pattern.queryArc(a, b);
  } catch {
    return { onsets: [], activeVal: null, bang: false };
  }
  const eps = 1e-9;
  const onsetHaps = haps
    .filter((h) => h.hasOnset())
    .sort((x, y) => x.part.begin.valueOf() - y.part.begin.valueOf());
  const onsets = onsetHaps.map((h) => ({
    value: h.value,
    frac: Math.max(0, Math.min(1, (h.part.begin.valueOf() - a) / inc)),
    durCycles: h.whole ? h.whole.end.valueOf() - h.whole.begin.valueOf() : 0,
  }));
  // active-at-boundary: the most recent hap whose whole spans the end
  let activeVal = null;
  let bestBegin = -Infinity;
  for (const h of haps) {
    if (!h.whole) continue;
    const wb = h.whole.begin.valueOf();
    const we = h.whole.end.valueOf();
    if (wb <= b - eps && we > b - eps && wb > bestBegin) {
      bestBegin = wb;
      activeVal = h.value;
    }
  }
  const bang = onsetHaps.some((h) => !FALSY.has(h.value));
  return { onsets, activeVal, bang };
}

// MIDI-face pitch resolution: control objects pass through, numbers add base
export function noteFromValue(value, art) {
  if (value && typeof value === 'object' && value.note != null) {
    const n = typeof value.note === 'number' ? value.note : strudel.noteToMidi?.(value.note);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const n = coercePatternValue(value);
  return n === null ? null : art.base + n;
}

export function velocityFromValue(value, art) {
  if (value && typeof value === 'object' && value.velocity != null) {
    return Math.max(1, Math.min(127, Math.round(value.velocity * 127)));
  }
  return art.vel;
}

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
      if (typeof ref !== 'string' || !/^[@$][0-9a-z]{1,2}$/.test(ref)) {
        throw new Error(`bad mount ref: ${ref} (use single-quoted '@a' / '$2f')`);
      }
      if (ref[0] === '@') {
        if (!(def instanceof LfoDef)) throw new Error(`${ref}: @ mounts take lfo(...) definitions`);
        table.entries.set(ref, def.compile());
      } else {
        const pd = def instanceof PatternDef ? def : new PatternDef(def);
        table.entries.set(ref, pd.compile());
      }
    },
    pat,
    // the mini plugin rewrites double-quoted strings to m(str, ...locations)
    m: (str) => mini(str),
    // strudel shapes + a curated slice of the combinator/control surface
    sine, cosine, saw, isaw, tri, square, perlin, rand,
    noise: 'noise',
    mini,
    ...Object.fromEntries(
      ['cat', 'stack', 'seq', 'sequence', 'fastcat', 'slowcat', 'silence', 'note', 'n', 'run', 'irand', 'choose']
        .filter((k) => strudel[k] !== undefined)
        .map((k) => [k, strudel[k]]),
    ),
  };

  const local = {
    add: (ref, artifact) => table.entries.set(ref, artifact),
  };

  const pre = prepass(source);
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
export const DEFAULT_MOUNT_DOC = `// griddle mounts — ⌘↵ to apply · later lines override earlier
// double quotes = mini-notation · single quotes = plain strings

// LFOs · @0-@9: beat-synced (period = n beats, 0 = half), phase-locked
'0123456789'.split('').forEach((ch, d) =>
  mount('@' + ch, lfo(tri).cycle((d === 0 ? 0.5 : d) + 'b').sync().mod('rate', 0.5, 2)))

// LFOs · @a-@z: slow free-running spread, 2 bars .. 128 bars · mod = fine rate
spread('2bar', '128bar', 26).forEach((c, i) =>
  mount('@' + 'abcdefghijklmnopqrstuvwxyz'[i], lfo(tri).cycle(c).mod('rate', 0.5, 2)))

// patterns · euclidean tables (positional: drive port = position)
// $1-$8: x(n,8) · $9: x(9,16) · $a-$p: x(1..16,16) · $q-$z: x(1..10,12) · $0: silence
'12345678'.split('').forEach((ch, i) =>
  mount('$' + ch, pat('x(' + (i + 1) + ',8)').gsteps(8)))
mount('$9', pat('x(9,16)').gsteps(16))
'abcdefghijklmnop'.split('').forEach((ch, i) =>
  mount('$' + ch, pat('x(' + (i + 1) + ',16)').gsteps(16)))
'qrstuvwxyz'.split('').forEach((ch, i) =>
  mount('$' + ch, pat('x(' + (i + 1) + ',12)').gsteps(12)))
mount('$0', pat('~').gsteps(8))

// overrides go below, e.g.:
// @p: lfo(tri).cycle('196t').phase(0.42)
// $b: note("c3 [e3 g3] a2 <g3 b3>").cycle('2b').vel(85)
`;

// convenience: evaluate with last-good retention + error capture
export function tryEvaluate(source, previous) {
  try {
    return { table: evaluateMountDoc(source), error: null };
  } catch (e) {
    return { table: previous ?? new MountTable(), error: e.message || String(e) };
  }
}
