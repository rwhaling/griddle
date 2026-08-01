import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { describeAt, portCells, multiplexLookup } from '../src/ports.js';
import { evaluateMountDoc } from '../src/mounts.js';
import { charToCell } from '../src/values.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));
const placeRow = (m, x, y, s) => {
  [...s].forEach((ch, i) => { if (ch !== '.') place(m, x + i, y, ch); });
};

describe('context inspector (describeAt)', () => {
  it('describes an F with live port values and resolved mount', () => {
    const m = new Machine(14, 8, null);
    m.mounts = evaluateMountDoc("@8: lfo(tri).cycle('16bar')");
    // dev(7)=x1 .. mod(1)=x7, F at x8
    place(m, 1, 1, '0');
    place(m, 3, 1, 'a'); // ctrl
    place(m, 7, 1, '8'); // wait: slot is west(2)=x6
    m.grid.set(7, 1, { flags: 0, letter: 0 });
    place(m, 6, 1, '8'); // slot
    place(m, 8, 1, 'F');
    const d = describeAt(m, 8, 1);
    expect(d).toContain('F · mounted lfo');
    expect(d).toContain('slot 8');
    expect(d).toContain('→ lfo shape 256t'); // 16 bars = 256 ticks; sigil-free display
  });

  it('reports NO MOUNT for unmounted slots', () => {
    const m = new Machine(14, 8, null);
    m.mounts = evaluateMountDoc('');
    place(m, 6, 1, '3');
    place(m, 8, 1, 'F');
    expect(describeAt(m, 8, 1)).toContain('NO MOUNT');
  });

  it('reverse-describes a literal as a port of its consumer', () => {
    const m = new Machine(10, 8, null);
    place(m, 1, 1, '4');
    place(m, 2, 1, '8');
    place(m, 3, 1, 'C');
    expect(describeAt(m, 1, 1)).toContain('rate of clock');
    expect(describeAt(m, 2, 1)).toContain('mod of clock');
    m.step();
    expect(describeAt(m, 3, 2)).toContain('count out of clock');
  });

  it('portCells returns input and output positions for highlighting', () => {
    const m = new Machine(10, 8, null);
    place(m, 3, 1, 'C');
    const p = portCells(m, 3, 1);
    expect(p.ins).toEqual([[1, 1], [2, 1]]);
    expect(p.outs).toEqual([[3, 2]]);
    expect(portCells(m, 0, 0)).toBeNull();
  });
});

describe('M scan head (CLAVIER-style lookup highlight, 2026-07-31)', () => {
  it('resolves east-by-x, up-by-(y+1) from the port literals', () => {
    const m = new Machine(16, 8, null);
    placeRow(m, 4, 3, '.0795'); // data row at y=3
    placeRow(m, 3, 4, '2.M'); // M at (5,4): x=2, y=0 -> reads (7,3)
    expect(multiplexLookup(m, 5, 4)).toEqual([7, 3]);
    // non-literal ports default 0: one up, same column
    const n = new Machine(8, 8, null);
    place(n, 4, 4, 'M');
    expect(multiplexLookup(n, 4, 4)).toEqual([4, 3]);
    // not an M -> null
    expect(multiplexLookup(m, 4, 3)).toBe(null);
  });

  it('portCells includes M lookup as an input, I target as an output', () => {
    const m = new Machine(16, 8, null);
    placeRow(m, 3, 4, '2.M');
    expect(portCells(m, 5, 4).ins).toContainEqual([7, 3]);
    const i = new Machine(16, 8, null);
    placeRow(i, 1, 4, 'z531I'); // I at (5,4): x=3, y=1 -> writes (8,6)
    expect(portCells(i, 5, 4).outs).toContainEqual([8, 6]);
  });

  it('describeAt shows where the scan head reads', () => {
    const m = new Machine(16, 8, null);
    placeRow(m, 4, 3, '.0795');
    placeRow(m, 3, 4, '2.M');
    expect(describeAt(m, 5, 4)).toMatch(/reads \(7,3\)/);
  });
});
