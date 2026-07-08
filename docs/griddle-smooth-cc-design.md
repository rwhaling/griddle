# Griddle — Smooth CC Operators (F / G) Design

*Stateful modulation operators (glide, LFO) with analytic sub-tick MIDI CC
rendering. Follows `griddle-prototype-0.1-design.md`; targets the implemented
prototype in `griddle/`.*

Status: **design agreed in discussion (2026-07-07), not yet implemented.**
Open questions are collected in §8 for a later pass — do not resolve them
silently at implementation time. A companion design for **MIDI CC inputs**
is anticipated as a separate doc; §7.3 notes the touchpoints.

---

## 1. Motivation

CLAVIER's `W` operator (ported in 0.1) is maximally discrete: one CC message
per adjacent bang, value quantized `knob × 127/35` (`CLAVIER-36/src/ring.c`
~line 635; raw immediate `0xB0` send in `src/midi.c:111`). That is right for
gestures, wrong for *modulation*: filter sweeps, crossfades, slow timbral
drift. Two problems:

1. **Fidelity**: grid literals are 0–35; MIDI CC is 0–127. A single cell
   cannot even express every CC value.
2. **Rate**: the grid evaluates once per tick (~125ms at 120 BPM, 4 ticks per
   beat). CC rendered at tick resolution is audibly steppy; long transitions
   need many intermediate messages at *finer-than-tick* timing.

Rather than MSB/LSB plumbing, this design adds two **stateful smoothing
operators** that hold high-resolution internal values and render them to MIDI
as precisely timed CC message streams:

- **`G` — glide**: slews from its current value toward a target at an
  adjustable rate (linear for now).
- **`F` — LFO**: free-running oscillator (triangle for now) with adjustable
  rate and phase offset; **rate changes do not reset phase**; an adjacent
  bang resets phase.

Fact-check recorded during design: strudel *does* send CC (`sendCC`,
`strudel/packages/midi/midi.mjs:185`, values 0–1 scaled ×127 via `midimaps`)
— but only *pattern-triggered*, i.e. at hap onsets. Neither parent system has
a continuously-rendered control line; strudel approximates one by
discretizing signals with `.segment(n)`. This feature is therefore new
territory for the lineage, not a port.

## 2. Why not strudel signals (the paradigm argument)

The 0.1 division of labor is: **bank = pure lookup, grid = state and time.**
These two operators are precisely the two canonical modulation primitives
that pure functions of time cannot express:

