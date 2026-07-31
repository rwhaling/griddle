import { describe, it, expect } from 'vitest';
import { evaluateMountDoc, resolveSynthControls, DEFAULT_MOUNT_DOC } from '../src/mounts.js';

// doc nine: synth definitions in the device table — lookup chain, resolution,
// merge rules. All pure; superdough itself is never imported here.

describe('devices() synth definitions', () => {
  it('stores objects, functions, arrays; validates keys', () => {
    const t = evaluateMountDoc(`devices({
      '3': { s: 'triangle' },
      '3.1': (n, v, d) => ({ s: 'sine', lpf: n * 10 }),
      '3.2': [{ s: 'sine' }, { s: 'white' }],
      '5': 'IAC Driver Bus 1',
      '6': null,
    })`);
    expect(typeof t.deviceMap['3']).toBe('object');
    expect(typeof t.deviceMap['3.1']).toBe('function');
    expect(Array.isArray(t.deviceMap['3.2'])).toBe(true);
    expect(t.deviceMap['5']).toBe('IAC Driver Bus 1');
    expect(t.deviceMap['6']).toBe(null);
    expect(() => evaluateMountDoc(`devices({ 'x.z': { s: 'sine' } })`)).toThrow(/bad key/);
  });

  it('synthDef: d.ch ?? d chain, channel folded mod 16, MIDI/null excluded', () => {
    const t = evaluateMountDoc(`devices({
      '3': { s: 'triangle' },
      '3.1': { s: 'sine' },
      '5': 'A MIDI Port',
      '6': null,
    })`);
    expect(t.synthDef(3, 1).s).toBe('sine'); // specific wins
    expect(t.synthDef(3, 0).s).toBe('triangle'); // falls back to device
    expect(t.synthDef(3, 17).s).toBe('sine'); // 17 % 16 = 1
    expect(t.synthDef(5, 0)).toBe(null); // MIDI route is not a synth def
    expect(t.synthDef(6, 0)).toBe(null); // black hole
    expect(t.synthDef(9, 0)).toBe(null); // unmounted
    expect(t.hasSynthDefs()).toBe(true);
  });
});

describe('resolveSynthControls', () => {
  const ctx = { note: 60, velocity: 127, durTicks: 4 };

  it('static object: merges note, velocity multiplies gain', () => {
    const [c] = resolveSynthControls({ s: 'sine', gain: 0.5 }, ctx);
    expect(c.s).toBe('sine');
    expect(c.note).toBe(60);
    expect(c.gain).toBeCloseTo(0.5);
    const [q] = resolveSynthControls({ s: 'sine' }, { ...ctx, velocity: 64 });
    expect(q.gain).toBeCloseTo(64 / 127);
  });

  it('function receives (note, vel, durTicks) and its return is merged', () => {
    const def = (n, v, d) => ({ s: 'triangle', lpf: 100 + v, pdecay: d * 0.01 });
    const [c] = resolveSynthControls(def, { note: 48, velocity: 100, durTicks: 8 });
    expect(c.cutoff).toBe(200); // lpf aliased to superdough's raw name
    expect(c.pdecay).toBeCloseTo(0.08);
    expect(c.note).toBe(48);
  });

  it('arrays become layers; explicit note/freq in a layer is preserved', () => {
    const layers = resolveSynthControls(
      [{ s: 'sine', freq: 50, gain: 1 }, { s: 'white', gain: 0.4 }],
      { note: 60, velocity: 127, durTicks: 1 },
    );
    expect(layers.length).toBe(2);
    expect(layers[0].freq).toBe(50); // pinned drum pitch survives
    expect(layers[1].gain).toBeCloseTo(0.4);
    const [n] = resolveSynthControls({ s: 'sine', note: 72 }, ctx);
    expect(n.note).toBe(72); // explicit note beats grid note
  });

  it('filter aliases map to raw superdough keys', () => {
    const [c] = resolveSynthControls({ s: 'white', hpf: 8000, bpf: 2000, bpq: 8, lpq: 5 }, ctx);
    expect(c.hcutoff).toBe(8000);
    expect(c.bandf).toBe(2000);
    expect(c.bandq).toBe(8);
    expect(c.resonance).toBe(5);
  });

  it('is deterministic: same def + ctx -> identical controls', () => {
    const def = (n, v, d) => ({ s: 'sine', lpf: n * v });
    const a = resolveSynthControls(def, ctx);
    const b = resolveSynthControls(def, ctx);
    expect(a).toEqual(b);
  });
});

describe('default mount doc synth bank', () => {
  it('mounts the six device-z demo voices and they all resolve', () => {
    const t = evaluateMountDoc(DEFAULT_MOUNT_DOC);
    expect(t.hasSynthDefs()).toBe(true);
    const ctx = { note: 60, velocity: 96, durTicks: 2 };
    for (let ch = 0; ch <= 5; ch++) {
      const def = t.synthDef(35, ch); // device z
      expect(def).not.toBe(null);
      const layers = resolveSynthControls(def, ctx);
      expect(layers.length).toBeGreaterThan(0);
      for (const c of layers) expect(typeof c.s).toBe('string');
    }
    expect(t.synthDef(35, 3).length).toBe(2); // kick is layered
    expect(t.synthDef(35, 6)).toBe(null); // no device-level fallback on z
  });
});
