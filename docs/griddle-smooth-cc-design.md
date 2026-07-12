# Griddle — Smooth CC Operators (F / G) Design

*Stateful modulation operators (glide, LFO) with analytic sub-tick MIDI CC
rendering. Follows `griddle-prototype-0.1-design.md`; targets the implemented
prototype in `griddle/`.*

Status: **implemented (phase 1) 2026-07-12** — 7-bit MIDI only, per user
scoping; §6 (14-bit) and the Ableton bridge are designed but deferred to
later phases. Implementation: `griddle/src/modulation.js` (pure math),
`interpreter.js` (F/G cases, opState, ccEvents), `main.js` (sub-tick sends,
5ms/stream cap); tests in `test/smoothcc.test.js`. §9 open questions were
resolved with the user on 2026-07-12 (annotations inline), including one
**revision**: F gained min/max amplitude ports (§4.3) after realizing grid
arithmetic cannot scale the sub-tick CC stream — see §9.4.
**Amended 2026-07-08** with §6 (14-bit rendering): the user discovered VCV
Rack (and other receivers) support 14-bit MSB/LSB CC, revising the original
"no MSB/LSB plumbing" preference — the operators are unchanged; only the
wire face gained formats. The companion design for **MIDI CC inputs** exists
(`griddle-midi-controllers-design.md`); §8.3 notes the touchpoints.

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

Rather than *exposing* MSB/LSB plumbing on the grid, this design adds two
**stateful smoothing operators** that hold high-resolution internal values
and render them to MIDI as precisely timed CC message streams (14-bit wire
formats, added 2026-07-08, live below the grid surface — §6):

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
accumulator to scrub (§8.1). State = phase/position accumulation
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
line crosses each wire-format boundary inside `[T(t), T(t+1))` — 7-bit
integers in the base case; the math is lattice-agnostic (§6) — and
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
  `coarse×36 + fine` = 0–1295 ≈ 3.4× 7-bit CC resolution. The pair is
  ordinary grid data: wireable, arithmetic-able; the coarse byte alone feeds
  legacy consumers. (The grid face is a *patching view*, not a fidelity
  claim — see §6 for how 14-bit wire output exceeds it without contradiction.)
- **MIDI face (continuous)**: the same internal state rendered analytically
  to timestamped CC crossings (§3), at the wire format's resolution
  (7-bit base case: `cc = floor(v × 127 / 1295)`; 14-bit: §6).

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
- Target is coarse-domain (0–35), scaled **×37** into the fine domain —
  0 → 0 and z → 1295 exactly, so a max target reaches CC 127 (§9.5
  resolution; the ×36 draft topped out at CC 123). Implementation details:
  a freshly placed G initializes *at* its target (no surprise sweep from
  zero); an empty target cell means hold position; rate default 8; rate 0 =
  instant (a value-follower).
- State: current value, **integer fixed-point with sub-units**
  (1296-domain × 64) so ultra-slow rates step cleanly with zero float drift
  and full cross-platform determinism.
- Each tick: step linearly toward target by `stepPerTick(rate)`; clamp at
  target.
- **Bang: snap to target instantly**, emitting one CC message at the new
  value.
- Rate mapping (open, §9.1) — working proposal: **full-scale traversal in
  `r²` ticks** (r=6 → ~4.5s, r=g → 32s, r=z → ~2.5min at 120 BPM).
  Quadratic keeps the low end usable while opening the long end
  ("long, silky, slow" is the design aesthetic).

### 4.3 `F` — LFO

- Ports (west): `device(7), channel(6), controller(5), min(4), max(3),
  rate(2), offset(1)`; outputs coarse `(0,1)`, fine `(1,1)`.
- **min/max (amplitude, added at implementation 2026-07-12)**: the triangle
  is lerped into `[min×37, max×37]` (defaults 0/35 = full range when
  unwired); **min > max inverts the waveform**; min = max is a constant.
  Rationale in §9.4 — grid arithmetic cannot scale the sub-tick CC stream,
  so amplitude must live inside the operator. Scaling is linear-in-linear,
  so pieces stay piecewise linear and the crossing math is untouched.
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
- Rate mapping (open, §9.1) — working proposal: **period = `4·r²` ticks**
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

## 6. 14-bit rendering: three resolutions, one truth (added 2026-07-08)

Motivating discovery: VCV Rack's MIDI-CC module (and a handful of hardware
and software synths) accepts **14-bit CC** — MSB on CC *n*, LSB on CC
*n+32*, 16,384 levels — enabling very smooth, very slow modulation. Two
concerns raised: 14-bit exceeds even the two-cell grid pair (1,296), and
message volume might be unsendable. Both resolve quantitatively.

### 6.1 The resolution ladder

