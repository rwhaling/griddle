# griddle

**A grid esolang for livecoding MIDI, built from two paradigms that are
supposed to be incompatible.**

Uzulangs (TidalCycles, Strudel) treat music as *pure functions of time* —
elegant, composable, and constitutionally incapable of state, feedback, or
true randomness. Grid esolangs (Orca, CLAVIER-36) are the dual: imperative
cellular automata with real mutable state and trivial feedback, but only
primitive sequencing. Griddle refuses the choice. It is a CLAVIER-style
cellular grid — base-36 values, operators that read west and write south,
a tick-based clock — in which strudel patterns are embedded as **pure
lookup structures the grid interrogates**. The pattern never pushes; the
grid pulls. The stateless thing and the stateful thing keep their natures,
and the seam between them is where the instrument lives.

In a phrase: **CLAVIER's body, Orca's reflexes, strudel's memory.**

## What that looks like

Content lives in a live-codeable **mount document** (⌘E) — real JavaScript
through strudel's transpiler:

```js
$a: note("c3 [e3 g3] a2 <g3 b3>").cycle('2b').vel(85)   // a melody
$k: "8 ~ 5 7 4 ~ 5 8 a ~ 5 7 4 ~ 5 ~"                    // a drum track
@f: lfo(perlin).cycle('8bar').range(30, 100)             // a filter drift
```

The grid holds **state, time, and routing** — and one-glyph *references*
into that document:

```
· 1 a · V          V plays the melody: notes at true fractional times,
                   durations from the pattern, sounding pitch readable
                   on the grid by everything downstream

1 g C · · · ·      a clock scans the drum track by position —
· · k · U · ·      U strikes, V (same slot) reads the accent values,
· · k · V · Z      both feed a Z; rhythm and dynamics from ONE mount

0 f 7 · · f · F    F renders the perlin LFO as a smooth CC stream —
                   messages timestamped at each 7-bit boundary crossing,
                   sub-tick accurate, silky at any speed
```

Every value is visible. Every parameter is a cell you can see, wire,
overwrite, or modulate. Patterns can be scanned positionally (the grid is
the time-giver: drive position with clocks, random walks, arithmetic,
*feedback*) or run themselves (`.cycle()`) while the grid supervises —
bang-resets their phase, modulates them through declared mod ports, mutes
them with `#`. Both time models, with and without direct MIDI output, per
mount: four quadrants, one instrument.

## Principles the design keeps faith with

- **The grid holds references; text holds content.** Rich, precise,
  composable things (patterns, LFO definitions, device maps, tempo) are
  code in the mount document. The grid's base-36 surface stays lo-fi and
  legible — a glyph is a pointer, a knob, or a wire.
- **Two-phase purity.** Arbitrary JS runs once at mount time (⌘↵);
  only compiled artifacts run at query time. A session is a pure function
  of (grid, mount source, tick count) — reproducible, replayable. Live
  input and grid-side randomness are the *sanctioned* nondeterminism.
- **The wire tells the truth the grid can't.** The grid is tick-quantized
  (its Nyquist floor is the aesthetic); the MIDI faces render the real
  continuous line — LFO boundary crossings and note onsets at exact
  timestamps via lookahead scheduling.
- **Defaults are code, not engine magic.** Empty patches seed a visible,
  editable mount document: 36 LFOs (digits beat-synced, letters a slow
  geometric spread) and 36 euclidean rhythm tables. Delete what you
  don't mean.
- **Everything is overwritable, everything is inspectable.** In the Orca
  tradition — plus a live context line that names whatever's under your
  cursor, its ports, their current values, and its resolved mount.

## Running it

```sh
npm install
npm run dev      # open in Chrome/Edge (WebMIDI); press ▶ or ⌘↵
npm test         # 110 headless tests: interpreter, patterns, LFOs, mounts
```

No MIDI gear handy: check **preview** in the bottom strip. The demo patch
(auto-loads first run) plays a 24-tick polymetric arpeggio — a euclidean
cinquillo against a 12-tick melody scan.

**Build caveat**: griddle consumes strudel as *source* from a sibling
checkout (`../strudel`, via `vite.config.js` aliases) because the published
npm bundles are currently broken. Cloning this repo alone will not build.

## Reference

### The grid

Each tick: a movement phase (values with velocity move simultaneously;
collisions destroy), then evaluation in reading order — operators see
same-tick outputs of anything above or left of them. Operators read
**west**, write **south**. Digits and lowercase letters are base-36
literals; uppercase and symbols are operators; `!` is a bang. Operators
are powered by default; `` ` `` toggles power (unpowered = runs only
beside a bang). `#` mutes a selection (comment-out). **Wires** (⌘drag)
carry operator writes point-to-point, transitively.

| glyph | operator | inputs (west, hot first) |
|---|---|---|
| `U` `V` | pattern strike / sound | drive, slot, ch, dev |
| `F` | mounted LFO → smooth CC | mod, slot, max, min, ctrl, ch, dev |
| `G` | glide → smooth CC | rate, target, ctrl, ch, dev |
| `Z` `W` | MIDI note / CC (bang-fired) | pitch,oct,hold,vel,ch,dev / val,ctrl,ch,dev |
| `C` `P` `R` | clock, pendulum, random | mod, rate |
| `N` `E` | major scale, envelope | idx / rise, fall, mult |
| `L` `S` `M` `Q` | load, store, multiplex, quote | — |
| `+ − * / %` `= > < & \|` | arithmetic, compare, logic | b, a |
| `H` `J` `I` | hop W→E, jump N→S, launch moving value | — |

### The mount document

`$x:` mounts a pattern, `@x:` an LFO; `@2a` scopes to device 2 (lookup
falls back `@2a` → `@a`; 36 slots × 36 devices per sigil). **Double quotes
are mini-notation, single quotes are plain strings.** Bare pattern mounts
are positional (drive port = position, window `[p/S, (p+1)/S)`, steps via
`.gsteps(n)`); `.cycle('2b')` mounts self-advance (drive port = declared
`.mod(...)`; bang resets phase; `.sync()` locks to the transport). A
literal in the channel/controller cell opens the MIDI face; without it,
operators are pure grid citizens. `bpm()`, `grid()`, `devices()` (with
`null` as a black hole), `mount()`, `spread()`, and plain JS loops all
work — bulk definition is just code.

### Keys

Arrows move (⌥ = ×8) · ⇧arrows select · type fills selection · `[ ]` zoom
· ⌘A all · ⌘C/X/V clipboard (cells + interior wires) · ⌘drag wire ·
⌘↵ play/stop on grid, evaluate in editor · ⌘E editor pane · ⌘. panic ·
esc editor→grid.

## Status & documents

A personal research instrument — already performed live — not yet a
packaged release. The design history lives in [`docs/`](docs/): seven
design documents covering the core language, the smooth-CC operators,
MIDI controllers as memory-mapped regions, MIDI clock, an Ableton bridge,
and the mount system, each with its open questions annotated. They are the
real documentation; this file is the door.
