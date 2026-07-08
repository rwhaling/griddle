# Griddle — MIDI Clock Design (Send, Receive, and the Clock-Source Seam)

*Sending MIDI clock correctly (timestamped), receiving it as a phase-locked
tick source, and the scheduler abstraction both require. Follows
`griddle-prototype-0.1-design.md`; sibling to `griddle-smooth-cc-design.md`
and `griddle-midi-controllers-design.md`.*

Status: **designed (2026-07-08), not implemented.** Explicitly *out of scope
for 0.1*. Per user decision, clock-receive instrumentation (§6, phase 0) is
deferred to a future pass. The one item worth adopting early is the
clock-source seam (§4.1) — retrofitting a time source into a scheduler later
is the bolt-on failure mode this project keeps criticizing elsewhere
(`_steps`, input-only regions).

---

## 1. Motivation and prior experience

The user's experience syncing strudel → Ableton via MIDI clock has been
poor. Diagnosis from source (verified 2026-07-08): strudel emits each clock
pulse via `scheduleAtTime(() => device.sendClock(), targetTime)`
(`strudel/packages/midi/midi.mjs:439-443`) — a **JavaScript callback fires
at approximately the right time and sends without a WebMIDI timestamp**.
Every 0xF8 departs subject to event-loop jitter (several ms) on a message
whose spacing (20.83ms at 120 BPM, 24 PPQN) *is* the tempo signal. Receivers
compute instantaneous tempo from inter-pulse spacing, so send jitter reads
as tempo wobble; Ableton, already a nervous clock follower, amplifies it.
Strudel also generates clock *as a pattern* (`midicmd("clock")`, 48
haps/cycle), so pulse emission competes with pattern-query machinery.

Conclusion: the browser was never the culprit — the missing timestamp was.
Griddle can do strictly better in both directions.

## 2. The reframe: browser limits apply to *reacting*, not *measuring* or *scheduling*

Griddle never reacts to a clock pulse in real time; it lives on a lookahead
scheduler. WebMIDI is timestamped in both directions:

- **Receive**: `MIDIMessageEvent.timeStamp` is a `DOMHighResTimeStamp`
  (same domain as `performance.now()`) recording when the message arrived
  at the *system* — stamped at the driver layer, not when the JS event
  fires. Delivery may be late or batched under load; timestamps preserve
  the true pulse spacing regardless.
- **Send**: `MIDIOutput.send(data, timestamp)` — the OS does last-mile
  timing, exactly as griddle's note scheduling already relies on.

Therefore clock **receive is a signal-processing problem, not a latency
problem**: estimate tempo and phase from a timestamped pulse train, predict
future pulse times, and let the existing lookahead scheduler place ticks at
the predictions. That is a phase-locked loop (PLL) — a standard structure.

## 3. Structural facts that make griddle a good clock follower

1. **Tick-indexed semantics.** External clock changes tick *timing*, never
   tick *content*. The reproducibility invariant — same (grid, slots, tick
   count) → same events — is untouched; only wall-clock placement varies.
   In strudel, time is the semantic domain and sync touches meaning; in
   griddle, sync is quarantined in `clock.js`. The smooth-CC design
   composes automatically: F/G crossings are *fractions of the tick
   window*, so they stretch with a breathing tempo.
2. **Units align exactly.** MIDI clock = 24 PPQN; griddle = 4 ticks/beat;
   **1 tick = 6 pulses**, integer. Ticks should be **hard-locked to pulse
   count** (tick N fires at predicted pulse 6N), not free-running at an
   estimated tempo — phase-locked forever, zero drift accumulation.
3. **SPP is the tick number.** MIDI Song Position Pointer counts in
   sixteenths — literally the griddle tick index at 4 ticks/beat. Start
   (0xFA) → tick 0; Continue (0xFB) → resume at current position (honoring
   any prior SPP); Stop (0xFC) → transport stop.

## 4. Architecture

### 4.1 The clock-source seam (adopt early)

`Clock` currently advances via `nextTickTime += tickMs()`
(`griddle/src/clock.js`). Refactor to a source interface:

```
ClockSource {
  timeOfTick(n)  -> ms | null     // null = not yet predictable (following, no lock)
  running()      -> bool          // transport state (external stop/start)
  // implementations: InternalSource (BPM math, exactly today's behavior),
  //                  MidiClockSource (PLL prediction, §4.2)
}
```

The poll loop asks the source for upcoming tick times instead of computing
them. `InternalSource` reproduces current behavior bit-for-bit; this
refactor is safe to land ahead of any receive work and is the only part of
this design recommended for near-term adoption.

### 4.2 Receive: the PLL (`MidiClockSource`)

- **Input**: timestamped 0xF8 stream from a selected input port; transport
  bytes 0xFA/0xFB/0xFC; SPP (0xF2).
- **Estimator**: rolling window (~2 beats of pulses) with linear regression
  or EMA on (pulse index → timestamp) for period; phase from recent pulses.
  Filter constants tuned from measured jitter (§6), not guessed.
- **Prediction**: `timeOfTick(n) = predictedPulseTime(6n)`. Pulse-count
  lock per §3.2.
- **Correction discipline**: *slew, never jump.* Phase error absorbed over
  ~a beat is imperceptible; a jump is a flam. Tempo changes update the
  regression naturally.
- **Lookahead under following**: shorten horizon from 150ms to ~60–80ms so
  tempo changes invalidate less pre-scheduled future. Already-scheduled
  MIDI (notes, F/G crossings) is not recalled — small placement error on
  tempo change, corrected next window. Acceptable; note it.
