import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMidi } from "../../src/hosted/midi.js";
import { Cdg } from "../../src/hosted/cdg.js";
import { detectPitch, PerformanceTools } from "../../src/hosted/performance.js";
import { youtubeId } from "../../src/hosted/youtube.js";

function midiFixture() {
  const track = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20, 0, 0xff, 5, 3, 72, 101, 121,
    0, 0x90, 69, 100, 0x83, 0x60, 69, 0, 0, 0xff, 0x2f, 0];
  return Uint8Array.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,track.length,...track]).buffer;
}
test("MIDI parser reads tempo, running-status note durations and KAR lyrics; malformed data is rejected", () => {
  const midi = parseMidi(midiFixture());
  assert.equal(midi.notes[0].pitch, 69);
  assert.equal(midi.notes[0].duration, 0.5);
  assert.equal(midi.lyrics[0].text, "Hey");
  assert.throws(() => parseMidi(new ArrayBuffer(12)), /invalid_midi/);
  assert.throws(() => parseMidi(midiFixture().slice(0, -3)), /invalid_midi/);
});

test("CD+G applies palette and tile packets, and rebuilds correctly after seeking backwards", () => {
  const packets = [];
  const packet = (instruction, data) => packets.push(9, instruction, 0, 0, ...Array.from({ length: 16 }, (_, i) => data[i] || 0), 0, 0, 0, 0);
  packet(30, [0, 0, 0x3c, 0]); // palette 1 red
  packet(6, [0, 1, 1, 1, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63]);
  let image;
  const canvas = { getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(300 * 216 * 4) }), putImageData: value => { image = value; } }) };
  const cdg = new Cdg(Uint8Array.from(packets).buffer, canvas);
  cdg.render(2 / 300);
  assert.equal(image.data[(12 * 300 + 6) * 4], 255);
  cdg.render(0);
  assert.equal(image.data[(12 * 300 + 6) * 4], 0);
  cdg.render(2 / 300);
  assert.equal(image.data[(12 * 300 + 6) * 4], 255);
});

test("scoring rejects silence, detects sung pitch and compares octave-equivalent guide notes", () => {
  assert.equal(detectPitch(new Float32Array(2048), 48000), null);
  const tone = Float32Array.from({ length: 2048 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000));
  assert.ok(Math.abs(detectPitch(tone, 48000) - 69) < 0.1);

});

test("YouTube URL parser accepts supported links and rejects lookalike hosts", () => {
  for (const url of ["M7lc1UVf-VE", "https://youtu.be/M7lc1UVf-VE?t=10", "https://www.youtube.com/watch?v=M7lc1UVf-VE", "https://youtube.com/shorts/M7lc1UVf-VE"])
    assert.equal(youtubeId(url), "M7lc1UVf-VE");
  for (const url of ["https://youtube.com.evil.test/watch?v=M7lc1UVf-VE", "https://evil.test/M7lc1UVf-VE", "file:///M7lc1UVf-VE", "short"])
    assert.equal(youtubeId(url), null);
});

test("a microphone permission response cannot start capture after disable or display retirement", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let resolve, stopped = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(r => { resolve = r; }) } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "navigator", original); else delete globalThis.navigator; });
  const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
  const player = { valid: () => true, generation: "display" };
  const pending = tools.startMicrophone(player);
  tools.stopMicrophone();
  resolve({ getTracks: () => [{ stop() { stopped = true; } }] });
  await assert.rejects(pending, /stale_display/);
  assert.equal(stopped, true); assert.equal(tools.stream, null);
});

test("recording exports performance and audio stems, keeps microphone off speakers and cleans up on stop", t => {
  const original = { document: globalThis.document, MediaRecorder: globalThis.MediaRecorder, MediaStream: globalThis.MediaStream };
  let videoStopped = false, drawn = 0;
  const connections = [], exports = [];
  const audioTrack = { kind: "audio", stop() {} }, videoTrack = { kind: "video", stop() { videoStopped = true; } };
  class Stream {
    constructor(tracks = [audioTrack]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable({ data: new Blob(["recording"]) }); this.onstop(); }
  }
  Object.assign(globalThis, { MediaRecorder: Recorder, MediaStream: Stream,
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {}, drawImage() { drawn++; } }), captureStream: () => new Stream([videoTrack]) }) } });
  t.after(() => Object.assign(globalThis, original));
  const tools = new PerformanceTools({ status() {}, score() {}, recording: (blob, title) => exports.push({ blob, title }) });
  const mic = { connect: node => connections.push(["mic", node]), disconnect() {} };
  const gate = { connect: node => connections.push(["gate", node]), disconnect() {} };
  tools.stream = new Stream(); tools.input = mic;
  tools.context = { createMediaStreamDestination: () => ({ stream: new Stream() }) };
  const player = { valid: () => true, loaded: "song", song: { format: "audio" }, localMedia: { readyState: 2 }, gate, room: { current: { title: "Performance" } }, lines: [], audio: { currentTime: 0 } };
  tools.startRecording(player);
  assert.equal(tools.recorders.length, 3);
  assert.deepEqual(connections.map(c => c[0]), ["mic", "gate", "gate"]);
  assert.equal(tools.recorders[0].stream.getVideoTracks().length, 1);
  tools.trackChanged();
  assert.equal(videoStopped, true); assert.equal(tools.recorders, null);
  assert.deepEqual(exports.map(e => e.title), ["Performance-performance", "Performance-microphone", "Performance-music"]);
  assert.ok(exports.every(e => e.blob.size > 0));
  player.song.format = "youtube";
  connections.length = 0;
  tools.startRecording(player);
  assert.equal(tools.recorders.length, 3);
  assert.equal(drawn, 1);
  assert.deepEqual(connections.map(c => c[0]), ["mic", "gate", "gate"]);
  tools.stopRecording();
});
