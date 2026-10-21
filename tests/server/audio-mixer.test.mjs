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
