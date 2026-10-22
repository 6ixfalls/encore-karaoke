import { BrowserServices } from "../platform/BrowserServices.js";
import { BrowserPlayer } from "./player.js";
import { PitchStaff } from "./scoring/staff.js";
import { PerformanceTools } from "./performance.js";
import { mountTV } from "./tv.js";
import { mountController } from "./controller.js";
import { RemoteMicrophone } from "./remote-microphone.js";
import { youtubeId } from "./youtube.js";
import { HostedLyrics } from "./lyrics.js";
import { Presentation } from "./presentation.js";
import { AudioMixer } from "./audio-mixer.js";
import { loadPreferences, savePreferences } from "./preferences.js";
import { mountSettings } from "./settings.js";
import { Romanizer } from "./romanizer.js";
import { mountInputStatus, mountMicrophoneMaster } from "./input-status.js";
import { mountMessage } from "./message.js";

const $ = (id) => document.getElementById(id);
const services = new BrowserServices();
let tv = location.pathname === "/tv";
const dashboard = $("dashboard");
if (!dashboard) document.body.classList.add(tv ? "tv" : "control");
if (!dashboard && !tv) mountController();
let renderTV = tv ? mountTV() : null;
if (tv) $("welcome").hidden = true;
const remoteMicrophone = new RemoteMicrophone({
  tv,
  status: (message) => { $("remote-mic-status").textContent = message; },
  level: (value) => {
    const meter = $("remote-mic-level");
    meter.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    meter.style.setProperty("--level", String(value));
  },
  connections: (count) => {
    const badge = $("tv-mic-badge");
    if (!badge) return;
    $("tv-mic-count").textContent = String(count);
    const description = `${count} connected ${count === 1 ? "microphone" : "microphones"}`;
    badge.setAttribute("aria-label", description);
    badge.title = description;
    badge.classList.toggle("has-microphones", count > 0);
  },
});

let session,
  room,
  socket;
let endingRoom = false;
let invitation = new URLSearchParams(location.hash.slice(1)).get("invite");
// Erase secrets before any API request, Socket.IO connection, or navigation.
if (location.hash)
  history.replaceState(null, "", location.pathname + location.search);
if (invitation) $("join-code").value = invitation;
const tell = mountMessage($("message"));
const showError = (error) =>
  tell(
    `${error.message === "separation_storage_unwritable" ? "Media storage is not writable. Mount /var/cache/encore-media as a writable Kubernetes volume and set pod fsGroup: 1000." : error.message}${error.retryAfterMs ? ` — try again in ${Math.ceil(error.retryAfterMs / 1000)} seconds.` : ""}`,
  );
