import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { charToCell, cellToChar } from '../src/values.js';
import {
  FULL, PHASE, cc7, face1296, targetInternal, glideStep, lfoInc,
  triAt, lfoPieces, scaleV, crossings,
} from '../src/modulation.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));
const clear = (m, x, y) => m.grid.set(x, y, { flags: 0, letter: 0 });
const charAt = (m, x, y) => {
  const c = m.grid.get(x, y);
  return cellToChar(c.flags, c.letter);
};

describe('modulation math (pure)', () => {
  it('target scaling reaches exact full scale (×37 resolution of §9.5)', () => {
    expect(targetInternal(0)).toBe(0);
    expect(targetInternal(35)).toBe(FULL);
    expect(cc7(targetInternal(35))).toBe(127);
    expect(cc7(0)).toBe(0);
  });

  it('quadratic glide step: full scale in r² ticks', () => {
    expect(glideStep(0)).toBe(FULL); // instant
    expect(glideStep(1)).toBe(FULL);
    expect(glideStep(6)).toBe(Math.round(FULL / 36));
    expect(glideStep(35)).toBe(Math.round(FULL / 1225));
  });

  it('triangle: 0 at phase 0, FULL at half, symmetric', () => {
    expect(triAt(0)).toBe(0);
    expect(triAt(PHASE / 2)).toBe(FULL);
    expect(triAt(PHASE / 4)).toBe(FULL / 2);
    expect(triAt((3 * PHASE) / 4)).toBe(FULL / 2);
  });

  it('lfoPieces splits at a fold and keeps frac continuity', () => {
    const inc = lfoInc(1); // PHASE/4
    const start = PHASE / 2 - inc / 2; // straddles the peak
    const pieces = lfoPieces(start, inc);
    expect(pieces.length).toBe(2);
    expect(pieces[0].v1).toBe(FULL); // peak
    expect(pieces[1].v0).toBe(FULL);
    expect(pieces[0].f1).toBeCloseTo(pieces[1].f0);
    expect(pieces[0].f0).toBe(0);
    expect(pieces[1].f1).toBe(1);
  });

  it('crossings: full rising sweep hits every 7-bit boundary once, in order', () => {
    const { events, lastCC } = crossings([{ v0: 0, v1: FULL, f0: 0, f1: 1 }], 0);
    expect(events.length).toBe(127);
    expect(events[0].value7).toBe(1);
    expect(events[126].value7).toBe(127);
    expect(lastCC).toBe(127);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].frac).toBeGreaterThan(events[i - 1].frac);
    }
  });

  it('crossings: falling sweep and stall dedupe', () => {
    const down = crossings([{ v0: FULL, v1: 0, f0: 0, f1: 1 }], 127);
    expect(down.events.length).toBe(127);
    expect(down.events[0].value7).toBe(126);
    expect(down.events[126].value7).toBe(0);
    const stall = crossings([{ v0: 1000, v1: 1000, f0: 0, f1: 1 }], cc7(1000));
    expect(stall.events.length).toBe(0);
  });

  it('crossings announce initial value once when lastCC is null', () => {
    const { events } = crossings([{ v0: FULL / 2, v1: FULL / 2, f0: 0, f1: 1 }], null);
    expect(events.length).toBe(1);
    expect(events[0].value7).toBe(cc7(FULL / 2));
    expect(events[0].frac).toBe(0);
  });

  it('scaleV maps into [lo,hi] and inverts when lo > hi', () => {
    expect(scaleV(0, 1000, 2000)).toBe(1000);
    expect(scaleV(FULL, 1000, 2000)).toBe(2000);
    expect(scaleV(0, 2000, 1000)).toBe(2000); // inverted
    expect(scaleV(FULL, 2000, 1000)).toBe(1000);
  });
});

// G at (4,1): dev(5)... omitted, ch(4)... omitted where possible;
// layout helper places controller/target/rate west of the glyph.
const glideMachine = ({ ctrl = null, target = '0', rate = '1' } = {}) => {
  const m = new Machine(12, 8, null);
  if (ctrl !== null) place(m, 3, 1, ctrl); // controller west(3) of G at (6,1)
  place(m, 4, 1, target); // target west(2)
  place(m, 5, 1, rate); // rate west(1)
  place(m, 6, 1, 'G');
  return m;
};

