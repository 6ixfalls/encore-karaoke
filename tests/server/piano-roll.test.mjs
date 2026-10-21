import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideNotes, pageLayout, HostedPianoRoll } from '../../src/hosted/scoring/piano-roll.js';
import { midiReference } from '../../src/hosted/scoring/reference.js';

test('vocal guide bars preserve silence and sustained notes across streamed snapshots', () => {
  assert.deepEqual(guideNotes({ pitches: [440, 440, null, 440, 493.88], step: .1 }), [
    { startTime: 0, duration: .2, pitch: 69 },
    { startTime: 3 * .1, duration: .1, pitch: 69 },
    { startTime: .4, duration: .1, pitch: 71 },
  ]);
  const reference = midiReference([{ time: 5, duration: 2, pitch: 69 }, { time: 1, duration: 1, pitch: 60 }]);
  assert.deepEqual(guideNotes(reference).map(n => n.startTime), [1, 5]);
});

test('piano roll pages at 150 pixels per second and retains the upstream pre-roll', () => {
  const notes = [{ startTime: 10 }];
  assert.deepEqual(pageLayout(1200, 7.5, notes), { start: 7.5, end: 15.5, playhead: 0 });
  assert.equal(pageLayout(1200, 11.5, notes).playhead, 600);
  assert.deepEqual(pageLayout(1200, 15.5, notes), { start: 15.5, end: 23.5, playhead: 0 });
  assert.equal(pageLayout(600, 11.5, notes).start, 11.5);
  assert.equal(pageLayout(1200, 11.5, notes).start, 7.5);
});

test('guide preview draws future bars without a microphone; singer history freezes and disconnects independently', () => {
  const bars = [], fills = [], stops = [];
  const ctx = new Proxy({
    roundRect: (...args) => bars.push(args),
    fillRect: (...args) => fills.push([ctx.fillStyle, ...args]),
    createLinearGradient: () => ({ addColorStop: (...args) => stops.push(args) }),
  }, { get: (target, name) => target[name] || (() => {}) });
  const canvas = { getContext: () => ctx };
  const roll = new HostedPianoRoll({ clientWidth: 1200 }, canvas);
  const frame = { time: 1, reference: midiReference([{ time: 3, duration: 2, pitch: 69 }]), singers: [], active: true };
  roll.render(frame);
  assert.ok(bars.some(([x, , width, height]) => x === 375 && width === 300 && height === 16));
  assert.ok(stops.some(([, color]) => color === '#7dd3fc'));
  assert.ok(fills.some(([color]) => color === '#ffd700'));
  roll.render({ ...frame, singers: [{ id: 'one', pitch: 69 }, { id: 'two', pitch: 70 }] });
  assert.equal(roll.trails.size, 2);
  roll.render({ ...frame, time: 2, active: false, singers: [{ id: 'one', pitch: null }] });
  assert.equal(roll.trails.size, 1);
  assert.equal(roll.trails.get('one').length, 1);
  roll.reset();
  assert.equal(roll.trails.size, 0);
});
