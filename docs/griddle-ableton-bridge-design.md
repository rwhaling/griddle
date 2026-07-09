# Griddle — Ableton Bridge Design (Hub Device, Segments-not-Samples)

*High-resolution modulation into Ableton Live via a single Max for Live hub
device: one WebSocket, 36 map slots, `line~`/`live.remote~` rendering of
F/G's analytic segments. Fifth design doc; builds on
`griddle-smooth-cc-design.md` (esp. §5 segments and §6.2 output map) and
touches `griddle-midi-clock-design.md` (§7) and
`griddle-midi-controllers-design.md` (legibility principle).*

Status: **designed (2026-07-08), not implemented.** Requires the spike in §8
before building — several load-bearing facts are high-confidence but
unverified in current Live versions. Open questions in §9. User constraints
driving this design: owns Suite + M4L; wants griddle hosted **externally**
(browser app, nothing of griddle living inside Ableton); was stuck on how
one griddle instance connects to *multiple* M4L devices — resolved in §3 by
needing only one.

---

## 1. Why MIDI is not the high-res door into Live

The reordering fact: **Ableton's built-in MIDI mapping is 7-bit, full
stop.** Live does not accept 14-bit CC in its mapping layer (Push works
around this by being a control-surface *script*, not a MIDI map), and pitch
bend is 14-bit but only means note pitch on a MIDI track — not mappable to
parameters. So the smooth-CC doc's §6 (14-bit CC / bend) remains exactly
right for **VCV Rack and 14-bit hardware**, but for Live every MIDI-mapped
parameter steps at 128 levels. The Live API routes are not a luxury for
this target; they are the only high-resolution door.

Routes compared:

| route | resolution | timing | requires | verdict |
|---|---|---|---|---|
| native MIDI map | 7-bit | driver-timed in, control-thread applied | nothing | zipper baseline |
| AbletonOSC (remote script, LOM over OSC/UDP) | float | control-thread, no lookahead, jittery | script install; any Live edition | no-Suite fallback: full resolution, stepwise delivery |
| **M4L hub + `live.remote~`** | float, ramped at audio rate (~per 64-sample vector) | best available | Suite/M4L + bespoke device | **the design below** |