describe('G — glide operator', () => {
  it('initializes at target (no surprise sweep) and holds', () => {
    const m = glideMachine({ target: 'k' }); // k = 20
    m.step();
    const face = face1296(targetInternal(20));
    expect(charAt(m, 6, 2)).toBe(Math.floor(face / 36).toString(36));
    expect(charAt(m, 7, 2)).toBe((face % 36).toString(36));
  });

  it('converges to a new target in r² ticks (±1 for step rounding) and clamps', () => {
    const m = glideMachine({ target: '0', rate: '6' }); // r²=36 ticks full-scale
    m.step(); // init at 0
    place(m, 4, 1, 'z'); // retarget to max
    for (let i = 0; i < 36; i++) m.step();
    expect(charAt(m, 6, 2)).toBe('z'); // coarse byte arrived
    m.step(); // step rounds down, so full fine precision lands one tick later
    expect(charAt(m, 6, 2)).toBe('z');
    expect(charAt(m, 7, 2)).toBe('z'); // face1296(FULL) = 1295 = (35,35)
    m.step(); // clamped, no overshoot
    expect(charAt(m, 7, 2)).toBe('z');
  });

  it('emits one CC crossing per 7-bit boundary with increasing fracs', () => {
    const m = glideMachine({ ctrl: '7', target: '0', rate: '1' });
    m.step(); // init at 0; announces initial value 0
    expect(m.ccEvents.length).toBe(1);
    expect(m.ccEvents[0]).toMatchObject({ controller: 7, value7: 0 });
    place(m, 4, 1, 'z');
    m.step(); // full sweep in one tick (r=1)
    expect(m.ccEvents.length).toBe(127);
    expect(m.ccEvents[0].value7).toBe(1);
    expect(m.ccEvents[126].value7).toBe(127);
  });

  it('is a pure grid modulator when unaddressed (opt-in by addressing)', () => {
    const m = glideMachine({ ctrl: null, target: 'z' });
    m.step();
    expect(m.ccEvents.length).toBe(0);
    expect(charAt(m, 6, 2)).toBe('z'); // face still written
  });

  it('bang snaps to target with a single CC edge', () => {
    const m = glideMachine({ ctrl: '7', target: '0', rate: 'z' });
    m.step(); // init at 0
    place(m, 4, 1, 'z'); // far target, glacial rate
    place(m, 6, 0, '!'); // bang north of G
    m.step();
    const edges = m.ccEvents.filter((e) => e.controller === 7);
    expect(edges.length).toBe(1);
    expect(edges[0].value7).toBe(127);
    expect(edges[0].frac).toBe(0);
    expect(charAt(m, 6, 2)).toBe('z');
  });

  it('unpowered G is frozen even when banged', () => {
    const m = glideMachine({ target: 'z' });
    m.step();
    // toggle power off, retarget, bang — nothing should move
    const cell = m.grid.get(6, 1);
    m.grid.set(6, 1, { flags: cell.flags & ~0b100000, letter: cell.letter });
    place(m, 4, 1, '0');
    place(m, 6, 0, '!');
    m.step();
    expect(charAt(m, 6, 2)).toBe('z'); // face unchanged from before freeze
  });
});

// F at (8,1): min west(4)=(4,1), max west(3)=(5,1), rate west(2)=(6,1),
// offset west(1)=(7,1); controller west(5)=(3,1)
const lfoMachine = ({ ctrl = null, min = null, max = null, rate = '1', offset = '0' } = {}) => {
  const m = new Machine(12, 8, null);
  if (ctrl !== null) place(m, 3, 1, ctrl);
  if (min !== null) place(m, 4, 1, min);
  if (max !== null) place(m, 5, 1, max);
  place(m, 6, 1, rate);
  place(m, 7, 1, offset);
  place(m, 8, 1, 'F');
  return m;
};

