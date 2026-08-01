import { describe, it, expect } from 'vitest';
import { evaluateMountDoc, DEFAULT_MOUNT_DOC } from '../src/mounts.js';

// mountSignal/mountPattern (2026-08-01): sigil-free refs — numbers 0-35,
// chars, device-qualified two-char strings. The table is implied by type;
// legacy mount('@a')/mount('$3') and sigil labels keep parsing.

describe('mountSignal / mountPattern', () => {
  it('accepts numeric, char, and device-qualified refs', () => {
    const t = evaluateMountDoc(`
      mountSignal(10, lfo(tri).cycle('2b'))
      mountSignal('b', lfo(tri).cycle('4b'))
      mountSignal('2c', lfo(tri).cycle('8b'))
      mountPattern(3, pat('x(3,8)').gsteps(8))
      mountPattern('2f', pat('x(5,8)').gsteps(8))
    `);
    expect(t.lookup('@', 0, 10).cycleTicks).toBe(8); // slot a, global
    expect(t.lookup('@', 0, 11).cycleTicks).toBe(16); // slot b
    expect(t.lookup('@', 2, 12).cycleTicks).toBe(32); // device 2, slot c
    expect(t.lookup('@', 0, 12)).toBe(null); // no global fallback for '2c'
    expect(t.lookup('$', 0, 3).steps).toBe(8);
    expect(t.lookup('$', 2, 15).steps).toBe(8); // '$2f'
  });

  it('type-checks: signals are lfo(), patterns are not', () => {
    expect(() => evaluateMountDoc(`mountSignal(1, pat('x(3,8)'))`)).toThrow(/lfo/);
    expect(() => evaluateMountDoc(`mountPattern(1, lfo(tri).cycle('2b'))`)).toThrow(/mountSignal/);
  });

  it('rejects bad refs', () => {
    expect(() => evaluateMountDoc(`mountSignal(36, lfo(tri).cycle('2b'))`)).toThrow(/bad slot ref/);
    expect(() => evaluateMountDoc(`mountSignal('abc', lfo(tri).cycle('2b'))`)).toThrow(/bad slot ref/);
    expect(() => evaluateMountDoc(`mountPattern(-1, pat('x'))`)).toThrow(/bad slot ref/);
  });

  it('legacy sigil forms still parse and land in the same table', () => {
    const t = evaluateMountDoc(`
      mount('@a', lfo(tri).cycle('2b'))
      mountSignal('a', lfo(tri).cycle('4b'))
    `);
    expect(t.lookup('@', 0, 10).cycleTicks).toBe(16); // later spelling wins, same key
  });

  it('the sigil-free default doc mounts the full tables', () => {
    const t = evaluateMountDoc(DEFAULT_MOUNT_DOC);
    expect(t.lookup('@', 0, 0).cycleTicks).toBe(2); // slot 0: half-beat sync
    expect(t.lookup('@', 0, 9).cycleTicks).toBe(36); // slot 9: 9 beats
    expect(t.lookup('@', 0, 35)).not.toBe(null); // slot z mounted
    expect(t.lookup('$', 0, 3).steps).toBe(8); // x(3,8)
    expect(t.lookup('$', 0, 9).steps).toBe(16); // x(9,16)
    expect(t.lookup('$', 0, 25).steps).toBe(16); // p = x(16,16)
    expect(t.lookup('$', 0, 35).steps).toBe(12); // z = x(10,12)
    expect(t.lookup('$', 0, 0).steps).toBe(8); // silence slot
  });
});
