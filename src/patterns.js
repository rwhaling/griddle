// The pattern bank: 36 slots (0-z) of strudel mini-notation, compiled once per
// edit, queried as pure functions of (slot, position) by the U/V operators.
//
// Position semantics (see griddle-prototype-0.1-design.md §3.1):
//   window for position p = [ p/S , (p+1)/S ) in pattern time, Fraction-exact.
//   S = the pattern's step count (strudel _steps metadata), or the slot's
//   explicit steps override (needed for euclids: mini('x(5,8)') reports 1 step),
//   or 36 for continuous signals. Positions are NOT wrapped mod S — the driver
//   (clock mod, random, arithmetic) chooses periodicity.

import { mini } from '@strudel/mini';
import { Fraction, sine, cosine, saw, isaw, tri, square, rand, perlin } from '@strudel/core';
import { RADIX } from './values.js';

// continuous signals aren't expressible in mini-notation, so slots whose code
// is exactly a signal name get the signal directly: V samples it as a
// 36-entry wavetable (position = phase in 36ths of a cycle), U never bangs
const SIGNALS = { sine, cosine, saw, isaw, tri, square, rand, perlin };

// bang mode treats these hap values as "no bang"; note that 'f' means false
// here but 15 in value mode — mode-dependent reading, by design
const FALSY = new Set([false, 0, 'f', 'false', '~', '']);

const coerceValue = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return ((Math.round(v) % RADIX) + RADIX) % RADIX;
  }
  if (typeof v === 'string') {
    if (/^[0-9a-zA-Z]$/.test(v)) {
      const n = parseInt(v.toLowerCase(), 36);
      return n < RADIX ? n : null;
    }
    const n = Number(v);
    if (Number.isFinite(n)) return ((Math.round(n) % RADIX) + RADIX) % RADIX;
  }
  return null;
};

// continuous signals are 0..1 (sine, rand, perlin); scale to 0..35
const coerceSignal = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(RADIX - 1, Math.floor(v * RADIX)));
};

export class PatternBank {
  constructor() {
    this.slots = Array.from({ length: RADIX }, () => ({
      code: '',
      stepsOverride: null,
      pattern: null,
      autoSteps: null,
      error: null,
    }));
  }

  setSlot(index, code, stepsOverride = null) {
    const slot = this.slots[index];
    slot.code = code;
    slot.stepsOverride = stepsOverride;
    slot.pattern = null;
    slot.autoSteps = null;
    slot.error = null;
    if (!code.trim()) return slot;
    const signal = SIGNALS[code.trim()];
    if (signal) {
      slot.pattern = signal;
      return slot; // no autoSteps: signals default to 36 (wavetable phase)
    }
    try {
      const pattern = mini(code);
      // probe one cycle so parse/runtime errors surface at edit time
      pattern.queryArc(0, 1);
      slot.pattern = pattern;
      const s = pattern._steps !== undefined && pattern._steps !== null ? Number(pattern._steps) : NaN;
      slot.autoSteps = Number.isFinite(s) && s >= 1 ? Math.round(s) : null;
    } catch (e) {
      slot.error = e.message || String(e);
    }
    return slot;
  }

  steps(index) {
    const slot = this.slots[index];
    return slot.stepsOverride ?? slot.autoSteps ?? RADIX;
  }

  query(index, pos) {
    const slot = this.slots[index];
    if (!slot?.pattern) return null;
    const S = this.steps(index);
    try {
      return slot.pattern.queryArc(Fraction(pos).div(S), Fraction(pos + 1).div(S));
    } catch {
      return null;
    }
  }

  // U: does the window at this position contain an onset with a truthy value?
  bang(index, pos) {
    const haps = this.query(index, pos);
    if (!haps) return false;
    return haps.some((h) => h.hasOnset() && !FALSY.has(h.value));
  }

  // V: earliest onset's value coerced to base-36; continuous signals sampled;
  // rest (no haps) -> null, which the V operator writes as NONE
  value(index, pos) {
    const haps = this.query(index, pos);
    if (!haps || haps.length === 0) return null;
    const onsets = haps
      .filter((h) => h.hasOnset())
      .sort((a, b) => a.part.begin.valueOf() - b.part.begin.valueOf());
    if (onsets.length > 0) return coerceValue(onsets[0].value);
    const continuous = haps.find((h) => h.whole === undefined);
    if (continuous) return coerceSignal(continuous.value);
    return null; // only tails of earlier events: not an onset, not a signal
  }
}
