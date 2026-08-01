import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { PatternBank } from '../src/patterns.js';
import { charToCell, cellToChar, TYPE, getType } from '../src/values.js';
import { DEMO } from '../src/demo.js';

const place = (machine, x, y, char) => {
  const cell = charToCell(char);
  if (!cell) throw new Error(`bad char: ${char}`);
  machine.grid.set(x, y, cell);
};

const charAt = (machine, x, y) => {
  const c = machine.grid.get(x, y);
  return cellToChar(c.flags, c.letter);
};

describe('arithmetic and dataflow', () => {
  it('ADD writes (a+b)%36 south', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, 'z'); // 35
    place(m, 2, 1, '3');
    place(m, 3, 1, '+');
    m.step();
    expect(charAt(m, 3, 2)).toBe('2'); // (35+3)%36
  });

  it('SUB wraps positive', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '2');
    place(m, 2, 1, '5');
    place(m, 3, 1, '-');
    m.step();
    expect(charAt(m, 3, 2)).toBe('x'); // (2-5+36)%36 = 33
  });

  it('CLOCK counts metronome/rate mod mod', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '1');
    place(m, 2, 1, '4');
    place(m, 3, 1, 'C');
    const seen = [];
    for (let i = 0; i < 6; i++) {
      m.step();
      seen.push(charAt(m, 3, 2));
    }
    expect(seen).toEqual(['0', '1', '2', '3', '0', '1']);
  });

  it('reading-order evaluation chains within one tick', () => {
    // C outputs to (3,2); an ADD below it on a later row consumes it same-tick
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '1');
    place(m, 2, 1, '8');
    place(m, 3, 1, 'C');
    place(m, 4, 2, '1'); // addend west(1) of ADD... careful: ADD reads west(2), west(1)
    place(m, 5, 2, '+');
    // ADD at (5,2): west(2)=(3,2)=clock out, west(1)=(4,2)='1'
    m.step();
    expect(charAt(m, 5, 3)).toBe('1'); // clock 0 + 1, same tick
    m.step();
    expect(charAt(m, 5, 3)).toBe('2'); // clock 1 + 1
  });

  it('HOP carries west to east; JUMP carries north to south', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '7');
    place(m, 2, 1, 'H');
    place(m, 4, 1, '9');
    place(m, 4, 2, 'J');
    m.step();
    expect(charAt(m, 3, 1)).toBe('7');
    expect(charAt(m, 4, 3)).toBe('9');
  });

  it('EQUAL emits bang, clears on mismatch (always-write)', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '4');
    place(m, 2, 1, '4');
    place(m, 3, 1, '=');
    m.step();
    expect(charAt(m, 3, 2)).toBe('!');
    place(m, 2, 1, '5');
    m.step();
    expect(charAt(m, 3, 2)).toBe('.');
  });

  it('movement: values with velocity travel; collisions destroy', () => {
    const m = new Machine(8, 8, null);
    // INTERFERE launches a literal east: value west(4), velocity west(3), x west(2), y west(1)
    place(m, 1, 1, '5'); // value
    place(m, 2, 1, '1'); // velocity 1 -> 1+(1%4)=2=east
    place(m, 3, 1, '0'); // x offset
    place(m, 4, 1, '0'); // y offset
    place(m, 5, 1, 'I');
    m.step();
    // placed at (5+0, 1+0+1) = (5,2) with east velocity
    expect(charAt(m, 5, 2)).toBe('5');
    // remove the launcher so it doesn't re-fire, then watch the value move
    m.grid.set(5, 1, { flags: 0, letter: 0 });
    m.step();
    expect(charAt(m, 5, 2)).toBe('.');
    expect(charAt(m, 6, 2)).toBe('5');
  });

  it('AND presence-conjunction: bang & literal gates on data-exists (2026-08-01)', () => {
    // trigger + occupied cell -> bang (either order)
    for (const [a, b] of [['!', '5'], ['5', '!'], ['!', '0']]) {
      const m = new Machine(8, 8, null);
      place(m, 1, 1, a);
      place(m, 2, 1, b);
      place(m, 3, 1, '&');
      m.step();
      expect(charAt(m, 3, 2), `${a} & ${b}`).toBe('!'); // note: 0 is real data
    }
    // trigger + empty cell -> NONE (the rest stays a rest)
    const rest = new Machine(8, 8, null);
    place(rest, 1, 1, '!');
    place(rest, 3, 1, '&');
    rest.step();
    expect(charAt(rest, 3, 2)).toBe('.');
    // pure cases unchanged: lit&lit bitwise, bang&bang bang
    const bits = new Machine(8, 8, null);
    place(bits, 1, 1, '6');
    place(bits, 2, 1, '3');
    place(bits, 3, 1, '&');
    bits.step();
    expect(charAt(bits, 3, 2)).toBe('2'); // 6 & 3
    const bb = new Machine(8, 8, null);
    place(bb, 1, 1, '!');
    place(bb, 2, 1, '!');
    place(bb, 3, 1, '&');
    bb.step();
    expect(charAt(bb, 3, 2)).toBe('!');
  });

  it('M copies emptiness verbatim, so a scanned blank reaches & as a rest', () => {
    // the composition fact behind the sparse-sequencer idiom: M's output
    // preserves NONE, so & downstream gates on the row's true occupancy
    const n = new Machine(8, 8, null);
    place(n, 1, 1, '2');
    place(n, 3, 1, 'M'); // x=2, y=0 -> reads (5,0): empty
    n.step();
    expect(getType(n.grid.get(3, 2).flags)).toBe(TYPE.NONE);
  });

  it('STORE and LOAD round-trip through registers', () => {
    const m = new Machine(8, 8, null);
    place(m, 1, 1, '9'); // value
    place(m, 2, 1, '3'); // register index
    place(m, 3, 1, 'S');
    place(m, 5, 1, '3'); // register index
    place(m, 6, 1, 'L');
    m.step();
    expect(charAt(m, 6, 2)).toBe('9');
  });
});

