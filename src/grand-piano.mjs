import manifest from './grand-manifest.mjs';

export const GRAND_MANIFEST = manifest;
export const GRAND_CREDIT = manifest.credit;
export const GRAND_HALL_CREDIT = manifest.hallCredit;
export const GRAND_NOTE_COUNT = manifest.notes.reduce((sum, note) => sum + note.files.length, 0);

export function layerForVelocity(velocity, layers = manifest.layers) {
  const list = layers && layers.length ? layers : [127];
  const vel = Math.max(1, Math.min(127, Math.round(Number(velocity) || 1)));
  let index = list.findIndex((max) => vel <= max);
  if (index < 0) index = list.length - 1;
  const floor = index === 0 ? 1 : list[index - 1] + 1;
  const ceil = list[index];
  const span = Math.max(1, ceil - floor);
  const pos = Math.max(0, Math.min(1, (vel - floor) / span));
  return { index, gain: 0.82 + 0.18 * pos };
}

export function nearestGrandNote(midi, notes = manifest.notes) {
  let best = null;
  let diff = Infinity;
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i];
    const distance = Math.abs(note.midi - midi);
    if (distance < diff) {
      diff = distance;
      best = note;
    }
  }
  return best;
}

export function nearestByMidi(midi, entries) {
  let best = null;
  let diff = Infinity;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const distance = Math.abs(entry.midi - midi);
    if (distance < diff) {
      diff = distance;
      best = entry;
    }
  }
  return best;
}

// Bass strings ring longer after the damper drops. High notes die quickly.
export function grandReleaseSeconds(midi) {
  const span = Math.max(0, Math.min(1, (Number(midi) - 21) / (108 - 21)));
  return 1.45 - span * 1.12;
}

export function grandSampleJobs(source = manifest) {
  const jobs = [{ key: 'hall', file: source.hall, priority: -1, note: false }];
  source.notes.forEach((note) => {
    note.files.forEach((file, index) => {
      jobs.push({
        key: `n:${note.midi}:${index}`,
        file,
        priority: Math.abs(note.midi - 60),
        note: true,
      });
    });
  });
  source.releases.forEach((entry) => {
    jobs.push({
      key: `r:${entry.midi}`,
      file: entry.file,
      priority: 1000 + Math.abs(entry.midi - 60),
      note: false,
    });
  });
  source.resonance.forEach((entry) => {
    jobs.push({
      key: `h:${entry.midi}`,
      file: entry.file,
      priority: 2000 + Math.abs(entry.midi - 60),
      note: false,
    });
  });
  jobs.push({ key: 'pedalD', file: source.pedalDown, priority: 3000, note: false });
  jobs.push({ key: 'pedalU', file: source.pedalUp, priority: 3001, note: false });
  jobs.sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));
  return jobs;
}

export function pianoOutputRoute({ native, potetoMode, forcePotato }) {
  if (potetoMode || forcePotato) return 'direct';
  if (native) return 'hall';
  return 'desktop';
}
