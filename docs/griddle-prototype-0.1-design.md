# Griddle — Prototype 0.1 Design

*A 2D grid-based esoteric livecoding language combining a CLAVIER-36-style cellular
interpreter with Strudel's pattern engine. MIDI-only I/O. Browser-first.*

Status: **implemented** in `griddle/` (2026-06-11) — `npm run dev` to play,
`npm test` for the 22-test suite covering interpreter semantics, U/V sampling, and
the demo's 24-tick polymetric loop. This document records the design rationale and
the source-file references. Implementation notes discovered during the build:
- mini-notation euclids report `_steps: 1`, so slots carry an optional steps
  override (set 8 for `x(5,8)`); `t`/`f` parse as strings, handled in bang mode.
- Continuous signals aren't expressible in mini-notation; slots whose code is
  exactly `sine`/`saw`/`tri`/`square`/`rand`/`perlin`/`cosine`/`isaw` get the
  signal pattern directly.
- C-source convention not in the spec: operator reads are at origin−offset,
  writes at origin+offset (so HOP is west→east, JUMP is north→south).
- Strudel is consumed as source from the sibling monorepo clone via Vite aliases
  (`griddle/vite.config.js`) — the published npm dist bundles have a broken
  `@kabelsalat/web` import and `workspace:*` blocks `file:` installs.

---

## 1. Vision

Uzulangs (Tidal, Strudel) define a Pattern as a pure function from a time span to a
list of whole-or-partial events. This supports an elegant combinator algebra but is
deliberately stateless and feed-forward: state accumulation, true nondeterminism, and
feedback have no natural home (the NIME 2026 uzulangs paper concedes all three — see
§7.4). Grid esolangs (Orca, CLAVIER-36) are the dual: imperative cellular automata
with real mutable state, real PRNGs, and trivially expressible feedback, but only
primitive arithmetic sequencing.

Griddle puts pure patterns *inside* the stateful grid as **lookup structures with an
explicit position input** — the grid pulls values out of patterns; patterns never push
into the grid. This dissolves the pull-vs-push paradigm conflict identified in
CLAVIER's own integration memo (§7.3) and turns the pattern model's signature property
(random access via pure time queries) into a grid primitive.

## 2. Decisions locked for 0.1

| Decision | Choice |
|---|---|
| Host | Browser (Vite + plain JS) |
| Grid core | CLAVIER-36 interpreter semantics, ported to JS (not Orca's) |
| Pattern engine | `@strudel/core` + `@strudel/mini` (no transpiler in 0.1; mini-notation only) |
| MIDI | Strudel's MIDI device handling / WebMIDI (`@strudel/midi` adapted) |
| Pattern operators | `U` = bang patterns, `V` = value patterns |
| Time coupling | **Explicit position port** — no implicit metronome inside U/V, no rate port |
| Notation in cells | Never. Patterns live in a 36-slot bank (side panel), referenced by base-36 glyph |

Why CLAVIER over Orca for the grid core: type-safe 2-byte cell values, more natural
arithmetic operators, left-to-right postfix dataflow (operators read west, write
south), reading-order evaluation that lets upstream operators feed downstream ones
within a single tick, two-phase step (simultaneous movement + collision, then eval),
36 named registers, deterministic PCG PRNG. Spec: §7.3 `interpreter-design.md`.

## 3. Core semantics: U and V

`U` and `V` are **pure functions of (slot, position)** — stateless, same inputs →
same outputs. All time-driving machinery (clocks, randomness, feedback, arithmetic on
positions) stays in grid-land, where state belongs. The pattern's referential
transparency extends one cell into the grid.

Ports (CLAVIER postfix convention — inputs west, output south; position nearest the
operator since it is the hot input):

```
slot  position  U/V
                 |
              [output]
```

### 3.1 Position → query window

```
window for position p  =  [ p/S , (p+1)/S )     in pattern (cycle) time
S = pattern step count   (Strudel's `_steps` metadata)
S = 36 for continuous signals (no `_steps`)
```

- Spans are half-open and constructed in `Fraction` time, so consecutive windows tile
  exactly and every onset belongs to exactly one position. This is one of the two
  corners idlecycles cut (rational time; whole/part) that we must NOT cut.
- **Positions are NOT wrapped mod S.** Position 7 of a 4-step pattern reaches into
  the pattern's second cycle. This is load-bearing: per-cycle structure (`<a b>`
  alternation, `?` degradation, `.every()`) lives across cycles, and unwrapped
  positions let the grid reach it. **Periodicity belongs to the driver**: a clock
  with mod 4 freezes cycle 0 as a lookup table; mod 8 lets `<a b>` alternate; mod z
  scans ~9 cycles of a 4-step pattern. The clock's mod port is the "how much of the
  pattern do I loop" control — a semantic dial that is a wire, not a config option.