The internal fixed-point state specified in §4.2 (1296 × 64 = **82,944
levels**) already exceeds 14-bit by 5.06×. The §4.1 principle — the MIDI
face tells the truth about the continuous line — extends from *time* to
*amplitude*:

| layer | levels | role |
|---|---|---|
| internal state | 82,944 | the single truth |
| wire face | 16,384 (14-bit) / 128 (7-bit) | truest projection the receiver accepts |
| grid face | 1,296 (pair) / 36 (coarse) | patching view, not a fidelity claim |

Coarse *inputs* do not poison 14-bit *outputs*: G's target is one of 36
values, but what is heard is the **journey between targets**, and the
journey is the continuum, rendered at wire resolution. Same for F — rate
and offset are quantized; the triangle's output sweeps everything between.
The base-36 aesthetic governs destinations and controls; the wire renders
motion. Static values (bare `W` sends) stay coarse — they need no
smoothness by definition. Endpoint precision: internal quantization error
< 0.2 LSB₁₄.

The crossing machinery (§3, §5) is **lattice-agnostic**: same closed-form
math over 16,383 boundaries instead of 127. The §5 event gains a format
field; nothing else changes.

### 6.2 Wire formats and the output map

14-bitness is a property of the *receiver*, not the modulation. It lives in
a declarative **output map** — per (device, channel, controller):
`cc7 | cc14 | bend` (NRPN a future fourth, §8.2) — consulted by F, G, and
W alike. Echoes strudel's `midimaps` and the controllers doc's
dumb-profiles principle; no mode ports burned, no new grid syntax.

MSB/LSB discipline (where implementations usually go wrong):

- **Pair at MSB change**: MSB (CC n) then LSB (CC n+32), immediately
  adjacent, both timestamped. Receivers applying on either message see an
  inaudibly brief intermediate.
- **LSB-only within runs**: the MSB changes only 127 times across a full
  sweep (~0.8% of transitions) — everything else is a single LSB message.
  Halves the naive message count.
- **The MSB-resets-LSB trap**: some receivers zero the LSB on a bare MSB —
  the two rules above make bare MSBs impossible.

**Pitch bend is the sleeper option**: native 14-bit in a single atomic
3-byte message — no pairing, no reset trap, half the bytes, universal
support, and VCV exposes the pitch wheel as a CV source. For
one-parameter-per-channel modulation, bend-on-a-dedicated-channel is a poor
man's CV output and arguably the best wire format available. Identical
rendering machinery.

### 6.3 Message budget and adaptive decimation

Full-range sweep, one 14-bit stream, LSB-run discipline applied:

| full-range sweep time | ideal msg rate | share of DIN (~1,040 msg/s) |
|---|---|---|
| 1s | ~16,400/s | impossible — decimate |
| 10s | ~1,640/s | >100% — decimate |
| 60s | ~275/s | ~26% |
| 5 min | ~55/s | ~5% |
| 20 min | ~14/s | ~1% |

Two facts make this benign. **The stated aesthetic — very slow — is
exactly where full 14-bit is nearly free.** And the primary target (VCV) is
reached via virtual MIDI (IAC on macOS), where the 31,250-baud DIN
bottleneck does not exist; the DIN column matters only for hardware.

**Adaptive decimation** handles the fast case gracefully: when the ideal
crossing rate exceeds a per-stream budget (~250 msg/s default, open §9.8),
coarsen the boundary lattice — emit crossings of every *k*-th 14-bit step,
k chosen to fit, still analytically timestamped. Perceptual math: a
10-second full sweep decimated to 250 msg/s steps by ~6.5 LSB₁₄ every 4ms —
still ~20× finer than 7-bit, and fast motion masks steps anyway. Resolution
inversely proportional to speed matches how hearing works: slow = fine
(silky drones), fast = coarse (inaudible either way).

**Arbitration**: token bucket per output *port*, notes and transport
prioritized over CC — a late note is worse than a coarser CC step. This
subsumes §5's flat per-operator cap.

### 6.4 Known gap

Precise *static* 14-bit values are out of reach: coarse targets give 1,296
destinations (~9 cents granularity on a 10-octave V/oct mapping). Real
limitation for exact-pitch-offset use in VCV; irrelevant for modulation.
Whether G grows an optional fine-target port is open (§9.7).

## 7. Per-cell operator state

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

## 8. Future directions (recorded, not designed)

### 8.1 Waveshapes from the pattern bank
`F`'s triangle is a placeholder, deliberately **not** an enum of shapes: the
enum wants to become a slot reference. Growth path: the accumulator drives a
fine-resolution position into a bank slot read as a wavetable — the V-style
lookup that already exists, plus the base-36 fixed-point sub-step addressing
mused in earlier design discussion. `sine` in a slot then *is* the pure
waveshape, scrubbed by imperative phase — the state/shape factorization of
§2 realized. Crossing math requires only piecewise-linear sampling, which a
wavetable is by construction.

