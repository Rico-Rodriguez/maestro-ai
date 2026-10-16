import assert from 'node:assert/strict';
import test from 'node:test';
import { renderScorePdf } from '../src/score-pdf.mjs';

function song(measureCount, title = 'Prelude (Test)') {
  const events = [];
  for (let measure = 1; measure <= measureCount; measure += 1) {
    events.push({
      id: `r-${measure}`,
      pitch: 64,
      step: 'E',
      alter: 0,
      octave: 4,
      onset: (measure - 1) * 4,
      duration: measure % 2 === 0 ? 2 : 1,
      measure,
      beat: 1,
      hand: 'R',
    });
    events.push({
      id: `l-${measure}`,
      pitch: 48,
      step: 'C',
      alter: 0,
      octave: 3,
      onset: (measure - 1) * 4,
      duration: 1,
      measure,
      beat: 1,
      hand: 'L',
    });
  }
  return {
    title,
    composer: 'Practice library',
    keySignature: 'C Major',
    tempo: 96,
    timeSignature: [4, 4],
    totalMeasures: measureCount,
    events,
  };
}

function pdfText(bytes) {
  return Buffer.from(bytes).toString('latin1');
}

test('a saved score becomes a readable PDF', () => {
  const bytes = renderScorePdf(song(4));
  const text = pdfText(bytes);
  assert.equal(text.startsWith('%PDF-1.4'), true);
  assert.equal(text.includes('%%EOF'), true);
  assert.match(text, /\/Count 1/);
  assert.match(text, /Prelude \\\(Test\\\)/);
  assert.match(text, /96 BPM/);
  const start = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  assert.equal(bytes.length > 800, true);
});

test('a long score continues onto another page', () => {
  const text = pdfText(renderScorePdf(song(20, 'Long Piece')));
  assert.match(text, /\/Count 2/);
  assert.match(text, /Long Piece/);
});

test('a score with no notes still downloads', () => {
  const text = pdfText(renderScorePdf({
    title: 'Empty',
    timeSignature: [3, 4],
    events: [],
  }));
  assert.match(text, /This score has no notes/);
  assert.match(text, /3\/4/);
});
