import { groupStaffEvents, layoutStaffGroup } from './staff-layout.mjs';

const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 40;
const RIGHT = 572;
const LINE = 7;
const MEASURES_PER_SYSTEM = 4;
const SYSTEMS_PER_PAGE = 4;
const SYSTEM_H = 132;

const DIATONIC = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const STEP_BY_PITCH = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALTER_BY_PITCH = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

function n(value) {
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(rounded) || Object.is(rounded, -0)) return '0';
  return String(rounded);
}

function pdfString(value) {
  const ascii = String(value).replace(/[^\x20-\x7e]/g, ' ');
  return `(${ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

function text(ops, value, x, y, size) {
  ops.push('BT');
  ops.push(`/F1 ${size} Tf`);
  ops.push(`${n(x)} ${n(y)} Td`);
  ops.push(`${pdfString(value)} Tj`);
  ops.push('ET');
}

function ellipse(cx, cy, rx, ry) {
  const k = 0.5522847498;
  const ox = rx * k;
  const oy = ry * k;
  return [
    `${n(cx - rx)} ${n(cy)} m`,
    `${n(cx - rx)} ${n(cy + oy)} ${n(cx - ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
    `${n(cx + ox)} ${n(cy + ry)} ${n(cx + rx)} ${n(cy + oy)} ${n(cx + rx)} ${n(cy)} c`,
    `${n(cx + rx)} ${n(cy - oy)} ${n(cx + ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
    `${n(cx - ox)} ${n(cy - ry)} ${n(cx - rx)} ${n(cy - oy)} ${n(cx - rx)} ${n(cy)} c`,
  ].join('\n');
}

function timeSignature(song) {
  const sig = song.timeSignature;
  if (!Array.isArray(sig) || sig.length < 2 || !sig[0] || !sig[1]) return [4, 4];
  return [sig[0], sig[1]];
}

function spelled(ev) {
  if (typeof ev.step === 'string' && Number.isFinite(ev.octave)) return ev;
  const pitch = Number.isFinite(ev.pitch) ? ev.pitch : 60;
  const pc = ((pitch % 12) + 12) % 12;
  return {
    ...ev,
    step: STEP_BY_PITCH[pc],
    alter: Number.isFinite(ev.alter) ? ev.alter : ALTER_BY_PITCH[pc],
    octave: Math.floor(pitch / 12) - 1,
  };
}

function staffOffset(ev, clef) {
  const diatonic = ev.octave * 7 + (DIATONIC[ev.step] ?? 0);
  return diatonic - (clef === 'treble' ? 30 : 18);
}

function measureCount(song, beats) {
  const fromEvents = song.events.reduce((max, ev) => {
    const measure = ev.measure || Math.floor((ev.onset || 0) / beats) + 1;
    return Math.max(max, measure);
  }, 0);
  return Math.max(1, song.totalMeasures || 0, fromEvents);
}

function systemsFor(count) {
  const systems = [];
  for (let start = 1; start <= count; start += MEASURES_PER_SYSTEM) {
    systems.push({
      start,
      end: Math.min(count, start + MEASURES_PER_SYSTEM - 1),
    });
  }
  return systems;
}

function drawStaff(ops, x1, x2, bottom) {
  ops.push('0.4 w');
  for (let i = 0; i < 5; i += 1) {
    const y = bottom + i * LINE;
    ops.push(`${n(x1)} ${n(y)} m ${n(x2)} ${n(y)} l S`);
  }
}

function drawNotes(ops, events, hand, staffBottom, x0, measureWidth, beats) {
  const clef = hand === 'R' ? 'treble' : 'bass';
  const mine = events
    .filter((ev) => (ev.hand || 'R') === hand)
    .map((ev) => spelled(ev));
  groupStaffEvents(mine).forEach((group) => {
    const prepared = group.notes.map((ev) => ({
      ...ev,
      stepOffset: staffOffset(ev, clef),
    }));
    const layout = layoutStaffGroup(prepared);
    const drawn = layout.notes.map((note) => {
      const beat = note.beat || (((note.onset || 0) % beats) + 1);
      const frac = Math.max(0, Math.min(0.98, (beat - 1) / beats));
      const cx = x0 + 12 + frac * (measureWidth - 24) + note.dx * 0.65;
      const cy = staffBottom + note.stepOffset * (LINE / 2);
      return { ...note, cx, cy };
    });
    const showStem = drawn.some((note) => note.duration < 4);
    if (showStem && drawn.length) {
      const top = Math.max(...drawn.map((note) => note.cy));
      const bottom = Math.min(...drawn.map((note) => note.cy));
      const stemX = layout.stemUp
        ? Math.max(...drawn.map((note) => note.cx)) + 3
        : Math.min(...drawn.map((note) => note.cx)) - 3;
      const stemTop = layout.stemUp ? top + 16 : top;
      const stemBottom = layout.stemUp ? bottom : bottom - 16;
      ops.push('0.8 w');
      ops.push(`${n(stemX)} ${n(stemBottom)} m ${n(stemX)} ${n(stemTop)} l S`);
    }
    drawn.forEach((note) => {
      if (note.stepOffset >= 10 || note.stepOffset <= -2) {
        ops.push('0.5 w');
        const limit = note.stepOffset >= 10 ? note.stepOffset : note.stepOffset;
        const step = note.stepOffset >= 10 ? 2 : -2;
        const start = note.stepOffset >= 10 ? 10 : -2;
        for (let offset = start; note.stepOffset >= 10 ? offset <= limit : offset >= limit; offset += step) {
          const y = staffBottom + offset * (LINE / 2);
          ops.push(`${n(note.cx - 7)} ${n(y)} m ${n(note.cx + 7)} ${n(y)} l S`);
        }
      }
      if (note.alter === 1) text(ops, '#', note.cx - 11 - (note.accidentalLane || 0) * 7, note.cy - 3, 9);
      if (note.alter === -1) text(ops, 'b', note.cx - 11 - (note.accidentalLane || 0) * 7, note.cy - 3, 9);
      const hollow = note.duration >= 2;
      const head = ellipse(note.cx, note.cy, 3.2, 2.3);
      if (hollow) {
        ops.push('1 1 1 rg');
        ops.push(head);
        ops.push('f');
        ops.push('0 0 0 RG');
        ops.push('0.8 w');
        ops.push(head);
        ops.push('S');
      } else {
        ops.push('0 0 0 rg');
        ops.push(head);
        ops.push('f');
      }
    });
  });
}

function drawSystem(ops, systemTop, system, song, beats, sig) {
  const trebleBottom = PAGE_H - (systemTop + 50);
  const bassBottom = PAGE_H - (systemTop + 98);
  const startX = LEFT + 36;
  const measureWidth = (RIGHT - startX) / MEASURES_PER_SYSTEM;
  const measures = system.end - system.start + 1;

  ops.push('0.9 w');
  ops.push(`${n(LEFT)} ${n(trebleBottom + 4 * LINE)} m ${n(LEFT)} ${n(bassBottom)} l S`);
  drawStaff(ops, LEFT, RIGHT, trebleBottom);
  drawStaff(ops, LEFT, RIGHT, bassBottom);
  text(ops, 'G', LEFT + 6, trebleBottom + 8, 14);
  text(ops, 'F', LEFT + 6, bassBottom + 8, 14);
  text(ops, String(sig[0]), LEFT + 20, trebleBottom + 16, 9);
  text(ops, String(sig[1]), LEFT + 20, trebleBottom + 4, 9);
  text(ops, String(sig[0]), LEFT + 20, bassBottom + 16, 9);
  text(ops, String(sig[1]), LEFT + 20, bassBottom + 4, 9);

  for (let index = 0; index <= measures; index += 1) {
    const x = startX + index * measureWidth;
    ops.push('0.7 w');
    ops.push(`${n(x)} ${n(trebleBottom + 4 * LINE)} m ${n(x)} ${n(bassBottom)} l S`);
    if (index < measures) {
      const measure = system.start + index;
      text(ops, String(measure), x + 3, trebleBottom + 4 * LINE + 10, 8);
      const events = song.events.filter((ev) => {
        const number = ev.measure || Math.floor((ev.onset || 0) / beats) + 1;
        return number === measure;
      });
      drawNotes(ops, events, 'R', trebleBottom, x, measureWidth, beats);
      drawNotes(ops, events, 'L', bassBottom, x, measureWidth, beats);
    }
  }
}

function pageStream(song, systems, pageIndex, pageCount, sig, beats) {
  const ops = ['0 0 0 RG', '0 0 0 rg', '0.6 w'];
  const title = String(song.title || 'Saved score').slice(0, 80);
  if (pageIndex === 0) {
    text(ops, title, LEFT, PAGE_H - 46, 16);
    const detail = [
      song.composer,
      song.keySignature,
      `${sig[0]}/${sig[1]}`,
      song.tempo ? `${Math.round(song.tempo)} BPM` : '',
    ].filter(Boolean).join('  ·  ');
    if (detail) text(ops, detail, LEFT, PAGE_H - 64, 9);
  } else {
    text(ops, title, LEFT, PAGE_H - 36, 10);
  }
  const firstTop = pageIndex === 0 ? 88 : 56;
  systems.forEach((system, index) => {
    drawSystem(ops, firstTop + index * SYSTEM_H, system, song, beats, sig);
  });
  if (!song.events.length && pageIndex === 0) {
    text(ops, 'This score has no notes.', LEFT, PAGE_H - 120, 11);
  }
  text(ops, `${pageIndex + 1} / ${pageCount}`, PAGE_W / 2 - 12, 28, 8);
  return ops.join('\n');
}

function encodePdf(streams) {
  const fontId = 3 + streams.length * 2;
  const objects = [];
  const kids = [];
  streams.forEach((stream, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${streams.length} /Kids [${kids.join(' ')}] >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${fontId + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id <= fontId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export function renderScorePdf(song) {
  if (!song || !Array.isArray(song.events)) {
    throw new Error('A score with notes is required.');
  }
  const sig = timeSignature(song);
  const beats = sig[0] * (4 / sig[1]) || 4;
  const systems = systemsFor(measureCount(song, beats));
  const streams = [];
  for (let index = 0; index < systems.length; index += SYSTEMS_PER_PAGE) {
    streams.push(pageStream(
      song,
      systems.slice(index, index + SYSTEMS_PER_PAGE),
      streams.length,
      Math.ceil(systems.length / SYSTEMS_PER_PAGE),
      sig,
      beats,
    ));
  }
  return encodePdf(streams);
}
