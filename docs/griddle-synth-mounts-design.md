# Griddle — Synth Mounts Design (Superdough Devices)

*In-browser synthesis as first-class devices: strudel's superdough engine
mounted into the device table, addressed per channel, defined in the mount
document. Ninth design doc; extends `griddle-lfo-mounts-design.md` /
`griddle-pattern-mounts-design.md` (the mount system and device table) and
slots into the renderer taxonomy of `griddle-clap-daemon-design.md` §2 as
**renderer #0** — in-process, zero-install, living inside the published
instrument. Supersedes the `PreviewSynth` demo voice entirely.*

Status: **v1 core IMPLEMENTED 2026-07-30** (119 tests): devices() synth
definitions with channel-qualified keys, `synthDef` lookup chain, pure
`resolveSynthControls` (functions, layers, aliases, velocity-gain merge) in
`src/mounts.js`; lazy superdough glue in `src/synthout.js`; device routing
at the noteEvents seam in `main.js`; PreviewSynth + checkbox removed;
superdough vendored (see §9 deltas). Demo voices shipped on **device z,
channels 0–5** (sine, pluck, supersaw, layered kick, rim, hat) per user
direction — the §7 sixteen-sound bank remains a future polish pass. NOT
yet implemented: `master()` limiter (§8), the `acurve` patch (§9),
sound-by-ear tuning of the demo defs. Scope decision by user: v1 ships
**static controls objects and functions returning static objects**;
pattern-valued ("field") definitions are deferred but fully sketched in
§10.1 so the resolution chain is future-compatible. Open questions in §11
— ask before deciding in code.

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
  explicit `orbit` control. (§11.3)

## 4. Definitions and the resolution chain

Two axes organize the design space: a **pattern** is *time-indexed* (timbre
= f(when the strike lands): an evolving field, rhythm-independent, cannot
react to the note) and a **function** is *strike-indexed* (timbre = f(what
the grid struck): fully reactive, no time evolution of its own). A static
object is the degenerate case of both.

**v1 ships the strike-indexed axis** (user decision, 2026-07-30): a
definition is a **controls object** or a **function returning a controls
object**. The time-indexed axis (pattern fields) is deferred to §10.1 —
deferred, not rejected: static ≡ constant pattern, so fields slot into the
chain later without breaking anything.

```
resolve(def, ctx):                        // per noteEvent
  def = lookup(device.channel) ?? lookup(device)   // §3 chain
  if (typeof def === 'function') def = def(ctx.note, ctx.vel, ctx.dur)
  for (layer of [def].flat()) {                    // array = layered voices
    controls = { ...layer, note: ctx.note,
                 gain: (layer.gain ?? 1) * ctx.vel / 127,
                 duration: ctx.durSec }
    superdough(controls, toCtxTime(ctx.timeMs), ctx.durSec)
  }
```

Merge rule: the definition speaks for timbre; Z's ports speak for the
note. `note`/`duration` always come from the grid; velocity multiplies
into the definition's `gain` rather than replacing it (a quiet preset
stays quiet under full velocity).

**Layered definitions (added 2026-07-30, in v1)**: a definition — or a
function's return — may be an **array of controls objects**, each becoming
one voice at the same timestamp. One superdough call is one source; a
layered def is how a strike sounds like oscillator-plus-noise — the
classic drum-synth voice (§7.1). One `.flat()` branch, no new concepts.

## 5. The function contract

- **Arguments: `(note, velocity, durationTicks)`, positional** — these are
  exactly Z's ports; the grid reaches timbre through ports that already
  exist, no new grid syntax. Channel is *not* an argument for
  channel-qualified definitions (the channel already did its work selecting
  the def). Whether a device-level definition receives channel (one
  function handling all sixteen) is §11.4.
- **Query-time purity required** — the function runs at strike time, on
  the pure side of the two-phase eval contract (mount-time impurity is a
  livecoding gesture; query-time purity is the invariant). All arguments
  are grid-derived, so a pure function preserves determinism: same (grid,
  mounts, tick) → identical superdough calls. Purity is documented, not
  enforced — same posture as mounted patterns.
- **Time stays out of the arguments** (design refusal, recorded): no tick
  or position parameter. If timbre should vary with time, that is the
  pattern-field axis (§10.1) — functions index strikes, fields index time;
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
one synth device (index: §11.5) covering the demo and cold-start
experience — channels 0–f, one device, a playable kit + tonal spread.
Sketch (contents are a taste pass for the user, not final):