`live.remote~` takes *exclusive* control of a parameter while active
(greyed out in Live's UI) — which is the **absence** of the classic
MIDI-map-vs-automation fight, not a limitation. It is what the stock LFO
device uses; functionally, CV inside Ableton.

## 2. The architectural insight: send trajectories, not samples

The entire smooth-CC design rests on F/G knowing their per-tick trajectories
**analytically** — each tick is a linear segment. MIDI forces rendering that
segment into boundary-crossing messages, and §6.3's budget machinery exists
to manage the volume. But a segment is three numbers — `(slot, target,
rampMs)` — and Max's `line~` consumes exactly that, rendering the ramp *at
the receiver, at audio rate, in float*. The economics invert:

- **Message rate collapses**: one message per active stream per tick
  (~8/s at 120 BPM) instead of up to 250/s of crossings. A 20-minute glide
  costs the same as a 1-second sweep.
- **Resolution becomes effectively continuous**: interpolated in the audio
  engine — finer than the 82,944-level internal state, finer than any wire
  format. The three-resolution ladder (smooth-CC §6.1) gains a rung above
  the top.
- **No new design work in the machine**: the §5 machine/host contract
  computes segments *before* it computes crossings; a `live` transport
  consumes them one pipeline stage earlier. F and G never learn this exists.

Arrival jitter over localhost WebSocket (a few ms) smears segment
*boundaries*, inaudible for modulation; notes stay on the timestamped
WebMIDI path, so rhythmic timing has no new dependency.

## 3. Topology: one hub device, 36 slots, one socket

The stuck point ("one griddle ↔ many M4L devices?") dissolves on one fact:
**the Live Object Model is global.** A `live.remote~` in any device can
control any automatable parameter anywhere in the set — any track, device,
macro, send (the stock LFO maps cross-track this way). Therefore:

**One `griddle-bridge` M4L device** (on any track), containing:

- **One WebSocket server** — `node.script` (Node for Max) runs a real Node
  process per device; hosting a `ws` server inside an M4L device is
  established practice. Fixed port (default 9000).
- **36 mapping slots**, each = Map button + `line~` + `live.remote~`.
  Mapping gesture (Multimap-family pattern): touch any knob anywhere in the
  set, click Map on slot *k*, bound. Mappings persist with the set, stored
  as **LOM paths, not raw ids** (ids are not stable across set edits).

Griddle connects *out* to `ws://localhost:9000` — forced anyway (browsers
cannot host servers) and desirable: **nothing of griddle lives inside
Ableton**. The hub is passive infrastructure, like an audio driver. Multiple
griddle clients may connect (last-write-wins per slot); reconnect logic on
both ends.

### 3.1 Addressing: the base-36 fit

**36 slots is one glyph.** The bridge presents as one entry in the output
map's device table (smooth-CC §6.2 gains transport `live`), and F/G's
*existing* ports address it unchanged: device port → the bridge; controller
port (0–z) → slot. The channel port is spare (future: 16 banks × 36 = 576
params). The grid never learns slot `7` is a `line~` ramp rather than a CC
number. Outgrowing 36 targets = a second hub on port 9001 = "device 2" —
scale by adding pseudo-devices, never by rearchitecting.

## 4. Protocol (v0 sketch)

Transport: WebSocket, JSON messages (binary later if ever needed — rates
are trivial).

**Griddle → hub:**

| msg | fields | when |
|---|---|---|
| `seg` | `slot, target (float 0–1), rampMs` | per active stream per tick |
| `set` | `slot, value (float 0–1)` | snaps / resets / bang discontinuities (one edge, no burst — smooth-CC §3) |
| `hello` | protocol version | connect |

**Hub → griddle:**

| msg | fields | when |
|---|---|---|
| `slots` | per-slot: mapped? param name, device name, track name, path | connect + on any remap |
| `transport` | playing, tempo, beatPosition | on change + periodic |
| `pong` / errors | — | as needed |

The `slots` message is the underrated payoff: griddle's sidebar can display
"slot 7 → Operator | Filter Freq" — the controllers doc's
which-knob-is-what legibility principle extended across the wall into Live.
The `transport` message feeds the clock doc's PLL as an alternative pulse
source (jittery, control-thread-sourced, but smoothable) — possibly making
Live↔griddle sync workable without the native-app/Link endgame
(clock doc §7).

Normalization: `live.remote~` targets take 0–1 normalized values (per-param
ranges handled by Live); griddle sends its internal state normalized. The
hub applies nothing but `line~` — no curves hub-side; curves remain
griddle's (F/G's) business.

## 5. Deployment fine print

- **Same machine** (griddle at an HTTPS URL or localhost; Live local):
  works — Chrome exempts `ws://localhost` / loopback from mixed-content
  blocking, so a secure page may open an insecure socket to 127.0.0.1.
- **Different machines**: `ws://` to a non-loopback host from an HTTPS page
  *is* blocked. Options: serve griddle over plain HTTP on the LAN; give the
  hub a self-signed `wss://` (certificate pain); or run the browser on the
  Live machine. Architecture unchanged in all cases; decide per gig.
- Port collisions / multiple sets: hub UI shows port + connection status;
  second hub instance auto-offsets (9001, ...).

## 6. What stays MIDI

Everything except parameter modulation into Live. Notes → WebMIDI as today
(timestamped, latency-critical). VCV and hardware modulation → smooth-CC §6
formats. The output map is now the single routing authority:

```
target-by-target:
  Ableton parameters  → live (hub, segments, CV-grade)
  VCV Rack            → cc14 / bend (crossings)
  hardware synths     → cc7 / cc14 / nrpn-future (crossings)
```