const run = (fn) => async (event) => {
  event?.preventDefault();
  try {
    await fn(event);
  } catch (error) {
    showError(error);
  }
};
const button = (label, fn) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", run(fn));
  return b;
};
const label = (value, className) => {
  const node = document.createElement("span");
  node.textContent = value;
  if (className) node.className = className;
  return node;
};
const isHost = () => session?.role === "host";
const recordingUrls = [];
let lyricRenderer;
let presentation;
const preferences = loadPreferences();
const staff = new PitchStaff($("pitch-staff"), $("pitch-canvas"));
function setLiveScoring(enabled) {
  staff.setEnabled(enabled);
  $("toggle-scoring").setAttribute("aria-pressed", String(enabled));
  $("toggle-scoring").textContent = `Live scoring: ${enabled ? "on" : "off"}`;
}
setLiveScoring(tv);
const performanceTools = new PerformanceTools({
  staff,
  inputs: mountInputStatus($("microphone-inputs"), () => player.mixer),
  status: (text) => { $("performance-status").textContent = text; },
  score: () => {},
  recording: (blob, title) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title}.${blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm"}`;
    link.textContent = `Download ${title}`;
    const preview = document.createElement(blob.type.startsWith("video/") ? "video" : "audio");
    preview.controls = true; preview.preload = "metadata"; preview.src = url;
    preview.setAttribute("aria-label", title);
    recordingUrls.push({ url, link, preview, size: blob.size });
    $("recordings").append(preview, link);
  },
});
const player = new BrowserPlayer(services, {
  createMixer: (context, source, gate) => {
    const mixer = new AudioMixer(context, source, gate); mixer.apply(preferences); return mixer;
  },
  trackReady: (song) => presentation?.prepare(song) || 0,
  finished: (song, score, reason, inputs) => presentation?.finish(song, score, reason, inputs),
  media: $("local-media"), performance: performanceTools,
  telemetry: (data) => {
    if (socket?.connected)
      socket.emit("display:telemetry", data, (ack) => {
        player.handleTelemetryAck(data, ack).catch(showError);
      });
  },
  lyrics: (current, next) => {
    $("lyrics").textContent = current;
    $("next-lyrics").textContent = next;
    if (tv) {
      if (!lyricRenderer) {
        lyricRenderer = new HostedLyrics($("lyrics-canvas"), new Romanizer(services, () => room?.id));
        lyricRenderer.configure(preferences);
      }
      lyricRenderer.update(player.lines, player.audio.currentTime);
      presentation?.update();
      $("tv-appliance").classList.toggle("has-lyrics", !!(current || next));
    }
  },
  error: showError,
  released: () => {
    remoteMicrophone.stop();
    if (room?.status !== "ended") setTimeout(() => startDisplay().catch(showError), 0);
  },
});
function mountPresentation() {
  presentation = new Presentation($("tv-appliance"), preferences, player, () => player.update(room).catch(showError));
  presentation.startup();
  const refreshMaster = mountMicrophoneMaster($("microphone-master"), preferences, () => {
    savePreferences(preferences); player.mixer?.apply(preferences);
  });
  mountSettings($("display-controls"), preferences, async () => {
    refreshMaster();
    lyricRenderer?.configure(preferences);
    if (player.mixer) { await player.mixer.initialize(); player.mixer.apply(preferences); }
  }, showError, () => player.mixer?.resetMicrophoneSettings());
  $("tv-settings-title").textContent = "Encore settings";
}
if (tv) mountPresentation();
async function command(type, payload = {}, revision) {
  const ack = await services.command(room.id, type, payload, revision);
  if (!socket?.connected && type !== "end" && session) await refreshRoom();
  return ack;
}
async function refreshRoom() {
  render(await services.request(`/api/rooms/${room.id}`));
}
function membershipEnded() {
  remoteMicrophone.stop();
  services.clear();
  session = null;
  socket?.disconnect();
  player.stop().catch(showError);
  if (!tv) {
    $("room").hidden = true;
    $("welcome").hidden = false;
    $("join-code").value = "";
  }
  tell(tv ? "Room ended or server restarted. Reload this screen to launch karaoke again."
    : "This room has ended. Enter a new TV code to join.");
}
function connect() {
  socket?.disconnect();
  socket = window.io({
    auth: { token: services.token },
    transports: ["websocket", "polling"],
  });
  socket.on("connect", () => {
    $("connection").textContent = "Connected";
    socket.io.engine.on("ping", () => player.heartbeat());
    if (room) subscribe();
  });
  socket.on("disconnect", () => {
    $("connection").textContent = "Disconnected · playback paused";
    remoteMicrophone.stop();
    player.disconnected();
  });
  socket.on("connect_error", (error) => {
    $("connection").textContent = "Connection unavailable";
    remoteMicrophone.stop();
    player.disconnected();
    if (error.message === "unauthorized") membershipEnded();
    else showError(error);
  });
  remoteMicrophone.connect(socket, () => room, player);
  socket.on("session:revoked", membershipEnded);
  socket.on("room:state", (snapshot) => {
    if (room?.id === snapshot.id && snapshot.revision >= room.revision) {
      player.connected = true;
      render(snapshot);
    }
  });
}
function subscribe() {
  socket.emit("room:subscribe", { roomId: room.id }, (snapshot) => {
    if (snapshot.error) {
      showError(new Error(snapshot.error));
      player.stop().catch(showError);
      return;
    }
    if (room?.id !== snapshot.id) return;
    player.connected = true;
    render(snapshot);
    if (player.generation)
      player
        .renew()
        .then(() => player.update(room))
        .catch(showError);
  });
}
async function enter(id) {
  if (player.generation) await player.stop();
  const snapshot = await services.request(`/api/rooms/${id}`);
  room = snapshot;
  $("welcome").hidden = true;
  $("lobby").hidden = true;
  $("room").hidden = false;
  $("invitation").hidden = true;
  render(snapshot);
  if (socket?.connected) subscribe();
  if (tv && isHost()) await invite();
  $("remote-microphone").hidden = tv;

}
async function lobby() {
  session = await services.request("/api/session");
  $("welcome").hidden = true;
  $("lobby").hidden = !!invitation;
  $("room").hidden = true;
  $("rooms").replaceChildren(
    ...session.rooms.map((r) => button(r.name, () => enter(r.id))),
  );
  connect();
  if (!invitation || tv) {
    const target = session.roomId;
    if (target) await enter(target);
    else { $("welcome").hidden = false; $("lobby").hidden = true; }
  }
}
function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function render(snapshot) {
  if (room?.id === snapshot.id && snapshot.revision < room.revision) return;
  room = snapshot;
  $("room-title").textContent = room.name;
  $("now-title").textContent =
    room.current?.title || (tv ? "ENCORE KARAOKE" : "Waiting for your first song");
  $("now-artist").textContent = room.current?.artist || "";
  $("transpose-value").textContent = `${room.transpose > 0 ? "+" : ""}${room.transpose || 0}`;
  $("playback-status").textContent =
    room.observed === "loading" ? "Preparing instrumental…" : room.current ? room.observed : "Ready to sing";
  $("progress").textContent = room.current
    ? `Approximately ${Math.floor(room.position || 0)} seconds · ${room.tempo.toFixed(2)}×`
    : "";
  $("display-controls").hidden = !tv || !isHost();
  $("play-controls").hidden = !room.canControl;
  $("seek-form").hidden = !room.canControl || room.seekable === false;
  const duration = room.duration || 600;
  $("seek").max = String(duration);
  if (document.activeElement !== $("seek")) $("seek").value = String(room.position || 0);
  $("time-position").textContent = `${formatTime(room.position || 0)} / ${room.duration ? formatTime(duration) : "–:––"}`;
  $("play").disabled = !room.current && !room.queue.length;
  $("pause").disabled = room.desired !== "playing";
  $("host-tools").hidden = !isHost();
  $("room-cap-label").hidden = !isHost();
  $("lock").textContent =
    room.status === "locked" ? "Unlock room" : "Lock room";
  for (const [id, value] of [
    ["volume", room.volume],
    ["tempo", room.tempo],
    ["transpose", room.transpose || 0],
    ["guest-cap", room.policy.guestCap],
    ["room-cap", room.policy.roomCap],
  ])
    if (document.activeElement !== $(id)) $(id).value = String(value);
  if (document.activeElement !== $("guest-control"))
    $("guest-control").checked = room.policy.guestControl;
  $("queue-empty").hidden = room.queue.length > 0;
  $("song-queue").replaceChildren(...room.queue.map(item => {
    const row = document.createElement("li"); row.className = "queue-item";
    row.append(label(`${item.title} · ${item.artist} — ${item.nickname}`));
    if (isHost() || item.owner === session.id)
      row.append(button("Remove", () => command("remove", { id: item.id })));
    return row;
  }));
  player.update(room).catch(showError);
  renderTV?.(room);
  if (tv) startDisplay().catch(showError);
  remoteMicrophone.update();
  if (room.status === "ended") membershipEnded();
}
$("join-form").addEventListener(
  "submit",
  run(async () => {
    const joined = await services.request("/api/join", {
      method: "POST",
      body: { nickname: $("nickname").value.trim() || "Singer", invitation: $("join-code").value },
    });
    $("join-code").value = "";
    session = await services.request("/api/session");
    connect();
    await enter(joined.roomId);
    tell("");
  }),
);
$("youtube-form").addEventListener("submit", run(async () => {
  const query = $("youtube-query").value.trim(), id = youtubeId(query);
  if (id) {
    const track = await services.request(`/api/youtube/${id}/metadata?roomId=${room.id}`);
    await command("enqueue", { youtube: id, title: track.title, artist: track.artist });
    tell("Song queued.");
    return;
  }
  const roomId = room.id;
  const response = await services.request(`/api/youtube/search?roomId=${roomId}&q=${encodeURIComponent(query)}`);
  if (room.id !== roomId) return;
  $("youtube-results").replaceChildren(...response.items.map((video) => {
    const row = document.createElement("div"); row.className = "song";
    row.append(label(`${video.title} · ${video.artist}`), button("Queue +", () => command("enqueue", { youtube: video.videoId, title: video.title, artist: video.artist })));
    return row;
  }));
}));
$("toggle-scoring").addEventListener("click", () => {
  setLiveScoring(!staff.enabled);
});
$("mic-latency").addEventListener("change", run(() => {
  performanceTools.setLatency($("mic-latency").value);
}));
$("enable-mic").addEventListener("click", run(() => performanceTools.startMicrophone(player)));
$("disable-mic").addEventListener("click", () => {
  performanceTools.stopMicrophone();
  $("performance-status").textContent = "Microphone disabled.";
});
$("record").addEventListener("click", run(() => {
  if (recordingUrls.reduce((total, item) => total + item.size, 0) >= 256 * 1024 * 1024)
    throw new Error("Download and clear existing recordings before starting another.");
  performanceTools.startRecording(player);
}));
$("stop-record").addEventListener("click", () => performanceTools.stopRecording());
$("clear-recordings").addEventListener("click", () => {
  for (const item of recordingUrls) { item.preview.pause(); item.preview.removeAttribute("src"); item.preview.load(); item.preview.remove(); URL.revokeObjectURL(item.url); item.link.remove(); }
  recordingUrls.length = 0;
});
for (const action of ["play", "pause", "skip"])
  $(action).addEventListener(
    "click",
    run(() => command(action)),
  );
