// SPDX-License-Identifier: GPL-3.0-only
// Browser adaptation of Encore's FortePianoRoll: paged notes, gold sweep,
// hit/miss gradients and microphone trails. Scoring still uses Nightingale.
import { freqToSemitone, snapToRefOctave } from "./state.js";

export const PIXELS_PER_SECOND = 150;
export const ROLL_HEIGHT = 250;
const PALETTE = {
  neutral: ["#7dd3fc", "#0284c7"],
  hit: ["#a3e635", "#4d7c0f"],
  miss: ["#fca5a5", "#991b1b"],
};

// Turn extracted vocal frames into the same sustained bars as a MIDI guide.
export function guideNotes(reference) {
  if (reference?.notes) return reference.notes.map(n => ({ ...n, startTime: n.time })).sort((a, b) => a.startTime - b.startTime);
  const notes = [];
  for (let i = 0; i < (reference?.pitches?.length || 0); i++) {
    const hz = reference.pitches[i];
    if (hz === null) continue;
    const pitch = Math.round(freqToSemitone(hz));
    const previous = notes.at(-1), startTime = i * reference.step;
    if (previous && previous.pitch === pitch && Math.abs(previous.startTime + previous.duration - startTime) < .001)
      previous.duration += reference.step;
    else notes.push({ startTime, duration: reference.step, pitch });
  }
  return notes;
}

export function pageLayout(width, time, notes) {
  const offset = Math.max(0, (notes[0]?.startTime || 0) - 2.5);
  const duration = width / PIXELS_PER_SECOND;
  const page = Math.floor(Math.max(0, time - offset) / duration);
  return { start: offset + page * duration, end: offset + (page + 1) * duration,
    playhead: (time - offset - page * duration) * PIXELS_PER_SECOND };
}

export class HostedPianoRoll {
  constructor(container, canvas) { Object.assign(this, { container, canvas }); this.reset(); }
  reset() { this.reference = null; this.frames = null; this.notes = []; this.trails = new Map(); }
  render({ time, reference, singers, active }) {
    if (reference !== this.reference || reference?.pitches !== this.frames) {
      const previous = reference === this.reference ? new Map(this.notes.map(n => [`${n.startTime}:${n.pitch}`, n.hitStatus])) : new Map();
      this.notes = guideNotes(reference);
      for (const note of this.notes) note.hitStatus = previous.get(`${note.startTime}:${note.pitch}`);
      this.reference = reference; this.frames = reference?.pitches;
      let min = 42, max = 90;
      if (this.notes.length) {
        min = Infinity; max = -Infinity;
        for (const note of this.notes) { min = Math.min(min, note.pitch - 3); max = Math.max(max, note.pitch + 3); }
        if (max - min < 12) { const center = (max + min) / 2; min = center - 6; max = center + 6; }
      }
      this.range = { min, max };
    }
    const width = this.container.clientWidth || globalThis.innerWidth || 1280;
    const height = ROLL_HEIGHT, ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== height * dpr) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const page = pageLayout(width, time, this.notes);
    const present = new Set(singers.map(s => s.id));
    for (const id of this.trails.keys()) if (!present.has(id)) this.trails.delete(id);
    let { min = 42, max = 90 } = this.range || {};
    // Keep actual singer octaves and retained trails visible alongside the guide.
    for (const singer of singers) {
      let trail = this.trails.get(singer.id) || [];
      if (active && trail.at(-1)?.time !== time) trail.push({ time, pitch: singer.pitch });
      trail = trail.filter(p => p.time >= page.start - 1).slice(-1200);
      this.trails.set(singer.id, trail);
      for (const point of [...trail, singer]) {
        if (point.pitch === null) continue;
        min = Math.min(min, point.pitch - 3);
        max = Math.max(max, point.pitch + 3);
      }
    }
    const pitchY = pitch => Math.max(8, Math.min(height - 8, height - (pitch - min) / (max - min) * height));
    ctx.beginPath(); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.15)";
    for (let i = 1; i < 8; i++) { ctx.moveTo(0, height / 8 * i); ctx.lineTo(width, height / 8 * i); }
    ctx.stroke();
    let currentStatus = "neutral";
    for (const note of this.notes) {
      if (note.startTime > page.end) break;
      if (note.startTime + note.duration < page.start) continue;
      const x = (note.startTime - page.start) * PIXELS_PER_SECOND;
      const barWidth = Math.max(8, note.duration * PIXELS_PER_SECOND), y = pitchY(note.pitch);
      const current = time >= note.startTime && time < note.startTime + note.duration;
      if (active && current && singers.some(s => s.pitch !== null)) {
        const hit = singers.some(s => s.pitch !== null && Math.abs(snapToRefOctave(note.pitch, s.pitch) - note.pitch) < 1.5);
        note.hitStatus = hit ? "hit" : "miss";
      }
      const status = note.hitStatus || "neutral";
      if (current) currentStatus = status;
      if (current) {
        ctx.fillStyle = status === "hit" ? "#a3e63566" : status === "miss" ? "#f8717166" : "#38bdf866";
        ctx.beginPath(); ctx.roundRect(x - 4, y - 12, barWidth + 8, 24, 12); ctx.fill();
      }
      const colors = PALETTE[status], gradient = ctx.createLinearGradient(0, y - 8, 0, y + 8);
      gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]);
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.roundRect(x, y - 8, barWidth, 16, 8); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.beginPath();
      ctx.roundRect(x + 2, y - 7, Math.max(1, barWidth - 4), 5, 3); ctx.fill();
    }
    if (page.playhead < 0) return;
    const sweep = ctx.createLinearGradient(page.playhead - 120, 0, page.playhead, 0);
    sweep.addColorStop(0, "transparent"); sweep.addColorStop(1, "rgba(255,215,0,.15)");
    ctx.fillStyle = sweep; ctx.fillRect(page.playhead - 120, 0, 120, height);
    for (const [size, color] of [[8, "#ffd7004d"], [4, "#ffd70099"], [2, "#ffd700"]]) {
      ctx.fillStyle = color; ctx.fillRect(page.playhead - size / 2, 0, size, height);
    }
    singers.forEach((singer, index) => {
      const trail = this.trails.get(singer.id);
      const color = singers.length > 1 ? ["#89cff0", "#f9a8d4", "#c4b5fd", "#86efac"][index % 4]
        : PALETTE[currentStatus][0];
      ctx.beginPath(); let previous;
      for (const point of trail) {
        if (point.pitch === null) { previous = null; continue; }
        const x = (point.time - page.start) * PIXELS_PER_SECOND, y = pitchY(point.pitch);
        if (!previous || point.time - previous.time > .15) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        previous = point;
      }
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = `${color}40`; ctx.lineWidth = 10; ctx.stroke();
      ctx.strokeStyle = `${color}cc`; ctx.lineWidth = 4; ctx.stroke();
      if (singer.pitch !== null) {
        const y = pitchY(singer.pitch);
        ctx.fillStyle = `${color}66`; ctx.beginPath(); ctx.arc(page.playhead, y, 13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(page.playhead, y, 6, 0, Math.PI * 2); ctx.fill();
      }
    });
  }
}
