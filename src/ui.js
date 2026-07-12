// Canvas grid editor in the Orca/CLAVIER visual idiom.
//
// Interaction model (per CLAVIER src/clavier.c):
//   - plain left-drag: rectangular drag-select; shift+arrows extends selection
//   - cmd/ctrl + left-drag: draw a wire from press cell to release cell;
//     wiring the same pair again removes it (toggle)
//   - typing writes the cell at the cursor (or fills the whole selection);
//     backspace/delete/'.' clears the selection; '`' toggles operator power
//   - cmd/ctrl + C / X / V: copy, cut, paste (cells + wires inside selection)

import { TYPE, getType, getPower, charToCell, cellToChar, makeFlags } from './values.js';
import { copyRegion, cutRegion, pasteRegion, regionToText } from './clipboard.js';

const CELL = 26;
const COLORS = {
  background: '#14151a',
  guide: '#26282f',
  none: '#3a3d46',
  literal: '#9aa3b2',
  operator: '#e8e3d0',
  operatorBg: '#2c2e36',
  unpowered: '#6f6a58',
  bang: '#ffd75f',
  pattern: '#7fd4a8', // U/V get their own color: they're the new thing
  midi: '#df8fb8',
  cursor: '#ffffff',
  selection: 'rgba(255, 255, 255, 0.08)',
  selectionBorder: 'rgba(255, 255, 255, 0.45)',
  wire: '#5f8fbf',
  wirePreview: '#9fc4e8',
};

const PATTERN_TAGS = new Set([30, 31]); // U, V
const MIDI_TAGS = new Set([15, 16, 32, 35]); // F, G, W, Z

export class GridUI {
  constructor(canvas, machine, { onEdit } = {}) {
    this.canvas = canvas;
    this.machine = machine;
    this.onEdit = onEdit;
    this.cursor = { x: 2, y: 2 };
    this.box = { w: 1, h: 1 }; // selection extends from cursor (top-left)
    this.clipboard = null;
    this.ctx = canvas.getContext('2d');

    // mouse interaction state
    this.drag = null; // {mode: 'select'|'wire', origin: {x,y}, current: {x,y}}

    const dpr = window.devicePixelRatio || 1;
    canvas.width = machine.width * CELL * dpr;
    canvas.height = machine.height * CELL * dpr;
    canvas.style.width = `${machine.width * CELL}px`;
    canvas.style.height = `${machine.height * CELL}px`;
    this.ctx.scale(dpr, dpr);

    // focusable, so clicking the grid reclaims keyboard focus from the
    // sidebar inputs (mousedown preventDefault suppresses the default
    // focus transfer, so we move focus explicitly)
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';

    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
  }

  tileAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.machine.width - 1, Math.floor((e.clientX - rect.left) / CELL))),
      y: Math.max(0, Math.min(this.machine.height - 1, Math.floor((e.clientY - rect.top) / CELL))),
    };
  }

  selectionRect() {
    return { x: this.cursor.x, y: this.cursor.y, w: this.box.w, h: this.box.h };
  }

  setSelectionFromDrag(a, b) {
    this.cursor = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    this.box = { w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
  }

  onMouseDown(e) {
    this.canvas.focus();
    const tile = this.tileAt(e);
    if (e.metaKey || e.ctrlKey) {
      this.drag = { mode: 'wire', origin: tile, current: tile };
    } else {
      this.drag = { mode: 'select', origin: tile, current: tile };
      this.cursor = tile;
      this.box = { w: 1, h: 1 };
    }
    e.preventDefault();
  }

  onMouseMove(e) {
    if (!this.drag) return;
    this.drag.current = this.tileAt(e);
    if (this.drag.mode === 'select') {
      this.setSelectionFromDrag(this.drag.origin, this.drag.current);
    }
  }

  onMouseUp() {
    if (!this.drag) return;
    if (this.drag.mode === 'wire') {
      const { origin, current } = this.drag;
      if (origin.x !== current.x || origin.y !== current.y) {
        this.machine.addWire(origin, current);
        this.onEdit?.();
      }
    }
    this.drag = null;
  }

  handleKey(e) {
    const grid = this.machine.grid;
    const meta = e.metaKey || e.ctrlKey;

    // clipboard
    if (meta && (e.key === 'c' || e.key === 'x' || e.key === 'v')) {
      if (e.key === 'v') {
        if (this.clipboard) {
          pasteRegion(this.machine, this.clipboard, this.cursor);
          this.onEdit?.();
        }
      } else {
        const rect = this.selectionRect();
        this.clipboard = e.key === 'x' ? cutRegion(this.machine, rect) : copyRegion(this.machine, rect);
        navigator.clipboard?.writeText(regionToText(this.clipboard)).catch(() => {});
        if (e.key === 'x') this.onEdit?.();
      }
      e.preventDefault();
      return;
    }

    const move = (dx, dy) => {
      this.cursor.x = Math.max(0, Math.min(this.machine.width - 1, this.cursor.x + dx));
      this.cursor.y = Math.max(0, Math.min(this.machine.height - 1, this.cursor.y + dy));
    };
    const grow = (dw, dh) => {
      this.box.w = Math.max(1, Math.min(this.machine.width - this.cursor.x, this.box.w + dw));
      this.box.h = Math.max(1, Math.min(this.machine.height - this.cursor.y, this.box.h + dh));
    };
    const collapse = () => {
      this.box = { w: 1, h: 1 };
    };

    switch (e.key) {
      case 'ArrowUp':
        e.shiftKey ? grow(0, -1) : (collapse(), move(0, -1)); e.preventDefault(); return;
      case 'ArrowDown':
        e.shiftKey ? grow(0, 1) : (collapse(), move(0, 1)); e.preventDefault(); return;
      case 'ArrowLeft':
        e.shiftKey ? grow(-1, 0) : (collapse(), move(-1, 0)); e.preventDefault(); return;
      case 'ArrowRight':
        e.shiftKey ? grow(1, 0) : (collapse(), move(1, 0)); e.preventDefault(); return;
      case 'Escape':
        collapse(); e.preventDefault(); return;
      case 'Backspace':
      case 'Delete':
      case '.': {
        const rect = this.selectionRect();
        for (let dy = 0; dy < rect.h; dy++) {
          for (let dx = 0; dx < rect.w; dx++) {
            grid.set(rect.x + dx, rect.y + dy, { flags: 0, letter: 0 });
          }
        }
        this.onEdit?.();
        if (e.key === 'Backspace' && rect.w === 1 && rect.h === 1) move(-1, 0);
        e.preventDefault();
        return;
      }
      case '`': {
        const rect = this.selectionRect();
        for (let dy = 0; dy < rect.h; dy++) {
          for (let dx = 0; dx < rect.w; dx++) {
            const cell = grid.get(rect.x + dx, rect.y + dy);
            if (getType(cell.flags) === TYPE.OPERATOR) {
              grid.set(rect.x + dx, rect.y + dy, {
                flags: cell.flags ^ makeFlags(0, 0, 1),
                letter: cell.letter,
              });
            }
          }
        }
        this.onEdit?.();
        e.preventDefault();
        return;
      }
      default:
    }

    if (e.key.length === 1 && !meta) {
      const cell = charToCell(e.key);
      if (cell) {
        const rect = this.selectionRect();
        for (let dy = 0; dy < rect.h; dy++) {
          for (let dx = 0; dx < rect.w; dx++) {
            grid.set(rect.x + dx, rect.y + dy, cell);
          }
        }
        this.onEdit?.();
        if (rect.w === 1 && rect.h === 1) move(1, 0);
        e.preventDefault();
      }
    }
  }

  center(p) {
    return [p.x * CELL + CELL / 2, p.y * CELL + CELL / 2];
  }

  drawWire(from, to, color) {
    const { ctx } = this;
    const [x1, y1] = this.center(from);
    const [x2, y2] = this.center(to);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // arrowhead dot at the destination end
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x2 + (x1 - x2) * 0.12, y2 + (y1 - y2) * 0.12, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  render() {
    const { ctx, machine } = this;
    const grid = machine.grid;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, machine.width * CELL, machine.height * CELL);

    // selection (under the glyphs)
    const rect = this.selectionRect();
    ctx.fillStyle = COLORS.selection;
    ctx.fillRect(rect.x * CELL, rect.y * CELL, rect.w * CELL, rect.h * CELL);

    ctx.font = `15px "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let y = 0; y < machine.height; y++) {
      for (let x = 0; x < machine.width; x++) {
        const cell = grid.get(x, y);
        const type = getType(cell.flags);
        const cx = x * CELL + CELL / 2;
        const cy = y * CELL + CELL / 2 + 1;

        if (type === TYPE.NONE) {
          const isGuide = x % 4 === 0 && y % 4 === 0;
          ctx.fillStyle = isGuide ? COLORS.none : COLORS.guide;
          ctx.fillText(isGuide ? '+' : '·', cx, cy);
          continue;
        }

        const char = cellToChar(cell.flags, cell.letter);
        if (type === TYPE.OPERATOR) {
          ctx.fillStyle = COLORS.operatorBg;
          ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
          if (!getPower(cell.flags)) ctx.fillStyle = COLORS.unpowered;
          else if (PATTERN_TAGS.has(cell.letter)) ctx.fillStyle = COLORS.pattern;
          else if (MIDI_TAGS.has(cell.letter)) ctx.fillStyle = COLORS.midi;
          else ctx.fillStyle = COLORS.operator;
        } else if (type === TYPE.BANG) {
          ctx.fillStyle = COLORS.bang;
        } else {
          ctx.fillStyle = COLORS.literal;
        }
        ctx.fillText(char, cx, cy);
      }
    }

    // wires (dotted, over the glyphs but under cursor/preview)
    for (const { from, to } of machine.allWires()) {
      this.drawWire(from, to, COLORS.wire);
    }

    // wire-drag preview
    if (this.drag?.mode === 'wire') {
      const { origin, current } = this.drag;
      if (origin.x !== current.x || origin.y !== current.y) {
        this.drawWire(origin, current, COLORS.wirePreview);
      }
      ctx.strokeStyle = COLORS.wirePreview;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(origin.x * CELL + 0.5, origin.y * CELL + 0.5, CELL - 1, CELL - 1);
    }

    // selection border + cursor
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x * CELL + 0.5, rect.y * CELL + 0.5, rect.w * CELL - 1, rect.h * CELL - 1);
    ctx.strokeStyle = COLORS.cursor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(this.cursor.x * CELL + 0.5, this.cursor.y * CELL + 0.5, CELL - 1, CELL - 1);
  }
}
