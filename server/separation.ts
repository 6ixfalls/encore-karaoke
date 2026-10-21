import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, Readable, type Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, mkdtempSync, openSync, closeSync, createWriteStream, rmSync, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PitchDetector } from "pitchy";
import type { Configuration } from "./config.js";
import type { VideoSource, YouTube } from "./youtube.js";
import { requireValue, Fault } from "../shared/contracts.js";
import { Lyrics, type TimedLyrics } from "./lyrics.js";

const RATE = 44100, WINDOW = 2048, HOP = 1024;
function storageError(error: NodeJS.ErrnoException) {
  return ["ENOSPC", "EDQUOT"].includes(error.code || "") ? "separation_storage_full"
    : ["EACCES", "EPERM", "EROFS"].includes(error.code || "") ? "separation_storage_unwritable" : "separation_storage_failed";
}
export class VocalFrames {
  pitches: (number | null)[] = [];
  samples = 0;
  singable = 0;
  private carry = new Float32Array(0);
  private detector = PitchDetector.forFloat32Array(WINDOW);
  accept(packet: { start: number; samples: number; vocals: string }) {
    requireValue(packet.start === this.samples && Number.isInteger(packet.samples) && packet.samples > 0 &&
      packet.samples <= 8 * RATE && typeof packet.vocals === "string", "invalid_vocal_packet", 502);
    const bytes = Buffer.from(packet.vocals, "base64");
    requireValue(bytes.length === packet.samples * 4 && this.samples + packet.samples <= 600 * RATE, "vocal_packet_limit", 502);
    const pcm = new Float32Array(this.carry.length + packet.samples);
    pcm.set(this.carry);
    for (let i = 0; i < packet.samples; i++) {
      const value = bytes.readFloatLE(i * 4);
      requireValue(Number.isFinite(value), "invalid_vocal_pcm", 502);
      pcm[this.carry.length + i] = value;
    }
    let offset = 0;
    while (offset + WINDOW <= pcm.length) {
      const window = pcm.subarray(offset, offset + WINDOW);
      let sum = 0;
      for (const value of window) sum += value * value;
      const [hz, clarity] = Math.sqrt(sum / WINDOW) >= 0.005 ? this.detector.findPitch(window, RATE) : [0, 0];
      const pitch = hz >= 80 && hz <= 1000 && clarity >= 0.4 ? hz : null;
      this.pitches.push(pitch);
      if (pitch !== null) this.singable += HOP / RATE;
      offset += HOP;
    }
    this.carry = pcm.slice(offset);
    this.samples += packet.samples;
  }
  snapshot() { return { pitches: this.pitches, step: HOP / RATE, through: this.samples / RATE, singable: this.singable }; }
}

export interface SeparationJob {
  id: string; roomId: string; playbackId: string; deviceId: string;
  current: () => boolean; output: PassThrough; processes: ChildProcess[];
  controller: AbortController; frames: VocalFrames; state: "loading" | "processing" | "complete" | "failed";
  error?: string; claimed: boolean; started: number; progress: number; referenceComplete: boolean;
  directory: string; file: string; writer: WriteStream; ready: boolean;
  lyrics?: TimedLyrics | null;
}
export type Launcher = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

