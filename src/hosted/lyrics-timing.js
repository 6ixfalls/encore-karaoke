/* SPDX-License-Identifier: GPL-3.0-only
 * Adapted from rzru/nightingale, ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca.
 * Copyright: Nightingale contributors. See THIRD_PARTY_NOTICES.md.
 * Modified 2026-10-20: browser canvas and Encore playback adapters.
 */
// Small timing leads keep lyric transitions visually in sync with the audio.
export const LYRICS_LEAD = 0.15;
export const WORD_HIGHLIGHT_LEAD = 0.25;
export const SEGMENT_LINGER = 0.5;
export const GAP_THRESHOLD_SEC = 3.5;
export const BUBBLE_COUNTDOWN_SEC = 3.0;
/** Finds the displayed segment, using `hint` to skip already-passed entries. */
export function findCurrentSegment(segments, time, hint) {
    const start = hint < segments.length && time >= segments[hint].start - LYRICS_LEAD ? hint : 0;
    for (let i = start; i < segments.length; i++) {
        if (time >= segments[i].end + SEGMENT_LINGER) {
            const next = i + 1;
            // Keep a finished line through short pauses until the next line's lead-in.
            if (next < segments.length &&
                segments[next].start - segments[i].end < GAP_THRESHOLD_SEC &&
                time < segments[next].start - LYRICS_LEAD) {
                return i;
            }
            continue;
        }
        const next = i + 1;
        if (next < segments.length && time >= segments[next].start - LYRICS_LEAD) {
            continue;
        }
        return i;
    }
    return Math.max(0, segments.length - 1);
}
const segmentEdges = (segments, index) => ({
    gapBefore: index === 0 ? segments[index].start : segments[index].start - segments[index - 1].end,
    nextStart: index + 1 < segments.length ? segments[index + 1].start : Infinity,
});
export function segmentVisibility(segments, index, time) {
    const segment = segments[index];
    const { gapBefore, nextStart } = segmentEdges(segments, index);
    const timeUntil = segment.start - time;
    const isActive = time >= segment.start - LYRICS_LEAD && time <= segment.end + SEGMENT_LINGER;
    const showCountdown = gapBefore >= GAP_THRESHOLD_SEC && timeUntil > 0 && timeUntil <= BUBBLE_COUNTDOWN_SEC;
    const bridgeShortGap = time > segment.end + SEGMENT_LINGER && nextStart - segment.end < GAP_THRESHOLD_SEC;
    const showCurrent = isActive || showCountdown || bridgeShortGap;
    const nextIsContinuous = index + 1 < segments.length && nextStart - segment.end < GAP_THRESHOLD_SEC;
    const inLongGap = gapBefore >= GAP_THRESHOLD_SEC && timeUntil > LYRICS_LEAD;
    const showNext = [showCurrent, nextIsContinuous, !inLongGap || showCountdown].every(Boolean);
    return {
        segment,
        isActive,
        bridgeShortGap,
        showCountdown,
        showCurrent,
        showNext,
        timeUntil,
    };
}

// Hosted cues use time/end rather than transcript start/end.
export function lyricFrame(lines, time) {
  if (!lines?.length) return { index: -1, showCurrent: false, showNext: false };
  const segments = lines.map((line, i) => ({ start: line.time, end: line.end ?? lines[i + 1]?.time ?? Infinity }));
  const index = findCurrentSegment(segments, time, 0);
  return { index, ...segmentVisibility(segments, index, time) };
}
