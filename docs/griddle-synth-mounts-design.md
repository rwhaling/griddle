# Griddle — Synth Mounts Design (Superdough Devices)

*In-browser synthesis as first-class devices: strudel's superdough engine
mounted into the device table, addressed per channel, defined in the mount
document. Ninth design doc; extends `griddle-lfo-mounts-design.md` /
`griddle-pattern-mounts-design.md` (the mount system and device table) and
slots into the renderer taxonomy of `griddle-clap-daemon-design.md` §2 as
**renderer #0** — in-process, zero-install, living inside the published
instrument. Supersedes the `PreviewSynth` demo voice entirely.*

Status: **designed (2026-07-30), not implemented.** Scope decision by user:
v1 ships **static controls objects and functions returning static objects**;
pattern-valued ("field") definitions are deferred but fully sketched in §9.1
so the resolution chain is future-compatible. Open questions in §10 — ask
before deciding in code. Implementation note (user): start testing against
one or two simple sounds; build the §7 sixteen-sound bank after the
mechanism is proven.

---

## 1. Motivation

The current audible-without-gear story is `PreviewSynth` (`src/midi.js:62-96`):
34 lines, one triangle oscillator per note, fixed 5ms/30ms gain ramps,
velocity → gain. It exists so the deployed page makes sound; it expresses
nothing.

Superdough — strudel's synthesis engine — is a full instrument: basic
waveforms plus `supersaw`, `pulse`, `sbd`, `bytebeat`, noises, ZZFX, a
sampler, and a serious **wavetable engine with 22 warp modes** (`Warpmode`,
`wavetable.mjs`) plus `wt_lfo` position modulators; per voice filter ADSRs,
FM, vibrato, pitch envelopes, per-voice LFOs (`modulators.mjs`); per orbit
delay/reverb/distortion/compressor/vowel; 128-voice FIFO polyphony and node
pooling. AGPL, like griddle.

The architectural fact that makes this cheap: **superdough is a standalone
function** — `superdough(controlsObject, audioContextTime, duration)`
(`superdough.mjs:461`) — no strudel scheduler, no Pattern machinery
required. And `PreviewSynth.note()` already performs exactly that dance:
lookahead timestamp → `toCtxTime()` → fire-and-forget voice. The call site
(`main.js:145-151`) is already superdough-shaped. This is a seam change,
not an architecture change: swap the toy voice for the real engine and let
the mount document define instruments.

This makes the *published, no-install* griddle radically more expressive —
a payoff neither the Ableton bridge nor the CLAP daemon touches.

## 2. Position: renderer #0, and the death of the preview synth

Per the bridge/daemon taxonomy, note and modulation streams flow to
renderers: the M4L hub (#1, Live), the CLAP daemon (#2, plugins). WebAudio
is **renderer #0**: in-process, no socket, no install. A synth device is a
routing target in the existing device table — Z and mounted U/V address it
through their existing device/channel ports; nothing new appears on the
grid.

**`PreviewSynth` is superseded entirely** (user decision). The preview
checkbox retires. The audible-out-of-the-box guarantee moves to
defaults-as-code: the default mount document mounts the §7 bank, so a fresh
grid is audible through real instruments — the same lesson as the default
LFO table (an all-36-slot default beats a special case).

## 3. The mount: device table, channel-qualified

`devices()` currently maps device index → MIDI port name or `null` (black
hole). It gains a third value type — a **synth definition** — and
channel-qualified keys:

```js
devices({
  '3.0': { s: 'sbd', pdecay: 0.4 },                        // kick
  '3.1': { s: 'white', decay: 0.06, hpf: 8000 },           // hat
  '3.2': (n, v, d) => ({ s: 'crackle', lpf: 400 + v * 90 }), // snare, reactive
  '3':   { s: 'triangle', decay: 0.1 },                    // device fallback
  '5':   'IAC Driver Bus 1',                               // MIDI routing unchanged
})
```

- **Lookup chain: `dev.ch ?? dev`** — the same specific-beats-global rule
  as `@2a ?? @a`. Synth mounts are a two-level table over (device ×
  channel), the structural sibling of the LFO table over (device × slot).
- **Channel is a timbre selector.** On a MIDI device the channel byte
  belongs to the far end; on a synth device it is semantically unemployed —
  so it is repurposed as the instrument bank index. Sixteen timbres per
  device, selected per note by a port every Z and mounted U/V already has.
- **Orbit = device (working default)**: all channels of a synth device
  share one superdough orbit (effects bus) — a kit shares its room, a
  device is a mixer-bus concept. Overridable per definition with an
  explicit `orbit` control. (§10.3)

## 4. Definitions and the resolution chain

Two axes organize the design space: a **pattern** is *time-indexed* (timbre
= f(when the strike lands): an evolving field, rhythm-independent, cannot
react to the note) and a **function** is *strike-indexed* (timbre = f(what
the grid struck): fully reactive, no time evolution of its own). A static
object is the degenerate case of both.

**v1 ships the strike-indexed axis** (user decision, 2026-07-30): a
definition is a **controls object** or a **function returning a controls
object**. The time-indexed axis (pattern fields) is deferred to §9.1 —
deferred, not rejected: static ≡ constant pattern, so fields slot into the
chain later without breaking anything.

```
resolve(def, ctx):                        // per noteEvent
  def = lookup(device.channel) ?? lookup(device)   // §3 chain
  if (typeof def === 'function') def = def(ctx.note, ctx.vel, ctx.dur)
  controls = { ...def, note: ctx.note,
               gain: (def.gain ?? 1) * ctx.vel / 127,
               duration: ctx.durSec }
  superdough(controls, toCtxTime(ctx.timeMs), ctx.durSec)
```

Merge rule: the definition speaks for timbre; Z's ports speak for the
note. `note`/`duration` always come from the grid; velocity multiplies
into the definition's `gain` rather than replacing it (a quiet preset
stays quiet under full velocity).

