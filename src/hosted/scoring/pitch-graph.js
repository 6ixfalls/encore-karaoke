/* SPDX-License-Identifier: GPL-3.0-only
 * Adapted from rzru/nightingale, ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca.
 * Copyright: Nightingale contributors. See THIRD_PARTY_NOTICES.md.
 * Modified 2026-10-20: browser canvas and Encore playback adapters.
 */
import { PITCH_BUFFER_SIZE } from './constants.js';
import { freqToSemitone, snapToRefOctave } from './state.js';
const BASE_DISPLAY_WIDTH = 400;
const BASE_DISPLAY_HEIGHT = 44;
const REFERENCE_HEIGHT = 1080;
const MIN_DISPLAY_SCALE = 0.85;
const LOWEST_VISIBLE_SEMITONE = 45;
const VISIBLE_SEMITONE_RANGE = 36;
const OLDEST_POINT_ALPHA = 0.25;
const NEWEST_POINT_ALPHA = 1.0;
const REF_LINE_COLOR = { r: 0.5, g: 0.7, b: 1.0 };
const REF_LINE_ALPHA = 0.55;
const USER_BASE_COLOR = { r: 0.85, g: 0.85, b: 1.0 };
const USER_ALPHA_WITHOUT_REF = 0.55;
const USER_ALPHA_MIN_WITH_REF = 0.35;
const USER_ALPHA_MAX_WITH_REF = 1.0;
const SIMILARITY_GOOD = { r: 0.2, g: 0.9, b: 0.3 };
const SIMILARITY_OK = { r: 0.95, g: 0.8, b: 0.1 };
const SIMILARITY_BAD = { r: 0.9, g: 0.2, b: 0.2 };
const SIMILARITY_OK_THRESHOLD = 0.7;
function displayScale(windowHeight) {
    return Math.max(MIN_DISPLAY_SCALE, windowHeight / REFERENCE_HEIGHT);
}
export function computeLayout(windowHeight, windowWidth, userScale) {
    const scale = displayScale(windowHeight) * userScale;
    const width = Math.min(BASE_DISPLAY_WIDTH * scale, Math.max(240, windowWidth - 32));
    const height = BASE_DISPLAY_HEIGHT * scale;
    const paddingX = 8 * scale;
    const paddingY = 6 * scale;
    return {
        width,
        height,
        paddingX,
        paddingY,
        plotWidth: width - paddingX * 2,
        plotHeight: height - paddingY * 2,
        lineWidth: Math.max(2.25, 2 * scale),
    };
}
function lerpRgb(from, to, t) {
    return {
        r: from.r + (to.r - from.r) * t,
        g: from.g + (to.g - from.g) * t,
        b: from.b + (to.b - from.b) * t,
    };
}
function similarityToColor(similarity) {
    if (similarity >= SIMILARITY_OK_THRESHOLD) {
        const t = (similarity - SIMILARITY_OK_THRESHOLD) / (1 - SIMILARITY_OK_THRESHOLD);
        return lerpRgb(SIMILARITY_OK, SIMILARITY_GOOD, t);
    }
    const t = Math.max(0, similarity / SIMILARITY_OK_THRESHOLD);
    return lerpRgb(SIMILARITY_BAD, SIMILARITY_OK, t);
}
function rgbaString({ r, g, b }, alpha) {
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}
export function semitoneToY(semitone, layout) {
    const normalized = Math.min(1, Math.max(0, (semitone - LOWEST_VISIBLE_SEMITONE) / VISIBLE_SEMITONE_RANGE));
    return layout.paddingY + (1 - normalized) * layout.plotHeight;
}
function indexToX(index, seriesLength, layout) {
    const xStep = layout.plotWidth / (PITCH_BUFFER_SIZE - 1);
    const bufferOffset = PITCH_BUFFER_SIZE - seriesLength;
    return layout.paddingX + (bufferOffset + index) * xStep;
}
function ageAlpha(index, seriesLength) {
    const t = index / Math.max(1, seriesLength - 1);
    return OLDEST_POINT_ALPHA + (NEWEST_POINT_ALPHA - OLDEST_POINT_ALPHA) * t;
}
export function setupCanvas(canvas, ctx, layout) {
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(layout.width * dpr);
    canvas.height = Math.floor(layout.height * dpr);
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
}
function tracePath(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
}
function strokeUniformSegment(ctx, points, lineWidth) {
    if (points.length < 2) {
        return;
    }
    tracePath(ctx, points);
    ctx.strokeStyle = rgbaString(points[0].color, points[0].alpha);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
}
function strokeGradientSegment(ctx, points, lineWidth) {
    if (points.length < 2) {
        return;
    }
    tracePath(ctx, points);
    const gradient = ctx.createLinearGradient(points[0].x, 0, points[points.length - 1].x, 0);
    for (let i = 0; i < points.length; i++) {
        gradient.addColorStop(i / (points.length - 1), rgbaString(points[i].color, points[i].alpha));
    }
    ctx.strokeStyle = gradient;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
}
function buildSegments(values, toPoint) {
    const segments = [];
    let current = [];
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === null) {
            if (current.length >= 2) {
                segments.push(current);
            }
            current = [];
            continue;
        }
        current.push(toPoint(value, i));
    }
    if (current.length >= 2) {
        segments.push(current);
    }
    return segments;
}
function buildReferencePoint(hz, index, seriesLength, layout) {
    return {
        x: indexToX(index, seriesLength, layout),
        y: semitoneToY(freqToSemitone(hz), layout),
        color: REF_LINE_COLOR,
        alpha: REF_LINE_ALPHA * ageAlpha(index, seriesLength),
    };
}
function userPointStyle(similarity, hasRef, baseColor) {
    if (!hasRef) {
        return { color: baseColor, weight: USER_ALPHA_WITHOUT_REF };
    }
    return {
        color: lerpRgb(baseColor, similarityToColor(similarity), similarity),
        weight: USER_ALPHA_MIN_WITH_REF + similarity * (USER_ALPHA_MAX_WITH_REF - USER_ALPHA_MIN_WITH_REF),
    };
}
function buildUserPoint({ userHz, index, series, layout, baseColor }) {
    const seriesLength = series.userPitches.length;
    const refHz = series.refPitches[index];
    const userSemi = freqToSemitone(userHz);
    const displaySemi = refHz !== null ? snapToRefOctave(freqToSemitone(refHz), userSemi) : userSemi;
    const similarity = series.similarities[index] ?? 0;
    const { color, weight } = userPointStyle(similarity, refHz !== null, baseColor);
    return {
        x: indexToX(index, seriesLength, layout),
        y: semitoneToY(displaySemi, layout),
        color,
        alpha: weight * ageAlpha(index, seriesLength),
    };
}
export function drawPitchSeries({ ctx, layout, series, baseColor = USER_BASE_COLOR, includeReference = true, }) {
    const length = series.refPitches.length;
    if (length < 2) {
        return;
    }
    if (includeReference) {
        const refSegments = buildSegments(series.refPitches, (hz, i) => buildReferencePoint(hz, i, length, layout));
        for (const segment of refSegments) {
            strokeUniformSegment(ctx, segment, layout.lineWidth);
        }
    }
    const userSegments = buildSegments(series.userPitches, (userHz, index) => buildUserPoint({ userHz, index, series, layout, baseColor }));
    for (const segment of userSegments) {
        strokeGradientSegment(ctx, segment, layout.lineWidth);
    }
}
