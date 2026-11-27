export interface BeamInputNote {
  id: string;
  duration: number;
  stepOffset: number;
}

export interface BeamInputGroup {
  hand: 'R' | 'L';
  onset: number;
  notes: BeamInputNote[];
}

export interface BeamMeasureSpan {
  measure: number;
  startBeat: number;
  endBeat: number;
}

export interface BeamMember {
  hand: 'R' | 'L';
  onset: number;
  displayDuration: number;
  flagCount: 1 | 2;
  noteIds: string[];
  minStepOffset: number;
  maxStepOffset: number;
}

export interface BeamRun {
  hand: 'R' | 'L';
  measure: number;
  beatGroup: number;
  stemUp: boolean;
  members: BeamMember[];
}

export interface BeamLineMemberInput {
  onset: number;
  minStepOffset?: number;
  maxStepOffset?: number;
  stepOffset?: number;
  stemDx?: number;
}

export interface BeamLineResult {
  yStart: number;
  yEnd: number;
  slope: number;
  stemYForMember: (cx: number) => number;
}

const MAX_BEAM_SLOPE = 0.18;
const MAX_BEAM_GAP_BEATS = 0.6;
const BEAT_TOLERANCE = 1e-4;

export function effectiveDisplayDuration(
  onset: number,
  duration: number,
  nextOnsetInHand: number | null,
): number {
  // Staccato 8ths in MIDI have short played durations (~0.2-0.3 beats) despite ~0.5+ beat inter-onset spacing.
  if (duration < 0.375 && nextOnsetInHand !== null && nextOnsetInHand - onset >= 0.42) {
    return 0.5;
  }
  return duration;
}

export function flagCountForDuration(displayDuration: number): 0 | 1 | 2 {
  if (displayDuration < 0.375) return 2;
  if (displayDuration < 0.9) return 1;
  return 0;
}

function pickUnifiedStemUp(notes: readonly BeamInputNote[]): boolean {
  let maxDist = -1;
  let extremeStep = 4;
  for (let i = 0; i < notes.length; i += 1) {
    const step = notes[i].stepOffset;
    const dist = Math.abs(step - 4);
    if (dist > maxDist || (dist === maxDist && step > extremeStep)) {
      maxDist = dist;
      extremeStep = step;
    }
  }
  return extremeStep < 4;
}

export function buildBeamGroups(
  groups: readonly BeamInputGroup[],
  measureSpans: readonly BeamMeasureSpan[],
): BeamRun[] {
  const spans = [...measureSpans].sort((a, b) => a.startBeat - b.startBeat);
  const runs: BeamRun[] = [];

  for (const hand of ['R', 'L'] as const) {
    const handGroups = groups
      .filter((g) => g.hand === hand && g.notes.length > 0)
      .sort((a, b) => a.onset - b.onset);

    let spanIdx = 0;
    let active: {
      measure: number;
      beatGroup: number;
      lastOnset: number;
      members: BeamMember[];
      allNotes: BeamInputNote[];
    } | null = null;

    const flush = () => {
      if (active && active.members.length >= 2) {
        runs.push({
          hand,
          measure: active.measure,
          beatGroup: active.beatGroup,
          stemUp: pickUnifiedStemUp(active.allNotes),
          members: active.members,
        });
      }
      active = null;
    };

    for (let i = 0; i < handGroups.length; i += 1) {
      const g = handGroups[i];
      const nextOnset = i + 1 < handGroups.length ? handGroups[i + 1].onset : null;

      let minDur = g.notes[0].duration;
      let minStep = g.notes[0].stepOffset;
      let maxStep = g.notes[0].stepOffset;
      const noteIds: string[] = [];
      for (let n = 0; n < g.notes.length; n += 1) {
        const note = g.notes[n];
        noteIds.push(note.id);
        if (note.duration < minDur) minDur = note.duration;
        if (note.stepOffset < minStep) minStep = note.stepOffset;
        if (note.stepOffset > maxStep) maxStep = note.stepOffset;
      }

      const displayDuration = effectiveDisplayDuration(g.onset, minDur, nextOnset);
      const flagCount = flagCountForDuration(displayDuration);
      if (flagCount === 0) {
        flush();
        continue;
      }

      while (spanIdx + 1 < spans.length && g.onset >= spans[spanIdx].endBeat - BEAT_TOLERANCE) {
        spanIdx += 1;
      }
      const span = spans[spanIdx] ?? {
        measure: Math.floor(g.onset / 4) + 1,
        startBeat: Math.floor(g.onset / 4) * 4,
        endBeat: (Math.floor(g.onset / 4) + 1) * 4,
      };
      const beatGroup = Math.floor(Math.max(0, g.onset - span.startBeat + BEAT_TOLERANCE));

      const member: BeamMember = {
        hand,
        onset: g.onset,
        displayDuration,
        flagCount,
        noteIds,
        minStepOffset: minStep,
        maxStepOffset: maxStep,
      };

      const canExtend =
        active !== null &&
        active.measure === span.measure &&
        active.beatGroup === beatGroup &&
        g.onset - active.lastOnset <= MAX_BEAM_GAP_BEATS + BEAT_TOLERANCE;

      if (canExtend && active) {
        active.lastOnset = g.onset;
        active.members.push(member);
        for (let n = 0; n < g.notes.length; n += 1) {
          active.allNotes.push(g.notes[n]);
        }
      } else {
        flush();
        active = {
          measure: span.measure,
          beatGroup,
          lastOnset: g.onset,
          members: [member],
          allNotes: [...g.notes],
        };
      }
    }

    flush();
  }

  return runs;
}

export function computeBeamLine(
  members: readonly BeamLineMemberInput[],
  stemUp: boolean,
  beatPx: number,
  leftMargin: number,
  baseBottomY: number,
  stepPx: number,
  minStemLen = 26,
): BeamLineResult {
  if (members.length === 0) {
    return {
      yStart: baseBottomY,
      yEnd: baseBottomY,
      slope: 0,
      stemYForMember: () => baseBottomY,
    };
  }

  const xs: number[] = [];
  const idealYs: number[] = [];
  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    const x = leftMargin + m.onset * beatPx + 18 + (m.stemDx ?? 0);
    const minStep = m.minStepOffset ?? m.stepOffset ?? 0;
    const maxStep = m.maxStepOffset ?? m.stepOffset ?? 0;
    const outerStep = stemUp ? maxStep : minStep;
    const noteY = baseBottomY - outerStep * stepPx;
    xs.push(x);
    idealYs.push(stemUp ? noteY - minStemLen : noteY + minStemLen);
  }

  const xFirst = xs[0];
  const xLast = xs[xs.length - 1];
  const dx = xLast - xFirst;
  const rawSlope = dx > 1e-6 ? (idealYs[idealYs.length - 1] - idealYs[0]) / dx : 0;
  const slope = Math.max(-MAX_BEAM_SLOPE, Math.min(MAX_BEAM_SLOPE, rawSlope));

  let shift = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const candY = idealYs[0] + slope * (xs[i] - xFirst);
    const diff = idealYs[i] - candY;
    if (stemUp) {
      if (diff < shift) shift = diff;
    } else if (diff > shift) {
      shift = diff;
    }
  }

  const yStart = idealYs[0] + shift;
  const yEnd = yStart + slope * dx;

  return {
    yStart,
    yEnd,
    slope,
    stemYForMember: (cx: number) => yStart + slope * (cx - xFirst),
  };
}
