/* SPDX-License-Identifier: GPL-3.0-only
 * From rzru/nightingale, commit ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca.
 * Copyright: Nightingale contributors. See THIRD_PARTY_NOTICES.md.
 * Modified for Encore Karaoke on 2026-10-19: removed TypeScript syntax.
 */
export const PITCH_WINDOW_SAMPLES = 2048;
export const MIN_PITCH_HZ = 80;
export const MAX_PITCH_HZ = 1000;
export const PITCH_CLARITY_THRESHOLD = 0.4;
export const MIC_PITCH_CLARITY_THRESHOLD = 0.05;
export const REF_RMS_GATE = 0.005;
export const MIC_RMS_GATE = 0.003;
export const PUSH_INTERVAL_SEC = 0.02;
export const SMOOTHING = 0.55;
export const PITCH_BUFFER_SIZE = 200;
export const SEMITONE_TOLERANCE = 6;
export const DEFAULT_MIC_LATENCY_COMPENSATION_SEC = 0.08;
export const MIN_MIC_LATENCY_COMPENSATION_SEC = 0;
export const MAX_MIC_LATENCY_COMPENSATION_SEC = 0.5;
