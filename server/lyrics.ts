import { requireValue } from "../shared/contracts.js";
import { runJson, type JsonRunner } from "./youtube.js";

export interface TimedLine { time: number; end: number; text: string }
export interface TimedLyrics { source: string; lines: TimedLine[] }
export interface LyricsProvider { get(videoId: string, signal: AbortSignal): Promise<TimedLyrics | null> }

function* objects(value: unknown): Generator<Record<string, unknown>> {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) yield value as Record<string, unknown>;
  for (const child of Object.values(value)) yield* objects(child);
}

// Keep timestamps in the recording's timebase. Untimed text cannot be synced.
export class YouTubeMusicLyrics implements LyricsProvider {
  constructor(private request: typeof fetch = fetch) {}
  private async api(endpoint: string, body: object, signal: AbortSignal, mobile = false): Promise<unknown> {
    const response = await this.request(`https://music.youtube.com/youtubei/v1/${endpoint}?alt=json`, {
      method: "POST", signal, redirect: "error",
      headers: { "Content-Type": "application/json", Origin: "https://music.youtube.com", Cookie: "SOCS=CAI" },
      body: JSON.stringify({ ...body, context: { client: { hl: "en",
        clientName: mobile ? "ANDROID_MUSIC" : "WEB_REMIX",
        clientVersion: mobile ? "7.21.50" : `1.${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.01.00` } } }),
    });
    requireValue(response.ok, "lyrics_unavailable", 502);
    const text = await response.text();
    requireValue(text.length <= 2 * 1024 * 1024, "lyrics_response_limit", 502);
    return JSON.parse(text);
  }
  async get(videoId: string, signal: AbortSignal): Promise<TimedLyrics | null> {
    requireValue(/^[\w-]{11}$/.test(videoId), "invalid_youtube_id");
    const next = await this.api("next", { videoId }, signal);
    const browseId = [...objects(next)].map(item => item.browseId)
      .find(id => typeof id === "string" && id.startsWith("MPLY"));
    if (!browseId) return null;
    const response = await this.api("browse", { browseId }, signal, true);
    const data = [...objects(response)].find(item => Array.isArray(item.timedLyricsData));
    if (!data) return null;
    const lines: TimedLine[] = [];
    for (const item of data.timedLyricsData as unknown[]) {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, unknown>;
      const cue = raw.cueRange as Record<string, unknown> | undefined;
      const time = Number(cue?.startTimeMilliseconds) / 1000;
      const end = Number(cue?.endTimeMilliseconds) / 1000;
      if (typeof raw.lyricLine !== "string" || !Number.isFinite(time) || !Number.isFinite(end) || time < 0 || end < time || end > 600) return null;
      lines.push({ time, end, text: raw.lyricLine.slice(0, 1000) });
    }
    return lines.length ? { source: typeof data.sourceMessage === "string" ? data.sourceMessage : "YouTube Music", lines: lines.sort((a, b) => a.time - b.time) } : null;
  }
}

export class Lyrics {
  constructor(private providers: LyricsProvider[] = [new YouTubeMusicLyrics()]) {}
  async get(videoId: string, signal: AbortSignal): Promise<TimedLyrics | null> {
    for (const provider of this.providers) {
      if (signal.aborted) return null;
      try {
        const result = await provider.get(videoId, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
        if (result?.lines.length) return result;
      } catch { /* Lyrics are optional; try the next exact-timing provider. */ }
    }
    return null;
  }
}

// Creator-provided captions use the exact video's clock, unlike matching a
// different album recording by title. Never substitute auto-generated tracks.
export class YouTubeCaptionLyrics implements LyricsProvider {
  constructor(private binary = "yt-dlp", private run: JsonRunner = runJson, private request: typeof fetch = fetch) {}
  async get(videoId: string, signal: AbortSignal): Promise<TimedLyrics | null> {
    requireValue(/^[\w-]{11}$/.test(videoId), "invalid_youtube_id");
    const metadata = await this.run(this.binary, ["--ignore-config", "--no-cache-dir", "--no-playlist", "--no-warnings",
      "--js-runtimes", "node", "--skip-download", "--dump-single-json", "--", `https://www.youtube.com/watch?v=${videoId}`], signal) as {
      subtitles?: Record<string, { ext?: string; url?: string }[]>;
      language?: string;
    };
    const tracks = metadata.subtitles || {};
    const languages = [...new Set([metadata.language, "en", ...Object.keys(tracks)])];
    const track = languages.flatMap(language => language ? tracks[language] || [] : []).find(track => track.ext === "json3");
    if (!track?.url) return null;
    const url = new URL(track.url);
    requireValue(url.protocol === "https:" && url.hostname === "www.youtube.com" && url.pathname === "/api/timedtext" &&
      !url.username && !url.password && !url.port, "lyrics_invalid_caption_url", 502);
    const response = await this.request(url, { signal, redirect: "error" });
    requireValue(response.ok, "lyrics_unavailable", 502);
    const text = await response.text();
    requireValue(text.length <= 2 * 1024 * 1024, "lyrics_response_limit", 502);
    const data = JSON.parse(text) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
    const lines: TimedLine[] = [];
    for (const event of data.events || []) {
      const content = (event.segs || []).map(segment => segment.utf8 || "").join("").trim();
      if (!content) continue;
      const time = Number(event.tStartMs) / 1000, end = time + Number(event.dDurationMs) / 1000;
      if (!Number.isFinite(time) || !Number.isFinite(end) || time < 0 || end <= time || end > 600) return null;
      lines.push({ time, end, text: content.slice(0, 1000) });
    }
    return lines.length ? { source: "YouTube captions", lines: lines.sort((a, b) => a.time - b.time) } : null;
  }
}