- **Slew is a function of history.** Output depends on where the value *was*,
  which depends on every prior target it chased. `Time → Value` has no "was".
  (Tidal's `VState` threads state through queried events — wrong shape.)
- **A rate-stable LFO is an integral.** A pure signal computes
  `phase = t × rate`; changing rate rescales all elapsed time and the phase
  jumps (the classic naive-LFO bug). "Phase survives rate changes" *defines*
  a *phase accumulator*: `phase += rate·dt` — state by definition.

So F and G are grid-side stateful operators. Strudel signals remain relevant
in exactly one future role: as pure **waveshapes** for a stateful phase
accumulator to scrub (§7.1). State = phase/position accumulation
(imperative, grid); shape = pure function of phase (bank). That
factorization is the whole griddle thesis in miniature.

## 3. Core insight: analytic sub-tick rendering, no lag

An earlier draft had a separate "fine CC sender" operator interpolating
between *observed* tick values — costing one tick of lag and smearing. It
was dropped for this:

**Within any tick window, both trajectories are known in closed form at the
start of the tick.** G's segment is `current → current + step` (linear); F's
is a linear phase sweep through a triangle (piecewise linear, at most one
fold at a peak/trough per window). The lookahead clock (`griddle/src/clock.js`,
25ms poll / 150ms horizon) evaluates tick *t* before its wall time `T(t)`.
So at evaluation time the operator computes *exactly* where its continuous
line crosses each 7-bit integer boundary inside `[T(t), T(t+1))` and
schedules one timestamped CC message per crossing via
`MIDIOutput.send(data, timestamp)` — the OS driver does the last mile,
same as note scheduling.

Consequences:

- A 30-second glide renders as ~127 messages, one every ~236ms, each landing
  at the exact moment the ideal line crosses that integer. Cleanest staircase
  7-bit MIDI can express ("clean integer transition points").
- Message timing is **irregular by construction** — crossings happen where
  the value moves, not on a clock. Slow motion → sparse messages; stasis →
  silence. Deduplication is automatic (no crossing, no message).
- **No added latency** — this is causal: the tick-t segment is fully
  determined when tick t is evaluated.
- **Discontinuities send one edge, not a burst**: a bang-snap (G) or phase
  reset (F) emits a single message at the new value. Only continuous motion
  renders as staircases.

## 4. Operator specifications

### 4.1 Two faces, one state

Each operator has:

- **Grid face (tick-quantized)**: writes a two-byte value pair every tick —
  **coarse at south `(0,1)`, fine at south-east `(1,1)`**. Domain
  `coarse×36 + fine` = 0–1295 ≈ 3.4× CC resolution (headroom for future
  14-bit CC / pitch bend). The pair is ordinary grid data: wireable,
  arithmetic-able; the coarse byte alone feeds legacy consumers.
- **MIDI face (continuous)**: the same internal state rendered analytically
  to timestamped CC crossings (§3). CC mapping: `cc = floor(v × 127 / 1295)`.

The grid never pretends to sub-tick resolution; the MIDI face tells the
truth about the continuous line. Both are views of one state — divergence is
impossible.

**CC sending is opt-in by addressing**: if the controller port cell is
empty / non-literal, the operator is a pure grid modulator and sends
nothing. Presence of an address is the switch; no configuration.

### 4.2 `G` — glide

- Ports (west, postfix convention — hot inputs nearest):
  `device(5), channel(4), controller(3), target(2), rate(1)`; outputs
  coarse `(0,1)`, fine `(1,1)`.
- Target is coarse-domain (0–35), scaled ×36 into the fine domain
  (so target `z` = 1260, not 1295 — full-scale means "top coarse step";
  acceptable, or scale ×36+35 — minor open point, §8.5).
- State: current value, **integer fixed-point with sub-units**
  (1296-domain × 64) so ultra-slow rates step cleanly with zero float drift
  and full cross-platform determinism.
- Each tick: step linearly toward target by `stepPerTick(rate)`; clamp at
  target.
- **Bang: snap to target instantly**, emitting one CC message at the new
  value.
- Rate mapping (open, §8.1) — working proposal: **full-scale traversal in
  `r²` ticks** (r=6 → ~4.5s, r=g → 32s, r=z → ~2.5min at 120 BPM).
  Quadratic keeps the low end usable while opening the long end
  ("long, silky, slow" is the design aesthetic).

### 4.3 `F` — LFO

- Ports (west): `device(5), channel(4), controller(3), rate(2), offset(1)`;
  outputs coarse `(0,1)`, fine `(1,1)`.
- State: phase accumulator, fixed-point. Each tick
  `phase = (phase + increment(rate)) mod 1`.
- **Rate changes never touch the accumulator** — that is the point of the
  accumulator design.
- **Offset is applied at read time** (`out = shape(phase + offset/36)`),
  never accumulated: tweaking it shifts the waveform instantly and
  reversibly; two Fs sharing a rate with offsets 0 and 9 are a quadrature
  pair.
- Shape: triangle for now (`2p` rising for p<½, `2−2p` falling), scaled to
  0–1295. Piecewise linear ⇒ crossing math stays closed-form; a mid-tick
  fold splits the window into two segments, crossings computed per segment.
- **Bang: reset accumulator to zero** (output jumps to `shape(offset)`), one
  CC edge emitted. Makes the LFO retriggerable — a `U` reading a euclid
  adjacent to an `F` re-syncs it on the rhythm.
- Rate mapping (open, §8.1) — working proposal: **period = `4·r²` ticks**
  (r=1 → 1 beat, r=6 → 9 bars, r=z → ~10min). Same quadratic mental model
  as G.

### 4.4 Bang semantics note

Both operators are **powered** (free-running); adjacency of a bang is
repurposed as a *discontinuity gesture* (snap / reset) rather than the
"fire once" meaning it has for unpowered operators. Precedent: MIDI `Z`/`W`
already give bang a special meaning for powered operators (fire = power AND
bang). Unpowered F/G are simply frozen (state holds, nothing sent).

## 5. Machine/host contract & scheduling

The interpreter stays time-agnostic; the host owns wall time. New contract:

1. `machine.step()` evaluates F/G in reading order like any operator:
   update state, write the grid-face pair (wire-propagating, as all operator
   writes do).
2. A post-step scan (analogue of `scanMidi()`) emits **crossing events with
   fractional tick offsets**:
   `{type:'cc', device, channel, controller, value7, frac}` where
   `frac ∈ [0,1)` is the position of the crossing within this tick window,
   computed in exact integer/rational arithmetic from the segment endpoints.
3. The host (`main.js` onTick) maps `frac` → `timeMs + frac × tickMs` and
   sends timestamped WebMIDI messages. (Note-off scheduling already works
   this way; this generalizes the pattern.)

**Message-rate safety**: a fast LFO (r=1) sweeping full range crosses ~254
boundaries per period; cap emission at ~one message per 5ms per operator
(drop interior crossings, always keep segment endpoints). Inaudible for CC;
protects cheap MIDI interfaces.

**Same-controller contention** (two operators addressing one
device/channel/controller) is not arbitrated — last write wins per
timestamp, as in CLAVIER. User's responsibility.

## 6. Per-cell operator state

New machine facility:

- `machine.opState: Map<"x,y", {tag, ...state}>` — keyed by **position**,
  with the operator tag as a guard (replacing a `G` with an `F` at the same
  cell starts fresh state).
- **Reset on play** alongside metronome/registers/PRNG. The 0.1
  reproducibility invariant survives intact: all output, including the CC
  stream, is a pure function of (grid, slots, tick count).
- **Not persisted** to localStorage — runtime state, like a sounding voice.
- **State is positional**: an operator moved by velocity leaves its state
  behind (documented; arguably exploitable). Stale entries swept lazily.

## 7. Future directions (recorded, not designed)

### 7.1 Waveshapes from the pattern bank
`F`'s triangle is a placeholder, deliberately **not** an enum of shapes: the
enum wants to become a slot reference. Growth path: the accumulator drives a
fine-resolution position into a bank slot read as a wavetable — the V-style
lookup that already exists, plus the base-36 fixed-point sub-step addressing
mused in earlier design discussion. `sine` in a slot then *is* the pure
waveshape, scrubbed by imperative phase — the state/shape factorization of
§2 realized. Crossing math requires only piecewise-linear sampling, which a
wavetable is by construction.

### 7.2 14-bit CC / pitch bend
The 1296-level internal domain exceeds 7-bit by 3.4×; MSB/LSB CC pairs
(cc n / n+32) or pitch bend would use it fully. Explicitly out of scope now
(user preference), but the two-byte grid face and internal fixed-point were
chosen so this needs no rework.

### 7.3 MIDI CC *inputs* (anticipated companion design)
A follow-up design doc is planned for CC input. Touchpoints to keep in mind
here: strudel's input side (`midi/input.mjs`, `MidiInput`, `createCC` refs
with localStorage persistence) is the reference implementation; an incoming
CC is naturally a *grid write* (external state entering the stateful side —
consistent with §2's paradigm split); and the two-byte pair convention
established here is the obvious representation for high-res input values.
Determinism note: live CC input is exactly the kind of true nondeterminism
the 0.1 doc's "determinism boundary" reserves for grid-side entry.

### 7.4 Other curves
Exponential/equal-power glides, sine LFO: all remain closed-form or
piecewise-linear-approximable; the crossing contract (§5) is the stable
interface. Linear/triangle first, by explicit choice.

## 8. Open questions (deferred by user, 2026-07-07)

1. **Rate curves.** Quadratic for both (`r²` ticks full-scale for G;
   `4·r²` ticks period for F) is the working proposal. Alternatives: linear
   (legible, short max), or G counting in *beats* (`r²` beats → up to
   ~10min glides). Recommendation: implement quadratic, tune in a jam
   session — the formulas are one-liners.
2. **Port order.** Working proposal: device/channel/controller as far
   (set-and-forget) inputs, target/rate (G) and rate/offset (F) nearest
   (hot), matching Z's convention. Confirm before implementation.
3. **Pair layout.** South `(0,1)` + south-east `(1,1)` proposed (keeps the
   next row free for a consumer reading both as west-adjacent inputs).
   Alternative: vertical stack.
4. **F output depth/scaling.** No depth/min/max ports in this draft (use
   grid arithmetic on the coarse byte, or wait for CC-input doc's mapping
   ideas?). A depth port is a plausible 6th input if jams demand it.
5. **Target scaling.** `target × 36` tops out at 1260, not 1295 (§4.2) — is
   "coarse-step top" acceptable, or scale to true full-scale?
6. **Glyph confirmation.** `G` glide, `F` LFO (both free in the ported tag
   space; D/K/O remain free). Any collision with future plans (e.g. D as a
   dedicated clock-divider from the fractional-time discussion)?

## 9. Testing plan (headless, vitest)

- G converges to target; step size matches rate formula; clamps exactly;
  bang snaps; unpowered freezes.
- F phase continuity across rate change (assert output delta bounded by one
  step — the no-jump property); bang reset; offset quadrature; fold-in-window
  crossing correctness.
- Crossing generator: for a known linear segment, crossing fracs are exact
  rationals; boundary dedupe (no message when stalled); rate cap keeps
  endpoints; snap emits exactly one event.
- Determinism: two runs from reset produce identical event streams
  (values + fracs).
- Grid face: pair written south/south-east, wire propagation applies,
  coarse-only consumption works.

## 10. Source references

| What | Where |
|---|---|
| CLAVIER `W` scan semantics (power AND bang, ×127/35) | `CLAVIER-36/src/ring.c` ~635–650 |
| CLAVIER raw CC send | `CLAVIER-36/src/midi.c:111` (CoreMIDI), `:188` (Win) |
| Strudel CC send (pattern-triggered, 0–1 ×127) | `strudel/packages/midi/midi.mjs:185` (`sendCC`), `:87–159` (`midicontrolMap`) |
| Strudel CC input (for §7.3 follow-up) | `strudel/packages/midi/input.mjs:16–150` |
| Griddle lookahead clock (25ms/150ms) | `griddle/src/clock.js` |
| Griddle post-step MIDI scan to extend | `griddle/src/interpreter.js` (`scanMidi`) |
| Host tick → timestamped sends | `griddle/src/main.js` (onTick), `griddle/src/midi.js` |
| 0.1 design (paradigm split, determinism boundary, fixed-point musing) | `griddle-prototype-0.1-design.md` |
