import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { VocalFrames, Separations } from "../../dist/server/separation.js";
import { readFileSync, existsSync } from "node:fs";
import { configuration } from "../../dist/server/config.js";

export function fakeProcesses() {
  const children = [];
  const launch = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { command, args, options, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      stdio: [null, null, null, new PassThrough()], killed: false,
      kill() { this.killed = true; } });
    children.push(child); return child;
  };
  return { children, launch };
}
function packet(start, length, tone = true) {
  const pcm = Buffer.alloc(length * 4);
  for (let i = 0; i < length; i++) pcm.writeFloatLE(tone ? 0.2 * Math.sin(2 * Math.PI * 440 * (start + i) / 44100) : 0, i * 4);
  return { start, samples: length, vocals: pcm.toString("base64") };
}
const source = { url: "https://rr1.googlevideo.com/video", userAgent: "test", duration: 18 };

test("GPU configuration defaults to CPU and stream copy and rejects invalid settings", () => {
  const defaults = configuration({});
  assert.equal(defaults.separationDevice, "cpu");
  assert.equal(defaults.ffmpegVideoMode, "copy");
  assert.equal(defaults.ffmpegGpu, "0");
  for (const device of ["cpu", "mps", "cuda", "cuda:1"]) {
    assert.equal(configuration({ SEPARATION_DEVICE: device }).separationDevice, device);
  }
  assert.throws(() => configuration({ SEPARATION_DEVICE: "cuda:bad" }), /invalid_separation_device/);
  assert.throws(() => configuration({ FFMPEG_VIDEO_MODE: "bad" }), /invalid_ffmpeg_video_mode/);
  assert.throws(() => configuration({ FFMPEG_GPU: "-1" }), /invalid_ffmpeg_gpu/);
});

test("CUDA separation and NVIDIA video processing are independently configurable", async t => {
  for (const nvidia of [false, true]) {
    const { children, launch } = fakeProcesses();
    const config = configuration({ SEPARATION_DEVICE: "cuda:1", FFMPEG_VIDEO_MODE: nvidia ? "nvidia" : "copy", FFMPEG_GPU: "1" });
    const jobs = new Separations(config, { resolve: async () => source }, launch);
    t.after(() => jobs.close());
    await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => true);
    const [decoder, worker, mux] = children;
    assert.equal(worker.options.env.SEPARATION_DEVICE, "cuda:1");
    assert.equal(decoder.args.includes("-hwaccel"), false); // audio decode has no NVIDIA acceleration
    assert.equal(mux.args.includes("h264_nvenc"), nvidia);
    assert.equal(mux.args.includes("copy"), !nvidia);
    if (nvidia) {
      assert.ok(mux.args.indexOf("-hwaccel") < mux.args.indexOf("-i"));
      assert.equal(mux.args[mux.args.indexOf("-hwaccel_device") + 1], "1");
      assert.equal(mux.args[mux.args.indexOf("-gpu") + 1], "1");
      assert.equal(mux.args[mux.args.indexOf("-c:a") + 1], "aac");
    }
    assert.ok(mux.args.includes("1:a:0"));
  }
});

