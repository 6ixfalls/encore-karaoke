// Use the desktop appliance's presentation classes and shared styles.
export function mountTV() {
  const $ = (id) => document.getElementById(id);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet"; stylesheet.href = "/tv.css";
  document.head.append(stylesheet);
  const shell = document.createElement("div");
  shell.id = "tv-appliance";
  shell.className = "mode-menu";
  shell.innerHTML = `<video class="tv-background" src="/assets/standby.mp4" autoplay muted loop playsinline aria-hidden="true"></video><div class="overlay-ui"><div class="standby-screen"><div class="standby-text">SELECT SONG</div></div><div class="idle-hint">SCAN TO CONNECT YOUR PHONE</div></div><div class="top-bar-container"><div class="info-bar persist-visible"><span class="info-bar-label">UP NEXT</span><span class="info-bar-content" id="tv-next">Choose your first song</span></div><div class="system-indicators">ENCORE</div></div><div class="tv-song-info"></div><div class="player-ui"></div><div class="qr-code-container"><div class="qr-counter-badge"><span id="tv-remote-count">0</span> remotes</div><div class="qr-image-wrapper"></div><p id="tv-pairing">Scan to control &amp; sing</p></div>`;
  $("room").append(shell);
  const stage = document.querySelector(".stage");
  shell.prepend(stage);
  shell.querySelector(".tv-song-info").append($("playback-status"), $("now-title"), $("now-artist"));
  shell.append($("pitch-staff"));
  const lastScore = document.createElement("p"); lastScore.id = "tv-last-score";
  shell.querySelector(".tv-song-info").append(lastScore);
  const lyricSection = document.createElement("div");
  lyricSection.className = "player-bottom-section";
  lyricSection.append($("lyrics-canvas"));
  shell.querySelector(".player-ui").append(lyricSection, $("score"));
  shell.querySelector(".qr-image-wrapper").append($("qr"), $("manual-code"));
  $("progress").hidden = true;
  // Shared event handlers still need these elements, but the TV is display-only.
  const controls = document.createElement("section");
  controls.hidden = true;
  controls.append($("play-controls"), $("display-controls"), $("host-tools"), document.querySelector("#room > .columns"));
  $("room").append(controls);
  document.querySelector(".room-heading").hidden = true;
  return (room) => {
    shell.classList.toggle("mode-player", !!room.current);
    const background = shell.querySelector(".tv-background");
    background.hidden = !!room.current;
    if (room.current) background.pause();
    else if (background.paused) background.play().catch(() => {});
    shell.querySelector(".standby-screen").hidden = !!room.current;
    shell.querySelector(".player-ui").hidden = !room.current;
    shell.querySelector(".idle-hint").hidden = !!room.current;
    const score = room.scores?.at(-1);
    lastScore.textContent = score ? `${score.title} · ${score.nickname}: ${Math.round(score.value)} / 100` : "";
    $("tv-next").textContent = room.queue.map((song) => `${song.title} · ${song.artist || song.nickname}`).join(" / ") || "Choose your first song";
    const remotes = room.participants.filter((p) => p.role === "guest").length;
    $("tv-remote-count").textContent = remotes;
    shell.querySelector(".qr-code-container").classList.toggle("has-remotes", remotes > 0);
    $("host-tools").hidden = true;

  };
}
