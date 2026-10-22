import { test } from "node:test";
import assert from "node:assert/strict";
import { Presentation, gapPresentation, rankForScore } from "../../src/hosted/presentation.ts";
import { defaults, validatePreferences } from "../../src/hosted/preferences.ts";
import { Romanization } from "../../dist/server/romanization.js";
import { Romanizer } from "../../src/hosted/romanizer.ts";
import { PerformanceTools } from "../../src/hosted/performance.js";

const cues = [{ time: 10, end: 15, text: "One" }, { time: 30, end: 35, text: "Two" }];
test("results fade for 400ms before resuming and teardown cancels the pending exit", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const classes = new Set(["visible"]);
  let resumed = 0, valid = true;
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    player: { valid: () => valid },
    results: { hidden: false, classList: { remove: name => classes.delete(name) } },
    stopSound() {}, resume() { resumed++; },
  });
  presentation.skip();
  assert.equal(classes.has("visible"), false);
  assert.equal(presentation.results.hidden, false, "keep the overlay rendered during its fade");
  assert.ok(presentation.player.resultsUntil > performance.now());
  t.mock.timers.tick(200);
  presentation.skip(); // Repeated Enter must not restart the fade.
  t.mock.timers.tick(199);
  assert.equal(resumed, 0);
  t.mock.timers.tick(1);
  assert.equal(presentation.results.hidden, true);
  assert.equal(resumed, 1);
  assert.equal(presentation.player.resultsUntil, 0);
  presentation.results.hidden = false;
  presentation.skip();
  presentation.skip(false);
  t.mock.timers.tick(400);
  assert.equal(resumed, 1, "teardown cancels the pending resume");
  presentation.results.hidden = false;
  presentation.skip();
  valid = false;
  t.mock.timers.tick(400);
  assert.equal(resumed, 1, "an expired lease cannot resume playback");
});
test("song results show missing-score guidance and animate a measured zero score", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const element = () => ({ hidden: true, textContent: "", style: {}, replaceChildren() {}, classList: { add() {}, remove() {} } });
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    preferences: { celebrations: true }, player: { valid: () => true },
    results: element(), scoreTitle: element(), scoreNumber: element(), scoreStatus: element(),
    rank: element(), leaderboard: element(), inputResults: element(), skip() {}, hideStage() {},
  });
  const song = { playbackId: "song", title: "Song", nickname: "Singer" };
  presentation.finish(song, undefined, "Connect a phone microphone.");
  assert.equal(presentation.results.hidden, false);
  assert.equal(presentation.scoreTitle.textContent, "SINGER'S SCORE");
  assert.equal(presentation.scoreNumber.textContent, "—");
  assert.equal(presentation.rank.textContent, "SCORE UNAVAILABLE");
  assert.equal(presentation.scoreStatus.textContent, "Connect a phone microphone.");
  presentation.finish(song, { value: 0, samples: 100, mode: "guide" });
  assert.equal(presentation.scoreNumber.textContent, "0");
  assert.equal(presentation.scoreStatus.hidden, true);
  assert.equal(presentation.rank.textContent, "");
});
test("skipping results cancels delayed fanfare and narration during the fade", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const element = () => ({ hidden: true, textContent: "", style: {}, replaceChildren() {}, classList: { add() {}, remove() {} } });
  const sounds = [];
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    preferences: { celebrations: true, fanfare: true, narration: true }, player: { valid: () => true },
    results: element(), scoreTitle: element(), scoreNumber: element(), scoreStatus: element(),
    rank: element(), leaderboard: element(), inputResults: element(), hideStage() {},
    stopSound() {}, playSound(url) { sounds.push(url); return Promise.resolve(); }, resume() {},
  });
  presentation.finish({ playbackId: "song", title: "Song" }, { value: 80 });
  t.mock.timers.tick(800);
  presentation.skip();
  t.mock.timers.tick(200);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(presentation.results.hidden, false, "the delayed audio fires while the overlay is fading");
  assert.deepEqual(sounds, [], "neither fanfare nor narration can restart after skip");
  t.mock.timers.tick(200);
  assert.equal(presentation.results.hidden, true);
});