- Addressable universe = 36 steps (one base-36 digit). Multi-page addressing is
  explicitly deferred (§6).

### 3.2 V — value extraction

Query the window, then:

- **Discrete pattern**: take the *earliest* hap with `hasOnset()` (sort by
  `part.begin`). Coerce value to base-36:
  - number → `Math.round(v) mod 36` → glyph
  - single char in `0-9a-z` → that glyph literally (so `"0 3 7 <9 b>"` and
    `"a f a ~"` are literal base-36 sequences)
- **Continuous signal** (`whole === undefined`): take the sampled value (Strudel
  computes signals at span midpoint), scale `0..1 → 0..35`, floor. `sine` becomes a
  36-entry **wavetable**; a ramping clock makes it an LFO, `R` makes it S&H noise.
- **Rest / no onset** (`~`): **write NONE — do not sample-and-hold.** Holding the
  last value would reintroduce hidden state into a pure operator. If you want hold,
  that's what registers and grid plumbing (CLAVIER `S`/`L`, `H`) are for.
- A step containing a subdivision (`"0 [3 5] 7"` at p=1 holds two onsets) takes the
  earliest. Aliasing is well-defined and accepted: **the grid is a zero-order-hold
  sampler; the tick is a hard Nyquist limit on pattern detail.** This is the lo-fi
  aesthetic constraint of the language, same spirit as base-36.

### 3.3 U — bang extraction

Same window. Bang iff the window contains a hap with `hasOnset()` and value
`!== false`. Notes:

- In mini-notation, `~` produces *no hap*; an explicit `f`/`false` produces a hap
  with value false — treated as no bang. This distinction is what later enables
  mask-style usage with the same machinery.
- Multiple onsets in one window OR together into one bang.
- Continuous signals never have onsets → U over a signal correctly never fires.
- Bang patterns ARE Strudel boolean patterns: `"x ~ x [x x]"`, `"t f t t"`,
  `"x(3,8)"` (euclid is in the krill grammar), `"x ~ x? x"` (probabilistic).
- Output is a CLAVIER BANG value, which propagates per the existing power/bang
  evaluation model.

### 3.4 Idioms this design buys

- `C`(mod 4) → `V` over a 4-step pattern = an Orca track, exactly.
- Two readers, one slot, different clock rates = phasing / canon (Reich on a grid).
- One `V` scanned forward, another scanned via subtraction = crab canon — `rev` as
  *wiring* rather than combinator.
- `R` → position = nondeterministic access into deterministic structure: `?`
  randomness is time-hashed, so position 13 always answers the same way — *stable*
  irregularity sampled *unstably*. Neither parent language can make this texture.
- Position computed from the pattern's own previous output = feedback through a pure
  pattern — the thing the uzu model cannot express alone, achieved without breaking
  pattern purity (grid holds the state; pattern stays pure).
- `U` over `"x(5,8)"` driven by non-clock sources = a euclidean rhythm as an
  addressable mask, not just a sequence.