| ch | sketch |
|---|---|
| 0–3 | kick (`sbd`, `duckorbit` → pad device: free sidechain pumping, §8), hat (filtered `white`), snare (`crackle`, reactive), clap-ish noise |
| 4–7 | bass: dark saw (keytracked lpf), acid saw (velocity-reactive, function), sub sine, square pluck |
| 8–b | leads: supersaw (unison/spread), pulse (pwm), wavetable + warp, FM-ish sine stack |
| c–f | pads/texture: slow-attack supersaw + room, triangle pad, noise wash, bytebeat curio |

Implementation order (user decision): **prove the mechanism on one or two
simple sounds first**; author the full bank as a later polish pass. The
bank doubles as the living documentation of the definition vocabulary.

### 7.1 Worked target: Microtonic (the drum-synth stress test)

Studied 2026-07-30 against the Sonic Charge Microtonic user guide (v3.3.4)
— a single universal drum-voice architecture: oscillator (sine/tri/saw,
pitch modulation) + filtered noise (LP/BP/HP + Q, shaped envelope), mixed,
distorted, EQ'd, with three velocity-sensitivity targets. Verdict:
**~85% reproducible with genuine character overlap**, given §4's layered
definitions. The bank's drum channels should be Microtonic-shaped.

What maps directly (verified against superdough source):

| Microtonic | superdough |
|---|---|
| osc sine/tri/saw + frequency | `s` + `freq` |
| decaying pitch mod (the kick/tom heart) | full pitch ADSR: `penv` (signed semitones) + `pattack`/`pdecay` + **`pcurve`** (0=linear 1=exponential — the drop curve is shapeable) |
| sine pitch mod: slow (LFO) / fast (FM, metallic) | `vib`/`vibmod` / `fmi`+`fmh` (rate-Hz → ratio conversion in a def function) |
| noise + multimode filter + Q | `'white'`/pink/brown + `lpf`/`bpf`/`hpf` + resonance, ladder model available |
| osc/noise mix | layer gains (§4 arrays) |
| distortion 0–100 | `distort`/`distortvol`/`distorttype` (+`crush`/`coarse`) |
| velocity sensitivity (3 fixed targets, 0–200%) | the def function — velocity may scale *any* control with any curve; strictly more general |
| level/pan, output A/B | `gain`/`pan`, orbit/device routing (36 devices vs 2 buses) |

