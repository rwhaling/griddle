# griddle 0.1

A 2D grid-based esoteric livecoding language: a CLAVIER-36-style cellular
interpreter with strudel patterns embedded as pure lookup structures, MIDI-only
output, browser-only. Design rationale: `docs/griddle-prototype-0.1-design.md`
(plus designed-but-unimplemented features in the other `docs/` files).

Note: this build consumes strudel as *source* from a sibling checkout
(`../strudel`, via aliases in `vite.config.js`) because the published npm dist
bundles are currently broken. Cloning this repo alone will not build — a
sibling `strudel` monorepo clone is required. To be resolved before publishing.

## Run

```sh
npm install
npm run dev      # then open the printed URL in Chrome/Edge (WebMIDI)
npm test         # headless interpreter + pattern semantics tests
```

The demo preset (auto-loaded on first run, or via **load demo**) plays a
polymetric arpeggio: a euclidean E(5,8) rhythm against a 12-tick melody scan
with a `<7 9>` alternation — a 24-tick loop. Press **▶ play**. If you have no
MIDI device handy, check **preview synth**.

## The language

The grid is a CLAVIER-36 interpreter: each tick has a movement phase
(values with velocity move simultaneously, collisions destroy) then an
evaluation phase in reading order, so operators see same-tick outputs of
operators above/left of them. Operators read inputs **west**, write output
**south**. Uppercase letters and symbols are operators; digits and lowercase
letters are base-36 literals (0-z = 0-35); `!` is a bang. Operators are
*powered* (run every tick) by default; `` ` `` toggles power — unpowered
operators run only when adjacent to a bang.

### Editing

Drag (or shift+arrows) makes a rectangular selection; typing fills it,
backspace/delete/`.` clears it, `` ` `` toggles power across it, **⌘A**
selects all. **⌘C/⌘X/⌘V** copy/cut/paste a selection — including any wires
whose endpoints are both inside it; cut severs wires that cross the
boundary. Copy also puts a plain-text rendering of the region on the system
clipboard.

**`#` mutes/unmutes the selection** (comment-out): muted operators don't
evaluate — clocks stop, F/G stop sending, Z/W never fire — and render
dimmed. Mute is a cell flag, so it persists and travels with copy/paste.
Note: a muted F/G loses its runtime state; unmuting re-initializes (G
arrives at its target, F restarts at phase 0). Handy for Ableton's CC-map
mode: ⌘A, `#`, then unmute just the operator you're mapping.

The grid defaults to 64×32 (resizable up to 128×64 in the sidebar, content
preserved) and the window is a **viewport**: the camera follows the cursor,
so arrows and typing auto-pan — no mouse needed. **⌥arrows** leap 8 cells;
**`[` / `]`** zoom out/in (14–34px cells). The status line shows cursor
coordinates.

**Patches**: every edit auto-saves to localStorage and survives reload (but
"load demo"/"clear grid" overwrite that single slot). **save patch /
load patch** export and import the full state — grid, wires, slots, size,
bpm — as a JSON file.

### Wires

**⌘drag** from one cell to another draws a wire (dotted line); ⌘drag the same
pair again to remove it. When an *operator* writes to a wired cell, the value
propagates through the wire — transitively through chains — within the same
tick. Movement-phase writes and INTERFERE placements do not propagate
(CLAVIER's `memory_set_transitive` convention). Wire direction is normalized
to reading order (the earlier cell is the source), which is also what makes
transitive propagation always terminate. Wires separate data routing from
spatial layout: long-distance connections without ladders of H/J passthroughs.

### Pattern operators (the new thing)

Patterns live in a 36-slot bank (sidebar), written in strudel mini-notation.
`U` and `V` are pure functions of (slot, position):

```
slot pos U        slot pos V
      [bang]            [value]
```

- window for position p = `[p/S, (p+1)/S)` in pattern time; S = the pattern's
  step count (auto from `_steps`, or the slot's steps override — euclids like
  `x(5,8)` need override 8)
- positions are **not** wrapped mod S: position 7 of a 4-step pattern reaches
  the pattern's second cycle, so `<a b>` alternation and `?` randomness unfold.
  The driver's clock mod decides how much of the pattern loops.
- `V`: earliest onset's value, coerced to base-36 (numbers mod 36; single
  chars `0-z` literally). Rests write NONE — no hidden sample-hold.
