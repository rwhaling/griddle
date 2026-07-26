// Patch serialization v2 (doc seven §7.1): the grid as human-readable row
// strings plus a cellFlags sidecar for exceptions (unpowered, muted), the
// mount document as an array of lines. Pure functions, headlessly testable;
// main.js supplies the DOM glue.

import { charToCell, cellToChar, getType, TYPE } from './values.js';

// -> { rows: string[], cellFlags: [x, y, flags][] }
export function gridToRows(machine) {
  const rows = [];
  const cellFlags = [];
  const grid = machine.grid;
  for (let y = 0; y < machine.height; y++) {
    let row = '';
    for (let x = 0; x < machine.width; x++) {
      const cell = grid.get(x, y);
      if (getType(cell.flags) === TYPE.NONE) {
        row += '.';
        continue;
      }
      const char = cellToChar(cell.flags, cell.letter);
      row += char;
      // sidecar only when flags differ from what typing the char produces
      const canonical = charToCell(char);
      if (canonical && canonical.flags !== cell.flags) {
        cellFlags.push([x, y, cell.flags]);
      }
    }
    rows.push(row);
  }
  return { rows, cellFlags };
}

export function rowsToGrid(machine, rows, cellFlags = []) {
  machine.grid.clear();
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      if (char === '.' || char === '·') return;
      const cell = charToCell(char);
      if (cell) machine.grid.set(x, y, cell);
    });
  });
  for (const [x, y, flags] of cellFlags) {
    const cell = machine.grid.get(x, y);
    machine.grid.set(x, y, { flags, letter: cell.letter });
  }
}

// legacy v1 cells array: [x, y, char, flags]
export function cellsToGrid(machine, cells) {
  machine.grid.clear();
  for (const [x, y, char, flags] of cells) {
    const cell = charToCell(char);
    if (cell) machine.grid.set(x, y, { flags: flags ?? cell.flags, letter: cell.letter });
  }
}

// legacy slot-panel patterns -> mount-document lines (slot-panel retirement:
// old patches migrate by textualization at load)
export function textualizeSlots(slots) {
  const lines = [];
  (slots ?? []).forEach((s, i) => {
    if (!s?.code?.trim()) return;
    const code = s.code.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const steps = s.steps ? `.gsteps(${s.steps})` : '';
    lines.push(`$${i.toString(36)}: pat('${code}')${steps}`);
  });
  if (lines.length) {
    lines.unshift('// migrated from the legacy slot panel:');
  }
  return lines;
}
