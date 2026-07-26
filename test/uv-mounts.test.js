import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { PatternBank } from '../src/patterns.js';
import { evaluateMountDoc, DEFAULT_MOUNT_DOC } from '../src/mounts.js';
import { charToCell, cellToChar } from '../src/values.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));
const charAt = (m, x, y) => {
  const c = m.grid.get(x, y);
  return cellToChar(c.flags, c.letter);
};

// U/V at (8,1): dev(4)=x4, ch(3)=x5, slot(2)=x6, drive(1)=x7
const uvMachine = (mountDoc, op, { dev = null, ch = null, slot = 'a', drive = null } = {}) => {
  const m = new Machine(14, 8, null);
  if (mountDoc) m.mounts = evaluateMountDoc(mountDoc);
  if (dev !== null) place(m, 4, 1, dev);
  if (ch !== null) place(m, 5, 1, ch);
  place(m, 6, 1, slot);
  if (drive !== null) place(m, 7, 1, drive);
  place(m, 8, 1, op);
  return m;
};

describe('positional pattern mounts (quadrant ①/②)', () => {
  it('V positional matches the legacy bank byte-for-byte', () => {
    const doc = `$a: pat('0 3 7 <9 b>')`;
    const bank = new PatternBank();
    bank.setSlot(10, '0 3 7 <9 b>');
    for (let p = 0; p < 8; p++) {
      const m = uvMachine(doc, 'V', { drive: p.toString(36) });
      m.step();
      const legacy = bank.value(10, p);
      const face = charAt(m, 8, 2);
      expect(face).toBe(legacy === null ? '.' : legacy.toString(36));
    }
  });

  it('U positional: euclid bangs at the same positions as the legacy bank', () => {
    const doc = `$a: pat('x(5,8)').gsteps(8)`;
    const bank = new PatternBank();
    bank.setSlot(10, 'x(5,8)', 8);
    for (let p = 0; p < 8; p++) {
      const m = uvMachine(doc, 'U', { drive: p.toString(36) });
      m.step();
      expect(charAt(m, 8, 2) === '!').toBe(bank.bang(10, p));
    }
  });

  it('positional + channel cell = MIDI face at sub-position fracs (quadrant ②)', () => {
    // subdivision inside one position plays both notes with correct fracs
    const doc = `$a: pat('[0 7] 3').gsteps(2).base(60)`;
    const m = uvMachine(doc, 'V', { ch: '1', drive: '0' });
    m.step();
    expect(m.noteEvents.length).toBe(2);
    expect(m.noteEvents[0].note).toBe(60);
    expect(m.noteEvents[1].note).toBe(67);
    expect(m.noteEvents[0].frac).toBe(0);
    expect(m.noteEvents[1].frac).toBeCloseTo(0.5);
    // grid face aliases to the earliest onset, as always
    expect(charAt(m, 8, 2)).toBe('0');
  });

  it('no channel cell = pure grid citizen (no MIDI face)', () => {
    const m = uvMachine(`$a: pat('0 7').gsteps(2).base(60)`, 'V', { drive: '0' });
    m.step();
    expect(m.noteEvents.length).toBe(0);
  });
});

