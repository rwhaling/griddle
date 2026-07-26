// Canvas grid editor in the Orca/CLAVIER visual idiom, with a keyboard-first
// viewport for grids larger than the window.
//
// Interaction model (per CLAVIER src/clavier.c, plus griddle additions):
//   - plain left-drag: rectangular drag-select; shift+arrows extends selection
//   - cmd/ctrl + left-drag: draw a wire from press cell to release cell;
//     wiring the same pair again removes it (toggle)
//   - typing writes the cell at the cursor (or fills the whole selection);
//     backspace/delete/'.' clears the selection; '`' toggles operator power
//   - '#' toggles MUTE across the selection (comment-out; muted operators
//     don't evaluate, rendered dimmed)
//   - cmd/ctrl + C / X / V: copy, cut, paste (cells + wires inside selection)
//   - cmd/ctrl + A: select all
//   - navigation is a side effect of editing: the camera keeps the cursor in
//     view, so arrows/typing auto-pan; alt+arrows leap 8 cells; '['/']' zoom

import { TYPE, getType, getPower, getMuted, MUTE_BIT, charToCell, cellToChar, makeFlags } from './values.js';
import { copyRegion, cutRegion, pasteRegion, regionToText } from './clipboard.js';

const COLORS = {
  background: '#14151a',
  outside: '#0e0f12',
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
  gridBorder: '#26282f',
};

const PATTERN_TAGS = new Set([30, 31]); // U, V
const MIDI_TAGS = new Set([15, 16, 32, 35]); // F, G, W, Z
const MUTED_ALPHA = 0.3;
const LEAP = 8;
const ZOOM_MIN = 14;
const ZOOM_MAX = 34;
const ZOOM_STEP = 4;

export class GridUI {
  constructor(canvas, machine, { onEdit } = {}) {
    this.canvas = canvas;
    this.machine = machine;
    this.onEdit = onEdit;
    this.cursor = { x: 2, y: 2 };
    this.box = { w: 1, h: 1 }; // selection extends from cursor (top-left)
    this.clipboard = null;
    this.ctx = canvas.getContext('2d');

    this.cell = 26; // px per cell, zoomable
    this.camera = { x: 0, y: 0 }; // top-left visible cell

    // mouse interaction state
    this.drag = null; // {mode: 'select'|'wire', origin: {x,y}, current: {x,y}}

    // focusable, so clicking the grid reclaims keyboard focus from the
    // sidebar inputs (mousedown preventDefault suppresses the default
    // focus transfer, so we move focus explicitly)
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
  }

  resizeCanvas() {
    const parent = this.canvas.parentElement;
    this.viewW = Math.max(200, parent.clientWidth);
    this.viewH = Math.max(150, parent.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.viewW * dpr;
    this.canvas.height = this.viewH * dpr;
    this.canvas.style.width = `${this.viewW}px`;
    this.canvas.style.height = `${this.viewH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampCamera();
  }

  visibleCols() {
    return Math.floor(this.viewW / this.cell);
  }

  visibleRows() {
    return Math.floor(this.viewH / this.cell);
  }

  clampCamera() {
    this.camera.x = Math.max(0, Math.min(this.machine.width - this.visibleCols(), this.camera.x));
    this.camera.y = Math.max(0, Math.min(this.machine.height - this.visibleRows(), this.camera.y));
  }

  // keep the cursor in view with a margin — navigation as a side effect
  ensureVisible() {
    const cols = this.visibleCols();
    const rows = this.visibleRows();
    const margin = 2;
    const { x, y } = this.cursor;
    if (x < this.camera.x + margin) this.camera.x = x - margin;
    if (x > this.camera.x + cols - 1 - margin) this.camera.x = x - cols + 1 + margin;
    if (y < this.camera.y + margin) this.camera.y = y - margin;
    if (y > this.camera.y + rows - 1 - margin) this.camera.y = y - rows + 1 + margin;
    this.clampCamera();
  }

  setZoom(delta) {
    this.cell = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.cell + delta));
    this.clampCamera();
    this.ensureVisible();
  }

  tileAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.machine.width - 1,
        this.camera.x + Math.floor((e.clientX - rect.left) / this.cell))),
      y: Math.max(0, Math.min(this.machine.height - 1,
        this.camera.y + Math.floor((e.clientY - rect.top) / this.cell))),
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

  forSelection(fn) {
    const rect = this.selectionRect();
    for (let dy = 0; dy < rect.h; dy++) {
      for (let dx = 0; dx < rect.w; dx++) {
        fn(rect.x + dx, rect.y + dy);
      }
    }
    return rect;
  }

  handleKey(e) {
    const grid = this.machine.grid;
    const meta = e.metaKey || e.ctrlKey;

    // clipboard + select all — but if the user has selected page text
    // (an error message, the mount bar), native copy must win
    if (meta && e.key === 'c' && !window.getSelection?.().isCollapsed) return;
    if (meta && (e.key === 'c' || e.key === 'x' || e.key === 'v' || e.key === 'a')) {
      if (e.key === 'a') {
        this.cursor = { x: 0, y: 0 };
        this.box = { w: this.machine.width, h: this.machine.height };
      } else if (e.key === 'v') {
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

    const step = e.altKey ? LEAP : 1;
    const move = (dx, dy) => {
      this.cursor.x = Math.max(0, Math.min(this.machine.width - 1, this.cursor.x + dx * step));
      this.cursor.y = Math.max(0, Math.min(this.machine.height - 1, this.cursor.y + dy * step));
      this.ensureVisible();
    };
    const grow = (dw, dh) => {
      this.box.w = Math.max(1, Math.min(this.machine.width - this.cursor.x, this.box.w + dw * step));
      this.box.h = Math.max(1, Math.min(this.machine.height - this.cursor.y, this.box.h + dh * step));
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
      case '[':
        this.setZoom(-ZOOM_STEP); e.preventDefault(); return;
      case ']':
        this.setZoom(ZOOM_STEP); e.preventDefault(); return;
      case 'Backspace':
      case 'Delete':
      case '.': {
        const rect = this.forSelection((x, y) => grid.set(x, y, { flags: 0, letter: 0 }));
        this.onEdit?.();
        if (e.key === 'Backspace' && rect.w === 1 && rect.h === 1) move(-1, 0);
        e.preventDefault();
        return;
      }
      case '`': {
        this.forSelection((x, y) => {
          const cell = grid.get(x, y);
          if (getType(cell.flags) === TYPE.OPERATOR) {
            grid.set(x, y, { flags: cell.flags ^ makeFlags(0, 0, 1), letter: cell.letter });
          }
        });
        this.onEdit?.();
        e.preventDefault();
        return;
      }
      case '#': {
        // mute toggle: if anything in the selection is unmuted, mute all;
        // otherwise unmute all (deterministic on mixed selections)
        let anyUnmuted = false;
        this.forSelection((x, y) => {
          const cell = grid.get(x, y);
          if (getType(cell.flags) !== TYPE.NONE && !getMuted(cell.flags)) anyUnmuted = true;
        });
        this.forSelection((x, y) => {
          const cell = grid.get(x, y);
          if (getType(cell.flags) === TYPE.NONE) return;
          const muted = getMuted(cell.flags);
          if (anyUnmuted && !muted) grid.set(x, y, { flags: cell.flags | MUTE_BIT, letter: cell.letter });
          if (!anyUnmuted && muted) grid.set(x, y, { flags: cell.flags & ~MUTE_BIT, letter: cell.letter });
        });
        this.onEdit?.();
        e.preventDefault();
        return;
      }
      default:
    }

