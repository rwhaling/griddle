// API probe — verifies our assumptions about strudel's mini/core surface.
import { describe, it, expect } from 'vitest';
import { mini } from '@strudel/mini';
import { Fraction, sine } from '@strudel/core';

describe('strudel API probe', () => {
  it('reports steps and per-cycle haps', () => {
    const p = mini('0 2 4 <7 9> 4 2');
    console.log('steps:', String(p._steps));
    console.log('c0:', p.queryArc(0, 1).map((h) => `${h.value}@${h.part.begin.toFraction()}`).join(' '));
    console.log('c1:', p.queryArc(1, 2).map((h) => `${h.value}@${h.part.begin.toFraction()}`).join(' '));
    expect(Number(p._steps)).toBe(6);
  });

  it('shows how booleans parse', () => {
    const t = mini('t f x ~ 1 0');
    console.log('bool values:', t.queryArc(0, 1).map((h) => JSON.stringify(h.value)).join(' '));
  });

  it('euclid onsets', () => {
    const e = mini('x(5,8)');
    console.log(
      'euclid onsets:',
      e.queryArc(0, 1).filter((h) => h.hasOnset()).map((h) => h.part.begin.toFraction()).join(' '),
      '| steps:', String(e._steps),
    );
  });

  it('samples a signal over a fractional window', () => {
    const haps = sine.queryArc(Fraction(9).div(36), Fraction(10).div(36));
    console.log('sine [9/36,10/36):', JSON.stringify(haps.map((h) => ({ v: +h.value.toFixed(3), continuous: h.whole === undefined }))));
    expect(haps.length).toBeGreaterThan(0);
    expect(haps[0].whole).toBeUndefined();
  });

  it('rests produce no haps', () => {
    const q = mini('0 ~ 5 7');
    console.log('with rest:', q.queryArc(0, 1).map((h) => `${JSON.stringify(h.value)}@${h.part.begin.toFraction()}`).join(' '));
    expect(q.queryArc(0, 1).length).toBe(3);
  });
});
