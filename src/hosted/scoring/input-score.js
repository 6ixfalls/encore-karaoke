import { ReferenceScore } from "./reference.js";
import { freqToSemitone } from "./state.js";

// Each microphone owns its history, including samples waiting for a streamed guide.
export class InputScore {
  constructor({ id, label, source }, reference, time) {
    Object.assign(this, { id, label, source, samples: 0, credit: 0, previousPitch: null, pending: [], failed: false });
    if (reference) {
      this.referenceScore = new ReferenceScore(reference);
      this.referenceScore.anchor(time);
    }
  }
  anchor(time) {
    if (!this.pending.length) this.referenceScore?.anchor(time);
    this.previousPitch = null;
  }
  update(time, hz, latency, rate, liveReference) {
    if (this.failed) return;
    if (liveReference) {
      if (this.pending.length >= 400) { this.failed = true; this.pending = []; return; }
      this.pending.push({ time, hz, latency, rate });
      this.flush(liveReference);
    } else if (this.referenceScore) {
      this.referenceScore.update(time, hz, latency, rate);
    } else {
      const pitch = hz === null ? null : freqToSemitone(hz);
      if (pitch !== null && this.previousPitch !== null) {
        this.credit += Math.max(0, 1 - Math.abs(pitch - this.previousPitch) / 2);
        this.samples++;
      }
      this.previousPitch = pitch;
    }
  }
  flush(reference) {
    if (!this.referenceScore) return;
    this.referenceScore.scorer.totalSingable = Math.max(.5, reference.duration);
    // Completed guides cannot grow further. Drain the codec/polling tail too;
    // reference.at() treats positions beyond the guide as silence.
    while (this.pending.length && (reference.complete || this.pending[0].time <= reference.through)) {
      const sample = this.pending.shift();
      this.referenceScore.update(sample.time, sample.hz, sample.latency, sample.rate);
    }
  }
  result(liveReference, provisional = false) {
    const samples = this.referenceScore?.samples ?? this.samples;
    let reason;
    if (this.failed) reason = "The scoring guide fell behind this microphone.";
    else if (!provisional && liveReference && (!liveReference.complete || this.pending.length))
      reason = "The vocal scoring guide has not finished processing.";
    else if (samples < 20) reason = "Not enough vocal samples were captured. Check this microphone and try again.";
    const value = reason ? null : this.referenceScore ? this.referenceScore.result().value : Math.round(100 * this.credit / samples);
    return { id: this.id, label: this.label, source: this.source, value, samples,
      mode: this.referenceScore ? "guide" : "stability", ...(reason ? { reason } : {}) };
  }
}

export function inputColor(id) {
  if (id === "local") return "#89cff0";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ["#f9a8d4", "#c4b5fd", "#86efac", "#fcd34d", "#fdba74"][hash % 5];
}