describe('rate-driven pattern mounts (quadrant ③/④)', () => {
  it('V grid face shows the sounding value; rests show NONE (active-at-boundary)', () => {
    // two long notes then a rest quarter: "0@2 c@1 ~@1" over 8 ticks
    const doc = `$a: note("0@2 12@1 ~@1").cycle('8t')`;
    const m = uvMachine(doc, 'V');
    const faces = [];
    for (let i = 0; i < 8; i++) {
      m.step();
      faces.push(charAt(m, 8, 2));
    }
    // note 0 sounds through tick 4 (half cycle), 12='c' through tick 6, rest after
    expect(faces.slice(0, 3)).toEqual(['0', '0', '0']);
    expect(faces[4]).toBe('c');
    expect(faces[6]).toBe('.');
    expect(faces[7]).toBe('.');
  });

  it('U bangs once per tick window even with multiple onsets; MIDI face fires all', () => {
    const doc = `$a: pat('x*8').cycle('4t').note(36)`; // 8 onsets over 4 ticks
    const m = uvMachine(doc, 'U', { ch: '9' });
    m.step();
    expect(charAt(m, 8, 2)).toBe('!'); // one grid bang
    expect(m.noteEvents.length).toBe(2); // both onsets in this tick played
    expect(m.noteEvents.every((e) => e.note === 36 && e.channel === 9)).toBe(true);
  });

  it('durations become note lengths (whole spans -> durTicks)', () => {
    const doc = `$a: note("60 62").cycle('8t')`; // each note = half cycle = 4 ticks
    const m = uvMachine(doc, 'V', { ch: '1' });
    m.step();
    expect(m.noteEvents.length).toBe(1);
    expect(m.noteEvents[0].note).toBe(60);
    expect(m.noteEvents[0].durTicks).toBeCloseTo(4);
  });

  it('unbounded patterns: <a b c> alternation unfolds past 36 steps', () => {
    const doc = `$a: pat('<0 1 2>').cycle('1t')`; // one cycle per tick
    const m = uvMachine(doc, 'V');
    const faces = [];
    for (let i = 0; i < 6; i++) {
      m.step();
      faces.push(charAt(m, 8, 2));
    }
    expect(faces).toEqual(['0', '1', '2', '0', '1', '2']);
  });

  it('bang resets phase; drive port is mod when declared', () => {
    const doc = `$a: pat('0 1 2 3').cycle('4t')`;
    const m = uvMachine(doc, 'V');
    m.step();
    m.step(); // face '1'
    expect(charAt(m, 8, 2)).toBe('1');
    place(m, 8, 0, '!'); // bang north
    m.step(); // reset: sweep [0, 0.25) again
    expect(charAt(m, 8, 2)).toBe('0');
    // rate mod doubles speed: 8t cycle at mod z ≈ 4t
    const fast = uvMachine(`$a: pat('0 1 2 3').cycle('8t').mod('rate', 0.5, 2)`, 'V', { drive: 'z' });
    fast.step();
    fast.step();
    expect(charAt(fast, 8, 2)).toBe('1'); // reached step 1 in 2 ticks
  });

  it("mod 'transpose' and 'degrade' behave deterministically", () => {
    const t = uvMachine(`$a: pat('0').cycle('1t').base(60).mod('transpose', -12, 12)`, 'V', {
      ch: '1',
      drive: 'z',
    });
    t.step();
    expect(t.noteEvents[0].note).toBe(72); // +12 at mod z
    const runDegrade = () => {
      const d = uvMachine(`$a: pat('x*4').cycle('4t').note(36).mod('degrade')`, 'U', {
        ch: '1',
        drive: 'i', // ~50% drop
      });
      const log = [];
      for (let i = 0; i < 20; i++) {
        d.step();
        log.push(d.noteEvents.length);
      }
      return log.join('');
    };
    expect(runDegrade()).toBe(runDegrade());
  });

  it('.sync() anchors pattern phase to the metronome', () => {
    const doc = `$a: pat('0 1 2 3').cycle('4t').sync()`;
    const m = uvMachine(doc, 'V');
    const faces = [];
    for (let i = 0; i < 5; i++) {
      m.step(); // metronome at eval time: 0,1,2,3,4
      faces.push(charAt(m, 8, 2));
    }
    // a = metronome*0.25: steps 0,1,2,3, then cycle 1 step 0 — locked, no drift
    expect(faces).toEqual(['0', '1', '2', '3', '0']);
  });
});

describe('defaults and demo', () => {
  it('default doc mounts 36 LFOs and 36 euclid patterns', () => {
    const table = evaluateMountDoc(DEFAULT_MOUNT_DOC);
    const ats = [...table.entries.keys()].filter((k) => k[0] === '@');
    const dollars = [...table.entries.keys()].filter((k) => k[0] === '$');
    expect(ats.length).toBe(36);
    expect(dollars.length).toBe(36);
    expect(table.entries.get('@3').cycleTicks).toBe(12); // 3 beats
    expect(table.entries.get('@3').sync).toBe(true);
    expect(table.entries.get('$5').steps).toBe(8); // x(5,8)
    expect(table.entries.get('$5').cycleTicks).toBeNull(); // positional
    expect(table.entries.get('$0').steps).toBe(8); // silence
  });

  it('$5 in the default table bangs like the classic cinquillo', () => {
    const m = uvMachine(DEFAULT_MOUNT_DOC, 'U', { slot: '5', drive: '0' });
    m.step();
    expect(charAt(m, 8, 2)).toBe('!'); // position 0 is an onset in E(5,8)
    const m2 = uvMachine(DEFAULT_MOUNT_DOC, 'U', { slot: '5', drive: '1' });
    m2.step();
    expect(charAt(m2, 8, 2)).toBe('.'); // position 1 is a rest
  });

  it('legacy slot panel still works when no mount shadows it', () => {
    const bank = new PatternBank();
    bank.setSlot(1, '0 3 7 9');
    const m = new Machine(14, 8, {
      bang: (s, p) => bank.bang(s, p),
      value: (s, p) => bank.value(s, p),
    });
    // no mounts at all: legacy path
    place(m, 6, 1, '1');
    place(m, 7, 1, '2');
    place(m, 8, 1, 'V');
    m.step();
    expect(charAt(m, 8, 2)).toBe('7');
  });

  it('full strudel expressions mount as patterns', () => {
    const doc = `$a: cat("0 3", "7 9").gsteps(2)`;
    const m = uvMachine(doc, 'V', { drive: '0' });
    m.step();
    expect(charAt(m, 8, 2)).toBe('0');
    const m2 = uvMachine(doc, 'V', { drive: '3' }); // cycle 1, step 1
    m2.step();
    expect(charAt(m2, 8, 2)).toBe('9');
  });
});
