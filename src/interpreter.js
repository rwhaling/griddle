// The griddle interpreter: a faithful JS port of CLAVIER-36's interpreter step
// (include/interpreter_step.c, doc/interpreter-design.md), with two changes:
//   - U (tag 30) and V (tag 31) are pattern operators querying the slot bank
//   - ENVELOPE relocates to E, UNQUOTE is dropped, SAMPLER/SYNTH are not ported
//
// Conventions from the C source:
//   - operator input reads are at origin MINUS offset (so offset (2,0) = west(2))
//   - writes are at origin PLUS offset (so offset (0,1) = south)
//   - movement phase reads src / writes dst simultaneously with collision checks
//   - evaluation phase runs in reading order, in place on dst, so operators see
//     same-step outputs of operators above / to the left of them
//   - MIDI operators (Z/W) are NOT evaluated in the step; they are scanned
//     post-step (ring_trigger) and fire when powered AND adjacent to a bang.

import {
  TYPE, DIR_VEC, CARDINALS, RADIX, OCTAVE, SCALE, SCALE_CARDINAL, OP,
  getType, getVelocity, getPower, makeFlags, setVelocity, IMPLEMENTED_OPS,
} from './values.js';
import { PCG } from './pcg.js';
import {
  PHASE, face1296, cc7, targetInternal, glideStep, lfoInc, offsetPhase,
  triAt, lfoPieces, scaleV, crossings,
} from './modulation.js';

const NONE = { flags: 0, letter: 0 };
const BANG = { flags: makeFlags(TYPE.BANG), letter: 0 };
const lit = (v) => ({ flags: makeFlags(TYPE.LITERAL), letter: ((v % RADIX) + RADIX) % RADIX });

const mapZero = (value, revert) => (value === 0 ? revert : value);

class Buffer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.flags = new Uint8Array(width * height);
    this.letter = new Uint8Array(width * height);
  }

  contains(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x, y) {
    if (!this.contains(x, y)) return NONE;
    const i = y * this.width + x;
    return { flags: this.flags[i], letter: this.letter[i] };
  }

  set(x, y, cell) {
    if (!this.contains(x, y)) return;
    const i = y * this.width + x;
    this.flags[i] = cell.flags;
    this.letter[i] = cell.letter;
  }

  clear() {
    this.flags.fill(0);
    this.letter.fill(0);
  }

  copyFrom(other) {
    this.flags.set(other.flags);
    this.letter.set(other.letter);
  }
}

const readLiteral = (cell, fallback) =>
  getType(cell.flags) === TYPE.LITERAL ? cell.letter : fallback;

export class Machine {
  // patterns: { bang(slot, pos) -> boolean, value(slot, pos) -> int|null }
  constructor(width, height, patterns) {
    this.width = width;
    this.height = height;
    this.patterns = patterns;
    this.src = new Buffer(width, height);
    this.dst = new Buffer(width, height);
    this.metronome = 0;
    this.rng = new PCG(0x36n);
    this.registers = Array.from({ length: RADIX }, () => ({ ...NONE }));
    // wiring: key "x,y" -> array of [tx,ty]. Wires are normalized at creation
    // so the source is the endpoint earlier in reading order — recursion in
    // setTransitive therefore always moves forward and terminates.
    this.wires = new Map();
    // per-cell operator state (F/G smoothing), keyed by position with the
    // tag as a guard; reset on play, swept when the operator disappears
    this.opState = new Map();
    // sub-tick CC events emitted by F/G this step: {device, channel,
    // controller, value7, frac} with frac in [0,1) of the tick window
    this.ccEvents = [];
  }

  // the latest completed state; the editor reads and writes this
  get grid() {
    return this.src;
  }

  wireKey(x, y) {
    return `${x},${y}`;
  }