describe('U/V pattern operators', () => {
  const bankMachine = (slots) => {
    const bank = new PatternBank();
    for (const [i, { code, steps }] of Object.entries(slots)) {
      const slot = bank.setSlot(Number(i), code, steps ?? null);
      expect(slot.error).toBeNull();
    }
    const m = new Machine(10, 10, {
      bang: (s, p) => bank.bang(s, p),
      value: (s, p) => bank.value(s, p),
    });
    return { bank, m };
  };

  it('V reads sequence values by position', () => {
    const { m } = bankMachine({ 1: { code: '0 3 7 9' } });
    // clock (rate 1, mod 4) writes its output to (3,2), which is west(1) of V
    place(m, 1, 1, '1');
    place(m, 2, 1, '4');
    place(m, 3, 1, 'C');
    place(m, 2, 2, '1'); // slot 1, west(2) of V
    place(m, 4, 2, 'V');
    const seen = [];
    for (let i = 0; i < 8; i++) {
      m.step();
      seen.push(charAt(m, 4, 3));
    }
    expect(seen).toEqual(['0', '3', '7', '9', '0', '3', '7', '9']);
  });

  it('V with static position is a pure lookup', () => {
    const { m } = bankMachine({ 0: { code: '5 6 7 8' } });
    place(m, 1, 1, '0'); // slot 0
    place(m, 2, 1, '2'); // position 2
    place(m, 3, 1, 'V');
    m.step();
    expect(charAt(m, 3, 2)).toBe('7');
  });

  it('V writes NONE on rests (no sample-hold)', () => {
    const { m } = bankMachine({ 0: { code: '5 ~ 7 ~' } });
    place(m, 1, 1, '1');
    place(m, 2, 1, '4');
    place(m, 3, 1, 'C');
    place(m, 2, 2, '0');
    place(m, 4, 2, 'V');
    const seen = [];
    for (let i = 0; i < 4; i++) {
      m.step();
      seen.push(charAt(m, 4, 3));
    }
    expect(seen).toEqual(['5', '.', '7', '.']);
  });

  it('V reads base-36 letter strings literally', () => {
    const { m } = bankMachine({ 0: { code: 'a f z 0' } });
    place(m, 1, 1, '0'); // slot
    place(m, 2, 1, '1'); // position 1
    place(m, 3, 1, 'V');
    m.step();
    expect(charAt(m, 3, 2)).toBe('f'); // 15
  });

  it('U bangs follow a euclidean pattern with steps override', () => {
    const { bank } = bankMachine({ 0: { code: 'x(5,8)', steps: 8 } });
    const bangs = [];
    for (let p = 0; p < 8; p++) bangs.push(bank.bang(0, p));
    // E(5,8) onsets at 0, 2, 3, 5, 6 (verified against strudel's bjorklund)
    expect(bangs).toEqual([true, false, true, true, false, true, true, false]);
  });

  it('unwrapped positions reach later cycles: <a b> alternation', () => {
    const { bank } = bankMachine({ 0: { code: '<1 2>', steps: 1 } });
    expect(bank.value(0, 0)).toBe(1);
    expect(bank.value(0, 1)).toBe(2);
    expect(bank.value(0, 2)).toBe(1);
  });

  it('continuous signals act as wavetables (V samples, U never bangs)', () => {
    const bank = new PatternBank();
    const slot = bank.setSlot(0, 'sine');
    expect(slot.error).toBeNull();
    expect(bank.steps(0)).toBe(36); // signals: position = phase in 36ths
    // sine starts at 0.5, peaks at quarter phase, troughs at three-quarter
    expect(bank.value(0, 0)).toBe(18);
    expect(bank.value(0, 9)).toBe(35);
    expect(bank.value(0, 27)).toBe(0);
    // signals have no onsets: U never bangs
    expect(bank.bang(0, 0)).toBe(false);
    expect(bank.bang(0, 9)).toBe(false);
  });

  it('U treats f and 0 as no-bang, x and t as bang', () => {
    const { bank } = bankMachine({ 0: { code: 't f x 0', steps: 4 } });
    expect(bank.bang(0, 0)).toBe(true);
    expect(bank.bang(0, 1)).toBe(false);
    expect(bank.bang(0, 2)).toBe(true);
    expect(bank.bang(0, 3)).toBe(false);
  });
});

