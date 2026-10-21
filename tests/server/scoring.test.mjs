import { test } from "node:test";
import assert from "node:assert/strict";
import { PitchScoring, pitchSimilarity, computeSingableTime } from "../../src/hosted/scoring/state.js";
import { ReferenceScore, midiReference, vocalReference } from "../../src/hosted/scoring/reference.js";
import { PerformanceTools } from "../../src/hosted/performance.js";
import { InputScore } from "../../src/hosted/scoring/input-score.js";
import { inputStatusText } from "../../src/hosted/input-status.js";

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
  const input = new InputScore({ id: "local", label: "Display microphone", source: "display" }, tools.reference, 0);
  input.referenceScore = perform(0.05);
  tools.inputScores.set("local", input);
  assert.equal(tools.result().value, 100);
  tools.trackChanged();
  assert.equal(tools.result(), undefined);
  let resolve;
  const pending = tools.prepareReference({ guideNotes: [], context: {} }, { referenceId: "old" },
    () => new Promise(r => { resolve = r; }), () => false);
  tools.trackChanged();
  resolve(new ArrayBuffer(0));
  await pending;
  assert.equal(tools.inputScores.size, 0);
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
  assert.deepEqual(tools.result(), { value: 50, samples: 80, mode: "guide", aggregation: "mean",
    inputs: [{ id: "local", label: "Display microphone", source: "display", value: 50, samples: 80, mode: "guide" }] });
  assert.ok(labels.at(-1).startsWith("Nightingale pitch match"));
});

test("live references score queued microphone samples once data arrives and withhold provisional results", () => {
  const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
  tools.setLatency(0);
  tools.beginLiveReference();
  const input = new InputScore({ id: "phone", label: "Phone 1", source: "phone" }, tools.reference, 0);
  tools.inputScores.set("phone", input);
  input.update(.05, 440, 0, 1, tools.liveReference);
  input.update(.1, 440, 0, 1, tools.liveReference);
  tools.updateLiveReference({ pitches: Array(100).fill(440), step: 1024 / 44100,
    through: 2, singable: 2, complete: false });
  assert.equal(input.pending.length, 0);
  assert.ok(input.referenceScore.scorer.earned > 0);
  assert.equal(tools.result(), undefined);
  const earned = input.referenceScore.scorer.earned;
  tools.updateLiveReference({ pitches: Array(100).fill(440), step: 1024 / 44100,
    through: 2, singable: 2, complete: true });
  assert.equal(input.referenceScore.scorer.earned, earned);
  assert.throws(() => tools.updateLiveReference({ pitches: [], step: 1024 / 44100,
    through: 1, singable: 1, complete: true }), /invalid_live_reference/);
  tools.trackChanged();
  assert.equal(tools.liveReference, null);
});

for (const mode of ["guide", "stability", "live"]) {
  test(`phone audio produces a final ${mode} score without a TV microphone or pitch graph`, async () => {
    const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
    const player = { guideNotes: [{ time: 0, duration: 4, pitch: 69 }], valid: () => true,
      loaded: "song", audio: { currentTime: 0, paused: false, playbackRate: 1 } };
    let reads = 0, silent = false;
    const analyser = { disconnect() {}, getFloatTimeDomainData(buffer) {
      reads++;
      buffer.forEach((_, i) => { buffer[i] = silent ? 0 : .3 * Math.sin(2 * Math.PI * 440 * i / 48000); });
    } };
    const source = { connect() {}, disconnect() {} };
    tools.attachRemoteMicrophone("phone", source, { sampleRate: 48000, createAnalyser: () => analyser });
    tools.setLatency(0);
    if (mode === "guide") await tools.prepareReference(player, {}, null, () => true);
    if (mode === "live") tools.beginLiveReference();
    for (let frame = 1; frame <= 80; frame++) {
      player.audio.currentTime = frame * .05;
      tools.update(player);
    }
    assert.equal(reads, 80, "analyse phone audio only once per scoring frame");
    if (mode === "live") {
      assert.equal(tools.result(), undefined);
      tools.updateLiveReference({ pitches: Array(173).fill(440), step: 1024 / 44100,
        through: 4, singable: 4, complete: true });
    }
    assert.equal(tools.result().mode, mode === "stability" ? "stability" : "guide");
    assert.equal(tools.result().value, 100);
    const samples = tools.result().samples;
    player.audio.paused = true;
    player.audio.currentTime += .05;
    tools.update(player);
    assert.equal(tools.result().samples, samples);
    assert.equal(reads, 80);
    tools.trackChanged();
    assert.equal(tools.result(), undefined);
    assert.equal(tools.remoteInputs.size, 1, "phones remain attached across songs");
    if (mode === "guide") {
      player.audio.currentTime = 0;
      player.audio.paused = false;
      await tools.prepareReference(player, {}, null, () => true);
      for (let frame = 1; frame <= 80; frame++) {
        silent = frame > 40;
        player.audio.currentTime = frame * .05;
        tools.update(player);
      }
      assert.equal(tools.result().value, 50, "missed phone vocals reduce the final score");
    }
    tools.detachRemoteMicrophone("phone");
    assert.equal(tools.remoteInputs.size, 0);
  });
}