    if (e.key.length === 1 && !meta && !e.altKey) {
      const cell = charToCell(e.key);
      if (cell) {
        const rect = this.forSelection((x, y) => grid.set(x, y, cell));
        this.onEdit?.();
        if (rect.w === 1 && rect.h === 1) move(1, 0);
        e.preventDefault();
      }
    }
  }

  toScreen(gx, gy) {
    return [(gx - this.camera.x) * this.cell, (gy - this.camera.y) * this.cell];
  }

  center(p) {
    const [sx, sy] = this.toScreen(p.x, p.y);
    return [sx + this.cell / 2, sy + this.cell / 2];
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
    const { ctx, machine, cell } = this;
    const grid = machine.grid;
    ctx.fillStyle = COLORS.outside;
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    // grid extent background + border
    const [gx0, gy0] = this.toScreen(0, 0);
    const [gx1, gy1] = this.toScreen(machine.width, machine.height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
    ctx.strokeStyle = COLORS.gridBorder;
    ctx.strokeRect(gx0 + 0.5, gy0 + 0.5, gx1 - gx0 - 1, gy1 - gy0 - 1);

    // selection (under the glyphs)
    const rect = this.selectionRect();
    const [selX, selY] = this.toScreen(rect.x, rect.y);
    ctx.fillStyle = COLORS.selection;
    ctx.fillRect(selX, selY, rect.w * cell, rect.h * cell);

    ctx.font = `${Math.round(cell * 0.58)}px "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const x0 = this.camera.x;
    const y0 = this.camera.y;
    const x1 = Math.min(machine.width, x0 + this.visibleCols() + 1);
    const y1 = Math.min(machine.height, y0 + this.visibleRows() + 1);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const c = grid.get(x, y);
        const type = getType(c.flags);
        const [sx, sy] = this.toScreen(x, y);
        const cx = sx + cell / 2;
        const cy = sy + cell / 2 + 1;

        if (type === TYPE.NONE) {
          const isGuide = x % 4 === 0 && y % 4 === 0;
          ctx.fillStyle = isGuide ? COLORS.none : COLORS.guide;
          ctx.fillText(isGuide ? '+' : '·', cx, cy);
          continue;
        }

        const muted = getMuted(c.flags);
        if (muted) ctx.globalAlpha = MUTED_ALPHA;

        const char = cellToChar(c.flags, c.letter);
        if (type === TYPE.OPERATOR) {
          ctx.fillStyle = COLORS.operatorBg;
          ctx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2);
          if (!getPower(c.flags)) ctx.fillStyle = COLORS.unpowered;
          else if (PATTERN_TAGS.has(c.letter)) ctx.fillStyle = COLORS.pattern;
          else if (MIDI_TAGS.has(c.letter)) ctx.fillStyle = COLORS.midi;
          else ctx.fillStyle = COLORS.operator;
        } else if (type === TYPE.BANG) {
          ctx.fillStyle = COLORS.bang;
        } else {
          ctx.fillStyle = COLORS.literal;
        }
        ctx.fillText(char, cx, cy);
        if (muted) ctx.globalAlpha = 1;
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
      const [ox, oy] = this.toScreen(origin.x, origin.y);
      ctx.strokeStyle = COLORS.wirePreview;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + 0.5, oy + 0.5, cell - 1, cell - 1);
    }

    // selection border + cursor
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(selX + 0.5, selY + 0.5, rect.w * cell - 1, rect.h * cell - 1);
    const [curX, curY] = this.toScreen(this.cursor.x, this.cursor.y);
    ctx.strokeStyle = COLORS.cursor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(curX + 0.5, curY + 0.5, cell - 1, cell - 1);
  }
}