## 5. The function contract

- **Arguments: `(note, velocity, durationTicks)`, positional** — these are
  exactly Z's ports; the grid reaches timbre through ports that already
  exist, no new grid syntax. Channel is *not* an argument for
  channel-qualified definitions (the channel already did its work selecting
  the def). Whether a device-level definition receives channel (one
  function handling all sixteen) is §10.4.
- **Query-time purity required** — the function runs at strike time, on
  the pure side of the two-phase eval contract (mount-time impurity is a
  livecoding gesture; query-time purity is the invariant). All arguments
  are grid-derived, so a pure function preserves determinism: same (grid,
  mounts, tick) → identical superdough calls. Purity is documented, not
  enforced — same posture as mounted patterns.
- **Time stays out of the arguments** (design refusal, recorded): no tick
  or position parameter. If timbre should vary with time, that is the
  pattern-field axis (§9.1) — functions index strikes, fields index time;
  one time-access idiom, not two.

## 6. Grid idioms (worked, from the design discussion)

- **Velocity accent, done right**: `(n, v, d) => ({ s: 'sawtooth', lpf:
  300 + v * 70, resonance: v > 24 ? 18 : 8 })` — the grid's velocity row
  (V → Z vel) sculpts timbre per note; an `R` randomizes it; a comparator
  gates it.
- **Keytracking**: `lpf: 55 * 2 ** (n / 12) * 6` — cutoff follows pitch.
- **Hold port as voice selector**: `(n, v, d) => d < 3 ? pluck : pad` —
  note length chooses the instrument; an existing port acquires depth.
- **One-Z drum kit**: a data row of channel indices scanned by `M` into
  Z's channel port sequences a whole kit through a single operator — the
  CLAVIER M-scan idiom, scanning *instruments* instead of gates.
- **Preset switching stays grid-visible**: the device port is a cell; a
  comparator writing `4`/`5` into it is a wireable, performable timbre
  switch (36 discrete timbres × 36 devices before channels even enter).

## 7. The default bank: sixteen sounds

Per defaults-as-code, `DEFAULT_MOUNT_DOC` mounts a sixteen-sound bank on
one synth device (index: §10.5) covering the demo and cold-start
experience — channels 0–f, one device, a playable kit + tonal spread.
Sketch (contents are a taste pass for the user, not final):

| ch | sketch |
|---|---|
| 0–3 | kick (`sbd`), hat (filtered `white`), snare (`crackle`, reactive), clap-ish noise |
| 4–7 | bass: dark saw (keytracked lpf), acid saw (velocity-reactive, function), sub sine, square pluck |
| 8–b | leads: supersaw (unison/spread), pulse (pwm), wavetable + warp, FM-ish sine stack |
| c–f | pads/texture: slow-attack supersaw + room, triangle pad, noise wash, bytebeat curio |

Implementation order (user decision): **prove the mechanism on one or two
simple sounds first**; author the full bank as a later polish pass. The
bank doubles as the living documentation of the definition vocabulary.

## 8. Integration and vendoring plan

- **Vendor `packages/superdough`** alongside core/mini/transpiler, plus
  strudel's in-monorepo `vite-plugin-bundle-audioworklet` (resolves the
  `?audioworklet` import for DSP worklets). Same provenance discipline as
  the existing `vendor/strudel` README.
- **Vendor refresh required**: the current pin (`95a9d301`) predates
  superdough's `modulators.mjs` (per-voice LFOs). Bumping the vendor moves
  core/mini/transpiler too — do it deliberately, run the full suite, note
  the new commit in the provenance README.
- **Init**: `registerSynthSounds()` (+ noises/zzfx registration) at app
  start; AudioContext creation/resume on first gesture (the `ensure()`
  pattern already exists). Wavetables and sample packs load over the
  network on first use — fine on the deployed site; offline use gets
  silence for those sounds and a status-line note (§10.7).
- **Mount scope widening**: `s`/`sound` and the controls vocabulary enter
  the curated scope only insofar as v1 needs them — v1 definitions are
  plain objects/functions, so *no* new Pattern-side controls are required
  yet; the scope work belongs to the §9.1 field phase. (This is a real
  simplification the static-first scoping buys.)
- **Routing**: implemented at the `noteEvents` seam (`main.js:145-151`)
  — resolve device: synth def → §4 chain; string → MIDI as today; absent →
  nothing. `PreviewSynth` and its checkbox are removed in the same change.