- **Clock loss** (Ableton stops pulsing when its transport stops): timeout
  (~2 missed pulses expected interval ×4) → policy knob: **freeze**
  (transport stop) vs **freewheel** at last estimated tempo. Default
  freeze; freewheel is the jam-safety option. (§8.2)
- **Start alignment**: on 0xFA, reset machine to tick 0 (same as play);
  on SPP + 0xFB, set tick counter to SPP value and continue. This gives
  bar-locked restarts from the DAW for free.

### 4.3 Send: griddle as master

Near-free given the existing machinery: inside each lookahead window,
schedule 0xF8s at `timeOfTick`-derived pulse times (6 per tick) **with
explicit timestamps**, plus 0xFA/0xFC on transport, optional SPP on
play-from-position. This is the thing strudel's implementation skipped;
griddle-as-master should measurably outperform it. Config: per-output
enable ("send clock to device X"). Sending while *following* is legal
(clock thru/re-clocking) but off by default.

### 4.4 UI

Sidebar: clock mode selector (`internal` / `follow: <input port>`), BPM
field becomes read-only display when following (shows estimated tempo to
0.1), lock indicator (locked / acquiring / lost), and the send-clock
per-output toggles.

## 5. Platform fine print (recorded expectations)

- **Timestamp quality varies.** Chrome/macOS stamps from CoreMIDI (good).
  Windows historically coarser (WinMM legacy; newer Chrome uses better
  backends). Firefox: WebMIDI behind a flag. The spec mandates
  receipt-time stamps; implementations differ in fidelity. Hence §6.
- **Background tabs** throttle `setInterval` (~1Hz); with a 60–80ms
  horizon a hidden tab starves. Known escape hatch if screen-off
  performance matters: AudioWorklet clock host (option 2 in
  `CLAVIER-36/doc/interpreter-design.md`), which keeps running in
  background. Not v1.
- **Ableton-as-slave is wobbly regardless of master quality** — industry
  folklore, consistent with the user's experience. Set expectations:
  griddle→Ableton via MIDI clock will be *better* than strudel's, not
  perfect; Ableton→griddle (griddle following) is the more promising
  direction, since griddle's follower can be as disciplined as we like.

## 6. Phase 0 — measurement spike (deferred; do first when resumed)

Before tuning any filter: a diagnostic mode that subscribes to the clock
input and logs inter-pulse deltas from the user's actual interface with
Ableton as master. Report: mean period, jitter distribution (σ, p95, max),
batching evidence (identical timestamps), drift over 5 minutes. One
evening of work; determines PLL constants — or reveals the platform lies
before anything is built on it. **User decision 2026-07-08: this
instrumentation pass is deferred to a future session.**

## 7. Relation to the native-app question

MIDI clock does **not** force a native decision — receive is
browser-feasible per §2. What forces native (or a wrapper) is **Ableton
Link**: UDP multicast, structurally impossible in a browser, and the sync
that actually works well with Live. The endgame for tight Ableton sync is
an Electron/Tauri wrapper (Chromium ships WebMIDI — the codebase carries
over unchanged) plus a Link binding. MIDI clock receive remains worth
having regardless: hardware sequencers and drum machines are excellent
clock masters and natural griddle companions.

## 8. Open questions

1. **PLL constants** — window length, slew rate: from §6 measurements, not
   speculation.
2. **Clock-loss default** — freeze vs freewheel (working default: freeze).
3. **Fractional tick alignment** — when following, should the *first*
   tick after lock quantize to the next pulse-6 boundary or next beat?
   (Working: next beat, cleaner musically.)
4. **Does BPM input become a nudge control when following** (tempo offset
   ×/÷ for polytempo tricks), or strictly read-only? (Working: read-only;
   nudge is a fun future.)
5. **Send-while-following** default-off confirmed?
6. **Do ticks pause when external transport stops**, or does the grid
   keep evaluating silently (metronome frozen vs running)? (Working:
   full stop, matching internal transport semantics.)

## 9. Testing plan

`InternalSource` refactor: existing behavior byte-identical (tick times,
demo loop test unchanged). `MidiClockSource` is testable headlessly by
feeding synthetic timestamped pulse trains: constant tempo → lock within N
pulses, tick times within ε; tempo ramp → bounded phase error, no jumps
(assert max inter-tick delta change); jittered train (σ from §6) → output
tick jitter below input jitter (smoothing works); dropout → loss policy
fires; SPP/continue → tick counter alignment. Send side: scheduled pulse
timestamps arithmetic-exact against `timeOfTick`.

## 10. Source references

| What | Where |
|---|---|
| Strudel unstamped clock send (the diagnosis) | `strudel/packages/midi/midi.mjs:432-455` |
| Griddle scheduler to refactor | `griddle/src/clock.js` (POLL_MS 25, LOOKAHEAD_MS 150, TICKS_PER_BEAT 4) |
| Timestamped send path to reuse | `griddle/src/midi.js`, `griddle/src/main.js` (onTick) |
| AudioWorklet clock host option (background tabs) | `CLAVIER-36/doc/interpreter-design.md` §Option 2 |
| Orca's MIDI clock handling (prior art: tap, 6 pulses/beat) | `Orca/desktop/sources/scripts/clock.js:92-131`, `core/io/midi.js:92-143` |
| Tick-window fractions (why F/G compose with variable tempo) | `griddle-smooth-cc-design.md` §5 |
