import { requireValue } from "../shared/contracts.js";

/** A single operator-configured instance; callers supply video IDs, never URLs. */
export class Invidious {
  constructor(private origin?: string) {}

  private url(path: string) {
    requireValue(this.origin, "invidious_not_configured", 503);
    return new URL(path, this.origin);
  }

  private async request(url: URL, init: RequestInit = {}) {
    // Check every redirect before connecting, including redirects from the instance.
    for (let hop = 0; hop < 6; hop++) {
      requireValue(!url.username && !url.password &&
        (url.origin === this.origin ||
          (url.protocol === "https:" && url.port === "" && url.hostname.endsWith(".googlevideo.com"))),
      "invidious_invalid_stream_url", 502);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 15000);
      let response: Response;
      try {
        response = await fetch(url, { ...init, redirect: "manual", signal: init.signal ?
          AbortSignal.any([init.signal, timeout.signal]) : timeout.signal });
      } finally { clearTimeout(timer); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        requireValue(location, "invidious_invalid_redirect", 502);
        url = new URL(location, url);
        continue;
      }
      return response;
    }
    throw new Error("invidious_redirect_limit");
  }

  private async json(url: URL, signal?: AbortSignal) {
    const response = await this.request(url, { signal: signal ?
      AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    requireValue(response.ok, "invidious_unavailable", 502);
    // Bound metadata even when Content-Length is absent or untrustworthy.
    const reader = response.body?.getReader();
    requireValue(reader, "invidious_invalid_response", 502);
    let data = "", size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireValue(size <= 2 * 1024 * 1024, "invidious_metadata_too_large", 502);
        data += decoder.decode(value, { stream: true });
      }
      return JSON.parse(data + decoder.decode());
    } finally { await reader.cancel(); }
  }

  async search(query: string) {
    const url = this.url("/api/v1/search");
    url.search = new URLSearchParams({ q: query, type: "video" }).toString();
    const data = await this.json(url) as { videoId: string; title: string; author: string }[];
    requireValue(Array.isArray(data), "invidious_invalid_response", 502);
    return data.filter((item) => item && /^[\w-]{11}$/.test(item.videoId) && typeof item.title === "string")
      .slice(0, 12).map((item) => ({ videoId: item.videoId, title: item.title, artist: item.author || "YouTube" }));
  }

  async stream(id: string, range: string | undefined, signal: AbortSignal, head = false) {
    requireValue(/^[\w-]{11}$/.test(id), "invalid_youtube_id");
    requireValue(!range || /^bytes=(\d*)-(\d*)$/.test(range) && range !== "bytes=-", "invalid_range", 416);
    const metadata = await this.json(this.url(`/api/v1/videos/${id}`), signal) as {
      formatStreams?: { itag: string; type: string }[];
    };
    // Progressive formats include both audio and video; adaptive video-only
    // formats would silently produce recordings without the backing track.
    const formats = Array.isArray(metadata.formatStreams) ? metadata.formatStreams : [];
    const format = formats.find((item) => item.itag === "18" && item.type?.startsWith("video/mp4")) ||
      formats.find((item) => /^\d+$/.test(item.itag) && item.type?.startsWith("video/mp4"));
    requireValue(format, "invidious_no_combined_stream", 502);
    const url = this.url("/latest_version");
    url.search = new URLSearchParams({ id, itag: format.itag, local: "true" }).toString();
    const response = await this.request(url, { method: head ? "HEAD" : "GET", signal,
      headers: range ? { Range: range } : {} });
    if (response.status === 416) { await response.body?.cancel(); return response; }
    if (![200, 206].includes(response.status) || !response.headers.get("content-type")?.startsWith("video/")) {
      await response.body?.cancel();
      requireValue(false, "invidious_stream_unavailable", 502);
    }
    return response;
  }
}
