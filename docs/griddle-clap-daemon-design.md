# Griddle — CLAP Daemon Design (Native Plugin Hosting via the Bridge Protocol)

*A minimal native audio engine for griddle: a standalone daemon hosting CLAP
plugins, driven from the unchanged browser app over the Ableton-bridge
protocol's topology. Eighth design doc; generalizes
`griddle-ableton-bridge-design.md` §3–4 (one socket, passive renderer) and
incorporates the poptart study (2026-07-30). Touches
`griddle-smooth-cc-design.md` (the resolution ladder gains its top rung) and
`griddle-midi-clock-design.md` §7 (the native-wrapper endgame).*

Status: **designed (2026-07-30), not implemented.** Requires the spike in §8
before building. Open questions in §9 are deliberately unresolved — ask
before deciding them in code. This doc exists to record the design while the
thinking is fresh; there is no implementation commitment or schedule.

---

## 1. Motivation

Soft synths without a DAW. Griddle's MIDI face reaches hardware and anything
a DAW hosts, but playing a VST/CLAP instrument today requires Ableton (7-bit
mapping ceiling, per the bridge doc §1) or a SuperCollider stack (poptart's
route: mature but an external `sclang`/`scsynth`/`VSTPlugin~` dependency
chain). A small native engine owned by griddle would:

1. **Host plugin instruments directly** — no DAW, no SuperCollider install.
2. **Lift the modulation ceiling past every wire format**: sample-accurate
   parameter events, above 7-bit CC (128), 14-bit (16,384), and even
   poptart's control-rate buses (~750 Hz).
3. **Extend the determinism invariant into audio**: (grid, mounts, tick) →
   identical sample-accurate event queues — which makes **offline
   bounce-to-disk** nearly free, something neither the MIDI route nor the
   SC route offers cleanly.
4. Keep the published browser app (`whaling.dev/griddle`) as the one
   codebase — the daemon is an optional peripheral, like a MIDI interface.

## 2. Topology: a second renderer of the bridge protocol

The load-bearing decision, inherited from the bridge doc: **griddle connects
out to passive renderers; nothing of griddle lives inside them.** The M4L hub
is renderer #1 (Live parameters via `line~`). The CLAP daemon is renderer #2
— same one-socket topology, richer vocabulary (§4):

```
browser app (unchanged, WebMIDI for hardware)
     │  ws://localhost:<port>   (lookahead-timestamped events)
     ▼
griddle-clap-daemon             (Rust or C++, no UI beyond plugin editors)
     ├─ CLAP host layer          (clack-host / clap-helpers)
     ├─ fixed-chain graph        (per track: 1 instrument + N fx → mixer)
     └─ audio device I/O         (cpal / RtAudio; RT thread + lock-free rings)
```

**Electron is explicitly not a prerequisite.** The browser stays the front
end; WS jitter is absorbed by the same ~150ms lookahead that already makes
MIDI timing work — the daemon receives events ahead of their deadlines and
renders them sample-accurately, which is *tighter* than WebMIDI through IAC.
An Electron/Tauri shell remains the separate endgame move if Ableton Link
ever matters (clock doc §7); this design neither needs nor precludes it.

Addressing follows the bridge convention: the daemon presents as entries in
the output-map device table (transport `clap`), so F/G/Z's existing ports
address it unchanged. Whether daemon parameters are addressed as 36 map
slots (bridge-style, one glyph) or by real CLAP parameter names declared in
the mount document (poptart-style) is open (§9.6) — the mount doc is the
natural home for the binding either way.

## 3. Why CLAP (and why CLAP-only)

- **License and ABI**: MIT headers, composes cleanly with griddle's AGPL; a
  stable-ABI guarantee across 1.x. No Steinberg agreement, no COM.
- **The event model is griddle-shaped.** `process()` consumes sample-accurate
  event queues: notes, `PARAM_VALUE`, and — decisively —
  **`CLAP_EVENT_PARAM_MOD`**: modulation as a first-class, *non-destructive*
  offset composed with the user's knob setting (Bitwig heritage). This is
  exactly F's semantics; neither MIDI CC nor `live.remote~` (exclusive
  control) can express it.
- **First-class transport events** per block (tempo, beat position) —
  griddle becomes the tempo authority and plugin-internal synced LFOs,
  delays, and arps follow the grid's clock.
- **State extension** (opaque blob save/load) → poptart-style
  pin-the-preset-into-the-patch; the blob rides in the patch JSON.
- **Per-note pitch and note expressions** — a microtonality door the MIDI
  face doesn't have. Recorded, not designed.
- **Reference material exists**: `clap-host` (official minimal host),
  `clap-helpers` (C++), `clack-host` (maintained safe-Rust host bindings
  over `clap-sys`).

