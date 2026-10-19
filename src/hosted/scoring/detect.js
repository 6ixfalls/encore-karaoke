/* SPDX-License-Identifier: GPL-3.0-only
 * Adapted from rzru/nightingale, commit ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca.
 * Copyright: Nightingale contributors. See THIRD_PARTY_NOTICES.md and LICENSE.txt.
 * Modified for Encore Karaoke on 2026-10-19: JavaScript modules and local imports.
 */
import { PitchDetector } from "pitchy";
import {
  MAX_PITCH_HZ,
  MIC_PITCH_CLARITY_THRESHOLD,
  MIC_RMS_GATE,
  MIN_PITCH_HZ,
  PITCH_CLARITY_THRESHOLD,
  PITCH_WINDOW_SAMPLES,
  REF_RMS_GATE
} from "./constants.js";
function rms(samples) {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}
function createPitchDetector() {
  return PitchDetector.forFloat32Array(PITCH_WINDOW_SAMPLES);
}
function createMicPitchDetector() {
  const d = PitchDetector.forFloat32Array(PITCH_WINDOW_SAMPLES);
  d.clarityThreshold = 0.65;
  return d;
}
function detectPitchFromSamplesRef(detector, samples, sampleRate) {
  if (samples.length !== PITCH_WINDOW_SAMPLES) {
    throw new Error(`Expected ${PITCH_WINDOW_SAMPLES} samples`);
  }
  if (rms(samples) < REF_RMS_GATE) {
    return null;
  }
  const [hz, clarity] = detector.findPitch(samples, sampleRate);
  if (clarity < PITCH_CLARITY_THRESHOLD || hz <= 0) {
    return null;
  }
  if (hz < MIN_PITCH_HZ || hz > MAX_PITCH_HZ) {
    return null;
  }
  return hz;
}
function detectPitchFromSamplesMic(detector, samples, sampleRate) {
  if (samples.length !== PITCH_WINDOW_SAMPLES) {
    throw new Error(`Expected ${PITCH_WINDOW_SAMPLES} samples`);
  }
  if (rms(samples) < MIC_RMS_GATE) {
    return null;
  }
  const [hz, clarity] = detector.findPitch(samples, sampleRate);
  if (hz <= 0 || clarity < MIC_PITCH_CLARITY_THRESHOLD) {
    return null;
  }
  if (hz < MIN_PITCH_HZ || hz > MAX_PITCH_HZ) {
    return null;
  }
  return hz;
}
export {
  createMicPitchDetector,
  createPitchDetector,
  detectPitchFromSamplesMic,
  detectPitchFromSamplesRef
};
