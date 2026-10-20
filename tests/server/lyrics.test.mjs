import { test } from "node:test";
import assert from "node:assert/strict";
import { Lyrics, YouTubeMusicLyrics } from "../../dist/server/lyrics.js";

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