const faceValue = (m, x, y) => {
  const coarse = parseInt(charAt(m, x, y), 36);
  const fine = parseInt(charAt(m, x + 1, y), 36);
  return coarse * 36 + fine;
};

describe('F — LFO operator', () => {
  it('runs a triangle: rises to peak at half period', () => {
    const m = lfoMachine({ rate: '1' }); // period 4 ticks
    m.step(); // phase 0 -> quarter; face at quarter = FULL/2
    expect(faceValue(m, 8, 2)).toBe(face1296(FULL / 2));
    m.step(); // half: peak
    expect(faceValue(m, 8, 2)).toBe(1295);
    m.step();
    m.step(); // full cycle: back to 0
    expect(faceValue(m, 8, 2)).toBe(0);
  });

  it('rate change does not jump phase (the accumulator property)', () => {
    const m = lfoMachine({ rate: '2' }); // period 16 ticks
    for (let i = 0; i < 5; i++) m.step();
    const before = faceValue(m, 8, 2);
    place(m, 6, 1, '5'); // period 100 ticks — naive phase=t*rate would jump wildly
    m.step();
    const after = faceValue(m, 8, 2);
    const maxStep = Math.ceil((2 * Math.max(lfoInc(2), lfoInc(5)) * 1296) / PHASE) + 1;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(maxStep);
  });

  it('bang resets phase to zero (output = shape(offset))', () => {
    const m = lfoMachine({ rate: '1' });
    m.step();
    m.step(); // at peak
    place(m, 8, 0, '!');
    m.step();
    expect(faceValue(m, 8, 2)).toBe(0); // shape(0 + offset 0)
  });

  it('offset 9 of 36 is a quadrature pair with offset 0', () => {
    const a = lfoMachine({ rate: '1', offset: '0' });
    const b = lfoMachine({ rate: '1', offset: '9' }); // quarter cycle
    a.step();
    b.step();
    // b leads a by a quarter period: b at phase quarter+quarter=half → peak
    expect(faceValue(b, 8, 2)).toBe(1295);
    expect(faceValue(a, 8, 2)).toBe(face1296(FULL / 2));
  });

  it('min/max scale the output; min > max inverts', () => {
    const m = lfoMachine({ min: 'a', max: 'k', rate: '1' }); // 10..20
    m.step();
    m.step(); // peak
    expect(faceValue(m, 8, 2)).toBe(face1296(targetInternal(20)));
    const inv = lfoMachine({ min: 'k', max: 'a', rate: '1' });
    inv.step();
    inv.step(); // peak of inverted = min end
    expect(faceValue(inv, 8, 2)).toBe(face1296(targetInternal(10)));
  });

  it('CC crossings cover a fold within one tick continuously', () => {
    const m = lfoMachine({ ctrl: '7', rate: '1' }); // quarter cycle per tick
    m.step(); // 0 -> FULL/2 rising: initial + crossings up to 63
    m.step(); // FULL/2 -> FULL: rising to 127
    const upTo = m.ccEvents[m.ccEvents.length - 1].value7;
    expect(upTo).toBe(127);
    m.step(); // peak -> FULL/2: falling — monotone decreasing values
    const falling = m.ccEvents.map((e) => e.value7);
    for (let i = 1; i < falling.length; i++) {
      expect(falling[i]).toBeLessThan(falling[i - 1]);
    }
  });

  it('two identical machines produce identical CC event streams', () => {
    const run = () => {
      const m = lfoMachine({ ctrl: '5', rate: '2', offset: '3' });
      const log = [];
      for (let i = 0; i < 40; i++) {
        m.step();
        log.push(...m.ccEvents.map((e) => `${e.value7}@${e.frac.toFixed(6)}`));
      }
      return log.join(' ');
    };
    expect(run()).toBe(run());
  });

  it('grid-face writes propagate through wires', () => {
    const m = lfoMachine({ rate: '1' });
    m.addWire({ x: 8, y: 2 }, { x: 2, y: 5 });
    m.step();
    m.step(); // peak
    expect(charAt(m, 2, 5)).toBe('z'); // coarse byte arrived by wire
  });
});
