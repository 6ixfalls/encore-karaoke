import { lyricFrame } from "./lyrics-timing.js";
import type { Preferences } from "./preferences.js";
import type { Cue } from "./presentation.js";
import type { Romanizer } from "./romanizer.js";
import LyricsEngine from "./lyrics-engine.js";

// Adapt the browser's timed lines to the original renderer. Layout, colors,
// outlines, alternating rows and fades stay shared with desktop Encore.
export class HostedLyrics {
  engine: LyricsEngine;
  private source?: Cue[];
  private index?: number;
  private expired?: boolean;
  private showNext?: boolean;
  private preview?: boolean;
  private options?: Preferences;
  constructor(canvas: HTMLCanvasElement, private romanizer?: Romanizer) {
    const surface = {
      elm: canvas,
      styleJs(styles: Partial<CSSStyleDeclaration>) { Object.assign(canvas.style, styles); return this; },
    };
    this.engine = new LyricsEngine({
      dom: { lyricsCanvas: surface },
      state: { mode: "player", lyricFontFamily: "Radio Canada" },
      config: {},
      // Hosted playback has no native romanization service.
      romanizer: { romanize: (text: string) => this.options?.romanization ? this.romanizer?.romanize(text) ?? Promise.resolve(null) : Promise.resolve(null) },
    });
    this.engine.init();
    document.fonts?.addEventListener("loadingdone", this.engine.resizeLyricsCanvas);
    document.fonts?.ready.then(() => this.engine.resizeLyricsCanvas());
  }

  configure(preferences: Preferences): void {
    this.options = preferences;
    Object.assign(this.engine.ctx.state, { lyricFontFamily: preferences.lyricFont,
      lyricFontSizeScale: preferences.lyricSize, lyricLineGapScale: preferences.lyricGap,
      lyricBottomMargin: preferences.lyricMargin, lyricAlignment: preferences.lyricAlignment,
      romanizationEnabled: preferences.romanization });
    this.engine.ctx.config.videoConfig = { lyricCase: preferences.lyricCase, lyricColors: { default: preferences.lyricColor } };
    this.index = undefined;
    this.source = undefined;
    this.engine.resizeLyricsCanvas();
  }
  update(lines: Cue[] = [], position = 0): void {
    position = Math.max(0, position + (this.options?.lyricOffset || 0) / 1000);
    const engine = this.engine;
    const changed = this.source !== lines && (!this.source ||
      lines.length !== this.source.length || lines.some((line, i) =>
          (["text", "time", "end"] as const).some((key) => line[key] !== this.source?.[i][key])));
    this.source = lines;
    if (changed) {
      engine.parsedLrc = lines.map((line) => ({
        ...line,
        syllables: (line.text.match(/\S+\s*/gu) || []).flatMap((text) =>
          engine.asianRegex.test(text) && Array.from(text).length > 16
            ? text.match(/.{1,12}/gu) || [] : [text]).map((text) => ({
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
