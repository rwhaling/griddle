// Value representation, ported from CLAVIER-36 (include/interpreter.h).
// A cell is two bytes: flags (type/velocity/power bit fields) + letter (payload).

export const RADIX = 36;
export const OCTAVE = 12;

export const TYPE = { NONE: 0, BANG: 1, LITERAL: 2, OPERATOR: 3 };

export const DIR = { NONE: 0, N: 1, E: 2, S: 3, W: 4 };
export const DIR_VEC = [
  [0, 0],
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
export const CARDINALS = [DIR.N, DIR.E, DIR.S, DIR.W];

const SHIFT_VELOCITY = 2;
const SHIFT_POWER = 5;
const SHIFT_MUTE = 6; // griddle addition: bit 6 (unused in CLAVIER) = muted

export const getType = (flags) => flags & 0b11;
export const getVelocity = (flags) => (flags >> SHIFT_VELOCITY) & 0b111;
export const getPower = (flags) => (flags >> SHIFT_POWER) & 1;
export const getMuted = (flags) => (flags >> SHIFT_MUTE) & 1;
export const MUTE_BIT = 1 << SHIFT_MUTE;

export const makeFlags = (type, velocity = 0, power = 0) =>
  (type & 0b11) | ((velocity & 0b111) << SHIFT_VELOCITY) | ((power & 1) << SHIFT_POWER);

export const setVelocity = (flags, velocity) =>
  (flags & ~(0b111 << SHIFT_VELOCITY)) | ((velocity & 0b111) << SHIFT_VELOCITY);

// Operator tags follow CLAVIER's enum: tags 0-9 are the symbol operators, and
// tags 10-35 are exactly the base-36 values of their letters, which is what
// keeps QUOTE coherent (literal 12 = 'c' quotes to CLOCK).
// Griddle changes: ENVELOPE relocates V->E (tag 14), UNQUOTE is dropped, and
// U (30) / V (31) become the pattern operators. SAMPLER/SYNTH are not ported.
export const OP = {
  ADD: 0,
  SUB: 1,
  MUL: 2,
  DIV: 3,
  MOD: 4,
  EQUAL: 5,
  GREATER: 6,
  LESSER: 7,
  AND: 8,
  OR: 9,
  ALTER: 10, // A
  BOTTOM: 11, // B
  CLOCK: 12, // C
  ENVELOPE: 14, // E (relocated from CLAVIER's V)
  LFO: 15, // F (griddle: smooth-CC LFO)
  GLIDE: 16, // G (griddle: smooth-CC glide/slew)
  HOP: 17, // H
  INTERFERE: 18, // I
  JUMP: 19, // J
  LOAD: 21, // L
  MULTIPLEX: 22, // M
  NOTE: 23, // N
  PENDULUM: 25, // P
  QUOTE: 26, // Q
  RANDOM: 27, // R
  STORE: 28, // S
  TOP: 29, // T
  PATTERN_BANG: 30, // U (griddle)
  PATTERN_VALUE: 31, // V (griddle)
  MIDI_CC: 32, // W
  MIDI: 35, // Z
};

const SYMBOL_CHARS = '+-*/%=><&|';

export const IMPLEMENTED_OPS = new Set(Object.values(OP));

export const opChar = (tag) =>
  tag < 10 ? SYMBOL_CHARS[tag] : tag.toString(36).toUpperCase();

export const charToOp = (ch) => {
  const sym = SYMBOL_CHARS.indexOf(ch);
  if (sym >= 0) return sym;
  if (/^[A-Z]$/.test(ch)) {
    const tag = parseInt(ch.toLowerCase(), 36);
    if (IMPLEMENTED_OPS.has(tag)) return tag;
  }
  return null;
};

export const toB36Char = (v) => v.toString(36);
export const fromB36Char = (ch) => parseInt(ch, 36);

// Editor input mapping, per CLAVIER's character table (src/clavier.c):
// digits and lowercase letters are literals, uppercase letters and symbols
// are powered operators, '!' is a bang.
export const charToCell = (ch) => {
  if (/^[0-9a-z]$/.test(ch)) return { flags: makeFlags(TYPE.LITERAL), letter: fromB36Char(ch) };
  if (ch === '!') return { flags: makeFlags(TYPE.BANG), letter: 0 };
  const tag = charToOp(ch);
  if (tag !== null) return { flags: makeFlags(TYPE.OPERATOR, 0, 1), letter: tag };
  return null;
};

export const cellToChar = (flags, letter) => {
  switch (getType(flags)) {
    case TYPE.NONE: return '.';
    case TYPE.BANG: return '!';
    case TYPE.LITERAL: return toB36Char(letter);
    case TYPE.OPERATOR: return opChar(letter);
    default: return '?';
  }
};

// major scale, as in CLAVIER (src/interpreter.c)
export const SCALE = [0, 2, 4, 5, 7, 9, 11];
export const SCALE_CARDINAL = 7;
