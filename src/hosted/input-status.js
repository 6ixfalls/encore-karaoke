export function inputStatusText(input) {
  if (!input.active) return "Connected · waiting for playback";
  if (input.pitch !== null) {
    const midi = Math.round(input.pitch);
    const note = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"][((midi % 12) + 12) % 12];
    return `Voice detected · ${note}${Math.floor(midi / 12) - 1}`;
  }
  return input.rms >= .003 ? "Audio received · no clear pitch" : "Silent / no audio received";
}

export function mountInputStatus(container) {
  const rows = new Map();
  return inputs => {
    const present = new Set(inputs.map(input => input.id));
    for (const [id, row] of rows) if (!present.has(id)) { row.element.remove(); rows.delete(id); }
    container.querySelector(".mic-input-empty").hidden = inputs.length > 0;
    for (const input of inputs) {
      let row = rows.get(input.id);
      if (!row) {
        const element = document.createElement("div"); element.className = "mic-input-row";
        const label = document.createElement("strong"), state = document.createElement("span"), score = document.createElement("span");
        const meter = document.createElement("meter"); meter.min = 0; meter.max = 1;
        element.append(label, meter, state, score); container.append(element);
        row = { element, label, meter, state, score }; rows.set(input.id, row);
      }
      row.element.style.setProperty("--input-color", input.color);
      row.label.textContent = input.label;
      row.meter.setAttribute("aria-label", `${input.label} audio received at display`);
      row.meter.value = Math.min(1, input.rms * 4);
      const state = inputStatusText(input);
      if (row.state.textContent !== state) row.state.textContent = state;
      const value = input.result?.value;
      const score = value == null ? "Collecting score" : `${value} / 100${input.provisional ? " · provisional" : ""}`;
      if (row.score.textContent !== score) row.score.textContent = score;
    }
  };
}
