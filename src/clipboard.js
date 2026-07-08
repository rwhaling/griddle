// Region clipboard: copy/cut/paste rectangular grid regions, carrying both
// cell contents and any wires whose endpoints are entirely inside the region
// (CLAVIER's clipboard does the same — see ClipboardWire in src/clavier.c).

import { TYPE, getType, cellToChar } from './values.js';

// rect: {x, y, w, h} -> data: {w, h, cells: [[dx,dy,flags,letter]], wires: [[adx,ady,bdx,bdy]]}
export function copyRegion(machine, rect) {
  const cells = [];
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      const cell = machine.grid.get(rect.x + dx, rect.y + dy);
      if (getType(cell.flags) === TYPE.NONE) continue;
      cells.push([dx, dy, cell.flags, cell.letter]);
    }
  }
  const inside = (p) =>
    p.x >= rect.x && p.x < rect.x + rect.w && p.y >= rect.y && p.y < rect.y + rect.h;
  const wires = machine
    .allWires()
    .filter(({ from, to }) => inside(from) && inside(to))
    .map(({ from, to }) => [from.x - rect.x, from.y - rect.y, to.x - rect.x, to.y - rect.y]);
  return { w: rect.w, h: rect.h, cells, wires };
}

export function clearRegion(machine, rect) {
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      machine.grid.set(rect.x + dx, rect.y + dy, { flags: 0, letter: 0 });
    }
  }
  // remove wires with either endpoint inside the region
  const inside = (p) =>
    p.x >= rect.x && p.x < rect.x + rect.w && p.y >= rect.y && p.y < rect.y + rect.h;
  for (const { from, to } of machine.allWires()) {
    if (inside(from) || inside(to)) machine.addWire(from, to); // toggle off
  }
}

export function cutRegion(machine, rect) {
  const data = copyRegion(machine, rect);
  clearRegion(machine, rect);
  return data;
}

export function pasteRegion(machine, data, at) {
  for (const [dx, dy, flags, letter] of data.cells) {
    machine.grid.set(at.x + dx, at.y + dy, { flags, letter });
  }
  for (const [adx, ady, bdx, bdy] of data.wires ?? []) {
    machine.ensureWire(
      { x: at.x + adx, y: at.y + ady },
      { x: at.x + bdx, y: at.y + bdy },
    );
  }
}

// plain-text rendering of a region (written to the system clipboard alongside
// the structured copy, so grids can be shared as text)
export function regionToText(data) {
  const rows = Array.from({ length: data.h }, () => Array(data.w).fill('.'));
  for (const [dx, dy, flags, letter] of data.cells) {
    rows[dy][dx] = cellToChar(flags, letter);
  }
  return rows.map((r) => r.join('')).join('\n');
}
