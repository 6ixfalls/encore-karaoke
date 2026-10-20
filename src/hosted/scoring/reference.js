// SPDX-License-Identifier: GPL-3.0-only
// Encore adapter around the Nightingale scorer. See THIRD_PARTY_NOTICES.md.
import { PitchScoring, pitchSimilarity } from "./state.js";
import { createPitchDetector, detectPitchFromSamplesRef } from "./detect.js";
import { PITCH_WINDOW_SAMPLES } from "./constants.js";

export const midiHz = (pitch) => 440 * 2 ** ((pitch - 69) / 12);

export function midiReference(notes) {
  const intervals = notes.filter(n => Number.isFinite(n.time) && Number.isFinite(n.duration) && n.duration > 0)
    .map(n => [Math.max(0, n.time), Math.max(0, n.time + n.duration)]).sort((a, b) => a[0] - b[0]);
  let duration = 0, end = 0;
  for (const [start, stop] of intervals) {
    duration += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return { duration, end, at: time => notes.filter(n => time >= n.time && time < n.time + n.duration).map(n => midiHz(n.pitch)) };
}

/** Same 50%-overlap singable-time scan as Nightingale, yielding between batches.
 * Cache compact pitch frames rather than retaining a decoded song in memory. */
export async function vocalReference(buffer, current = () => true) {
  if (buffer.duration > 600 || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2)
    throw new Error("vocal_reference_limit");
  const samples = buffer.getChannelData(0), hop = PITCH_WINDOW_SAMPLES / 2;
  const step = hop / buffer.sampleRate, pitches = [];
  const detector = createPitchDetector(), window = new Float32Array(PITCH_WINDOW_SAMPLES);
  let duration = 0;
  for (let offset = 0; offset + window.length <= samples.length; offset += hop) {
    if (!current()) throw new Error("reference_cancelled");
    window.set(samples.subarray(offset, offset + window.length));
    const pitch = detectPitchFromSamplesRef(detector, window, buffer.sampleRate);
    pitches.push(pitch);
    if (pitch !== null) duration += step;
    if (pitches.length % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { duration, end: pitches.length * step, at: time => {
    const pitch = time >= 0 ? pitches[Math.floor(time / step)] : null;
    return pitch == null ? [] : [pitch];
  } };
}

export class ReferenceScore {
  constructor(reference) {
    this.reference = reference;
    this.scorer = new PitchScoring(reference.duration);
    this.highWater = 0;
    this.previous = null;
    this.samples = 0;
  }
  anchor(time) {
    this.previous = time;
    this.highWater = Math.max(this.highWater, time);
    this.scorer.lastTime = time;
  }
  update(time, pitch, latency, rate = 1) {
    const previous = this.previous;
    this.previous = time;
    // Pauses, buffering, seeks and replay cannot award unperformed time or
    // award a previously scored region twice. The upstream scorer caps dt too.
    if (previous === null || time <= this.highWater || time - previous > Math.max(0.25, rate * 0.2)) {
      this.anchor(time);
      return;
    }
    const start = Math.max(previous, this.highWater);
    const dt = Math.min(0.1, time - start);
    // Sample the credited interval, including the last frame of a note.
    const targets = this.reference.at(time - latency - dt / 2);
    const similarity = pitch === null || !targets.length ? 0 : Math.max(...targets.map(hz => pitchSimilarity(hz, pitch)));
    this.scorer.lastTime = start;
    this.highWater = time;
    this.scorer.accumulate(time, targets[0] ?? null, pitch, similarity);
    if (targets.length) this.samples++;
  }
  result() {
    return { value: this.scorer.score() / 10, samples: this.samples, mode: "guide" };
  }
}
