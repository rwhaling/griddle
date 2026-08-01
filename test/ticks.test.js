import { describe, it, expect } from 'vitest';
import { evaluateMountDoc, cycleTicks } from '../src/mounts.js';
import { Clock } from '../src/clock.js';
import { makeAccessors } from '../src/visuals.js';

// ticks(n): ticks-per-beat as a per-patch declaration (0.1 doc, 2026-08-01).
// The invariant: changes what a beat means, never what a tick does.

describe('ticks(n) mount statement', () => {
  it('rescales beat-relative cycle specs; tick specs are untouched', () => {
    const t = evaluateMountDoc(
      `ticks(8)\nmount('@a', lfo(tri).cycle('2b'))\nmount('@b', lfo(tri).cycle('1bar'))\nmount('@c', lfo(tri).cycle('16t'))`,
    );
    expect(t.ticksPerBeat).toBe(8);
    expect(t.lookup('@', 0, 10).cycleTicks).toBe(16); // 2 beats × 8
    expect(t.lookup('@', 0, 11).cycleTicks).toBe(32); // 1 bar = 4 beats × 8
    expect(t.lookup('@', 0, 12).cycleTicks).toBe(16); // ticks are ticks
  });

  it('defaults to 4 and resets between evals', () => {
    evaluateMountDoc('ticks(8)');
    const t = evaluateMountDoc(`mount('@a', lfo(tri).cycle('1b'))`);
    expect(t.ticksPerBeat).toBe(4);
    expect(t.lookup('@', 0, 10).cycleTicks).toBe(4); // not leaked from prior eval
  });

  it('rejects non-divisors of 24 and post-beat-spec declaration', () => {
    expect(() => evaluateMountDoc('ticks(5)')).toThrow(/divisor of 24/);
    expect(() => evaluateMountDoc('ticks(0)')).toThrow(/divisor of 24/);
    expect(() =>
      evaluateMountDoc(`mount('@a', lfo(tri).cycle('1b'))\nticks(8)`),
    ).toThrow(/must precede/);
    // tick-only specs before ticks() are fine — nothing beat-relative resolved
    const ok = evaluateMountDoc(`mount('@a', lfo(tri).cycle('16t'))\nticks(8)`);
    expect(ok.ticksPerBeat).toBe(8);
  });

  it('the default mount doc still evaluates (beat specs under default tpb)', () => {
    expect(cycleTicks('3b')).toBe(12); // outside eval: default 4
  });
});

describe('clock and accessors follow the declaration', () => {
  it('ticks(8) + bpm(104) is tick-identical to bpm(208) at default tpb', () => {
    const clavier = new Clock({ getBpm: () => 104, getTpb: () => 8 });
    const hack = new Clock({ getBpm: () => 208 });
    expect(clavier.tickMs()).toBeCloseTo(hack.tickMs(), 10);
    expect(clavier.tickMs()).toBeCloseTo(72.115, 2); // CLAVIER at tempo 104
  });

  it('visuals beat()/bar() read the declared tpb', () => {
    const deps = (tpb) => ({
      getMachine: () => ({ metronome: 8, grid: { get: () => ({ flags: 0, letter: 0 }) } }),
      getMounts: () => null,
      getTpb: () => tpb,
      tickFrac: () => 0,
    });
    const a4 = makeAccessors(deps(4));
    const a8 = makeAccessors(deps(8));
    expect(a4.beat()).toBeCloseTo(0); // tick 8 = beat boundary at tpb 4
    expect(a8.beat()).toBeCloseTo(0); // and at tpb 8
    expect(a4.bar()).toBeCloseTo(0.5); // tick 8 = mid-bar at tpb 4
    expect(a8.bar()).toBeCloseTo(0.25); // quarter-bar at tpb 8
  });
});
