// Solo (0.1 doc): the host-side filter keys on event provenance — every
// emitted event carries its operator's grid coordinates. These tests pin the
// sx/sy stamps on all three emission streams; the filter itself is one
// predicate in main.js (e.sx === solo.x && e.sy === solo.y).
import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { evaluateMountDoc, DEFAULT_MOUNT_DOC } from '../src/mounts.js';
import { charToCell } from '../src/values.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));

describe('event provenance (solo filter substrate)', () => {
  it('Z scanMidi note events carry their operator origin', () => {
    const m = new Machine(14, 8, null);
    place(m, 1, 2, '0');
    place(m, 2, 2, '1');
    place(m, 3, 2, 's');
    place(m, 4, 2, '1');
    place(m, 5, 2, '5');
    place(m, 6, 2, '0');
    place(m, 7, 2, 'Z');
    place(m, 7, 1, '!');
    m.step();
    const notes = m.scanMidi().filter((e) => e.type === 'note');
    expect(notes.length).toBe(1);
    expect([notes[0].sx, notes[0].sy]).toEqual([7, 2]);
  });

  it('W scanMidi cc events carry their operator origin', () => {
    const m = new Machine(14, 8, null);
    place(m, 2, 3, '0');
    place(m, 3, 3, '1');
    place(m, 4, 3, '7');
    place(m, 5, 3, 'k');
    place(m, 6, 3, 'W');
    place(m, 6, 2, '!');
    m.step();
    const ccs = m.scanMidi().filter((e) => e.type === 'cc');
    expect(ccs.length).toBe(1);
    expect([ccs[0].sx, ccs[0].sy]).toEqual([6, 3]);
  });

  it('U/V noteEvents carry their operator origin', () => {
    const m = new Machine(14, 8, null);
    m.mounts = evaluateMountDoc(`$a: pat('x*4').cycle('4t').note(36)`);
    place(m, 4, 1, '1'); // channel
    place(m, 5, 1, 'a'); // slot
    place(m, 7, 1, 'U');
    m.step();
    expect(m.noteEvents.length).toBeGreaterThan(0);
    expect([m.noteEvents[0].sx, m.noteEvents[0].sy]).toEqual([7, 1]);
  });

  it('G ccEvents carry their operator origin (F shares the emitCC path)', () => {
    const m = new Machine(14, 8, null);
    m.mounts = evaluateMountDoc(DEFAULT_MOUNT_DOC);
    // G ports west: dev(5) ch(4) ctrl(3) target(2) rate(1); bang = snap,
    // which emits one immediate CC when the controller cell is addressed
    place(m, 1, 4, '0'); // dev
    place(m, 2, 4, '1'); // ch
    place(m, 3, 4, '7'); // ctrl
    place(m, 4, 4, 'k'); // target
    place(m, 6, 4, 'G');
    place(m, 6, 3, '!');
    m.step();
    expect(m.ccEvents.length).toBeGreaterThan(0);
    expect([m.ccEvents[0].sx, m.ccEvents[0].sy]).toEqual([6, 4]);
  });
});