export class Separations {
  jobs = new Map<string, SeparationJob>();
  constructor(private config: Configuration, private youtube: Pick<YouTube, "resolve">, private launch: Launcher = spawn,
    private lyrics?: Lyrics) {
    if (config.separationStorageDir) {
      // This dedicated directory belongs to one server process. Remove media
      // orphaned by a crash before admitting any new playback jobs.
      let probe: string | undefined;
      try {
        mkdirSync(config.separationStorageDir, { recursive: true, mode: 0o700 });
        probe = mkdtempSync(join(config.separationStorageDir, "encore-probe-"));
        closeSync(openSync(join(probe, "write-test"), "wx", 0o600));
        for (const entry of readdirSync(config.separationStorageDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("encore-media-"))
            rmSync(join(config.separationStorageDir, entry.name), { recursive: true, force: true });
        }
      } catch (error) {
        this.logStorageError(error as NodeJS.ErrnoException);
        throw new Fault(storageError(error as NodeJS.ErrnoException), 502);
      } finally { if (probe) rmSync(probe, { recursive: true, force: true }); }
    }
  }
  private logStorageError(error: NodeJS.ErrnoException) {
    console.error("Temporary media storage unavailable", { path: this.config.separationStorageDir || tmpdir(),
      code: error.code, uid: process.getuid?.(), gid: process.getgid?.(),
      hint: "Mount a writable disk-backed emptyDir at SEPARATION_STORAGE_DIR; set pod fsGroup to the container group (1000)." });
  }
  async create(roomId: string, playbackId: string, deviceId: string, videoId: string, current: () => boolean) {
    for (const job of this.jobs.values()) {
      if (!job.current()) this.stop(job.id);
    }
    const existing = [...this.jobs.values()].find(j => j.roomId === roomId && j.playbackId === playbackId && j.deviceId === deviceId);
    if (existing && existing.current() && existing.state !== "failed") return existing;
    if (existing) this.stop(existing.id);
    requireValue(this.jobs.size < (this.config.maxSeparations || 1), "separation_busy", 503);
    let directory: string | undefined;
    let file: string, writer: WriteStream;
    try {
      directory = mkdtempSync(join(this.config.separationStorageDir || tmpdir(), "encore-media-"));
      file = join(directory, "backing.mp4");
      writer = createWriteStream(file, { fd: openSync(file, "wx", 0o600) });
    } catch (error) {
      this.logStorageError(error as NodeJS.ErrnoException);
      if (directory) rmSync(directory, { recursive: true, force: true });
      throw new Fault(storageError(error as NodeJS.ErrnoException), 502);
    }
    const job: SeparationJob = { id: randomUUID(), roomId, playbackId, deviceId, current, output: new PassThrough({ highWaterMark: 256 * 1024 }),
      processes: [], controller: new AbortController(), frames: new VocalFrames(), state: "loading", claimed: false,
      directory, file, writer, ready: false,
      started: Date.now(), progress: Date.now(), referenceComplete: false };
    job.output.on("error", () => {});
    // Retain the prepared instrumental for repeatable HTTP range requests.
    // Pausing or seeking no longer tears down the separation process.
    let bytes = 0;
    job.output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      job.progress = Date.now();
      if (bytes > 1024 * 1024 * 1024) this.fail(job, "separation_media_limit");
    });
    writer.on("error", (error: NodeJS.ErrnoException) => {
      if (!this.jobs.has(job.id) || job.state === "failed") return;
      const code = storageError(error);
      console.warn("Temporary media write failed", { code: error.code });
      this.fail(job, code);
    });
    writer.on("finish", () => { job.ready = job.state !== "failed"; });
    job.output.pipe(writer);
    // A full output pipe can intentionally suspend the entire processing chain.
    // Give inference a fresh stall interval when the consumer resumes reading.
    job.output.on("drain", () => { job.progress = Date.now(); });
    this.jobs.set(job.id, job);
    if (this.lyrics) void this.lyrics.get(videoId, job.controller.signal).then(result => { job.lyrics = result; });
    try {
      const source = await this.youtube.resolve(videoId, job.controller.signal);
      requireValue(current() && this.jobs.has(job.id), "stale_display", 409);
      this.start(job, source);
      return job;
    } catch (error) { this.stop(job.id); throw error; }
  }
  private start(job: SeparationJob, source: VideoSource) {
    const process = (command: string, args: string[], extra = {}) => {
      const child = this.launch(command, args, { stdio: ["pipe", "pipe", "pipe", "pipe"], ...extra });
      job.processes.push(child);
      child.on("error", () => this.fail(job, "separation_dependency_unavailable"));
      child.stdin?.on("error", () => {});
      child.stderr?.resume(); // Never expose signed URLs or subprocess diagnostics to clients.
      child.on("close", code => { if (code !== 0 && this.jobs.has(job.id)) this.fail(job, "separation_process_failed"); });
      return child;
    };
    const network = (url: string) => ["-nostdin", "-v", "error", "-rw_timeout", "30000000", "-user_agent", source.userAgent, "-i", url];
    const decoder = process(this.config.ffmpeg || "ffmpeg", [...network(source.audioUrl || source.url), "-t", "600", "-vn", "-f", "f32le", "-ar", "44100", "-ac", "2", "pipe:1"]);
    decoder.stdin?.end();
    const worker = process(this.config.python || "python3", ["-u", fileURLToPath(new URL("./separation_worker.py", import.meta.url))],
      { env: { ...globalThis.process.env, SEPARATION_DEVICE: this.config.separationDevice || "cpu" } });
    const gpu = this.config.ffmpegGpu || "0";
    const nvidia = this.config.ffmpegVideoMode === "nvidia";
    // CUDA input options belong before the video input; PCM audio stays on CPU.
    const videoInput = nvidia ? ["-hwaccel", "cuda", "-hwaccel_device", gpu, "-hwaccel_output_format", "cuda"] : [];
    const videoOutput = nvidia
      ? ["-c:v", "h264_nvenc", "-gpu", gpu, "-preset", "p4", "-tune", "ll", "-b:v", "5M", "-g", "60", "-bf", "0"]
      : ["-c:v", "copy"];
    const mux = process(this.config.ffmpeg || "ffmpeg", [...videoInput, ...network(source.url), "-f", "f32le", "-ar", "44100", "-ac", "2", "-i", "pipe:3",
      "-map", "0:v:0", "-map", "1:a:0", ...videoOutput, "-c:a", "aac", "-b:a", "192k", "-t", "600", "-shortest",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", "-f", "mp4", "pipe:1"]);
    mux.stdin?.end();
    const backing = mux.stdio[3] as Writable;
    backing.on("error", () => {});
    decoder.stdout!.pipe(worker.stdin!);
    worker.stdout!.pipe(backing);
    mux.stdout!.pipe(job.output);
    let pending = "";
    const reference = worker.stdio[3] as Readable;
    reference.setEncoding("utf8");
    reference.on("data", (part: string) => {
      pending += part;
      if (pending.length > 2 * 1024 * 1024) { this.fail(job, "vocal_packet_limit"); return; }
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          job.frames.accept(JSON.parse(line)); job.progress = Date.now(); job.state = "processing";
        } catch { this.fail(job, "invalid_vocal_packet"); return; }
      }
    });
    worker.on("close", code => {
      if (code === 0 && pending.length === 0 && job.frames.samples > 0) job.referenceComplete = true;
    });
    mux.on("close", code => {
      if (code === 0 && job.state !== "failed") {
        job.state = "complete";
        job.ready = job.writer.writableFinished;
      }
    });
  }
  // Read only committed bytes, waiting at the growing EOF instead of ending the response.
  media(job: SeparationJob, signal?: AbortSignal) {
    const jobs = this.jobs;
    return Readable.from((async function* () {
      const file = await open(job.file, "r");
      let offset = 0;
      try {
        while (!signal?.aborted && jobs.has(job.id) && job.current() && job.state !== "failed") {
          const available = job.writer.bytesWritten - offset;
          if (available > 0) {
            const bytes = Buffer.alloc(Math.min(available, 256 * 1024));
            const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
            offset += bytesRead;
            if (bytesRead) yield bytes.subarray(0, bytesRead);
          } else if (job.writer.writableFinished) return;
          else await delay(100, undefined, { signal });
        }
        throw new Fault(job.error || "stale_display", 502);
      } finally { await file.close(); }
    })());
  }
  playable(job: SeparationJob) {
    job.ready = job.state !== "failed" && job.writer.bytesWritten > 0 &&
      (job.frames.samples >= 16 * RATE || job.referenceComplete && job.writer.writableFinished);
    return job.ready;
  }
  get(id: string, roomId: string, deviceId: string) {
    const job = this.jobs.get(id);
    requireValue(job && job.roomId === roomId && job.deviceId === deviceId, "separation_not_found", 404);
    requireValue(job.current(), "stale_display", 409);
    requireValue(job.state !== "failed", job.error || "separation_failed", 502);
    return job;
  }
  fail(job: SeparationJob, error: string) {
    if (job.state === "failed") return;
    console.warn("Vocal separation failed", { error, processedSeconds: job.frames.samples / RATE, storedBytes: job.writer.bytesWritten });
    job.state = "failed"; job.error = error;
    job.controller.abort();
    job.processes.forEach(child => child.kill("SIGKILL"));
    job.output.destroy(new Fault(error, 502));
    job.writer.destroy();
    rmSync(job.directory, { recursive: true, force: true });
  }
  stopOwned(id: string, roomId: string, deviceId: string) {
    const job = this.jobs.get(id);
    requireValue(job && job.roomId === roomId && job.deviceId === deviceId, "separation_not_found", 404);
    this.stop(id);
  }
  stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id); job.controller.abort();
    job.processes.forEach(child => child.kill("SIGKILL")); job.output.destroy();
    job.writer.destroy();
    rmSync(job.directory, { recursive: true, force: true });
  }
  sweep() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!job.current() || now - job.started > 30 * 60_000) this.stop(job.id);
      else if (job.claimed && job.output.writableNeedDrain) job.progress = now;
      else if (job.state !== "complete" && job.state !== "failed" && now - job.progress > 300000) this.fail(job, "separation_stalled");
    }
  }
  close() { for (const id of this.jobs.keys()) this.stop(id); }
}
