// Per-operator port metadata: powers the context-line inspector (what is
// under the cursor, with live port values and resolved mounts) and the
// grid's port highlighting. One table, two consumers.

import { OP, TYPE, getType, cellToChar, toB36Char } from './values.js';

// ins: [westOffset, label]; outs: [dx, dy, label] (write positions)
export const PORTS = {
  [OP.ADD]: { name: 'add', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'sum']] },
  [OP.SUB]: { name: 'sub', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'diff']] },
  [OP.MUL]: { name: 'mul', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'prod']] },
  [OP.DIV]: { name: 'div', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'quot']] },
  [OP.MOD]: { name: 'modulo', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'rem']] },
  [OP.EQUAL]: { name: 'equal', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'bang']] },
  [OP.GREATER]: { name: 'greater', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'bang']] },
  [OP.LESSER]: { name: 'lesser', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'bang']] },
  [OP.AND]: { name: 'and', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'out']] },
  [OP.OR]: { name: 'or', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'out']] },
  [OP.ALTER]: { name: 'alter', ins: [[3, 't'], [2, 'min'], [1, 'max']], outs: [[0, 1, 'lerp']] },
  [OP.BOTTOM]: { name: 'bottom', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'min']] },
  [OP.TOP]: { name: 'top', ins: [[2, 'a'], [1, 'b']], outs: [[0, 1, 'max']] },
  [OP.CLOCK]: { name: 'clock', ins: [[2, 'rate'], [1, 'mod']], outs: [[0, 1, 'count']] },
  [OP.PENDULUM]: { name: 'pendulum', ins: [[2, 'rate'], [1, 'mod']], outs: [[0, 1, 'bang']] },
  [OP.ENVELOPE]: { name: 'envelope', ins: [[3, 'mult'], [2, 'fall'], [1, 'rise']], outs: [[0, 1, 'level']] },
  [OP.HOP]: { name: 'hop', ins: [[1, 'in']], outs: [[1, 0, 'out']] },
  [OP.INTERFERE]: { name: 'interfere', ins: [[4, 'val'], [3, 'vel'], [2, 'x'], [1, 'y']], outs: [] },
  [OP.JUMP]: { name: 'jump', ins: [], outs: [[0, 1, 'out']] }, // reads north
  [OP.LOAD]: { name: 'load', ins: [[1, 'reg']], outs: [[0, 1, 'val']] },
  [OP.MULTIPLEX]: { name: 'multiplex', ins: [[2, 'x'], [1, 'y']], outs: [[0, 1, 'val']] },
  [OP.NOTE]: { name: 'note', ins: [[1, 'idx']], outs: [[0, 1, 'pitch']] },
  [OP.QUOTE]: { name: 'quote', ins: [[1, 'idx']], outs: [[0, 1, 'op']] },
  [OP.RANDOM]: { name: 'random', ins: [[2, 'rate'], [1, 'mod']], outs: [[0, 1, 'val']] },
  [OP.STORE]: { name: 'store', ins: [[2, 'val'], [1, 'reg']], outs: [] },
  [OP.PATTERN_BANG]: { name: 'U · pattern strike', ins: [[4, 'dev'], [3, 'ch'], [2, 'slot'], [1, 'drive']], outs: [[0, 1, 'bang']] },
  [OP.PATTERN_VALUE]: { name: 'V · pattern sound', ins: [[4, 'dev'], [3, 'ch'], [2, 'slot'], [1, 'drive']], outs: [[0, 1, 'val']] },
  [OP.LFO]: { name: 'F · mounted lfo', ins: [[7, 'dev'], [6, 'ch'], [5, 'ctrl'], [4, 'min'], [3, 'max'], [2, 'slot'], [1, 'mod']], outs: [[0, 1, 'coarse'], [1, 1, 'fine']] },
  [OP.GLIDE]: { name: 'G · glide', ins: [[5, 'dev'], [4, 'ch'], [3, 'ctrl'], [2, 'tgt'], [1, 'rate']], outs: [[0, 1, 'coarse'], [1, 1, 'fine']] },
  [OP.MIDI_CC]: { name: 'W · midi cc', ins: [[4, 'dev'], [3, 'ch'], [2, 'ctrl'], [1, 'val']], outs: [] },
  [OP.MIDI]: { name: 'Z · midi note', ins: [[6, 'dev'], [5, 'ch'], [4, 'vel'], [3, 'hold'], [2, 'oct'], [1, 'pitch']], outs: [] },
};

