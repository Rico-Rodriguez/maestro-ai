import { beatToSeconds, bpmAtBeat, secondsToBeat } from '../music/midi-parser';
import type { Hand, NoteEvent, PedalEvent, Score, TimeSigPoint } from '../music/types';
import { pianoEngine, type PianoAudioEngine } from './piano-engine';

export type SchedulerMode = 'wait' | 'tempo' | 'listen';
export type SchedulerHandFilter = 'BOTH' | 'R' | 'L';

export interface SchedulerLoopConfig {
  enabled: boolean;
  startMeasure: number;
  endMeasure: number;
}

export interface PlaybackSchedulerConfig {
  score: Score | null;
  mode: SchedulerMode;
  handFilter: SchedulerHandFilter;
  tempoScale: number;
  loop: SchedulerLoopConfig;
  metronomeOn: boolean;
  guideSoundOn: boolean;
  onBeatAdvance?: (prevBeat: number, nextBeat: number, bpm: number) => void;
  onLoopWrap?: (loopStartBeat: number) => void;
  onEnd?: () => void;
}

interface MeasureSegment {
  startBeat: number;
  endBeat: number;
  startMeasure: number;
  beatsPerMeasure: number;
}

interface ScheduledNote {
  pitch: number;
  hand: Hand;
  onset: number;
  endBeat: number;
  onWhenSec: number;
  offSent: boolean;
}

interface PendingLoopWrap {
  wrapAudioTime: number;
  loopStartBeat: number;
}

const TICK_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.12;
const MIN_TEMPO_SCALE = 0.1;
const MAX_TEMPO_SCALE = 4.0;
const MIN_NOTE_SEC = 0.015;
const BOUNDARY_EPS = 1e-6;

function clampTempoScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(MIN_TEMPO_SCALE, Math.min(MAX_TEMPO_SCALE, scale));
}

function buildMeasureSegments(score: Score): MeasureSegment[] {
  const timeSigs: TimeSigPoint[] =
    score.timeSignatures.length > 0
      ? score.timeSignatures
      : [
          {
            tick: 0,
            beat: 0,
            numerator: score.timeSignature[0] || 4,
            denominator: score.timeSignature[1] || 4,
          },
        ];

  const segments: MeasureSegment[] = [];
  let currentMeasure = 1;

  if (timeSigs[0].beat > 0) {
    const beatsPerMeasure = 4;
    const endBeat = timeSigs[0].beat;
    const count = Math.ceil(Math.max(0, endBeat - BOUNDARY_EPS) / beatsPerMeasure);
    segments.push({ startBeat: 0, endBeat, startMeasure: currentMeasure, beatsPerMeasure });
    currentMeasure += count;
  }

  for (let i = 0; i < timeSigs.length; i += 1) {
    const ts = timeSigs[i];
    const beatsPerMeasure = Math.max(1, ts.numerator * (4 / Math.max(1, ts.denominator)));
    const nextBeat = i + 1 < timeSigs.length ? timeSigs[i + 1].beat : Infinity;
    segments.push({
      startBeat: ts.beat,
      endBeat: nextBeat,
      startMeasure: currentMeasure,
      beatsPerMeasure,
    });
    if (Number.isFinite(nextBeat)) {
      const span = Math.max(0, nextBeat - ts.beat);
      currentMeasure += Math.ceil(Math.max(0, span - BOUNDARY_EPS) / beatsPerMeasure);
    }
  }

  return segments;
}

function measureToStartBeat(segments: MeasureSegment[], measure: number): number {
  if (measure <= 1 || segments.length === 0) return 0;
  let seg = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].startMeasure <= measure) {
      seg = segments[i];
    } else {
      break;
    }
  }
  return seg.startBeat + (measure - seg.startMeasure) * seg.beatsPerMeasure;
}

