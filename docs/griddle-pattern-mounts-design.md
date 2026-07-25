# Griddle — Pattern Mounts & the U/V Unification Design

*Patterns join the mount document (`$` sigil, device-qualified, full strudel
expressions); U/V gain rate-driven time and an opt-in MIDI face, organized
as a 2×2 whose first quadrant is exactly the current semantics. Seventh
design doc; companion to `griddle-lfo-mounts-design.md` (doc six), whose §9
tension this resolves and whose `.rate()` naming this revises.*

Status: **designed (2026-07-12), pending implementation.** Intended to be
implemented together with or immediately after doc six (shared
infrastructure: transpiler pipeline, sigil pre-pass, mount table, device
table). Backward compatibility with existing patches is a design theorem
here (§5), not an aspiration.

---

## 1. The 2×2: two orthogonal dimensions, four quadrants

The deferred paradigm tension (doc six §9.3 — position-read vs rate-driven
vs direct-MIDI) resolved into two *independent* choices per mount:

|  | **grid face only** | **+ MIDI face** |
|---|---|---|
| **position-driven** | ① today's U/V — the 0.1 thesis, untouched | ② grid-timed scanning; sub-step haps play at true times |
| **rate-driven** | ③ self-advancing sequencer feeding grid dataflow | ④ "strudel-in-a-cell" |

- **The MIDI face** is F's dual-face principle applied to patterns: the
  tick-quantized grid face never goes away; an opt-in sub-tick face emits
  note events at haps' true fractional times, with **durations from
  `whole` spans** (landing "hap duration → note length" from the 0.1
  deferred list). Grid-face aliasing (a triplet inside one tick = one
  bang) is escaped on the wire, exactly as F's CC stream escapes the
  coarse pair.
- **Rate-driven time** is F's phase accumulator applied to patterns: the
  *mount* declares a cycle duration; the operator advances pattern-time
  itself; bang resets phase; rate changes never jump. The 36-step
  position universe limit evaporates — phase is unbounded, so long-form
  patterns and deep alternations mount and just play.
- **The mount decides the time model, not the operator**: a bare mount is
  positional (port 1 = position); a `.cycle()` mount is rate-driven
  (port 1 = mod). Content declares its own time semantics; the grid
  supplies the drive signal either way. No new glyphs.

### 1.1 The disintermediation question, answered structurally

Quadrant ④ is not a bypass of the grid, for two reasons:

1. **The grid face never goes away** — a rate-driven MIDI-emitting V
   still writes its sounding value south every tick, so the patch can
   observe and react to what's playing. In strudel, running patterns are
   opaque to each other; here a pattern's output is grid state readable
   by arithmetic, comparators, other mounts' mod ports, and (future)
   controller LEDs.
2. **The grid retains supervisory powers strudel lacks over its own
   patterns**: bang-gated phase reset (re-sync a melody on a euclid hit),
   mod-port modulation from any grid signal, slot-switching as a gesture,
   `#`-muting. The 0.1 thesis "the grid is the time-giver" matures into
   "the grid is the *authority* — it may give time positionally, or
   delegate time and keep supervision."

**Known property, stated eyes-open**: quadrant ④ is seductive — a patch
of nothing but `.cycle()` MIDI-face mounts is strudel wearing a grid
costume. The instrument tolerates abandoning its own idiom; the
`devices({n: null})` black-hole is the discipline mechanism for patches
that want the constraint back (§4). Instruments shouldn't police taste.

## 2. U and V, formally: the two projections

Superseding 0.1's ad-hoc "bang pattern / value pattern" framing:

> **U and V are the whole/part distinction surfaced as glyphs — two
> projections of any one mounted pattern.** U is the strike-view
> (`hasOnset` → bangs); V is the sound-view (values). One mount serves
> both: `U` at slot `a` is that pattern's rhythm, `V` at slot `a` its
> melody, definitionally in sync.

This is why they remain two operators (single-operator-plus-boolean-
patterns was considered and rejected): merging forces the projection
choice into the mount, costs a second mount per dual-use pattern, and
destroys the same-slot-two-reads idiom — to save one glyph. In quadrant ④
a single V already carries strike+pitch+velocity+duration on its MIDI
face, so the merged design would gain nothing there either. The
`onsets(pat)` mount helper exists anyway (one line) for deriving
rhythm-only mounts.

## 3. Grid-face semantics for unsynced patterns: active vs struck

The slippery case — rate-driven patterns whose haps don't align to ticks —
resolves by letting U and V ask **different questions**, both well-defined
at any real time:

