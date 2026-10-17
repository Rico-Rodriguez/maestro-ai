import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDecodeSamples } from '../src/poteto-audio.mjs';
import { iosIndexHtml } from '../src/ios-viewport.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAFF_BEAT_PX,
  STAFF_LEFT,
  applyTouchChord,
  beatFromStaffScroll,
  cappedDevicePixelRatio,
  nextExpectedOnset,
  paintFallingNotes,
  scrollForBeat,
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

test('scrolling the staff lands on that beat and does not jump back', () => {
  const width = 390;
  const totalBeats = 64;
  const scrollWidth = STAFF_LEFT + totalBeats * STAFF_BEAT_PX + 140;
  assert.equal(beatFromStaffScroll({
    scrollLeft: 0,
    clientWidth: width,
    scrollWidth,
    totalBeats,
  }), 0);
  for (const beat of [2, 4, 8, 12, 20]) {
    const left = scrollForBeat(beat, width);
    const back = beatFromStaffScroll({
      scrollLeft: left,
      clientWidth: width,
      scrollWidth,
      totalBeats,
    });
    assert.ok(Math.abs(back - beat) < 0.02, `beat ${beat} came back as ${back}`);
  }
  assert.equal(beatFromStaffScroll({
    scrollLeft: scrollWidth - width,
    clientWidth: width,
    scrollWidth,
    totalBeats,
  }), totalBeats);
});

test('the iOS playhead is a layer above the staff, not a child of the svg', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'src', 'maestro_ai_platform.tsx'), 'utf8');
  const svgStart = source.indexOf('<svg');
  const svgEnd = source.indexOf('</svg>', svgStart);
  const playhead = source.indexOf('className="ios-playhead"');
  assert.ok(svgStart > 0 && svgEnd > svgStart);
  assert.ok(playhead > svgEnd, 'playhead div is inside the svg and will not paint');
  assert.match(source, /ios-staff-stage/);
  const css = fs.readFileSync(path.join(root, 'src', 'index.css'), 'utf8');
  assert.match(css, /\.ios-playhead[\s\S]*z-index:\s*4/);
  assert.match(css, /\.ios-staff-stage[\s\S]*position:\s*relative/);
});
