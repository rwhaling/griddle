import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { charToCell, cellToChar } from '../src/values.js';
import {
  FULL, cc7, face1296, targetInternal, glideStep, scaleV, crossings,
  tablePieces, tableValue, noisePieces, warpTable, intHash, NOISE_STEPS,
} from '../src/modulation.js';
import { evaluateMountDoc } from '../src/mounts.js';

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

  const TRI = [[0, 0], [0.5, 1], [1, 0]];

  it('tableValue interpolates and wraps; sides resolve step edges', () => {
    expect(tableValue(TRI, 0)).toBe(0);
    expect(tableValue(TRI, 0.25)).toBe(0.5);
    expect(tableValue(TRI, 0.5)).toBe(1);
    expect(tableValue(TRI, 1.25)).toBe(0.5); // wraps
    const STEP = [[0, 0], [0.5, 0], [0.5, 1], [1, 1]];
    expect(tableValue(STEP, 0.5, 'left')).toBe(0);
    expect(tableValue(STEP, 0.5, 'right')).toBe(1);
  });

  it('tablePieces splits at breakpoints across a fold with frac continuity', () => {
    const pieces = tablePieces(TRI, 0.375, 0.25); // straddles the peak
    expect(pieces.length).toBe(2);
    expect(pieces[0].v1).toBe(1);
    expect(pieces[1].v0).toBe(1);
    expect(pieces[0].f1).toBeCloseTo(pieces[1].f0);
    expect(pieces[0].f0).toBe(0);
    expect(pieces[1].f1).toBe(1);
  });

  it('tablePieces walks step edges as zero-width vertical pieces', () => {
    const STEP = [[0, 0], [0.5, 0], [0.5, 1], [1, 1]];
    const pieces = tablePieces(STEP, 0.25, 0.5);
    const vertical = pieces.find((p) => p.f1 === p.f0);
    expect(vertical).toBeTruthy();
    expect(vertical.v0).toBe(0);
    expect(vertical.v1).toBe(1);
  });

  it('vertical pieces emit one CC edge, not a staircase burst', () => {
    const { events } = crossings(
      [{ v0: 0, v1: FULL, f0: 0.5, f1: 0.5 }],
      0,
    );
    expect(events.length).toBe(1);
    expect(events[0].value7).toBe(127);
    expect(events[0].frac).toBe(0.5);
  });

  it('warpTable moves the midpoint, preserving order and endpoints', () => {
    const w = warpTable(TRI, 0.2);
    expect(w[0]).toEqual([0, 0]);
    expect(w[2][0]).toBe(1);
    expect(w[1][0]).toBeCloseTo(0.2); // peak moved
    const identity = warpTable(TRI, 0.5);
    expect(identity[1][0]).toBeCloseTo(0.5);
  });

  it('noisePieces are deterministic, continuous when smooth, stepped when not', () => {
    const a = noisePieces(0, 1, 0);
    const b = noisePieces(0, 1, 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // hash determinism
    expect(a.length).toBeGreaterThanOrEqual(NOISE_STEPS);
    const smooth = noisePieces(0, 1, 1);
    for (let i = 1; i < smooth.length; i++) {
      expect(smooth[i].v0).toBeCloseTo(smooth[i - 1].v1, 9); // no jumps
    }
    expect(intHash(5)).toBe(intHash(5));
    expect(intHash(5)).not.toBe(intHash(6));
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

// Mount-driven F at (8,1): dev(7)=x1, ch(6)=x2, ctrl(5)=x3, min(4)=x4,
// max(3)=x5, slot(2)=x6, mod(1)=x7. TRI4 = exact triangle over 4 ticks.
const TRI4 = `@a: lfo("0@0 1@0".slow(1))`; // placeholder replaced below

const lfoMachine = (mountDoc, { ctrl = null, min = null, max = null, slot = 'a', mod = null, dev = null } = {}) => {
  const m = new Machine(12, 8, null);
  m.mounts = evaluateMountDoc(mountDoc);
  if (dev !== null) place(m, 1, 1, dev);
  if (ctrl !== null) place(m, 3, 1, ctrl);
  if (min !== null) place(m, 4, 1, min);
  if (max !== null) place(m, 5, 1, max);
  place(m, 6, 1, slot);
  if (mod !== null) place(m, 7, 1, mod);
  place(m, 8, 1, 'F');
  return m;
};

const faceValue = (m, x, y) => {
  const coarse = parseInt(charAt(m, x, y), 36);
  const fine = parseInt(charAt(m, x + 1, y), 36);
  return coarse * 36 + fine;
};

// tri signal sampled at 64 points is exact at quarter-phase breakpoints
const TRI_4T = `@a: lfo(tri).cycle("4t")`;

describe('F — mount-driven LFO operator', () => {
  it('walks a mounted triangle: peak at half cycle, zero at wrap', () => {
    const m = lfoMachine(TRI_4T);
    m.step(); // phase 0 -> 0.25; face = tri(0.25) = half
    expect(faceValue(m, 8, 2)).toBe(face1296(FULL / 2));
    m.step(); // peak
    expect(faceValue(m, 8, 2)).toBe(1295);
    m.step();
    m.step(); // full cycle
    expect(faceValue(m, 8, 2)).toBe(0);
  });

  it('is inert without a mount (face untouched), wakes on slot switch', () => {
    const m = lfoMachine(TRI_4T, { slot: 'b' }); // @b unmounted
    m.step();
    expect(charAt(m, 8, 2)).toBe('.'); // no face write
    place(m, 6, 1, 'a'); // switch to the mounted slot
    m.step();
    expect(charAt(m, 8, 2)).not.toBe('.');
  });

  it('re-mounting with a different cycle never jumps phase', () => {
    const m = lfoMachine(`@a: lfo(tri).cycle("16t")`);
    for (let i = 0; i < 5; i++) m.step();
    const before = faceValue(m, 8, 2);
    m.mounts = evaluateMountDoc(`@a: lfo(tri).cycle("100t")`);
    m.step();
    const after = faceValue(m, 8, 2);
    // worst per-tick move at either rate: 2·inc·1296 ≈ 162 (16t) — no jump
    expect(Math.abs(after - before)).toBeLessThanOrEqual(165);
  });

  it('bang resets phase; mount .phase() makes a quadrature pair', () => {
    const m = lfoMachine(TRI_4T);
    m.step();
    m.step(); // peak
    place(m, 8, 0, '!');
    m.step();
    expect(faceValue(m, 8, 2)).toBe(0); // shape(0)
    const a = lfoMachine(TRI_4T);
    const b = lfoMachine(`@a: lfo(tri).cycle("4t").phase(0.25)`);
    a.step();
    b.step(); // b leads by a quarter: at half phase = peak
    expect(faceValue(b, 8, 2)).toBe(1295);
    expect(faceValue(a, 8, 2)).toBe(face1296(FULL / 2));
  });

  it('mount range is the base; min/max port literals override; inversion works', () => {
    // mount range only
    const m1 = lfoMachine(`@a: lfo(tri).cycle("4t").range(0, 63.5)`);
    m1.step();
    m1.step(); // peak of half-range
    expect(faceValue(m1, 8, 2)).toBe(face1296(FULL / 2));
    // port overrides (a=10, k=20 -> same internal values as the old design)
    const m2 = lfoMachine(TRI_4T, { min: 'a', max: 'k' });
    m2.step();
    m2.step();
    expect(faceValue(m2, 8, 2)).toBe(face1296(targetInternal(20)));
    // inverted via ports
    const m3 = lfoMachine(TRI_4T, { min: 'k', max: 'a' });
    m3.step();
    m3.step(); // peak of inverted = min end
    expect(faceValue(m3, 8, 2)).toBe(face1296(targetInternal(10)));
  });

  it("mod 'rate' multiplies speed; mod 'depth' collapses toward center", () => {
    // rate z with args (0.5, 2) => x2 speed: 8t cycle peaks in 2 ticks
    const fast = lfoMachine(`@a: lfo(tri).cycle("8t").mod('rate', 0.5, 2)`, { mod: 'z' });
    fast.step();
    fast.step();
    expect(faceValue(fast, 8, 2)).toBe(1295);
    // depth 0 => range collapsed to center: face pinned at half regardless of phase
    const flat = lfoMachine(`@a: lfo(tri).cycle("4t").mod('depth')`, { mod: '0' });
    flat.step();
    expect(faceValue(flat, 8, 2)).toBe(face1296(FULL / 2));
    flat.step();
    expect(faceValue(flat, 8, 2)).toBe(face1296(FULL / 2));
  });

  it('CC crossings cover a fold; step shapes emit single edges', () => {
    const m = lfoMachine(TRI_4T, { ctrl: '7' });
    m.step();
    m.step(); // rising to 127
    expect(m.ccEvents[m.ccEvents.length - 1].value7).toBe(127);
    m.step(); // falling — monotone decreasing
    const falling = m.ccEvents.map((e) => e.value7);
    for (let i = 1; i < falling.length; i++) {
      expect(falling[i]).toBeLessThan(falling[i - 1]);
    }
    // step shape: one edge per transition, no staircase burst
    const s = lfoMachine(`@a: lfo("0 z").cycle("4t")`, { ctrl: '7' });
    s.step(); // announces initial 0
    s.step();
    s.step(); // the 0 -> z edge lands in here
    const all = [];
    // rerun cleanly to collect per-tick counts
    const s2 = lfoMachine(`@a: lfo("0 z").cycle("4t")`, { ctrl: '7' });
    for (let i = 0; i < 4; i++) {
      s2.step();
      all.push(s2.ccEvents.map((e) => e.value7));
    }
    const flat = all.flat();
    expect(flat.length).toBeLessThanOrEqual(4); // edges only, never 127-bursts
    expect(flat).toContain(127);
    expect(flat[0]).toBe(0);
  });

  it('noise is deterministic and respects the black-hole device', () => {
    const doc = `@a: lfo(noise).cycle("4t")\ndevices({ 0: null })`;
    const run = () => {
      const m = lfoMachine(doc, { ctrl: '7' });
      const log = [];
      for (let i = 0; i < 20; i++) {
        m.step();
        log.push(faceValue(m, 8, 2));
      }
      return log.join(',');
    };
    expect(run()).toBe(run()); // hash determinism
    // black hole: face lives, wire face silenced
    const m = lfoMachine(doc, { ctrl: '7' });
    m.step();
    expect(m.ccEvents.length).toBe(0);
    expect(charAt(m, 8, 2)).not.toBe('.');
  });

  it('.sync() anchors phase to the metronome (no accumulator drift)', () => {
    const m = lfoMachine(`@a: lfo(tri).cycle("4t").sync()`);
    m.step();
    m.step(); // metronome 2: sweep [0.25, 0.5) -> face = tri(0.5) = peak
    expect(faceValue(m, 8, 2)).toBe(1295);
    m.step();
    m.step();
    expect(faceValue(m, 8, 2)).toBe(0); // wrapped exactly with the metronome
  });

  it('grid-face writes propagate through wires', () => {
    const m = lfoMachine(TRI_4T);
    m.addWire({ x: 8, y: 2 }, { x: 2, y: 5 });
    m.step();
    m.step(); // peak
    expect(charAt(m, 2, 5)).toBe('z');
  });
});