- **V: what is *sounding* at the end-of-tick boundary?** A hap is active
  if its `whole` span contains the boundary instant. Show the active
  hap's value; nothing active → NONE. Pure query, no sample-and-hold
  state; rests genuinely show NONE (a rest *is* the absence of an active
  hap), preserving the 0.1 no-hidden-state rule; durations hold values on
  the grid for exactly their spans; matches F's end-of-tick face
  convention; precedented by how strudel's own visualizations sample the
  now-instant.
- **U: did anything *strike* during the swept window `[phase,
  phase+inc)`?** OR of onsets — the existing aliasing rule. Multiple
  onsets = one grid bang while the MIDI face fires them all.

"What is sounding" and "did something hit" are different musical facts;
conflating them was the source of the slipperiness. Position-driven
mounts keep their current earliest-onset-in-window semantics *unchanged*
(coincident with active-at-start for step-aligned patterns).

Residue (§9.1): overlapping actives (stack/chord at the boundary) need a
grid-face tiebreak — proposed: most recent onset wins, ties by
first-in-stack. The MIDI face has no such problem (plays all).

## 4. Ports, gates, and routing

Family invariant, stated as law: **slot is always west(2); the hot/drive
input is always west(1); addressing is west(3)+ with set-and-forget
furthest.**

| op | west(5) | west(4) | west(3) | west(2) | west(1) | south |
|---|---|---|---|---|---|---|
| `V` | — | device | channel | slot | drive | value (active-at-boundary) |
| `U` | — | device | channel | slot | drive | bang (onsets-in-window) |
| `F` | device | channel | controller | slot | mod | coarse (+fine SE) |
| `G` | device | channel | controller | target | rate | coarse (+fine SE) |

- **drive** = position (bare mount) or mod (`.cycle()` mount). Empty is
  legal in both readings (position 0 / no modulation).
