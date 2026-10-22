import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { AudioMixer } from "../../src/hosted/audio-mixer.ts";
import { defaults } from "../../src/hosted/preferences.ts";

class Parameter {
  value = 1;
  events = [];
  setValueAtTime(value, time) { this.events.push({ value, time }); if (time === 10) this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelScheduledValues() { this.events = []; }
}
class Node {
  gain = new Parameter();
  destinations = new Set();
  connect(node) { this.destinations.add(node); }
  disconnect(node) { if (node) this.destinations.delete(node); else this.destinations.clear(); }
}
const reaches = (start, goal, visited = new Set()) => {
  if ((start.gain?.value === 0 && !("frequency" in start)) || visited.has(start)) return false;
  if (start === goal) return true;
  visited.add(start);
  return [...start.destinations].some(node => reaches(node, goal, visited));
};
test("microphone channels have independent levels and loopback, with a master that leaves music and dry inputs alone", async t => {
  const original = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class extends Node { parameters = new Map([["pitchFactor", new Parameter()], ["threshold", new Parameter()]]); };
  t.after(() => { if (original) globalThis.AudioWorkletNode = original; else delete globalThis.AudioWorkletNode; });
  const context = { currentTime: 10, audioWorklet: { addModule: async () => {} },
    createGain: () => new Node(),
    createBiquadFilter: () => Object.assign(new Node(), { frequency: new Parameter(), Q: new Parameter() }),
    createDynamicsCompressor: () => Object.assign(new Node(), Object.fromEntries(["threshold", "ratio", "attack", "release", "knee"].map(k => [k, new Parameter()]))),
    createDelay: () => Object.assign(new Node(), { delayTime: new Parameter() }),
  };
  const source = new Node(), gate = new Node(), mixer = new AudioMixer(context, source, gate);
  mixer.apply({ ...defaults, micGain: .5 }); await mixer.initialize(); mixer.setLease(8);
  const first = mixer.microphoneInput("first"), second = mixer.microphoneInput("second");
  const level = (node, goal, seen = new Set()) => {
    if (seen.has(node)) return 0;
    if (node === goal) return node.gain?.value ?? 1;
    const next = new Set(seen); next.add(node);
    const gain = "frequency" in node ? 1 : node.gain?.value ?? 1;
    return gain * [...node.destinations].reduce((sum, dest) => sum + level(dest, goal, next), 0);
  };
  mixer.setMicrophoneSettings("first", { volume: .4, loopback: false });
  mixer.setMicrophoneSettings("second", { volume: 1.2, loopback: true });
  assert.equal(level(first, gate), 0);
  assert.equal(level(first, mixer.capture), .2);
  assert.equal(level(second, gate), .6);
  assert.equal(level(second, mixer.capture), .6);
  mixer.setMicrophoneSettings("local", { volume: .8, loopback: true });
  assert.equal(level(mixer.localInput, gate), .4);
  assert.equal(first.gain.value, 1); // Dry source/scoring branch stays untouched.
  assert.equal(level(source, gate), 1);
  mixer.apply({ ...defaults, micGain: 0 });
  assert.equal(level(second, gate), 0);
  assert.equal(level(first, mixer.capture), 0);
  assert.equal(level(source, gate), 1);
  mixer.apply(defaults);
  assert.equal(level(second, gate), 1.2);
  mixer.removeMicrophone("second");
  assert.equal(reaches(second, gate), false);
  assert.equal(reaches(second, mixer.capture), false);
  const reconnected = mixer.microphoneInput("second");
  assert.equal(level(reconnected, gate), 1.2);
  mixer.setMicrophoneSettings("second", { volume: -1, loopback: true });
  assert.equal(level(reconnected, gate), 1.2);
  mixer.setMicrophoneSettings("first", { volume: 0, loopback: false });
  mixer.setMicrophoneSettings("disconnected", { volume: 0, loopback: false });
  mixer.resetMicrophoneSettings();
  assert.deepEqual(mixer.getMicrophoneSettings("local"), { volume: 1, loopback: defaults.monitoring });
  assert.equal(level(mixer.localInput, gate), 0);
  assert.equal(level(first, gate), defaults.micGain);
  assert.equal(level(reconnected, gate), defaults.micGain);
  assert.equal(level(mixer.microphoneInput("disconnected"), gate), defaults.micGain);
  assert.equal(level(first, mixer.capture), defaults.micGain);
  assert.equal(level(source, gate), 1);
  mixer.setLease(0);
  assert.equal(level(first, mixer.capture), 0);
});
test("vocal monitoring, processed capture and phone output have separate routes behind the lease gate", async t => {
  const original = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class extends Node { parameters = new Map([["pitchFactor", new Parameter()], ["threshold", new Parameter()]]); };
  t.after(() => { if (original) globalThis.AudioWorkletNode = original; else delete globalThis.AudioWorkletNode; });
  const delays = [];
  const context = { currentTime: 10, audioWorklet: { addModule: async () => {} },
    createGain: () => new Node(),
    createBiquadFilter: () => Object.assign(new Node(), { frequency: new Parameter(), Q: new Parameter() }),
    createDynamicsCompressor: () => Object.assign(new Node(), Object.fromEntries(["threshold", "ratio", "attack", "release", "knee"].map(k => [k, new Parameter()]))),
    createDelay: () => {
      const delay = Object.assign(new Node(), { delayTime: new Parameter() });
      delays.push(delay); return delay;
    },
  };
  const source = new Node(), gate = new Node(), speakers = new Node(); gate.connect(speakers);
  const mixer = new AudioMixer(context, source, gate);
  mixer.apply(structuredClone(defaults)); await mixer.initialize(); mixer.setLease(8);
  assert.equal(reaches(mixer.localInput, speakers), false);
  assert.equal(reaches(mixer.input, speakers), true);
  assert.equal(reaches(mixer.localInput, mixer.capture), true);
  assert.equal(reaches(mixer.input, mixer.capture), true);
  assert.equal(reaches(source, mixer.musicCapture), true);
  assert.deepEqual(mixer.capture.gain.events.at(-1), { value: 0, time: 18 });
  assert.deepEqual(mixer.musicCapture.gain.events.at(-1), { value: 0, time: 18 });
  mixer.apply({ ...defaults, monitoring: true });
  assert.equal(reaches(mixer.localInput, speakers), true);
  gate.gain.value = 0;
  assert.equal(reaches(mixer.localInput, speakers), false);
  assert.equal(reaches(mixer.input, speakers), false);
  assert.equal(reaches(source, speakers), false);
  mixer.silence(); assert.equal(mixer.capture.gain.value, 0);
  mixer.apply({ ...defaults, echo: .45 });
  const echoGains = () => delays.map(delay => [...delay.destinations].map(node => node.gain.value));
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    mixer.silence();
    assert.deepEqual(echoGains(), [[0, 0], [0, 0]]);
    await mixer.initialize();
    assert.deepEqual(echoGains(), [[0, 0], [0, 0]]);
    mixer.setLease(8);
    assert.deepEqual(echoGains(), [[.3, .45], [.3, .45]]);
    assert.equal(gate.gain.value, 0);
    assert.deepEqual(mixer.capture.gain.events.at(-1), { value: 0, time: 18 });
  }
});

