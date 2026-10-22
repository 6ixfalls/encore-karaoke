// Encore BootManager / UIManager / PlaybackManager presentation, adapted to DOM
// and the browser playback clock. Theme classes and sound assets stay upstream.
import type { Preferences } from "./preferences.js";
import type { InputScoreResult, PerformanceScore } from "../../shared/scoring.js";
import { inputColor } from "./scoring/input-score.js";
import { parseMidi, renderMidi } from "./midi.js";
export interface Cue { time: number; end?: number; text: string }
export interface SongInfo { playbackId: string; title: string; artist?: string; nickname?: string; composer?: string; lyricist?: string; bpm?: number; key?: string }
type Score = Pick<PerformanceScore, "value" | "inputs" | "aggregation">;
interface PlayerView {
  context?: AudioContext; gate?: GainNode; loaded?: string | null; loading?: boolean;
  audio: { currentTime: number; paused: boolean; playbackRate: number };
  lines?: Cue[]; room?: { current?: SongInfo | null; status: string; scores?: (Score & { title: string; nickname: string; playbackId: string })[] };
  valid(): boolean;
  resultsUntil?: number;
}
const TIPS = [
  "TIP: You can use your phone to queue songs by scanning the QR code!",
  "Take a deep breath and get ready for the next verse.",
  "Grab a drink and rest your vocal cords.",
  "“Music speaks louder than words.” — Kousei Arima, Your Lie in April",
  "“Tomorrow will always be a better day.” — Haruka Kiritani, Project SEKAI",
];
export function gapPresentation(lines: Cue[], time: number): { countdown: number | null; interlude: boolean; target?: number } {
  const next = lines.findIndex(line => line.time > time);
  if (next < 0) return { countdown: null, interlude: false };
  const target = lines[next].time, previous = next ? lines[next - 1].end ?? target : 0;
  const gap = target - previous, remaining = target - time;
  if (time < previous || gap < 3.5) return { countdown: null, interlude: false };
  return { countdown: remaining <= 3 ? Math.ceil(remaining) : null,
    interlude: next > 0 && gap >= 8 && remaining > 3 && time >= previous + .5, target };
}
export function rankForScore(value: number): [string, string] {
  if (value >= 100) return ["HOW DID YOU PULL THAT OFF", "#00e676"];
  if (value >= 98) return ["WHAT", "#00e676"];
  if (value >= 90) return ["EXCELLENT", "#29b6f6"];
  if (value >= 80) return ["GREAT", "#ffee58"];
  if (value >= 60) return ["GOOD", "#ffca28"];
  if (value >= 50) return ["DECENT", "#ffca28"];
  if (value >= 20) return ["NICE TRY", "#ffca28"];
  return ["yikes", "#ef5350"];
}
function node(tag: string, className: string, text = ""): HTMLElement {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
}
export class Presentation {
  private intro: HTMLElement;
  private introTitle: HTMLElement;
  private metadata: HTMLElement;
  private badges: HTMLElement;
  private countdown: HTMLElement;
  private interlude: HTMLElement;
  private tip: HTMLElement;
  private results: HTMLElement;
  private scoreNumber: HTMLElement;
  private rank: HTMLElement;
  private scoreTitle: HTMLElement;
  private scoreStatus: HTMLElement;
  private inputResults: HTMLElement;
  private leaderboard: HTMLElement;
  private startupLayer?: HTMLElement;
  private introStarted = 0;
  private introWasShown = false;
  private resultStarted = 0;
  private resultScore?: Score;
  private resultSong?: SongInfo;
  private resultPending = false;
  private dismissedResult?: string;
  private lastTipTarget?: number;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private sound?: AudioBufferSourceNode;
  private soundVersion = 0;
  private confetti?: HTMLCanvasElement;
  private resultTimer?: ReturnType<typeof setTimeout>;
  private resultExitTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private wasValid = false;
  private onKey = (event: KeyboardEvent) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) return;
    if (["Escape", "Enter", " "].includes(event.key) && (this.startupLayer || !this.results.hidden)) {
      event.preventDefault(); this.skip();
    }
  };
  constructor(private shell: HTMLElement, private preferences: Preferences, private player: PlayerView,
    private resume: () => void = () => {}) {
    this.intro = node("div", "intro-card"); this.intro.id = "song-intro";
    const content = node("div", "intro-card-content"), left = node("div", "intro-card-left");
    this.introTitle = node("div", "intro-card-title"); this.metadata = node("div", "intro-card-artist-meta");
    left.append(this.introTitle, this.metadata, node("div", "intro-card-meta-list", "YOUTUBE · ENCORE"));
    this.badges = node("div", "intro-card-badges");
    const right = node("div", "intro-card-right"), slogan = node("div", "intro-card-slogan");
    slogan.innerHTML = 'Be the <span class="slogan-gold">star</span><br>that shines <span class="slogan-gold">bright.</span>';
    right.append(slogan); content.append(left, this.badges, node("div", "intro-card-divider"), right); this.intro.append(content);
    this.countdown = node("div", "countdown-display"); this.countdown.id = "vocal-countdown";
    this.interlude = node("div", "interlude-overlay"); this.interlude.id = "song-interlude";
    this.tip = node("div", "interlude-tip-box"); this.interlude.append(node("div", "interlude-text", "INTERLUDE"), this.tip);
    this.results = node("section", "post-song-screen-overlay"); this.results.id = "song-results"; this.results.hidden = true;
    this.results.setAttribute("aria-label", "Performance result");
    this.scoreTitle = node("div", "score-title-text", "YOUR SCORE");
    const main = node("div", "score-main-group"); this.scoreNumber = node("div", "score-display-number");
    this.rank = node("div", "rank-display-text"); main.append(this.scoreNumber, this.rank);
    this.leaderboard = node("div", "score-session-leaderboard");
    const skip = node("button", "score-skip-hint", "PRESS ENTER TO CONTINUE"); skip.addEventListener("click", () => this.skip());
    this.scoreStatus = node("p", "score-unavailable-reason");
    this.inputResults = node("div", "score-input-results");
    this.results.append(this.scoreTitle, main, this.scoreStatus, this.inputResults, this.leaderboard, skip);
    shell.append(this.intro, this.countdown, this.interlude, this.results);
    document.addEventListener("keydown", this.onKey);
    window.addEventListener("pagehide", () => this.dispose(), { once: true });
  }
  startup(): void {
    if (!this.preferences.startupIntro || this.startupLayer) return;
    const layer = node("section", "startup-intro"); layer.id = "startup-intro";
    const warning = node("div", "startup-warning");
    warning.append(node("h1", "", "PHOTOSENSITIVITY WARNING"), node("p", "", "This application contains rapid color changes, flashing lights, and visual patterns that may trigger seizures for people with photosensitive epilepsy. Viewer discretion is advised."));
    const title = node("div", "startup-title"); title.setAttribute("aria-label", "テレビ");
    for (const [i, character] of Array.from("テレビ").entries()) {
      const span = node("span", "terebi-char", character); span.style.setProperty("--char", String(i)); title.append(span);
    }
    const tiles = node("div", "startup-tiles");
    const columns = Math.max(1, Math.floor(window.innerWidth / 50));
    const rows = Math.max(1, Math.floor(window.innerHeight / 50));
    tiles.style.setProperty("--columns", String(columns));
    tiles.style.setProperty("--rows", String(rows));
    let lastTileDelay = 0;
    for (let i = 0; i < columns * rows; i++) {
      const tile = node("div", "startup-tile");
      const x = i % columns - (columns - 1) / 2, y = Math.floor(i / columns) - (rows - 1) / 2;
      const delay = Math.hypot(x, y) * 35;
      lastTileDelay = Math.max(lastTileDelay, delay);
      tile.style.setProperty("--delay", `${delay}ms`); tiles.append(tile);
    }
    // First reveal the desktop intro's white backing, then fade it into the TV.
    // Wait for the outermost tile even on large displays before starting the fade.
    tiles.style.setProperty("--reveal-delay", `${1700 + lastTileDelay}ms`);
    const finish = () => {
      if (this.startupLayer !== layer) return;
      clearTimeout(this.startupTimer);
      // The sound can outlast the reveal, especially on smaller displays or
      // while loading. Only an explicit skip or teardown should interrupt it.
      layer.remove(); this.startupLayer = undefined;
    };
    tiles.addEventListener("animationend", (event) => {
      if (event.target !== tiles || event.animationName !== "startupReveal") return;
      finish();
    });
    const skip = node("button", "startup-skip", "Skip intro"); skip.addEventListener("click", () => this.skip());
    layer.append(tiles, warning, title, skip); this.shell.append(layer); this.startupLayer = layer;
    this.startupTimer = setTimeout(() => {
      if (this.startupLayer !== layer) return;
      layer.classList.add("animating"); warning.hidden = true;
      // Reduced motion disables animations, so animationend may never fire.
      // Allow the full reveal duration plus a small margin before falling back.
      this.startupTimer = setTimeout(finish, 1700 + lastTileDelay + 650 + 100);
      void this.playSound("/assets/audio/startup.wav", .65);
    }, 4000);
  }
  private async playSound(url: string, volume = .5): Promise<void> {
    this.stopSound(); const version = this.soundVersion;
    const { context, gate } = this.player;
    if (!context || !gate || !this.player.valid()) return;
    try {
      let buffer = this.buffers.get(url);
      if (!buffer) {
        buffer = fetch(url).then(async response => {
          if (!response.ok) throw new Error("sound_unavailable");
          let bytes = await response.arrayBuffer();
          if (url.endsWith(".mid")) bytes = await (await renderMidi(parseMidi(bytes))).arrayBuffer();
          return context.decodeAudioData(bytes);
        });
        this.buffers.set(url, buffer);
      }
      const decoded = await buffer;
      if (version !== this.soundVersion || this.disposed || !this.player.valid()) return;
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = decoded; gain.gain.value = volume;
      source.connect(gain); gain.connect(gate); this.sound = source;
      await new Promise<void>(resolve => { source.onended = () => { source.disconnect(); gain.disconnect(); resolve(); }; source.start(); });
    } catch { this.buffers.delete(url); /* An unavailable sound never blocks playback. */ }
  }
  private stopSound(): void { this.soundVersion++; this.sound?.stop(); this.sound = undefined; }
  private showIntro(song: SongInfo): void {
    this.introTitle.textContent = song.title;
    this.metadata.replaceChildren(); this.badges.replaceChildren();
    for (const [label, value] of [["ARTIST:", song.artist], ["MUSIC:", song.composer], ["LYRICS:", song.lyricist]]) {
      if (!value) continue;
      const row = node("div", "intro-meta-row"); row.append(node("span", "intro-meta-label", label), node("span", "intro-meta-value", value)); this.metadata.append(row);
    }
    // YouTube metadata normally has neither BPM nor key. Never invent them.
    if (song.bpm) this.badges.append(node("div", "intro-badge intro-badge-bpm", `${Math.round(song.bpm)} BPM`));
    if (song.key) this.badges.append(node("div", "intro-badge intro-badge-key", song.key));
    this.intro.classList.remove("exiting"); this.intro.classList.add("visible");
  }
  update(): void {
    if (this.disposed) return;
    const song = this.player.room?.current;
    if (!this.player.valid() || this.player.room?.status === "ended") {
      this.hideStage(); if (this.wasValid) this.skip(); return;
    }
    this.wasValid = true;
    if (this.resultPending && (song?.playbackId !== this.resultSong?.playbackId ||
        this.player.loaded !== this.resultSong?.playbackId || !this.player.audio.paused)) this.skip(false);
    this.updateResult();
    const active = song && this.player.loaded === song.playbackId && !this.player.loading;
    if (!active) { this.hideStage(); return; }
    const elapsed = (performance.now() - this.introStarted) / 1000;
    const intro = this.introWasShown && this.preferences.songIntro && elapsed >= 0 && elapsed < 2.9;
    this.intro.classList.toggle("visible", intro && elapsed < 2.2);
    this.intro.classList.toggle("exiting", intro && elapsed >= 2.2);
    this.shell.classList.toggle("showing-song-intro", intro);
    const gap = gapPresentation(this.player.lines || [], this.player.audio.currentTime);
    this.countdown.textContent = String(gap.countdown ?? "");
    this.countdown.classList.toggle("visible", this.preferences.countdowns && !intro && gap.countdown !== null);
    const interlude = this.preferences.interludes && !intro && gap.interlude;
    this.interlude.classList.toggle("visible", interlude);
    if (interlude && gap.target !== this.lastTipTarget) {
      this.lastTipTarget = gap.target; this.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    }
  }
  prepare(song: SongInfo): number {
    this.introStarted = performance.now();
    this.lastTipTarget = undefined;
    this.introWasShown = this.preferences.songIntro;
    if (this.introWasShown) this.showIntro(song);
    return this.introWasShown ? 2900 : 0;
  }
  finish(song: SongInfo, score?: Score, reason?: string, inputs: InputScoreResult[] = score?.inputs || [], pending = false): void {
    if (!this.preferences.celebrations || !this.player.valid()) return;
    if (this.dismissedResult === song.playbackId) { this.player.resultsUntil = 0; return; }
    const reveal = this.resultPending && this.resultSong?.playbackId === song.playbackId;
    if (!reveal) this.skip(false);
    this.resultPending = pending; this.resultSong = song; this.resultScore = score;
    this.resultStarted = performance.now(); this.results.hidden = false;
    this.results.classList.remove("show-leaderboard"); this.results.classList.add("visible");
    this.results.setAttribute?.("aria-busy", String(pending));
    this.scoreTitle.textContent = inputs.length ? "GROUP SCORE" : song.nickname ? `${song.nickname.toUpperCase()}'S SCORE` : "YOUR SCORE";
    this.inputResults.replaceChildren();
    this.inputResults.hidden = !inputs.length;
    this.results.classList.remove("score-pending");
    if (pending) {
      this.results.classList.add("score-pending");
      this.scoreNumber.textContent = ""; this.rank.textContent = "";
      this.scoreStatus.hidden = false;
      this.scoreStatus.textContent = "Calculating your score…";
      this.leaderboard.classList.add("hidden");
      this.hideStage();
      return;
    }
    if (inputs.length) {
      this.inputResults.append(node("p", "score-group-method", "Group = average of available microphone scores. Each microphone is scored against the full song."));
      for (const input of inputs) {
        const row = node("div", "score-input-row"); row.style.setProperty("--input-color", inputColor(input.id));
        row.append(node("span", "", input.label), node("strong", "", input.value === null ? "UNAVAILABLE" : `${input.value} / 100`));
        if (input.value === null && input.reason) row.append(node("small", "", input.reason));
        this.inputResults.append(row);
      }
    }
    this.scoreStatus.hidden = !!score;
    this.scoreStatus.textContent = score ? "" : reason || "Not enough vocal samples were captured to calculate a score. Check your microphone and try again.";
    this.rank.textContent = ""; this.rank.style.transform = "scale(0.8)"; this.rank.style.opacity = "0";
    this.scoreNumber.textContent = score ? "0" : "—";
    if (!score) {
      this.rank.textContent = "SCORE UNAVAILABLE";
      this.rank.style.color = "#ffca28"; this.rank.style.transform = "scale(1)"; this.rank.style.opacity = "1";
    }
    this.leaderboard.classList.add("hidden");
    this.player.resultsUntil = performance.now() + 18400;
    this.resultTimer = setTimeout(() => this.skip(), 18000);
    this.hideStage();
    if (score) {
      const s = Math.floor(score.value);
      const fanfare = s >= 100 ? 4 : s >= 70 ? 3 : s >= 20 ? 1 : 2;
      const url = `/assets/audio/fanfare${fanfare === 1 ? "" : `-${fanfare}`}.mid`;
      const started = this.resultStarted;
      const audio = new Promise<void>(resolve => setTimeout(resolve, 1000)).then(() => {
        if (this.resultStarted !== started || this.results.hidden || this.resultExitTimer !== undefined) return;
        return this.preferences.fanfare ? this.playSound(url) : new Promise<void>(resolve => setTimeout(resolve, 4000));
      });
      void audio.then(() => {
        if (this.resultStarted !== started || this.results.hidden || this.resultExitTimer !== undefined || !this.preferences.narration) return;
        return this.playSound(`/assets/audio/scores/${s >= 100 ? 100 : s >= 70 ? 70 : s >= 50 ? 50 : s >= 20 ? 20 : 0}.wav`);
      });
    }
  }
  private updateResult(): void {
    if (this.results.hidden || this.resultExitTimer !== undefined || !this.resultSong) return;
    if (!this.preferences.celebrations) { this.skip(); return; }
    if (this.resultPending) return;
    const elapsed = performance.now() - this.resultStarted;
    if (this.resultScore) {
      const s = Math.floor(this.resultScore.value), progress = Math.min(1, elapsed / 3800);
      this.scoreNumber.textContent = progress === 1 ? String(this.resultScore.value) : String(Math.floor(s * (1 - (1 - progress) ** 3)));
      if (progress === 1 && !this.rank.textContent) {
        const [rank, color] = rankForScore(s); this.rank.textContent = rank; this.rank.style.color = color;
        Object.assign(this.rank.style, { transform: "scale(1)", opacity: "1", transition: "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)" });
        if (s >= 70 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) this.startConfetti();
      }
    }
    const scores = this.player.room?.scores || [];
    this.leaderboard.replaceChildren(node("h3", "", "TOP PERFORMANCES"));
    const grid = node("div", "score-lb-grid"); this.leaderboard.append(grid);
    for (const [i, score] of [...scores].sort((a, b) => b.value - a.value).slice(0, 5).entries()) {
      const row = node("div", "score-lb-row");
      if (score.playbackId === this.resultSong.playbackId) row.classList.add("is-current-singer");
      const avatar = node("div", "score-lb-avatar"); avatar.style.background = "#444";
      const details = node("div", "score-lb-details");
      details.append(node("span", "score-lb-name", score.nickname), node("span", "score-lb-song", score.title));
      row.append(node("span", "score-lb-rank", `#${i + 1}`), avatar, details, node("span", "score-lb-score", String(Math.floor(score.value))));
      grid.append(row);
    }
    this.results.classList.toggle("show-leaderboard", elapsed >= 10000 && scores.length > 0);
    this.leaderboard.classList.toggle("hidden", elapsed < 10000 || !scores.length);
  }
  private startConfetti(): void {
    // Same celebratory colors/count as upstream; canvas keeps this self-contained.
    const canvas = document.createElement("canvas"); canvas.className = "celebration-confetti";
    canvas.width = window.innerWidth; canvas.height = window.innerHeight; this.results.append(canvas); this.confetti = canvas;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const start = performance.now();
    const particles = Array.from({ length: 67 }, () => ({ x: canvas.width / 2, y: canvas.height / 2,
      vx: (Math.random() - .5) * 550, vy: -Math.random() * 450 - 50, color: ["#89cff0", "#ffd700", "#ff6666", "#66ff66"][Math.floor(Math.random() * 4)] }));
    const draw = () => {
      if (this.confetti !== canvas) return;
      const seconds = (performance.now() - start) / 1000; ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) { ctx.fillStyle = p.color; ctx.globalAlpha = Math.max(0, 1 - seconds / 3); ctx.fillRect(p.x + p.vx * seconds, p.y + p.vy * seconds + 160 * seconds ** 2, 8, 13); }
      if (seconds < 3) requestAnimationFrame(draw); else { canvas.remove(); this.confetti = undefined; }
    }; requestAnimationFrame(draw);
  }
  private hideStage(): void {
    this.intro.classList.remove("visible", "exiting"); this.shell.classList.remove("showing-song-intro");
    this.countdown.classList.remove("visible"); this.interlude.classList.remove("visible");
  }
  skip(resume = true): void {
    if (resume && this.resultExitTimer !== undefined) return;
    if (resume && this.resultPending) this.dismissedResult = this.resultSong?.playbackId;
    this.resultPending = false;
    const hadResult = !this.results.hidden;
    clearTimeout(this.startupTimer); clearTimeout(this.resultTimer); clearTimeout(this.resultExitTimer);
    this.resultExitTimer = undefined;
    this.startupLayer?.remove(); this.startupLayer = undefined;
    this.stopSound(); this.results.classList.remove("visible");
    this.confetti?.remove(); this.confetti = undefined;
    if (resume && hadResult && this.player.valid() && !this.disposed) {
      // Match upstream: fade for 400ms before allowing the next track to load.
      this.player.resultsUntil = performance.now() + 400;
      this.resultExitTimer = setTimeout(() => {
        this.resultExitTimer = undefined;
        this.results.hidden = true;
        this.player.resultsUntil = 0;
        if (this.player.valid()) this.resume();
      }, 400);
      return;
    }
    this.results.hidden = true;
    this.player.resultsUntil = 0;
  }
  dispose(): void { this.disposed = true; this.skip(false); this.hideStage(); document.removeEventListener("keydown", this.onKey); }
}
