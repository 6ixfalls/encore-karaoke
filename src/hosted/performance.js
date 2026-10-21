import { requestMicrophone } from "./microphone.js";
// SPDX-License-Identifier: GPL-3.0-only
import { createMicPitchDetector, detectPitchFromSamplesMic } from "./scoring/detect.js";
import { freqToSemitone } from "./scoring/state.js";
import { midiReference, vocalReference } from "./scoring/reference.js";
import { InputScore, inputColor } from "./scoring/input-score.js";
import { DEFAULT_MIC_LATENCY_COMPENSATION_SEC } from "./scoring/constants.js";

const defaultMicDetector = createMicPitchDetector();
export function detectPitch(samples, sampleRate) {
  const hz = detectPitchFromSamplesMic(defaultMicDetector, samples, sampleRate);
  return hz === null ? null : freqToSemitone(hz);
}
export class PerformanceTools {
  constructor({ status, score, recording, staff, inputs = () => {} }) {
    Object.assign(this, { status, score, recording, staff, inputs });
    this.phoneLabels = new Map();
    this.remoteInputs = new Map();
    this.references = new Map();
    this.latency = DEFAULT_MIC_LATENCY_COMPENSATION_SEC;
    this.detector = createMicPitchDetector();
    this.resetScore();
  }
  resetScore() {
    this.inputScores = new Map(); this.lastScoringTime = 0;
    this.mode = "stability"; this.reference = null; this.guideNotes = null;
    this.liveReference = null;
    this.displayReference = null;
    this.staff?.reset();
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
      this.mode = "guide";
      this.lastScoringTime = player.audio?.currentTime || 0;
      this.inputScores.clear();
      this.updateDisplayReference();
    }
  }
  beginLiveReference() {
    const reference = { duration: 0, end: 0, through: 0, complete: false, pitches: [], step: 1024 / 44100 };
    reference.at = time => {
      const pitch = time >= 0 ? reference.pitches[Math.floor(time / reference.step)] : null;
      return pitch == null ? [] : [pitch];
    };
    this.reference = this.liveReference = reference;
    this.inputScores.clear(); this.lastScoringTime = 0;
    this.mode = "guide";
    this.status("Separating streamed audio. Playback starts after the first processed chunk.");
  }
  updateLiveReference(snapshot) {
    const reference = this.liveReference;
    if (!reference) return;
    if (!Array.isArray(snapshot.pitches) || snapshot.pitches.length > 27000 ||
      !Number.isFinite(snapshot.through) || snapshot.through < reference.through || snapshot.through > 601 ||
      typeof snapshot.complete !== "boolean" || !Number.isFinite(snapshot.singable) || snapshot.singable < 0 ||
      snapshot.singable > 600 || snapshot.step !== 1024 / 44100 ||
      snapshot.pitches.some(pitch => pitch !== null && (!Number.isFinite(pitch) || pitch < 80 || pitch > 1000)))
      throw new Error("invalid_live_reference");
    Object.assign(reference, { pitches: snapshot.pitches, end: snapshot.pitches.length * snapshot.step,
      duration: snapshot.singable, through: snapshot.through, complete: snapshot.complete });
    this.updateDisplayReference();
    for (const score of this.inputScores.values()) score.flush(reference);
    this.status(snapshot.complete ? "Vocal separation complete. Reference scoring is ready." :
      `Separating ahead of playback: ${Math.floor(snapshot.through)} seconds ready. Score is provisional.`);
  }
  setTranspose(semitones) {
    if (this.transpose === semitones) return;
    this.transpose = semitones;
    this.updateDisplayReference();
    this.staff?.reset();
  }
  updateDisplayReference() {
    if (!this.reference) return;
    const reference = this.reference, factor = 2 ** ((this.transpose || 0) / 12);
    // Progress updates extend the same track; the roll uses identity to retain hit/miss colors.
    Object.assign(this.displayReference ||= {}, reference, {
      pitches: reference.pitches?.map(hz => hz === null ? null : hz * factor),
      at: time => reference.at(time).map(hz => hz * factor) });
  }
  attachRemoteMicrophone(id, source, context, nickname) {
    this.detachRemoteMicrophone(id);
    if (!this.phoneLabels.has(id)) this.phoneLabels.set(id, `Phone ${this.phoneLabels.size + 1}${nickname ? ` · ${nickname}` : ""}`.slice(0, 100));
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    source.connect(analyser);
    this.remoteInputs.set(id, { source, analyser, context, label: this.phoneLabels.get(id),
      detector: createMicPitchDetector(), buffer: new Float32Array(2048) });
  }
  detachRemoteMicrophone(id) {
    const input = this.remoteInputs.get(id);
    if (!input) return;
    input.source.disconnect(input.analyser); input.analyser.disconnect();
    this.remoteInputs.delete(id);
  }
  readMicrophones(active) {
    const singers = [];
    const inputs = [...(this.analyser ? [["local", this]] : []), ...this.remoteInputs];
    for (const [id, input] of inputs) {
      let hz = null, rms = 0;
      if (active) {
        input.analyser.getFloatTimeDomainData(input.buffer);
        rms = Math.sqrt(input.buffer.reduce((sum, sample) => sum + sample * sample, 0) / input.buffer.length);
        hz = detectPitchFromSamplesMic(input.detector, input.buffer, input.context.sampleRate);
      }
      // The same sample feeds this microphone's score, trace and receipt indicator.
      singers.push({ id, label: id === "local" ? "Display microphone" : input.label,
        source: id === "local" ? "display" : "phone", color: inputColor(id), rms, hz,
        pitch: hz === null ? null : freqToSemitone(hz) });
    }
    return singers;
  }
  async startMicrophone(player) {
    if (!player.valid()) throw new Error("start_display_first");
    if (this.stream) return;
    const generation = player.generation;
    const version = this.micVersion || 0;
    const stream = await requestMicrophone(false);
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
      this.input.connect(this.analyser); // Scoring uses the dry microphone, independent of the effect chain.
      if (player.mixer) this.input.connect(player.mixer.localInput);
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
  inputResults(provisional = false) {
    return [...this.inputScores.values()].map(score => score.result(this.liveReference, provisional));
  }
  result(provisional = false) {
    const inputs = this.inputResults(provisional), scored = inputs.filter(input => input.value !== null);
    if (!scored.length) return undefined;
    return { value: Math.round(10 * scored.reduce((sum, input) => sum + input.value, 0) / scored.length) / 10,
      samples: Math.max(...scored.map(input => input.samples)), mode: this.mode, inputs, aggregation: "mean" };
  }
  unavailableReason() {
    if (this.inputScores.size) return this.inputResults().find(input => input.reason)?.reason;
    return "Enable the display microphone or connect a phone microphone before singing to receive a score.";
  }
  update(player) {
    this.drawFrame?.();
    const time = player.audio.currentTime;
    const active = !!(player.valid() && !player.audio.paused && !player.loading && player.loaded);
    const singers = this.readMicrophones(active), connected = new Set(singers.map(singer => singer.id));
    for (const singer of singers) {
      let score = this.inputScores.get(singer.id);
      if (!score) {
        score = new InputScore(singer, this.reference, this.lastScoringTime);
        this.inputScores.set(singer.id, score);
      }
      if (active) score.update(time, singer.hz === null ? null : singer.hz / 2 ** ((this.transpose || 0) / 12),
        this.latency, player.audio.playbackRate, this.liveReference);
    }
    for (const [id, score] of this.inputScores) if (!active || !connected.has(id)) score.anchor(time);
    this.lastScoringTime = time;
    if (this.staff?.enabled) this.staff.render({ time, reference: this.displayReference || this.reference, singers, active, latency: this.latency });
    const results = this.inputResults(true);
    this.inputs(singers.map(singer => ({ ...singer, active, result: results.find(result => result.id === singer.id),
      provisional: !!(this.liveReference && !this.liveReference.complete) })));
    const group = this.result(true);
    this.score(group ? `${this.mode === "guide" ? "Nightingale pitch match" : "Pitch stability"} · Group: ${group.value} / 100${this.liveReference && !this.liveReference.complete ? " (provisional)" : ""}` : "");
  }

  startRecording(player) {
    if (!player.valid() || !player.loaded || player.loading) throw new Error("play_song_before_recording");
    if (!this.stream) throw new Error("enable_microphone_first");
    if (this.recorders) throw new Error("already_recording");
    if (typeof MediaRecorder === "undefined") throw new Error("recording_not_supported");
    const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext("2d"), video = canvas.captureStream(20);
    const mix = this.context.createMediaStreamDestination();
    const mixedSource = player.mixer?.capture || player.gate;
    if (!player.mixer) this.input.connect(mix);
    const musicDestination = this.context.createMediaStreamDestination();
    mixedSource.connect(mix);
    const musicSource = player.mixer?.musicCapture || player.gate;
    musicSource.connect(musicDestination);
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
        if (!player.mixer) this.input?.disconnect(mix);
        mixedSource.disconnect(mix); musicSource.disconnect(musicDestination);
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
      if (!player.mixer) this.input.disconnect(mix);
      mixedSource.disconnect(mix); musicSource.disconnect(musicDestination);
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
