import { lyricFrame } from "./lyrics-timing.js";
import LyricsEngine from "../pkgs/system/managers/LyricsEngine.js";

// Adapt the browser's timed lines to the original renderer. Layout, colors,
// outlines, alternating rows and fades stay shared with desktop Encore.
export class HostedLyrics {
  constructor(canvas) {
    const surface = {
      elm: canvas,
      styleJs(styles) { Object.assign(canvas.style, styles); return this; },
    };
    this.engine = new LyricsEngine({
      dom: { lyricsCanvas: surface },
      state: { mode: "player", lyricFontFamily: "Radio Canada" },
      config: {},
      // Hosted playback has no native romanization service.
      romanizer: { async romanize() { return null; } },
    });
    this.engine.init();
    document.fonts?.addEventListener("loadingdone", this.engine.resizeLyricsCanvas);
    document.fonts?.ready.then(() => this.engine.resizeLyricsCanvas());
  }

  update(lines = [], position = 0) {
    const engine = this.engine;
    const changed = this.source !== lines && (!this.source ||
      lines.length !== this.source.length || lines.some((line, i) =>
        ["text", "time", "end"].some((key) => line[key] !== this.source[i][key])));
    this.source = lines;
    if (changed) {
      engine.parsedLrc = lines.map((line) => ({
        ...line,
        syllables: (line.text.match(/\S+\s*/gu) || []).flatMap((text) =>
          engine.asianRegex.test(text) && Array.from(text).length > 16
            ? text.match(/.{1,12}/gu) : [text]).map((text) => ({
          text, rawText: text, absoluteTime: line.time,
          endTime: line.end ?? line.time + 1, duetRole: "default",
        })),
      }));
      this.index = undefined;
      this.expired = undefined;
    }
    if (!lines.length) {
      if (engine.lyricsRafId) cancelAnimationFrame(engine.lyricsRafId);
      engine.lyricsRafId = null;
      engine.renderableLines = [];
      engine.lyricsCtx.clearRect(0, 0, engine.ctx.dom.lyricsCanvas.elm.width,
        engine.ctx.dom.lyricsCanvas.elm.height);
      return;
    }

    // Use the media clock directly so pauses and seeks stay exact.
    engine.currentMediaTime = position;
    engine.lastMediaTimeUpdate = null;
    const frame = lyricFrame(lines, position);
    const { index, showCurrent, showNext } = frame;
    const expired = !showCurrent;
    const preview = position < lines[index].time - .15;
    if (index !== this.index || expired !== this.expired || showNext !== this.showNext || preview !== this.preview) {
      this.showNext = showNext;
      this.preview = preview;
      this.index = index;
      this.expired = expired;
      engine.currentLrcIndex = preview ? -1 : index;
      engine.isLrcLine2Active = index >= 0 && index % 2 !== 0;
      const current = expired ? null : engine.parsedLrc[Math.max(0, index)];
      const other = showNext ? engine.parsedLrc[index + 1] : null;
      engine.currentLrcLine1 = engine.isLrcLine2Active ? other : current;
      engine.currentLrcLine2 = engine.isLrcLine2Active ? current : other;
      engine.lrcChangeTime = performance.now();
      engine.nextLineFadeStartMs = performance.now();
      engine.nextLineFadeDurationMs = 500;
      engine.calculateLyricLayout();
    }
    if (!engine.lyricsRafId)
      engine.lyricsRafId = requestAnimationFrame(() => engine.drawLyricsFrame());
  }
}
