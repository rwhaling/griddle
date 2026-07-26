import { describe, it, expect } from 'vitest';
import {
  prepass, decodeLabel, cycleTicks, spread, evaluateMountDoc, tryEvaluate, lfo,
} from '../src/mounts.js';

describe('sigil pre-pass', () => {
  it('rewrites @ labels at line starts, one and two glyphs', () => {
    expect(prepass('@a: lfo(sine)')).toBe('$__at_a: lfo(sine)');
    expect(prepass('  @2f : lfo(tri)')).toBe('  $__at_2f : lfo(tri)');
    expect(prepass('$1: "0 2 4"')).toBe('$__dollar_1: "0 2 4"');
  });

  it('leaves @ inside strings and mid-line untouched', () => {
    expect(prepass('const s = "@a: not a label"')).toBe('const s = "@a: not a label"');
    expect(prepass('foo(x); @a: y')).toBe('foo(x); @a: y'); // mid-line: not rewritten
  });

  it('decodes round-trip', () => {
    expect(decodeLabel('$__at_2f')).toEqual({ sigil: '@', ref: '2f' });
    expect(decodeLabel('$__dollar_a')).toEqual({ sigil: '$', ref: 'a' });
    expect(decodeLabel('other')).toBeNull();
  });
});

describe('cycle specs', () => {
  it('parses ticks, beats, bars, bare numbers', () => {
    expect(cycleTicks('16t')).toBe(16);
    expect(cycleTicks('3.5b')).toBe(14);
    expect(cycleTicks('2bar')).toBe(32);
    expect(cycleTicks(4)).toBe(16);
  });

  it('rejects garbage at mount time', () => {
    expect(() => cycleTicks('4hz')).toThrow(/bad cycle spec/);
  });

  it('spread is geometric between endpoints', () => {
    const s = spread('1b', '16b', 3).map((x) => parseFloat(x));
    expect(s[0]).toBeCloseTo(4);
    expect(s[1]).toBeCloseTo(16);
    expect(s[2]).toBeCloseTo(64);
  });
});

describe('mount document evaluation', () => {
  it('mounts labeled lfos, global and device-qualified, with lookup fallback', () => {
    const table = evaluateMountDoc(`
      @a: lfo(tri).cycle("4b").range(40, 90)
      @2a: lfo(saw).cycle("16t")
    `);
    expect(table.entries.size).toBe(2);
    const global = table.lookup('@', 5, 10); // device 5 slot a: no @5a -> @a
    expect(global.range).toEqual([40, 90]);
    expect(global.cycleTicks).toBe(16);
    const scoped = table.lookup('@', 2, 10); // device 2 slot a -> @2a
    expect(scoped.cycleTicks).toBe(16);
    expect(scoped.range).toEqual([0, 127]); // default
    expect(table.lookup('@', 0, 11)).toBeNull(); // slot b unmounted
  });

  it('devices() populates the map; null is a legal black hole', () => {
    const table = evaluateMountDoc(`devices({ 0: "IAC Bus 1", 3: null })`);
    expect(table.deviceMap[0]).toBe('IAC Bus 1');
    expect(table.deviceMap[3]).toBeNull();
  });

  it('mount() and plain JS loops work (bulk definition)', () => {
    const table = evaluateMountDoc(`
      spread("1b", "32b", 4).forEach((c, i) =>
        mount('@' + "wxyz"[i], lfo(sine).cycle(c)))
    `);
    expect(table.entries.size).toBe(4);
    const cycles = ['w', 'x', 'y', 'z'].map((s) => table.entries.get('@' + s).cycleTicks);
    expect(cycles[0]).toBeCloseTo(4);
    expect(cycles[3]).toBeCloseTo(128);
    for (let i = 1; i < 4; i++) expect(cycles[i]).toBeGreaterThan(cycles[i - 1]);
  });

  it('builder is immutable: shared base defs do not cross-contaminate', () => {
    const table = evaluateMountDoc(`
      const base = lfo(sine).range(40, 90)
      @a: base.cycle("1b")
      @b: base.cycle("8b")
    `);
    expect(table.entries.get('@a').cycleTicks).toBe(4);
    expect(table.entries.get('@b').cycleTicks).toBe(32);
    expect(table.entries.get('@a').range).toEqual([40, 90]);
  });

  it('multi-line chained definitions parse (labels span statements)', () => {
    const table = evaluateMountDoc(`@a: lfo(tri)\n  .cycle("2b")\n  .range(10, 20)`);
    expect(table.entries.get('@a').range).toEqual([10, 20]);
  });

  it('tryEvaluate retains last-good table on error', () => {
    const first = tryEvaluate(`@a: lfo(sine)`, null);
    expect(first.error).toBeNull();
    const second = tryEvaluate(`@a: lfo(sine).cycle("4hz")`, first.table);
    expect(second.error).toMatch(/bad cycle spec/);
    expect(second.table.entries.get('@a')).toBeTruthy(); // last-good retained
  });

  it('rejects $ pattern mounts for now with a clear message', () => {
    const { error } = tryEvaluate(`$a: "0 2 4"`, null);
    expect(error).toMatch(/not yet implemented|pattern/i);
  });
});

