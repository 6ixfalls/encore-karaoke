import type { Cue } from "./presentation.js";
interface Palette { label: string; main: string; stroke: string; dim: string; dimStroke: string; ruby: { main: string; stroke: string; dim: string; dimStroke: string }; romaji: { text: string; stroke: string } }
export interface Syllable {
  text: string; rawText: string; absoluteTime: number; endTime: number; duetRole: string;
  furigana?: string; isRoleSwitch?: boolean; isHidden?: boolean;
}
interface LayoutSyllable extends Syllable {
  casedText?: string; indicatorText?: string; showRoleIndicator?: boolean;
  indicatorWidth: number; indicatorLeftMargin: number; furiW: number; romW: number;
  standaloneW: number; origW: number; blockWidth: number; layoutX: number; layoutY: number;
  isPartOfContinuousWord?: boolean; isContinuousWordStart?: boolean; continuousWordText?: string;
}
export interface LyricLine extends Cue { syllables: Syllable[] }
interface Chunk { role: string; syllables: LayoutSyllable[]; text?: string; romaji?: string }
type Row = LayoutSyllable[] & { layoutY: number; romajiChunks: Chunk[] };
interface RenderLine { isNextLine: boolean; isPreviousLine: boolean; syllables: LayoutSyllable[]; rows: Row[] }
interface Cache { dim: HTMLCanvasElement; main: HTMLCanvasElement; dimCtx: CanvasRenderingContext2D; mainCtx: CanvasRenderingContext2D; _dpr?: number }
interface Surface { elm: HTMLCanvasElement; styleJs(styles: Partial<CSSStyleDeclaration>): Surface }
interface Context {
  dom: { lyricsCanvas: Surface };
  state: { mode: string; lyricFontFamily: string; lyricFontSizeScale?: number; lyricLineGapScale?: number; lyricBottomMargin?: number; lyricAlignment?: string; romanizationEnabled?: boolean; isInterludeActive?: boolean; isTransitioning?: boolean; isDuet?: boolean };
  config: { videoConfig?: { lyricCase: string; lyricColors: Record<string, string> } };
  romanizer: { romanize(text: string): Promise<string | null> };
}
const makeRow = (): Row => Object.assign([] as LayoutSyllable[], { layoutY: 0, romajiChunks: [] as Chunk[] });
const layoutSyllable = (syllable: Syllable): LayoutSyllable => ({ ...syllable,
  indicatorWidth: 0, indicatorLeftMargin: 0, furiW: 0, romW: 0, standaloneW: 0,
  origW: 0, blockWidth: 0, layoutX: 0, layoutY: 0 });
// Canvas layout and drawing adapted from Encore upstream LyricsEngine.
// Copyright Encore Karaoke Labs. See THIRD_PARTY_NOTICES.md.
export const COLOR_PALETTES: Record<string, Palette> = {
  white: {
    label: "White",
    main: "#ffffff",
    stroke: "#010141",
    dim: "rgba(255, 255, 255, 0.4)",
    dimStroke: "rgba(1, 1, 65, 0.6)",
    ruby: {
      main: "#f2f2ff",
      stroke: "#01012b",
      dim: "rgba(230, 230, 255, 0.35)",
      dimStroke: "rgba(1, 1, 45, 0.5)",
    },
    romaji: {
      text: "rgba(235, 238, 255, 0.88)",
      stroke: "rgba(5, 5, 45, 0.85)",
    },
  },
  red: {
    label: "Red",
    main: "#ff6666",
    stroke: "#660000",
    dim: "rgba(255, 102, 102, 0.35)",
    dimStroke: "rgba(102, 0, 0, 0.6)",
    ruby: {
      main: "#ffe6e6",
      stroke: "#4d0000",
      dim: "rgba(255, 180, 180, 0.35)",
      dimStroke: "rgba(77, 0, 0, 0.5)",
    },
    romaji: {
      text: "rgba(255, 180, 180, 0.85)",
      stroke: "rgba(60, 0, 0, 0.85)",
    },
  },
  orange: {
    label: "Orange",
    main: "#ffb233",
    stroke: "#804000",
    dim: "rgba(255, 178, 51, 0.35)",
    dimStroke: "rgba(128, 64, 0, 0.6)",
    ruby: {
      main: "#fff2e6",
      stroke: "#663300",
      dim: "rgba(255, 210, 150, 0.35)",
      dimStroke: "rgba(102, 51, 0, 0.5)",
    },
    romaji: {
      text: "rgba(255, 215, 160, 0.85)",
      stroke: "rgba(70, 35, 0, 0.85)",
    },
  },
  yellow: {
    label: "Yellow",
    main: "#ffff33",
    stroke: "#665200",
    dim: "rgba(255, 255, 51, 0.35)",
    dimStroke: "rgba(102, 82, 0, 0.6)",
    ruby: {
      main: "#fffefa",
      stroke: "#594700",
      dim: "rgba(255, 255, 180, 0.35)",
      dimStroke: "rgba(89, 71, 0, 0.5)",
    },
    romaji: {
      text: "rgba(255, 255, 170, 0.85)",
      stroke: "rgba(60, 45, 0, 0.85)",
    },
  },
  green: {
    label: "Green",
    main: "#66ff66",
    stroke: "#004d00",
    dim: "rgba(102, 255, 102, 0.35)",
    dimStroke: "rgba(0, 77, 0, 0.6)",
    ruby: {
      main: "#eafeea",
      stroke: "#003800",
      dim: "rgba(180, 255, 180, 0.35)",
      dimStroke: "rgba(0, 56, 0, 0.5)",
    },
    romaji: {
      text: "rgba(180, 255, 180, 0.85)",
      stroke: "rgba(0, 40, 0, 0.85)",
    },
  },
  blue: {
    label: "Blue",
    main: "#66e6ff",
    stroke: "#004d66",
    dim: "rgba(102, 230, 255, 0.35)",
    dimStroke: "rgba(0, 77, 102, 0.6)",
    ruby: {
      main: "#e6faff",
      stroke: "#00364d",
      dim: "rgba(180, 240, 255, 0.35)",
      dimStroke: "rgba(0, 54, 77, 0.5)",
    },
    romaji: {
      text: "rgba(180, 242, 255, 0.85)",
      stroke: "rgba(0, 45, 60, 0.85)",
    },
  },
  purple: {
    label: "Purple",
    main: "#d966ff",
    stroke: "#4d0066",
    dim: "rgba(217, 102, 255, 0.35)",
    dimStroke: "rgba(77, 0, 102, 0.6)",
    ruby: {
      main: "#f9e6ff",
      stroke: "#33004d",
      dim: "rgba(240, 180, 255, 0.35)",
      dimStroke: "rgba(51, 0, 77, 0.5)",
    },
    romaji: {
      text: "rgba(240, 180, 255, 0.85)",
      stroke: "rgba(60, 0, 80, 0.85)",
    },
  },
  pink: {
    label: "Pink",
    main: "#ff66b3",
    stroke: "#660033",
    dim: "rgba(255, 102, 179, 0.35)",
    dimStroke: "rgba(102, 0, 51, 0.6)",
    ruby: {
      main: "#ffe6f2",
      stroke: "#4d0026",
      dim: "rgba(255, 180, 215, 0.35)",
      dimStroke: "rgba(77, 0, 38, 0.5)",
    },
    romaji: {
      text: "rgba(255, 180, 215, 0.85)",
      stroke: "rgba(60, 0, 40, 0.85)",
    },
  },
};

