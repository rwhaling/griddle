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

// ---------------------------------------------------------------------------
// Mount-driven LFO trajectories (docs six/seven): shapes are per-cycle
// piecewise-linear breakpoint tables [[phase, value01], ...] compiled at
// mount time (src/mounts.js). The runtime walks them with a float phase
// accumulator; all pieces below are in the 0..1 value domain and get scaled
// into the internal domain by the F operator via a resolved CC range.
// ---------------------------------------------------------------------------

// piecewise-linear phase remap moving the table's midpoint to `skew` (0..1);
// skew 0.5 = identity. Order-preserving, so tables stay valid breakpoints.
export function warpTable(table, skew) {
  const s = Math.max(0.02, Math.min(0.98, skew));
  const warp = (p) => (p <= 0.5 ? p * (s / 0.5) : s + (p - 0.5) * ((1 - s) / 0.5));
  return table.map(([p, v]) => [warp(p), v]);
}

const EPS = 1e-9;

// value of the table at wrapped phase; at duplicated phases (step edges),
// 'left' takes the first entry (approaching from below), 'right' the last
export function tableValue(table, absPhase, side = 'right') {
  let p = ((absPhase % 1) + 1) % 1;
  if (side === 'left' && p < EPS) p = 1; // approaching a cycle boundary from below
  const matches = [];
  for (let i = 0; i < table.length; i++) {
    if (Math.abs(table[i][0] - p) < EPS) matches.push(i);
  }
  if (matches.length) {
    return side === 'left' ? table[matches[0]][1] : table[matches[matches.length - 1]][1];
  }
  for (let i = 0; i + 1 < table.length; i++) {
    const [p0, v0] = table[i];
    const [p1, v1] = table[i + 1];
    if (p > p0 && p < p1) return v0 + ((v1 - v0) * (p - p0)) / (p1 - p0);
  }
  return table[table.length - 1][1];
}

// split an absolute phase sweep [a, a+inc) into linear pieces by walking the
// table's breakpoints (including vertical step edges) across cycle boundaries
export function tablePieces(table, a, inc) {
  const b = a + inc;
  const frac = (p) => (p - a) / inc;
  const cuts = [];
  for (let cyc = Math.floor(a); cyc <= Math.floor(b) + 1; cyc++) {
    for (const [tp] of table) {
      const abs = cyc + tp;
      if (abs > a + EPS && abs < b - EPS) cuts.push(abs);
    }
  }
  cuts.sort((x, y) => x - y);
  const uniq = cuts.filter((c, i) => i === 0 || c - cuts[i - 1] > EPS);
  const points = [a, ...uniq, b];
  const pieces = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (p1 - p0 > EPS) {
      pieces.push({
        v0: tableValue(table, p0, 'right'),
        v1: tableValue(table, p1, 'left'),
        f0: frac(p0),
        f1: frac(p1),
      });
    }
    // vertical edge at an interior cut (step shapes): zero-width piece
    if (i + 1 < points.length - 1) {
      const lv = tableValue(table, p1, 'left');
      const rv = tableValue(table, p1, 'right');
      if (Math.abs(lv - rv) > EPS) {
        pieces.push({ v0: lv, v1: rv, f0: frac(p1), f1: frac(p1) });
      }
    }
  }
  return pieces;
}

// deterministic hash -> [0, 1): the noise shape's value source (Tidal-style
// index hashing — no PRNG state, reproducible per session)
export function intHash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = (x ^ (x >>> 15)) >>> 0;
  return x / 4294967296;
}

export const NOISE_STEPS = 16; // noise values per cycle

// procedural noise pieces over [a, a+inc): sample-and-hold steps at
// NOISE_STEPS per cycle; smooth in [0,1] ramps the tail of each step toward
// the next value (0 = hard steps, 1 = fully interpolated)
export function noisePieces(a, inc, smooth) {
  const b = a + inc;
  const stepDur = 1 / NOISE_STEPS;
  const s = Math.max(0, Math.min(1, smooth));
  const pieces = [];
  const frac = (p) => (p - a) / inc;
  let n = Math.floor(a / stepDur);
  while (n * stepDur < b) {
    const t0 = n * stepDur;
    const t1 = t0 + stepDur;
    const v0 = intHash(n);
    const v1 = intHash(n + 1);
    const ramp = t1 - s * stepDur; // hold until here, then ramp to v1
    const clip = (p) => Math.max(a, Math.min(b, p));
    const holdEnd = clip(Math.min(ramp, t1));
    const segStart = clip(t0);
    if (holdEnd > segStart + 1e-12 || s === 0) {
      const p0 = segStart;
      const p1 = s === 0 ? clip(t1) : holdEnd;
      if (p1 > p0 + 1e-12) pieces.push({ v0, v1: v0, f0: frac(p0), f1: frac(p1) });
    }
    if (s > 0) {
      const p0 = clip(ramp);
      const p1 = clip(t1);
      if (p1 > p0 + 1e-12) {
        const vAt = (p) => v0 + ((v1 - v0) * (p - ramp)) / (t1 - ramp);
        pieces.push({ v0: vAt(p0), v1: vAt(p1), f0: frac(p0), f1: frac(p1) });
      }
    } else if (t1 > a && t1 < b) {
      pieces.push({ v0, v1, f0: frac(t1), f1: frac(t1) }); // hard edge
    }
    n++;
  }
  return pieces;
}

// scale a 0..1 value-domain piece list into the internal domain through a
// resolved CC-float range [lo, hi] (0..127; lo > hi inverts)
export function scalePieces(pieces, lo, hi) {
  const toInternal = (v01) => Math.round(((lo + (hi - lo) * v01) * FULL) / 127);
  return pieces.map((p) => ({ ...p, v0: toInternal(p.v0), v1: toInternal(p.v1) }));
}

export const valueToInternal = (v01, lo, hi) =>
  Math.round(((lo + (hi - lo) * v01) * FULL) / 127);

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
    } else if (cc7(v0) !== prev) {
      // discontinuity at the piece start (e.g. a step edge that landed
      // exactly on a tick boundary): one announcing edge
      prev = cc7(v0);
      events.push({ value7: prev, frac: f0 });
    }
    if (v1 === v0) continue;
    const c1 = cc7(v1);
    if (f1 - f0 < 1e-12) {
      // vertical edge (step shape): one message at the landing value,
      // not a staircase burst — discontinuities send one edge
      if (c1 !== prev) {
        events.push({ value7: c1, frac: f0 });
        prev = c1;
      }
      continue;
    }
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
