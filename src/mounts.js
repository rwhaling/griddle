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
import { tableValue, intHash, NOISE_STEPS } from './modulation.js';

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
// forgiveness for strudel muscle memory: a double-quoted "4b" arrives as a
// mini pattern — unwrap its single value when it looks like a plain token
const unwrapToken = (x) => {
  if (!isStrudelPattern(x)) return x;
  try {
    const haps = x.queryArc(0, 1);
    if (haps.length === 1 && (typeof haps[0].value === 'string' || typeof haps[0].value === 'number')) {
      return haps[0].value;
    }
  } catch {
    /* fall through to the quote-convention error */
  }
  return x;
};

// ticks-per-beat during document evaluation: ticks(n) sets it, beat-relative
// cycle specs consume it. Reset per eval; outside eval the default holds.
let evalTpb = TICKS_PER_BEAT;
let beatSpecUsed = false;

export function cycleTicks(spec) {
  spec = unwrapToken(spec);
  if (typeof spec === 'number') {
    beatSpecUsed = true;
    return spec * evalTpb;
  }
  if (isStrudelPattern(spec)) {
    throw new Error("cycle spec got a pattern — use single quotes: .cycle('4b') (double quotes are mini-notation)");
  }
  const m = /^\s*([\d.]+)\s*(t|b|bar)\s*$/.exec(String(spec));
  if (!m) throw new Error(`bad cycle spec: ${JSON.stringify(spec)} (use '16t' / '3.5b' / '2bar')`);
  const n = parseFloat(m[1]);
  if (m[2] !== 't') beatSpecUsed = true;
  return m[2] === 't' ? n : m[2] === 'b' ? n * evalTpb : n * 4 * evalTpb;
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
    name = unwrapToken(name);
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
    this._oneshot = false;
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

  // oneshot lifecycle (doc seven §11): armed until an adjacent bang, then
  // exactly one cycle of flight at the declared duration, then re-arm.
  oneshot() {
    const d = this._clone();
    d._oneshot = true;
    return d;
  }

  mod(name, ...args) {
    name = unwrapToken(name);
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
    if (this._oneshot) {
      if (this._cycle === null) throw new Error('.oneshot() needs .cycle(d) — a oneshot plays one cycle per trig');
      if (this._sync) throw new Error('.oneshot() rejects .sync() — a oneshot has no standing phase to anchor');
    }
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
      oneshot: this._oneshot,
    };
  }
}

export const pat = (p) => new PatternDef(p);