- `U`: bangs iff the window holds an onset with truthy value (`~` rest, `f`,
  `0`, `false` don't bang). `x(5,8)`, `x ~ x [x x]`, `x? x` all work.
- a slot containing exactly `sine`, `saw`, `tri`, `square`, `rand`, `perlin`,
  `cosine`, or `isaw` is a continuous signal: V samples it as a 36-entry
  wavetable (position = phase in 36ths), U never bangs.

Drive position with `C` (clock) for sequencing, `R` (random) for
nondeterministic access, arithmetic for transforms, or feedback from the
grid's own state — `rev` is wiring, phasing is two readers at different rates.

### Operator reference

| glyph | name | inputs (west…) | output |
|---|---|---|---|
| `+ - * / %` | arithmetic | b, a | south, mod 36 |
| `= > <` | compare | b, a | bang / none |
| `& \|` | and / or | b, a | literal or bang |
| `A` | alter (lerp) | max, min, t | south |
| `B` / `T` | min / max | b, a | south |
| `C` | clock | mod, rate | `(m/rate)%mod` when `m%rate==0` |
| `E` | envelope | rise, fall, mult | looping ramp 0-35 |
| `H` | hop | west(1) | east(1) |
| `I` | interfere | y, x, vel, value | places moving value |
| `J` | jump | north(1) | south(1) |
| `L` / `S` | load / store | reg / reg, value | register file |
| `M` | multiplex | y, x | indirect read |
| `N` | note | index | major-scale pitch |
| `P` | pendulum | mod, rate | bang every rate×mod |
| `Q` | quote | index | literal → operator |
| `R` | random | mod, rate | random literal |
| `F` | lfo | phase, rate, max, min, ctrl, ch, dev | smooth CC + coarse/fine pair |
| `G` | glide | rate, tgt, ctrl, ch, dev | smooth CC + coarse/fine pair |
| `U` | pattern bang | pos, slot | bang from pattern |
| `V` | pattern value | pos, slot | value from pattern |
| `W` | midi cc | val, ctrl, ch, dev | sends CC (bang-discrete) |
| `Z` | midi note | pitch, oct, hold, vel, ch, dev | sends note |

`Z`/`W` fire post-tick when powered **and** adjacent to a bang (CLAVIER's
ring_trigger convention). MIDI note = 12×octave + pitch; hold is in ticks
(33-35 = that many −32 bars of 32 ticks).

### Smooth CC: F (LFO) and G (glide)

Stateful modulation operators (design: `docs/griddle-smooth-cc-design.md`).
Both hold a high-resolution internal value, write a **coarse+fine pair**
south / south-east each tick, and — when their controller cell holds a
literal (opt-in by addressing) — render their continuous trajectory as
**timestamped CC messages at each 7-bit boundary crossing**, sub-tick
accurate, so slow sweeps are the cleanest staircase 7-bit MIDI can express.

- `G` slews toward its target; full scale takes rate² ticks (rate 0 =
  instant); a bang **snaps** to target (one CC edge). A fresh G starts at
  its target — no surprise sweep.
- `F` is a triangle phase accumulator: **rate changes never jump the
  phase**; a bang **resets** it; the phase-offset port makes two Fs a
  quadrature pair; min/max scale the output (min > max inverts). Period =
  4·rate² ticks (rate 1 = one beat).

Unpowered F/G freeze. 14-bit CC / pitch bend and the Ableton bridge are
designed (see `docs/`) but not yet implemented — 7-bit only for now.

### Timing

One lookahead clock (25ms poll, 150ms horizon) on `performance.now()`; each
tick is evaluated ahead of time and MIDI sends carry precise timestamps, so
the OS driver does the last mile. 4 ticks per beat.

## Differences from CLAVIER-36

- `U` (unquote) dropped; `V` (envelope) relocated to `E`; `U`/`V` are the
  pattern operators; `X` (sampler) / `Y` (synth) not ported (MIDI-only).
- No wiring system yet (deferred).
- Deterministic PCG PRNG seeded fresh on play: a session is reproducible from
  (grid, slots, tick count) — strudel `?` randomness is time-hashed, so it's
  deterministic per position too.
