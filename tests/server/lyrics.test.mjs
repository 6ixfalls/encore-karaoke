import { test } from "node:test";
import assert from "node:assert/strict";
import { Lyrics, YouTubeMusicLyrics, YouTubeCaptionLyrics } from "../../dist/server/lyrics.js";

test("YouTube Music lyrics retain exact fractional start/end cues for the requested recording", async () => {
  const calls = [];
  const provider = new YouTubeMusicLyrics(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json(calls.length === 1 ? { tabs: [{ browseEndpoint: { browseId: "MPLYlyrics" } }] } : {
      lyrics: { sourceMessage: "Source: provider", timedLyricsData: [
        { lyricLine: "Second", cueRange: { startTimeMilliseconds: "2800", endTimeMilliseconds: "3500" } },
        { lyricLine: "First <line>", cueRange: { startTimeMilliseconds: "1250", endTimeMilliseconds: "2100" } },
      ] },
    });
  });
  const result = await provider.get("M7lc1UVf-VE", new AbortController().signal);
  assert.equal(calls[0].body.videoId, "M7lc1UVf-VE");
  assert.equal(calls[1].body.browseId, "MPLYlyrics");
  assert.equal(calls[1].body.context.client.clientName, "ANDROID_MUSIC");
  assert.deepEqual(result, { source: "Source: provider", lines: [
    { time: 1.25, end: 2.1, text: "First <line>" }, { time: 2.8, end: 3.5, text: "Second" },
  ] });
});

test("untimed lyrics never receive invented timestamps", async () => {
  let count = 0;
  const provider = new YouTubeMusicLyrics(async () => Response.json(++count === 1
    ? { browseId: "MPLYlyrics" } : { timedLyricsData: [{ lyricLine: "Untimed" }] }));
  assert.equal(await provider.get("M7lc1UVf-VE", new AbortController().signal), null);
});

test("provider failure falls through and an aborted request skips all providers", async () => {
  const result = { source: "another timing API", lines: [{ time: 1, end: 2, text: "Line" }] };
  let calls = 0;
  const lyrics = new Lyrics([
    { get: async () => { calls++; throw new Error("offline"); } },
    { get: async () => { calls++; return result; } },
  ]);
  assert.deepEqual(await lyrics.get("M7lc1UVf-VE", new AbortController().signal), result);
  assert.equal(calls, 2);
  assert.equal(await lyrics.get("M7lc1UVf-VE", AbortSignal.abort()), null);
  assert.equal(calls, 2);
});

const captionUrl = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=json3";
test("untimed Music lyrics fall back to the exact video's creator captions", async () => {
  let count = 0;
  const music = new YouTubeMusicLyrics(async () => Response.json(++count === 1
    ? { browseId: "MPLYlyrics" } : { lyricsData: { timedLyricsData: [{ lyricLine: "No timestamps" }] } }));
  const captions = new YouTubeCaptionLyrics("custom-yt-dlp", async (binary, args) => {
    assert.equal(binary, "custom-yt-dlp");
    assert.equal(args.at(-1), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.ok(args.includes("--skip-download"));
    return { subtitles: { en: [{ ext: "json3", url: captionUrl }] } };
  }, async (url, init) => {
    assert.equal(url.href, captionUrl);
    assert.equal(init.redirect, "error");
    return Response.json({ events: [
      { tStartMs: 200 },
      { tStartMs: 1250, dDurationMs: 2100, segs: [{ utf8: "First " }, { utf8: "cue" }] },
      { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: "Next cue" }] },
    ] });
  });
  assert.deepEqual(await new Lyrics([music, captions]).get("dQw4w9WgXcQ", new AbortController().signal), {
    source: "YouTube captions", lines: [{ time: 1.25, end: 3.35, text: "First cue" }, { time: 4, end: 5.5, text: "Next cue" }],
  });
});

test("captions omit automatic tracks, invalid timings and untrusted URLs", async () => {
  const signal = new AbortController().signal;
  const auto = new YouTubeCaptionLyrics("yt-dlp", async () => ({ automatic_captions: { en: [{ ext: "json3", url: captionUrl }] } }),
    async () => { assert.fail("automatic captions must not be fetched"); });
  assert.equal(await auto.get("dQw4w9WgXcQ", signal), null);
  const invalid = new YouTubeCaptionLyrics("yt-dlp", async () => ({ subtitles: { en: [{ ext: "json3", url: captionUrl }] } }),
    async () => Response.json({ events: [{ tStartMs: 2000, segs: [{ utf8: "Untimed" }] }] }));
  assert.equal(await invalid.get("dQw4w9WgXcQ", signal), null);
  const unsafe = new YouTubeCaptionLyrics("yt-dlp", async () => ({ subtitles: { en: [{ ext: "json3", url: "https://evil.test/api/timedtext" }] } }),
    async () => { assert.fail("untrusted caption host must not be fetched"); });
  await assert.rejects(unsafe.get("dQw4w9WgXcQ", signal), /lyrics_invalid_caption_url/);
});
