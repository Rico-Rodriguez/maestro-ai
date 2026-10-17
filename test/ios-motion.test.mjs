import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDecodeSamples } from '../src/poteto-audio.mjs';
import { iosIndexHtml } from '../src/ios-viewport.mjs';
import {
  applyTouchChord,
  cappedDevicePixelRatio,
  nextExpectedOnset,
  paintFallingNotes,
  shouldPublishBeat,
} from '../src/ios-motion.mjs';

test('the installed app decodes piano samples before the first tap', () => {
  assert.equal(shouldDecodeSamples({
    potetoMode: false,
    forcePotato: false,
    native: true,
    contextState: 'suspended',
  }), true);
  assert.equal(shouldDecodeSamples({
    potetoMode: true,
    forcePotato: false,
    native: false,
    contextState: 'running',
  }), false);
  assert.equal(shouldDecodeSamples({
    potetoMode: false,
    forcePotato: false,
    native: false,
    contextState: 'suspended',
  }), false);
  assert.equal(shouldDecodeSamples({
    potetoMode: false,
    forcePotato: false,
    native: false,
    contextState: 'running',
  }), true);
});

test('a moving playhead does not republish the page on every frame', () => {
  const events = [
    { id: 'a', onset: 0, pitch: 60 },
    { id: 'b', onset: 4, pitch: 64 },
  ];
  const evaluated = {};
  let published = 0;
  let last = 0;
  let beat = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    beat += 0.033;
    if (shouldPublishBeat(last, beat, 4, events, evaluated)) {
      published += 1;
      last = beat;
    }
  }
  assert.equal(nextExpectedOnset(events, evaluated, 0), 0);
  assert.ok(published < 5, `published ${published} times in 120 frames`);
});

test('two fingers can hold a chord and one lift keeps the other note', () => {
  let active = new Map();
  const first = applyTouchChord(active, 'start', 1, 60);
  active = first.active;
  assert.deepEqual(first.events, [{ midi: 60, down: true }]);
  const second = applyTouchChord(active, 'start', 2, 64);
  active = second.active;
  assert.deepEqual(second.events, [{ midi: 64, down: true }]);
  const lift = applyTouchChord(active, 'end', 1, null);
  assert.deepEqual(lift.events, [{ midi: 60, down: false }]);
  assert.equal(lift.active.get(2), 64);
});

test('canvas pixels stay capped on a 3x phone', () => {
  assert.equal(cappedDevicePixelRatio(3, 2), 2);
  assert.equal(cappedDevicePixelRatio(1.5, 2), 1.5);
  assert.equal(cappedDevicePixelRatio(0, 2), 1);
});

test('the iOS page blocks pinch zoom and the site viewport stays the same', () => {
  const site = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
  assert.match(iosIndexHtml(site), /user-scalable=no/);
  assert.match(iosIndexHtml(site), /viewport-fit=cover/);
  assert.match(iosIndexHtml(site), /maximum-scale=1.0/);
});

test('falling notes for two seconds of frames stay cheap without a react render', () => {
  const ctx = {
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    roundRect() {},
  };
  const events = Array.from({ length: 180 }, (_, index) => ({
    id: String(index),
    onset: index * 0.25,
    duration: 0.5,
    pitch: 48 + (index % 24),
    hand: index % 2 === 0 ? 'R' : 'L',
  }));
  const started = performance.now();
  for (let frame = 0; frame < 120; frame += 1) {
    paintFallingNotes(ctx, 390, 176, frame * 0.033, events, {}, {
      minMidi: 48,
      maxMidi: 72,
    }, false, 4);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `paint took ${elapsed.toFixed(1)} ms`);
});