test("streamed vocal pitch windows span packet boundaries without duplicating time", () => {
  const split = new VocalFrames(), whole = new VocalFrames();
  split.accept(packet(0, 3000)); split.accept(packet(3000, 5820));
  whole.accept(packet(0, 8820));
  assert.deepEqual(split.snapshot(), whole.snapshot());
  assert.ok(Math.abs(split.pitches[0] - 440) < 1);
  assert.equal(split.samples, 8820);
  assert.throws(() => split.accept(packet(0, 10)), /invalid_vocal_packet/);
  assert.throws(() => new VocalFrames().accept({ start: 0, samples: 5, vocals: "AA==" }), /vocal_packet_limit/);
});
test("one bounded separation feeds instrumental muxing and independently supplies the vocal reference", async () => {
  const { children, launch } = fakeProcesses();
  let current = true;
  const jobs = new Separations({ maxSeparations: 1 }, { resolve: async () => source }, launch);
  const job = await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => current);
  assert.equal(children.length, 3);
  assert.equal(children[1].args.at(-1).endsWith("separation_worker.py"), true);
  assert.ok(children[2].args.includes("1:a:0")); // separated PCM, not the original audio
  assert.ok(children[2].args.includes("+frag_keyframe+empty_moov+default_base_moof"));
  children[1].stdio[3].write(JSON.stringify(packet(0, 8820)) + "\n");
  assert.equal(job.frames.samples, 8820);
  assert.equal(job.state, "processing");
  assert.equal(jobs.get(job.id, "room", "display"), job);
  assert.throws(() => jobs.get(job.id, "room", "guest"), /separation_not_found/);
  await assert.rejects(jobs.create("other", "play", "other", "M7lc1UVf-VE", () => true), /separation_busy/);
  current = false; jobs.sweep();
  assert.equal(jobs.jobs.size, 0);
  assert.ok(children.every(child => child.killed));
});
test("model failure and malformed metadata stop every process and never fall back to original vocals", async () => {
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({}, { resolve: async () => source }, launch);
  const job = await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => true);
  children[1].stdio[3].write('{"bad":true}\n');
  assert.equal(job.state, "failed");
  assert.ok(children.every(child => child.killed));
  assert.throws(() => jobs.get(job.id, "room", "display"), /invalid_vocal_packet/);
  jobs.close();
});
test("an extraction completed after retirement cannot start subprocesses", async () => {
  let resolve, current = true;
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({}, { resolve: () => new Promise(r => { resolve = r; }) }, launch);
  const pending = jobs.create("room", "play", "display", "M7lc1UVf-VE", () => current);
  current = false; jobs.sweep(); resolve(source);
  await assert.rejects(pending, /stale_display/);
  assert.equal(children.length, 0);
});

test("skipping during extraction admits the next track before the periodic sweep", async t => {
  let resolveOld, oldSignal, current = true;
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({ maxSeparations: 1 }, {
    resolve: (_id, signal) => {
      if (!oldSignal) {
        oldSignal = signal;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      return Promise.resolve(source);
    },
  }, launch);
  t.after(() => jobs.close());
  const pending = jobs.create("room", "old", "display", "M7lc1UVf-VE", () => current);
  const retired = assert.rejects(pending, /stale_display/);
  current = false;
  const next = await jobs.create("room", "next", "display", "M7lc1UVf-VE", () => true);
  assert.equal(oldSignal.aborted, true);
  resolveOld(source);
  await retired;
  assert.equal(jobs.jobs.size, 1);
  assert.equal(jobs.get(next.id, "room", "display"), next);
  assert.equal(children.length, 3);
});

test("replacing a stale running job kills its processes before admitting the next track", async t => {
  let current = true;
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({ maxSeparations: 1 }, { resolve: async () => source }, launch);
  t.after(() => jobs.close());
  const old = await jobs.create("room", "old", "display", "M7lc1UVf-VE", () => current);
  current = false;
  await jobs.create("room", "next", "display", "M7lc1UVf-VE", () => true);
  assert.ok(children.slice(0, 3).every(child => child.killed));
  assert.ok(old.output.destroyed);
  assert.equal(jobs.jobs.size, 1);
});

test("prepared media is retained for pause and seek and removed on retirement", async t => {
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({}, { resolve: async () => source }, launch);
  t.after(() => jobs.close());
  const job = await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => true);
  assert.equal(job.ready, false);
  const finished = once(job.writer, "finish");
  children[2].stdout.end("instrumental");
  children[2].emit("close", 0);
  await finished;
  assert.equal(job.ready, true);
  assert.equal(readFileSync(job.file, "utf8"), "instrumental");
  assert.equal(await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => true), job);
  assert.equal(children.length, 3);
  jobs.stop(job.id);
  assert.equal(existsSync(job.directory), false);
});

test("stalled preparation still fails without an active browser consumer", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({}, { resolve: async () => source }, launch);
  t.after(() => jobs.close());
  const job = await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => true);
  t.mock.timers.setTime(121001);
  jobs.sweep();
  assert.equal(job.error, "separation_stalled");
  assert.ok(children.every(child => child.killed));
});

test("output backpressure does not bypass the absolute job lifetime", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const { children, launch } = fakeProcesses();
  const jobs = new Separations({}, { resolve: async () => source }, launch);
  t.after(() => jobs.close());
  const job = await jobs.create("room", "play", "display", "M7lc1UVf-VE", () => true);
  job.claimed = true;
  children[2].stdout.write(Buffer.alloc(512 * 1024));
  t.mock.timers.setTime(1801001);
  jobs.sweep();
  assert.equal(jobs.jobs.size, 0);
  assert.ok(children.every(child => child.killed));
});