Envelope curvature (double-checked 2026-07-30): superdough's envelope
machinery supports linear AND exponential ramps (`getParamADSR` curve
param); filter envelopes default exponential, pitch envelope selectable
via `pcurve`. Only the **amplitude** ADSR is hardcoded `'linear'` at the
synth `registerSound` call sites — an unexposed parameter, not a
machinery limit. Fix: the §9 `acurve` vendored patch (also buys
Microtonic's signature exponential attack). Symmetry noted: Microtonic's
manual concedes exponential decay "never reaches zero… only approximate"
— the same approximation as WebAudio's 0.001-floored exponential ramp.

Honest gaps (each with its workaround): **audio-rate random pitch mod**
(shaker/rattle band-noise — no equivalent; `crackle` is adjacent; NB
per-trigger randomization is *better* done griddle-side: an `R` feeding a
port is deterministic, visible, replayable); **modulated/clap envelope**
(retriggered micro-bursts — tick resolution can't fake 10–30ms spacing;
accept a different clap or `crackle`); **per-voice bell EQ** (filters /
orbit `djf` approximate the role, not the ±40dB boost); **synth-voice
choke groups** (`cut` exists only in the sampler path, `sampler.mjs:289`
— griddle-side gating idiom or a small vendored extension, §11.11);
**stereo-uncorrelated noise** (orbit reverb send does the dispersed job
by other means). The pattern-engine half of Microtonic — matrix, accents,
chaining, choke priorities — is griddle itself.

## 8. Effects and the master bus (added 2026-07-30)

Everything asked of the effects story — delay, reverb, saturation,
limiting, summing to one stereo bus — is preexisting superdough parts,
except a master limiter, which is one insertion of superdough's own
pooled compressor helper.

**Per orbit** (shared bus per synth device, lazily built — `Orbit`,
`superdoughoutput.mjs:19-130`), all driven by keys the definitions
already carry:

- **Feedback delay**: per-voice `delay` is the send; `delaytime` /
  `delayfeedback` configure the shared node; **`delaysync` gives
  tempo-synced delay** (needs cps plumbed into the `superdough()` call —
  §11.9).
- **Reverb**: `room` (send) + `roomsize`/`roomfade`/`roomlp`/`roomdim`
  (generated), or **convolution with custom impulse responses**
  (`ir`/`irspeed`/`irbegin`, loaded like samples). Regenerates only on
  parameter change.
- **`djf`**: one-knob DJ filter worklet on the whole orbit bus.
- **Sidechain ducking**: `duckorbit`/`duckonset`/`duckattack`/`duckdepth`
  — a voice ducks *other orbits'* output gain with exponential ramps.
  With orbit = device, pumping is one key in the kick's definition
  (`duckorbit: <pad device>`); free, and demo-bank material.

**Per voice**: `distort` (+`distortvol`, `distorttype`, gain-compensated
waveshaper), `shape`, `crush`, `coarse`, and `compressor`
(+`compressorRatio`/`Knee`/`Attack`/`Release`, pooled
`DynamicsCompressorNode`). Saturation is therefore per-definition already.

**The gap — master limiting**: `SuperdoughAudioController` sums via
`channelMerger → destinationGain → destination` with nothing protective.
Fix: insert `getCompressor()` (`helpers.mjs:148`) before
`destinationGain` with limiter-shaped settings (threshold ≈ −2dB, ratio ≈
20, attack ≈ 2ms). Exposed as a **`master()` mount statement**, sibling
of `bpm()`/`grid()`:

```js
master({ gain: 0.9, threshold: -2, ratio: 20 })
```

Design consequence recorded: orbit parameters riding in per-voice controls
(last-write-wins on the shared node) work but scatter the bus config —
this is the strongest argument yet for the §11.6 cascade, at least for the
orbit-parameter keys (`'3': { delaytime: .375, roomsize: 3 }` configures
the kit's bus once; channels stay voices).

## 9. Integration and vendoring plan

- **Vendor `packages/superdough`** alongside core/mini/transpiler, plus
  strudel's in-monorepo `vite-plugin-bundle-audioworklet` (resolves the
  `?audioworklet` import for DSP worklets). Same provenance discipline as
  the existing `vendor/strudel` README.
- **Vendor refresh: NOT needed** (corrected at implementation 2026-07-30):
  the sibling clone is itself at `95a9d301` and superdough — including
  `modulators.mjs` — exists at that commit; it was vendored from there.
  The earlier "postdates the pin" claim was wrong. Implementation deltas
  that DID land: the worklet plugin inherits host resolve config (local
  delta, see `vendor/strudel/README.md`); `@kabelsalat/web` stubbed
  (`src/stubs/`); `@kabelsalat/lib` + `nanostores@^0.11` installed;
  superdough code-splits into a lazy chunk (loads on the play gesture).
- **`acurve` vendored patch** (§7.1): expose the amplitude ADSR's curve —
  the synth `registerSound` sites hardcode `'linear'` into a
  curve-capable `getParamADSR`; thread `value.acurve ?? 'linear'` through
  instead (one word per call site). Note in the provenance README as a
  local delta; offer upstream to strudel as a PR — it is an
  obviously-useful control. (A third `setTargetAtTime` RC-decay mode is
  recorded as a maybe, not a need.)
- **Init**: `registerSynthSounds()` (+ noises/zzfx registration) at app
  start; AudioContext creation/resume on first gesture (the `ensure()`
  pattern already exists). Wavetables and sample packs load over the
  network on first use — fine on the deployed site; offline use gets
  silence for those sounds and a status-line note (§11.7).
- **Mount scope widening**: `s`/`sound` and the controls vocabulary enter
  the curated scope only insofar as v1 needs them — v1 definitions are
  plain objects/functions, so *no* new Pattern-side controls are required
  yet; the scope work belongs to the §10.1 field phase. (This is a real
  simplification the static-first scoping buys.) `master()` (§8) joins the
  statement scope beside `bpm()`/`grid()`.
- **Routing**: implemented at the `noteEvents` seam (`main.js:145-151`)
  — resolve device: synth def → §4 chain; string → MIDI as today; absent →
  nothing. `PreviewSynth` and its checkbox are removed in the same change.

## 10. Deferred (documented for the future pass)

### 10.1 Pattern fields (the time-indexed axis) — deferred by user decision
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

### 10.2 F → synth modulation (renderer #0 earns segments)
WebAudio `AudioParam`s natively consume the segment contract
(`linearRampToValueAtTime`); superdough's `connectBusModulator` is the
plausible attach point for F streams modulating a synth device's bus
(filter, gain) continuously. Recorded, not designed.

### 10.3 Control writes (W-like face)
A per-device mapping from W's controller numbers to named controls —
grid-pushed control changes for synth devices. Needs the §10.2 story first.

### 10.4 Sample packs
`s('bd')`-style sample playback is engine-supported (sampler.mjs); the
griddle-side story (pack loading UI, offline caching) is its own pass.

## 11. Open questions (deferred — ask before deciding)

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
   overrides (CSS-style) vs specific-wins (the `@` table rule). Working
   answer UPGRADED by §8: cascade at least for the orbit-parameter keys
   (delaytime/feedback, room*, ir*) so a device's bus is configured once;
   whether voice keys cascade too is the remaining taste call.
7. **Offline/CDN posture** for wavetable/sample assets on the deployed
   site (silent skip + status note vs bundling a minimal wavetable set).
8. **Velocity → gain curve**: linear `v/127` (working) vs a perceptual
   curve; and whether definitions can opt out of velocity scaling.
9. **cps mapping for `delaysync`** (§8): what one superdough "cycle"
   means in griddle time — a beat (`cps = bpm/60`) or a bar
   (`cps = bpm/240` at 4 ticks/beat). Working: a beat, so
   `delaysync: 0.75` reads as dotted-eighth-of-a-beat-ish; confirm
   against feel.
10. **`master()` defaults** (§8): limiter always on with gentle defaults
    (safety-first, working) vs only present when the statement appears;
    exact parameter spelling.
11. **Synth-voice choke groups** (§7.1): open/closed-hat choke — extend
    superdough's sampler-only `cut` to synth voices (vendored, offer
    upstream) vs a griddle-side gating idiom. Working: the vendored
    extension, it is where the sampler precedent points.