$("end").addEventListener("click", run(async () => {
  endingRoom = true;
  await player.stop();
  await command("end");
  location.assign("/");
}));
$("lock").addEventListener(
  "click",
  run(() => command("lock", { locked: room.status !== "locked" })),
);
for (const action of ["volume", "tempo", "transpose"])
  $(action).addEventListener(
    "change",
    run(() => command(action, { value: Number($(action).value) })),
  );
$("seek").addEventListener("change", run(() => command("seek", { position: Number($("seek").value) })));
$("seek-form").addEventListener(
  "submit",
  run(() => command("seek", { position: Number($("seek").value) })),
);
$("policy-form").addEventListener(
  "submit",
  run(() =>
    command("policy", {
      guestCap: Number($("guest-cap").value),
      guestControl: $("guest-control").checked,
      roomCap: Number($("room-cap").value),
    }),
  ),
);
let displayStarting;
function startDisplay() {
  if (endingRoom || !tv || !isHost() || !room || room.status === "ended" || !socket?.connected || player.generation || player.stopping)
    return Promise.resolve();
  if (displayStarting) return displayStarting;
  player.connected = true;
  displayStarting = player.claim(room.id).then(() => tell("")).finally(() => { displayStarting = null; });
  return displayStarting;
}
// Browser autoplay policies can suspend audio on a direct visit or reload.
// Reuse any normal interaction to unlock it, without a separate start screen.
for (const event of ["pointerdown", "keydown"])
  document.addEventListener(event, () => {
    if (tv && player.context?.state !== "running") player.initialize().then(startDisplay).catch(showError);
  }, { capture: true });