### 3.5 Determinism boundary

Strudel randomness is hashed from absolute time (§7.2 UI.hs refs), so given (grid
contents, frame counter, slot strings) the entire system state is reproducible. True
nondeterminism enters only through CLAVIER's grid-side PRNG (`R`, PCG in the register
file) or live MIDI input. Keep this boundary legible — it's a feature.

## 4. Architecture

```
┌────────────────────────────────────────────────┐
│  Pattern bank: 36 slots (0-z), mini-notation   │   compiled once per edit:
│  strings edited in a side panel                │   mini(str) → Pattern (cached)
└──────────────┬─────────────────────────────────┘
               │ queryArc(p/S, (p+1)/S)  — pure pull, per eval of U/V
┌──────────────▼─────────────────────────────────┐
│  Grid interpreter (CLAVIER step ported to JS)  │
│  phase 1: simultaneous movement + collision    │
│  phase 2: reading-order eval (incl. U/V)       │
│  state: cells, 36 registers, metronome, PRNG   │
└──────────────┬─────────────────────────────────┘
               │ MIDI ops queue events stamped for tick targetTime
┌──────────────▼─────────────────────────────────┐
│  Clock + MIDI out (Strudel stack)              │
│  lookahead clock evals tick t at T(t)−latency; │
│  WebMIDI send(data, timestamp) does last mile  │
└────────────────────────────────────────────────┘
```

- **One clock.** A Cyclist-style lookahead clock drives grid ticks; the grid is
  effectively Cyclist's `onTrigger`. Evaluate the grid for tick *t* slightly ahead of
  wall time, stamp WebMIDI sends with the precise target timestamp. Both CLAVIER's
  midi-timing post-mortem and its integration memo converge on exactly this (§7.3).
  Pattern evaluation needs no scheduler coupling at all — it's a pure call inside the
  interpreter step (~30 lines per operator over `queryArc`).
- **Pattern compilation**: `mini(slotString)` on slot edit, cache the Pattern and its
  `_steps`; per-tick cost is queries only.
- **MIDI out operators**: keep CLAVIER's `Z` (note) / `W` (CC) operator semantics
  (device, channel, velocity, hold, octave, pitch read from west), but route through
  Strudel's device handling instead of CoreMIDI.

## 5. Build plan for the first implementation session

1. Vite scaffold; `@strudel/core`, `@strudel/mini` deps.
2. Port CLAVIER interpreter step to JS, using `doc/interpreter-design.md` as the
   source of truth and `include/interpreter_step.c` as reference. (~500 lines.
   Skip placeholder ops D/E/F/G/K/O; skip synth `Y` / sampler `X` — MIDI only.)
3. Slot bank: 36 textareas (or one editor + slot selector), compile-on-edit with
   parse-error surfacing, cache `{pattern, steps}`.
4. `U`/`V` operators per §3.
5. Lookahead clock + WebMIDI adapter from Strudel's midi package; `Z`/`W` operators.
6. Minimal canvas grid editor (CLAVIER's UI is C/SDL — needs a small JS one; Orca's
   browser client at `Orca/sources` is a reference for a JS grid editor).

## 6. Deferred / open questions (explicitly out of 0.1)

