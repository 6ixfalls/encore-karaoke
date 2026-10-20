import { test } from "node:test";
import assert from "node:assert/strict";
import { noteName, staffPosition, staffRange, targetBars, TargetBarCache, PitchStaff } from "../../src/hosted/scoring/staff.js";
import { midiReference } from "../../src/hosted/scoring/reference.js";
import { PerformanceTools } from "../../src/hosted/performance.js";

const guide = midiReference([{ time: 0, duration: 1, pitch: 60 }, { time: 2, duration: 1, pitch: 84 }]);
test("pitch bars preserve octave jumps and leave instrumental gaps empty", () => {
  const bars = targetBars(guide, -1, 4);
  assert.deepEqual(bars.map(bar => bar.pitch), [60, 84]);
  assert.ok(bars[0].end < 1.05 && bars[1].start >= 2);
  assert.deepEqual(targetBars(null, 0, 4), []);
  assert.equal(staffPosition(72) - staffPosition(60), 7);
  assert.equal(noteName(60), "C4"); assert.equal(noteName(84), "C6");
  assert.ok(staffPosition(61) > staffPosition(60));
});
test("staff follows the current register and fits singers in different octaves", () => {
  const bars = targetBars(guide, 0, 4);
  const low = staffRange(bars, [], 0), high = staffRange(bars, [], 2.5);
  assert.equal(high.center - low.center, 14);
  const duet = staffRange(bars, [{ pitch: 48 }, { pitch: 84 }, { pitch: null }], 2.5);
  assert.ok(duet.span >= 27);
});
function view() {
  const ctx = new Proxy({}, { get: (object, key) => object[key] || (() => {}) });
  const container = { hidden: true };
  const canvas = { clientWidth: 960, clientHeight: 180, getContext: () => ctx };
  return new PitchStaff(container, canvas);
}
test("long-song target geometry is calculated once and reused across seeks and toggles", () => {
  const reference = midiReference([{ time: 0, duration: 600, pitch: 69 }]);
  let calls = 0;
  const at = reference.at;
  reference.at = time => { calls++; return at(time); };
  const staff = view(); staff.setEnabled(true);
  const frame = { time: 1, reference, singers: [], active: true };
  staff.render(frame);
  const initial = calls;
  assert.equal(initial, 15001); // 15,000 target steps plus the current marker
  staff.render({ ...frame, time: 590 });
  staff.setEnabled(false); staff.setEnabled(true);
  staff.render({ ...frame, time: 1 });
  assert.equal(calls, initial + 2); // only the live marker is read per render
  assert.deepEqual(staff.targets.get(reference, 300, 310), [{ start: 0, end: 600, pitch: 69 }]);
});
test("live target geometry appends new data once, joining notes and preserving gaps", () => {
  const cache = new TargetBarCache();
  let calls = 0;
  const reference = { end: .105, complete: false, at: time => {
    calls++;
    assert.ok(time < reference.end);
    return time < .12 || time >= .2 ? [440] : [];
  } };
  assert.deepEqual(cache.get(reference, 0, 8), [{ start: 0, end: .08, pitch: 69 }]);
  assert.equal(calls, 2);
  cache.get(reference, 0, 8); assert.equal(calls, 2);
  reference.end = .225;
  assert.deepEqual(cache.get(reference, 0, 8), [{ start: 0, end: .12, pitch: 69 }]);
  assert.equal(calls, 5);
  reference.complete = true;
  const bars = cache.get(reference, 0, 8);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[1], { start: .2, end: .225, pitch: 69 });
  cache.get(reference, 0, 8); assert.equal(calls, 6);
  assert.deepEqual(cache.get(midiReference([{ time: 0, duration: 1, pitch: 60 }]), 0, 1),
    [{ start: 0, end: 1, pitch: 60 }]);
});
test("optional guide compensates latency and clears trails on seeks, silence and track changes", () => {
  const staff = view();
  const frame = { time: .5, reference: guide, singers: [{ id: "one", pitch: 60 }], active: true, latency: .1 };
  staff.render(frame); assert.equal(staff.history.size, 0);
  staff.setEnabled(true); staff.render(frame);
  assert.equal(staff.lastTime, .4);
  staff.render({ ...frame, time: .55, singers: [{ id: "one", pitch: null }] });
  assert.equal(staff.history.get("one").at(-1).pitch, null);
  staff.render({ ...frame, time: 2.5 });
  assert.equal(staff.history.get("one").length, 1);
  staff.render({ ...frame, time: .2, active: false });
  assert.equal(staff.history.get("one").length, 0);
  staff.reset(); assert.equal(staff.history.size, 0);
  staff.setEnabled(false); assert.equal(staff.container.hidden, true);
});
test("phone microphones feed independent live markers without needing a local microphone", () => {
  const staff = view(); staff.setEnabled(true);
  const tools = new PerformanceTools({ staff, status() {}, score() {}, recording() {} });
  const connections = [], disconnections = [];
  const source = { connect: node => connections.push(node), disconnect: node => disconnections.push(node) };
  const context = { sampleRate: 48000, createAnalyser: () => ({
    getFloatTimeDomainData: buffer => buffer.forEach((_, i) => { buffer[i] = .3 * Math.sin(2 * Math.PI * 440 * i / 48000); }), disconnect() {},
  }) };
  tools.attachRemoteMicrophone("phone", source, context);
  tools.reference = midiReference([{ time: 0, duration: 4, pitch: 69 }]);
  const player = { valid: () => true, loaded: "song", audio: { currentTime: .5, paused: false, playbackRate: 1 } };
  tools.update(player);
  assert.equal(connections.length, 1);
  assert.ok(Math.abs(staff.history.get("phone")[0].pitch - 69) < .1);
  tools.trackChanged(); assert.equal(staff.history.size, 0);
  tools.detachRemoteMicrophone("phone"); tools.update(player);
  assert.equal(disconnections.length, 1); assert.equal(tools.remoteInputs.size, 0);
  assert.equal(staff.history.size, 0);
});
