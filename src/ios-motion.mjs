const BLACK_PITCH = new Set([1, 3, 6, 8, 10]);

export const STAFF_LEFT = 88;
export const STAFF_BEAT_PX = 56;
export const STAFF_ANCHOR = 0.38;

export function scrollForBeat(beat, clientWidth) {
  const width = Number(clientWidth) || 0;
  const playheadPx = STAFF_LEFT + (Number(beat) || 0) * STAFF_BEAT_PX;
  return Math.max(0, playheadPx - width * STAFF_ANCHOR);
}

export function beatFromStaffScroll({ scrollLeft, clientWidth, scrollWidth, totalBeats }) {
  const left = Math.max(0, Number(scrollLeft) || 0);
  const width = Math.max(0, Number(clientWidth) || 0);
  const full = Math.max(0, Number(scrollWidth) || 0);
  const total = Number.isFinite(totalBeats) ? Math.max(0, totalBeats) : 0;
  if (left <= 0.5) return 0;
  const maxScroll = Math.max(0, full - width);
  if (maxScroll > 1 && left >= maxScroll - 0.5) return total;
  const playheadPx = left + width * STAFF_ANCHOR;
  const beat = (playheadPx - STAFF_LEFT) / STAFF_BEAT_PX;
  if (!Number.isFinite(beat)) return 0;
  return Math.max(0, Math.min(total, beat));
}

export function cappedDevicePixelRatio(dpr, cap = 2) {
  const value = Number(dpr);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(cap, Math.max(1, value));
}

export function nextExpectedOnset(events, evaluated, beat) {
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!evaluated[ev.id] && ev.onset >= beat - 0.35) return ev.onset;
  }
  return null;
}

export function shouldPublishBeat(previous, next, beatsPerMeasure, events, evaluated) {
  if (previous == null || !Number.isFinite(previous)) return true;
  const bar = beatsPerMeasure > 0 ? beatsPerMeasure : 4;
  if (Math.floor(previous / bar) !== Math.floor(next / bar)) return true;
  return nextExpectedOnset(events, evaluated, previous) !== nextExpectedOnset(events, evaluated, next);
}

export function applyTouchChord(active, phase, id, midi) {
  const next = new Map(active);
  const events = [];
  if (phase === 'start') {
    if (midi == null || next.has(id)) return { active, events };
    const already = [...active.values()].includes(midi);
    next.set(id, midi);
    if (!already) events.push({ midi, down: true });
    return { active: next, events };
  }
  if (phase === 'end' || phase === 'cancel') {
    if (!next.has(id)) return { active, events };
    const held = next.get(id);
    next.delete(id);
    if (![...next.values()].includes(held)) events.push({ midi: held, down: false });
    return { active: next, events };
  }
  return { active, events };
}

export function paintFallingNotes(ctx, width, height, beat, events, evaluated, bounds, dark, beatsPerMeasure) {
  ctx.clearRect(0, 0, width, height);
  const minMidi = bounds.minMidi;
  const maxMidi = bounds.maxMidi;
  const whiteKeys = [];
  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    if (!BLACK_PITCH.has(midi % 12)) whiteKeys.push(midi);
  }
  if (whiteKeys.length === 0) return;
  const whiteKeyWidth = width / whiteKeys.length;
  const keyX = (midi) => {
    const isBlack = BLACK_PITCH.has(midi % 12);
    if (!isBlack) {
      const idx = whiteKeys.indexOf(midi);
      return { x: idx * whiteKeyWidth + 2, w: whiteKeyWidth - 4 };
    }
    const lowerWhiteIdx = whiteKeys.indexOf(midi - 1);
    return { x: (lowerWhiteIdx + 0.65) * whiteKeyWidth, w: whiteKeyWidth * 0.68 };
  };

  const lookaheadBeats = 4;
  const pixelsPerBeat = height / lookaheadBeats;
  whiteKeys.forEach((_, index) => {
    if (index % 2 !== 0) return;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.025)' : 'rgba(28,25,23,0.035)';
    ctx.fillRect(index * whiteKeyWidth, 0, whiteKeyWidth, height);
  });

  for (let mark = Math.ceil(beat); mark <= beat + lookaheadBeats; mark += 1) {
    if (mark % beatsPerMeasure !== 0) continue;
    const y = height - (mark - beat) * pixelsPerBeat;
    ctx.strokeStyle = dark ? 'rgba(217, 119, 6, 0.28)' : 'rgba(180, 83, 9, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = dark ? 'rgba(251, 146, 60, 0.85)' : 'rgba(194, 65, 12, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();

  events.forEach((ev) => {
    if (ev.onset + ev.duration < beat - 0.15 || ev.onset > beat + lookaheadBeats) return;
    if (ev.pitch < minMidi || ev.pitch > maxMidi) return;
    const { x, w } = keyX(ev.pitch);
    const inset = Math.max(2, Math.min(5, w * 0.16));
    const noteBottomY = height - (ev.onset - beat) * pixelsPerBeat;
    const noteHeight = Math.max(6, ev.duration * pixelsPerBeat - 3);
    const noteTopY = noteBottomY - noteHeight;
    const imminent = Math.abs(ev.onset - beat) < 0.35 && !evaluated[ev.id];
    const evalState = evaluated[ev.id];
    if (evalState?.status === 'hit') ctx.fillStyle = '#059669';
    else if (evalState?.status === 'miss') ctx.fillStyle = '#be123c';
    else if (ev.hand === 'R') ctx.fillStyle = imminent ? '#ea580c' : 'rgba(194, 65, 12, 0.82)';
    else ctx.fillStyle = imminent ? '#0284c7' : 'rgba(3, 105, 161, 0.82)';
    ctx.beginPath();
    ctx.roundRect(x + inset, noteTopY, Math.max(4, w - inset * 2), noteHeight, 3);
    ctx.fill();
  });
}

export function bindIosKeyboard(node, handlers) {
  let active = new Map();
  const dispatch = (phase, touch, midi) => {
    const result = applyTouchChord(active, phase, touch.identifier, midi);
    active = result.active;
    result.events.forEach((event) => {
      if (event.down) handlers.onDown(event.midi);
      else handlers.onUp(event.midi);
    });
  };
  const midiAt = (touch) => {
    const hit = document.elementFromPoint(touch.clientX, touch.clientY);
    const key = hit && hit.closest ? hit.closest('[data-midi]') : null;
    if (!key || !node.contains(key)) return null;
    const midi = Number(key.getAttribute('data-midi'));
    return Number.isFinite(midi) ? midi : null;
  };
  const start = (event) => {
    if (event.cancelable) event.preventDefault();
    Array.from(event.changedTouches || []).forEach((touch) => {
      dispatch('start', touch, midiAt(touch));
    });
  };
  const end = (event) => {
    Array.from(event.changedTouches || []).forEach((touch) => dispatch('end', touch, null));
  };
  const cancel = (event) => {
    Array.from(event.changedTouches || []).forEach((touch) => dispatch('cancel', touch, null));
  };
  node.addEventListener('touchstart', start, { passive: false });
  node.addEventListener('touchend', end);
  node.addEventListener('touchcancel', cancel);
  return () => {
    node.removeEventListener('touchstart', start);
    node.removeEventListener('touchend', end);
    node.removeEventListener('touchcancel', cancel);
  };
}