**VST is out of scope, deliberately.** VST3 hosting is COM-shaped, much
heavier, and `clap-wrapper` goes the wrong direction (it presents CLAP
plugins *as* VST3s; it does not host VSTs). CLAP adoption (u-he, Surge,
Vital, TAL, the Serum 2 generation; clapdb.tech tracks it) makes CLAP-only
plausible — but §9.1's inventory check is the empirical gate.

## 4. Protocol v2: notes, segments, and definition handoff

Extends the bridge doc §4 vocabulary. Reused unchanged: `hello`, `slots`
(now: parameter binding table), `transport`, `seg` (per-tick linear
trajectory), `set` (discontinuity: snap/reset, one edge, no burst).

Added:

| msg | fields | when |
|---|---|---|
| `note` | track, key, velocity, channel, timestamp, durTicks | per note event, lookahead-timestamped |
| `def` | stream id, shape table (breakpoints), rate, phase-at-change | mount/rate/port change on an F stream (see below) |
| `anchor` | stream id, phase, timestamp | periodic re-pin + bang resets |
| `bounce` | span, destination | offline render request (future; §9.8) |

**Definition handoff, done with intact state — the poptart finding.** The
transmission ladder (crossings → segments → definitions) tops out at sending
the modulator's *definition* once and letting the renderer run it with zero
steady-state traffic. Poptart demonstrates both the economics and the trap:
its truth is a pure wall-clock formula, so a livecoded rate change is
phase-continuous natively (SC's `Sweep` accumulates) but gets snapped to the
formula by the next periodic anchor — the naive-LFO phase jump, deferred up
to 4s (`scheduler.mjs:37,528`; `poptart.scd:909,945`). The fix — rebasing the
definition's phase offset at each change — turns the offset into accumulated,
edit-history-dependent state: **definition handoff with continuity is a
stateful accumulator whose increments are computed receiver-side.** Griddle
already keeps the accumulator as the single truth (smooth-cc §2), so it gets
the top rung without the trap: every `def`/`anchor` carries phase *from F's
accumulator*, bang reset is a one-message `anchor`, and every F invariant
(phase survives rate changes, tick-count determinism) holds by construction.
The daemon-side phasor is a cache, never an authority; anchors keep it
honest against audio-clock skew (poptart's two-clock problem, same cure).

Shape tables are the mount system's existing breakpoint tables. Poptart's
per-segment curvature (`x,y,c` with SC curve semantics, `shape.mjs`) is
noted as a cheap future enrichment — exponential segments keep closed-form
crossings (smooth-cc §8.4), so the MIDI face could share it.

**Fallback discipline**: a renderer that lacks `def` support (the M4L hub,
v1) receives `seg` streams — the ladder degrades rung by rung, mirroring the
output-map format ladder of smooth-cc §6.2. No silent capability guessing:
`hello` declares what the renderer speaks.

## 5. Engine architecture and the three engineering tiers

What the CLAP SDK does *not* provide, sorted by risk:

- **Tier A — bounded, well-trodden**: audio device I/O (cpal/RtAudio/
  miniaudio); the fixed-topology graph — per track 1 instrument + N effects
  into a mixer, poptart-validated shape, hundreds of lines, no dynamic
  rewiring; block splitting and event-queue feeding; parameter discovery;
  state pinning.
- **Tier B — the real discipline**: the RT thread contract. Lock-free SPSC
  rings between control and audio threads; no allocation, locks, or
  syscalls on the audio callback; CLAP's own threading spec (main-thread vs
  audio-thread functions; `params.flush()` when not processing). This is
  where homebrew hosts are subtly wrong; `clack-host` + the reference host
  remove most unknowns. Language choice (§9.3): Rust/clack vs
  C++/clap-helpers.
- **Tier C — the long tail**: plugin-quirk compatibility. `VSTPlugin~`
  embodies years of workarounds; a fresh host rediscovers them one plugin at
  a time (probe crashes → out-of-process scanner; editor main-thread
  dances; lying state blobs). CLAP-only shrinks the tail; nothing zeroes
  it. This cost is *ongoing*, not up-front — the honest reason poptart's SC
  route is cheaper than it looks.

GUI: plugin editors in **floating native windows** owned by the daemon,
macOS-first (§9.7). Embedding editors inside the browser/Electron chrome is
explicitly not v1.

Scanning: out-of-process probe per plugin with timeout (poptart's pattern),
results cached; `POPTART_VST_DIRS`-style curation via a symlink folder.

## 6. Scope estimate (recorded expectation)

Minimal viable daemon — macOS, CLAP-only, fixed chains, floating editors,
state pinning, `note`/`seg`/`set` first, `def`/`anchor` second: a
**weeks-of-focused-work project** given clack/cpal, not days, not a year.
Tier C then trickles indefinitely. The protocol layer is shared with the M4L
hub and testable headlessly on day one.

## 7. Alternatives considered

1. **Electron-first, engine in-process.** Rejected as a *prerequisite*:
   forks the codebase's deployment story, couples engine lifetime to a
   browser shell, and buys nothing the daemon topology lacks. Remains
   available later as a shell *around* both.
2. **Borrowed engine: SuperCollider + `VSTPlugin~`** (poptart's route —
   its `packages/osc-engine` is AGPL like griddle and deliberately
   engine-agnostic). Cheapest path to plugins-under-griddle; proven; VST3
   support included. Cost: the external dependency chain and control-rate
   modulation ceiling. **Viable stepping stone**: drive it with the §4
   protocol first, swap in the daemon later — sequencing is §9.2's call.
3. **JUCE AudioPluginHost as a base.** GPL-compatible and multi-format, but
   a far larger dependency for a "minimal" engine, and its hosting model
   pulls toward VST3's weight. Not pursued.

## 8. Phase 0 — verification spike (do first)

1. **Plugin inventory**: which of the user's actual instruments ship CLAP
   today? (Decides §9.1 empirically — check clapdb.tech and local
   binaries.)
2. **clack-host maturity**: load 2–3 real CLAP plugins headlessly (load →
   params → activate → process a test queue); confirm the host-side
   extension set required in practice.
3. **cpal RT behavior** on the user's interface (callback stability, buffer
   sizes, device switching).
4. **WS timing measurement**: timestamped-event jitter browser→daemon under
   load, alongside the clock doc §6 spike methodology; confirms the
   lookahead absorbs it.
5. **Editor windows**: open a CLAP GUI in a daemon-owned NSWindow; confirm
   lifecycle (close/reopen, state dirty marks).
6. **Stepping-stone evaluation**: how far poptart's `osc-engine` command
   set is from the §4 protocol — an afternoon's reading, informs §9.2.

## 9. Open questions (deferred — ask before deciding)

1. **CLAP-only acceptable?** Gated on the §8.1 inventory. If a load-bearing
   instrument is VST3-only, the answer shapes everything.
2. **Sequencing**: SC stepping stone first (protocol proven against a
   borrowed engine) vs straight to the daemon?
3. **Language**: Rust (clack, cpal, RT safety) vs C++ (clap-helpers,
   reference-host proximity)?
4. **Sampler scope**: host a CLAP sampler plugin and keep griddle's hands
   clean, or is sampling out of scope entirely? (SC gave poptart a sampler
   for free; the daemon gets none.)
5. **Note routing**: all notes through the device table (hardware via
   WebMIDI, plugins via daemon) — confirm the device-table-as-router story
   covers it without new grid syntax.
6. **Parameter addressing**: 36 bridge-style map slots per pseudo-device
   (one glyph, consistent with §3.1 of the bridge doc) vs real CLAP
   parameter names bound in the mount document (poptart-style legibility)?
   Both fit the mount doc; taste call.
7. **Platform scope**: macOS-first confirmed? (Daemon code is portable;
   editor-window and device layers are per-OS.)
8. **Bounce priority**: is offline render a v1 payoff worth designing for,
   or a recorded future?
9. **Anchor cadence**: fixed interval (poptart's 4s) vs on-drift-threshold;
   measure in the spike before choosing.

## 10. Testing plan

Protocol layer: headless round-trip against a mock renderer (message
ordering, capability fallback `def`→`seg`, reconnect → re-`hello` →
rebind). Engine: drive `process()` with deterministic event queues against
the official `clap-plugins` examples and assert output buffer hashes
(determinism extends to audio — the invariant made testable); RT-path
allocation asserts in debug builds; scanner probe isolation (a
deliberately-crashing stub plugin). End-to-end (manual): latency/jitter
against hardware MIDI A/B; editor lifecycle; state pin round-trip through a
patch file.

## 11. Source references

| What | Where |
|---|---|
| CLAP spec (headers, MIT, stable ABI) | `github.com/free-audio/clap` |
| Official minimal host / examples | `github.com/free-audio/clap-host`, `clap-plugins` |
| Rust host bindings (maintained) | `github.com/prokopyl/clack` (`clack-host`), over `clap-sys` |
| Bridge topology + protocol this extends | `griddle-ableton-bridge-design.md` §3–4 |
| Resolution ladder gaining its top rung | `griddle-smooth-cc-design.md` §6.1 |
| Segments contract (`seg`/`set` reuse) | `griddle-smooth-cc-design.md` §3, §5 |
| Native-wrapper endgame this defers | `griddle-midi-clock-design.md` §7 |
| poptart two-tier modulation + anchor (the study) | `poptart/packages/pattern-core/src/scheduler.mjs:18-37,515-546`, `signal.mjs:1590-1700` |
| poptart native LFOs + phase-preserving `set` | `poptart/packages/osc-engine/sc/poptart.scd:478-503,880-947` |
| poptart shape format (curvature, verticals) | `poptart/packages/pattern-core/src/shape.mjs` |
| poptart engine-agnostic OSC layer (stepping stone) | `poptart/packages/osc-engine/index.js` |
| Native audio-thread precedent in the lineage | `CLAVIER-36/src/ring.c` (audio-thread interpreter stepping) |