  // toggle a wire between two cells (CLAVIER semantics: re-wiring the same
  // pair removes it). Returns 'added' | 'removed' | null.
  addWire(a, b) {
    const order = (p) => p.y * this.width + p.x;
    if (order(a) === order(b)) return null;
    const inBounds = (p) => p.x >= 0 && p.y >= 0 && p.x < this.width && p.y < this.height;
    if (!inBounds(a) || !inBounds(b)) return null;
    const [src, dst] = order(a) < order(b) ? [a, b] : [b, a];
    const key = this.wireKey(src.x, src.y);
    const targets = this.wires.get(key) ?? [];
    const existing = targets.findIndex(([tx, ty]) => tx === dst.x && ty === dst.y);
    if (existing >= 0) {
      targets.splice(existing, 1);
      if (targets.length === 0) this.wires.delete(key);
      else this.wires.set(key, targets);
      return 'removed';
    }
    targets.push([dst.x, dst.y]);
    this.wires.set(key, targets);
    return 'added';
  }

  // add-if-absent (used by paste, where toggle semantics would delete)
  ensureWire(a, b) {
    const order = (p) => p.y * this.width + p.x;
    if (order(a) === order(b)) return;
    const [src, dst] = order(a) < order(b) ? [a, b] : [b, a];
    const targets = this.wires.get(this.wireKey(src.x, src.y)) ?? [];
    if (!targets.some(([tx, ty]) => tx === dst.x && ty === dst.y)) this.addWire(a, b);
  }

  allWires() {
    const out = [];
    for (const [key, targets] of this.wires) {
      const [x, y] = key.split(',').map(Number);
      for (const [tx, ty] of targets) out.push({ from: { x, y }, to: { x: tx, y: ty } });
    }
    return out;
  }

  clearWires() {
    this.wires.clear();
  }

  // operator writes propagate through wires, transitively (the analogue of
  // CLAVIER's memory_set_transitive); movement and INTERFERE writes do not
  setTransitive(buffer, x, y, cell, seen = null) {
    buffer.set(x, y, cell);
    const targets = this.wires.get(this.wireKey(x, y));
    if (!targets) return;
    seen = seen ?? new Set([this.wireKey(x, y)]);
    for (const [tx, ty] of targets) {
      const key = this.wireKey(tx, ty);
      if (seen.has(key)) continue;
      seen.add(key);
      this.setTransitive(buffer, tx, ty, cell, seen);
    }
  }

  reset() {
    this.metronome = 0;
    this.rng = new PCG(0x36n);
    this.registers = Array.from({ length: RADIX }, () => ({ ...NONE }));
    this.opState.clear();
    this.ccEvents = [];
  }

