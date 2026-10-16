// Seconds (adjacent staff positions) cannot share a column or the noteheads
// become one blob. Thirds and wider intervals stay in the main column.

export function chordColumns(stepOffsets, stemUp) {
  const order = stepOffsets.map((step, index) => ({ step, index }))
    .sort((a, b) => a.step - b.step);
  const column = new Array(stepOffsets.length).fill(0);
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].step - order[i - 1].step <= 1) {
      const previous = column[order[i - 1].index];
      column[order[i].index] = previous === 0 ? 1 : 0;
    }
  }
  const sign = stemUp ? 1 : -1;
  return column.map((lane) => (lane === 0 ? 0 : lane * 12 * sign));
}

export function stemGoesUp(stepOffsets) {
  if (!stepOffsets.length) return true;
  const middle = stepOffsets.reduce((sum, step) => sum + step, 0) / stepOffsets.length;
  return middle < 4;
}

export function groupStaffEvents(events, onsetSlack = 0.12) {
  const groups = [];
  const sorted = [...events].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  sorted.forEach((ev) => {
    const last = groups[groups.length - 1];
    if (last && last.hand === ev.hand && Math.abs(last.onset - ev.onset) < onsetSlack) {
      last.notes.push(ev);
    } else {
      groups.push({ hand: ev.hand, onset: ev.onset, notes: [ev] });
    }
  });
  return groups;
}

export function layoutStaffGroup(notes) {
  const steps = notes.map((note) => note.stepOffset);
  const stemUp = stemGoesUp(steps);
  const dxs = chordColumns(steps, stemUp);
  const placed = notes.map((note, index) => ({ ...note, dx: dxs[index] }));
  const stemX = stemUp
    ? Math.max(...placed.map((note) => note.dx)) + 6
    : Math.min(...placed.map((note) => note.dx)) - 6;

  const altered = placed
    .filter((note) => note.alter)
    .sort((a, b) => a.stepOffset - b.stepOffset);
  const accidentalLane = {};
  let lastStep = -99;
  let lane = 0;
  altered.forEach((note) => {
    if (note.stepOffset - lastStep <= 2) lane = lane === 0 ? 1 : 0;
    else lane = 0;
    lastStep = note.stepOffset;
    accidentalLane[note.id] = lane;
  });

  return {
    stemUp,
    stemX,
    notes: placed.map((note) => ({
      ...note,
      accidentalLane: accidentalLane[note.id] || 0,
    })),
  };
}

export function octaveShiftForWindow(pitches, shift, base = 48, span = 24) {
  if (!pitches.length) return shift;
  const min = base + shift * 12;
  const max = min + span;
  if (pitches.some((pitch) => pitch >= min && pitch <= max)) return shift;
  const center = pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length;
  let best = shift;
  let bestDist = Infinity;
  [-1, 0, 1].forEach((candidate) => {
    const lo = base + candidate * 12;
    const hi = lo + span;
    const dist = center < lo ? lo - center : center > hi ? center - hi : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  });
  return best;
}
