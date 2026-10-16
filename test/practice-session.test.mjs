import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRACTICE_MODES,
  chordCanAdvance,
  formatNextChip,
  micShouldAdvanceScore,
  midiShortStatus,
  midiStatusLine,
  notesPassedBy,
} from '../src/practice-session.mjs';
import { chordColumns, groupStaffEvents, layoutStaffGroup, octaveShiftForWindow } from '../src/staff-layout.mjs';
import {
  applyAudioSession,
  audioSessionType,
  detectPitch,
  isIosLike,
  isSilentWav,
  silentWavBytes,
} from '../src/poteto-audio.mjs';

test('practice modes say what they actually do', () => {
  assert.deepEqual(PRACTICE_MODES.map((mode) => mode.id), ['wait', 'continuous', 'autoplay']);
  assert.match(PRACTICE_MODES[0].hint, /waits|press/i);
  assert.match(PRACTICE_MODES[1].hint, /keep up|time/i);
  assert.match(PRACTICE_MODES[2].hint, /listen/i);
  for (const mode of PRACTICE_MODES) {
    assert.ok(mode.hint.length > 20);
    assert.ok(mode.idle.length > 8);
  }
});

test('the next-note chip stays short when a chord gets bigger', () => {
  const chord = ['C4', 'E4', 'G4', 'B4', 'D5', 'F5'].map((pitchName) => ({ pitchName }));
  assert.equal(formatNextChip([], true), '—');
  assert.equal(formatNextChip(chord.slice(0, 1), true), 'C4');
  assert.equal(formatNextChip(chord, true), 'C4+5');
  assert.ok(formatNextChip(chord, true).length < formatNextChip(chord, false).length);
  assert.equal(formatNextChip(chord, false), 'Next C4 +5');
  assert.ok(!formatNextChip(chord, true).includes('F5'));
});

test('a waited chord advances only after every note in it is played', () => {
  const events = [
    { id: 'a', onset: 0, pitch: 60 },
    { id: 'b', onset: 0.02, pitch: 64 },
    { id: 'c', onset: 1, pitch: 67 },
  ];
  const matched = events[1];
  assert.equal(chordCanAdvance(events, { b: { status: 'hit' } }, matched), false);
  assert.equal(chordCanAdvance(events, { a: { status: 'hit' }, b: { status: 'hit' } }, matched), true);
});

test('tempo mode marks only notes the playhead has passed', () => {
  const events = [
    { id: 'early', onset: 0 },
    { id: 'soon', onset: 1 },
    { id: 'done', onset: 0 },
  ];
  const late = notesPassedBy(events, { done: { status: 'hit' } }, 1.2, 0.8);
  assert.deepEqual(late.map((ev) => ev.id), ['early']);
});

test('the mic does not grade Listen while the song is sounding', () => {
  assert.equal(micShouldAdvanceScore('autoplay', true), false);
  assert.equal(micShouldAdvanceScore('autoplay', false), true);
  assert.equal(micShouldAdvanceScore('wait', true), true);
  assert.equal(micShouldAdvanceScore('continuous', true), true);
});

test('MIDI status names a connected keyboard and does not pretend the port is missing', () => {
  assert.match(midiShortStatus({ access: 'unknown', devices: [] }), /Connect/);
  assert.match(midiStatusLine({ access: 'denied', devices: [] }), /Allow/);
  assert.match(midiStatusLine({ access: 'ready', devices: [] }), /Turn on your keyboard/);
  assert.equal(midiShortStatus({ access: 'ready', devices: [{ name: 'Stage Piano' }] }), 'Stage Piano');
  assert.match(midiStatusLine({ access: 'ready', devices: [{ name: 'Stage Piano' }] }), /Stage Piano/);
});

test('chord seconds step aside and thirds stay in line', () => {
  assert.deepEqual(chordColumns([0, 1, 3], true), [0, 12, 0]);
  assert.deepEqual(chordColumns([0, 1, 2, 3], false), [0, -12, 0, -12]);
  const group = groupStaffEvents([
    { id: 'a', hand: 'R', onset: 4, pitch: 64 },
    { id: 'b', hand: 'R', onset: 4.02, pitch: 67 },
    { id: 'c', hand: 'L', onset: 4, pitch: 48 },
    { id: 'd', hand: 'R', onset: 5, pitch: 69 },
  ]);
  assert.equal(group.length, 3);
  const rightChord = group.find((item) => item.notes.length === 2);
  assert.deepEqual(rightChord.notes.map((note) => note.id), ['a', 'b']);
  const laid = layoutStaffGroup([
    { id: 'low', stepOffset: 0, alter: 1 },
    { id: 'second', stepOffset: 1, alter: 1 },
  ]);
  assert.notEqual(laid.notes[0].dx, laid.notes[1].dx);
  assert.notEqual(laid.notes[0].accidentalLane, laid.notes[1].accidentalLane);
});

test('the compact keyboard follows notes that are off screen', () => {
  assert.equal(octaveShiftForWindow([60, 64], 0), 0);
  assert.equal(octaveShiftForWindow([36], 0), -1);
  assert.equal(octaveShiftForWindow([76], 0), 1);
});

test('poteto mode recognizes iPhone, iPad, and desktop-mode iPad', () => {
  assert.equal(isIosLike({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' }), true);
  assert.equal(isIosLike({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)' }), true);
  assert.equal(isIosLike({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isIosLike({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 0 }), false);
  assert.equal(isIosLike(undefined), false);
});

test('the silent unlock clip is a real wav and the session asks for playback', () => {
  assert.equal(isSilentWav(silentWavBytes()), true);
  assert.equal(audioSessionType({ recording: false }), 'playback');
  assert.equal(audioSessionType({ recording: true }), 'play-and-record');
  const session = { type: 'auto' };
  assert.equal(applyAudioSession({ audioSession: session }, { recording: false }), true);
  assert.equal(session.type, 'playback');
  assert.equal(applyAudioSession({}, {}), false);
});

test('pitch detection finds A4 and ignores silence', () => {
  const sampleRate = 44100;
  const size = 2048;
  const silent = new Float32Array(size);
  assert.equal(detectPitch(silent, sampleRate), -1);

  const buf = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    buf[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const freq = detectPitch(buf, sampleRate);
  assert.ok(Math.abs(freq - 440) < 8, `expected near 440, got ${freq}`);
});
