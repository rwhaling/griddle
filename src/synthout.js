// Renderer #0 (doc nine): superdough as an in-process synth target for note
// events whose device resolves to a synth definition. The engine is loaded
// lazily (dynamic import) so the interpreter, mounts, and tests never touch
// audio; resolveSynthControls in mounts.js stays pure and headless.

import { resolveSynthControls } from './mounts.js';

let sd = null; // superdough module, once loaded
let initPromise = null;

// Load + initialize the engine. Safe to call repeatedly; call from a user
// gesture (play button) so the AudioContext may start. Ordering matters:
// sounds register before `sd` is set (playSynthNote's readiness guard), and
// a failed worklet init is non-fatal — the basic voices don't need worklets.
export function ensureSynth() {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import('superdough');
      mod.registerSynthSounds(); // waveforms, supersaw, noises, etc.
      await mod.getAudioContext().resume(); // gesture-adjacent: start audio
      try {
        await mod.initAudio(); // worklet fx (coarse/crush/shape), polyphony
      } catch (e) {
        console.warn('[griddle] superdough initAudio (worklet fx unavailable):', e);
      }
      sd = mod; // only now is the engine playable
    })().catch((e) => {
      initPromise = null; // allow retry on the next gesture
      throw e;
    });
  }
  return initPromise;
}

export const synthReady = () => sd !== null;

// performance.now() timestamp -> AudioContext time (PreviewSynth's mapping)
function toCtxTime(timeMs) {
  const ctx = sd.getAudioContext();
  return ctx.currentTime + Math.max(0, timeMs - performance.now()) / 1000;
}

// Play one strike through a synth definition: resolve layers (pure), then
// one superdough voice per layer at the same timestamp.
export function playSynthNote(def, e, timeMs, durMs) {
  if (!sd) return; // engine still loading: drop rather than mistime
  const durSec = Math.max(durMs / 1000, 0.02);
  const layers = resolveSynthControls(def, {
    note: e.note,
    velocity: e.velocity,
    durTicks: e.durTicks ?? e.holdTicks ?? 1,
  });
  const t = toCtxTime(timeMs);
  for (const controls of layers) {
    controls.duration = durSec;
    sd.superdough(controls, t, durSec);
  }
}
