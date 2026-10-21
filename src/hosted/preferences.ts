export interface Preferences {
  startupIntro: boolean;
  songIntro: boolean;
  celebrations: boolean;
  fanfare: boolean;
  narration: boolean;
  countdowns: boolean;
  interludes: boolean;
  lyricFont: string;
  lyricSize: number;
  lyricGap: number;
  lyricMargin: number;
  lyricOffset: number;
  lyricCase: string;
  lyricAlignment: string;
  lyricColor: string;
  romanization: boolean;
  micGain: number;
  monitoring: boolean;
  eq: number[];
  parametricFrequency: number;
  parametricGain: number;
  parametricQ: number;
  compressor: boolean;
  compressorThreshold: number;
  echo: number;
  echoTime: number;
  noiseGate: number;
}
export const defaults: Preferences = {
  startupIntro: true, songIntro: true, celebrations: true, fanfare: true,
  narration: true, countdowns: true, interludes: true,
  lyricFont: "Radio Canada", lyricSize: 1, lyricGap: 1, lyricMargin: 0,
  lyricOffset: 0, lyricCase: "original", lyricAlignment: "center",
  lyricColor: "white", romanization: true,
  micGain: 1, monitoring: false, eq: [0, 0, 0, 0, 0, 0, 0],
  parametricFrequency: 1000, parametricGain: 0, parametricQ: 1,
  compressor: true, compressorThreshold: -24, echo: 0, echoTime: .25, noiseGate: -50,
};
const ranges: Partial<Record<keyof Preferences, [number, number]>> = {
  lyricSize: [.5, 2], lyricGap: [.5, 2], lyricMargin: [0, 150], lyricOffset: [-5000, 5000],
  micGain: [0, 2], parametricFrequency: [40, 16000],
  parametricGain: [-12, 12], parametricQ: [.1, 10], compressorThreshold: [-60, 0],
  echo: [0, .7], echoTime: [.05, .8], noiseGate: [-100, -10],
};
const choices: Partial<Record<keyof Preferences, string[]>> = {
  lyricFont: ["Radio Canada", "Rajdhani", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC"],
  lyricCase: ["original", "uppercase", "lowercase", "sentence"],
  lyricAlignment: ["center", "left", "right", "alternating", "split"],
  lyricColor: ["white", "red", "orange", "yellow", "green", "blue", "purple"],
};
export function validatePreferences(value: unknown): Preferences {
  const result = structuredClone(defaults);
  if (!value || typeof value !== "object") return result;
  for (const key of Object.keys(defaults) as (keyof Preferences)[]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (key === "eq") {
      if (Array.isArray(candidate) && candidate.length === 7 && candidate.every(n =>
        typeof n === "number" && Number.isFinite(n) && n >= -12 && n <= 12)) result.eq = [...candidate];
    } else if (ranges[key]) {
      const [min, max] = ranges[key]!;
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= min && candidate <= max)
        Object.assign(result, { [key]: candidate });
    } else if (choices[key]) {
      if (typeof candidate === "string" && choices[key]!.includes(candidate)) Object.assign(result, { [key]: candidate });
    } else if (typeof candidate === "boolean") Object.assign(result, { [key]: candidate });
  }
  return result;
}
export function loadPreferences(): Preferences {
  try { return validatePreferences(JSON.parse(localStorage.getItem("encore.preferences.v1") || "null")); }
  catch { return structuredClone(defaults); }
}
export function savePreferences(value: Preferences): void {
  try { localStorage.setItem("encore.preferences.v1", JSON.stringify(value)); } catch { /* Private mode still works. */ }
}