const cellStr = (machine, x, y) => {
  const c = machine.grid.get(x, y);
  return getType(c.flags) === TYPE.NONE ? '–' : cellToChar(c.flags, c.letter);
};

function summarizeArtifact(art) {
  if (!art) return 'NO MOUNT';
  if (art.kind === 'lfo') {
    const shape = art.procedural ?? 'shape';
    const mod = art.mod ? ` mod:${art.mod.name}` : '';
    return `lfo ${shape} ${+art.cycleTicks.toFixed(1)}t${art.sync ? ' sync' : ''}${mod}`;
  }
  if (art.kind === 'pattern') {
    const mode = art.cycleTicks === null ? `positional ${art.steps ?? 36} steps` : `cycle ${+art.cycleTicks.toFixed(1)}t${art.sync ? ' sync' : ''}`;
    const mod = art.mod ? ` mod:${art.mod.name}` : '';
    return `pattern · ${mode}${mod}`;
  }
  return art.kind;
}

// the context line for the cell under the cursor
export function describeAt(machine, x, y) {
  const cell = machine.grid.get(x, y);
  const type = getType(cell.flags);

  if (type === TYPE.OPERATOR) {
    const spec = PORTS[cell.letter];
    if (!spec) return `operator ${cellToChar(cell.flags, cell.letter)}`;
    const parts = spec.ins.map(([off, label]) => `${label} ${cellStr(machine, x - off, y)}`);
    let resolved = '';
    // slot-consuming operators resolve their mount live
    if ([OP.LFO, OP.PATTERN_BANG, OP.PATTERN_VALUE].includes(cell.letter)) {
      const sigil = cell.letter === OP.LFO ? '@' : '$';
      const devOff = spec.ins.find(([, l]) => l === 'dev')[0];
      const slotOff = spec.ins.find(([, l]) => l === 'slot')[0];
      const devCell = machine.grid.get(x - devOff, y);
      const slotCell = machine.grid.get(x - slotOff, y);
      if (getType(slotCell.flags) === TYPE.LITERAL) {
        const dev = getType(devCell.flags) === TYPE.LITERAL ? devCell.letter : 0;
        const art = machine.mounts?.lookup(sigil, dev, slotCell.letter);
        resolved = ` → ${sigil}${toB36Char(slotCell.letter)} ${summarizeArtifact(art)}`;
      } else {
        resolved = ' → no slot';
      }
    }
    return `${spec.name} · ${parts.join(' · ')}${resolved}`;
  }

  // non-operator: what reads or writes this cell? (reverse port lookup)
  const roles = [];
  for (let k = 1; k <= 7; k++) {
    const op = machine.grid.get(x + k, y);
    if (getType(op.flags) !== TYPE.OPERATOR) continue;
    const spec = PORTS[op.letter];
    const hit = spec?.ins.find(([off]) => off === k);
    if (hit) roles.push(`${hit[1]} of ${spec.name.split(' ')[0]}`);
  }
  for (const [dx, dy] of [[0, 1], [1, 1], [1, 0]]) {
    const op = machine.grid.get(x - dx, y - dy);
    if (getType(op.flags) === TYPE.OPERATOR) {
      const spec = PORTS[op.letter];
      const out = spec?.outs.find(([ox, oy]) => ox === dx && oy === dy);
      if (out) roles.push(`${out[2]} out of ${spec.name.split(' ')[0]}`);
    }
  }
  const what =
    type === TYPE.NONE ? 'empty' : type === TYPE.BANG ? 'bang' : `literal ${cellToChar(cell.flags, cell.letter)}`;
  return roles.length ? `${what} · ${roles.slice(0, 3).join(' · ')}` : what;
}

// port cells to tint when the cursor sits on an operator
export function portCells(machine, x, y) {
  const cell = machine.grid.get(x, y);
  if (getType(cell.flags) !== TYPE.OPERATOR) return null;
  const spec = PORTS[cell.letter];
  if (!spec) return null;
  return {
    ins: spec.ins.map(([off]) => [x - off, y]),
    outs: spec.outs.map(([dx, dy]) => [x + dx, y + dy]),
  };
}
