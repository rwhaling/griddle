# Griddle — Mount Document & LFO Banks Design

*A live-codeable JavaScript document ("mount document") defining LFOs with
full precision — arbitrary rates, ranges, and curves — mounted into
device-qualified slots that the F operator references. Sixth design doc;
revises F as specified in `griddle-smooth-cc-design.md` (whose §5 crossing
contract is retained unchanged).*

Status: **designed (2026-07-12), pending implementation.** Scoped to **LFOs
only** by user decision: the same mechanism is expected to eventually serve
the pattern bank and U/V, but §9 records that as open — including a genuine
unresolved design tension — rather than designing it here. The current
pattern-slot UI is untouched by this doc.

> **Revisions from doc seven (`griddle-pattern-mounts-design.md`, same
> day):** (1) §9's tension is now RESOLVED — the 2×2 in doc seven §1;
> patterns join the mount document after all, with U/V unification.
> (2) **`.rate()` is renamed `.cycle()`** throughout (doc seven §6.1):
> `.rate("4b")` was a duration masquerading as a rate; read every
> `.rate(` in this doc's examples as `.cycle(`. The `'rate'` *mod name*
> keeps its name (it's a multiplier, where rate intuition is correct).
> (3) **F regains min/max override ports** (doc seven §4, user review):
> this doc's `device(5) ch(4) ctrl(3) slot(2) mod(1)` layout is
> superseded by `dev(7) ch(6) ctrl(5) min(4) max(3) slot(2) mod(1)` —
> mount `.range()` is the precise base, port literals coarsely override
> per-bound, `'depth'`/`'offset'` join the mod-name set.

Origin: feedback from the first live performance with griddle (2026-07-12).
The F operator worked, but its base-36 ports quantize rate to 36 quadratic
steps and range endpoints to 36 positions — per-composition compromises
squeezed through a one-glyph keyhole.

---

## 1. Architecture principle: the grid holds references

Griddle has had a two-tier architecture since 0.1 without naming it: **rich
content lives in text; the grid holds base-36 references to it, plus state
and routing.** U/V got this right (slot glyphs pointing into the pattern
bank). F violated it by cramming five continuous parameters into ports.
This design brings F into compliance: an F cell holds *state* (phase) and
*routing* (addressing, slot pointer, modifier); everything else is a
mounted definition.

### 1.1 Two-phase evaluation and the purity contract

The historical objection to "full JS in the bank" was query-time
determinism. The mount document splits evaluation so the objection
dissolves:

- **Mount time** (explicit eval gesture): arbitrary JS runs *once*,
  producing artifacts (LFO configs compiled to breakpoint tables).
  Impurity here is harmless — `Math.random()` at mount time means each
  eval rolls dice, a legitimate livecoding gesture. Patches save the
  *source*; a deterministic document reproduces its artifacts exactly.
- **Query time** (every tick): only artifacts run. The runtime invariant
  becomes *(grid, mounted artifacts, tick count) → identical output*.

Contract (documented, not enforced): definitions must not close over
impure values evaluated at query time. Personal-instrument honesty over
sandbox theater.

This reverses the thrice-defended "never full JS" position. What changed:
(a) the two-phase split preserves the invariant that actually mattered;
(b) strudel-syntax compatibility converts the user's existing muscle
memory and strudel's documentation into griddle assets; (c) the strudel
transpiler is already in the dependency tree via the monorepo aliases.
Mondo (previously the designated pressure valve) loses on every axis and
is retired for this purpose.

## 2. The mount document

A single editor pane containing JavaScript, processed by strudel's
transpiler (acorn; labeled statements; auto-`mini()` on double-quoted
strings; source locations for error markers) and evaluated against a
curated griddle scope.

```js
// device table: logical devices 0-35 -> physical MIDI outputs
devices({ 0: "IAC Bus 1", 1: "IAC Bus 2", 2: "Digitone" })

// LFO mounts — @ sigil; one glyph = slot on every device
@a: lfo(sine).rate("4b").range(40, 90)
@b: lfo(saw).rate(1.5).range(0, 127).phase(0.25)

// two glyphs = device-qualified: slot a on device 2 only (shadows @a there)
@2a: lfo(noise).rate("16t").range(64, 88).smooth(0.5)

// shapes are strudel signals, patterns, or mini-notation strings
@c: lfo(perlin).rate("2bar").range(0, 127)
@d: lfo("0 8 3 z <5 9>").rate("2b").range(20, 100)

// named reuse and bulk definition are plain JS
const swell = lfo(sine).range(40, 90)
@e: swell.rate("8b")
spread("1b", "32bar", 8).forEach((r, i) =>
  mount('@' + "qrstuvwx"[i], lfo(sine).rate(r).range(0, 127)))
```

### 2.1 Sigils and labels

- `@` marks an LFO mount. `$` is **reserved for patterns** (§9) and any
  future resource type gets its own sigil — one rule in the pre-pass.
- `@` is not a legal JS identifier character; a **line-anchored token
  pre-pass** rewrites `^\s*@([0-9a-z]{1,2})\s*:` to a legal label before
  acorn, and strudel's `labelToP` transform
  (`strudel/packages/transpiler/transpiler.mjs:184`, `x: y` → `y.p('x')`)
  carries it to a mount call. Line-anchoring avoids mangling `@` inside
  string literals except in pathological multi-line strings (accepted).
- Labels: `@a` (slot, all devices), `@2a` (device 2, slot a). Digit-only
  slots work in both forms (`@5`, `@25` = device 2 slot 5 — two-glyph is
  always device-then-slot; a bare two-character label is never ambiguous
  because one-glyph and two-glyph forms are distinguished by length).
- `mount(ref, def)` is the programmatic equivalent (bulk definition).

### 2.2 Device-qualified lookup

An F with device port `d` and slot port `s` resolves **`@ds` ?? `@s`** —
specific first, global fallback. Consequences:

- Shared defaults with per-device overrides for free.
- Headroom: 36 slots × 36 devices = **1,296 LFO mounts**, up from 36
  port-encoded configurations.
- Robustness: a stray literal on a device port selects a bank with no
  device-scoped mounts and falls through to the global mount — garbage-in
  degrades to today's behavior, never to silence.

Channel was deliberately **not** used as a bank dimension: channel is
semantically load-bearing to receivers (Live mappings, multitimbral
hardware); logical device is pure indirection griddle owns.

### 2.3 The device table

`devices({...})` maps logical devices to physical outputs (matched
against WebMIDI port names; matching mode is open question §10.4).
Unmapped logical devices fall back to the in-app selector, which demotes
from "the output" to "the default mapping" — today's behavior is the
empty-table case. Many logical devices may alias one physical output
(separate namespaces in griddle, one cable out — pairs naturally with
OS-level aggregate devices). **The table also makes Z/W's hitherto-ignored
device ports live**, since routing lives in one place now.

### 2.4 Eval model

Explicit eval (⌘↵ in the mount pane), never auto-compile: mid-performance,
half-typed definitions must not go live. Per-statement error markers via
transpiler source locations; on error, **last-good artifacts stay
mounted**. Mount-document source is part of patch state (localStorage +
patch files).

### 2.5 Scope surface

Curated, passed explicitly (no `evalScope` global pollution): strudel
signals (`sine`, `tri`, `saw`, `isaw`, `square`, `perlin`, `rand`), mini
(auto-wrapped strings), core combinators for shape-patterns, and griddle's
`lfo()`, `mount()`, `spread()`, `devices()`. No webaudio, no sound
controls.

## 3. The `lfo()` definition API

```js
lfo(shape)              // signal | pattern | mini-string | 'noise'
  .rate(v)              // number = beats; "16t" ticks, "3.5b" beats, "2bar" bars
  .range(lo, hi)        // CC units 0-127, floats (draft — open §10.1)
  .phase(p)             // 0..1, applied at read time (quadrature etc.)
  .smooth(s)            // noise only: 0 = S&H, 1 = fully interpolated
  .sync()               // optional: transport-anchored phase (open §10.2)
  .mod(param, ...args)  // declares the F mod port's meaning (§5)
```

- **Shapes compile to per-cycle piecewise-linear breakpoint tables at
  mount time** — signals sampled at N points (~64; sine error far below CC
  resolution), patterns/strings sampled per the V-wavetable interpretation
  (steps become steps; `<a b>` alternation folds into a 2-cycle table).
  This is smooth-cc §8.1 ("the shape enum wants to become a slot
  reference") realized. The §5 crossing contract is untouched: the runtime
  is shape-agnostic, walking breakpoints instead of one triangle fold.
- **`noise`** is procedural, not sampled: step values from hashing
  (slot, cycle, step) — Tidal-style deterministic randomness, no PRNG
  state, reproducibility intact. `smooth` interpolates between steps
  (still piecewise linear).
- Rates are floats with musical units — the coarseness fix at the root.
  Seconds are deliberately absent (tick duration already tracks BPM).

## 4. The revised F operator

Ports (west): **`device(5), channel(4), controller(3), slot(2), mod(1)`** —
addressing trio, then the hot pair. One glyph narrower than the current F
despite doing more.

- **Send rule unchanged**: controller cell literal = send (opt-in by
  addressing); otherwise pure grid modulator. Grid face (coarse/fine pair
  south / south-east) unchanged.
- **State lives in the operator; config lives in the mount.** Phase
  survives re-evaluation of the document: editing rate/shape/range while
  playing never jumps phase — the no-phase-jump property generalizes from
  the old rate port to the entire definition.
- **Slot-switching is the grid-side performance gesture**: changing one
  glyph (by hand, pattern, or arithmetic) swaps the whole LFO character.
- Bang resets phase; unpowered freezes; empty slot / no mount / type
  mismatch = inert (visible in a future status surface, not silent
  failure — at minimum the grid face stops updating).
- **Removed**: min/max/rate/offset ports (now definition-side). This is a
  **breaking change** to patches using the current F (§8).

## 5. The `mod` port: definition-declared meaning

One general-purpose runtime input (0–35), wireable from anything — clocks,
`R`, `V`, another LFO's coarse byte. The *definition* declares what it
means:

```js
@a: lfo(tri).rate("4b").range(30, 100).mod('skew')       // tri <-> saw morph
@b: lfo(noise).rate("1b").range(64, 96).mod('spread')    // distribution width
@c: lfo(sine).rate("8b").mod('phase')                    // scrub/nudge
@d: lfo(saw).rate("2b").mod('rate', 0.5, 2)              // rate bend x0.5..x2
```

Implementation: `phase` and `rate` mods never touch the table; shape-
changing mods (`skew`, `spread`, `smooth`) regenerate it, **memoized per
modifier value** — at most 36 cached tables of ~64 points per operator.
Definitions without `.mod()` ignore the port. Initial parameter set:
`phase`, `rate`, `skew`, `spread`/`smooth` — extensible without grammar
changes since the declaration is JS.

## 6. Runtime changes

- `MountTable` (host-side) holds compiled LFO artifacts keyed by
  device-qualified ref; the machine's pattern interface is untouched.
- `lfoPieces` generalizes from "triangle with ≤1 fold" to "walk the
  mounted breakpoint table across the phase sweep" — pieces stay
  piecewise linear; `crossings()` unchanged.
- Rate → phase increment computed from ticks-per-cycle at mount time
  (float inc acceptable; determinism holds since it's fixed per mount).
- F's per-cell `opState` keeps `{phase, lastCC, modCache}`.

## 7. UI

- New **mount pane** (sidebar tab or split): code editor, ⌘↵ evaluates,
  error markers per statement, status line showing mounted refs count.
- Pattern slots UI **unchanged** (this doc's scope boundary).
- MIDI section: device table read-only view (logical → resolved physical),
  selector = default mapping.

## 8. Migration & breaking changes

- **F port layout changes** (5 ports → new meanings). Existing patches
  using F need manual rework — acceptable now (few patches, one user);
  patch-format version bump so old patches can at least warn.
- Patch state gains `mountSource` (the document text). Old patches load
  with an empty mount document; their pattern slots work as before.
- The single-output assumption in `main.js` (device field ignored) is
  replaced by device-table resolution with selector fallback.

## 9. TBD: patterns, U/V, and the paradigm tension (deliberately unresolved)

Recorded for the follow-up discussion, per user decision:

1. **`$` sigil and pattern mounts** — reserved. Full strudel expressions
   as patterns (`$1: cat("0 2 4", "7 9").fast(2)`) fall out of the same
   transpiler machinery whenever patterns migrate to the mount document.
2. **U/V bank ports** — the device-qualified lookup rule would extend
   headroom to patterns via an optional `dev(3)` port on U/V (safe by the
   fallback rule), but this is **on hold** pending (3).
3. **The unresolved tension.** The user is contemplating a U/V flavor
   that is *rate-driven* rather than position-driven — taking a rate (and
   maybe phase/bang reset), advancing through pattern time on its own,
   emitting events at their true fractional times rather than quantized
   to integer position reads. That drifts toward patterns emitting MIDI
   directly (as F now does), which the user flags as feeling
   **disintermediated** relative to the strudel workflow — but note the
   direction of the concern: griddle's 0.1 thesis is patterns as *lookup
   structures inside grid dataflow* (grid is the time-giver); a
   rate-driven operator reintroduces strudel-style self-scheduling inside
   the grid. Three paradigm positions are now on the table: position-read
   (current U/V), rate-driven-to-grid, rate-driven-to-MIDI. **Do not
   resolve in passing** — this deserves its own design pass, alongside
   pattern banking and devices.

## 10. Open questions

1. **Range units**: drafted as CC 0–127 floats (matches the MIDI/Ableton
   headspace). Alternatives: normalized 0–1 (strudel-native), base-36.
2. **`.sync()`**: include transport-anchored phase in v1, or defer?
   (Free-running accumulator is the default regardless.)
3. **Steps-override spelling** for future pattern mounts (`.gsteps(8)` vs
   other) — deferred with patterns.
4. **`devices()` matching**: exact port name vs case-insensitive
   substring. Draft: substring, warn on ambiguity.
5. **Global addressing defaults** (`output({...})` auto-assigning CCs by
   slot) — sketched during design, not adopted (user preferred explicit
   ports + bulk-mount loops). Revisit only if port-cell boilerplate
   becomes a real pain.
6. **Breakpoint resolution** N=64 default — per-definition override
  worth exposing?

## 11. Testing plan (headless)

Pre-pass: sigil rewriting incl. digit slots, two-glyph refs, strings
containing `@` unharmed. Mount eval: artifacts produced, last-good
retention on error, deterministic doc → identical artifacts. Lookup:
specific ?? global, garbage device port falls through. Shapes: signal
sampling accuracy (sine ≤ 1 LSB₇ error), pattern-as-shape (steps,
alternation), noise determinism (hash-based, same stream across runs),
smooth interpolation. F runtime: phase survives re-mount (no jump on
rate/shape/range change); mod port — phase/rate mods tableless,
skew/spread regenerate memoized; crossings against table-walking pieces;
bang/unpowered unchanged. Device table: resolution, alias many→one,
selector fallback; Z/W device routing.

## 12. Source references

| What | Where |
|---|---|
| labelToP (`x: y` → `y.p('x')`) | `strudel/packages/transpiler/transpiler.mjs:177-200` |
| Transpiler (acorn, mini-wrapping, locations) | `strudel/packages/transpiler/transpiler.mjs` |
| Strudel signals to sample as shapes | `strudel/packages/core/signal.mjs` |
| Crossing contract retained | `griddle-smooth-cc-design.md` §3, §5; `griddle/src/modulation.js` |
| Shape-from-bank future being realized | `griddle-smooth-cc-design.md` §8.1 |
| Current F to be revised | `griddle/src/interpreter.js` (OP.LFO case) |
| Tidal-style hash randomness (noise precedent) | `tidal/.../UI.hs:85-101`; 0.1 doc determinism boundary |