function connected() {
  if (socket?.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", ready);
      socket.off("connect_error", failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const timeout = setTimeout(() => failed(new Error("server_connection_required")), 10000);
    socket.once("connect", ready);
    socket.once("connect_error", failed);
  });
}
if (dashboard) {
  const launch = run(async () => {
    if (tv) return;
    // Start the existing media element's AudioContext while browser user
    // activation from the dashboard click is still live.
    tv = true;
    remoteMicrophone.tv = true;
    dashboard.hidden = true;
    document.body.className = "tv";
    $("welcome").hidden = true;
    setLiveScoring(true);
    renderTV = mountTV();
    history.pushState(null, "", "/tv");
    mountPresentation();
    const audioReady = player.initialize().then(() => player.mixer?.apply(preferences));
    await Promise.all([audioReady, boot()]);
    await connected();
    await startDisplay();
  });
  dashboard.querySelector('a[href="/tv"]').addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    return launch(event);
  });
  window.addEventListener("popstate", () => location.reload());
}
$("fullscreen").addEventListener(
  "click",
  run(() => document.documentElement.requestFullscreen?.()),
);
async function invite() {
  const grant = await services.request(`/api/rooms/${room.id}/pairing`, {
    method: "POST",
    body: {},
  });
  $("invitation").hidden = false;
  if (!/^data:image\/png;base64,/.test(grant.qr))
    throw new Error("invalid_qr_image");
  $("qr").src = grant.qr;
  const url = new URL(grant.url);
  if (url.origin !== location.origin || url.protocol !== location.protocol)
    throw new Error("invalid_invitation_url");
  $("join-link").href = url.href;
  $("join-link").textContent =
    "Join on your phone";
  $("invite-label").textContent =
    "Join the room";
  $("manual-code").textContent = grant.code || "";
  $("invite-expires").textContent =
    "This code stays the same until the room ends.";
}
$("invite").addEventListener(
  "click",
  run(() => invite()),
);
$("remote-mic-start").addEventListener("click", async () => {
  const start = $("remote-mic-start");
  start.disabled = true;
  $("remote-mic-status").textContent = "Requesting microphone access…";
  try {
    if (await remoteMicrophone.start()) {
      $("remote-mic-stop").hidden = false;
      start.hidden = true;
    }
  } catch (error) {
    $("remote-mic-status").textContent = error.message;
  } finally { start.disabled = false; }
});
$("remote-mic-stop").addEventListener("click", () => {
  remoteMicrophone.stop();
  $("remote-mic-stop").hidden = true;
  $("remote-mic-start").hidden = false;
});
async function boot() {
  // Membership is temporary and local to this tab; no account or login.
  try { session = await services.request("/api/session"); } catch (error) {
    if (error.status !== 401) throw error;
    services.clear();
    session = null;
  }
  if (invitation) {
    $("join-form").dispatchEvent(new Event("submit", { cancelable: true }));
  } else if (tv) {
    const launched = await services.request("/api/launch", { method: "POST", body: {} });
    session = await services.request("/api/session");
    connect();
    await enter(launched.roomId);
  } else await lobby();
}
window.addEventListener("hashchange", run(async () => {
  invitation = new URLSearchParams(location.hash.slice(1)).get("invite");
  history.replaceState(null, "", location.pathname + location.search);
  if (invitation) {
    $("join-code").value = invitation;
    await boot();
  }
}));
if (!dashboard) boot().catch((error) => {
  if (error.status !== 401) showError(error);
  $("welcome").hidden = false;
  $("lobby").hidden = true;
  $("connection").textContent = tv ? "Unable to launch karaoke" : "Enter your TV code";
});
