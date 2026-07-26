import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { describeAt, portCells } from '../src/ports.js';
import { evaluateMountDoc } from '../src/mounts.js';
import { charToCell } from '../src/values.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));

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
    expect(d).toContain('@8 lfo shape 256t'); // 16 bars = 256 ticks
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
