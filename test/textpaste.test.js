import { describe, it, expect } from 'vitest';
import { Machine } from '../src/interpreter.js';
import { textToRegion, regionToText, pasteRegion, copyRegion } from '../src/clipboard.js';
import { cellToChar, getPower, getType, TYPE } from '../src/values.js';

// external paste (2026-08-01): plain text -> region, the inverse of
// regionToText — doc figures and CLAVIER-style snippets paste at the cursor

describe('textToRegion', () => {
  it("parses the user's Turing-machine figure", () => {
    const fig = [
      '.....R........',
      '.8R8Cy9<......',
      '..6.40I.......',
      '..8C..63642151',
      '...4.M........',
      '.....4........',
    ].join('\n');
    const region = textToRegion(fig);
    expect(region.h).toBe(6);
    expect(region.w).toBe(14);
    const m = new Machine(20, 10, null);
    pasteRegion(m, region, { x: 1, y: 1 });
    const at = (x, y) => {
      const c = m.grid.get(x, y);
      return cellToChar(c.flags, c.letter);
    };
    expect(at(6, 1)).toBe('R'); // figure (5,0), offset by the paste origin
    expect(at(7, 3)).toBe('I'); // figure (6,2)
    expect(at(6, 5)).toBe('M'); // figure (5,4)
    expect(getPower(m.grid.get(6, 1).flags)).toBe(1); // typed ops arrive powered
  });

  it('treats . · space and tab as empty; skips prose characters', () => {
    const region = textToRegion('2 4.+·\nhello,(world)!');
    // row 0: 2 at 0, 4 at 2, + at 5... wait: '2 4.+·' -> 2(0) sp(1) 4(2) .(3) +(4) ·(5)
    const cells = Object.fromEntries(region.cells.map(([dx, dy, , letter]) => [`${dx},${dy}`, letter]));
    expect(cells['0,0']).toBe(2);
    expect(cells['2,0']).toBe(4);
    expect('4,0' in cells).toBe(true); // the +
    expect('1,0' in cells).toBe(false); // space = empty
    // prose row: letters/! parse as cells (h,e,l,o are literals, ! a bang),
    // punctuation is skipped without advancing errors
    expect(region.cells.some(([dx, dy]) => dy === 1)).toBe(true);
  });

  it('returns null for text with no griddle cells at all', () => {
    expect(textToRegion('')).toBe(null);
    expect(textToRegion('   \n\n  ')).toBe(null);
    expect(textToRegion('()[]{},;:"')).toBe(null);
  });

  it('strips CRLF and blank framing lines', () => {
    const region = textToRegion('\r\n\r\n.C.\r\n\r\n');
    expect(region.h).toBe(1);
    expect(region.cells.length).toBe(1);
  });

  it('round-trips regionToText', () => {
    const m = new Machine(8, 8, null);
    const src = textToRegion('24+\n..3');
    pasteRegion(m, src, { x: 0, y: 0 });
    const copied = copyRegion(m, { x: 0, y: 0, w: 3, h: 2 });
    expect(regionToText(copied)).toBe('24+\n..3');
  });
});
