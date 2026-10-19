/* SPDX-License-Identifier: GPL-3.0-only
 * Adapted from rzru/nightingale, commit ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca.
 * Copyright: Nightingale contributors. See THIRD_PARTY_NOTICES.md and LICENSE.txt.
 * Modified for Encore Karaoke on 2026-10-19: JavaScript modules and local imports.
 */
import {
  PITCH_BUFFER_SIZE,
  PITCH_WINDOW_SAMPLES,
  PUSH_INTERVAL_SEC,
  SEMITONE_TOLERANCE,
  SMOOTHING
} from "./constants.js";
import { createPitchDetector, detectPitchFromSamplesRef } from "./detect.js";
function freqToSemitone(hz) {
  return 12 * Math.log2(hz / 440) + 69;
}
function pitchSimilarity(refHz, userHz) {
  const refSemi = freqToSemitone(refHz);
  const userSemi = freqToSemitone(userHz);
  let diff = Math.abs(refSemi - userSemi) % 12;
  if (diff > 6) {
    diff = 12 - diff;
  }
  return Math.max(0, 1 - diff / SEMITONE_TOLERANCE);
}
function ema(prev, current) {
  if (current === null || current === void 0) {
    return null;
  }
  if (prev === null || prev === void 0) {
    return current;
  }
  return prev * SMOOTHING + current * (1 - SMOOTHING);
}
function snapToRefOctave(refSemi, userSemi) {
  const d = userSemi - refSemi;
  const octaveOffset = Math.round(d / 12) * 12;
  return userSemi - octaveOffset;
}
class PitchStateBuffer {
  refPitches = [];
  userPitches = [];
  similarities = [];
  smoothedRef = null;
  smoothedUser = null;
  lastPushTime = 0;
  tryPush(refPitch, userPitch, similarity, time) {
    this.smoothedRef = ema(this.smoothedRef, refPitch);
    this.smoothedUser = ema(this.smoothedUser, userPitch);
    if (time - this.lastPushTime < PUSH_INTERVAL_SEC) {
      return;
    }
    this.lastPushTime = time;
    if (this.refPitches.length >= PITCH_BUFFER_SIZE) {
      this.refPitches.shift();
      this.userPitches.shift();
      this.similarities.shift();
    }
    this.refPitches.push(this.smoothedRef);
    this.userPitches.push(this.smoothedUser);
    this.similarities.push(similarity);
  }
  snapshot() {
    return {
      refPitches: [...this.refPitches],
      userPitches: [...this.userPitches],
      similarities: [...this.similarities]
    };
  }
  reset() {
    this.refPitches = [];
    this.userPitches = [];
    this.similarities = [];
    this.smoothedRef = null;
    this.smoothedUser = null;
    this.lastPushTime = 0;
  }
}
class PitchScoring {
  totalSingable;
  earned = 0;
  lastTime = 0;
  constructor(totalSingable) {
    this.totalSingable = Math.max(0.5, totalSingable);
  }
  accumulate(currentTime, refPitch, userPitch, similarity) {
    const dt = Math.min(0.1, Math.max(0, currentTime - this.lastTime));
    this.lastTime = currentTime;
    if (refPitch !== null && userPitch !== null) {
      this.earned += similarity * dt;
    }
  }
  score() {
    return Math.round(Math.min(1e3, Math.max(0, this.earned / this.totalSingable * 1e3)));
  }
}
function computeSingableTime(vocals) {
  const sr = vocals.sampleRate;
  const ch = vocals.numberOfChannels > 0 ? vocals.getChannelData(0) : null;
  if (ch === null) {
    return 0;
  }
  const hop = PITCH_WINDOW_SAMPLES / 2;
  const hopSec = hop / sr;
  const detector = createPitchDetector();
  const window = new Float32Array(PITCH_WINDOW_SAMPLES);
  let total = 0;
  let offset = 0;
  while (offset + PITCH_WINDOW_SAMPLES <= ch.length) {
    window.set(ch.subarray(offset, offset + PITCH_WINDOW_SAMPLES));
    if (detectPitchFromSamplesRef(detector, window, sr) !== null) {
      total += hopSec;
    }
    offset += hop;
  }
  return total;
}
function sampleVocalsWindow(vocals, timeSec, out, latencyCompensationSec) {
  if (!vocals || out.length !== PITCH_WINDOW_SAMPLES) {
    return false;
  }
  const sr = vocals.sampleRate;
  const start = Math.floor(Math.max(0, timeSec - latencyCompensationSec) * sr);
  const ch = vocals.numberOfChannels > 0 ? vocals.getChannelData(0) : null;
  if (!ch || start + out.length > ch.length) {
    return false;
  }
  out.set(ch.subarray(start, start + out.length));
  return true;
}
export {
  PitchScoring,
  PitchStateBuffer,
  computeSingableTime,
  freqToSemitone,
  pitchSimilarity,
  sampleVocalsWindow,
  snapToRefOctave
};
