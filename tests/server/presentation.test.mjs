import { test } from "node:test";
import assert from "node:assert/strict";
import { gapPresentation, rankForScore } from "../../src/hosted/presentation.ts";
import { defaults, validatePreferences } from "../../src/hosted/preferences.ts";
import { Romanization } from "../../dist/server/romanization.js";
import { Romanizer } from "../../src/hosted/romanizer.ts";
import { PerformanceTools } from "../../src/hosted/performance.js";

const cues = [{ time: 10, end: 15, text: "One" }, { time: 30, end: 35, text: "Two" }];
test("vocal countdowns and interludes follow cue gaps and rewind without timers", () => {
  assert.deepEqual(gapPresentation([], 0), { countdown: null, interlude: false });
  assert.equal(gapPresentation(cues, 7).countdown, 3);
  assert.equal(gapPresentation(cues, 9.9).countdown, 1);
  assert.equal(gapPresentation(cues, 10).countdown, null);
  assert.equal(gapPresentation(cues, 16).interlude, true);
  assert.equal(gapPresentation(cues, 27).interlude, false);
  assert.equal(gapPresentation(cues, 27).countdown, 3);
  assert.equal(gapPresentation(cues, 10).interlude, false);
  assert.equal(gapPresentation(cues, 40).interlude, false);
  assert.equal(gapPresentation([{ time: 0, end: 5, text: "a" }, { time: 6, end: 8, text: "b" }], 5.5).countdown, null);
});
test("score thresholds preserve upstream ranks", () => {
  assert.equal(rankForScore(100)[0], "HOW DID YOU PULL THAT OFF");
  assert.equal(rankForScore(98)[0], "WHAT");
  assert.equal(rankForScore(90)[0], "EXCELLENT");
  assert.equal(rankForScore(80)[0], "GREAT");
  assert.equal(rankForScore(60)[0], "GOOD");
  assert.equal(rankForScore(50)[0], "DECENT");
  assert.equal(rankForScore(20)[0], "NICE TRY");
});
test("saved preferences reject malformed effects and unsafe font values", () => {
  const value = validatePreferences({ lyricFont: 'evil";font', lyricSize: 9, echo: Infinity,
    eq: [0, 0, 0, 0, 0, 0, 99], monitoring: "true", lyricAlignment: "right", romanization: false });
  assert.equal(value.lyricFont, defaults.lyricFont); assert.equal(value.lyricSize, 1);
  assert.deepEqual(value.eq, defaults.eq); assert.equal(value.monitoring, false);
  assert.equal(value.echo, 0); assert.equal(value.lyricAlignment, "right"); assert.equal(value.romanization, false);
  value.eq[0] = 4; assert.equal(defaults.eq[0], 0);
});
test("Japanese uses the upstream local analyzer, Korean stays in the browser", async () => {
  const service = new Romanization();
  const result = await service.convert("日本語"); assert.match(result, /nihongo/i);
  assert.equal(await service.convert("日本語"), result);
  assert.equal(await service.convert("English"), "");
  let calls = 0;
  const romanizer = new Romanizer({ request: async () => { calls++; return { text: result }; } }, () => "room");
  assert.match(await romanizer.romanize("한국어"), /hangug/i); assert.equal(calls, 0);
  assert.equal(await romanizer.romanize("日本語"), result); assert.equal(calls, 1);
});
test("transposition shifts the live target without changing raw reference pitches", () => {
  const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
  tools.beginLiveReference();
  tools.updateLiveReference({ pitches: [440, null, 440], through: 1, step: 1024 / 44100, complete: true, singable: .1 });
  tools.setTranspose(12);
  assert.equal(tools.reference.at(0)[0], 440);
  assert.equal(tools.displayReference.at(0)[0], 880);
  assert.deepEqual(tools.displayReference.pitches, [880, null, 880]);
  tools.setTranspose(-12); assert.equal(tools.displayReference.at(0)[0], 220);
});
