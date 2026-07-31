// Stub for @kabelsalat/web. Superdough imports it dynamically only when a
// kabelsalat-dsp sound is triggered (superdough.mjs `loadKabelsalat`), which
// griddle does not expose. Aliased here (vite.config.js) so the bundle never
// pulls the real package — the one whose broken published dist forced the
// strudel vendoring in the first place.
export class SalatRepl {
  constructor() {
    throw new Error('kabelsalat is not available in griddle (stubbed out)');
  }
}
export default { SalatRepl };
