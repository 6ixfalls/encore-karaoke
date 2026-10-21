import { test } from "node:test";
import assert from "node:assert/strict";
import { lyricFrame } from "../../src/hosted/lyrics-timing.js";

const lines = [
  { time: 1, end: 2, text: "First" },
  { time: 4, end: 5, text: "Second" },
  { time: 12, end: 13, text: "Last" },
];
test("upstream captions bridge short gaps, linger, and hide through long breaks", () => {
  assert.equal(lyricFrame(lines, 2.8).index, 0);
  assert.equal(lyricFrame(lines, 2.8).showCurrent, true);
  assert.equal(lyricFrame(lines, 3.85).index, 1);
  assert.equal(lyricFrame(lines, 5.49).showCurrent, true);
  assert.equal(lyricFrame(lines, 5.51).showCurrent, false);
  assert.equal(lyricFrame(lines, 8.99).showCurrent, false);
  assert.equal(lyricFrame(lines, 9).showCountdown, true);
  assert.equal(lyricFrame(lines, 13.49).showCurrent, true);
  assert.equal(lyricFrame(lines, 13.51).showCurrent, false);
  assert.equal(lyricFrame(lines, 2.8).index, 0); // rewind after final cue
  assert.equal(lyricFrame([], 1).showCurrent, false);
});

test("closely spaced cues advance past lingering lines and rewind correctly", () => {
  const rapid = [
    { time: 1, end: 1.3, text: "First" },
    { time: 1.3, end: 1.6, text: "Second" },
    { time: 1.6, end: 2, text: "Third" },
  ];
  assert.equal(lyricFrame(rapid, 1).index, 0);
  assert.equal(lyricFrame(rapid, 1.3).index, 1);
  assert.equal(lyricFrame(rapid, 1.44).index, 1);
  assert.equal(lyricFrame(rapid, 1.46).index, 2);
  assert.equal(lyricFrame(rapid, 1.6).index, 2);
  assert.equal(lyricFrame(rapid, 2.49).showCurrent, true);
  assert.equal(lyricFrame(rapid, 2.51).showCurrent, false);
  assert.equal(lyricFrame(rapid, 1).index, 0);
});
