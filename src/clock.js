// Lookahead tick clock ("A Tale of Two Clocks" pattern, as recommended by
// CLAVIER's interpreter-design.md): a coarse setInterval keeps a lookahead
// window populated; each tick is evaluated ahead of time and its events are
// scheduled with precise timestamps (performance.now() ms, which is also the
// WebMIDI timestamp domain).

const POLL_MS = 25;
const LOOKAHEAD_MS = 150;
// default ticks-per-beat (Orca convention: a tick is a sixteenth); a patch
// may redeclare via the ticks(n) mount statement — ticks() changes what a
// beat means, never what a tick does
export const TICKS_PER_BEAT = 4;

export class Clock {
  constructor({ onTick, getBpm, getTpb }) {
    this.onTick = onTick; // (tickNumber, timeMs) => void
    this.getBpm = getBpm;
    this.getTpb = getTpb ?? (() => TICKS_PER_BEAT);
    this.running = false;
    this.interval = null;
    this.tick = 0;
    this.nextTickTime = 0;
  }

  tickMs() {
    return 60000 / (this.getBpm() * this.getTpb());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick = 0;
    this.nextTickTime = performance.now() + 100;
    this.interval = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  poll() {
    const horizon = performance.now() + LOOKAHEAD_MS;
    while (this.nextTickTime < horizon) {
      this.onTick(this.tick, this.nextTickTime);
      this.tick += 1;
      this.nextTickTime += this.tickMs(); // re-read each tick: live BPM changes
    }
  }
}