## 9. Deferred (documented for the future pass)

### 9.1 Pattern fields (the time-indexed axis) — deferred by user decision
A definition may be a strudel controls pattern, queried at the strike's
cycle position (positions unwrapped): the instrument as a **timbre field**
— `s('sawtooth').lpf("<600 900 1400 2600>").resonance(perlin.range(6,20))`
— stepped sequences advance in machine time, continuous signals are
sampled per onset, wavetable morphs crawl (`warp(saw.slow(16).range(0,8))`).
Fields are rhythm-independent (same tick → same controls: determinism
holds) and shared (all strikes on the device ride one evolution).
Functions may then return fields (strike context *selects among* time-
indexed fields — accent notes ride the evolving supersaw, quiet notes stay
dark). Design work owed before implementing: the position rule (bare =
machine-cycle position; a `.cycle()`-style span override per doc seven's
time models), scope widening for the controls vocabulary, and the honest
aesthetic note from the discussion — fields move timbre variation *into
the text pane*, device/channel switching keeps it *on the grid*; a patch
wants both. Theory note for the eventual doc: strudel merges note and
timbre in pattern algebra; griddle's notes come from the grid, so the
merge happens at the strike — §4's resolve() is that merge point.

### 9.2 F → synth modulation (renderer #0 earns segments)
WebAudio `AudioParam`s natively consume the segment contract
(`linearRampToValueAtTime`); superdough's `connectBusModulator` is the
plausible attach point for F streams modulating a synth device's bus
(filter, gain) continuously. Recorded, not designed.

### 9.3 Control writes (W-like face)
A per-device mapping from W's controller numbers to named controls —
grid-pushed control changes for synth devices. Needs the §9.2 story first.

### 9.4 Sample packs
`s('bd')`-style sample playback is engine-supported (sampler.mjs); the
griddle-side story (pack loading UI, offline caching) is its own pass.

## 10. Open questions (deferred — ask before deciding)

1. **Key syntax**: `'3.1'` (readable object key) vs `'31'` (mirrors the
   concatenated `@2a` sigil convention). Working: `'3.1'`.
2. **Channel range**: 16 (MIDI symmetry — a voice re-pointed from synth to
   hardware keeps meaning; matches the 16-sound bank) vs 36 (base36
   headroom, channel cell is 0–z anyway). Working: 16; >f folds mod 16
   with a status-line warning either way.
3. **Orbit = device** default confirmed? Per-definition override spelling.
4. **Device-level function signature**: does a whole-device function
   receive channel (positional 4th arg vs ctx object)? Working: yes as a
   4th argument, channel-qualified defs never see it.
5. **Default bank device index** — which device the §7 bank occupies
   (working: device `1`, leaving `0` for the user's first MIDI routing),
   and whether the bank is one device or splits kit/tonal across two.
6. **Cascade merge**: device-level def as base controls with channel
   overrides (CSS-style) vs specific-wins (the `@` table rule). Working:
   specific-wins; cascade recorded as a maybe.
7. **Offline/CDN posture** for wavetable/sample assets on the deployed
   site (silent skip + status note vs bundling a minimal wavetable set).
8. **Velocity → gain curve**: linear `v/127` (working) vs a perceptual
   curve; and whether definitions can opt out of velocity scaling.

## 11. Testing plan (headless first, per house rules)

Resolution chain is pure and testable without audio: lookup chain
(`dev.ch ?? dev`, fallbacks, absent device), function evaluation and merge
precedence (grid owns note/duration; velocity multiplies gain), 16-fold
channel folding, determinism (fixed grid + mounts + tick range → identical
resolved-controls sequences, asserted structurally against a mock
superdough capture). Scheduling: `toCtxTime` mapping monotonicity (already
exercised by PreviewSynth tests if any — port them). Default doc: bank
evaluates without error; every channel resolves. Audio itself: manual
smoke (one sound, then the bank), per the strudel-side testing posture —
don't boot audio from tooling.

## 12. Source references

| What | Where |
|---|---|
| superdough standalone contract | `strudel/packages/superdough/superdough.mjs:461` (`superdough(value, t, hapDuration, …)`) |
| sound registration (waveforms, supersaw, sbd, noises…) | `strudel/packages/superdough/synth.mjs:42-420` |
| wavetable engine, 22 warp modes, `wt_lfo` | `strudel/packages/superdough/wavetable.mjs` |
| per-voice modulators (postdates vendor pin) | `strudel/packages/superdough/modulators.mjs` |
| worklet import plugin to vendor | `strudel/packages/vite-plugin-bundle-audioworklet/` |
| the seam to replace | `griddle/src/midi.js:62-96` (`PreviewSynth`), `griddle/src/main.js:145-151` (noteEvents routing) |
| device table + specific??global precedent | `griddle/src/mounts.js` (`devices()`, `lookup`), `griddle-lfo-mounts-design.md` §2.2 |
| renderer taxonomy this joins | `griddle-clap-daemon-design.md` §2 |
| defaults-as-code precedent | `griddle-lfo-mounts-design.md` (default table); memory of the inert-F incident |