function isDownbeatAt(segments: MeasureSegment[], beat: number): boolean {
  if (segments.length === 0) return Math.abs(beat % 4) < 1e-4;
  let seg = segments[0];
  for (let i = 0; i < segments.length; i += 1) {
    if (beat >= segments[i].startBeat - 1e-4) {
      seg = segments[i];
    } else {
      break;
    }
  }
  const offset = Math.max(0, beat - seg.startBeat);
  const rem = offset % seg.beatsPerMeasure;
  return rem < 1e-4 || seg.beatsPerMeasure - rem < 1e-4;
}

function findFirstEventIndexAtOrAfter(events: readonly NoteEvent[], beat: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].onset < beat - BOUNDARY_EPS) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function findFirstPedalIndexAtOrAfter(pedals: readonly PedalEvent[], beat: number): number {
  let lo = 0;
  let hi = pedals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pedals[mid].beat < beat - BOUNDARY_EPS) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function computeSongEndBeat(score: Score): number {
  if (score.events.length === 0) return Math.max(0, score.totalBeats);
  let maxEnd = score.totalBeats;
  for (let i = 0; i < score.events.length; i += 1) {
    const ev = score.events[i];
    const end = ev.onset + ev.duration;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

function pedalDownAtBeat(pedals: readonly PedalEvent[], beat: number): boolean {
  let down = false;
  for (let i = 0; i < pedals.length; i += 1) {
    if (pedals[i].beat <= beat + BOUNDARY_EPS) {
      down = pedals[i].down;
    } else {
      break;
    }
  }
  return down;
}

export class PlaybackScheduler {
  private readonly engine: PianoAudioEngine;
  private config: PlaybackSchedulerConfig;
  private measureSegments: MeasureSegment[] = [];
  private songEndBeat = 0;

  private timerId: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private disposed = false;

  private heldBeat = 0;
  private lastEmittedBeat = 0;

  private liveAnchorAudioTime = 0;
  private liveAnchorSongSec = 0;
  private schedAnchorAudioTime = 0;
  private schedAnchorSongSec = 0;
  private scheduledBeat = 0;

  private eventCursor = 0;
  private pedalCursor = 0;
  private lastScheduledClickBeat = -Infinity;
  private activeScheduledNotes: ScheduledNote[] = [];
  private pendingWrap: PendingLoopWrap | null = null;

  constructor(
    engine: PianoAudioEngine = pianoEngine,
    initialConfig: Partial<PlaybackSchedulerConfig> = {},
  ) {
    this.engine = engine;
    this.config = {
      score: null,
      mode: 'wait',
      handFilter: 'BOTH',
      loop: { enabled: false, startMeasure: 1, endMeasure: 4 },
      metronomeOn: false,
      guideSoundOn: true,
      ...initialConfig,
      tempoScale: clampTempoScale(initialConfig.tempoScale ?? 1),
    };
    this.rebuildScoreCache();
  }

  play(): void {
    if (this.disposed || this.playing) return;
    const score = this.config.score;
    if (!score) return;

    let ctx: AudioContext;
    try {
      ctx = this.engine.ensureContext();
    } catch {
      return;
    }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const startBeat = this.clampBeatForPlay(this.heldBeat);
    this.heldBeat = startBeat;
    this.lastEmittedBeat = startBeat;
    this.playing = true;

    const now = ctx.currentTime;
    this.resetAnchors(score, now, startBeat);
    this.resetCursors(score, startBeat);

    if (this.config.mode === 'listen') {
      const initialPedal = pedalDownAtBeat(score.pedals, startBeat);
      this.engine.setSustain(initialPedal, now, 'playback');
    }

    this.startTimer();
    if (this.config.mode !== 'wait') {
      this.tick();
    }
  }

  pause(): void {
    if (!this.playing) return;
    if (this.config.mode !== 'wait') {
      this.heldBeat = this.getLiveBeat();
      this.lastEmittedBeat = this.heldBeat;
    }
    this.playing = false;
    this.stopTimer();
    this.pendingWrap = null;
    this.activeScheduledNotes = [];
    this.engine.stopAllPlayback();
  }

  seekBeat(beat: number): void {
    const score = this.config.score;
    const clamped = score ? Math.max(0, Math.min(beat, this.songEndBeat)) : Math.max(0, beat);

    this.heldBeat = clamped;
    this.lastEmittedBeat = clamped;
    this.pendingWrap = null;
    this.activeScheduledNotes = [];
    this.engine.stopAllPlayback();

    if (!score) return;
    this.resetCursors(score, clamped);

    if (this.playing) {
      const ctx = this.engine.getContext();
      if (ctx && ctx.state !== 'closed') {
        const now = ctx.currentTime;
        this.resetAnchors(score, now, clamped);
        if (this.config.mode === 'listen') {
          const initialPedal = pedalDownAtBeat(score.pedals, clamped);
          this.engine.setSustain(initialPedal, now, 'playback');
        }
        if (this.config.mode !== 'wait') {
          this.tick();
        }
      }
    }
  }

  setClampedBeat(beat: number): void {
    const score = this.config.score;
    const clamped = score ? Math.max(0, Math.min(beat, this.songEndBeat)) : Math.max(0, beat);
    this.heldBeat = clamped;
    this.lastEmittedBeat = clamped;

    if (score && this.config.mode === 'wait') {
      this.resetCursors(score, clamped);
    }
  }

  setTempoScale(scale: number): void {
    const nextScale = clampTempoScale(scale);
    if (nextScale === this.config.tempoScale) return;

    const score = this.config.score;
    const ctx = this.engine.getContext();

    if (this.playing && score && ctx && ctx.state !== 'closed' && this.config.mode !== 'wait') {
      const now = ctx.currentTime;
      if (this.pendingWrap && now >= this.pendingWrap.wrapAudioTime) {
        this.commitPendingWrap();
      }
      const currentBeat = this.computeBeatAt(
        score,
        now,
        this.liveAnchorAudioTime,
        this.liveAnchorSongSec,
      );
      this.config.tempoScale = nextScale;
      this.liveAnchorAudioTime = now;
      this.liveAnchorSongSec = beatToSeconds(score, currentBeat);

      // Re-anchor lookahead clock from the current scheduled horizon to preserve continuity.
      if (this.pendingWrap) {
        const remainingSchedBeats = Math.max(0, this.scheduledBeat - this.pendingWrap.loopStartBeat);
        const startSongSec = beatToSeconds(score, this.pendingWrap.loopStartBeat);
        const targetSongSec = beatToSeconds(score, this.scheduledBeat);
        const newWrapTime =
          now + (beatToSeconds(score, this.getLoopBounds().endBeat) - this.liveAnchorSongSec) / nextScale;
        this.pendingWrap.wrapAudioTime = newWrapTime;
        this.schedAnchorAudioTime = newWrapTime;
        this.schedAnchorSongSec = startSongSec;
        if (remainingSchedBeats > 0 && targetSongSec > startSongSec) {
          this.scheduledBeat = this.pendingWrap.loopStartBeat;
          this.resetCursors(score, this.pendingWrap.loopStartBeat);
        }
      } else {
        this.schedAnchorAudioTime = now;
        this.schedAnchorSongSec = this.liveAnchorSongSec;
      }
      return;
    }

    this.config.tempoScale = nextScale;
  }

  updateConfig(partial: Partial<PlaybackSchedulerConfig>): void {
    const prev = this.config;
    const nextScore = partial.score !== undefined ? partial.score : prev.score;
    const scoreChanged = nextScore !== prev.score;
    const prevMode = prev.mode;
    const prevHand = prev.handFilter;
    const prevGuide = prev.guideSoundOn;
    const nextTempoScale =
      partial.tempoScale !== undefined ? clampTempoScale(partial.tempoScale) : prev.tempoScale;

    this.config = {
      ...prev,
      ...partial,
      loop: partial.loop ? { ...partial.loop } : prev.loop,
      tempoScale: prev.tempoScale,
    };

    if (scoreChanged) {
      this.engine.stopAllPlayback();
      this.activeScheduledNotes = [];
      this.pendingWrap = null;
      this.rebuildScoreCache();
      this.heldBeat = 0;
      this.lastEmittedBeat = 0;
      if (nextScore) {
        this.resetCursors(nextScore, 0);
        const ctx = this.engine.getContext();
        if (this.playing && ctx && ctx.state !== 'closed') {
          this.resetAnchors(nextScore, ctx.currentTime, 0);
        }
      }
    }

    if (partial.tempoScale !== undefined && nextTempoScale !== prev.tempoScale) {
      this.setTempoScale(nextTempoScale);
    }

    const modeChanged = this.config.mode !== prevMode;
    if (modeChanged) {
      const ctx = this.engine.getContext();
      if (this.config.mode === 'wait') {
        if (this.playing) {
          this.heldBeat = this.computeCurrentLiveBeat();
          this.lastEmittedBeat = this.heldBeat;
        }
        this.pendingWrap = null;
        this.activeScheduledNotes = [];
        this.engine.stopAllPlayback();
      } else if (this.playing && nextScore && ctx && ctx.state !== 'closed') {
        const now = ctx.currentTime;
        if (prevMode === 'wait') {
          const startBeat = this.clampBeatForPlay(this.heldBeat);
          this.heldBeat = startBeat;
          this.lastEmittedBeat = startBeat;
          this.resetAnchors(nextScore, now, startBeat);
          this.resetCursors(nextScore, startBeat);
          if (this.config.mode === 'listen') {
            this.engine.setSustain(pedalDownAtBeat(nextScore.pedals, startBeat), now, 'playback');
          }
        } else {
          const liveBeat = this.computeCurrentLiveBeat();
          if (this.config.mode !== 'listen') {
            this.engine.setSustain(false, now, 'playback');
          } else {
            this.engine.setSustain(pedalDownAtBeat(nextScore.pedals, liveBeat), now, 'playback');
          }
          if (this.config.mode === 'tempo' && !this.config.guideSoundOn) {
            this.activeScheduledNotes = [];
            this.engine.stopAllPlayback(now);
          }
        }
      }
    } else if (
      this.playing &&
      (this.config.handFilter !== prevHand || this.config.guideSoundOn !== prevGuide)
    ) {
      this.activeScheduledNotes = [];
      this.engine.stopAllPlayback();
    }

    if (partial.loop !== undefined && !this.config.loop.enabled) {
      this.pendingWrap = null;
    }
  }

  getLiveBeat(): number {
    return this.computeCurrentLiveBeat();
  }

  getActivePlaybackPitches(): Map<number, Hand> {
    const active = new Map<number, Hand>();
    if (!this.playing || !this.config.score) return active;
    if (this.config.mode === 'wait') return active;
    if (this.config.mode === 'tempo' && !this.config.guideSoundOn) return active;

    const liveBeat = this.getLiveBeat();
    for (let i = 0; i < this.activeScheduledNotes.length; i += 1) {
      const note = this.activeScheduledNotes[i];
      if (note.onset <= liveBeat + BOUNDARY_EPS && liveBeat < note.endBeat) {
        active.set(note.pitch, note.hand);
      }
    }
    return active;
  }

  getPlaybackSustain(): boolean {
    if (!this.playing || this.config.mode !== 'listen' || !this.config.score) {
      return false;
    }
    return pedalDownAtBeat(this.config.score.pedals, this.getLiveBeat());
  }

  dispose(): void {
    this.disposed = true;
    this.playing = false;
    this.stopTimer();
    this.pendingWrap = null;
    this.activeScheduledNotes = [];
    this.engine.stopAllPlayback();
  }

  private tick = (): void => {
    if (this.disposed || !this.playing) return;
    if (this.config.mode === 'wait') return;

    const score = this.config.score;
    const ctx = this.engine.getContext();
    if (!score || !ctx || ctx.state === 'closed') return;

    const now = ctx.currentTime;
    if (this.pendingWrap && now >= this.pendingWrap.wrapAudioTime) {
      const wrappedBeat = this.pendingWrap.loopStartBeat;
      this.commitPendingWrap();
      this.pruneCompletedNotes(wrappedBeat);
      this.config.onLoopWrap?.(wrappedBeat);
    }

    const rawLiveBeat = this.computeBeatAt(
      score,
      now,
      this.liveAnchorAudioTime,
      this.liveAnchorSongSec,
    );

    const loopBounds = this.getLoopBounds();
    const looping = this.config.loop.enabled && loopBounds.endBeat > loopBounds.startBeat;
    const targetEndBeat = looping ? loopBounds.endBeat : this.songEndBeat;

    const clampedLiveBeat = Math.min(rawLiveBeat, targetEndBeat);
    this.heldBeat = clampedLiveBeat;

    if (Math.abs(clampedLiveBeat - this.lastEmittedBeat) > 1e-6) {
      const prevBeat = this.lastEmittedBeat;
      this.lastEmittedBeat = clampedLiveBeat;
      this.config.onBeatAdvance?.(prevBeat, clampedLiveBeat, bpmAtBeat(score, clampedLiveBeat));
    }

    this.pruneCompletedNotes(clampedLiveBeat);

    const lookaheadTime = now + LOOKAHEAD_SEC;

    if (looping && !this.pendingWrap) {
      const wrapAudioTime = this.beatToAudioTime(
        score,
        loopBounds.endBeat,
        this.schedAnchorAudioTime,
        this.schedAnchorSongSec,
      );

      if (lookaheadTime >= wrapAudioTime) {
        this.scheduleWindow(score, this.scheduledBeat, loopBounds.endBeat);
        this.flushPendingNoteOffs(score, loopBounds.endBeat);
        this.engine.stopAllPlayback(wrapAudioTime);
        this.activeScheduledNotes = this.activeScheduledNotes.filter(
          (n) => n.endBeat > loopBounds.endBeat,
        );

        const wrapStartBeat = loopBounds.startBeat;
        this.pendingWrap = { wrapAudioTime, loopStartBeat: wrapStartBeat };
        this.schedAnchorAudioTime = wrapAudioTime;
        this.schedAnchorSongSec = beatToSeconds(score, wrapStartBeat);
        this.scheduledBeat = wrapStartBeat;
        this.resetCursors(score, wrapStartBeat);

        if (this.config.mode === 'listen') {
          this.engine.setSustain(
            pedalDownAtBeat(score.pedals, wrapStartBeat),
            wrapAudioTime,
            'playback',
          );
        }

        const nextWindowEnd = this.computeBeatAt(
          score,
          lookaheadTime,
          this.schedAnchorAudioTime,
          this.schedAnchorSongSec,
        );
        const clampedNextEnd = Math.min(nextWindowEnd, loopBounds.endBeat);
        if (clampedNextEnd > this.scheduledBeat) {
          this.scheduleWindow(score, this.scheduledBeat, clampedNextEnd);
          this.flushPendingNoteOffs(score, clampedNextEnd);
          this.scheduledBeat = clampedNextEnd;
        }
        return;
      }
    }

    const windowEndBeat = Math.min(
      this.computeBeatAt(score, lookaheadTime, this.schedAnchorAudioTime, this.schedAnchorSongSec),
      targetEndBeat,
    );

    if (windowEndBeat > this.scheduledBeat) {
      this.scheduleWindow(score, this.scheduledBeat, windowEndBeat);
      this.flushPendingNoteOffs(score, windowEndBeat);
      this.scheduledBeat = windowEndBeat;
    }

    if (!looping && rawLiveBeat >= this.songEndBeat) {
      this.playing = false;
      this.stopTimer();
      this.heldBeat = this.songEndBeat;
      this.lastEmittedBeat = this.songEndBeat;
      this.activeScheduledNotes = [];
      this.engine.stopAllPlayback();
      this.config.onEnd?.();
    }
  };

  private scheduleWindow(score: Score, fromBeat: number, toBeat: number): void {
    const shouldPlayNotes =
      this.config.mode === 'listen' ||
      (this.config.mode === 'tempo' && this.config.guideSoundOn);
    const velScale = this.config.mode === 'tempo' ? 0.55 : 1;

    while (this.eventCursor < score.events.length) {
      const ev = score.events[this.eventCursor];
      if (ev.onset >= toBeat - BOUNDARY_EPS) break;
      this.eventCursor += 1;

      if (ev.onset < fromBeat - BOUNDARY_EPS) continue;
      if (!shouldPlayNotes) continue;
      if (this.config.handFilter !== 'BOTH' && ev.hand !== this.config.handFilter) continue;

      const onWhenSec = this.beatToAudioTime(
        score,
        ev.onset,
        this.schedAnchorAudioTime,
        this.schedAnchorSongSec,
      );
      const velocity = Math.max(1, Math.min(127, Math.round(ev.velocity * velScale)));
      this.engine.noteOn(ev.pitch, velocity, onWhenSec, 'playback');

      this.activeScheduledNotes.push({
        pitch: ev.pitch,
        hand: ev.hand,
        onset: ev.onset,
        endBeat: ev.onset + ev.duration,
        onWhenSec,
        offSent: false,
      });
    }

    if (this.config.mode === 'listen') {
      while (this.pedalCursor < score.pedals.length) {
        const pedal = score.pedals[this.pedalCursor];
        if (pedal.beat >= toBeat - BOUNDARY_EPS) break;
        this.pedalCursor += 1;

        if (pedal.beat < fromBeat - BOUNDARY_EPS) continue;
        const whenSec = this.beatToAudioTime(
          score,
          pedal.beat,
          this.schedAnchorAudioTime,
          this.schedAnchorSongSec,
        );
        this.engine.setSustain(pedal.down, whenSec, 'playback');
      }
    }

    if (this.config.metronomeOn) {
      let beatTick = Math.max(0, Math.ceil(fromBeat - BOUNDARY_EPS));
      while (beatTick < toBeat - BOUNDARY_EPS) {
        if (beatTick !== this.lastScheduledClickBeat) {
          this.lastScheduledClickBeat = beatTick;
          const whenSec = this.beatToAudioTime(
            score,
            beatTick,
            this.schedAnchorAudioTime,
            this.schedAnchorSongSec,
          );
          const isDownbeat = isDownbeatAt(this.measureSegments, beatTick);
          this.engine.playMetronomeClick(isDownbeat, whenSec);
        }
        beatTick += 1;
      }
    }
  }

  private flushPendingNoteOffs(score: Score, upToBeat: number): void {
    for (let i = 0; i < this.activeScheduledNotes.length; i += 1) {
      const note = this.activeScheduledNotes[i];
      if (note.offSent || note.endBeat >= upToBeat - BOUNDARY_EPS) continue;
      note.offSent = true;
      const offWhenSec = Math.max(
        note.onWhenSec + MIN_NOTE_SEC,
        this.beatToAudioTime(
          score,
          note.endBeat,
          this.schedAnchorAudioTime,
          this.schedAnchorSongSec,
        ),
      );
      this.engine.noteOff(note.pitch, offWhenSec, 'playback');
    }
  }

  private pruneCompletedNotes(liveBeat: number): void {
    if (this.activeScheduledNotes.length === 0) return;
    this.activeScheduledNotes = this.activeScheduledNotes.filter(
      (n) => !n.offSent || liveBeat < n.endBeat,
    );
  }

  private computeCurrentLiveBeat(): number {
    const score = this.config.score;
    if (!score) return this.heldBeat;
    if (!this.playing || this.config.mode === 'wait') return this.heldBeat;

    const ctx = this.engine.getContext();
    if (!ctx || ctx.state === 'closed') return this.heldBeat;

    const now = ctx.currentTime;
    if (this.pendingWrap && now >= this.pendingWrap.wrapAudioTime) {
      const beat = this.computeBeatAt(
        score,
        now,
        this.pendingWrap.wrapAudioTime,
        beatToSeconds(score, this.pendingWrap.loopStartBeat),
      );
      return Math.min(beat, this.getTargetEndBeat());
    }

    const beat = this.computeBeatAt(
      score,
      now,
      this.liveAnchorAudioTime,
      this.liveAnchorSongSec,
    );
    return Math.min(beat, this.getTargetEndBeat());
  }

  private commitPendingWrap(): void {
    if (!this.pendingWrap || !this.config.score) return;
    this.liveAnchorAudioTime = this.pendingWrap.wrapAudioTime;
    this.liveAnchorSongSec = beatToSeconds(this.config.score, this.pendingWrap.loopStartBeat);
    this.heldBeat = this.pendingWrap.loopStartBeat;
    this.lastEmittedBeat = this.pendingWrap.loopStartBeat;
    this.pendingWrap = null;
  }

  private computeBeatAt(
    score: Score,
    audioTime: number,
    anchorAudioTime: number,
    anchorSongSec: number,
  ): number {
    const elapsedAudio = Math.max(0, audioTime - anchorAudioTime);
    const songSec = anchorSongSec + elapsedAudio * this.config.tempoScale;
    return Math.max(0, secondsToBeat(score, songSec));
  }

  private beatToAudioTime(
    score: Score,
    beat: number,
    anchorAudioTime: number,
    anchorSongSec: number,
  ): number {
    const targetSongSec = beatToSeconds(score, beat);
    return anchorAudioTime + (targetSongSec - anchorSongSec) / this.config.tempoScale;
  }

  private rebuildScoreCache(): void {
    const score = this.config.score;
    if (!score) {
      this.measureSegments = [];
      this.songEndBeat = 0;
      return;
    }
    this.measureSegments = buildMeasureSegments(score);
    this.songEndBeat = computeSongEndBeat(score);
  }

  private getLoopBounds(): { startBeat: number; endBeat: number } {
    if (!this.config.score) return { startBeat: 0, endBeat: 0 };
    const startMeasure = Math.max(1, this.config.loop.startMeasure);
    const endMeasure = Math.max(startMeasure, this.config.loop.endMeasure);
    const startBeat = measureToStartBeat(this.measureSegments, startMeasure);
    const endBeat = Math.min(
      this.songEndBeat > 0 ? Math.max(this.songEndBeat, startBeat) : Infinity,
      measureToStartBeat(this.measureSegments, endMeasure + 1),
    );
    return { startBeat, endBeat };
  }

  private getTargetEndBeat(): number {
    if (this.config.loop.enabled) {
      const bounds = this.getLoopBounds();
      if (bounds.endBeat > bounds.startBeat) return bounds.endBeat;
    }
    return this.songEndBeat;
  }

  private clampBeatForPlay(beat: number): number {
    if (!this.config.score) return 0;
    if (this.config.loop.enabled) {
      const bounds = this.getLoopBounds();
      if (bounds.endBeat > bounds.startBeat) {
        if (beat < bounds.startBeat || beat >= bounds.endBeat) {
          return bounds.startBeat;
        }
        return beat;
      }
    }
    return Math.max(0, Math.min(beat, this.songEndBeat));
  }

  private resetAnchors(score: Score, audioTime: number, beat: number): void {
    const songSec = beatToSeconds(score, beat);
    this.liveAnchorAudioTime = audioTime;
    this.liveAnchorSongSec = songSec;
    this.schedAnchorAudioTime = audioTime;
    this.schedAnchorSongSec = songSec;
    this.scheduledBeat = beat;
    this.pendingWrap = null;
  }

  private resetCursors(score: Score, beat: number): void {
    this.eventCursor = findFirstEventIndexAtOrAfter(score.events, beat);
    this.pedalCursor = findFirstPedalIndexAtOrAfter(score.pedals, beat);
    this.lastScheduledClickBeat = -Infinity;
  }

  private startTimer(): void {
    if (this.timerId !== null) return;
    this.timerId = setInterval(this.tick, TICK_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timerId === null) return;
    clearInterval(this.timerId);
    this.timerId = null;
  }
}