// Pattern.prototype extensions — ONLY names verified free of strudel claims
// (note/vel/oct/sync collide with strudel controls, so they live on the
// wrapper: start a griddle chain with cycle/gsteps/base/mod or pat()).
for (const name of ['cycle', 'gsteps', 'base', 'mod', 'oneshot']) {
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
// Narrowed 2026-08-02: numeric 0 is DATA, not a rest — the same stance the
// & presence-conjunction takes. Only explicit boolean falses (mini t/f
// patterns produce real haps at f steps) fail to strike; numeric patterns
// write rests as '~' (no hap, nothing to strike).
const FALSY = new Set([false, 'f', 'false', '~', '']);
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

// An @-mount LFO's value in [0,1] at a fractional tick t — the pure read
// behind the visuals accessor gval() (doc ten §5). Uses the transport-
// anchored phase formula, which matches a free-running F from reset when
// its ports are unmodded; port mods (rate/depth/skew...) are per-operator
// state and deliberately out of scope here.
export function lfoValue01(art, t) {
  if (!art || art.kind !== 'lfo') return 0;
  const a = t / art.cycleTicks + art.phase0;
  if (art.procedural) return intHash(Math.floor(a * NOISE_STEPS));
  return tableValue(art.table, a);
}

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

// per-hap channel (2026-08-02): the channel port is the default, a hap
// carrying .channel() overrides — one pattern can address a whole kit
export function channelFromValue(value, fallback) {
  if (value && typeof value === 'object' && value.channel != null) {
    const c = Number(value.channel);
    if (Number.isFinite(c)) return Math.max(0, Math.min(RADIX - 1, Math.round(c)));
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// mount table: device-qualified lookup, specific ?? global
// ---------------------------------------------------------------------------
export class MountTable {
  constructor() {
    this.entries = new Map(); // '@a' | '@2a' -> artifact
    // logical device -> route. String = MIDI output name, null = black hole,
    // object/function/array = synth definition (doc nine). Channel-qualified
    // keys 'd.c' hold per-channel synth defs.
    this.deviceMap = {};
    this.bpm = null; // set by a bpm() statement; null = widget rules
    this.ticksPerBeat = TICKS_PER_BEAT; // set by ticks(n); a declaration, not a knob
    this.gridSize = null; // set by grid(w, h); null = unchanged
    this.source = '';
    this.errors = [];
  }

  // F with device port d, slot s: '@<d><s>' ?? '@<s>'
  lookup(sigil, device, slot) {
    const d = device.toString(36);
    const s = slot.toString(36);
    return this.entries.get(sigil + d + s) ?? this.entries.get(sigil + s) ?? null;
  }

  // synth definition for a note event: 'd.c' ?? 'd' (doc nine §3), channel
  // folded mod 16 (MIDI symmetry). Returns null when the device routes to
  // MIDI (string), a black hole (null), or nowhere.
  synthDef(device, channel) {
    const d = device.toString(36);
    const c = (((channel | 0) % 16) + 16) % 16;
    const specific = this.deviceMap[`${d}.${c.toString(36)}`];
    if (isSynthDef(specific)) return specific;
    const general = this.deviceMap[d];
    return isSynthDef(general) ? general : null;
  }

  hasSynthDefs() {
    return Object.values(this.deviceMap).some(isSynthDef);
  }
}

const isSynthDef = (v) =>
  typeof v === 'function' || Array.isArray(v) || (typeof v === 'object' && v !== null);

// friendly filter aliases -> superdough's raw parameter names (the alias
// layer normally lives in @strudel/core's controls, which v1 bypasses)
const CONTROL_ALIASES = { lpf: 'cutoff', hpf: 'hcutoff', bpf: 'bandf', bpq: 'bandq', hpq: 'hresonance', lpq: 'resonance' };

// doc nine §4: resolve a synth definition against a strike. Pure — takes the
// note context, returns the list of superdough controls objects (one per
// layer). The caller owns scheduling and the superdough call.
export function resolveSynthControls(def, ctx) {
  let resolved = typeof def === 'function' ? def(ctx.note, ctx.velocity, ctx.durTicks) : def;
  if (resolved == null) return [];
  const layers = [resolved].flat();
  return layers.map((layer) => {
    const controls = {};
    for (const [k, v] of Object.entries(layer)) controls[CONTROL_ALIASES[k] ?? k] = v;
    // the grid speaks for the note; layers with an explicit freq pin their
    // own pitch (superdough prefers freq over note — drum layers use this)
    controls.note = controls.note ?? ctx.note;
    controls.gain = (Number(layer.gain ?? 1) || 0) * (ctx.velocity / 127);
    return controls;
  });
}

// slot refs for mountSignal/mountPattern: number 0-35, one base36 char, or
// device-qualified two chars ('2a')
const normalizeSlotRef = (ref, fn) => {
  ref = unwrapToken(ref);
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < 36) {
    return ref.toString(36);
  }
  if (typeof ref === 'string' && /^[0-9a-z]{1,2}$/.test(ref)) return ref;
  throw new Error(`${fn}: bad slot ref ${JSON.stringify(ref)} (0-35, 'a', or device-qualified '2a')`);
};

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
  evalTpb = TICKS_PER_BEAT; // ticks(n) may redeclare, before any beat spec
  beatSpecUsed = false;

  const scope = {
    // griddle
    lfo,
    spread,
    devices: (map) => {
      for (const [k, v] of Object.entries(map)) {
        if (!/^[0-9a-z](\.[0-9a-f])?$/.test(k)) {
          throw new Error(`devices(): bad key '${k}' (device 0-z, optional channel .0-.f)`);
        }
        // string = MIDI output, null = black hole, object/function/array =
        // synth definition (doc nine; kept verbatim, resolved per strike)
        if (v === null) table.deviceMap[k] = null;
        else if (typeof v === 'function' || Array.isArray(v) || typeof v === 'object') table.deviceMap[k] = v;
        else table.deviceMap[k] = unwrapToken(v);
      }
    },
    // patch-as-code initializers: applied by the host after a successful
    // eval; the toolbar widgets remain live nudgers (statement wins at eval)
    bpm: (n) => {
      n = Number(unwrapToken(n));
      if (!Number.isFinite(n) || n < 20 || n > 300) throw new Error(`bpm(${n}): expected 20..300`);
      table.bpm = n;
    },
    // ticks-per-beat declaration (default 4). Divisors of 24 only: keeps
    // future MIDI-clock pulses-per-tick integer, allows triplet grids.
    // Changes what a beat means, never what a tick does.
    ticks: (n) => {
      n = Number(unwrapToken(n));
      if (![1, 2, 3, 4, 6, 8, 12, 24].includes(n)) {
        throw new Error(`ticks(${n}): expected a divisor of 24 (1,2,3,4,6,8,12,24)`);
      }
      if (beatSpecUsed) {
        throw new Error('ticks() must precede beat-relative mounts (their cycle specs resolve when mounted)');
      }
      evalTpb = n;
      table.ticksPerBeat = n;
    },
    grid: (w, h) => {
      w = Math.round(Number(w));
      h = Math.round(Number(h));
      if (!(w >= 8 && w <= 128 && h >= 8 && h <= 64)) {
        throw new Error(`grid(${w}, ${h}): expected 8..128 x 8..64`);
      }
      table.gridSize = { w, h };
    },
    // legacy sigil form — kept parsing forever for saved patches; all
    // generated and documented text uses mountSignal/mountPattern instead
    mount: (ref, def) => {
      ref = unwrapToken(ref);
      if (typeof ref !== 'string' || !/^[@$][0-9a-z]{1,2}$/.test(ref)) {
        throw new Error(`bad mount ref: ${ref} (use mountSignal/mountPattern, or legacy '@a' / '$2f')`);
      }
      if (ref[0] === '@') {
        if (!(def instanceof LfoDef)) throw new Error(`${ref}: @ mounts take lfo(...) definitions`);
        table.entries.set(ref, def.compile());
      } else {
        const pd = def instanceof PatternDef ? def : new PatternDef(def);
        table.entries.set(ref, pd.compile());
      }
    },
    // sigil-free refs (2026-08-01): slot as number 0-35 or char '0'-'z',
    // device-qualified as two chars '2a'. The table is implied by the type —
    // signals feed F, patterns feed U/V. Internal keys keep the sigils.
    mountSignal: (ref, def) => {
      if (!(def instanceof LfoDef)) throw new Error('mountSignal takes lfo(...) definitions');
      table.entries.set('@' + normalizeSlotRef(ref, 'mountSignal'), def.compile());
    },
    mountPattern: (ref, def) => {
      if (def instanceof LfoDef) throw new Error('mountPattern takes patterns — use mountSignal for lfo(...)');
      const pd = def instanceof PatternDef ? def : new PatternDef(def);
      table.entries.set('$' + normalizeSlotRef(ref, 'mountPattern'), pd.compile());
    },
    pat,
    // the mini plugin rewrites double-quoted strings to m(str, ...locations);
    // strings that aren't valid mini-notation stay plain strings, so
    // mount("@b", ...) and friends survive strudel-style double quotes
    m: (str) => {
      try {
        return mini(str);
      } catch {
        return str;
      }
    },
    // strudel shapes + a curated slice of the combinator/control surface
    sine, cosine, saw, isaw, tri, square, perlin, rand,
    noise: 'noise',
    mini,
    ...Object.fromEntries(
      ['cat', 'stack', 'seq', 'sequence', 'fastcat', 'slowcat', 'silence', 'note', 'n', 'run', 'irand', 'choose', 'channel', 'velocity']
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
    evalTpb = TICKS_PER_BEAT; // don't leak a patch's declaration out of eval
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

// signal slots (read by F) · slots are numbers 0-35 or chars '0'-'z'
// 0-9: beat-synced (period = n beats, 0 = half), phase-locked
for (let n = 0; n < 10; n++)
  mountSignal(n, lfo(tri).cycle(n || 0.5).sync().mod('rate', 0.5, 2))

// slots a-z: slow free-running spread, 2 bars .. 128 bars · mod = fine rate
spread('2bar', '128bar', 26).forEach((c, i) =>
  mountSignal(i + 10, lfo(tri).cycle(c).mod('rate', 0.5, 2)))

// pattern slots (read by U/V) · euclidean tables (positional: drive = position)
// 1-8: x(n,8) · 9: x(9,16) · a-p: x(1..16,16) · q-z: x(1..10,12) · 0: silence
// (single-quoted concat: backticks are mini-notation here, like double quotes)
for (let n = 1; n <= 8; n++) mountPattern(n, pat('x(' + n + ',8)').gsteps(8))
mountPattern(9, pat('x(9,16)').gsteps(16))
for (let n = 1; n <= 16; n++) mountPattern(n + 9, pat('x(' + n + ',16)').gsteps(16))
for (let n = 1; n <= 10; n++) mountPattern(n + 25, pat('x(' + n + ',12)').gsteps(12))
mountPattern(0, pat('~').gsteps(8))

// synth device z — built-in superdough voices, no MIDI needed (doc nine)
// point a Z at device z; channel picks the voice; layers = osc+noise drums
devices({
  'z.0': { s: 'sine', decay: 0.35, sustain: 0.4, release: 0.08 },
  'z.1': (n, v, d) => ({ s: 'triangle', lpf: 700 + v * 14, lpenv: 3.5, lpdecay: 0.12, lpq: 5, decay: 0.3, sustain: 0 }),
  'z.2': { s: 'supersaw', unison: 5, spread: 0.7, detune: 0.2, lpf: 2600, decay: 0.4, sustain: 0.5, release: 0.12 },
  'z.3': [{ s: 'sine', freq: 50, penv: 26, pdecay: 0.07, decay: 0.4, sustain: 0 },
          { s: 'white', lpf: 4000, decay: 0.05, sustain: 0, gain: 0.45 }],
  'z.4': [{ s: 'triangle', freq: 440, decay: 0.06, sustain: 0 },
          { s: 'white', bpf: 2200, bpq: 8, decay: 0.03, sustain: 0, gain: 0.6 }],
  'z.5': { s: 'white', hpf: 8500, decay: 0.04, sustain: 0, release: 0.02 },
})

// overrides go below, e.g.:
// mountSignal('p', lfo(tri).cycle('196t').phase(0.42))
// mountPattern('b', note("c3 [e3 g3] a2 <g3 b3>").cycle('2b').vel(85))
`;

// convenience: evaluate with last-good retention + error capture
export function tryEvaluate(source, previous) {
  try {
    return { table: evaluateMountDoc(source), error: null };
  } catch (e) {
    return { table: previous ?? new MountTable(), error: e.message || String(e) };
  }
}
