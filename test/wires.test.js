import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { charToCell, cellToChar } from '../src/values.js';
import { copyRegion, cutRegion, pasteRegion, regionToText } from '../src/clipboard.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));
const charAt = (m, x, y) => {
  const c = m.grid.get(x, y);
  return cellToChar(c.flags, c.letter);
};

describe('wires', () => {
  it('normalizes direction to reading order and toggles', () => {
    const m = new Machine(8, 8, null);
    // create "backwards": from later cell to earlier cell
    expect(m.addWire({ x: 5, y: 5 }, { x: 1, y: 1 })).toBe('added');
    const wires = m.allWires();
    expect(wires.length).toBe(1);
    expect(wires[0].from).toEqual({ x: 1, y: 1 }); // earlier in reading order
    expect(wires[0].to).toEqual({ x: 5, y: 5 });
    // wiring the same pair again removes it, regardless of drag direction
    expect(m.addWire({ x: 1, y: 1 }, { x: 5, y: 5 })).toBe('removed');
    expect(m.allWires().length).toBe(0);
  });

  it('rejects zero-length and out-of-bounds wires', () => {
    const m = new Machine(8, 8, null);
    expect(m.addWire({ x: 2, y: 2 }, { x: 2, y: 2 })).toBeNull();
    expect(m.addWire({ x: 0, y: 0 }, { x: 99, y: 0 })).toBeNull();
  });

  it('operator writes propagate through wires, transitively', () => {
    const m = new Machine(10, 10, null);
    place(m, 1, 1, '3');
    place(m, 2, 1, '4');
    place(m, 3, 1, '+'); // writes 7 to (3,2)
    m.addWire({ x: 3, y: 2 }, { x: 6, y: 2 });
    m.addWire({ x: 6, y: 2 }, { x: 6, y: 5 }); // chained
    m.step();
    expect(charAt(m, 3, 2)).toBe('7');
    expect(charAt(m, 6, 2)).toBe('7');
    expect(charAt(m, 6, 5)).toBe('7'); // transitive
  });

  it('a wired value feeds a downstream operator in the same tick', () => {
    const m = new Machine(10, 10, null);
    // clock at (3,1) writes (3,2); wire carries it to (5,2); ADD at (6,2)
    // reads west(2)=(4,2)... use west(1)=(5,2) as addend instead
    place(m, 1, 1, '1');
    place(m, 2, 1, '4');
    place(m, 3, 1, 'C');
    place(m, 4, 2, '1'); // augend west(2) of ADD at (6,2)
    place(m, 6, 2, '+'); // west(2)=(4,2)='1', west(1)=(5,2)=wired clock value
    m.addWire({ x: 3, y: 2 }, { x: 5, y: 2 });
    m.step();
    expect(charAt(m, 6, 3)).toBe('1'); // 1 + clock(0), same tick via wire
    m.step();
    expect(charAt(m, 6, 3)).toBe('2'); // 1 + clock(1)
  });

  it('movement does not propagate through wires', () => {
    const m = new Machine(8, 8, null);
    // a moving literal passes over a wired cell; the wire target stays empty
    place(m, 1, 1, '5'); // value
    place(m, 2, 1, '1'); // velocity -> east
    place(m, 3, 1, '0');
    place(m, 4, 1, '0');
    place(m, 5, 1, 'I'); // places moving '5' at (5,2)
    m.addWire({ x: 6, y: 2 }, { x: 6, y: 6 });
    m.step();
    m.grid.set(5, 1, { flags: 0, letter: 0 }); // remove launcher
    m.step(); // value moves onto (6,2)
    expect(charAt(m, 6, 2)).toBe('5');
    expect(charAt(m, 6, 6)).toBe('.'); // movement write did not propagate
  });
});

describe('clipboard', () => {
  it('copy/paste round-trips cells and interior wires', () => {
    const m = new Machine(16, 16, null);
    place(m, 1, 1, '3');
    place(m, 2, 1, '4');
    place(m, 3, 1, '+');
    m.addWire({ x: 3, y: 2 }, { x: 1, y: 3 }); // inside the region
    m.addWire({ x: 3, y: 2 }, { x: 12, y: 12 }); // crosses the boundary: not copied

    const data = copyRegion(m, { x: 0, y: 0, w: 6, h: 6 });
    expect(data.cells.length).toBe(3);
    expect(data.wires.length).toBe(1);

    pasteRegion(m, data, { x: 8, y: 0 });
    expect(charAt(m, 9, 1)).toBe('3');
    expect(charAt(m, 11, 1)).toBe('+');
    m.step();
    expect(charAt(m, 11, 2)).toBe('7'); // pasted adder works
    expect(charAt(m, 9, 3)).toBe('7'); // pasted wire works too
  });

  it('cut clears cells and severs boundary-crossing wires', () => {
    const m = new Machine(16, 16, null);
    place(m, 2, 2, '9');
    m.addWire({ x: 2, y: 2 }, { x: 10, y: 10 });
    const data = cutRegion(m, { x: 0, y: 0, w: 4, h: 4 });
    expect(data.cells.length).toBe(1);
    expect(charAt(m, 2, 2)).toBe('.');
    expect(m.allWires().length).toBe(0); // boundary wire removed by cut
  });

  it('renders a region as text rows', () => {
    const m = new Machine(8, 8, null);
    place(m, 0, 0, 'C');
    place(m, 1, 1, '7');
    const text = regionToText(copyRegion(m, { x: 0, y: 0, w: 3, h: 2 }));
    expect(text).toBe('C..\n.7.');
  });
});
