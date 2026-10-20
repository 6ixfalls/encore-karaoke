// SPDX-License-Identifier: GPL-3.0-only
import { freqToSemitone } from "./state.js";

const COLORS = ["#6ee7ff", "#ff95d5", "#ffd477", "#b9a0ff", "#a5f5a0"];
export const noteName = pitch => {
  const midi = Math.round(pitch);
  return `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"][((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
};
// Diatonic coordinates keep each octave seven staff steps apart; accidentals
// sit between their neighboring natural notes. Never fold singers into a target octave.
export function staffPosition(pitch) {
  const octave = Math.floor(pitch / 12), semitone = pitch - octave * 12;
  const steps = [0, .5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7];
  const index = Math.floor(semitone);
  return octave * 7 + steps[index] + (steps[index + 1] - steps[index]) * (semitone - index);
}
export function targetBars(reference, start, end, step = .04) {
  const bars = [], active = new Map();
  for (let time = Math.max(0, start); time < end; time += step) {
    appendBars(reference, time, Math.min(end, time + step), bars, active);
  }
  return bars;
}
function appendBars(reference, time, end, bars, active) {
  const pitches = new Set((reference?.at(time) || []).filter(hz => hz > 0 && Number.isFinite(hz)).map(hz => Math.round(freqToSemitone(hz))));
  for (const pitch of active.keys()) if (!pitches.has(pitch)) active.delete(pitch);
  for (const pitch of pitches) {
    let bar = active.get(pitch);
    if (!bar) { bar = { start: time, end: time, pitch }; bars.push(bar); active.set(pitch, bar); }
    bar.end = end;
  }
}

// Build each reference's target geometry once. Live references append only
// fully available steps; a seek or visibility toggle reuses the same geometry.
export class TargetBarCache {
  constructor() { this.references = new WeakMap(); }
  get(reference, start, end) {
    if (!reference) return [];
    let cached = this.references.get(reference);
    if (!cached) {
      cached = { bars: [], active: new Map(), steps: 0 };
      this.references.set(reference, cached);
    }
    const step = .04, through = reference.end ?? end;
    const count = reference.complete === false ? Math.floor(through / step) : Math.ceil(through / step);
    while (cached.steps < count) {
      const time = cached.steps++ * step;
      appendBars(reference, time, Math.min(through, cached.steps * step), cached.bars, cached.active);
    }
    return cached.bars.filter(bar => bar.end >= start && bar.start <= end);
  }
}
export function staffRange(bars, singers, time) {
  const pitches = bars.filter(b => b.end >= time - .2 && b.start <= time + 1.5).map(b => b.pitch);
  for (const singer of singers) if (singer.pitch !== null) pitches.push(singer.pitch);
  const low = pitches.length ? Math.min(...pitches) : 60, high = pitches.length ? Math.max(...pitches) : 72;
  return { center: (staffPosition(low) + staffPosition(high)) / 2, span: Math.max(14, staffPosition(high) - staffPosition(low) + 6) };
}

export class PitchStaff {
  constructor(container, canvas) {
    Object.assign(this, { container, canvas });
    this.targets = new TargetBarCache();
    this.enabled = false;
    this.reset();
  }
  reset() { this.history = new Map(); this.lastTime = null; this.center = null; this.span = 14; }
  setEnabled(enabled) { this.enabled = enabled; this.container.hidden = !enabled; this.reset(); }
  render({ time, reference, singers, active, latency = 0 }) {
    if (!this.enabled) return;
    const now = time - latency;
    if (this.lastTime !== null && (now < this.lastTime || now - this.lastTime > .5)) this.reset();
    const bars = this.targets.get(reference, now - 2, now + 6);
    const range = staffRange(bars, singers, now);
    this.center = this.center === null ? range.center : this.center + (range.center - this.center) * .25;
    // Expand immediately for octave leaps; contract gently between phrases.
    this.span = Math.max(range.span + 2 * Math.abs(range.center - this.center), this.span + (range.span - this.span) * .08,
      ...singers.filter(s => s.pitch !== null).map(s => 2 * Math.abs(staffPosition(s.pitch) - this.center) + 4));
    const ids = new Set(singers.map(s => s.id));
    for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id);
    singers.forEach(singer => {
      const history = this.history.get(singer.id) || [];
      if (active && now !== this.lastTime) history.push({ time: now, pitch: singer.pitch });
      while (history.length && (history[0].time < now - 2 || history.length > 100)) history.shift();
      this.history.set(singer.id, history);
    });
    this.lastTime = now;
    const width = this.canvas.clientWidth || 960, height = this.canvas.clientHeight || 180;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 48, plot = width - left - 16;
    const x = t => left + (t - now + 2) / 8 * plot;
    const y = p => height / 2 - (staffPosition(p) - this.center) / this.span * (height - 24);
    ctx.font = "12px sans-serif";
    // Five staff lines move with the register. Labeled C lines identify octaves.
    const base = Math.round(this.center / 7) * 7;
    for (let offset = -4; offset <= 4; offset += 2) {
      const lineY = height / 2 - (base + offset - this.center) / this.span * (height - 24);
      ctx.strokeStyle = "#ffffff35"; ctx.beginPath(); ctx.moveTo(left, lineY); ctx.lineTo(width - 16, lineY); ctx.stroke();
    }
    for (let midi = 24; midi <= 108; midi += 12) {
      const lineY = y(midi);
      if (lineY < 10 || lineY > height - 6) continue;
      ctx.fillStyle = "#c5c9da"; ctx.fillText(noteName(midi), 8, lineY + 4);
      ctx.strokeStyle = "#ffffff18"; ctx.beginPath(); ctx.moveTo(left, lineY); ctx.lineTo(width - 16, lineY); ctx.stroke();
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, 0, plot, height); ctx.clip();
    ctx.lineCap = "round";
    for (const bar of bars) {
      ctx.strokeStyle = bar.start <= now && bar.end >= now ? "#fff2a6" : "#e9ca6c99";
      ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(x(bar.start), y(bar.pitch)); ctx.lineTo(x(bar.end), y(bar.pitch)); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.strokeStyle = "#ffffffaa";
    ctx.beginPath(); ctx.moveTo(x(now), 0); ctx.lineTo(x(now), height); ctx.stroke();
    const targets = reference?.at(now) || [];
    singers.forEach((singer, index) => {
      const color = COLORS[index % COLORS.length];
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath();
      let previous = null;
      for (const sample of this.history.get(singer.id)) {
        if (sample.pitch === null) { previous = null; continue; }
        if (previous && sample.time - previous.time < .15) ctx.lineTo(x(sample.time), y(sample.pitch));
        else ctx.moveTo(x(sample.time), y(sample.pitch));
        previous = sample;
      }
      ctx.stroke();
      if (singer.pitch === null || !active) return;
      const match = targets.some(hz => Math.abs(freqToSemitone(hz) - singer.pitch) < .5);
      ctx.fillStyle = color; ctx.strokeStyle = match ? "#a5f5a0" : "#fff"; ctx.lineWidth = match ? 4 : 1.5;
      ctx.beginPath(); ctx.arc(x(now), y(singer.pitch), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillText(String(index + 1), x(now) + 10, y(singer.pitch) - 5);
    });
    ctx.restore();
  }
}
