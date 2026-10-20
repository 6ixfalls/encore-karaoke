import { spawn } from "node:child_process";
import { requireValue, Fault } from "../shared/contracts.js";

export type JsonRunner = (binary: string, args: string[], signal?: AbortSignal) => Promise<unknown>;
export const runJson: JsonRunner = (binary, args, signal) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], signal });
  let data = "", finished = false;
  const timer = setTimeout(() => { child.kill("SIGKILL"); done(new Fault("youtube_extraction_timeout", 504)); }, 30000);
  function done(error?: Error) {
    if (finished) return;
    finished = true; clearTimeout(timer);
    if (error) reject(error);
    else { try { resolve(JSON.parse(data)); } catch { reject(new Fault("youtube_invalid_response", 502)); } }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    data += chunk.toString();
    if (Buffer.byteLength(data) > 2 * 1024 * 1024) { child.kill("SIGKILL"); done(new Fault("youtube_metadata_limit", 502)); }
  });
  child.on("error", () => done(new Fault("yt_dlp_unavailable", 503)));
  child.on("close", code => done(code === 0 ? undefined : new Fault("youtube_extraction_failed", 502)));
});

export interface VideoSource { url: string; audioUrl?: string; duration: number; userAgent: string }
interface MusicMetadata { id: string; title?: string; track?: string; artist?: string; artists?: string[]; channel?: string; uploader?: string; creator?: string; duration?: number }
function song(item: MusicMetadata) {
  const title = item.track || item.title;
  requireValue(typeof title === "string" && title.trim(), "youtube_invalid_response", 502);
  return { videoId: item.id, title: title.slice(0, 200), artist: (item.artists?.join(", ") || item.artist || item.creator || item.channel || item.uploader || "Unknown artist").slice(0, 200),
    ...(Number.isFinite(item.duration) && item.duration! > 0 ? { duration: item.duration } : {}) };
}
export class YouTube {
  private active = 0;
  private cache = new Map<string, { source: VideoSource; expires: number }>();
  constructor(private binary = "yt-dlp", private run: JsonRunner = runJson, private request: typeof fetch = fetch) {}
  private async json(args: string[], signal?: AbortSignal) {
    requireValue(this.active < 2, "youtube_busy", 503);
    this.active++;
    try { return await this.run(this.binary, ["--ignore-config", "--no-cache-dir", "--no-playlist", "--no-warnings", "--js-runtimes", "node", ...args], signal); }
    finally { this.active--; }
  }
  async search(query: string) {
    const data = await this.json(["--flat-playlist", "--playlist-end", "12", "--dump-single-json", "--skip-download", "--", `ytsearch12:${query}`]) as {
      entries?: MusicMetadata[];
    };
    requireValue(Array.isArray(data?.entries), "youtube_invalid_response", 502);
    return data.entries.filter(item => item && /^[\w-]{11}$/.test(item.id) && typeof item.title === "string")
      .slice(0, 12).map(song);
  }
  async metadata(id: string) {
    requireValue(/^[\w-]{11}$/.test(id), "invalid_youtube_id");
    const data = await this.json(["--dump-single-json", "--skip-download", "--", `https://www.youtube.com/watch?v=${id}`]) as MusicMetadata;
    requireValue(data && data.id === id, "youtube_invalid_response", 502);
    return song(data);
  }
  validate(url: URL) {
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.hostname.endsWith(".googlevideo.com"), "youtube_invalid_stream_url", 502);
  }
  async resolve(id: string, signal?: AbortSignal): Promise<VideoSource> {
    requireValue(/^[\w-]{11}$/.test(id), "invalid_youtube_id");
    const cached = this.cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.source;
    const data = await this.json(["--dump-single-json", "--skip-download", "-f", "bestvideo[height<=720][ext=mp4][vcodec^=avc1][protocol=https]+bestaudio[ext=m4a][protocol=https]/best[height<=720][ext=mp4][vcodec^=avc1][acodec!=none][protocol=https]", "--", `https://www.youtube.com/watch?v=${id}`], signal) as {
      url?: string; duration?: number; is_live?: boolean; http_headers?: { "User-Agent"?: string };
      requested_formats?: { url: string; vcodec?: string; acodec?: string }[];
    };
    const videoUrl = data?.requested_formats?.find(format => format.vcodec && format.vcodec !== "none")?.url || data?.url;
    const audioUrl = data?.requested_formats?.find(format => format.acodec && format.acodec !== "none")?.url || data?.url;
    requireValue(typeof videoUrl === "string" && typeof audioUrl === "string", "youtube_no_playable_stream", 502);
    const url = new URL(videoUrl), audio = new URL(audioUrl); this.validate(url); this.validate(audio);
    requireValue(!data.is_live && typeof data.duration === "number" && data.duration > 0 && data.duration <= 600, "youtube_duration_limit", 422);
    const userAgent = data.http_headers?.["User-Agent"] || "Encore-Karaoke";
    requireValue(typeof userAgent === "string" && userAgent.length < 512 && !/[\r\n]/.test(userAgent), "youtube_invalid_headers", 502);
    const source = { url: url.href, audioUrl: audio.href, duration: data.duration, userAgent };
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { source, expires: Date.now() + 60000 });
    return source;
  }
  async stream(id: string, range: string | undefined, signal: AbortSignal, head = false) {
    requireValue(!range || /^bytes=(\d*)-(\d*)$/.test(range) && range !== "bytes=-", "invalid_range", 416);
    const source = await this.resolve(id, signal);
    requireValue(!source.audioUrl || source.audioUrl === source.url, "youtube_combined_stream_required", 422);
    let url = new URL(source.url);
    for (let hop = 0; hop < 5; hop++) {
      this.validate(url);
      const response = await this.request(url, { method: head ? "HEAD" : "GET", signal, redirect: "manual",
        headers: { "User-Agent": source.userAgent, ...(range ? { Range: range } : {}) } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const target = response.headers.get("location");
        requireValue(target, "youtube_invalid_redirect", 502); url = new URL(target, url); continue;
      }
      if (response.status === 416) return response;
      if (![200, 206].includes(response.status) || !response.headers.get("content-type")?.startsWith("video/")) {
        await response.body?.cancel(); throw new Fault("youtube_stream_unavailable", 502);
      }
      return response;
    }
    throw new Fault("youtube_redirect_limit", 502);
  }
}
