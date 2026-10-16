export const PRACTICE_MODES = [
  {
    id: 'wait',
    label: 'Wait',
    hint: 'Press the lit keys. The on-screen keyboard and your MIDI keyboard both count. The song stays quiet.',
    idle: 'Press the lit keys.',
  },
  {
    id: 'continuous',
    label: 'Tempo',
    hint: 'Maestro plays each note in time. Keep up on your keyboard. Late notes turn red.',
    idle: 'Keep up with the notes.',
  },
  {
    id: 'autoplay',
    label: 'Listen',
    hint: 'Maestro plays the song. You can just listen.',
    idle: 'Press Play to hear it.',
  },
];

export function practiceModeMeta(modeId) {
  return PRACTICE_MODES.find((mode) => mode.id === modeId) || PRACTICE_MODES[0];
}

export function formatNextChip(events, compact = false) {
  if (!events || events.length === 0) return compact ? '—' : 'Next —';
  const name = events[0].pitchName || '—';
  if (events.length === 1) return compact ? name : `Next ${name}`;
  return compact ? `${name}+${events.length - 1}` : `Next ${name} +${events.length - 1}`;
}

export function chordCanAdvance(events, evaluated, matched) {
  const peers = events.filter(
    (ev) => Math.abs(ev.onset - matched.onset) < 0.12 && ev.id !== matched.id
  );
  return peers.every((peer) => evaluated[peer.id]);
}

export function notesPassedBy(events, evaluated, beat, slack = 0.8) {
  return events.filter((ev) => !evaluated[ev.id] && beat > ev.onset + slack);
}

export function micShouldAdvanceScore(mode, playing) {
  return !(mode === 'autoplay' && playing);
}

export function midiShortStatus({ access, devices }) {
  if (devices && devices.length > 0) return devices[0].name || 'Keyboard';
  if (access === 'denied') return 'Allow MIDI';
  if (access === 'missing') return 'Tap Connect';
  if (access === 'ready') return 'Plug in a keyboard';
  return 'Tap Connect';
}

export function midiStatusLine({ access, devices }) {
  if (devices && devices.length > 0) {
    return `MIDI connected: ${devices[0].name || 'keyboard'}. Notes from that keyboard are heard and graded in Wait and Tempo.`;
  }
  if (access === 'ready') return 'MIDI is on. Turn on your keyboard and it will show up here.';
  if (access === 'denied') return 'MIDI access was blocked. Allow it for this site, then tap Connect.';
  if (access === 'missing') {
    return 'No MIDI port is visible yet. Tap Connect. Chrome and Edge can use a USB or Bluetooth keyboard, including MIDI browsers on a phone.';
  }
  return 'Tap Connect so your MIDI keyboard can play these notes.';
}