export default class LyricsEngine {
  ctx: Context;
  romanizer: Context["romanizer"];
  asianRegex = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  romajiCache: Record<string, string> = {};
  pendingRomajiFetches = new Set<string>();
  private romajiRetries = new Map<string, { attempts: number; retryAt: number }>();
  lineCaches: Cache[] = [];
  parsedLrc: LyricLine[] = [];
  renderableLines: RenderLine[] = [];
  currentMediaTime = 0;
  lastMediaTimeUpdate: number | null = null;
  currentLrcIndex = -1;
  currentLrcLine1: LyricLine | null = null;
  currentLrcLine2: LyricLine | null = null;
  isLrcLine2Active = false;
  lrcChangeTime = 0;
  nextLineFadeStartMs = 0;
  nextLineFadeDurationMs = 0;
  lyricsCtx!: CanvasRenderingContext2D;
  lyricsRafId: number | null = null;
  logicalWidth = 0;
  logicalHeight = 0;
  pendingCanvasHeight: number | null = null;
  requestCanvasCacheUpdate = false;
  constructor(context: Context) {
    this.ctx = context; this.romanizer = context.romanizer;
    this.resizeLyricsCanvas = this.resizeLyricsCanvas.bind(this);
    window.addEventListener("resize", this.resizeLyricsCanvas);
  }
  init() {
    this.lyricsCtx = this.ctx.dom.lyricsCanvas.elm.getContext("2d", { alpha: true })!;
    this.resizeLyricsCanvas();
  }
  resizeLyricsCanvas() {
    if (!this.ctx.dom.lyricsCanvas) return;
    const canvas = this.ctx.dom.lyricsCanvas.elm;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(window.innerWidth * 0.9, 1400);

    const logicalWidth = width;
    const fontScale = this.ctx.state.lyricFontSizeScale ?? 1.0;
    const mainFontSize = Math.floor(logicalWidth * 0.045 * fontScale);
    const fixedHeight = Math.max(250, mainFontSize * 10);

    this.logicalWidth = logicalWidth;
    this.logicalHeight = fixedHeight;

    canvas.width = width * dpr;
    canvas.height = fixedHeight * dpr;
    const margin = Number(this.ctx.state.lyricBottomMargin) || 0;
    this.ctx.dom.lyricsCanvas.styleJs({
      width: `${width}px`,
      height: `${fixedHeight}px`,
      transform: `translateY(${-margin}px)`,
    });
    if (this.lyricsCtx) {
      this.lyricsCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.lyricsCtx.scale(dpr, dpr);
    }

    this.requestCanvasCacheUpdate = true;
    if (this.ctx.state.mode === "player") this.calculateLyricLayout();
  }

