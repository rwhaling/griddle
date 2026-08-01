import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { gridToRows, rowsToGrid, cellsToGrid, textualizeSlots } from '../src/patchfile.js';
import { charToCell, cellToChar, MUTE_BIT, getMuted, getPower } from '../src/values.js';
import { evaluateMountDoc } from '../src/mounts.js';

const place = (m, x, y, char) => m.grid.set(x, y, charToCell(char));
const charAt = (m, x, y) => {
  const c = m.grid.get(x, y);
  return cellToChar(c.flags, c.letter);
};

describe('serialization v2 (rows + cellFlags)', () => {
  it('round-trips cells, mute flags, and unpowered operators', () => {
    const a = new Machine(12, 6, null);
    place(a, 1, 1, 'C');
    place(a, 2, 1, '7');
    place(a, 3, 2, 'Z');
    // mute the 7, unpower the Z
    const seven = a.grid.get(2, 1);
    a.grid.set(2, 1, { flags: seven.flags | MUTE_BIT, letter: seven.letter });
    const z = a.grid.get(3, 2);
    a.grid.set(3, 2, { flags: z.flags & ~0b100000, letter: z.letter });

    const { rows, cellFlags } = gridToRows(a);
    expect(rows[1].startsWith('.C7')).toBe(true);
    expect(cellFlags.length).toBe(2); // only the two exceptions

    const b = new Machine(12, 6, null);
    rowsToGrid(b, rows, cellFlags);
    expect(charAt(b, 1, 1)).toBe('C');
    expect(getMuted(b.grid.get(2, 1).flags)).toBe(1);
    expect(getPower(b.grid.get(3, 2).flags)).toBe(0);
    expect(charAt(b, 3, 2)).toBe('Z');
  });

  it('legacy cells arrays still load', () => {
    const m = new Machine(8, 8, null);
    cellsToGrid(m, [[2, 3, 'R', 35], [4, 3, '9', 2]]);
    expect(charAt(m, 2, 3)).toBe('R');
    expect(charAt(m, 4, 3)).toBe('9');
  });
});

describe('legacy slot textualization', () => {
  it('non-empty slots become $ mount lines with steps overrides', () => {
    const lines = textualizeSlots([
      { code: 'x(5,8)', steps: 8 },
      { code: '0 2 4 <7 9> 4 2', steps: null },
      { code: '', steps: null },
    ]);
    expect(lines.length).toBe(3); // comment + two mounts
    expect(lines[1]).toBe(`mountPattern(0, pat('x(5,8)').gsteps(8))`);
    expect(lines[2]).toBe(`mountPattern(1, pat('0 2 4 <7 9> 4 2'))`);
    // and the generated lines actually evaluate
    const table = evaluateMountDoc(lines.join('\n'));
    expect(table.entries.get('$0').steps).toBe(8);
    expect(table.entries.get('$1').steps).toBe(6);
  });

  it('empty slot arrays produce nothing', () => {
    expect(textualizeSlots([])).toEqual([]);
    expect(textualizeSlots(undefined)).toEqual([]);
  });
});

describe('bpm()/grid() mount statements', () => {
  it('record into the table with validation', () => {
    const t = evaluateMountDoc(`bpm(96)\ngrid(48, 24)`);
    expect(t.bpm).toBe(96);
    expect(t.gridSize).toEqual({ w: 48, h: 24 });
    const bad = evaluateMountDoc.bind(null, `bpm(999)`);
    expect(bad).toThrow(/expected 20..300/);
  });
});

describe('import validation (looksLikePatch)', () => {
  it('accepts v2 (rows), v1/hybrid (cells), rejects everything else', async () => {
    const { looksLikePatch } = await import('../src/patchfile.js');
    expect(looksLikePatch({ version: 2, rows: ['..'], mount: [] })).toBe(true);
    expect(looksLikePatch({ version: 1, cells: [[1, 1, 'C', 35]] })).toBe(true);
    expect(looksLikePatch({ some: 'json' })).toBe(false);
    expect(looksLikePatch(null)).toBe(false);
    expect(looksLikePatch([1, 2, 3])).toBe(false);
  });
});