for (const live of [false, true]) {
  test(`simultaneous microphones receive independent ${live ? "streamed" : "prepared"} scores and an equal group average`, async () => {
    const activity = [];
    const tools = new PerformanceTools({ status() {}, score() {}, inputs: rows => activity.push(rows) });
    const player = { guideNotes: [{ time: 0, duration: 4, pitch: 69 }], valid: () => true,
      loaded: "song", audio: { currentTime: 0, paused: false, playbackRate: 1 } };
    tools.setLatency(0);
    if (live) tools.beginLiveReference(); else await tools.prepareReference(player, {}, null, () => true);
    const reads = { display: 0, phone: 0 };
    const analyser = (id, frequency) => ({ disconnect() {}, getFloatTimeDomainData(buffer) {
      reads[id]++;
      buffer.forEach((_, i) => { buffer[i] = .3 * Math.sin(2 * Math.PI * frequency * i / 48000); });
    } });
    tools.context = { sampleRate: 48000 };
    tools.buffer = new Float32Array(2048);
    tools.analyser = analyser("display", 440);
    tools.attachRemoteMicrophone("phone", { connect() {}, disconnect() {} },
      { sampleRate: 48000, createAnalyser: () => analyser("phone", 440 * 2 ** .5) }, "Alex");
    for (let frame = 1; frame <= 80; frame++) {
      player.audio.currentTime = frame * .05; tools.update(player);
    }
    assert.deepEqual(reads, { display: 80, phone: 80 });
    assert.equal(activity.at(-1).length, 2);
    assert.ok(activity.at(-1).every(input => input.rms > .1 && input.pitch !== null));
    assert.notEqual(activity.at(-1)[0].color, activity.at(-1)[1].color);
    assert.match(inputStatusText(activity.at(-1)[1]), /Voice detected/);
    if (live) {
      assert.equal(tools.result(), undefined);
      tools.updateLiveReference({ pitches: Array(173).fill(440), step: 1024 / 44100,
        through: 4, singable: 4, complete: true });
    }
    const result = tools.result();
    assert.equal(result.inputs[0].value, 100);
    assert.ok(result.inputs[1].value < 1, "a perfect display voice cannot mask an out-of-tune phone");
    assert.equal(result.inputs[1].label, "Phone 1 · Alex");
    assert.equal(result.value, 50);
    assert.equal(result.aggregation, "mean");
    tools.detachRemoteMicrophone("phone");
    assert.equal(tools.result().inputs[1].value, result.inputs[1].value, "retain finished phone scores after disconnect");
    tools.trackChanged();
    assert.equal(tools.result(), undefined);
    assert.equal(tools.inputScores.size, 0);
  });
}

test("one delayed input cannot suppress another input's result; unavailable inputs are excluded from the group", () => {
  const tools = new PerformanceTools({ status() {}, score() {} }); tools.beginLiveReference();
  const good = new InputScore({ id: "one", source: "phone", label: "Phone 1" }, tools.reference, 0);
  const failed = new InputScore({ id: "two", source: "phone", label: "Phone 2" }, tools.reference, 0);
  tools.inputScores.set("one", good); tools.inputScores.set("two", failed);
  for (let frame = 1; frame <= 80; frame++) good.update(frame * .05, 440, 0, 1, tools.liveReference);
  for (let frame = 1; frame <= 401; frame++) failed.update(frame * .05, 440, 0, 1, tools.liveReference);
  tools.updateLiveReference({ pitches: Array(173).fill(440), step: 1024 / 44100,
    through: 4, singable: 4, complete: true });
  assert.equal(tools.result().value, 100);
  assert.equal(tools.result().inputs[1].value, null);
  assert.match(tools.result().inputs[1].reason, /fell behind/);
});

test("input diagnostics distinguish receipt from silence, pitch detection and waiting for playback", () => {
  assert.match(inputStatusText({ active: true, pitch: null, rms: 0 }), /Silent/);
  assert.match(inputStatusText({ active: true, pitch: null, rms: .1 }), /Audio received.*no clear pitch/);
  assert.equal(inputStatusText({ active: true, pitch: 69, rms: .1 }), "Voice detected · A4");
  assert.match(inputStatusText({ active: false, pitch: null, rms: 0 }), /waiting for playback/);
});
