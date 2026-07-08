// Demo preset: a polymetric arpeggio.
//
//   - slot 0 is a euclidean rhythm x(5,8) (steps override 8), scanned by a
//     clock with mod 8 -> a 5-against-8 bang pattern into U
//   - slot 1 is a 6-step melody of scale indices with a <7 9> alternation,
//     scanned by a clock with mod c (12) -> the scan reaches the pattern's
//     second cycle, so the alternation unfolds; 12-tick melody against the
//     8-tick rhythm = a 24-tick polymetric loop
//   - V's value travels over a WIRE (dotted line) into N's input — V writes
//     its output cell, and the wire propagates it transitively eastward;
//     N (major scale) feeds Z's pitch; U's bang sits north of Z, triggering it
//
// Grid (reads are west of each operator, outputs go south):
//
//   c C . 1 8 C .        C(mod c): melody position | C(mod 8): rhythm position
//   1 . V . 0 . U        V reads slot 1 + position | U reads slot 0 + position
//   . . ~~~~~. N .       wire: V's output cell -> N's input cell
//   0 0 p 2 5 . Z        device ch vel hold octave [pitch] Z (bang from north)

export const DEMO = {
  bpm: 120,
  origin: { x: 2, y: 2 },
  rows: [
    'cC.18C.',
    '1.V.0.U',
    '.....N.',
    '00p25.Z',
  ],
  // origin-relative [fromX, fromY, toX, toY]
  wires: [[2, 2, 4, 2]],
  slots: {
    0: { code: 'x(5,8)', steps: 8 },
    1: { code: '0 2 4 <7 9> 4 2', steps: null },
  },
};