describe('shape compilation', () => {
  const compile = (src) => evaluateMountDoc(src).entries.get('@a');

  it('signals sample to breakpoint tables spanning [0,1]', () => {
    const t = compile(`@a: lfo(sine)`).table;
    expect(t[0][0]).toBe(0);
    expect(t[t.length - 1][0]).toBe(1);
    const peak = t.reduce((m, p) => Math.max(m, p[1]), 0);
    const trough = t.reduce((m, p) => Math.min(m, p[1]), 1);
    expect(peak).toBeGreaterThan(0.99);
    expect(trough).toBeLessThan(0.01);
    // sine starts at 0.5
    expect(t[0][1]).toBeCloseTo(0.5, 1);
  });

  it('tri and saw have the expected silhouettes', () => {
    const triT = compile(`@a: lfo(tri)`).table;
    const mid = triT.find(([p]) => Math.abs(p - 0.5) < 0.01);
    expect(mid[1]).toBeGreaterThan(0.98); // peak at half phase
    const sawT = compile(`@a: lfo(saw)`).table;
    expect(sawT[1][1]).toBeGreaterThan(sawT[0][1]); // rising
  });

  it('mini-notation strings become step tables (pattern-as-shape)', () => {
    const t = compile(`@a: lfo("0 z")`).table;
    // step from 0 to 1 at phase 0.5, with a vertical edge (duplicated phase)
    expect(t[0]).toEqual([0, 0]);
    const edge = t.filter(([p]) => Math.abs(p - 0.5) < 1e-9);
    expect(edge.length).toBe(2);
    expect(edge[0][1]).toBe(0);
    expect(edge[1][1]).toBe(1);
    expect(t[t.length - 1]).toEqual([1, 1]);
  });

  it('noise compiles procedural (no table), smooth carried', () => {
    const a = compile(`@a: lfo(noise).smooth(0.5)`);
    expect(a.procedural).toBe('noise');
    expect(a.table).toBeNull();
    expect(a.smooth).toBe(0.5);
  });

  it('mod declarations validate at mount time', () => {
    expect(compile(`@a: lfo(tri).mod('depth')`).mod).toEqual({ name: 'depth', args: [] });
    const { error } = tryEvaluate(`@a: lfo(tri).mod('wobble')`, null);
    expect(error).toMatch(/unknown mod/);
  });
});

describe('default mount document', () => {
  it('mounts all 36 slots as a coarse frequency knob on the old curve', async () => {
    const { DEFAULT_MOUNT_DOC } = await import('../src/mounts.js');
    const table = evaluateMountDoc(DEFAULT_MOUNT_DOC);
    expect(table.entries.size).toBe(36);
    expect(table.entries.get('@8').cycleTicks).toBe(256); // old rate 8
    expect(table.entries.get('@1').cycleTicks).toBe(4); // old rate 1: one beat
    expect(table.entries.get('@0').cycleTicks).toBe(4 * 36 * 36); // map_zero
    expect(table.entries.get('@z').cycleTicks).toBe(4 * 35 * 35);
  });
});
