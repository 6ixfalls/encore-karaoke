import { test } from "node:test";
import assert from "node:assert/strict";
import { YouTube, runJson } from "../../dist/server/youtube.js";

const source = { url: "https://rr1.googlevideo.com/videoplayback?signature=test", duration: 30, http_headers: { "User-Agent": "test-agent" } };
test("yt-dlp extraction uses safe arguments, caches signed URLs and preserves byte-range playback", async () => {
  const calls = [];
  const youtube = new YouTube("yt-dlp", async (binary, args) => {
    calls.push({ binary, args }); return source;
  }, async (url, init) => {
    assert.equal(url.hostname, "rr1.googlevideo.com");
    assert.equal(init.headers.Range, "bytes=2-5");
    assert.equal(init.headers.Cookie, undefined);
    return new Response("2345", { status: 206, headers: { "content-type": "video/mp4" } });
  });
  assert.equal((await youtube.stream("M7lc1UVf-VE", "bytes=2-5", new AbortController().signal)).status, 206);
  await youtube.resolve("M7lc1UVf-VE");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--ignore-config"));
  assert.ok(calls[0].args.includes("--skip-download"));
  assert.equal(calls[0].args.at(-1), "https://www.youtube.com/watch?v=M7lc1UVf-VE");
});
test("yt-dlp search uses structured output and treats the query as an argument", async () => {
  const youtube = new YouTube("yt-dlp", async (_binary, args) => {
    assert.equal(args.at(-1), "ytsearch12:karaoke & song");
    return { entries: [{ id: "M7lc1UVf-VE", title: "Song", channel: "Artist" }, { id: "bad" }] };
  });
  assert.deepEqual(await youtube.search("karaoke & song"), [{ videoId: "M7lc1UVf-VE", title: "Song", artist: "Artist" }]);
});
test("adaptive video and audio URLs are extracted without downloading or requiring a combined format", async () => {
  const youtube = new YouTube("yt-dlp", async () => ({ duration: 60, requested_formats: [
    { url: "https://rr1.googlevideo.com/video", vcodec: "avc1", acodec: "none" },
    { url: "https://rr1.googlevideo.com/audio", vcodec: "none", acodec: "mp4a" },
  ] }));
  const extracted = await youtube.resolve("M7lc1UVf-VE");
  assert.equal(extracted.url, "https://rr1.googlevideo.com/video");
  assert.equal(extracted.audioUrl, "https://rr1.googlevideo.com/audio");
});
test("pasted links use YouTube Music track and artist metadata instead of upload titles", async () => {
  const youtube = new YouTube("yt-dlp", async (_binary, args) => {
    assert.equal(args.at(-1), "https://www.youtube.com/watch?v=M7lc1UVf-VE");
    return { id: "M7lc1UVf-VE", title: "Song (Official Audio)", track: "Song", artists: ["Artist", "Guest"], duration: 195 };
  });
  assert.deepEqual(await youtube.metadata("M7lc1UVf-VE"), { videoId: "M7lc1UVf-VE", title: "Song", artist: "Artist, Guest", duration: 195 });
});
test("extraction rejects arbitrary URLs, live broadcasts, excessive duration and unsafe redirects", async () => {
  const signal = new AbortController().signal;
  const youtube = new YouTube("yt-dlp", async () => source, async () => new Response(null, { status: 302,
    headers: { location: "http://169.254.169.254/metadata" } }));
  await assert.rejects(youtube.resolve("https://evil.test"), /invalid_youtube_id/);
  await assert.rejects(youtube.stream("M7lc1UVf-VE", undefined, signal), /youtube_invalid_stream_url/);
  await assert.rejects(youtube.stream("M7lc1UVf-VE", "bytes=1-2,3-4", signal), /invalid_range/);
  for (const data of [{ ...source, is_live: true }, { ...source, duration: 601 }])
    await assert.rejects(new YouTube("yt-dlp", async () => data).resolve("M7lc1UVf-VE"), /youtube_duration_limit/);
  await assert.rejects(new YouTube("yt-dlp", async () => ({ ...source, url: "file:///etc/passwd" })).resolve("M7lc1UVf-VE"), /youtube_invalid_stream_url/);
});
test("missing yt-dlp fails explicitly", async () => {
  await assert.rejects(runJson("/nonexistent/encore-yt-dlp", []), /yt_dlp_unavailable/);
});

test("YouTube uploader metadata survives flat search without a Music placeholder", async () => {
  const youtube = new YouTube("yt-dlp", async () => ({ entries: [
    { id: "M7lc1UVf-VE", title: "Song", uploader: "Actual artist" },
  ] }));
  assert.equal((await youtube.search("Song"))[0].artist, "Actual artist");
});
