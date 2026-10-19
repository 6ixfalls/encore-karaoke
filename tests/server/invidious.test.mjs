import { test } from "node:test";
import assert from "node:assert/strict";
import { Invidious } from "../../dist/server/invidious.js";
import { configuration } from "../../dist/server/config.js";

test("Invidious selects combined media, proxies locally, preserves ranges and never forwards credentials", async t => {
  const calls = [];
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (calls.length === 1) return Response.json({ formatStreams: [
      { itag: "22", type: "video/mp4" }, { itag: "18", type: "video/mp4" },
    ] });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "/videoplayback?stream=test" } });
    return new Response("2345", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 2-5/10" } });
  });
  const response = await new Invidious("https://iv.example").stream("M7lc1UVf-VE", "bytes=2-5", signal);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "2345");
  assert.equal(calls[1].url.pathname, "/latest_version");
  assert.equal(calls[1].url.searchParams.get("local"), "true");
  assert.equal(calls[1].url.searchParams.get("itag"), "18");
  assert.equal(calls[2].init.headers.Range, "bytes=2-5");
  assert.equal(calls[2].init.redirect, "manual");
  assert.deepEqual(Object.keys(calls[2].init.headers), ["Range"]);
});

test("Invidious rejects unsafe redirects before fetching and does not choose adaptive video-only streams", async t => {
  const signal = new AbortController().signal;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? Response.json({ formatStreams: [{ itag: "18", type: "video/mp4" }] }) :
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/metadata" } });
  });
  const iv = new Invidious("https://iv.example");
  await assert.rejects(iv.stream("M7lc1UVf-VE", undefined, signal), /invidious_invalid_stream_url/);
  assert.equal(calls, 2);
  t.mock.method(globalThis, "fetch", async () => Response.json({ adaptiveFormats: [{ itag: "137", type: "video/mp4" }] }));
  await assert.rejects(iv.stream("M7lc1UVf-VE", undefined, signal), /invidious_no_combined_stream/);
  await assert.rejects(iv.stream("https://evil.test/", undefined, signal), /invalid_youtube_id/);
  await assert.rejects(iv.stream("M7lc1UVf-VE", "bytes=1-2,3-4", signal), /invalid_range/);
});

test("Invidious search validates results and configuration requires a base origin", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.pathname, "/api/v1/search");
    assert.equal(url.searchParams.get("q"), "karaoke & song");
    return Response.json([{ videoId: "M7lc1UVf-VE", title: "Song", author: "Artist" }, { videoId: "bad" }]);
  });
  assert.deepEqual(await new Invidious("https://iv.example").search("karaoke & song"),
    [{ videoId: "M7lc1UVf-VE", title: "Song", artist: "Artist" }]);
  await assert.rejects(new Invidious().search("song"), /invidious_not_configured/);
  assert.equal(configuration({ INVIDIOUS_URL: "http://invidious:3000" }).invidiousUrl, "http://invidious:3000");
  for (const origin of ["ftp://iv.example", "https://iv.example/path", "https://user:pass@iv.example"])
    assert.throws(() => configuration({ INVIDIOUS_URL: origin }), /invalid_invidious_url/);
});

test("Invidious aborts upstream streams and bounds metadata", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (!init.headers) return Response.json({ formatStreams: [{ itag: "18", type: "video/mp4" }] });
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const pending = new Invidious("https://iv.example").stream("M7lc1UVf-VE", "bytes=0-", controller.signal);
  // Wait for the metadata read and the subsequent stream fetch.
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /aborted/);
  t.mock.method(globalThis, "fetch", async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(new Invidious("https://iv.example").search("song"), /metadata_too_large/);
});
