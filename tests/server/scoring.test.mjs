import { test } from "node:test";
import assert from "node:assert/strict";
import { PitchScoring, pitchSimilarity, computeSingableTime } from "../../src/hosted/scoring/state.js";
import { ReferenceScore, midiReference, vocalReference } from "../../src/hosted/scoring/reference.js";
import { PerformanceTools } from "../../src/hosted/performance.js";

const reference = (duration = 4) => midiReference([{ time: 0, duration, pitch: 69 }]);
function perform(step, missing = false) {
  const score = new ReferenceScore(reference());
  score.anchor(0);
  for (let frame = 1; frame <= Math.round(4 / step); frame++)
    score.update(frame * step, missing && frame * step > 2 ? null : 440, 0);
  return score;
}

test("ported Nightingale similarity accepts octave shifts and scales semitone errors", () => {
  assert.equal(pitchSimilarity(440, 880), 1);
  assert.ok(Math.abs(pitchSimilarity(440, 440 * 2 ** (1 / 12)) - 5 / 6) < 1e-10);
  assert.equal(pitchSimilarity(440, 440 * 2 ** (6 / 12)), 0);
  const score = new PitchScoring(1);
  score.accumulate(100, 440, 440, 1);
  assert.equal(score.score(), 100); // upstream caps an update at 100 ms
});

test("time weighting is independent of polling frequency; missed vocals reduce the final score", () => {
  assert.equal(perform(0.02).result().value, 100);
  assert.equal(perform(0.05).result().value, 100);
  assert.equal(perform(0.05, true).result().value, 50);
  const score = new ReferenceScore(reference());
  score.anchor(0);
  for (let i = 1; i <= 80; i++) score.update(i * 0.05, null, 0);
  assert.equal(score.result().value, 0);
  assert.equal(score.result().samples, 80);
});

test("overlapping MIDI notes count singable time once and instrumental gaps award no credit", () => {
  const guide = midiReference([{ time: 1, duration: 2, pitch: 69 }, { time: 2, duration: 2, pitch: 81 }]);
  assert.equal(guide.duration, 3);
  assert.deepEqual(guide.at(0), []);
  const score = new ReferenceScore(guide);
  score.anchor(0);
  for (let i = 1; i <= 20; i++) score.update(i * 0.05, 440, 0);
  assert.ok(score.result().value < 2);
});

test("replaying, seeking, paused time and buffering cannot inflate earned credit", () => {
  const score = perform(0.05, true), earned = score.scorer.earned;
  for (let i = 1; i <= 80; i++) score.update(i * 0.05, 440, 0);
  assert.equal(score.scorer.earned, earned);
  for (let i = 0; i < 20; i++) score.update(4, 440, 0);
  assert.equal(score.scorer.earned, earned);
  const skipped = new ReferenceScore(reference());
  skipped.anchor(0);
  skipped.update(3, 440, 0);
  assert.equal(skipped.result().value, 0);
  skipped.anchor(3); // paused/buffering update
  skipped.update(3, 440, 0);
  assert.equal(skipped.result().value, 0);
  skipped.update(3.05, 440, 0);
  assert.ok(skipped.result().value > 0);
});

test("microphone delay uses the earlier reference position and stays within 0–500 ms", () => {
  const guide = midiReference([{ time: 0, duration: 1, pitch: 69 }, { time: 1, duration: 1, pitch: 75 }]);
  const delayed = new ReferenceScore(guide), immediate = new ReferenceScore(guide);
  delayed.anchor(1); immediate.anchor(1);
  delayed.update(1.05, 440, 0.08); immediate.update(1.05, 440, 0);
  assert.ok(delayed.result().value > immediate.result().value);
  const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
  tools.setLatency(120); assert.equal(tools.latency, 0.12);
  for (const value of [-1, 501, "bad"]) assert.throws(() => tools.setLatency(value), /invalid_microphone_latency/);
});

test("prepared vocal references match upstream singable-duration analysis and support cancellation", async () => {
  const sampleRate = 48000;
  const samples = Float32Array.from({ length: sampleRate * 2 }, (_, i) =>
    i < sampleRate ? 0.3 * Math.sin(2 * Math.PI * 440 * i / sampleRate) : 0);
  const buffer = { sampleRate, numberOfChannels: 1, duration: 2, getChannelData: () => samples };
  const guide = await vocalReference(buffer);
  assert.equal(guide.duration, computeSingableTime(buffer));
  assert.ok(Math.abs(guide.at(0.5)[0] - 440) < 1);
  assert.deepEqual(guide.at(1.5), []);
  assert.deepEqual(guide.at(-1), []);
  await assert.rejects(vocalReference(buffer, () => false), /reference_cancelled/);
  await assert.rejects(vocalReference({ ...buffer, duration: 601 }), /reference_limit/);
});

test("track replacement resets scoring; late reference preparation cannot update the next song", async () => {
  const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
  const player = { guideNotes: [{ time: 0, duration: 4, pitch: 69 }] };
  await tools.prepareReference(player, {}, null, () => true);
  assert.equal(tools.mode, "guide");
  tools.referenceScore = perform(0.05);
  assert.equal(tools.result().value, 100);
  tools.trackChanged();
  assert.equal(tools.result(), undefined);
  let resolve;
  const pending = tools.prepareReference({ guideNotes: [], context: {} }, { referenceId: "old" },
    () => new Promise(r => { resolve = r; }), () => false);
  tools.trackChanged();
  resolve(new ArrayBuffer(0));
  await pending;
  assert.equal(tools.referenceScore, null);
  assert.equal(tools.references.size, 0);
});

test("display performance tools use Nightingale scoring and retain missed-vocal samples", async () => {
  const labels = [];
  const tools = new PerformanceTools({ status() {}, score: label => labels.push(label), recording() {} });
  const player = { guideNotes: [{ time: 0, duration: 4, pitch: 69 }], valid: () => true,
    loaded: "song", audio: { currentTime: 0, paused: false, playbackRate: 1 } };
  await tools.prepareReference(player, {}, null, () => true);
  tools.context = { sampleRate: 48000 };
  tools.buffer = new Float32Array(2048);
  tools.analyser = { getFloatTimeDomainData: buffer => {
    buffer.forEach((_sample, i) => { buffer[i] = player.audio.currentTime <= 2 ? 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000) : 0; });
  } };
  tools.setLatency(0);
  for (let frame = 1; frame <= 80; frame++) {
    player.audio.currentTime = frame * 0.05;
    tools.update(player);
  }
  assert.deepEqual(tools.result(), { value: 50, samples: 80, mode: "guide" });
  assert.ok(labels.at(-1).startsWith("Nightingale pitch match"));
});
