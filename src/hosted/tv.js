// Use the desktop appliance's presentation classes and shared styles.
export function mountTV() {
  const $ = (id) => document.getElementById(id);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet"; stylesheet.href = "/tv.css";
  document.head.append(stylesheet);
  const shell = document.createElement("div");
  shell.id = "tv-appliance";
  shell.className = "mode-menu";
  shell.innerHTML = `<div class="overlay-ui"><div class="standby-screen"><div class="standby-text">SELECT SONG</div></div><div class="idle-hint">SCAN TO CONNECT YOUR PHONE</div><div class="bottom-actions"><button class="action-button" id="tv-search">Search songs (Y)</button><button class="action-button" id="tv-fullscreen">Fullscreen</button><a class="action-button" href="/">Exit</a></div></div><div class="top-bar-container"></div><div class="player-ui"></div><div class="qr-code-container"><div class="qr-counter-badge"><span id="tv-remote-count">0</span> remotes</div><div class="qr-image-wrapper"></div><p id="tv-pairing">Scan to control &amp; sing</p></div><div class="info-bar"><span>UP NEXT</span><span id="tv-next">Choose your first song</span></div>`;
  $("room").append(shell);
  const stage = document.querySelector(".stage");
  shell.prepend(stage);
  $("end").classList.add("action-button");
  shell.querySelector(".bottom-actions").append($("end"));
  shell.querySelector(".top-bar-container").append($("now-title"), $("now-artist"), $("playback-status"));
  shell.append($("pitch-staff"));
  shell.querySelector(".bottom-actions").append($("toggle-scoring"));
  $("toggle-scoring").classList.add("action-button");
  shell.querySelector(".player-ui").append($("lyrics"), $("next-lyrics"), $("score"));
  const dock = document.createElement("div");
  dock.className = "tv-dock";
  dock.append(shell.querySelector(".bottom-actions"), $("play-controls"));
  shell.append(dock);
  shell.querySelector(".qr-image-wrapper").append($("qr"), $("manual-code"));
  for (const id of ["progress", "performance-status", "recordings", "clear-recordings"]) $(id).hidden = true;
  const library = document.createElement("section");
  library.id = "tv-library"; library.hidden = true;
  const close = document.createElement("button"); close.textContent = "Back to TV (Escape)";
  close.onclick = () => { library.hidden = true; };
  const performanceSettings = document.createElement("details");
  const performanceSummary = document.createElement("summary"); performanceSummary.textContent = "Microphone, scoring & recording";
  performanceSettings.append(performanceSummary, $("display-controls"));
  library.append(close, document.querySelector("#room > .columns"), performanceSettings);
  $("room").append(shell, library);
  document.querySelector(".room-heading").hidden = true;
  $("host-tools").classList.add("tv-management");
  $("host-tools").hidden = true;
  $("tv-search").onclick = () => { library.hidden = !library.hidden; if (!library.hidden) $("youtube-query").focus(); };
  $("tv-fullscreen").onclick = () => document.documentElement.requestFullscreen?.();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") library.hidden = true;
    if (event.key.toLowerCase() === "y" && !["INPUT", "TEXTAREA"].includes(event.target.tagName)) $("tv-search").click();
  });
  return (room) => {
    shell.classList.toggle("mode-player", !!room.current);
    shell.querySelector(".standby-screen").hidden = !!room.current;
    shell.querySelector(".player-ui").hidden = !room.current;
    shell.querySelector(".idle-hint").hidden = !!room.current;
    $("tv-next").textContent = room.queue.map((song) => `${song.title} · ${song.artist || song.nickname}`).join(" / ") || "Choose your first song";
    $("tv-remote-count").textContent = room.participants.filter((p) => p.role === "guest").length;
    $("host-tools").hidden = true;

  };
}
