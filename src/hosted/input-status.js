export function inputStatusText(input) {
  if (!input.active) return "Connected · waiting for playback";
  if (input.pitch !== null) {
    const midi = Math.round(input.pitch);
    const note = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"][((midi % 12) + 12) % 12];
    return `Voice detected · ${note}${Math.floor(midi / 12) - 1}`;
  }
  return input.rms >= .003 ? "Audio received · no clear pitch" : "Silent / no audio received";
}

export function mountInputStatus(container, getMixer = () => null) {
  const rows = new Map();
  return inputs => {
    const present = new Set(inputs.map(input => input.id));
    for (const [id, row] of rows) if (!present.has(id)) { row.element.remove(); rows.delete(id); }
    for (const input of inputs) {
      let row = rows.get(input.id);
      if (!row) {
        const element = document.createElement("div"); element.className = "mic-input-row";
        const label = document.createElement("strong");
        const meter = document.createElement("meter"); meter.min = 0; meter.max = 1;
        const volumeLabel = document.createElement("label"); volumeLabel.textContent = "Volume";
        const volume = document.createElement("input"); volume.type = "range";
        volume.min = "0"; volume.max = "2"; volume.step = ".05";
        volume.setAttribute("aria-label", `${input.label} volume`);
        const output = document.createElement("output");
        volumeLabel.append(volume, output);
        const loopbackLabel = document.createElement("label");
        const loopback = document.createElement("input"); loopback.type = "checkbox";
        loopback.setAttribute("aria-label", `${input.label} loopback to display`);
        loopbackLabel.append(loopback, document.createTextNode("Loopback to display"));
        const changed = () => getMixer()?.setMicrophoneSettings(input.id, {
          volume: Number(volume.value), loopback: loopback.checked,
        });
        volume.addEventListener("input", changed); loopback.addEventListener("change", changed);
        element.append(label, meter, volumeLabel, loopbackLabel); container.append(element);
        row = { element, label, meter, volume, output, loopback }; rows.set(input.id, row);
      }
      row.element.style.setProperty("--input-color", input.color);
      row.label.textContent = input.label;
      row.meter.setAttribute("aria-label", `${input.label} audio received at display`);
      row.meter.value = Math.min(1, input.rms * 4);
      const settings = getMixer()?.getMicrophoneSettings(input.id);
      row.volume.disabled = row.loopback.disabled = !settings;
      if (settings) {
        if (document.activeElement !== row.volume) row.volume.value = String(settings.volume);
        row.output.textContent = `${Math.round(Number(row.volume.value) * 100)}%`;
        row.loopback.checked = settings.loopback;
      }

    }
  };
}

export function mountMicrophoneMaster(container, preferences, apply) {
  const label = document.createElement("label"); label.textContent = "Master microphone volume";
  const volume = document.createElement("input"); volume.type = "range";
  volume.min = "0"; volume.max = "2"; volume.step = ".05";
  const output = document.createElement("output");
  const refresh = () => {
    volume.value = String(preferences.micGain);
    output.textContent = `${Math.round(preferences.micGain * 100)}%`;
  };
  refresh();
  volume.addEventListener("input", () => { preferences.micGain = Number(volume.value); refresh(); apply(); });
  label.append(volume, output);
  const hint = document.createElement("p"); hint.className = "muted";
  hint.textContent = "Loopback plays a microphone through the display speakers. Turning it off keeps scoring and recording active. Each microphone volume is multiplied by the master volume.";
  container.append(label, hint);
  return refresh;
}
