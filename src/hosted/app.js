import { BrowserServices } from "../platform/BrowserServices.js";
import { BrowserPlayer } from "./player.js";
import { PerformanceTools } from "./performance.js";
import { mountTV } from "./tv.js";
import { RemoteMicrophone } from "./remote-microphone.js";
import { youtubeId } from "./youtube.js";

const $ = (id) => document.getElementById(id);
const services = new BrowserServices();
let tv = location.pathname === "/tv";
const dashboard = $("dashboard");
if (!dashboard) document.body.classList.add(tv ? "tv" : "control");
let renderTV = tv ? mountTV() : null;
if (tv) $("welcome").hidden = true;
const remoteMicrophone = new RemoteMicrophone({ tv, status: (message) => { $("remote-mic-status").textContent = message; } });

let session,
  room,
  socket;
let invitation = new URLSearchParams(location.hash.slice(1)).get("invite");
// Erase secrets before any API request, Socket.IO connection, or navigation.
if (location.hash)
  history.replaceState(null, "", location.pathname + location.search);
if (invitation) $("join-code").value = invitation;
const tell = (value) => {
  $("message").textContent = value || "";
};
const showError = (error) =>
  tell(
    `${error.message}${error.retryAfterMs ? ` — try again in ${Math.ceil(error.retryAfterMs / 1000)} seconds.` : ""}`,
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
const performanceTools = new PerformanceTools({
  status: (text) => { $("performance-status").textContent = text; },
  score: (text) => { $("score").textContent = text; },
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
  },
  error: showError,
  released: () => {
    remoteMicrophone.stop();
    $("start-display").hidden = !tv;
    $("stop-display").hidden = true;
    tell(
      "Karaoke paused. Start this screen again to continue.",
    );
  },
});
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
  $("logout").hidden = true;
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
  $("logout").hidden = false;
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
function render(snapshot) {
  if (room?.id === snapshot.id && snapshot.revision < room.revision) return;
  room = snapshot;
  $("room-title").textContent = room.name;
  $("now-title").textContent =
    room.current?.title || (tv ? "ENCORE KARAOKE" : "Waiting for your first song");
  $("now-artist").textContent = room.current?.artist || "";
  $("playback-status").textContent =
    `${room.status} · ${room.observed} · ${room.desired}`;
  $("progress").textContent = room.current
    ? `Approximately ${Math.floor(room.position || 0)} seconds · ${room.tempo.toFixed(2)}×`
    : "";
  $("display-controls").hidden = !tv || !isHost();
  $("play-controls").hidden = !room.canControl;
  $("seek-form").hidden = !room.canControl || room.seekable === false;
  $("host-tools").hidden = !isHost();
  $("cheers").replaceChildren(...(room.cheers || []).map((cheer) => {
    const node = label(`${cheer.nickname}: ${cheer.message}`, "cheer");
    setTimeout(() => node.remove(), 8000);
    return node;
  }));
  $("scores").replaceChildren(...(room.scores || []).slice().reverse().map((score) =>
    label(`${score.nickname} · ${score.title} · ${score.value} (${score.mode === "guide" ? "guide match" : "pitch stability"})`)));

  $("room-cap-label").hidden = !isHost();
  $("lock").textContent =
    room.status === "locked" ? "Unlock room" : "Lock room";
  for (const [id, value] of [
    ["volume", room.volume],
    ["tempo", room.tempo],
    ["guest-cap", room.policy.guestCap],
    ["room-cap", room.policy.roomCap],
  ])
    if (document.activeElement !== $(id)) $(id).value = String(value);
  if (document.activeElement !== $("guest-control"))
    $("guest-control").checked = room.policy.guestControl;
  $("queue").replaceChildren(
    ...room.queue.map((q, index) => {
      const li = document.createElement("li");
      li.className = "queue-item";
      const row = document.createElement("div"),
        info = document.createElement("div");
      info.className = "info";
      info.append(label(q.title), label(`${q.artist || ""} · ${q.nickname}`));
      row.append(info);
      if (isHost() && index > 0)
        row.append(
          button("↑", () => {
            const ids = room.queue.map((item) => item.id),
              i = ids.indexOf(q.id);
            [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
            return command("reorder", { ids }, room.revision);
          }),
        );
      if (isHost() || q.owner === session.id)
        row.append(
          button("Remove", () =>
            command("remove", { id: q.id }, room.revision),
          ),
        );
      li.append(row);
      return li;
    }),
  );
  $("participants").replaceChildren(
    ...room.participants.map((p) => {
      const row = document.createElement("div");
      row.className = "participant";
      row.append(label(`${p.nickname} · ${p.role}`, "info"));
      if (isHost() && p.role === "guest")
        row.append(
          button("Remove device", () => command("revoke", { deviceId: p.id })),
        );
      return row;
    }),
  );
  player.update(room).catch(showError);
  renderTV?.(room);
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
    $("logout").hidden = false;
    connect();
    await enter(joined.roomId);
    tell("");
  }),
);
$("logout").addEventListener(
  "click",
  run(async () => {
    try {
      await player.stop();
      if (session) {
        if (isHost()) await command("end");
        else await services.request("/api/logout", { method: "POST", body: {} });
      }
    } finally {
      services.clear();
      location.assign("/");
    }
  }),
);
$("choose-room").addEventListener("click", run(async () => {
  await player.stop();
  remoteMicrophone.stop();
  socket?.disconnect();
  room = null;
  invitation = null;
  $("join-code").value = "";
  $("room").hidden = true;
  $("lobby").hidden = true;
  $("welcome").hidden = false;
  $("join-code").focus();
}));
$("cheer-form").addEventListener("submit", run(async () => {
  await command("cheer", { message: $("cheer-message").value });
  $("cheer-message").value = "";
}));
$("youtube-form").addEventListener("submit", run(async () => {
  const query = $("youtube-query").value.trim(), id = youtubeId(query);
  if (id) {
    await command("enqueue", { youtube: id, title: $("youtube-title").value.trim() || `YouTube · ${id}` });
    tell("YouTube video queued.");
    return;
  }
  const roomId = room.id;
  const response = await services.request(`/api/youtube/search?roomId=${roomId}&q=${encodeURIComponent(query)}`);
  if (room.id !== roomId) return;
  $("youtube-results").replaceChildren(...response.items.map((video) => {
    const row = document.createElement("div"); row.className = "song";
    row.append(label(`${video.title} · ${video.artist}`), button("Queue +", () => command("enqueue", { youtube: video.videoId, title: video.title })));
    return row;
  }));
}));
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
  await player.stop();
  await command("end");
  location.assign("/");
}));
$("lock").addEventListener(
  "click",
  run(() => command("lock", { locked: room.status !== "locked" })),
);
for (const action of ["volume", "tempo"])
  $(action).addEventListener(
    "change",
    run(() => command(action, { value: Number($(action).value) })),
  );
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
async function startDisplay() {
  if (!socket?.connected) throw new Error("server_connection_required");
  player.connected = true;
  await player.claim(room.id);
  $("start-display").hidden = true;
  $("stop-display").hidden = false;
  tell("");
}
$("start-display").addEventListener("click", run(startDisplay));
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
    $("start-display").hidden = true;
    renderTV = mountTV();
    history.pushState(null, "", "/tv");
    const audioReady = player.initialize();
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
$("stop-display").addEventListener(
  "click",
  run(() => player.stop()),
);
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
$("remote-mic-start").addEventListener("click", run(async () => {
  await remoteMicrophone.start();
  $("remote-mic-stop").hidden = false;
  $("remote-mic-start").hidden = true;
}));
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
    $("logout").hidden = false;
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
