// MIDI output: WebMIDI device handling in the style of strudel's midi package
// (device enumeration with statechange refresh, timestamped sends so the
// OS/driver does the last-mile scheduling). Audible-without-gear now lives
// in synth devices (doc nine, src/synthout.js + the device-z defaults).

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

// The PreviewSynth that lived here was superseded by synth devices
// (doc nine, src/synthout.js): superdough voices mounted in the device
// table render any note event in-process, no MIDI gear required.