describe('demo integration: polymetric arpeggio', () => {
  it('produces the expected 24-tick loop of notes', () => {
    const bank = new PatternBank();
    for (const [key, { code, steps }] of Object.entries(DEMO.slots)) {
      const slot = bank.setSlot(Number(key), code, steps);
      expect(slot.error).toBeNull();
    }
    const m = new Machine(32, 16, {
      bang: (s, p) => bank.bang(s, p),
      value: (s, p) => bank.value(s, p),
    });
    DEMO.rows.forEach((row, dy) => {
      [...row].forEach((char, dx) => {
        if (char === '.') return;
        place(m, DEMO.origin.x + dx, DEMO.origin.y + dy, char);
      });
    });
    for (const [fx, fy, tx, ty] of DEMO.wires) {
      m.ensureWire(
        { x: DEMO.origin.x + fx, y: DEMO.origin.y + fy },
        { x: DEMO.origin.x + tx, y: DEMO.origin.y + ty },
      );
    }

    const notes = []; // [tick, midiNote]
    for (let t = 0; t < 24; t++) {
      m.step();
      for (const e of m.scanMidi()) {
        expect(e.type).toBe('note');
        notes.push([t, e.note, e.velocity, e.holdTicks]);
      }
    }

    // euclid E(5,8) bangs at ticks ≡ {0,2,3,5,6} mod 8 -> 15 notes in 24 ticks
    expect(notes.length).toBe(15);
    const ticks = notes.map(([t]) => t);
    expect(ticks).toEqual([0, 2, 3, 5, 6, 8, 10, 11, 13, 14, 16, 18, 19, 21, 22]);

    // melody: position = tick % 12 over '0 2 4 <7 9> 4 2' (steps 6), through
    // N (major scale) + octave 5 -> note = 60 + scaleMap(index)
    const scaleMap = (i) => 12 * Math.floor(i / 7) + [0, 2, 4, 5, 7, 9, 11][i % 7];
    const melody = (tick) => {
      const p = tick % 12;
      const cycle0 = [0, 2, 4, 7, 4, 2];
      const cycle1 = [0, 2, 4, 9, 4, 2];
      const idx = p < 6 ? cycle0[p] : cycle1[p - 6];
      return 60 + scaleMap(idx);
    };
    for (const [t, note] of notes) {
      expect(note).toBe(melody(t));
    }

    // spot-check the alternation is audible: tick 3 plays <7>=72, tick 21 plays <9>=76
    expect(notes.find(([t]) => t === 3)[1]).toBe(72);
    expect(notes.find(([t]) => t === 21)[1]).toBe(76);

    // velocity 'p' (25) -> 25*127/35 = 90; hold '2' -> 2 ticks
    expect(notes[0][2]).toBe(90);
    expect(notes[0][3]).toBe(2);
  });
});