test("the outro waits without timing out and reveals the final score without restarting its fade", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const element = () => ({ hidden: true, textContent: "", style: {}, replaceChildren() {}, classList: { add() {}, remove() {} } });
  let resets = 0;
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    preferences: { celebrations: true }, player: { valid: () => true },
    results: element(), scoreTitle: element(), scoreNumber: element(), scoreStatus: element(),
    rank: element(), leaderboard: element(), inputResults: element(),
    skip() { resets++; }, hideStage() {},
  });
  const song = { playbackId: "song", title: "Song" };
  presentation.finish(song, undefined, undefined, [], true);
  assert.equal(presentation.results.hidden, false);
  assert.equal(presentation.rank.textContent, "");
  assert.equal(presentation.scoreStatus.textContent, "Calculating your score…");
  assert.equal(presentation.resultTimer, undefined);
  t.mock.timers.tick(20000);
  assert.equal(presentation.results.hidden, false);
  presentation.finish(song, { value: 80 });
  assert.equal(resets, 1, "keep the overlay visible when the score becomes ready");
  assert.equal(presentation.resultPending, false);
  assert.equal(presentation.scoreStatus.hidden, true);
  assert.equal(presentation.scoreNumber.textContent, "0");
  assert.ok(presentation.resultTimer, "start the celebration timeout only after the score arrives");
});

test("skipping a pending outro prevents a late score from reopening it", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    preferences: { celebrations: true }, player: { valid: () => true },
    results: { hidden: false, classList: { remove() {} } },
    resultPending: true, resultSong: { playbackId: "song" }, stopSound() {}, resume() {},
  });
  presentation.skip();
  t.mock.timers.tick(400);
  presentation.finish({ playbackId: "song", title: "Song" }, { value: 80 });
  assert.equal(presentation.results.hidden, true);
  assert.equal(presentation.player.resultsUntil, 0);
});
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


test("startup reveals without cutting off its sound and remains skippable", t => {
  class Element extends EventTarget {
    children = [];
    properties = new Map();
    style = { setProperty: (key, value) => this.properties.set(key, value) };
    classes = new Set();
    classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    remove() { this.removed = true; }
  }
  const globals = ["document", "window"];
  const descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => globals.forEach((key, i) => {
    if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]); else delete globalThis[key];
  }));
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 3840, innerHeight: 2160 } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let soundStops = 0;
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    preferences: { startupIntro: true }, shell: new Element(), player: { valid: () => false },
    results: Object.assign(new Element(), { hidden: true }), soundVersion: 0,
    playSound() {
      this.sound = { stop() { soundStops++; } };
      return Promise.resolve();
    },
  });
  presentation.startup();
  const layer = presentation.shell.children.at(-1);
  const tiles = layer.children[0];
  t.mock.timers.tick(4000);
  assert.ok(layer.classes.has("animating"));
  t.mock.timers.tick(2400);
  assert.ok(!layer.removed, "do not cut off the reveal with a fixed timeout on a large display");
  const end = name => {
    const event = new Event("animationend");
    Object.defineProperty(event, "animationName", { value: name });
    tiles.dispatchEvent(event);
  };
  end("startupTile");
  assert.ok(!layer.removed, "individual tile animations cannot remove the overlay");
  end("startupReveal");
  assert.equal(layer.removed, true);
  assert.equal(presentation.startupLayer, undefined);
  assert.equal(soundStops, 0, "the sound can finish after the reveal disappears");
  assert.equal(presentation.soundVersion, 0, "the reveal must also allow pending audio to finish loading");
  presentation.startup();
  const secondLayer = presentation.shell.children.at(-1);
  presentation.skip();
  assert.equal(soundStops, 1, "an explicit skip still stops the intro sound");
  t.mock.timers.tick(10000);
  assert.equal(secondLayer.removed, true);
  assert.ok(!secondLayer.classes.has("animating"), "skip cancels the pending intro");
  presentation.startup();
  const reducedMotionLayer = presentation.shell.children.at(-1);
  t.mock.timers.tick(4000);
  assert.ok(!reducedMotionLayer.removed, "the fallback allows time for the full reveal");
  t.mock.timers.tick(10000);
  assert.equal(reducedMotionLayer.removed, true, "dismiss even when reduced motion suppresses animationend");
  assert.equal(presentation.startupLayer, undefined);
  assert.equal(soundStops, 1, "the fallback also lets the sound finish naturally");
  presentation.skip();
  assert.equal(soundStops, 2, "cleanup can stop audio after the overlay has disappeared");
});
