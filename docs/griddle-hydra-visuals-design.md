# Griddle — Hydra Visuals Design (Shaders on the Grid Panel)

*Livecoded visuals over the grid: hydra-synth as a post-processing layer
that consumes the rendered grid canvas as a source texture, edited in a
third pane tab under the mount-doc eval contract, with machine state bound
into shader parameters as per-frame closures. Tenth design doc; reuses the
mount system's editor/eval patterns (docs six/seven) and strudel's own
`@strudel/hydra` integration as the proven precedent.*

Status: **IMPLEMENTED 2026-07-31** (129 tests). `src/visuals.js` (lazy
hydra glue, curated scope, keep-last-good with restore-on-error,
accessors), `lfoValue01` in `mounts.js` (the pure gval read),
`code | visuals | ref` tabs + `fx` bypass button in the pane, visuals
source in patch JSON (absent-key preserves), tick + opacity toggle in the
frame loop. §8 spike findings: hydra-synth@1.4.0 bundles under vite with
one fix — `define: { global: 'globalThis' }` (raf-loop references Node's
`global`); it stays an npm dependency, no vendoring needed (its published
dist is fine, unlike strudel's was); it code-splits into a lazy chunk that
loads on first non-empty eval. Working answers adopted from §9: visuals
tab (not statement), interpolated `beat()`, commented starter gallery as
the default buffer, `gcell()` shipped in v1, onsets() NOT shipped
(deferred). Untested headlessly by nature: the GPU path itself — first
manual pass is the user's.

---

## 1. Motivation

Griddle is performed on a projector as often as through headphones; the
grid is the instrument's face. A programmable visual layer — trails,
feedback, warps, color — turns the same performance into AV, and if the
modulation sources that shift the *sound* also shift the *image*, the two
stay phase-locked for free. The requirement stated by the user: the shader
gets the existing rendered UI as an input texture, with a separate pane
for editing shader code.

## 2. Architecture: post-processing the grid canvas

The grid already renders to a DPR-scaled 2D canvas in a rAF loop
(`ui.js:80-91`, `main.js:452`). The visual layer is the textbook
post-processing pattern:

1. **`GridUI` keeps drawing exactly as today** — zero renderer rewrite.
   Its 2D canvas becomes the *source*.
2. A **hydra canvas** takes the grid panel's visual position. Each frame,
   hydra samples the source canvas as `s0` and renders the user's chain.
3. **Interactivity is preserved by stacking, not hiding**: the 2D canvas
   stays in the DOM at `opacity: 0`, absolutely positioned *over* the
   hydra canvas — it keeps receiving mouse/keyboard exactly as today
   (hit-testing survives zero opacity; `display: none` would not), while
   the hydra output shows through from beneath. No event forwarding, no
   `ui.js` changes.
4. **No visuals mounted → no hydra**: the 2D canvas is simply visible, as
   now. The layer is pay-for-what-you-use.

The strudel precedent (`strudel/packages/hydra/hydra.mjs`, `feedStrudel`
option) is this exact shape in production: hide the draw canvas,
`hydra.synth.s0.init({ src: canvas })`, hydra canvas in its place.

### 2.1 Whole-UI capture: rejected (recorded)

DOM (CodeMirror, toolbar) is not capturable as a live texture. The only
real route — `getDisplayMedia({ preferCurrentTab })` + Region/Element
Capture, shader on an overlay excluded from capture — costs a screen-share
permission prompt every session, 1–2 frames of latency, and DPR quirks: a
stunt, not a foundation. CSS/SVG filters on the app container (`filter:
url(#…)`) remain available for modest whole-UI treatments (displacement,
color matrices, turbulence) without capture — noted, not designed. The
grid is griddle's visual identity; crisp chrome around a melting grid
reads *better* than everything smearing.

## 3. Why hydra (and not bespoke GLSL)

hydra-synth (AGPL-3.0 — license-identical to griddle; `hydra-synth@^1.3.x`
on npm; regl-based WebGL) collapses most of the bespoke work:

- **Engine**: constructor takes our canvas; `autoLoop: false` +
  `hydra.tick(dt)` slots into the existing rAF loop; `detectAudio: false`
  avoids the mic prompt; `makeGlobal: false` keeps its vocabulary out of
  the global namespace (mandatory — hydra globals like `src`/`speed`/
  `shape` collide with strudel controls; strudel's `clearHydra` literally
  has to restore `globalThis.speed` afterward).
- **Feedback built in**: `o0`–`o3` buffers, `src(o0)` loops — the trails/
  decay machinery that makes livecoded visuals sing, free.
- **Language fit**: hydra is chained JS, not raw GLSL — so the visuals
  pane is another mount-doc-shaped editor (CM6, ⌘↵, curated scope,
  keep-last-good), and chains fail gracefully and read at a glance
  mid-performance.
- **Culture fit**: strudel + hydra is the canonical algorave AV pairing;
  griddle joining that lineage is on-brand, and hydra's documentation/
  community corpus transfers to griddle users directly.

**Bespoke raw-GLSL alternative (recorded, not pursued)**: a ~200-line
WebGL2 wrapper (quad + compile-with-error-gutter + canvas texture +
ping-pong) with shadertoy uniform conventions would allow pasting the
shadertoy corpus. Deliberately not v1: two shader systems is one too many,
and hydra's `setFunction()` registers custom GLSL chunks when chains run
out — a real escape hatch inside the chosen system.

## 4. The visuals pane and eval contract

Third tab in the right pane: **`code | ref | visuals`**. A CM6 editor
whose ⌘↵ evaluates the buffer as JS against a curated hydra scope
(`makeGlobal: false` → we inject `osc`, `src`, `noise`, `shape`, `s0`,
`o0`…, exactly like the mount scope injects strudel names). The mount
doc's contract transfers whole: green eval flash, amber dirty indicator,
error → keep-last-good with the message surfaced. `hush()` on stop-visuals;
a **bypass toggle** in the toolbar (and auto-bypass while the last eval is
broken) so the grid is always recoverable mid-performance — when the
shader melts the grid, you can still see to edit.

First eval lazily creates the hydra instance (dynamic import, code-split
chunk — the synth-device precedent in `synthout.js`); no visuals evaluated
means no hydra loaded.

## 5. Musical binding: closures, not uniforms

Hydra parameters accept **functions evaluated per frame** — no uniform
plumbing needed. The scope provides small pure accessors over machine
state:

```js
src(s0)
  .modulate(osc(3, 0.1), () => gval('@u') * 0.2)   // the same LFO that
  .blend(o0, () => 0.6 + beat() * 0.3)             // shifts the audio
  .out()                                            // texture shifts the image
```

Proposed accessor surface (v1, deliberately small):

| accessor | value |
|---|---|
| `tick()` | `machine.metronome` |
| `beat()` | beat phase 0..1 (metronome / 4, fractional via rAF interpolation — §9.3) |
| `bar()` | bar phase 0..1 |
| `gval('@u')` | an @-mount LFO's current value 0..1 (evaluated from its table + phase at read time) |
| `gcell(x, y)` | a grid cell's literal value 0..35, else 0 — the grid as a control surface for visuals |

This is strudel's `H(pattern)` idiom (hydra.mjs:51) with griddle's state
instead of pattern queries. All accessors are read-only and pure — the
visuals layer observes the machine, never writes it; the determinism
invariant is untouched (visuals are a view, like the screen).

## 6. Performance and timing

The scheduler is structurally immune: audio/MIDI timing lives in the
`setInterval` lookahead poll (150ms horizon), not the rAF loop — MIDI and
superdough events are scheduled ahead with timestamps. Consequences,
from the design discussion:

- Frame cost (texture from canvas + hydra chains) is trivial at grid-panel
  sizes on integrated GPUs; even dropping to 30fps visually leaves the
  music locked. A pathological chain pegs the GPU and chugs the *picture*,
  not the sound.
- The one main-thread hot spot is **shader compilation on eval**
  (synchronous, 10–100ms, driver-dependent) — the same hitch class as a
  mount-doc eval, inside a user gesture, absorbed by the ~100ms of
  lookahead slack. Acceptable; note it in the pane docs.
- Background tab: rAF pauses and visuals freeze, but the clock already
  throttles when hidden (clock doc §5) — no new failure mode.
- Honest costs: laptop battery/heat at gigs; regl's WebGL context is one
  more GPU consumer alongside nothing else (the app is otherwise 2D).

## 7. Serialization

The visuals source rides in the patch JSON as a line array (`visuals:
[...]`), exactly like `mount` — absent key preserves the current buffer on
load (the `state.mount === undefined` convention). The default is an
empty/commented buffer, **visuals off** — unlike the synth defaults, a
projector aesthetic is not a cold-start need, and an empty buffer keeps
the published page's first impression being the grid itself (§9.5).

## 8. Phase 0 — spike (do first)

1. **Bundling**: hydra-synth under vite — try `define: { global:
   'globalThis' }`; if it resists, vendor it like strudel (it is AGPL and
   source-vendorable). Strudel dodges via a runtime unpkg import
   (`hydra.mjs:18` `@vite-ignore`), unacceptable for the self-contained
   deployed site. ~20 minutes to a verdict.
2. **Canvas source fidelity**: `s0.init({ src })` against our DPR-scaled
   canvas — confirm resolution, `pixelRatio`/`pixelated` options, resize
   behavior (re-init `s0` on `resizeCanvas`).
3. **Tick integration**: `autoLoop: false`, `hydra.tick(dt)` from
   `frame()` — confirm clean coexistence + `hush()` teardown.
4. **Perf sanity**: a feedback chain at full panel size on the lowest-end
   target (Intel Mac?) while the synth demo plays; watch the status-line
   tick counter for scheduler stress.

## 9. Open questions (deferred — ask before deciding)

1. **Pane vs statement**: a dedicated `visuals` tab (working, §4) vs a
   `visuals(...)` statement inside the mount doc. The tab keeps eval
   domains separate (JS-with-hydra-scope vs JS-with-strudel-scope — a
   shared buffer would need scope merging and worsens error blast
   radius); the statement keeps one document per patch. Working: tab.
2. **Accessor surface** (§5): is `gcell()` in v1? Recent-onsets array
   (`onsets()` → last N {note, channel, age}) — v1 or later?
3. **`beat()` smoothness**: tick-quantized (honest, steppy) vs
   rAF-interpolated against the clock's tick times (smooth, slightly
   speculative). Working: interpolated — visuals want continuity.
