import { test } from "node:test";
import assert from "node:assert/strict";
import { HostedLyrics } from "../../src/hosted/lyrics.js";

function fixture(t) {
  const frames = new Map();
  let nextFrame = 0;
  const context = () => new Proxy({
    measureText: (text) => ({ width: Array.from(text).length * 25 }),
  }, { get: (target, key) => target[key] ?? (() => {}) });
  const canvas = () => ({ style: {}, getContext: () => context() });
  const names = ["window", "document", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => names.forEach((name, i) => {
    if (original[i]) Object.defineProperty(globalThis, name, original[i]);
    else delete globalThis[name];
  }));
  Object.assign(globalThis, {
    requestAnimationFrame(fn) {
      frames.set(++nextFrame, fn);
      return nextFrame;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    window: { innerWidth: 1280, devicePixelRatio: 2, addEventListener() {} },
    document: { createElement: canvas },
  });
  const renderer = new HostedLyrics(canvas());
  return { renderer, engine: renderer.engine, frames };
}

const lines = [
  { time: 2, end: 4, text: "First lyric" },
  { time: 4, end: 6, text: "Second lyric" },
  { time: 9, end: 12, text: "Final lyric" },
];
const text = (line) => line.syllables.map((part) => part.text).join("");

test("hosted lyrics alternate in the original renderer and rewind to dim previews", (t) => {
  const { renderer, engine } = fixture(t);
  renderer.update(lines, 2);
  assert.deepEqual(engine.renderableLines.map(text), ["First lyric", "Second lyric"]);
  assert.deepEqual(engine.renderableLines.map((line) => line.isNextLine), [false, true]);
  renderer.update(lines, 4);
  assert.deepEqual(engine.renderableLines.map(text), ["Final lyric", "Second lyric"]);
  assert.deepEqual(engine.renderableLines.map((line) => line.isNextLine), [true, false]);
  renderer.update(lines, 9);
  assert.deepEqual(engine.renderableLines.map(text), ["Final lyric", "Second lyric"]);
  renderer.update(lines, 0);
  assert.deepEqual(engine.renderableLines.map(text), ["First lyric", "Second lyric"]);
  assert.ok(engine.renderableLines.every((line) => line.isNextLine));
  assert.equal(engine.currentMediaTime, 0);
  assert.equal(engine.lastMediaTimeUpdate, null);
});

test("lyric gaps expire the active cue and stopping clears the animation", (t) => {
  const { renderer, engine, frames } = fixture(t);
  renderer.update(lines, 6);
  assert.deepEqual(engine.renderableLines.map(text), ["Final lyric"]);
  assert.equal(engine.renderableLines[0].isNextLine, true);
  renderer.update(lines, 12);
  assert.deepEqual(engine.renderableLines, []);
  renderer.update([], 0);
  assert.equal(frames.size, 0);
  renderer.update(lines, 2);
  assert.equal(frames.size, 1);
  assert.equal(text(engine.renderableLines[0]), "First lyric");
});

test("refreshed lyric snapshots preserve fades and long non-Latin lines wrap", async (t) => {
  const { renderer, engine } = fixture(t);
  renderer.update(lines, 4);
  const layout = engine.renderableLines;
  renderer.update(structuredClone(lines), 4.5);
  assert.equal(engine.renderableLines, layout);
  const japanese = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも".repeat(2);
  renderer.update([{ time: 0, end: 20, text: japanese }], 1);
  await Promise.resolve();
  assert.equal(text(engine.renderableLines[0]), japanese);
  assert.ok(engine.renderableLines[0].rows.length > 1);
});
