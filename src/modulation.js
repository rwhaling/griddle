// Smooth-CC math for the F (LFO) and G (glide) operators — pure functions,
// per docs/griddle-smooth-cc-design.md (§3–§5, §9 resolutions of 2026-07-12).
//
// Internal domain: integer fixed-point 0..FULL (1295 × 64 sub-units).
// Grid face: internal >> 6, split into a base-36 coarse/fine pair.
// Wire face (phase 1, 7-bit only): cc = floor(v·127/FULL) — the trajectory's
// crossings of these 127 boundaries become timestamped CC messages.

export const FULL = 1295 * 64; // 82880

export const face1296 = (v) => Math.min(1295, v >> 6);
export const cc7 = (v) => Math.floor((v * 127) / FULL);

// §9.5 resolution: ×37 maps target 0 → 0 and z → FULL exactly (35·37·64 = FULL),
// so a max target reaches CC 127 — superseding the ×36 draft that topped out
// at CC 123.
export const targetInternal = (t) => t * 37 * 64;

// §9.1 (confirmed): quadratic rates. G traverses full scale in r² ticks;
// rate 0 = instant (a value-follower).
export const glideStep = (r) => (r === 0 ? FULL : Math.max(1, Math.round(FULL / (r * r))));

// F period = 4·r² ticks (r=1 → one beat at 4 ticks/beat); rate 0 → 36 per
// CLAVIER's map_zero convention (~11min period).
// PHASE is divisible by 36 so phase offsets are exact.
export const PHASE = 36 * (1 << 18); // 9437184
const HALF = PHASE / 2;

export const lfoInc = (r) => {
  const rr = r === 0 ? 36 : r;
  return Math.max(1, Math.round(PHASE / (4 * rr * rr)));
};

export const offsetPhase = (o) => o * (PHASE / 36);

// triangle: 0 at phase 0, FULL at half phase, back to 0
export const triAt = (p) => {
  p = ((p % PHASE) + PHASE) % PHASE;
  return p < HALF ? Math.round((p * FULL) / HALF) : Math.round(((PHASE - p) * FULL) / HALF);
};

// Split a phase sweep [p0, p0+inc) into linear pieces in value space.
// Minimum period is 4 ticks, so inc ≤ PHASE/4 < HALF and at most one
// triangle fold lands inside a single tick window — but the loop handles any.
export const lfoPieces = (p0, inc) => {
  const a = p0;
  const b = p0 + inc;
  const points = [a];
  for (let k = Math.floor(a / HALF) + 1; k * HALF < b; k++) points.push(k * HALF);
  points.push(b);
  const pieces = [];
  for (let i = 0; i + 1 < points.length; i++) {
    pieces.push({
      v0: triAt(points[i]),
      v1: triAt(points[i + 1]),
      f0: (points[i] - a) / inc,
      f1: (points[i + 1] - a) / inc,
    });
  }
  return pieces;
};

// lerp an internal-domain value into [lo, hi] (both internal-domain).
// lo > hi inverts the waveform; lo === hi is a constant. Linear-in-linear,
// so scaled pieces stay piecewise linear and the crossing math is unchanged.
export const scaleV = (v, lo, hi) => lo + Math.round(((hi - lo) * v) / FULL);

// 7-bit boundary crossings of a piecewise-linear trajectory, deduplicated
// against the last value sent. lastCC === null means nothing sent yet: the
// current value is announced once at the segment start.
// Returns { events: [{value7, frac}], lastCC }.
export const crossings = (pieces, lastCC) => {
  const events = [];
  let prev = lastCC;
  for (const { v0, v1, f0, f1 } of pieces) {
    if (prev === null) {
      prev = cc7(v0);
      events.push({ value7: prev, frac: f0 });
    }
    if (v1 === v0) continue;
    const c1 = cc7(v1);
    if (v1 > v0) {
      for (let L = prev + 1; L <= c1; L++) {
        const vL = Math.ceil((L * FULL) / 127); // smallest v with cc7(v) === L
        events.push({ value7: L, frac: f0 + ((vL - v0) / (v1 - v0)) * (f1 - f0) });
      }
      prev = Math.max(prev, c1);
    } else {
      for (let L = prev - 1; L >= c1; L--) {
        const vL = Math.ceil(((L + 1) * FULL) / 127) - 1; // largest v with cc7(v) === L
        events.push({ value7: L, frac: f0 + ((vL - v0) / (v1 - v0)) * (f1 - f0) });
      }
      prev = Math.min(prev, c1);
    }
  }
  return { events, lastCC: prev };
};
