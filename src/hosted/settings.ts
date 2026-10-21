import { defaults, savePreferences, type Preferences } from "./preferences.js";
import { EQ_BANDS } from "./audio-mixer.js";
export function mountSettings(container: HTMLElement, preferences: Preferences,
  apply: (preferences: Preferences) => Promise<void> | void, error: (error: Error) => void): void {
  const form = document.createElement("div"); form.className = "encore-settings";
  container.append(form);
  const changed = () => {
    savePreferences(preferences);
    Promise.resolve(apply(preferences)).catch(error);
  };
  const group = (title: string) => {
    const details = document.createElement("details"); details.open = title === "Lyrics";
    const summary = document.createElement("summary"); summary.textContent = title;
    const fields = document.createElement("div"); fields.className = "settings-grid";
    details.append(summary, fields); form.append(details); return fields;
  };
  const field = (parent: HTMLElement, key: keyof Preferences, title: string,
    options?: { min: number; max: number; step: number } | string[][]) => {
    const label = document.createElement("label"); label.textContent = title;
    const value = preferences[key];
    if (Array.isArray(options)) {
      const select = document.createElement("select"); select.id = `setting-${key}`;
      for (const [value, title] of options) {
        const option = document.createElement("option"); option.value = value; option.textContent = title; select.append(option);
      }
      select.value = String(value);
      select.addEventListener("change", () => { Object.assign(preferences, { [key]: select.value }); changed(); });
      label.append(select);
    } else {
      const input = document.createElement("input"); input.id = `setting-${key}`;
      input.type = typeof value === "boolean" ? "checkbox" : "range";
      if (typeof value === "boolean") input.checked = value;
      else input.value = String(value);
      const output = document.createElement("output"); output.textContent = String(value);
      if (options) { input.min = String(options.min); input.max = String(options.max); input.step = String(options.step); input.value = String(value); }
      input.addEventListener("input", () => {
        const next = input.type === "checkbox" ? input.checked : Number(input.value);
        Object.assign(preferences, { [key]: next }); output.textContent = String(next); changed();
      });
      label.append(input); if (typeof value !== "boolean") label.append(output);
    }
    parent.append(label);
  };
  const lyrics = group("Lyrics");
  field(lyrics, "lyricFont", "Font", ["Radio Canada", "Rajdhani", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC"].map(v => [v, v]));
  field(lyrics, "lyricSize", "Text size", { min: .5, max: 2, step: .05 });
  field(lyrics, "lyricGap", "Line spacing", { min: .5, max: 2, step: .05 });
  field(lyrics, "lyricMargin", "Bottom margin (px)", { min: 0, max: 150, step: 5 });
  field(lyrics, "lyricOffset", "Lyric timing offset (ms)", { min: -5000, max: 5000, step: 50 });
  field(lyrics, "lyricCase", "Text case", [["original", "Original"], ["uppercase", "UPPERCASE"], ["lowercase", "lowercase"], ["sentence", "Sentence case"]]);
  field(lyrics, "lyricAlignment", "Alignment", ["center", "left", "right", "alternating", "split"].map(v => [v, v]));
  field(lyrics, "lyricColor", "Lyric color", ["white", "blue", "yellow", "red", "green", "orange", "purple"].map(v => [v, v]));
  field(lyrics, "romanization", "Japanese / Korean romanization");
  const sound = group("Audio mixer");
  const hint = document.createElement("p"); hint.className = "muted";
  hint.textContent = "Tempo and key are on your phone’s Remote tab. Microphone effects apply to local and phone vocals. Enable monitoring to hear local vocals; use headphones to prevent feedback.";
  sound.append(hint);
  field(sound, "micGain", "Vocal gain", { min: 0, max: 2, step: .05 });
  field(sound, "monitoring", "Monitor local microphone");
  for (const [index, frequency] of EQ_BANDS.entries()) {
    const label = document.createElement("label"); label.textContent = `${frequency >= 1000 ? frequency / 1000 + 'k' : frequency} Hz EQ (dB)`;
    const slider = document.createElement("input"); slider.type = "range"; slider.min = "-12"; slider.max = "12"; slider.step = ".5"; slider.value = String(preferences.eq[index]); slider.id = `eq-${frequency}`;
    const output = document.createElement("output"); output.textContent = slider.value;
    slider.addEventListener("input", () => { preferences.eq[index] = Number(slider.value); output.textContent = slider.value; changed(); });
    label.append(slider, output); sound.append(label);
  }
  field(sound, "parametricFrequency", "Parametric EQ frequency (Hz)", { min: 40, max: 16000, step: 10 });
  field(sound, "parametricGain", "Parametric EQ gain (dB)", { min: -12, max: 12, step: .5 });
  field(sound, "parametricQ", "Parametric EQ Q", { min: .1, max: 10, step: .1 });
  field(sound, "compressor", "Compressor");
  field(sound, "compressorThreshold", "Compressor threshold (dB)", { min: -60, max: 0, step: 1 });
  field(sound, "echo", "Echo mix", { min: 0, max: .7, step: .05 });
  field(sound, "echoTime", "Echo delay (seconds)", { min: .05, max: .8, step: .05 });
  field(sound, "noiseGate", "Noise gate threshold (dB)", { min: -100, max: -10, step: 1 });
  const stage = group("Presentation");
  for (const [key, title] of [["startupIntro", "Startup intro"], ["songIntro", "Song intro cards"],
    ["celebrations", "Post-song celebration"], ["fanfare", "Score fanfare"], ["narration", "Score narration"],
    ["countdowns", "Vocal-entry countdowns"], ["interludes", "Interlude tips"]] as [keyof Preferences, string][]) field(stage, key, title);
  const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "Reset presentation, lyrics & mixer";
  reset.addEventListener("click", () => {
    Object.assign(preferences, structuredClone(defaults)); form.remove();
    mountSettings(container, preferences, apply, error); changed();
  }); form.append(reset);
}