## 12. Testing plan (headless first, per house rules)

Resolution chain is pure and testable without audio: lookup chain
(`dev.ch ?? dev`, fallbacks, absent device), function evaluation and merge
precedence (grid owns note/duration; velocity multiplies gain), layered
defs (array → N calls, one timestamp, per-layer gain scaling), 16-fold
channel folding, determinism (fixed grid + mounts + tick range → identical
resolved-controls sequences, asserted structurally against a mock
superdough capture). Scheduling: `toCtxTime` mapping monotonicity (already
exercised by PreviewSynth tests if any — port them). `master()` statement:
parses, validates ranges, records into the table (bpm()/grid() pattern).
Default doc: bank evaluates without error; every channel resolves. Audio
itself: manual smoke (one sound, then the bank; limiter audibly catches a
deliberate overload), per the strudel-side testing posture — don't boot
audio from tooling.

## 13. Source references

| What | Where |
|---|---|
| superdough standalone contract | `strudel/packages/superdough/superdough.mjs:461` (`superdough(value, t, hapDuration, …)`) |
| sound registration (waveforms, supersaw, sbd, noises…) | `strudel/packages/superdough/synth.mjs:42-420` |
| wavetable engine, 22 warp modes, `wt_lfo` | `strudel/packages/superdough/wavetable.mjs` |
| per-voice modulators (postdates vendor pin) | `strudel/packages/superdough/modulators.mjs` |
| orbit bus: delay/reverb/djf/duck | `strudel/packages/superdough/superdoughoutput.mjs:19-130` (`Orbit`), `:200` (`duck` fan-out) |
| master sum (limiter insertion point) | `strudel/packages/superdough/superdoughoutput.mjs:143-148` (`channelMerger → destinationGain`) |
| pooled compressor for the master limiter | `strudel/packages/superdough/helpers.mjs:148` (`getCompressor`) |
| per-voice distort/compressor in the fx chain | `strudel/packages/superdough/superdough.mjs:812-860` |
| curve-capable ADSR machinery (`acurve` patch target) | `strudel/packages/superdough/helpers.mjs:40-58` (`getParamADSR`), `synth.mjs:47-68` (hardcoded `'linear'`) |
| pitch-envelope curve selection (`pcurve`) | `strudel/packages/superdough/helpers.mjs:325-335` |
| sampler-only cut groups (choke gap) | `strudel/packages/superdough/sampler.mjs:289-365` |
| Microtonic architecture studied (§7.1) | Sonic Charge Microtonic User Guide v3.3.4, Architecture + Drum Patch Section (pp. 4, 13–20) |
| worklet import plugin to vendor | `strudel/packages/vite-plugin-bundle-audioworklet/` |
| the seam to replace | `griddle/src/midi.js:62-96` (`PreviewSynth`), `griddle/src/main.js:145-151` (noteEvents routing) |
| device table + specific??global precedent | `griddle/src/mounts.js` (`devices()`, `lookup`), `griddle-lfo-mounts-design.md` §2.2 |
| renderer taxonomy this joins | `griddle-clap-daemon-design.md` §2 |
| defaults-as-code precedent | `griddle-lfo-mounts-design.md` (default table); memory of the inert-F incident |