- **MIDI-face gate**: U/V send iff the **channel cell is a literal**
  (F/G's controller-cell rule, applied one port over). Empty channel =
  pure grid citizen — quadrants ①/③ cost nothing.
- **Device port**: bank qualifier (`$ds` ?? `$s` lookup, doc six §2.2)
  *and* route selector via `devices()`. `devices({n: null})` = black
  hole: bank exists, wire doesn't — the patch-wide "no direct MIDI"
  discipline switch.
- **MIDI face payloads**: V emits note events — pitch from hap values
  (control objects with `.note` pass through; bare numbers → mount
  `.base()` + value), velocity from hap or mount `.vel()`, duration from
  `whole`, channel from the port; note-offs via the existing timestamped
  scheduler. U emits fixed-note triggers (`.note(36)` in the mount; no
  `.note()` → U's face is silent).

## 5. Backward compatibility (a theorem, not a hope)

Existing patches run identically, unmodified:

1. Existing U/V have slot at west(2), position at west(1) — positions
   unchanged.
2. Whatever sits at west(3)/west(4) of an existing U/V: an empty or
   non-literal channel cell disables the MIDI face; a garbage device cell
   selects a bank with no device-scoped mounts and **falls through the
   `$ds` ?? `$s` lookup to the global mount**. Garbage degrades to
   today's behavior, never to silence or noise.
3. Migrated pattern slots mount without `.cycle()` → positional → drive
   port reads as position, exactly as before.

(Contrast: the F revision in doc six *is* breaking. U/V's is not.)

## 6. Mount-document surface for patterns

Document-level (shared with doc six): `devices()`, `mount(ref, def)`,
`spread(lo, hi, n)` (geometric), `onsets(pat)`.

**`$` mounts** — the value is a strudel Pattern (mini-strings
auto-wrapped; curated core combinators available including strudel's own
`pace`/`steps` doing their strudel jobs), plus griddle methods:

| method | meaning | default |
|---|---|---|
| `.cycle("2b")` | rate-driven: one pattern-cycle per 2 beats (`"16t"`, `"4bar"`) | absent = positional |
| `.gsteps(8)` | addressing-granularity override (positional mounts) | auto from `_steps` |
| `.base(48)` / `.oct(4)` | numeric hap → MIDI note = base + value | base 48 |
| `.vel(90)` | default velocity (hap controls override) | 96 |
| `.note(36)` | U's MIDI-face fixed note | none |
| `.mod(name, ...)` | drive-port meaning: `'rate'` (multiplier lo..hi), `'phase'`, `'transpose', lo, hi`, `'degrade'`, `'velocity'` | port ignored |
| `.sync()` | transport-anchored phase (open, §9.2) | free-running |

### 6.1 Naming decisions (fixed by API review, 2026-07-12)

- **`.cycle()` replaces doc six's `.rate()`** for LFOs and patterns
  alike: `.rate("4b")` was a *duration* masquerading as a rate (bigger
  value = slower — backwards for musicians). `.cycle("4b")` ("a cycle
  lasts 4 beats") reads truthfully; one concept, one name, both mount
  types. Doc six is annotated accordingly. The `'rate'` **mod name**
  survives as the multiplier, where rate intuition is correct.
- **`.gsteps()` not `.steps()`** — verified collision: strudel core
  exports `steps` as an alias for `pace`
  (`strudel/packages/core/pattern.mjs:3517`). One awkward
  griddle-specific name beats shadowing a strudel export inside a
  strudel-shaped document.

### 6.2 Worked examples (the practice check)

```js
// ① today's idiom, untouched:
$1: "0 3 7 <9 b>"                          // grid: 1 8 C / · 1 p V

// ④ a melody playing itself — five cells on the grid: 0 1 a · V
$a: note("c3 [e3 g3] a2 <g3 b3>").cycle("2b").vel(85)

// kick lane with a live probability port — grid: 0 9 b m U
$b: "x*4 [~ x] x x2".cycle("1b").note(36).mod('degrade')

// rhythm + melody from ONE mount (the projection idiom):
$c: note("c2 ~ eb2 [g2 c3]").cycle("4b")
// U@c gates a Z; V@c feeds pitch to grid arithmetic — coherent by definition
```

## 7. Migration & UI

- **The pattern-slot tab retires.** Existing slots auto-textualize into
  the mount document (`$1: "0 3 7 <9 b>"`, steps overrides as
  `.gsteps(n)`); patch format's `slots` array is superseded by
  `mountSource` (already introduced in doc six).
- **Drive-port polysemy mitigation**: the status line (later, hover)
  shows the resolved mount kind + name for the operator under the cursor
  — also answers "is this slot even mounted."
- Doc six's per-statement error markers, last-good retention, and ⌘↵
  eval apply to `$` mounts identically.

## 8. Runtime notes

- `MountTable` serves both sigils; U/V consult `$`, F consults `@`.
- Rate-driven U/V get per-cell `opState` `{phase, activeNotes}` (phase
  accumulator; voice bookkeeping for note-offs when durations overlap a
  mount swap or mute — kill notes on unmount/mute/stop).
- Positional path is the existing `PatternBank` query logic relocated
  behind the mount table — semantics byte-identical (tests must prove
  this).
- MIDI-face events ride the existing frac-timestamped send path
  (crossings machinery generalized: onset events with fracs instead of
  boundary crossings).

## 9. Open questions

1. **Overlapping-actives tiebreak** for V's grid face (proposed: latest
   onset, then first-in-stack).
2. **`.sync()`** — transport-anchored phase for patterns and LFOs; one
   decision covering both (carried from doc six §10.2).
3. **Chord/voice bookkeeping** on V's MIDI face: simultaneous note-ons
   are fine; per-note note-off scheduling with mount-swap/mute edge cases
   needs care (§8).
4. **Hap control precedence**: mount `.vel()` vs hap-carried `velocity`
   vs future `.mod('velocity')` — proposed order: mod > hap > mount
   default.
5. **Bulk-mount ref plumbing**: if `mount('$'+d+s, ...)` string-building
   feels fiddly in practice, add `mounts({...})` object-literal form
   (planned relief valve, not a redesign).
6. **U MIDI face velocity** — fixed `.vel()` only, or pattern-value-as-
   velocity for boolean mounts with numeric values?

## 10. Testing plan (headless)

Positional regression: relocated bank produces byte-identical results to
current `PatternBank` (existing 59-test suite must pass unmodified).
Active-vs-struck: V active-at-boundary across unsynced cycles (durations
hold, rests NONE, boundary-mid-hap); U onset-OR; multiple-onsets one-bang
+ all-on-MIDI-face. Rate-driven: phase continuity across `.cycle` re-mount
and mod('rate') changes; bang reset; unbounded patterns (>36 steps)
traverse fully. MIDI face: frac timing of onsets, durations from wholes,
note-off on mute/unmount/stop, chord emission. Gates: channel-cell
opt-in, `devices({n: null})` black hole, garbage-port fallthrough
(the §5 theorem as a test). Migration: slot-array → mount-source
textualization round-trip.

## 11. Source references

| What | Where |
|---|---|
| Doc six (mount infra, sigils, device table, lookup rule, purity contract) | `griddle-lfo-mounts-design.md` |
| Resolved tension + `.rate()` naming revised | doc six §9.3, §3 |
| `steps = pace` collision (forces `.gsteps`) | `strudel/packages/core/pattern.mjs:3038, :3517` |
| Whole/part & `hasOnset` (the projections) | `strudel/packages/core/hap.mjs`; 0.1 doc §3 |
| Duration→note-length deferred item now landed | 0.1 doc §6 |
| Frac-timestamped send path to generalize | `griddle/src/main.js` (onTick), `griddle-smooth-cc-design.md` §5 |
| Current positional semantics to preserve | `griddle/src/patterns.js`, `test/interpreter.test.js` |