### 8.2 NRPN
The original 14-bit stub here was superseded by §6 (designed 2026-07-08).
Remaining future item: **NRPN** (CC 98/99 addressing + CC 6/38 data) for the
many hardware synths that prefer it over CC pairs — a fourth entry in the
§6.2 output-map format enum; same rendering, more setup bytes per parameter
switch, cheap within a single-parameter stream.

### 8.3 MIDI CC *inputs* (anticipated companion design)
A follow-up design doc is planned for CC input. Touchpoints to keep in mind
here: strudel's input side (`midi/input.mjs`, `MidiInput`, `createCC` refs
with localStorage persistence) is the reference implementation; an incoming
CC is naturally a *grid write* (external state entering the stateful side —
consistent with §2's paradigm split); and the two-byte pair convention
established here is the obvious representation for high-res input values.
Determinism note: live CC input is exactly the kind of true nondeterminism
the 0.1 doc's "determinism boundary" reserves for grid-side entry.

### 8.4 Other curves
Exponential/equal-power glides, sine LFO: all remain closed-form or
piecewise-linear-approximable; the crossing contract (§5) is the stable
interface. Linear/triangle first, by explicit choice.

## 9. Open questions — RESOLVED 2026-07-12 (annotations inline)

1. **Rate curves.** ✔ **Quadratic, user-confirmed** (`r²` ticks full-scale
   for G; `4·r²` ticks period for F). One-liners in `modulation.js`; retune
   in a jam session if needed.
2. **Port order.** ✔ **Set-and-forget far, user-confirmed** — addressing at
   the far west, hot inputs nearest the glyph, matching Z's convention.
3. **Pair layout.** ✔ South `(0,1)` + south-east `(1,1)` as proposed.
4. **F output depth/scaling.** ✔ **REVISED — min/max ports added** (§4.3).
   The draft's "use grid arithmetic" was wrong for the MIDI face: grid
   operators can only touch the tick-quantized coarse byte, while the CC
   stream renders from the internal trajectory and never passes through the
   grid. Without amplitude, every F is a full-range 0–127 sweep. min/max
   (CLAVIER `A`-style vocabulary) fixes this; inversion via min > max is a
   free idiom. Raised by the user mid-implementation.
5. **Target scaling.** ✔ **×37** — exact 0 and full-scale endpoints,
   superseding both drafted options (§4.2).
6. **Glyphs.** ✔ `F`/`G` confirmed; D/K/O remain free (D still reserved
   informally for a future clock-divider).
7. **Fine-target port for G.** Deferred with the 14-bit phase (moot at
   7-bit). Working answer unchanged: not until a real patch needs it.
8. **Per-port budgets.** Deferred with the 14-bit phase. Phase 1 uses the
   §5 cap (5ms per stream, final value always kept), which suffices for
   7-bit rates.

## 10. Testing plan (headless, vitest)

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
- 14-bit (§6): crossing generator parameterized by lattice size (127 vs
  16,383 — same fracs scale); LSB-run protocol (bare MSB never emitted;
  pair exactly at MSB transitions); decimation fits budget while keeping
  endpoints and monotonicity; bend format emits single messages;
  output-map dispatch (same operator, three formats).

## 11. Source references

| What | Where |
|---|---|
| CLAVIER `W` scan semantics (power AND bang, ×127/35) | `CLAVIER-36/src/ring.c` ~635–650 |
| CLAVIER raw CC send | `CLAVIER-36/src/midi.c:111` (CoreMIDI), `:188` (Win) |
| Strudel CC send (pattern-triggered, 0–1 ×127) | `strudel/packages/midi/midi.mjs:185` (`sendCC`), `:87–159` (`midicontrolMap`) |
| Strudel CC input (for §8.3 follow-up) | `strudel/packages/midi/input.mjs:16–150` |
| Strudel midimaps (precedent for the §6.2 output map) | `strudel/packages/midi/midi.mjs:87–159` |
| VCV Rack 14-bit CC (MIDI-CC module, "14-bit" toggle; MSB n / LSB n+32) | external — VCV Rack core module docs |
| Griddle lookahead clock (25ms/150ms) | `griddle/src/clock.js` |
| Griddle post-step MIDI scan to extend | `griddle/src/interpreter.js` (`scanMidi`) |
| Host tick → timestamped sends | `griddle/src/main.js` (onTick), `griddle/src/midi.js` |
| 0.1 design (paradigm split, determinism boundary, fixed-point musing) | `griddle-prototype-0.1-design.md` |