4. **Grid-face readability guard**: minimum legibility affordance —
   bypass toggle only (working), or also a "solo grid" hold-key?
5. **Default buffer contents**: empty vs a commented gallery of 3–4
   starter chains (a defaults-as-code echo). Working: commented gallery —
   teaching surface, zero cost.
6. **hydra version pinning + vendoring policy** — same question shape as
   superdough's; decide in the spike.

## 10. Testing plan

Headless surface is thin by nature (the layer is GPU + DOM); test what is
pure: accessor functions (`gval` table evaluation against known mounts,
`beat()`/`bar()` arithmetic at fixed metronome values), visuals-source
serialization round-trip (present/absent-key semantics mirroring mount's
tests), scope construction (curated names present, no globals leaked —
assert `globalThis.osc === undefined` after init with `makeGlobal:
false`). Manual: the §8 spike checklist, plus eval-error → keep-last-good
→ bypass behavior, and a long-session soak (context loss handling —
`webglcontextlost` → re-init, recorded as an implementation requirement).

## 11. Source references

| What | Where |
|---|---|
| strudel's hydra integration (the precedent: `feedStrudel`, `H()`) | `strudel/packages/hydra/hydra.mjs` (esp. :30-37, :51), `package.json` (`hydra-synth: ^1.3.29`) |
| hydra-synth standalone API (canvas, autoLoop/tick, makeGlobal, detectAudio, setFunction) | `github.com/hydra-synth/hydra-synth` README (AGPL-3.0) |
| grid render loop + DPR canvas this layers over | `griddle/src/ui.js:80-91`, `griddle/src/main.js:452` |
| lazy code-split engine precedent | `griddle/src/synthout.js` (superdough dynamic import) |
| eval contract to reuse (flash/dirty/keep-last-good) | `griddle/src/main.js` (`evalMountSource`), docs six/seven |
| scheduler immunity argument (lookahead vs rAF) | `griddle/src/clock.js`, `griddle-smooth-cc-design.md` §5 |
| whole-UI capture APIs (rejected route, for the record) | Region Capture / Element Capture, `getDisplayMedia` (external) |