test("ported audio processors handle mono/stereo, silence and pitch bypass without invalid samples", () => {
  const processors = new Map();
  const code = transformSync(readFileSync(new URL("../../src/hosted/audio-processors.ts", import.meta.url), "utf8"), { loader: "ts", format: "iife" }).code;
  runInNewContext(code, { AudioWorkletProcessor: class {}, sampleRate: 48000,
    registerProcessor: (name, processor) => processors.set(name, processor) });
  const pitch = new (processors.get("pitch-shifter-processor"))();
  const left = Float32Array.from({ length: 128 }, (_, i) => .3 * Math.sin(i / 5));
  const right = left.slice(), output = [new Float32Array(128), new Float32Array(128)];
  pitch.process([[left, right]], [output], { pitchFactor: [1] });
  assert.deepEqual(output[0], left); assert.deepEqual(output[1], right);
  pitch.process([[left]], [output], { pitchFactor: [1] });
  assert.deepEqual(output[1], left);
  for (let i = 0; i < 100; i++) pitch.process([[left, right]], [output], { pitchFactor: [1.5] });
  assert.ok(output.every(channel => channel.every(Number.isFinite)));
  const noise = new (processors.get("noise-gate-processor"))({});
  noise.process([[left, right]], [output], { threshold: [.001], attack: [.005], release: [.1] });
  assert.deepEqual(output[0], output[1]);
  noise.process([[left]], [output], { threshold: [.001], attack: [.005], release: [.1] });
  assert.deepEqual(output[0], output[1]);
  for (let i = 0; i < 100; i++) noise.process([[new Float32Array(128)]], [[new Float32Array(128)]], { threshold: [.001], attack: [.005], release: [.1] });
});
