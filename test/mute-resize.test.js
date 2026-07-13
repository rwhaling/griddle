import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { charToCell, cellToChar, getMuted, MUTE_BIT } from '../src/values.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));
const charAt = (m, x, y) => {
  const c = m.grid.get(x, y);
  return cellToChar(c.flags, c.letter);
};
const mute = (m, x, y) => {
  const c = m.grid.get(x, y);
  m.grid.set(x, y, { flags: c.flags | MUTE_BIT, letter: c.letter });
};
const unmute = (m, x, y) => {
  const c = m.grid.get(x, y);
  m.grid.set(x, y, { flags: c.flags & ~MUTE_BIT, letter: c.letter });
};

describe('mute flag', () => {
  it('muted operators do not evaluate; unmuting resumes', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '1');
    place(m, 2, 1, '4');
    place(m, 3, 1, 'C');
    m.step();
    expect(charAt(m, 3, 2)).toBe('0');
    mute(m, 3, 1);
    m.step();
    m.step();
    expect(charAt(m, 3, 2)).toBe('0'); // stale output, clock frozen
    expect(getMuted(m.grid.get(3, 1).flags)).toBe(1);
    unmute(m, 3, 1);
    m.step();
    expect(charAt(m, 3, 2)).toBe('3'); // metronome kept counting; clock resumes
  });

  it('muted Z never fires even with an adjacent bang', () => {
    const m = new Machine(10, 8, null);
    place(m, 6, 2, 'Z');
    place(m, 6, 1, '!');
    m.step();
    expect(m.scanMidi().length).toBe(1);
    mute(m, 6, 2);
    m.step();
    expect(m.scanMidi().length).toBe(0);
  });

  it('muted F emits no CC; unmute re-announces (state was swept)', () => {
    const m = new Machine(12, 8, null);
    place(m, 3, 1, '7'); // controller west(5) of F at (8,1)
    place(m, 6, 1, '1'); // rate west(2)
    place(m, 8, 1, 'F');
    m.step();
    expect(m.ccEvents.length).toBeGreaterThan(0);
    mute(m, 8, 1);
    m.step();
    expect(m.ccEvents.length).toBe(0);
    expect(m.opState.size).toBe(0); // swept while muted
    unmute(m, 8, 1);
    m.step();
    // fresh state: initial value announced again (lastCC was reset)
    expect(m.ccEvents[0].frac).toBe(0);
  });

  it('mute survives the movement phase (flag copied with the cell)', () => {
    const m = new Machine(8, 8, null);
    place(m, 2, 2, 'C');
    mute(m, 2, 2);
    m.step();
    m.step();
    expect(getMuted(m.grid.get(2, 2).flags)).toBe(1);
  });
});

describe('resize', () => {
  it('grow preserves cells and wires', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '3');
    place(m, 2, 1, '4');
    place(m, 3, 1, '+');
    m.addWire({ x: 3, y: 2 }, { x: 6, y: 6 });
    m.resize(20, 12);
    expect(m.width).toBe(20);
    expect(charAt(m, 3, 1)).toBe('+');
    m.step();
    expect(charAt(m, 3, 2)).toBe('7');
    expect(charAt(m, 6, 6)).toBe('7'); // wire survived
  });

  it('shrink drops out-of-bounds cells and severs out-of-bounds wires', () => {
    const m = new Machine(20, 12, null);
    place(m, 2, 2, '9');
    place(m, 15, 10, '5');
    m.addWire({ x: 2, y: 2 }, { x: 15, y: 10 });
    m.addWire({ x: 2, y: 2 }, { x: 4, y: 4 });
    m.resize(8, 8);
    expect(charAt(m, 2, 2)).toBe('9');
    expect(m.allWires().length).toBe(1); // only the in-bounds wire survives
    expect(m.allWires()[0].to).toEqual({ x: 4, y: 4 });
  });

  it('operators keep working across a resize', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '1');
    place(m, 2, 1, '8');
    place(m, 3, 1, 'C');
    m.step();
    m.resize(30, 20);
    m.step();
    expect(charAt(m, 3, 2)).toBe('1'); // metronome continuity preserved
  });
});