  getDuetColors(role: string) {
    const defaultMappings: Record<string, string> = {
      default: "white",
      m: "blue",
      f: "yellow",
      m2: "red",
      f2: "green",
      a: "orange",
    };
    const configuredColors = this.ctx.config.videoConfig?.lyricColors || {};
    const colorKey = configuredColors[role] || defaultMappings[role] || "white";
    return COLOR_PALETTES[colorKey] || COLOR_PALETTES.white;
  }

  calculateLyricLayout() {
    if (!this.parsedLrc) return;
    const canvas = this.ctx.dom.lyricsCanvas.elm;
    const ctx = this.lyricsCtx;
    const logicalWidth =
      parseFloat(canvas.style.width) || window.innerWidth * 0.9;

    const fontScale = this.ctx.state.lyricFontSizeScale ?? 1.0;
    const gapScale = this.ctx.state.lyricLineGapScale ?? 1.0;
    const mainFontSize = Math.floor(logicalWidth * 0.045 * fontScale);
    const subFontSize = Math.floor(logicalWidth * 0.018 * fontScale);
    const mainFontStr = `900 ${mainFontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`;
    const rubyFontStr = `700 ${subFontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`;
    const lineSpacing = mainFontSize * 1.25 * gapScale;
    const paragraphGap = mainFontSize * 1.8 * gapScale;
    let currentY = mainFontSize * 1.5;
    this.renderableLines = [];

    const buildLineLayout = (
      lineData: Syllable[],
      isNextLine: boolean,
      isPreviousLine = false,
      lineIndex = 0,
    ) => {
      if (!lineData || lineData.length === 0) return;
      const flatSyllables: LayoutSyllable[] = [];
      ctx.font = mainFontStr;

      for (let i = 0; i < lineData.length; i++) {
        const s = lineData[i];
        if (!s.furigana && s.text && s.text.match(/[ \u3000]/)) {
          const parts = s.text.match(/([^ \u3000]+[ \u3000]*|[ \u3000]+)/g);
          if (parts && parts.length > 1) {
            const totalWidth = ctx.measureText(s.text).width;
            let curAbs = s.absoluteTime;
            const totDur = s.endTime - s.absoluteTime || 0;
            for (let j = 0; j < parts.length; j++) {
              const p = parts[j];
              const pW = ctx.measureText(p).width;
              const pDur =
                totalWidth > 0
                  ? totDur * (pW / totalWidth)
                  : totDur / parts.length;
              flatSyllables.push({
                ...layoutSyllable(s),
                isRoleSwitch: j === 0 ? s.isRoleSwitch : false,
                text: p,
                rawText: p,
                absoluteTime: curAbs,
                endTime: curAbs + pDur,
              });
              curAbs += pDur;
            }
            continue;
          }
        }
        flatSyllables.push(layoutSyllable(s));
      }

      for (let i = 0; i < flatSyllables.length; i++) {
        const s = flatSyllables[i];

        if (
          this.ctx.state.isDuet &&
          s.isRoleSwitch &&
          s.duetRole !== "default"
        ) {
          s.showRoleIndicator = true;
          const roleLabels: Record<string, string> = { m: "M1", f: "F1", m2: "M2", f2: "F2", a: "ALL" };
          const rLabel = roleLabels[s.duetRole] || s.duetRole.toUpperCase();
          s.indicatorText = rLabel;

          ctx.font = `800 ${subFontSize * 0.85}px "${this.ctx.state.lyricFontFamily}", sans-serif`;
          const textW = ctx.measureText(rLabel).width;
          const pad = subFontSize * 0.6;
          const pillPadding = subFontSize * 1.2;

          const isFirstSyllable = i === 0;
          s.indicatorLeftMargin = isFirstSyllable ? 0 : subFontSize * 1.5;

          s.indicatorWidth = s.indicatorLeftMargin + textW + pillPadding + pad;
        } else {
          s.showRoleIndicator = false;
          s.indicatorWidth = 0;
          s.indicatorLeftMargin = 0;
        }
      }

      const lyricCase = this.ctx.config.videoConfig?.lyricCase || "original";

      if (lyricCase !== "original") {
        let capitalizeNext = true;
        const fullText = flatSyllables.map((s) => s.text || "").join("");
        const isIChar = new Array(fullText.length).fill(false);

        if (lyricCase === "sentence") {
          const iRegex = /\b(I)(['’](?:m|ll|d|ve))?\b/gi;
          let match;
          while ((match = iRegex.exec(fullText)) !== null) {
            isIChar[match.index] = true;
          }
        }

        let globalIndex = 0;

        for (let i = 0; i < flatSyllables.length; i++) {
          const s = flatSyllables[i];
          if (s.text) {
            if (lyricCase === "uppercase") {
              s.casedText = s.text.toUpperCase();
              globalIndex += s.text.length;
            } else if (lyricCase === "lowercase") {
              s.casedText = s.text.toLowerCase();
              globalIndex += s.text.length;
            } else if (lyricCase === "sentence") {
              let newText = "";
              for (let j = 0; j < s.text.length; j++) {
                const char = s.text[j];

                if (isIChar[globalIndex]) {
                  newText += char.toUpperCase();
                  capitalizeNext = false;
                } else if (/[.!?¿¡]/.test(char)) {
                  newText += char;
                  capitalizeNext = true;
                } else if (/\p{L}/u.test(char)) {
                  if (capitalizeNext) {
                    newText += char.toUpperCase();
                    capitalizeNext = false;
                  } else {
                    newText += char.toLowerCase();
                  }
                } else {
                  newText += char;
                }

                globalIndex++;
              }
              s.casedText = newText;
            }
          } else {
            s.casedText = s.text;
          }
        }
      } else {
        for (let i = 0; i < flatSyllables.length; i++) {
          flatSyllables[i].casedText = flatSyllables[i].text;
        }
      }

      const words: { syllables: LayoutSyllable[]; width: number }[] = [];
      let currentWord: LayoutSyllable[] = [];

      for (let i = 0; i < flatSyllables.length; i++) {
        const s = flatSyllables[i];
        const isAsian = this.asianRegex.test(s.rawText || "");
        if (currentWord.length > 0) {
          const prev = currentWord[currentWord.length - 1];
          const prevAsian = this.asianRegex.test(prev.rawText || "");
          if (
            s.rawText.startsWith(" ") ||
            s.rawText.startsWith("　") ||
            isAsian ||
            prevAsian
          ) {
            words.push({ syllables: currentWord, width: 0 });
            currentWord = [];
          }
        }
        ctx.font = rubyFontStr;
        s.furiW = s.furigana ? ctx.measureText(s.furigana).width : 0;
        s.romW = 0;
        ctx.font = mainFontStr;
        s.standaloneW = s.casedText ? ctx.measureText(s.casedText).width : 0;
        currentWord.push(s);
      }
      if (currentWord.length > 0) words.push({ syllables: currentWord, width: 0 });

      for (let i = 0; i < words.length; i++) {
        const word = words[i].syllables;
        let requiresExpansion = false;
        for (let j = 0; j < word.length; j++) {
          if (word[j].furiW > word[j].standaloneW) {
            requiresExpansion = true;
            break;
          }
        }
        let accText = "",
          previousSubWidth = 0,
          wordTotalWidth = 0;
        for (let j = 0; j < word.length; j++) {
          const s = word[j];
          if (requiresExpansion) {
            s.origW = s.standaloneW;
            s.blockWidth =
              Math.max(s.origW, s.furiW, s.romW) + (s.indicatorWidth || 0);
            s.isPartOfContinuousWord = false;
          } else {
            accText += s.casedText || "";
            const currentSubWidth = ctx.measureText(accText).width;
            s.origW = Math.max(0, currentSubWidth - previousSubWidth);
            previousSubWidth = currentSubWidth;
            s.blockWidth = s.origW + (s.indicatorWidth || 0);
            s.isPartOfContinuousWord = true;
          }
          s.isContinuousWordStart = false;
          s.continuousWordText = "";
          wordTotalWidth += s.blockWidth;
        }
        words[i].width = wordTotalWidth;
      }

      const rows: Row[] = [];
      let currentRow = makeRow(),
        currentX = 0;
      const maxWidth = logicalWidth * 0.95;

      for (let i = 0; i < words.length; i++) {
        const wordInfo = words[i],
          word = wordInfo.syllables;
        if (currentX + wordInfo.width > maxWidth && currentRow.length > 0) {
          rows.push(currentRow);
          currentRow = makeRow();
          currentX = 0;
        }
        let activeContinuousStart: LayoutSyllable | null = null,
          activeContinuousText = "";
        for (let j = 0; j < word.length; j++) {
          const s = word[j];
          if (currentX + s.blockWidth > maxWidth && currentRow.length > 0) {
            if (activeContinuousStart) {
              activeContinuousStart.continuousWordText = activeContinuousText;
              activeContinuousStart = null;
              activeContinuousText = "";
            }
            rows.push(currentRow);
            currentRow = makeRow();
            currentX = 0;
          }
          s.layoutX = currentX;
          currentX += s.blockWidth;
          currentRow.push(s);
          if (s.isPartOfContinuousWord) {
            if (!activeContinuousStart) {
              activeContinuousStart = s;
              s.isContinuousWordStart = true;
            }
            activeContinuousText += s.casedText || "";
          } else {
            if (activeContinuousStart) {
              activeContinuousStart.continuousWordText = activeContinuousText;
              activeContinuousStart = null;
              activeContinuousText = "";
            }
          }
        }
        if (activeContinuousStart)
          activeContinuousStart.continuousWordText = activeContinuousText;
      }
      if (currentRow.length > 0) rows.push(currentRow);

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];

        const romajiChunks: Chunk[] = [];
        let currentChunk: Chunk | null = null;

        for (let j = 0; j < r.length; j++) {
          const s = r[j];
          const role = s.duetRole || "default";
          if (!currentChunk || currentChunk.role !== role) {
            if (currentChunk) romajiChunks.push(currentChunk);
            currentChunk = {
              role: role,
              syllables: [s],
            };
          } else {
            currentChunk.syllables.push(s);
          }
        }
        if (currentChunk) romajiChunks.push(currentChunk);

        let hasRomaji = false;
        romajiChunks.forEach((chunk) => {
          const chunkText = chunk.syllables
            .map((s) => s.furigana || s.text || "")
            .join("")
            .trim();
          chunk.text = chunkText;

          if (this.ctx.state.romanizationEnabled !== false && this.asianRegex.test(chunkText)) {
            hasRomaji = true;
            if (this.romajiCache[chunkText] !== undefined) {
              chunk.romaji = this.romajiCache[chunkText];
            } else {
              chunk.romaji = "";
              if (!this.pendingRomajiFetches.has(chunkText) &&
                  performance.now() >= (this.romajiRetries.get(chunkText)?.retryAt ?? 0)) {
                this.pendingRomajiFetches.add(chunkText);
                this.romanizer.romanize(chunkText).then((res) => {
                  this.romajiCache[chunkText] = res || "";
                  this.romajiRetries.delete(chunkText);
                  this.pendingRomajiFetches.delete(chunkText);
                  this.calculateLyricLayout();
                  this.requestCanvasCacheUpdate = true;
                }).catch(error => {
                  const attempts = (this.romajiRetries.get(chunkText)?.attempts ?? 0) + 1;
                  const backoff = Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6));
                  const retryAfter = typeof error?.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
                    ? Math.max(0, error.retryAfterMs) : 0;
                  this.romajiRetries.set(chunkText, { attempts, retryAt: performance.now() + Math.max(backoff, retryAfter) });
                  this.pendingRomajiFetches.delete(chunkText);
                });
              }
            }
          } else {
            chunk.romaji = "";
          }
        });

        r.romajiChunks = romajiChunks;

        let rowWidth = 0,
          hasFurigana = false;
        for (let j = 0; j < r.length; j++) {
          rowWidth += r[j].blockWidth;
          if (r[j].furiW > 0 || r[j].furigana) hasFurigana = true;
        }

        const sideMargin = (logicalWidth - maxWidth) / 2;
        let startX = (logicalWidth - rowWidth) / 2;

        const alignment = this.ctx.state.lyricAlignment || "center";
        if (alignment === "left") startX = sideMargin;
        else if (alignment === "right") startX = Math.max(sideMargin, logicalWidth - rowWidth - sideMargin);
        else if (alignment === "alternating" || alignment === "split") {
          if (lineIndex === 0) {
            startX = sideMargin;
          } else {
            startX = Math.max(sideMargin, logicalWidth - rowWidth - sideMargin);
          }
        }

        const extraTop = hasFurigana ? mainFontSize * 0.6 : 0;
        const extraBottom = hasRomaji ? mainFontSize * 0.6 : 0;

        if (hasFurigana) currentY += extraTop;
        r.layoutY = currentY;

        for (let j = 0; j < r.length; j++) {
          r[j].layoutX += startX;
          r[j].layoutY = currentY;
        }
        currentY += lineSpacing + extraBottom;
      }
      currentY -= lineSpacing;
      currentY += paragraphGap;
      this.renderableLines.push({
        isNextLine,
        isPreviousLine,
        syllables: flatSyllables,
        rows: rows,
      });
    };

    if (this.parsedLrc?.length) {
      const isLastLrcLine =
        this.parsedLrc.length >= 2 &&
        this.currentLrcIndex === this.parsedLrc.length - 1;

      const isLine1Active = !this.isLrcLine2Active && this.currentLrcIndex >= 0;
      const isLine2Active = this.isLrcLine2Active && this.currentLrcIndex >= 0;

      const isLine1Next = !isLastLrcLine && !isLine1Active;
      const isLine2Next = !isLastLrcLine && !isLine2Active;
      const isLine1Prev = isLastLrcLine && !isLine1Active;
      const isLine2Prev = isLastLrcLine && isLine1Active;

      buildLineLayout(
        this.currentLrcLine1?.syllables || [],
        isLine1Next,
        isLine1Prev,
        0,
      );
      buildLineLayout(
        this.currentLrcLine2?.syllables || [],
        isLine2Next,
        isLine2Prev,
        1,
      );
    }

    const baseHeight = Math.max(250, mainFontSize * 10);
    const requiredHeight = Math.max(baseHeight, currentY + mainFontSize);
    const dpr = window.devicePixelRatio || 1;
    this.logicalHeight = requiredHeight;

    const currentPhysicalHeight = this.ctx.dom.lyricsCanvas.elm.height;
    const requiredPhysicalHeight = requiredHeight * dpr;

    if (Math.abs(currentPhysicalHeight - requiredPhysicalHeight) > 1) {
      this.pendingCanvasHeight = requiredHeight;
    }

    const bottomMarginOffset = this.ctx.state.lyricBottomMargin ?? 0;
    const bottomHeadroom = mainFontSize * 0.5 + bottomMarginOffset;

    const yOffset =
      this.logicalHeight - currentY - mainFontSize - bottomHeadroom;

    if (this.renderableLines) {
      for (let i = 0; i < this.renderableLines.length; i++) {
        const line = this.renderableLines[i];
        for (let j = 0; j < line.syllables.length; j++) {
          line.syllables[j].layoutY += yOffset;
        }
        for (let j = 0; j < line.rows.length; j++) {
          line.rows[j].layoutY += yOffset;
        }
      }
    }
    this.requestCanvasCacheUpdate = true;
  }

  updateCanvasCache() {
    const canvas = this.ctx.dom.lyricsCanvas.elm;
    const width = canvas.width,
      height = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const logicalWidth =
      parseFloat(canvas.style.width) || window.innerWidth * 0.9;

    while (this.lineCaches.length < this.renderableLines.length) {
      const dim = document.createElement("canvas"),
        main = document.createElement("canvas");
      this.lineCaches.push({
        dim,
        dimCtx: dim.getContext("2d", { alpha: true })!,
        main,
        mainCtx: main.getContext("2d", { alpha: true })!,
      });
    }

    const fontScale = this.ctx.state.lyricFontSizeScale ?? 1.0;
    const mainFontSize = Math.floor(logicalWidth * 0.045 * fontScale);
    const subFontSize = Math.floor(logicalWidth * 0.018 * fontScale);

    this.renderableLines.forEach((line, lineIdx) => {
      const cache = this.lineCaches[lineIdx];

      if (
        cache.dim.width !== width ||
        cache.dim.height !== height ||
        cache._dpr !== dpr
      ) {
        cache.dim.width = width;
        cache.dim.height = height;
        cache.main.width = width;
        cache.main.height = height;
        cache.dimCtx.setTransform(1, 0, 0, 1, 0, 0);
        cache.mainCtx.setTransform(1, 0, 0, 1, 0, 0);
        cache.dimCtx.scale(dpr, dpr);
        cache.mainCtx.scale(dpr, dpr);
        cache._dpr = dpr;
      } else {
        cache.dimCtx.save();
        cache.dimCtx.setTransform(1, 0, 0, 1, 0, 0);
        cache.dimCtx.clearRect(0, 0, width, height);
        cache.dimCtx.restore();
        cache.mainCtx.save();
        cache.mainCtx.setTransform(1, 0, 0, 1, 0, 0);
        cache.mainCtx.clearRect(0, 0, width, height);
        cache.mainCtx.restore();
      }
      cache.dimCtx.textBaseline = "alphabetic";
      cache.mainCtx.textBaseline = "alphabetic";
      cache.dimCtx.lineJoin = "round";
      cache.mainCtx.lineJoin = "round";

      line.syllables.forEach((s) => {
        if (s.isHidden) return;

        const textStartX = s.layoutX + (s.indicatorWidth || 0);
        const textBlockWidth = s.blockWidth - (s.indicatorWidth || 0);
        const centerX = textStartX + textBlockWidth / 2;

        const colors = this.ctx.state.isDuet
          ? this.getDuetColors(s.duetRole)
          : this.getDuetColors("default");

        if (s.showRoleIndicator && s.indicatorText) {
          const indHeight = mainFontSize * 0.65;
          const indY = s.layoutY - mainFontSize * 0.35;
          const indX = s.layoutX + (s.indicatorLeftMargin || 0);
          const pad = subFontSize * 0.6;
          const pillW =
            (s.indicatorWidth || 0) - (s.indicatorLeftMargin || 0) - pad;
          const fontSize = subFontSize * 0.85;

          const drawPill = (c: CanvasRenderingContext2D) => {
            c.save();
            c.fillStyle = colors.main;
            c.strokeStyle = colors.stroke;
            c.lineWidth = mainFontSize * 0.04;
            c.beginPath();

            if (c.roundRect) {
              c.roundRect(
                indX,
                indY - indHeight / 2,
                pillW,
                indHeight,
                indHeight / 2,
              );
            } else {
              const r = indHeight / 2;
              c.moveTo(indX + r, indY - r);
              c.lineTo(indX + pillW - r, indY - r);
              c.arc(indX + pillW - r, indY, r, -Math.PI / 2, Math.PI / 2);
              c.lineTo(indX + r, indY + r);
              c.arc(indX + r, indY, r, Math.PI / 2, Math.PI * 1.5);
            }
            c.fill();
            c.stroke();

            c.fillStyle = colors.stroke;
            c.font = `800 ${fontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`;
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(
              s.indicatorText || "",
              indX + pillW / 2,
              indY + fontSize * 0.05,
            );
            c.restore();
          };

          drawPill(cache.dimCtx);
          drawPill(cache.mainCtx);
        }

        const renderTextToCtx = (
          ctx: CanvasRenderingContext2D,
          text: string | undefined,
          y: number,
          font: string,
          w: number,
          isMain: boolean,
          isRuby = false,
        ) => {
          if (!text) return;
          ctx.font = font;

          const palette = isRuby ? colors.ruby : colors;
          ctx.fillStyle = isMain ? palette.main : palette.dim;
          ctx.strokeStyle = isMain ? palette.stroke : palette.dimStroke;

          const strokeMultiplier = isRuby ? 0.12 : 0.15;
          const fontSize = font.includes(String(mainFontSize))
            ? mainFontSize
            : subFontSize;
          ctx.lineWidth = fontSize * strokeMultiplier;

          ctx.strokeText(text, centerX - w / 2, y);
          ctx.fillText(text, centerX - w / 2, y);
        };

        renderTextToCtx(
          cache.dimCtx,
          s.furigana,
          s.layoutY - mainFontSize * 1.1,
          `700 ${subFontSize}px "${this.ctx.state.lyricFontFamily}"`,
          s.furiW,
          false,
          true,
        );
        renderTextToCtx(
          cache.mainCtx,
          s.furigana,
          s.layoutY - mainFontSize * 1.1,
          `700 ${subFontSize}px "${this.ctx.state.lyricFontFamily}"`,
          s.furiW,
          true,
          true,
        );

        if (s.isPartOfContinuousWord) {
          if (s.isContinuousWordStart && s.continuousWordText) {
            const wordX = textStartX;
            cache.dimCtx.font = `900 ${mainFontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`;
            cache.dimCtx.fillStyle = colors.dim;
            cache.dimCtx.strokeStyle = colors.dimStroke;
            cache.dimCtx.lineWidth = mainFontSize * 0.15;
            cache.dimCtx.strokeText(s.continuousWordText, wordX, s.layoutY);
            cache.dimCtx.fillText(s.continuousWordText, wordX, s.layoutY);

            cache.mainCtx.font = `900 ${mainFontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`;
            cache.mainCtx.fillStyle = colors.main;
            cache.mainCtx.strokeStyle = colors.stroke;
            cache.mainCtx.lineWidth = mainFontSize * 0.15;
            cache.mainCtx.strokeText(s.continuousWordText, wordX, s.layoutY);
            cache.mainCtx.fillText(s.continuousWordText, wordX, s.layoutY);
          }
        } else {
          renderTextToCtx(
            cache.dimCtx,
            s.casedText || s.text || "",
            s.layoutY,
            `900 ${mainFontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`,
            s.origW,
            false,
          );
          renderTextToCtx(
            cache.mainCtx,
            s.casedText || s.text || "",
            s.layoutY,
            `900 ${mainFontSize}px "${this.ctx.state.lyricFontFamily}", sans-serif`,
            s.origW,
            true,
          );
        }
      });

      cache.dimCtx.textAlign = "center";

      line.rows.forEach((r) => {
        if (r.romajiChunks && r.romajiChunks.length > 0) {
          r.romajiChunks.forEach((chunk) => {
            if (!chunk.romaji) return;

            const colors = this.ctx.state.isDuet
              ? this.getDuetColors(chunk.role)
              : this.getDuetColors("default");

            const firstS = chunk.syllables[0];
            const lastS = chunk.syllables[chunk.syllables.length - 1];

            const firstX = firstS.layoutX + (firstS.indicatorWidth || 0);
            const lastX = lastS.layoutX + lastS.blockWidth;
            const chunkCenterX = (firstX + lastX) / 2;
            const romajiY = r.layoutY + mainFontSize * 0.6;

            cache.dimCtx.font = `700 ${subFontSize}px "${this.ctx.state.lyricFontFamily}"`;
            cache.dimCtx.fillStyle = colors.romaji.text;
            cache.dimCtx.strokeStyle = colors.romaji.stroke;
            cache.dimCtx.lineWidth = subFontSize * 0.12;

            cache.dimCtx.strokeText(chunk.romaji, chunkCenterX, romajiY);
            cache.dimCtx.fillText(chunk.romaji, chunkCenterX, romajiY);
          });
        }
      });

      cache.dimCtx.textAlign = "left";
    });
  }

  drawLyricsFrame() {
    if (this.ctx.state.mode !== "player") return;
    if (this.ctx.state.isInterludeActive) {
      this.lyricsRafId = requestAnimationFrame(() => this.drawLyricsFrame());
      return;
    }

    // Retry only visible lyrics, using the render loop so hidden/disabled lines
    // do not leave background retry timers running.
    if (this.ctx.state.romanizationEnabled !== false && this.renderableLines.some(line =>
      line.rows.some(row => row.romajiChunks.some(chunk => {
        const retry = chunk.text && this.romajiRetries.get(chunk.text);
        return retry && performance.now() >= retry.retryAt && !this.pendingRomajiFetches.has(chunk.text!);
      })))) this.calculateLyricLayout();

    const ctx = this.lyricsCtx;
    const canvas = this.ctx.dom.lyricsCanvas.elm;
    const logicalWidth =
      parseFloat(canvas.style.width) || window.innerWidth * 0.9;

    if (this.pendingCanvasHeight) {
      const dpr = window.devicePixelRatio || 1;
      canvas.height = this.pendingCanvasHeight * dpr;
      this.ctx.dom.lyricsCanvas.styleJs({
        height: `${this.pendingCanvasHeight}px`,
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      this.pendingCanvasHeight = null;
      this.requestCanvasCacheUpdate = true;
    }

    const logicalHeight = canvas.height / (window.devicePixelRatio || 1);
    const fontScale = this.ctx.state.lyricFontSizeScale ?? 1.0;
    const mainFontSize = Math.floor(logicalWidth * 0.045 * fontScale);

    if (this.requestCanvasCacheUpdate) {
      this.updateCanvasCache();
      this.requestCanvasCacheUpdate = false;
    }

    if (this.ctx.state.isTransitioning) {
      this.lyricsRafId = requestAnimationFrame(() => this.drawLyricsFrame());
      return;
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    const isLrcMode = this.parsedLrc.length > 0;

    if (isLrcMode) {
      if (!this.renderableLines) {
        this.lyricsRafId = requestAnimationFrame(() => this.drawLyricsFrame());
        return;
      }
      let fadeProgress = 1.0;
      if (this.nextLineFadeStartMs && this.nextLineFadeDurationMs > 0) {
        fadeProgress = Math.min(
          1.0,
          (performance.now() - this.nextLineFadeStartMs) /
            this.nextLineFadeDurationMs,
        );
      }

      let baseTime = this.currentMediaTime || 0;
      if (this.lastMediaTimeUpdate) {
        const diff = (performance.now() - this.lastMediaTimeUpdate) / 1000;
        if (diff < 0.1) {
          baseTime += diff;
        }
      }

      const LYRICS_SYNC_OFFSET = 0.08;
      const currentTime = baseTime + LYRICS_SYNC_OFFSET;

      const firstLineGroupStartTime =
        this.renderableLines.length > 0 &&
        this.renderableLines[0].syllables &&
        this.renderableLines[0].syllables.length > 0
          ? this.renderableLines[0].syllables[0].absoluteTime
          : 0;

      const lineAlphas = this.renderableLines.map((line, lineIdx) => {
        let alpha = line.isNextLine ? fadeProgress : 1.0;
        const isFirstLineGroup = this.currentLrcIndex <= 0;

        if (isFirstLineGroup) {
          const maxLead = Math.min(firstLineGroupStartTime, 4.0);
          const staggerDelay = Math.min(0.5, maxLead / 4);
          const fadeDuration = 0.5;
          let fadeStart = firstLineGroupStartTime - maxLead;

          if (lineIdx === 1) fadeStart += staggerDelay;

          if (currentTime < fadeStart) {
            alpha = 0.0;
          } else if (currentTime < fadeStart + fadeDuration) {
            alpha = (currentTime - fadeStart) / fadeDuration;
          } else {
            alpha = 1.0;
          }
        }
        return alpha;
      });

      this.renderableLines.forEach((line, lineIdx) => {
        const cache = this.lineCaches[lineIdx];
        if (!cache) return;
        ctx.globalAlpha = lineAlphas[lineIdx];
        ctx.drawImage(cache.dim, 0, 0, logicalWidth, logicalHeight);
      });

      ctx.globalAlpha = 1.0;

      this.renderableLines.forEach((line, lineIdx) => {
        if (
          line.isNextLine &&
          (isLrcMode ||
            !line.syllables ||
            line.syllables.length === 0 ||
            currentTime < line.syllables[0].absoluteTime)
        ) {
          return;
        }
        const cache = this.lineCaches[lineIdx];
        if (!cache) return;

        ctx.save();
        const isFirstLineGroup = this.currentLrcIndex <= 0;

        if (isLrcMode && line.isPreviousLine) {
          ctx.globalAlpha = 1.0;
        } else if (isLrcMode && this.lrcChangeTime) {
          ctx.globalAlpha = Math.min(
            1.0,
            Math.max(0, (performance.now() - this.lrcChangeTime) / 300),
          );
        } else if (isFirstLineGroup) {
          ctx.globalAlpha = lineAlphas[lineIdx];
        } else if (line.isNextLine) {
          ctx.globalAlpha = fadeProgress;
        }
        ctx.beginPath();

        line.syllables.forEach((s) => {
          if (s.isHidden) return;
          let progress = 0;

          if (isLrcMode) {
            progress = 1;
          } else {
            if (currentTime >= s.endTime) progress = 1;
            else if (currentTime >= s.absoluteTime) {
              const duration = s.endTime - s.absoluteTime;
              progress =
                duration > 0 ? (currentTime - s.absoluteTime) / duration : 1;
            }
          }

          if (progress > 0) {
            let clipTop = s.layoutY - mainFontSize * 0.9;
            const clipBottom = s.layoutY + mainFontSize * 0.35;

            if (s.furigana) clipTop -= mainFontSize * 0.6;

            const clipLeft = s.layoutX - 5;
            let clipWidth;

            if (isLrcMode) {
              clipWidth = s.blockWidth + 10;
            } else {
              const indW = s.indicatorWidth || 0;
              const textWipe = (s.blockWidth - indW) * progress;
              clipWidth = indW + textWipe + 10;
            }

            ctx.rect(clipLeft, clipTop, clipWidth, clipBottom - clipTop);
          }
        });
        ctx.clip();
        ctx.drawImage(cache.main, 0, 0, logicalWidth, logicalHeight);
        ctx.restore();
      });
    }
    this.lyricsRafId = requestAnimationFrame(() => this.drawLyricsFrame());
  }

}