  step() {
    const { src, dst } = this;

    // ---- phase 1: movement (simultaneous, collision-checked) ----
    dst.clear();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const value = src.get(x, y);
        const velocity = getVelocity(value.flags);
        const [dx, dy] = DIR_VEC[velocity];
        const destX = x + dx;
        const destY = y + dy;

        if (velocity > 0) {
          let occupancy = dst.contains(destX, destY) ? 0 : 1;
          for (const d of CARDINALS) {
            const [adx, ady] = DIR_VEC[d];
            const ax = destX + adx;
            const ay = destY + ady;
            const occupier = src.get(ax, ay);
            if (getType(occupier.flags) === TYPE.NONE) continue;
            const [odx, ody] = DIR_VEC[getVelocity(occupier.flags)];
            if (ax + odx === destX && ay + ody === destY) occupancy += 1;
          }
          if (occupancy <= 1) dst.set(destX, destY, value);
        } else if (getType(value.flags) !== TYPE.NONE) {
          dst.set(destX, destY, value);
        }
      }
    }

    // ---- phase 2: evaluation (reading order, in place on dst) ----
    this.ccEvents = [];
    this.touchedOps = new Set();
    const m = dst;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const value = m.get(x, y);
        if (getType(value.flags) !== TYPE.OPERATOR) continue;

        let bang = false;
        for (const d of CARDINALS) {
          const [adx, ady] = DIR_VEC[d];
          if (getType(m.get(x + adx, y + ady).flags) === TYPE.BANG) bang = true;
        }
        const power = getPower(value.flags);
        if (!power && !bang) continue;

        // reads at origin - offset; writes at origin + offset (and propagate
        // through wires, per CLAVIER's record_write -> memory_set_transitive)
        const read = (ox, oy) => m.get(x - ox, y - oy);
        const write = (ox, oy, cell) => this.setTransitive(m, x + ox, y + oy, cell);

        this.evalOperator(value.letter, read, write, m, x, y, power, bang);
      }
    }

    // sweep state for operators that no longer exist at their position
    for (const key of this.opState.keys()) {
      if (!this.touchedOps.has(key)) this.opState.delete(key);
    }

    this.metronome += 1;

    // swap: dst becomes the new current state
    const tmp = this.src;
    this.src = this.dst;
    this.dst = tmp;
  }

  // F/G helper: queue sub-tick CC events if the operator is addressed
  // (controller cell is a literal — opt-in by addressing). `pieces` is the
  // piecewise-linear trajectory over this tick window; `disc` means a
  // discontinuity (snap/reset): one edge, no staircase burst.
  emitCC(st, addr, currentV, pieces, disc) {
    if (getType(addr.controllerCell.flags) !== TYPE.LITERAL) return;
    const device = addr.device;
    const channel = addr.channel;
    const controller = addr.controllerCell.letter;
    if (disc || !pieces) {
      const c = cc7(currentV);
      if (c !== st.lastCC) {
        this.ccEvents.push({ device, channel, controller, value7: c, frac: 0 });
        st.lastCC = c;
      }
      return;
    }
    const result = crossings(pieces, st.lastCC);
    for (const e of result.events) {
      this.ccEvents.push({ device, channel, controller, ...e });
    }
    st.lastCC = result.lastCC;
  }

  evalOperator(tag, read, write, m, x, y, power, bang) {
    switch (tag) {
      case OP.ADD: {
        const a = readLiteral(read(2, 0), 0);
        const b = readLiteral(read(1, 0), 0);
        write(0, 1, lit((a + b) % RADIX));
        break;
      }
      case OP.SUB: {
        const a = readLiteral(read(2, 0), 0);
        const b = readLiteral(read(1, 0), 0);
        write(0, 1, lit((a - b + RADIX) % RADIX));
        break;
      }
      case OP.MUL: {
        const a = readLiteral(read(2, 0), 1);
        const b = readLiteral(read(1, 0), 1);
        write(0, 1, lit((a * b) % RADIX));
        break;
      }
      case OP.DIV: {
        const a = readLiteral(read(2, 0), 0);
        const b = readLiteral(read(1, 0), 1);
        const d = b === 0 ? RADIX : b;
        write(0, 1, lit(Math.floor(a / d)));
        break;
      }
      case OP.MOD: {
        const a = readLiteral(read(2, 0), 0);
        const b = readLiteral(read(1, 0), 1);
        const d = b === 0 ? RADIX : b;
        write(0, 1, lit(a % d));
        break;
      }
      case OP.EQUAL: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        const same = getType(lhs.flags) === getType(rhs.flags) && lhs.letter === rhs.letter;
        write(0, 1, same ? BANG : NONE);
        break;
      }
      case OP.GREATER: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        const hit = getType(lhs.flags) === getType(rhs.flags) && lhs.letter > rhs.letter;
        write(0, 1, hit ? BANG : NONE);
        break;
      }
      case OP.LESSER: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        const hit = getType(lhs.flags) === getType(rhs.flags) && lhs.letter < rhs.letter;
        write(0, 1, hit ? BANG : NONE);
        break;
      }
      case OP.AND: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        if (getType(lhs.flags) === TYPE.LITERAL && getType(rhs.flags) === TYPE.LITERAL) {
          write(0, 1, lit(lhs.letter & rhs.letter));
        } else if (getType(lhs.flags) === TYPE.BANG && getType(rhs.flags) === TYPE.BANG) {
          write(0, 1, BANG);
        } else {
          write(0, 1, NONE);
        }
        break;
      }
      case OP.OR: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        if (getType(lhs.flags) === TYPE.LITERAL && getType(rhs.flags) === TYPE.LITERAL) {
          write(0, 1, lit((lhs.letter | rhs.letter) % RADIX));
        } else if (getType(lhs.flags) === TYPE.BANG || getType(rhs.flags) === TYPE.BANG) {
          write(0, 1, BANG);
        } else {
          write(0, 1, NONE);
        }
        break;
      }
      case OP.ALTER: {
        const t = read(3, 0);
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        if (
          getType(t.flags) === TYPE.LITERAL &&
          getType(lhs.flags) === TYPE.LITERAL &&
          getType(rhs.flags) === TYPE.LITERAL
        ) {
          const scale = RADIX - 1;
          write(0, 1, lit(Math.floor(((scale - t.letter) * lhs.letter + t.letter * rhs.letter) / scale)));
        }
        break;
      }
      case OP.BOTTOM: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        if (getType(lhs.flags) === TYPE.LITERAL || getType(rhs.flags) === TYPE.LITERAL) {
          write(0, 1, lit(Math.min(readLiteral(lhs, 0), readLiteral(rhs, 0))));
        }
        break;
      }
      case OP.TOP: {
        const lhs = read(2, 0);
        const rhs = read(1, 0);
        if (getType(lhs.flags) === TYPE.LITERAL || getType(rhs.flags) === TYPE.LITERAL) {
          write(0, 1, lit(Math.max(readLiteral(lhs, 0), readLiteral(rhs, 0))));
        }
        break;
      }
      case OP.CLOCK: {
        const rate = mapZero(readLiteral(read(2, 0), 1), RADIX);
        const mod = mapZero(readLiteral(read(1, 0), 0), RADIX);
        if (this.metronome % rate === 0) {
          write(0, 1, lit(Math.floor(this.metronome / rate) % mod));
        }
        break;
      }
      case OP.PENDULUM: {
        const rate = mapZero(readLiteral(read(2, 0), 1), RADIX);
        const mod = mapZero(readLiteral(read(1, 0), 1), RADIX);
        write(0, 1, this.metronome % (rate * mod) === 0 ? BANG : NONE);
        break;
      }
      case OP.ENVELOPE: {
        // CLAVIER's envelope, relocated from V to E
        const rise = readLiteral(read(1, 0), 0);
        const fall = readLiteral(read(2, 0), 0);
        const mult = mapZero(readLiteral(read(3, 0), 1), RADIX);
        const effRise = rise * RADIX * mult;
        const effFall = fall * RADIX * mult;
        const total = effRise + effFall;
        if (total <= 0) break;
        const phase = this.metronome % total;
        const out =
          phase < effRise
            ? Math.floor(phase / (rise * mult))
            : RADIX - (1 + Math.floor((phase - effRise) / (fall * mult)));
        write(0, 1, lit(out));
        break;
      }
      case OP.HOP: {
        write(1, 0, read(1, 0)); // west(1) hops over to east(1)
        break;
      }
      case OP.JUMP: {
        write(0, 1, read(0, 1)); // north(1) jumps down to south(1)
        break;
      }
      case OP.LOAD: {
        const reg = read(1, 0);
        if (getType(reg.flags) === TYPE.LITERAL) {
          write(0, 1, { ...this.registers[reg.letter] });
        } else {
          write(0, 1, NONE);
        }
        break;
      }
      case OP.STORE: {
        const set = read(2, 0);
        const reg = read(1, 0);
        if (getType(reg.flags) === TYPE.LITERAL) {
          this.registers[reg.letter] = { ...set };
        }
        break;
      }
      case OP.MULTIPLEX: {
        const xv = readLiteral(read(2, 0), 0);
        const yv = readLiteral(read(1, 0), 0);
        write(0, 1, read(-xv, yv + 1));
        break;
      }
      case OP.NOTE: {
        const index = readLiteral(read(1, 0), 0);
        const octave = Math.floor(index / SCALE_CARDINAL);
        const note = index % SCALE_CARDINAL;
        write(0, 1, lit((OCTAVE * octave + SCALE[note]) % RADIX));
        break;
      }
      case OP.QUOTE: {
        const index = read(1, 0);
        if (getType(index.flags) === TYPE.LITERAL && IMPLEMENTED_OPS.has(index.letter)) {
          write(0, 1, { flags: makeFlags(TYPE.OPERATOR, 0, 1), letter: index.letter });
        } else {
          write(0, 1, NONE);
        }
        break;
      }
      case OP.RANDOM: {
        const rate = mapZero(readLiteral(read(2, 0), 1), RADIX);
        if (this.metronome % rate === 0) {
          const mod = mapZero(readLiteral(read(1, 0), 0), RADIX);
          write(0, 1, lit(this.rng.next() % mod));
        }
        break;
      }
      case OP.INTERFERE: {
        const iv = read(4, 0);
        const vv = read(3, 0);
        const xv = readLiteral(read(2, 0), 0);
        const yv = readLiteral(read(1, 0), 0);
        const d =
          getType(vv.flags) === TYPE.LITERAL && getType(iv.flags) !== TYPE.NONE
            ? 1 + (vv.letter % 4)
            : 0;
        m.set(x + xv, y + yv + 1, { flags: setVelocity(iv.flags, d), letter: iv.letter });
        break;
      }
      case OP.GLIDE: {
        // G: slew toward target at quadratic rate; two faces of one state
        // (grid pair at tick resolution, CC crossings sub-tick). Unpowered =
        // frozen, even when banged; powered + bang = snap to target.
        if (!power) break;
        const key = `${x},${y}`;
        let st = this.opState.get(key);
        const targetCell = read(2, 0);
        const hasTarget = getType(targetCell.flags) === TYPE.LITERAL;
        const target = hasTarget ? targetInternal(targetCell.letter) : null;
        if (!st || st.tag !== OP.GLIDE) {
          // init at target: a freshly placed G arrives instantly, no
          // surprise sweep from zero
          st = { tag: OP.GLIDE, v: target ?? 0, lastCC: null };
          this.opState.set(key, st);
        }
        this.touchedOps.add(key);
        const goal = target ?? st.v; // no target cell -> hold position
        const oldV = st.v;
        let pieces = null;
        let disc = false;
        if (bang) {
          st.v = goal;
          disc = true;
        } else {
          const step = glideStep(readLiteral(read(1, 0), 8));
          if (st.v < goal) st.v = Math.min(goal, st.v + step);
          else if (st.v > goal) st.v = Math.max(goal, st.v - step);
          pieces = [{ v0: oldV, v1: st.v, f0: 0, f1: 1 }];
        }
        this.emitCC(
          st,
          {
            device: readLiteral(read(5, 0), 0),
            channel: readLiteral(read(4, 0), 0),
            controllerCell: read(3, 0),
          },
          st.v,
          pieces,
          disc,
        );
        const face = face1296(st.v);
        write(0, 1, lit(Math.floor(face / 36)));
        write(1, 1, lit(face % 36));
        break;
      }
      case OP.LFO: {
        // F: triangle phase accumulator; rate changes never touch the
        // accumulator (no phase jump); bang resets phase; offset applied at
        // read time; min/max ports scale the output (min > max inverts).
        if (!power) break;
        const key = `${x},${y}`;
        let st = this.opState.get(key);
        if (!st || st.tag !== OP.LFO) {
          st = { tag: OP.LFO, phase: 0, lastCC: null };
          this.opState.set(key, st);
        }
        this.touchedOps.add(key);
        const lo = targetInternal(readLiteral(read(4, 0), 0));
        const hi = targetInternal(readLiteral(read(3, 0), 35));
        const off = offsetPhase(readLiteral(read(1, 0), 0));
        let pieces = null;
        let disc = false;
        if (bang) {
          st.phase = 0;
          disc = true;
        } else {
          const inc = lfoInc(readLiteral(read(2, 0), 8));
          pieces = lfoPieces(st.phase + off, inc).map((p) => ({
            ...p,
            v0: scaleV(p.v0, lo, hi),
            v1: scaleV(p.v1, lo, hi),
          }));
          st.phase = (st.phase + inc) % PHASE;
        }
        const outV = scaleV(triAt(st.phase + off), lo, hi);
        this.emitCC(
          st,
          {
            device: readLiteral(read(7, 0), 0),
            channel: readLiteral(read(6, 0), 0),
            controllerCell: read(5, 0),
          },
          outV,
          pieces,
          disc,
        );
        const face = face1296(outV);
        write(0, 1, lit(Math.floor(face / 36)));
        write(1, 1, lit(face % 36));
        break;
      }
      case OP.PATTERN_BANG: {
        // U: pure function of (slot, position); always writes (bang-producer
        // convention), so a missed step clears last tick's bang
        const slot = read(2, 0);
        const pos = readLiteral(read(1, 0), 0);
        let out = NONE;
        if (getType(slot.flags) === TYPE.LITERAL && this.patterns?.bang(slot.letter, pos)) {
          out = BANG;
        }
        write(0, 1, out);
        break;
      }
      case OP.PATTERN_VALUE: {
        // V: earliest onset's value in the position window, coerced to base-36;
        // continuous signals sample-and-hold; rests write NONE (no hidden state)
        const slot = read(2, 0);
        const pos = readLiteral(read(1, 0), 0);
        let out = NONE;
        if (getType(slot.flags) === TYPE.LITERAL && this.patterns) {
          const v = this.patterns.value(slot.letter, pos);
          if (v !== null && v !== undefined) out = lit(v);
        }
        write(0, 1, out);
        break;
      }
      // Z and W are scanned post-step (see scanMidi), not evaluated here
      default:
        break;
    }
  }

  // Post-step scan for MIDI operators, the analogue of CLAVIER's ring_trigger:
  // fires when powered AND adjacent to a bang. Returns events for the host to
  // schedule; the interpreter itself never touches I/O.
  scanMidi() {
    const m = this.src; // post-step state
    const events = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const value = m.get(x, y);
        if (getType(value.flags) !== TYPE.OPERATOR) continue;
        if (value.letter !== OP.MIDI && value.letter !== OP.MIDI_CC) continue;

        let bang = false;
        for (const d of CARDINALS) {
          const [adx, ady] = DIR_VEC[d];
          if (getType(m.get(x + adx, y + ady).flags) === TYPE.BANG) bang = true;
        }
        if (!bang || !getPower(value.flags)) continue;

        const param = (o, fallback) => readLiteral(m.get(x - o, y), fallback);

        if (value.letter === OP.MIDI) {
          const device = param(6, 0);
          const channel = param(5, 0);
          const velocity = param(4, 24);
          const hold = param(3, 0);
          const octave = param(2, 4);
          const pitch = param(1, 0);
          // duration encoding: 0-32 are ticks, 33-35 are (v-32) bars of 32 ticks
          const holdTicks = hold <= 32 ? hold : (hold - 32) * 32;
          events.push({
            type: 'note',
            device,
            channel,
            note: OCTAVE * octave + pitch,
            velocity: Math.floor((velocity * 127) / 35),
            holdTicks,
          });
        } else {
          const device = param(4, 0);
          const channel = param(3, 0);
          const controller = param(2, 0);
          const knob = param(1, 0);
          events.push({
            type: 'cc',
            device,
            channel,
            controller,
            value: Math.floor((knob * 127) / 35),
          });
        }
      }
    }
    return events;
  }
}