All behind one map; all fed by the same F/G operators.

## 7. Future echoes (recorded, not designed)

- **LOM → grid input**: parameter values flowing back into grid regions —
  Live devices as *input* surfaces (controllers-doc regions with a `live`
  profile). Bidirectionality would need care (feedback via the same slot);
  the diff/idempotence quench argument applies.
- **Clock follow via bridge**: promote `transport` messages to a first-class
  `ClockSource` implementation (clock doc §4.1 seam) after the jitter spike.
- **Hub-side shapes**: `curve~` instead of `line~` for exponential segments
  if/when F/G grow curves (smooth-CC §8.4) — keep hub dumb until then.

## 8. Phase 0 — verification spike (do first)

High-confidence but unverified claims to check against current Live/Max
versions before building:

1. `node.script` may host a long-lived WebSocket server; behavior across
   Live lifecycle (set load/save, device duplication, edit-mode reopen).
2. `live.remote~` update granularity (believed ~per signal vector) and
   per-instance cost at 36 instances.
3. Selected/last-touched-parameter mapping gesture reliability (the
   Multimap pattern) in current Live.
4. LOM-path persistence across set edits (track/device reordering).
5. Chrome loopback mixed-content exemption still holds for `ws://localhost`
   from HTTPS origins.
6. **ableton-js** (M4L + Node bridging LOM to external JS — the same
   connectivity shape): evaluate for reuse. Reservation: believed to drive
   parameters via `live.object` control-thread messages, not `live.remote~`
   signals — fine for sets, not silky ramps. Likely: borrow connectivity
   patterns, own the slot/`line~`/`live.remote~` audio path.
7. AbletonOSC compatibility with current Live (the no-Suite fallback).

## 9. Open questions

1. **Fallback tier**: ship AbletonOSC support as a lower-smoothness
   alternative alongside the hub, or hub-only? (Working: hub-only first;
   OSC fallback only if a real no-Suite user appears.)
2. **Slot count**: 36 fixed (one glyph) vs configurable? (Working: 36.)
3. **Ramp timing source**: `rampMs` from griddle's tick duration at send
   time — should the hub instead sync ramps to Live's own transport?
   (Working: griddle-timed; revisit with clock-follow.)
4. **Bank via channel port**: reserve now or leave undefined? (Working:
   undefined; document the reservation.)
5. **Protocol transport**: JSON adequate at these rates; msgpack/binary
   only if profiling ever says otherwise.
6. **Hub distribution**: .amxd in the griddle repo? Separate repo? (Ties
   into the publish-to-github plan.)

## 10. Testing plan

Hub-side logic that is pure (slot table, path persistence, message
routing) tests in Node outside Live. Griddle-side: output-map dispatch to
`live` transport emits segments not crossings (unit); segment stream
correctness (target/rampMs per tick under rate changes, snap → `set` not
burst); reconnect behavior (drop socket mid-glide → re-handshake →
`slots` re-sync). End-to-end smoke (manual): map slot → glide → observe
Live param ramp smoothly; automation-lock behavior; set save/reload
restores mappings.

## 11. Source references

| What | Where |
|---|---|
| F/G segments + output map this plugs into | `griddle-smooth-cc-design.md` §3, §5, §6.2 |
| Message budget the hub route sidesteps | `griddle-smooth-cc-design.md` §6.3 |
| Clock PLL the `transport` msg could feed | `griddle-midi-clock-design.md` §4.2, §7 |
| Legibility principle (slot names in sidebar) | `griddle-midi-controllers-design.md` §1 |
| ableton-js (prior art, connectivity shape) | `github.com/leolabs/ableton-js` — evaluate in spike |
| AbletonOSC (fallback route) | `github.com/ideoforms/AbletonOSC` |
| Multimap-family devices (map-button UX pattern) | maxforlive.com — various; pattern, not dependency |
| Live Object Model / `live.remote~` / Node for Max | Cycling '74 M4L docs (external) |
