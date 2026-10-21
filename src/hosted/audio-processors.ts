// Pitch shifting and noise gate ported from Encore's AudioWorklets.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
class PitchShifterProcessor extends AudioWorkletProcessor {
  bufferSize: number;
  bufferMask: number;
  delayBuffer: Float32Array[];
  writeIndex: number;
  phase: number;
  static get parameterDescriptors() {
    return [
      { name: "pitchFactor", defaultValue: 1.0, minValue: 0.25, maxValue: 4.0 },
    ];
  }

  constructor() {
    super();
    this.bufferSize = 8192;
    this.bufferMask = this.bufferSize - 1;
    this.delayBuffer = [
      new Float32Array(this.bufferSize),
      new Float32Array(this.bufferSize),
    ];
    this.writeIndex = 0;
    this.phase = 0.0;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const pitchFactor = parameters.pitchFactor[0];
    const numChannels = output.length;

    if (pitchFactor === 1.0) {
      for (let c = 0; c < numChannels; c++) {
        if (output[c]) output[c].set(input[c] || input[0]);
      }
      return true;
    }

    const windowSize = 4096;
    const phaseIncrement = (1.0 - pitchFactor) / windowSize;

    for (let i = 0; i < input[0].length; i++) {
      for (let c = 0; c < numChannels; c++) {
        this.delayBuffer[c][this.writeIndex] = (input[c] || input[0])[i];
      }

      const offset1 = this.phase * windowSize;
      const phase2 = (this.phase + 0.5) % 1.0;
      const offset2 = phase2 * windowSize;

      const gain1 = 0.5 - 0.5 * Math.cos(this.phase * 2 * Math.PI);
      const gain2 = 0.5 - 0.5 * Math.cos(phase2 * 2 * Math.PI);

      for (let c = 0; c < numChannels; c++) {
        const readIdx1 =
          (this.writeIndex - Math.floor(offset1) + this.bufferSize) &
          this.bufferMask;
        const readIdx2 =
          (this.writeIndex - Math.floor(offset2) + this.bufferSize) &
          this.bufferMask;

        output[c][i] =
          this.delayBuffer[c][readIdx1] * gain1 +
          this.delayBuffer[c][readIdx2] * gain2;
      }

      this.writeIndex = (this.writeIndex + 1) & this.bufferMask;
      this.phase = (this.phase + phaseIncrement + 10.0) % 1.0;
    }

    return true;
  }
}
registerProcessor("pitch-shifter-processor", PitchShifterProcessor);

/**
 * Converts a dB value to a linear amplitude value.
 * @param {number} db - The value in decibels.
 * @returns {number} The corresponding linear amplitude (0.0 to 1.0).
 */
function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

/**
 * Audio worklet processor implementing a noise gate effect.
 * Silences audio below a threshold and applies attack/release envelope.
 * @extends AudioWorkletProcessor
 */
class NoiseGateProcessor extends AudioWorkletProcessor {
  _currentGain: number;
  /**
   * Defines the audio parameters for the noise gate.
   * @returns {Array<Object>} Array of parameter descriptors (threshold, attack, release).
   */
  static get parameterDescriptors() {
    return [
      {
        name: "threshold",
        defaultValue: dbToLinear(-50),
        minValue: dbToLinear(-100),
        maxValue: dbToLinear(0),
      },
      {
        name: "attack",
        defaultValue: 0.005,
        minValue: 0.001,
        maxValue: 0.2,
      },
      {
        name: "release",
        defaultValue: 0.1,
        minValue: 0.01,
        maxValue: 1.0,
      },
    ];
  }

  /**
   * Initializes the noise gate processor.
   * @param {Object} options - AudioWorkletProcessor options.
   */
  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    this._currentGain = 0.0;
  }

  /**
   * Processes audio samples through the noise gate.
   * @param {Float32Array[][]} inputs - Input audio buffers.
   * @param {Float32Array[][]} outputs - Output audio buffers.
   * @param {Object} parameters - Audio parameters (threshold, attack, release).
   * @returns {boolean} Always returns true to keep the processor alive.
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];

    const threshold = parameters.threshold[0];
    const attackTime = parameters.attack[0];
    const releaseTime = parameters.release[0];

    const attackCoeff = Math.exp(-1.0 / (attackTime * sampleRate));
    const releaseCoeff = Math.exp(-1.0 / (releaseTime * sampleRate));

    if (!input?.length || !output?.length) return true;
    for (let i = 0; i < input[0].length; i++) {
      let peak = 0;
      for (const channel of input) peak = Math.max(peak, Math.abs(channel[i] || 0));
      const coefficient = peak > threshold ? attackCoeff : releaseCoeff;
      const target = peak > threshold ? 1 : 0;
      this._currentGain = target + (this._currentGain - target) * coefficient;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][i] = ((input[channel] || input[0])?.[i] || 0) * (this._currentGain < .0001 ? 0 : this._currentGain);
      }
    }

    return true;
  }
}

registerProcessor("noise-gate-processor", NoiseGateProcessor);