> 2026-07-07: smooth MIDI CC modulation (stateful glide `G` / LFO `F` operators
> with analytic sub-tick CC rendering) is designed in
> `griddle-smooth-cc-design.md` — not yet implemented.
>
> 2026-07-08: MIDI controller input & bidirectional surfaces (regions as
> memory-mapped I/O; LaunchControl/Launchpad/shfts worked examples) is
> designed in `griddle-midi-controllers-design.md` — not yet implemented.
>
> 2026-07-08: MIDI clock (timestamped send; PLL-based receive with
> pulse-count-locked ticks; clock-source seam in clock.js worth adopting
> early) is designed in `griddle-midi-clock-design.md` — explicitly out of
> 0.1; receive instrumentation deferred to a future pass.
>
> 2026-07-08: Ableton bridge (single M4L hub device, 36 map slots, one
> WebSocket; F/G segments rendered by line~/live.remote~ — CV-grade, since
> Live's MIDI map is 7-bit-only) is designed in
> `griddle-ableton-bridge-design.md` — spike required before building.

- **Full Strudel expressions in slots** — adds `@strudel/transpiler` (+ acorn,
  escodegen). Mini-notation only for 0.1. Mondo notation (`@strudel/mondo`,
  `mondolang` packages exist) also deferred.
- **Position-port default = metronome** ("unwired → follow clock" convenience).
  Ship without it; see whether wiring a `C` ever actually feels like friction.
- **Multi-page addressing** (second port for cycle/page) to exceed the 36-step
  universe.
- **Step-locked convenience** (rate `.` = use `_steps`) — unnecessary now that
  position addressing subsumes it.
- **Grid state → pattern queries**: Strudel's `State` carries a `controls` object
  through every query; grid cell values could ride along in it, parameterizing
  patterns by live grid state without breaking purity. The most promising "next
  paradigm move" after 0.1.
- **Hap duration → note length**: currently ignored; could map `whole` duration to
  the MIDI op's hold input.
- **Control-object haps** (`{note, gain}`): 0.1 expects bare values in slots.
- ~~**CLAVIER's wiring system** (transitive writes)~~ — **PORTED** (2026-06-11),
  along with drag-select and clipboard (cells + interior wires). ⌘drag wires,
  toggle to remove, direction normalized to reading order, operator writes
  propagate transitively (movement/INTERFERE writes do not). The demo now routes
  V→N over a wire instead of an H hop.
- **Rejected for 0.1**: rate-port design (implicit metronome inside U/V, cycle =
  rate ticks). Superseded by explicit position — kept here for the record because it
  may return as a separate convenience operator.

## 7. Source references

All paths relative to `/Users/richardwhaling/dev/griddle-research/`.

### 7.1 Strudel (`strudel/packages/`)

| What | Where |
|---|---|
| Pattern class, `queryArc` | `core/pattern.mjs:45-100`, `:415-427` |
| Hap (`whole`/`part`/`value`, `hasOnset()`) | `core/hap.mjs:9-100` |
| TimeSpan (Fraction-based) | `core/timespan.mjs:9-100` |
| State (span + controls) | `core/state.mjs:7-26` |
| Cyclist scheduler (headless-capable: injectable getTime/setInterval, onTrigger) | `core/cyclist.mjs:10-140` |
| Clock primitive | `core/zyklus.mjs:4-54` |
| Controls / registerControl | `core/controls.mjs:10-95` |
| Mini-notation entry (`mini`, `m`), AST→Pattern | `mini/mini.mjs:193-262`, `:77-150` |
| Krill PEG grammar (euclid, `?`, `<>`, `[]`, polymeter all present) | `mini/krill.pegjs` |
| MIDI output (WebMIDI; note/CC/pitchbend; `scheduleAtTime`) | `midi/midi.mjs:284-400` |
| MIDI input / CC refs | `midi/input.mjs:16-150` |
| Transpiler (deferred) | `transpiler/transpiler.mjs` |
| Eval scope (deferred) | `core/evaluate.mjs:1-82` |

Reusable-headless set: `@strudel/core` (deps: fraction.js only), `@strudel/mini`,
`@strudel/tonal`. `@strudel/midi` is WebMIDI-coupled — fine, we're browser-first.

### 7.2 Tidal + NIME 2026 paper (`tidal/`, `nime2026/`)

| What | Where |
|---|---|
| Paper: "Uzulangs: a Community of Musical Pattern Languages" (McLean, Roos, et al.) | `nime2026/uzu.tex` (also `.md`, `.pdf`) |
| Pattern type: `query :: State -> [Event a]` | `tidal/tidal-core/src/Sound/Tidal/Pattern.hs:62` |
| Event (whole/part) | `Pattern.hs:993-1003` |
| Join strategies (in/out/mix/squeeze) | `Pattern.hs:219-299`; paper §joins |
| State limitation + VState workaround | paper `uzu.tex:500-521`; `Pattern.hs:1104`, `:1077-1089` |
| Time-hashed determinism (`timeToRand`, `xorwise`) | `tidal/.../UI.hs:85-101`, `:142-143` |
| Stepwise/tala (`_steps`, `pace`) — basis for §3.1 | paper §6 (`uzu.tex:615-647`); `Pattern.hs:70-87` |
| Feedback/external input discussion | `uzu.tex:836-840` |

### 7.3 CLAVIER-36 (`CLAVIER-36/`)

| What | Where |
|---|---|
| **Interpreter spec (source of truth for the port)** | `doc/interpreter-design.md` (428 lines) |
| **Strudel integration memo** (anticipates this project; its "don't embed" conclusion is what §3 deliberately revises via explicit position) | `doc/strudel-clavier-integration.md` |
| Companion Strudel notes | `doc/strudel-core-patterns.md`, `doc/strudel-timing-and-midi.md`, `doc/strudel-editor-and-runtime.md` |
| MIDI timing post-mortem (motivates lookahead clock) | `doc/midi-timing-issues.md` |
| Value type (2 bytes: type/velocity/power + letter), RegisterFile, wiring | `include/interpreter.h:49-155` |
| Two-phase step + all operator implementations | `include/interpreter_step.c:23-492` |
| Scale table, quotation rules | `src/interpreter.c:9-52` |
| Audio-thread timing, voice pool, ring_trigger | `src/ring.c:156-214`, `:495-650`, `:695-748` |
| Operator semantics summary: arithmetic `+ - * / %` (mod 36, defaults 1/36), compare `= > <`, logic `& \|`, clock `C` (rate,mod), pendulum `P`, envelope `V`→**rename needed: collides with griddle V**, load/store `L S`, multiplex `M`, alter `A`, min/max `B T`, note `N` (major scale `[0,2,4,5,7,9,11]`), random `R`, quote/unquote `Q U`→**U collides too**, interfere `I`, MIDI `Z`/CC `W` | `interpreter_step.c` |

**Glyph collisions — RESOLVED (2026-06-11)**: griddle's `U` (bang pattern) and `V`
(value pattern) win. CLAVIER's unquote is dropped entirely; CLAVIER's envelope
relocates from `V` to `E` (a free placeholder glyph).

### 7.4 Orca (`Orca/`)

Kept as reference only (grid core not used, but its browser JS is a UI reference and
its operator vocabulary is the shared culture):

| What | Where |
|---|---|
| Grid + frame cycle, locks, base-36 | `desktop/sources/scripts/core/orca.js` |
| Operator base class, ports | `desktop/sources/scripts/core/operator.js` |
| Full operator library incl. `T` track (the model for position-driven lookup) | `desktop/sources/scripts/core/library.js` |
| Worker-timer clock, 4 frames/beat | `desktop/sources/scripts/clock.js` |
| MIDI io + transpose table | `desktop/sources/scripts/core/io/midi.js`, `core/transpose.js` |

### 7.5 idlecycles blog series (Felix Roos)

`https://garten.salat.dev/053-...` through `058-idlecycles-VI-sound-+-joins/`; code at
`github.com/felixroos/idlecycles`. Key takeaway: a minimal pattern engine is ~150-300
lines (query fn, cycle splitting, cat/fast/stack, a join, mini-notation, onset-filtered
scheduling) — but the two corners it cuts, **rational time** and the **whole/part
distinction**, are exactly the ones griddle's tick-window tiling and `hasOnset()` test
depend on. Hence `@strudel/core` rather than a from-scratch engine.
