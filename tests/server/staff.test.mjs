import { test } from "node:test";
import assert from "node:assert/strict";
import { PitchStaff } from "../../src/hosted/scoring/staff.js";
import { midiReference } from "../../src/hosted/scoring/reference.js";
import { PerformanceTools } from "../../src/hosted/performance.js";

function view() {
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({ createLinearGradient: () => gradient }, { get: (object, key) => object[key] || (() => {}) });
  return new PitchStaff({ hidden: true }, { style: {}, getContext: () => ctx });
}
test("graph retains bounded history, freezes paused frames and resets on seeks", () => {
  const staff = view(); staff.setEnabled(true);
  const frame = { reference: midiReference([{ time: 0, duration: 20, pitch: 69 }]), singers: [{ id: "one", pitch: 69 }], active: true, latency: .1 };
  for (let i = 1; i <= 400; i++) staff.render({ ...frame, time: .1 + i * .03 });
  const buffer = staff.series.get("one");
  assert.equal(buffer.snapshot().userPitches.length, 200);
  staff.render({ ...frame, time: 12.15, active: false });
  assert.equal(buffer.snapshot().userPitches.length, 200);
  staff.render({ ...frame, time: .3 });
  assert.equal(staff.series.get("one").snapshot().userPitches.length, 1);
  staff.render({ ...frame, time: .35, singers: [{ id: "one", pitch: null }] });
  assert.equal(staff.series.get("one").snapshot().userPitches.at(-1), null);
  staff.render({ ...frame, time: .4, singers: [] });
  assert.equal(staff.container.hidden, false);
  assert.equal(staff.series.size, 0);
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
  assert.ok(Math.abs((12 * Math.log2(staff.series.get("phone").snapshot().userPitches[0] / 440) + 69) - 69) < .1);
  tools.trackChanged(); assert.equal(staff.series.size, 0);
  tools.detachRemoteMicrophone("phone"); tools.update(player);
  assert.equal(disconnections.length, 1); assert.equal(tools.remoteInputs.size, 0);
  assert.equal(staff.series.size, 0);
});

test("enabled graph stays visible and draws reference pitch without a microphone", () => {
  const staff = view();
  const strokes = [];
  const ctx = staff.canvas.getContext("2d");
  ctx.stroke = () => strokes.push(ctx.strokeStyle);
  const tools = new PerformanceTools({ staff, status() {}, score() {}, recording() {} });
  tools.reference = midiReference([{ time: 0, duration: 4, pitch: 69 }]);
  const player = { valid: () => true, loaded: "song", audio: { currentTime: .5, paused: false } };
  staff.setEnabled(true);
  tools.update(player);
  assert.equal(staff.container.hidden, false);
  player.audio.currentTime = .55;
  tools.update(player);
  assert.equal(staff.container.hidden, false);
  assert.equal(staff.series.size, 0);
  assert.deepEqual(staff.referenceSeries.snapshot().refPitches, [440, 440]);
  assert.ok(strokes.length > 0);
  player.audio.paused = true;
  tools.update(player);
  assert.equal(staff.container.hidden, false);
  assert.equal(staff.referenceSeries.snapshot().refPitches.length, 2);
  tools.trackChanged();
  assert.equal(staff.container.hidden, false);
  assert.equal(staff.referenceSeries.snapshot().refPitches.length, 0);
  staff.setEnabled(false);
  tools.update(player);
  assert.equal(staff.container.hidden, true);
});
