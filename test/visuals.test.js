import { describe, it, expect } from 'vitest';
import { evaluateMountDoc, lfoValue01, DEFAULT_MOUNT_DOC } from '../src/mounts.js';
import { makeAccessors, evalVisuals, DEFAULT_VISUALS_DOC } from '../src/visuals.js';
import { makeFlags, TYPE } from '../src/values.js';

// doc ten: the headless surface — pure accessors and the off-path. The
// hydra engine itself is GPU/DOM and stays untested here (loaded lazily,
// never imported by these paths).

describe('lfoValue01 (the gval read)', () => {
  const table = evaluateMountDoc(DEFAULT_MOUNT_DOC);

  it('reads a beat-synced tri mount: in range, moving, periodic', () => {
    const art = table.lookup('@', 0, 0); // @0: tri, cycle 0.5b = 2 ticks
    expect(art.kind).toBe('lfo');
    const vals = [0, 0.5, 1, 1.5].map((t) => lfoValue01(art, t));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(new Set(vals.map((v) => v.toFixed(3))).size).toBeGreaterThan(1); // moves
    expect(lfoValue01(art, 0.25)).toBeCloseTo(lfoValue01(art, 2.25), 5); // period 2 ticks
  });

  it('null/non-lfo art reads as 0', () => {
    expect(lfoValue01(null, 3)).toBe(0);
    expect(lfoValue01({ kind: 'pattern' }, 3)).toBe(0);
  });
});

describe('visuals accessors', () => {
  const cell = (letter) => ({ flags: makeFlags(TYPE.LITERAL), letter });
  const none = { flags: 0, letter: 0 };
  const deps = {
    getMachine: () => ({
      metronome: 10,
      grid: { get: (x, y) => (x === 3 && y === 2 ? cell(7) : none) },
    }),
    getMounts: () => evaluateMountDoc(DEFAULT_MOUNT_DOC),
    tickFrac: () => 0.5,
  };
  const a = makeAccessors(deps);

  it('tick/beat/bar interpolate through tickFrac', () => {
    expect(a.tick()).toBeCloseTo(10.5);
    expect(a.beat()).toBeCloseTo((10.5 / 4) % 1);
    expect(a.bar()).toBeCloseTo((10.5 / 16) % 1);
  });

  it('gval accepts sigil or bare slot, unknown reads 0', () => {
    expect(a.gval('@0')).toBeCloseTo(a.gval('0'));
    expect(a.gval('@nope')).toBe(0);
  });

  it('gcell reads literals, 0 elsewhere', () => {
    expect(a.gcell(3, 2)).toBe(7);
    expect(a.gcell(0, 0)).toBe(0);
  });
});

describe('evalVisuals off-path (no engine load)', () => {
  it('comment-only source resolves inactive without touching hydra', async () => {
    const res = await evalVisuals(DEFAULT_VISUALS_DOC);
    expect(res.active).toBe(false);
  });
});
