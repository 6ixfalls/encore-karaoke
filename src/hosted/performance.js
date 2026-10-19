// SPDX-License-Identifier: GPL-3.0-only
import { createMicPitchDetector, detectPitchFromSamplesMic } from "./scoring/detect.js";
import { freqToSemitone } from "./scoring/state.js";
import { midiReference, vocalReference, ReferenceScore } from "./scoring/reference.js";
import { DEFAULT_MIC_LATENCY_COMPENSATION_SEC } from "./scoring/constants.js";

const defaultMicDetector = createMicPitchDetector();
export function detectPitch(samples, sampleRate) {
  const hz = detectPitchFromSamplesMic(defaultMicDetector, samples, sampleRate);
  return hz === null ? null : freqToSemitone(hz);
}
export class PerformanceTools {
  constructor({ status, score, recording }) {
    Object.assign(this, { status, score, recording });
    this.references = new Map();
    this.latency = DEFAULT_MIC_LATENCY_COMPENSATION_SEC;
    this.detector = createMicPitchDetector();
    this.resetScore();
  }
  resetScore() {
    this.samples = 0; this.credit = 0; this.mode = "stability"; this.previousPitch = null;
    this.referenceScore = null; this.reference = null; this.guideNotes = null;
  }
  setLatency(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0 || value > 500) throw new Error("invalid_microphone_latency");
    this.latency = value / 1000;
  }
  async prepareReference(player, song, getBuffer, current) {
    if (player.guideNotes?.length) this.reference = midiReference(player.guideNotes);
    this.guideNotes = player.guideNotes;
    if (song.referenceId) {
      try {
        const key = `${song.referenceId}:${song.referenceVersion || ""}`;
        let reference = this.references.get(key);
        if (!reference) {
          const data = await getBuffer(song.referenceId, 32 * 1024 * 1024);
          if (!current()) return;
          const decoded = await player.context.decodeAudioData(data);
          if (!current()) return;
          reference = await vocalReference(decoded, current);
          if (!current()) return;
          if (reference.duration <= 0) throw new Error("vocal_reference_has_no_pitch");
          if (this.references.size >= 4) this.references.delete(this.references.keys().next().value);
          this.references.set(key, reference);
        }
        if (current()) this.reference = reference;
      } catch (error) {
        if (!current()) return;
        this.status(`Vocal reference unavailable (${error.message}). ${this.reference ? "Using MIDI guide." : "Using pitch stability."}`);
      }
    }
    if (current() && this.reference?.duration > 0) {
      this.referenceScore = new ReferenceScore(this.reference);
      this.referenceScore.anchor(player.audio?.currentTime || 0);
      this.mode = "guide";
    }
  }
  async startMicrophone(player) {
    if (!player.valid()) throw new Error("start_display_first");
    if (this.stream) return;
    const generation = player.generation;
    const version = this.micVersion || 0;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
    if (!player.valid() || generation !== player.generation || version !== (this.micVersion || 0)) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("stale_display");
    }
    // A second click or a release can overtake the permission prompt.
    if (this.stream) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    stream.getTracks().forEach((track) => track.addEventListener?.("ended", () => {
      if (this.stream !== stream) return;
      this.stopMicrophone();
      this.status("Microphone disconnected.");
    }, { once: true }));
    this.context = player.context;
    try {
      this.input = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048;
      this.input.connect(this.analyser); // Microphone is never connected to speakers.
      this.buffer = new Float32Array(2048);
    } catch (error) { this.stopMicrophone(); throw error; }
    this.status("Microphone enabled for scoring and recording on this display.");
  }
  stopMicrophone() {
    this.micVersion = (this.micVersion || 0) + 1;
    this.stopRecording();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.input?.disconnect(); this.analyser?.disconnect();
    this.stream = null; this.input = null; this.analyser = null;
  }
  trackChanged() { this.stopRecording(); this.resetScore(); this.score(""); }
  result() {
    if (this.referenceScore) return this.referenceScore.samples >= 20 ? this.referenceScore.result() : undefined;
    return this.samples >= 20 ? { value: Math.round(100 * this.credit / this.samples), samples: this.samples, mode: this.mode } : undefined;
  }
  update(player) {
    this.drawFrame?.();
    const time = player.audio.currentTime;
    if (!this.analyser || !player.valid() || player.audio.paused || player.loading || !player.loaded) {
      this.referenceScore?.anchor(time);
      this.previousPitch = null;
      return;
    }
    this.analyser.getFloatTimeDomainData(this.buffer);
    const hz = detectPitchFromSamplesMic(this.detector, this.buffer, this.context.sampleRate);
    const pitch = hz === null ? null : freqToSemitone(hz);
    if (this.referenceScore) {
      this.referenceScore.update(time, hz, this.latency, player.audio.playbackRate);
    } else {
      const credit = pitch === null || this.previousPitch === null ? null : Math.max(0, 1 - Math.abs(pitch - this.previousPitch) / 2);
      if (credit !== null) { this.credit += credit; this.samples++; }
    }
    this.previousPitch = pitch;
    const note = pitch === null ? "—" : ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"][((Math.round(pitch) % 12) + 12) % 12];
    this.score(`${this.referenceScore ? "Nightingale pitch match" : "Pitch stability"}: ${this.result()?.value ?? "…"} · ${note}`);
  }

  startRecording(player) {
    if (!player.valid() || !player.loaded || player.loading) throw new Error("play_song_before_recording");
    if (!this.stream) throw new Error("enable_microphone_first");
    if (this.recorders) throw new Error("already_recording");
    if (typeof MediaRecorder === "undefined") throw new Error("recording_not_supported");
    const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext("2d"), video = canvas.captureStream(20);
    const mix = this.context.createMediaStreamDestination();
    this.input.connect(mix);
    const musicDestination = this.context.createMediaStreamDestination();
    player.gate.connect(mix); player.gate.connect(musicDestination);
    const stream = new MediaStream([...video.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    const sources = [["performance", stream], ["microphone", this.stream]];
    sources.push(["music", musicDestination.stream]);
    this.drawFrame = () => {
      ctx.fillStyle = "#101022"; ctx.fillRect(0, 0, 1280, 720);
      if (["video", "youtube"].includes(player.song?.format) && player.localMedia.readyState >= 2) ctx.drawImage(player.localMedia, 0, 0, 1280, 720);
      if (player.cdgCanvas && !player.cdgCanvas.hidden) ctx.drawImage(player.cdgCanvas, 0, 0, 1280, 720);
      ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0, 540, 1280, 180);
      ctx.fillStyle = "white"; ctx.font = "32px sans-serif";
      ctx.fillText(player.room.current?.title || "Encore", 40, 50, 1200);
      const index = (player.lines || []).findLastIndex((line) => line.time <= player.audio.currentTime);
      ctx.fillText(player.lines?.[index]?.text || "♪", 40, 610, 1200);
      ctx.font = "22px sans-serif";
      ctx.fillText("Encore performance", 40, 685, 1200);
    };
    this.drawFrame();
    let size = 0;
    const recorders = [];
    const title = (player.room.current?.title || "Encore").replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 80);
    try {
      for (const [kind, source] of sources) {
        const types = kind === "performance" ? ["video/webm;codecs=vp8,opus", "video/mp4", "video/webm"] : ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"];
        const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(source, mimeType ? { mimeType } : {}), chunks = [];
        recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); size += data.size; if (size > 256 * 1024 * 1024) this.stopRecording(); };
        recorder.onstop = () => {
          if (chunks.length) this.recording(new Blob(chunks, { type: recorder.mimeType }), `${title}-${kind}`);
        };
        recorder.onerror = () => { this.status("Recording failed. Available captured data will be offered for download."); this.stopRecording(); };
        recorders.push(recorder);
      }
      this.recorders = recorders;
      this.recordingCleanup = () => {
        video.getTracks().forEach((track) => track.stop());
        this.input?.disconnect(mix);
        player.gate.disconnect(mix); player.gate.disconnect(musicDestination);
        mix.stream.getTracks().forEach((track) => track.stop());
        musicDestination?.stream.getTracks().forEach((track) => track.stop());
      };
      recorders.forEach((recorder) => recorder.start(1000));
      this.recordingTimer = setTimeout(() => this.stopRecording(), 30 * 60 * 1000);
      this.status("Recording performance, microphone and music stems locally.");
    } catch (error) {
      recorders.forEach((recorder) => { if (recorder.state !== "inactive") recorder.stop(); });
      this.recorders = null; this.drawFrame = null;
      this.recordingCleanup = null;
      video.getTracks().forEach((track) => track.stop());
      this.input.disconnect(mix);
      player.gate.disconnect(mix); player.gate.disconnect(musicDestination);
      mix.stream.getTracks().forEach((track) => track.stop());
      musicDestination?.stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }
  stopRecording() {
    if (!this.recorders) return;
    for (const recorder of this.recorders) if (recorder.state !== "inactive") recorder.stop();
    this.recorders = null; this.drawFrame = null;
    clearTimeout(this.recordingTimer);
    this.recordingCleanup?.(); this.recordingCleanup = null;
    this.status("Recording stopped. Download your files below.");
  }
}
