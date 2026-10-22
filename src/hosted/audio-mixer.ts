// Forte's browser audio graph and plugin parameters adapted for the hosted player.
import type { Preferences } from "./preferences.js";
export const EQ_BANDS = [60, 150, 400, 1000, 2400, 6000, 15000];
class VocalStrip {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly monitor: GainNode;
  private eq: BiquadFilterNode[];
  private parametric: BiquadFilterNode;
  private compressor: DynamicsCompressorNode;
  private gain: GainNode;
  private echo: DelayNode;
  private feedback: GainNode;
  private wet: GainNode;
  private noise?: AudioWorkletNode;
  private compressing = true;
  constructor(private context: AudioContext, gate: GainNode) {
    this.input = context.createGain(); this.output = context.createGain();
    this.monitor = context.createGain(); this.monitor.gain.value = 0;
    this.eq = EQ_BANDS.map(frequency => {
      const filter = context.createBiquadFilter(); filter.type = "peaking";
      filter.frequency.value = frequency; filter.Q.value = 1.41; return filter;
    });
    this.parametric = context.createBiquadFilter(); this.parametric.type = "peaking";
    this.compressor = context.createDynamicsCompressor();
    this.compressor.knee.value = 30; this.compressor.ratio.value = 4;
    this.compressor.attack.value = .003; this.compressor.release.value = .25;
    this.gain = context.createGain();
    this.echo = context.createDelay(1); this.echo.delayTime.value = .25;
    this.feedback = context.createGain(); this.feedback.gain.value = .3;
    this.wet = context.createGain(); this.wet.gain.value = 0;
    this.input.connect(this.eq[0]);
    this.eq.forEach((filter, i) => filter.connect(this.eq[i + 1] || this.parametric));
    this.parametric.connect(this.compressor); this.compressor.connect(this.gain);
    this.gain.connect(this.output); this.gain.connect(this.echo);
    this.echo.connect(this.feedback); this.feedback.connect(this.echo);
    this.echo.connect(this.wet); this.wet.connect(this.output);
    this.output.connect(this.monitor); this.monitor.connect(gate);
  }
  initialize(): void {
    if (this.noise) return;
    this.noise = new AudioWorkletNode(this.context, "noise-gate-processor", { outputChannelCount: [2] });
    this.input.disconnect(); this.input.connect(this.noise); this.noise.connect(this.eq[0]);
  }
  apply(settings: Preferences, monitoring: boolean, volume = 1): void {
    const time = this.context.currentTime;
    const set = (parameter: AudioParam, value: number) => parameter.setTargetAtTime(value, time, .01);
    set(this.output.gain, settings.micGain * volume); set(this.monitor.gain, monitoring ? 1 : 0);
    this.eq.forEach((filter, i) => set(filter.gain, settings.eq[i]));
    set(this.parametric.frequency, settings.parametricFrequency);
    set(this.parametric.gain, settings.parametricGain); set(this.parametric.Q, settings.parametricQ);
    // A ratio of 1 still incurs the compressor's look-ahead delay. Bypass the
    // node entirely when disabled, for both live monitoring and recording.
    if (this.compressing !== settings.compressor) {
      this.parametric.disconnect(); this.compressor.disconnect();
      if (settings.compressor) {
        this.parametric.connect(this.compressor); this.compressor.connect(this.gain);
      } else this.parametric.connect(this.gain);
      this.compressing = settings.compressor;
    }
    set(this.compressor.threshold, settings.compressor ? settings.compressorThreshold : 0);
    set(this.compressor.ratio, settings.compressor ? 4 : 1);
    set(this.echo.delayTime, settings.echoTime); set(this.wet.gain, settings.echo); set(this.feedback.gain, .3);
    this.noise?.parameters.get("threshold")?.setValueAtTime(10 ** (settings.noiseGate / 20), time);
  }
  dispose(): void {
    for (const node of [this.input, this.output, this.monitor, ...this.eq, this.parametric,
      this.compressor, this.gain, this.echo, this.feedback, this.wet, this.noise]) node?.disconnect();
  }
  silence(): void {
    this.feedback.gain.cancelScheduledValues(this.context.currentTime);
    this.feedback.gain.setValueAtTime(0, this.context.currentTime);
    this.wet.gain.cancelScheduledValues(this.context.currentTime);
    this.wet.gain.setValueAtTime(0, this.context.currentTime);
  }
}
export class AudioMixer {
  readonly music: GainNode;
  readonly vocalTrack: GainNode;
  readonly input: GainNode;
  readonly localInput: GainNode;
  readonly capture: GainNode;
  readonly musicCapture: GainNode;
  readonly vocalCapture: GainNode;
  private musicInput: GainNode;
  private backing: GainNode;
  private local: VocalStrip;
  private remote: VocalStrip;
  private microphones = new Map<string, VocalStrip>();
  private microphoneSettings = new Map<string, { volume: number; loopback: boolean }>();
  private initialized = false;
  private pitch?: AudioWorkletNode;
  private ready?: Promise<void>;
  private settings?: Preferences;
  private silenced = false;
  constructor(readonly context: AudioContext, source: AudioNode, readonly gate: GainNode) {
    this.musicInput = context.createGain(); this.music = context.createGain();
    this.vocalTrack = context.createGain(); this.vocalTrack.gain.value = 0;
    this.vocalTrack.connect(this.musicInput);
    this.local = new VocalStrip(context, gate); this.remote = new VocalStrip(context, gate);
    this.input = this.remote.input; this.localInput = this.local.input;
    this.backing = context.createGain(); source.connect(this.backing); this.backing.connect(this.musicInput); this.musicInput.connect(this.music); this.music.connect(gate);
    // Capture buses have the same audio-thread lease cutoff as speaker output.
    // Local monitoring is independent of processed recording and phone playback.
    this.capture = context.createGain(); this.musicCapture = context.createGain(); this.vocalCapture = context.createGain();
    for (const bus of [this.capture, this.musicCapture, this.vocalCapture]) bus.gain.value = 0;
    this.music.connect(this.capture); this.music.connect(this.musicCapture);
    for (const strip of [this.local, this.remote]) { strip.output.connect(this.capture); strip.output.connect(this.vocalCapture); }
  }
  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.context.audioWorklet.addModule("/audio-processors.js").then(() => {
      this.pitch = new AudioWorkletNode(this.context, "pitch-shifter-processor", { outputChannelCount: [2] });
      this.musicInput.disconnect(); this.musicInput.connect(this.pitch); this.pitch.connect(this.music);
      this.local.initialize(); this.remote.initialize();
      this.initialized = true;
      for (const strip of this.microphones.values()) strip.initialize();
      if (this.settings) this.apply(this.settings);
    }).catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  microphoneInput(id: string): GainNode {
    if (id === "local") return this.localInput;
    let strip = this.microphones.get(id);
    if (!strip) {
      strip = new VocalStrip(this.context, this.gate);
      this.microphones.set(id, strip);
      strip.output.connect(this.capture); strip.output.connect(this.vocalCapture);
      if (this.initialized) strip.initialize();
      if (this.settings) this.applyMicrophone(id, strip);
    }
    return strip.input;
  }
  removeMicrophone(id: string): void {
    this.microphones.get(id)?.dispose(); this.microphones.delete(id);
  }
  resetMicrophoneSettings(): void {
    this.microphoneSettings.clear();
    if (this.settings) this.apply(this.settings);
  }
  getMicrophoneSettings(id: string): { volume: number; loopback: boolean } {
    return this.microphoneSettings.get(id) || { volume: 1, loopback: id === "local" ? !!this.settings?.monitoring : true };
  }
  setMicrophoneSettings(id: string, value: { volume: number; loopback: boolean }): void {
    if (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 2 || typeof value.loopback !== "boolean") return;
    this.microphoneSettings.set(id, { ...value });
    const strip = id === "local" ? this.local : this.microphones.get(id);
    if (strip && this.settings) this.applyMicrophone(id, strip);
  }
  private applyMicrophone(id: string, strip: VocalStrip): void {
    const channel = this.getMicrophoneSettings(id);
    if (this.settings) strip.apply(this.settings, channel.loopback, channel.volume);
    if (this.silenced) strip.silence();
  }
  setTranspose(semitones: number): void {
    this.pitch?.parameters.get("pitchFactor")?.setValueAtTime(2 ** (semitones / 12), this.context.currentTime);
  }
  setLease(seconds: number): void {
    if (seconds > 0 && this.silenced) {
      this.silenced = false;
      if (this.settings) this.apply(this.settings);
    }
    const now = this.context.currentTime;
    for (const bus of [this.capture, this.musicCapture, this.vocalCapture]) {
      bus.gain.cancelScheduledValues(now); bus.gain.setValueAtTime(seconds > 0 ? 1 : 0, now);
      if (seconds > 0) bus.gain.setValueAtTime(0, now + seconds);
    }
  }
  apply(settings: Preferences): void {
    this.settings = settings;
    this.backing.gain.setTargetAtTime(settings.instrumentalVolume, this.context.currentTime, .01);
    this.vocalTrack.gain.setTargetAtTime(settings.playVocals ? settings.vocalVolume : 0, this.context.currentTime, .01);
    this.applyMicrophone("local", this.local); this.remote.apply(settings, true);
    for (const [id, strip] of this.microphones) this.applyMicrophone(id, strip);
  }
  silence(): void { this.setLease(0); this.local.silence(); this.remote.silence();
    for (const strip of this.microphones.values()) strip.silence();
    this.silenced = true; }
}
