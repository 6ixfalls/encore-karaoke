/* SPDX-License-Identifier: GPL-3.0-only
 * Encore piano roll presentation with Nightingale pitch scoring buffers.
 */
import { PitchStateBuffer, pitchSimilarity } from "./state.js";
import { HostedPianoRoll } from "./piano-roll.js";

export class PitchStaff {
  constructor(container, canvas) {
    Object.assign(this, { container, canvas, enabled: false });
    this.roll = new HostedPianoRoll(container, canvas);
    this.reset();
  }
  reset() { this.series = new Map(); this.referenceSeries = new PitchStateBuffer(); this.lastTime = null; this.roll.reset(); }
  setEnabled(enabled) { this.enabled = enabled; this.container.hidden = !enabled; this.reset(); }
  render({ time, reference, singers, active, latency = 0 }) {
    if (!this.enabled) return;
    const now = time - latency;
    if (this.lastTime !== null && (now < this.lastTime || now - this.lastTime > .5)) this.reset();
    const ids = new Set(singers.map(singer => singer.id));
    for (const id of this.series.keys()) if (!ids.has(id)) this.series.delete(id);
    const targets = reference?.at(Math.max(0, now)) || [];
    if (active && now !== this.lastTime)
      this.referenceSeries.tryPush(targets[0] ?? null, null, 0, Math.max(0, now));
    singers.forEach(singer => {
      let buffer = this.series.get(singer.id);
      if (!buffer) { buffer = new PitchStateBuffer(); this.series.set(singer.id, buffer); }
      // MIDI references can contain chords: use the nearest octave-independent
      // target for this singer, matching the scorer's comparison.
      const hz = singer.pitch === null ? null : 440 * 2 ** ((singer.pitch - 69) / 12);
      const ref = targets.reduce((best, target) => best === null || (hz !== null &&
        pitchSimilarity(target, hz) > pitchSimilarity(best, hz)) ? target : best, null);
      if (active && now !== this.lastTime)
        buffer.tryPush(ref, hz, ref !== null && hz !== null ? pitchSimilarity(ref, hz) : 0, Math.max(0, now));
    });
    this.lastTime = now;
    this.roll.render({ time: Math.max(0, now), reference, singers, active });
  }
}
