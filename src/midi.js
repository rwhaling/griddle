// MIDI output: WebMIDI device handling in the style of strudel's midi package
// (device enumeration with statechange refresh, timestamped sends so the
// OS/driver does the last-mile scheduling), plus a small WebAudio preview
// synth so the grid is audible without external gear.

export class MidiOut {
  constructor() {
    this.access = null;
    this.output = null;
    this.onDevicesChanged = null;
    this.error = null;
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.error = 'WebMIDI not available in this browser (Chrome/Edge recommended)';
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.addEventListener('statechange', () => {
        if (this.output && !this.outputs().find((o) => o.id === this.output.id)) {
          this.output = null;
        }
        this.onDevicesChanged?.();
      });
      return true;
    } catch (e) {
      this.error = `MIDI access denied: ${e.message}`;
      return false;
    }
  }

  outputs() {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  select(id) {
    this.output = this.outputs().find((o) => o.id === id) ?? null;
  }

  noteOn(channel, note, velocity, timeMs) {
    this.output?.send([0x90 | (channel & 0xf), note & 0x7f, velocity & 0x7f], timeMs);
  }

  noteOff(channel, note, timeMs) {
    this.output?.send([0x80 | (channel & 0xf), note & 0x7f, 0], timeMs);
  }

  cc(channel, controller, value, timeMs) {
    this.output?.send([0xb0 | (channel & 0xf), controller & 0x7f, value & 0x7f], timeMs);
  }

  allNotesOff() {
    if (!this.output) return;
    for (let ch = 0; ch < 16; ch++) {
      this.output.send([0xb0 | ch, 123, 0]); // CC 123: all notes off
    }
  }
}

export class PreviewSynth {
  constructor() {
    this.ctx = null;
  }

  ensure() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // map a performance.now() timestamp into AudioContext time
  toCtxTime(timeMs) {
    return this.ctx.currentTime + Math.max(0, timeMs - performance.now()) / 1000;
  }

  note(midiNote, velocity, timeMs, durationMs) {
    this.ensure();
    const t = this.toCtxTime(timeMs);
    const dur = Math.max(0.05, durationMs / 1000);
    const freq = 440 * 2 ** ((midiNote - 69) / 12);
    const gainValue = 0.25 * (velocity / 127);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(gainValue, t + 0.005);
    gain.gain.setValueAtTime(gainValue, t + dur);
    gain.gain.linearRampToValueAtTime(0, t + dur + 0.03);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}
