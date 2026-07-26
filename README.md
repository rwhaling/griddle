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

### Pattern operators: U and V

`U` and `V` are the **two projections of one mounted pattern** — U the
strike-view (onsets → bangs), V the sound-view (values). Patterns mount in
the **mount document** (⌘E) under the `$` sigil, as mini-notation or full
strudel expressions; ports are `dev(4) ch(3) slot(2) drive(1)`.

**The mount decides the time model:**

- **Bare mount = positional** (`$a: "0 3 7 <9 b>"`): drive port = position;
  window `[p/S, (p+1)/S)`, S from `_steps` or `.gsteps(n)` (euclids need
  it: `pat('x(5,8)').gsteps(8)`). Positions are unwrapped — the driver's
  clock mod decides how much of the pattern loops; `rev` is wiring,
  phasing is two readers. V = earliest onset's value (rests write NONE);
  U bangs on truthy onsets.
- **`.cycle('2b')` mount = rate-driven**: the pattern advances itself
  (phase is unbounded — long-form structure keeps unfolding); drive port
  becomes the **mod** input (`.mod('rate'|'phase'|'transpose'|'degrade'|
  'velocity')`); a bang resets phase; `.sync()` locks phase to the
  transport. V's grid face shows the *sounding* value (durations hold);
  U's shows whether anything *struck* this tick.

**The MIDI face** (either time model): put a literal in the channel cell
and haps play as notes at their true fractional times — V with pitch from
values (`.base(48)`/`.oct(n)`, or hap control objects from `note(...)`),
velocity from `.vel(v)` or the hap, **duration from the hap's whole span**;
U as fixed-note triggers (`.note(36)` — drum lanes). `devices({n: null})`
black-holes a device patch-wide. Without a channel cell, U/V are pure grid
citizens — exactly the 0.1 semantics.

**Default tables** (visible code in the mount doc): `@0`–`@9` beat-synced
LFOs (period = n beats), `@a`–`@z` slow spread (2–128 bars), all with
fine-rate mod; `$1`–`$8` = `x(n,8)` euclids ($5 = the cinquillo), `$9` =
x(9,16), `$a`–`$p` = x(1..16,16), `$q`–`$z` = x(1..10,12).

**Quoting** (strudel convention): double quotes = mini-notation, single
quotes = plain strings (`.cycle('2b')`). Simple double-quoted specs are
forgiven; string methods and concatenation are not.

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
| `F` | mounted lfo | mod, slot, max, min, ctrl, ch, dev | smooth CC + coarse/fine pair |
| `G` | glide | rate, tgt, ctrl, ch, dev | smooth CC + coarse/fine pair |
| `U` | pattern strike | drive, slot, ch, dev | bang + note triggers |
| `V` | pattern sound | drive, slot, ch, dev | value + pitched notes |
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
- `F` is **mount-driven**: its slot port references an `@` definition in
  the mount document (⌘E) — `@a: lfo(tri).cycle("4b").range(40, 90)` —
  with device-qualified lookup (`@<dev><slot>` ?? `@<slot>`). Shapes are
  strudel signals, patterns, or mini-strings compiled to breakpoint
  tables; `noise` is hash-deterministic. Phase lives in the operator, so
  re-evaluating the mount never jumps it; a bang resets it; `.sync()`
  anchors it to the transport instead. min/max port literals coarsely
  override the mount's range; the mod port's meaning is declared by the
  definition (`.mod('rate'|'phase'|'depth'|'offset'|'skew'|'smooth')`).
  `devices({n: null})` black-holes a device (grid face lives, wire
  silent). An F whose slot has no mount is inert.

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
