# Griddle — MIDI Controllers Design (Input Regions & Bidirectional Surfaces)

*Capturing CC and note input into the grid, representing banks of controls as
grid regions, and bidirectional hardware surfaces (Launchpad-class devices) as
memory-mapped views of grid state. Follows `griddle-prototype-0.1-design.md`
and `griddle-smooth-cc-design.md`.*

Status: **designed (2026-07-08), not implemented.** Sequencing intent: input
first, bidirectional second — but the region abstraction is *born
bidirectional* here so direction never has to be retrofitted (the `_steps`
lesson: bolted-on metadata decays; §2 of the smooth-CC doc). Open questions
in §9 are deliberately unresolved — ask before deciding them in code.

Reference devices (both owned by the user):

- **Novation LaunchControl XL** — 8 channel strips × (3 knobs + 1 fader +
  2 buttons), all CC. Pure input; wants to be *visible*.
- **Novation Launchpad** — 8×8 velocity/pressure pads sending notes; LEDs set
  by incoming note/CC messages. A display that happens to have buttons.
- **shfts** (`github.com/rwhaling/shfts`, user's own norns/monome instrument)
  — the *composed* case: one 8×8 surface serving simultaneously as sequencer
  state display, injection surface, fader bank, radio bank, and modal editor.
  §6 works it as the stress test.

---

## 1. Motivation

Two performance problems, stated by the user, drive this design:

1. **Hidden controller state.** Endless rotaries and multi-page knob banks
   mean you cannot see what a parameter *is*, or which knob owns it. Pulling
   all 48 LaunchControl values into a visible 6×8 grid region — wireable into
   the patch — makes controller state legible at a glance.
2. **Sequencer surfaces.** A Launchpad running a step sequencer requires
   notes-in → 2D state updates → LED-state-out. Conventionally this means a
   sequencer engine with its own state synchronized against the hardware.
   Griddle can refuse the duplication entirely (§3).

## 2. The frame: memory-mapped I/O

**MIDI input is remote editing.** The system already has exactly one
mechanism for external state entering the grid between ticks: typing. The
editor writes cells asynchronously; the next tick sees whatever is there. A
controller is the same mechanism — the LaunchControl is 48 remote hands, each
bound to one cell. Consequences, for free:

- Input applies **immediately**, like a keystroke. No buffering-to-tick
  machinery; the tick sees the latest value.
- Input values are ordinary cells: **wireable, arithmetic-able, copyable**.
  "Wire the fader into the patch" requires no new dataflow concept.
- The determinism story is unchanged: live input is the sanctioned
  nondeterminism entry point (0.1 doc, determinism boundary), same as typing.

**MIDI output is remote rendering.** The screen renders the grid at 60fps; a
Launchpad is a second, 64-pixel display rendering a *diff* of the same cells
at MIDI-safe rates.

**Principle (load-bearing): the grid is the single source of truth; screen
and hardware are both views.** The retro analogy is exact — C64 screen RAM:
POKE a value into screen memory, a character appears; write a griddle cell,
an LED changes; press a pad, a value appears in memory. There is no
"Launchpad state" anywhere: 64 cells, and the hardware is a
framebuffer-plus-touch-surface mapped onto them.

## 3. Bidirectionality

The user's acceptance scenario: *toggle a step by typing in the grid, or by
pressing the pad — both work, both views update.*

- Typing `5` into a step cell → cell changes → LED renderer diffs the region
  → pad lights. Pressing the pad → toggle behavior writes the cell → same
  diff → LED lights, **and the on-screen glyph changes**, because the screen
  is just the other view.
- **The running patch is a third author.** Operators writing into a region
  render to LEDs identically — generative sequences are visible on hardware
  automatically, because LEDs render *cells*, not input history.
- Two inputs (keyboard, pads) converge on one mutation; two outputs (screen,
  LEDs) render one state. Classic bidirectional-MIDI reconciliation is
  dissolved by refusing to have two states.

**Hard requirement: the device must be a dumb terminal.** Launchpads in
default modes light their own pads on press (local echo); if the pad lit
itself, an LED could claim a step exists when the cell write didn't happen.
MK3-era Launchpads disable local echo in **programmer mode**, entered via a
sysex message — so `requestMIDIAccess({sysex: true})` (scarier permission
prompt) is likely required. Load-bearing, not cosmetic. (§9.4)

**Self-quenching loops.** Output is diff-based (send only on cell change);
input is idempotent (writing a cell's current value changes nothing). Even a
pathological config where a device echoes our LED messages back as input
terminates after one round trip instead of oscillating.

**Discontinuity note**: a `toggle` press is a read-modify-write of the cell
at input time — single-threaded JS, between ticks, same as typing; no race.

## 4. The region: griddle's fourth entity

A **region** is a rectangle of grid cells bound to a device profile, with a
direction (`in` / `out` / `both`), per-row-or-cell **behaviors** and
**display modes**, and up to two auxiliary cell bindings (§4.4). Regions join
cells, slots, and wires as first-class entities.

### 4.1 Profiles are dumb, declarative routing tables

`"CC 77 ch 1 → cell (col 4, row 3), scale ×35/127"` — JSON-ish data, nothing
executable. A few built-ins (LaunchControl XL, Launchpad in programmer mode,
a generic keyboard strip §7.3) plus **learn mode**: select a cell, wiggle a
control, bound. Learn beats any config format in performance and sidesteps
most device-profile authoring.

Explicitly rejected homes for device config: **pattern slots** (they are pure
lookup tables; overloading them muddies the one clean thing) and **custom
JS** (the escape hatch resisted three times now; the grid is the
custom-logic layer). If routing tables ever genuinely fall short, the
pressure valve is mondo-with-curated-lib (notation discussion), not JS.

### 4.2 Behaviors (input side) — a deliberately tiny enum

| behavior | on message | writes |
|---|---|---|
| `mirror` | CC value | literal, scaled ×35/127 (0–35) |
| `momentary` | note/CC press / release | bang (or held value) / NONE on release |
| `toggle` | note-on | cell nonzero → `0`; cell zero → **on-value** (§4.3) |
| `velocity` | note-on | literal = velocity ×35/127; note-off → NONE (or hold) |

Everything smarter is grid logic: scale-mapping pads is `N`; radio-row
exclusivity is comparisons; inc/dec buttons are bang cells feeding an
increment circuit (§6.4); conditional routing is wires. **Boundary
principle: per-control scalar behaviors live in the region adapter (64
per-pad toggle circuits on the grid would be absurd); everything
cross-control lives in the grid.**

One addition from the shfts study: **`same-press-clears`** as a
radio/fader-row option — pressing the pad for the *current* value writes 0
(shfts uses this idiom on every parameter row).

### 4.3 Toggle-on value

Toggle-off writes `0`. Toggle-on writes, per region setting:

- **velocity** (default): pad velocity scaled 1–35 — soft press = quiet
  step; the cell value is visible on screen and can drive note velocity via
  wiring. Velocity-sensitive step entry for free.
- **fixed**: configured constant (`z`, `1`, …) for non-velocity surfaces.

**Rejected: "restore previous value"** — requires a shadow value per cell;
hidden state is the disease this feature exists to cure. The cell IS the
state: type `5`, toggle it off, it's gone.

### 4.4 Auxiliary cell bindings — views parameterized by grid state

Two optional bindings, both to *ordinary grid cells*, keeping the renderer a
pure function of grid state:

- **Cursor cell** (solves the playhead problem): a step sequencer wants the
  current column highlighted, but writing a playhead *into* the region would
  corrupt step state. Instead the region binds a cursor cell;
  `color(x,y) = palette(cell(x,y)) ⊕ highlight if x == cursorCell`. Wire the
  existing `C` clock into that cell and the hardware playhead sweeps —
  no sequencer engine, just a clock driving a cell that a view reads.
- **Enable cell** (generalizes to modality, from shfts's hold-to-edit): a
  region is active (rendered + receiving) iff its bound enable cell is
  nonzero. A `momentary` pad writes that cell while held → hold-button modal
  overlays, as grid state. Two regions with complementary enable logic can
  share one hardware surface (shfts's register-display vs quantizer-editor
  modes).

### 4.5 Display modes (output side)

| mode | rendering |
|---|---|
| `cell` | per-pad `palette(value)`; `0`/NONE → off |
| `bar` | row lit dim below the value cell's level, bright at it (fader idiom) |
| `radio` | single bright pad at the value cell's index |

Palette: a curated 36-entry color table for MK3-class pads (the native
128-color palette is not perceptually ordered); monochrome-brightness
fallback for one-color devices. `bar`/`radio` rows render *one* backing cell
rather than a row of cells — display density ≠ state density.

Refresh: diff per render frame (or per tick — §9.6), full-region repaint on
region create/device reconnect. 64 note-ons ≈ 192 bytes; trivial either way.

### 4.6 Embodiment and editing semantics

Working proposal (§9.1 confirms): **side-panel-defined, grid-anchored** — a
region is created/configured in the sidebar (like slots), placed on the grid
as a highlighted rectangle overlay; it does not consume a cell and cannot be
typed over *as an entity*. Its **cells remain ordinary cells**: nothing stops
an operator sitting inside a region, and nothing stops a pad press
overwriting it (`mirror`/`toggle` writes stomp whatever is there, exactly
like typing). Uniformity over fencing — a performance foot-gun accepted with
eyes open, in the Orca tradition of everything-visible-everything-mutable.
Input behaviors only ever write literals/bangs/NONE.

### 4.7 Resolution

Input cells default to **coarse-only 0–35** — legibility is the point, and
~3.5 CC steps per glyph is plenty for hand-set controls. Per-profile option
to map a control as a coarse+fine pair (convention shared with the smooth-CC
doc) if a fader proves to need it. (§9.2)

## 5. Worked example A — LaunchControl XL

One `in` region, 6 rows × 8 columns: three `mirror` knob rows, one `mirror`
fader row, two button rows (`momentary` or `toggle` per row config). All 48
values visible as glyphs, each wireable. The which-knob-is-what problem is
solved structurally: the parameter *is* a cell you can see, next to the
operator consuming it.

Pickup caveat: after reload, absolute-CC values are unknown until each
control moves (the LCXL cannot be polled without sysex tricks). Options in
§9.5: cells empty-until-touched (honest) vs last-known from localStorage
(convenient, occasionally lies; strudel `input.mjs` precedent).

## 6. Worked example B — shfts translated (the stress test)

`shfts.lua` (809 lines, reviewed 2026-07-07): two-voice Turing-machine
sequencer — per voice a 16-slot register of *analog* values 1–16 read
through a bias **threshold** (`reg[i] > 16 − bias`) for both trigger density
and DAC bits; probabilistic head mutation; 16 grid-editable quantizer
presets; nonlinear tapers (`prbsteps_lrg = {1,2,3,5,6,8,10,12}`); modal
hold-to-edit UI. Of ~800 lines, the sequencer core is ~60; the rest is
display/input plumbing — precisely what regions abstract.

Porting it to griddle produces **three collapses**:

1. **The DAC collapses — griddle registers are natively 36-ary.** shfts
   derives bits by threshold because the Turing-machine lineage is binary;
   a griddle cell holds a pitch's worth of resolution directly. `dac()` →
   read head, `%` range, `+` offset. The threshold survives where it is
   musical: the *trigger* path is one `>` against a bias cell.
2. **The shift collapses — a shift register is a ring buffer wearing a
   costume.** Static row of cells + rotating read pointer (`C` clock, mod =
   loop length, → `M` multiplex). Locked loop = *do nothing*; mutation =
   `R < prob` bang gates an unpowered `I` writing one random value at the
   pointer; loop length = the clock's mod cell (shortening preserves tail
   values, matching shfts's recirculation-from-longer-buffer); single-step =
   a bang-incremented counter driving the index. (The alternative — east-
   velocity literals as a visible conveyor belt with `I` re-injection — is
   the demo; the ring is the instrument.)
3. **Quantizers and tapers collapse into pattern slots — with patchable
   selection.** `make_quant_tab`'s 12-entry lookup is a `V`: slot =
   `"0 0 3 3 3 5 5 7 7 7 a a"`, position = `pitch % 12`. Sixteen presets =
   sixteen slots, **selected by writing a slot index into the `V`'s slot
   cell** — from a radio row, a pattern, or the sequencer itself (a register
   modulating its own quantizer, which shfts cannot express). Tapers
   likewise: fader region writes raw index 0–7; `V` + slot
   `"1 2 3 5 6 8 a c"` applies the taper as live-editable notation.

   Honest asymmetry: shfts edits quantizer *content* on the grid (the
   fourths-layout hold-mode); griddle edits content by typing slots, and
   makes *selection* hardware-patchable. Right trade for a livecoding
   instrument; recorded as a real loss of hands-on-ness.

Core sketch (one voice, schematic):

```
1 8 C ····                     clock → index i  (mod cell = loop length ◄ inc/dec bangs)
      i ──────────► cursor cell of region (hardware playhead for free)
[ 7 0 c 3 z 0 5 1 ]            pitch ring — 8 literal cells ◄ Launchpad region:
[ z 4 0 0 9 2 0 7 ]            trigger ring                   display AND injection
R prob < ! → I(rnd→ring[i])    mutation: overwrite at pointer when R < prob-cell
M(trig,i) bias > ! ─┐          trigger: threshold bang (bias ◄ fader + taper slot)
M(pitch,i) %12 V(q,·) +oct → Z pitch: ring → quantizer slot → offset → MIDI
```

Budget ≈ 45–55 cells/voice incl. parameter cells; two voices fit 32×16 with
control regions. Every parameter shfts hides in a Lua global is a visible,
wireable, hardware-mapped cell. And the register display region is
**bidirectional for free**: pressing a pad injects a value into the sequence
by hand — a gesture shfts's read-only display rows structurally cannot offer.

(shfts review findings, recorded for the author: velocity computed but
`note_on` hardcodes 100, line ~295; `out`/`p`/`held_notes` leak global;
same-pitch note-off collision in the expiration queue; dead tables
`prbsteps`/`biassteps`/`lensteps` and dead `duration vox` params;
`r1_bias_p` unreachable from the performance surface.)

## 7. Scope notes

### 7.1 Note input generally
A generic **keyboard strip** profile (3 cells: last note, velocity,
gate-bang) covers melodic input cheaply and is the natural third built-in.
(§9.3 scopes it.)

### 7.2 Pressure / aftertouch
Launchpad poly-aftertouch could map to a second region (`mirror`-like,
per-pad). Deferred; the region model accommodates it without new concepts.

### 7.3 Relation to smooth-CC doc
Input regions are the *dual* of `F`/`G`: those render grid state out as
continuous CC; these render external CC in as grid state. The coarse+fine
pair convention is shared. A future loop — hardware knob → mirror cell →
`G` glide → smooth CC out — is four cells of latency-free parameter
smoothing with every stage visible.

### 7.4 Recording & replay (future)
Log input events with tick stamps → replayable performances; formalizes the
determinism boundary. Not v1; the immediate-application model (§2) does not
preclude it.

## 8. Machine/host architecture notes

- Region registry lives host-side (like slots), serialized with the patch
  (localStorage + future patch format). The interpreter is untouched:
  regions read/write `machine.grid` cells exactly as the editor does.
- Input path: WebMIDI `midimessage` → profile lookup → behavior → cell
  write. Immediate (between ticks), no queue.
- Output path: render loop (or tick hook) diffs bound cells per region →
  batched sends. Per-region last-frame cache; invalidate on reconnect.
- Device identity: WebMIDI port ids per profile binding; `statechange`
  re-binds on reconnect (strudel `input.mjs` precedent for hot-plug).
- The 36-device indexing of `Z`/`W` is unrelated plumbing — regions bind
  ports directly in config; no base-36 device cell needed on the input side.

## 9. Open questions (deferred by user)

1. **Region embodiment** — side-panel object with grid-rectangle overlay
   (working proposal, §4.6) vs grid-anchored glyph operator (travels with
   copy/paste, visible in patch text). Shapes editing UX; user input wanted.
2. **Resolution** — coarse-only default confirmed? Which controls, if any,
   deserve coarse+fine pairs in v1?
3. **Note-input scope** — two Novation profiles only, or include the generic
   keyboard strip (§7.1) in v1?
4. **Launchpad model & sysex** — which Launchpad generation (protocols
   differ: S / MK2 / Mini MK3 / Pro)? Is the `sysex: true` permission
   acceptable for programmer mode?
5. **Pickup/persistence** — empty-until-touched vs localStorage last-known
   for absolute CCs after reload?
6. **Refresh cadence** — LED diff per render frame (~60fps, smoother for
   mirror displays) vs per tick (quantized, calmer)? Possibly per-region.
7. **Toggle-on default** — velocity-scaled (working proposal) vs fixed;
   per-region setting either way.
8. **Learn-mode UX** — select-cell-then-wiggle proposed; does learn also
   capture behavior guess (CC→mirror, note→toggle) or always ask?

## 10. Testing plan (headless)

Profiles and behaviors are pure data + small functions — testable without
hardware: message → cell-write mapping per behavior (incl. toggle
read-modify-write, same-press-clears, idempotence); diff renderer (cell
change set → minimal message list; cursor/enable cell composition; palette);
loop-quench property (feed renderer output back as input, assert fixpoint
after one round); scaling round-trips (127↔35 monotone, endpoints exact).
Hardware smoke tests remain manual (programmer-mode entry, local-echo-off
verification).

## 11. Source references

| What | Where |
|---|---|
| shfts (user's instrument; reviewed) | `github.com/rwhaling/shfts/blob/master/shfts.lua` (809 lines; local copy fetched 2026-07-07) |
| — threshold/bias read | `shfts.lua:316-322` (`bit_at`), `:289` (trigger test) |
| — DAC / shift / quantizer | `shfts.lua:324-336`, `:338-350`, `:196-226` |
| — taper tables / grid UI idioms | `shfts.lua:364-370`, `:439-556` |
| Strudel MIDI input (hot-plug, CC refs, localStorage) | `strudel/packages/midi/input.mjs:16-150` |
| Griddle grid/editor write path (the "typing" precedent) | `griddle/src/ui.js`, `griddle/src/interpreter.js` (Buffer) |
| Griddle MIDI out / device handling | `griddle/src/midi.js` |
| Smooth-CC doc (pair convention, F/G duality) | `griddle-smooth-cc-design.md` |
| 0.1 doc (determinism boundary, slots-as-lookup) | `griddle-prototype-0.1-design.md` |
| Launchpad programmer mode (sysex entry, local echo) | Novation "Launchpad Mini MK3 Programmer's Reference" (external; confirm model per §9.4) |
