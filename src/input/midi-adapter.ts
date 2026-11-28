import type { MidiAccessState, MidiDeviceInfo, NoteInput } from './types';

type NoteListener = (event: NoteInput) => void;
type StateListener = (state: MidiAccessState, devices: MidiDeviceInfo[]) => void;

export class MidiInputController {
  private access: MIDIAccess | null = null;
  private state: MidiAccessState = 'unknown';
  private devices: MidiDeviceInfo[] = [];
  private noteListeners = new Set<NoteListener>();
  private stateListeners = new Set<StateListener>();
  private inFlight: Promise<MidiAccessState> | null = null;
  // Incremented on dispose() so in-flight requestMIDIAccess resolutions from a prior StrictMode mount become no-ops.
  private epoch = 0;

  subscribe(listener: NoteListener): () => void {
    this.noteListeners.add(listener);
    return () => {
      this.noteListeners.delete(listener);
    };
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state, this.devices);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): MidiAccessState {
    return this.state;
  }

  getDevices(): MidiDeviceInfo[] {
    return this.devices;
  }

  async probeIfPermitted(): Promise<MidiAccessState> {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      this.setState('unsupported', []);
      return 'unsupported';
    }

    if (globalThis.__maestroNativeMidi) {
      return this.connect({ interactive: false });
    }

    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return this.state;
    }

    const callEpoch = this.epoch;
    try {
      const status = await navigator.permissions.query({ name: 'midi' as PermissionName });
      if (callEpoch !== this.epoch) return this.state;
      if (status.state === 'granted') {
        return this.connect();
      }
      if (status.state === 'denied') {
        this.setState('denied', []);
        return 'denied';
      }
      return this.state;
    } catch {
      return this.state;
    }
  }

  async connect(options?: { interactive?: boolean }): Promise<MidiAccessState> {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      this.setState('unsupported', []);
      return 'unsupported';
    }

    const interactive = options?.interactive ?? true;
    const isNativeMidi = Boolean(globalThis.__maestroNativeMidi);

    if (this.access && !(interactive && isNativeMidi)) {
      this.syncInputs();
      this.setState('ready', this.devices);
      return 'ready';
    }

    if (this.inFlight && !(interactive && isNativeMidi)) {
      return this.inFlight;
    }

    const callEpoch = this.epoch;
    const midiOptions = (
      isNativeMidi ? { sysex: false, presentBluetooth: interactive } : { sysex: false }
    ) as MIDIOptions;
    const pending = navigator
      .requestMIDIAccess(midiOptions)
      .then((access): MidiAccessState => {
        if (callEpoch !== this.epoch) {
          return this.state;
        }
        this.access = access;
        access.onstatechange = () => {
          if (callEpoch !== this.epoch) return;
          this.syncInputs();
        };
        this.syncInputs();
        return 'ready';
      })
      .catch((err: unknown): MidiAccessState => {
        if (callEpoch !== this.epoch) {
          return this.state;
        }
        const name = err instanceof Error ? err.name : '';
        const nextState: MidiAccessState =
          name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'unsupported';
        this.setState(nextState, []);
        return nextState;
      })
      .finally(() => {
        if (this.inFlight === pending) {
          this.inFlight = null;
        }
      });

    this.inFlight = pending;
    return pending;
  }

  dispose(): void {
    this.epoch += 1;
    this.inFlight = null;
    if (this.access) {
      this.access.onstatechange = null;
      this.access.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
      this.access = null;
    }
    this.devices = [];
    this.noteListeners.clear();
    this.stateListeners.clear();
  }

  private syncInputs(): void {
    if (!this.access) return;
    const inputs = Array.from(this.access.inputs.values());
    const nextDevices: MidiDeviceInfo[] = inputs.map((input) => ({
      id: input.id,
      name: input.name || 'MIDI keyboard',
      manufacturer: input.manufacturer || 'Generic MIDI',
      state: input.state,
    }));
    inputs.forEach((input) => {
      input.onmidimessage = (msg) => this.handleMidiMessage(msg);
    });
    this.setState('ready', nextDevices);
  }

  private handleMidiMessage(msg: MIDIMessageEvent): void {
    const data = msg.data;
    if (!data || data.length < 2) return;

    const status = data[0];
    if (status >= 0xf0 || (status & 0x0f) === 9) return;

    const cmd = status & 0xf0;
    const data1 = data[1];
    const data2 = data.length > 2 ? data[2] : 0;
    const timeMs = performance.now();

    if (cmd === 0x90 && data2 > 0) {
      this.emitNote({ kind: 'on', pitch: data1, velocity: data2, source: 'midi', timeMs });
    } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
      this.emitNote({ kind: 'off', pitch: data1, source: 'midi', timeMs });
    } else if (cmd === 0xb0 && data1 === 64) {
      this.emitNote({ kind: 'sustain', down: data2 >= 64, source: 'midi', timeMs });
    }
  }

  private emitNote(event: NoteInput): void {
    this.noteListeners.forEach((listener) => listener(event));
  }

  private setState(nextState: MidiAccessState, nextDevices: MidiDeviceInfo[]): void {
    this.state = nextState;
    this.devices = nextDevices;
    this.stateListeners.forEach((listener) => listener(nextState, nextDevices));
  }
}
