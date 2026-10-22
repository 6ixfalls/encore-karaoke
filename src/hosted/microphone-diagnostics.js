const milliseconds = value => Number.isFinite(value) ? Math.round(value * 1000 * 10) / 10 : null;
const average = (total, count) => Number.isFinite(total) && count > 0 ? milliseconds(total / count) : null;

export function audioLatencyStats(stats) {
  const reports = [...stats.values()];
  const transport = reports.find(report => report.type === "transport" && report.selectedCandidatePairId);
  const pair = transport ? stats.get(transport.selectedCandidatePairId) : reports.find(report =>
    report.type === "candidate-pair" && report.nominated && report.state === "succeeded");
  const candidateTypes = [pair?.localCandidateId, pair?.remoteCandidateId].map(id => stats.get(id)?.candidateType);
  const relayed = candidateTypes.includes("relay") ? true : candidateTypes.every(Boolean) ? false : null;
  return reports.filter(report => report.type === "inbound-rtp" &&
    (report.kind || report.mediaType) === "audio" && !report.isRemote).map(report => ({
    codec: stats.get(report.codecId)?.mimeType || "Unavailable",
    jitterMs: milliseconds(report.jitter),
    averageBufferMs: average(report.jitterBufferDelay, report.jitterBufferEmittedCount),
    averageTargetBufferMs: average(report.jitterBufferTargetDelay, report.jitterBufferEmittedCount),
    packetsReceived: report.packetsReceived ?? null,
    packetsLost: report.packetsLost ?? null,
    concealedSamples: report.concealedSamples ?? null,
    roundTripMs: milliseconds(pair?.currentRoundTripTime),
    relayed,
  }));
}

export function mountLatencyDiagnostics(container, microphone) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = "Refresh microphone diagnostics";
  const output = document.createElement("pre");
  output.setAttribute("aria-live", "polite");
  output.style.whiteSpace = "pre-wrap";
  output.textContent = "Connect a phone microphone, then measure. Statistics do not measure total acoustic delay.";
  const display = (value, unit = "") => value === null || value === undefined ? "Unavailable" : `${value}${unit}`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const context = microphone.player?.context;
    const lines = [
      `Audio context: ${context?.state || "Unavailable"}`,
      `Sample rate: ${display(context?.sampleRate, " Hz")}`,
      `Web Audio base latency: ${display(milliseconds(context?.baseLatency), " ms")}`,
      `Output latency: ${display(milliseconds(context?.outputLatency), " ms")}`,
      `Requested buffer: ${microphone.bufferTarget === null ? "Browser default" : `${microphone.bufferTarget} ms`}`,
    ];
    try {
      const entries = [...microphone.peers];
      if (!entries.length) lines.push("No phone microphones connected.");
      const results = await Promise.all(entries.map(async ([id, entry], index) => {
        const label = microphone.getRoom?.()?.participants?.find(participant => participant.id === id)?.nickname || `Phone ${index + 1}`;
        try {
          const reports = audioLatencyStats(await entry.pc.getStats());
          if (microphone.peers.get(id) !== entry) return `${label}: Disconnected`;
          if (!reports.length) return `${label}: Waiting for audio statistics`;
          return reports.map(report => [
            `${label}: ${entry.pc.connectionState} · ${report.codec}`,
            `Network RTT: ${display(report.roundTripMs, " ms")} · ${report.relayed === null ? "Route unavailable" : report.relayed ? "Relay" : "Direct peer route"}`,
            `Jitter: ${display(report.jitterMs, " ms")}`,
            `Average jitter buffer: ${display(report.averageBufferMs, " ms")} (target ${display(report.averageTargetBufferMs, " ms")})`,
            `Packets received / lost: ${display(report.packetsReceived)} / ${display(report.packetsLost)}`,
            `Concealed samples: ${display(report.concealedSamples)}`,
          ].join("\n")).join("\n");
        } catch { return `${label}: Audio statistics unavailable`; }
      }));
      lines.push(...results, "Buffer averages and counters cover this connection so far. RTT is round-trip, not one-way audio delay.",
        "For end-to-end latency, record a sharp tap near the phone and its speaker reproduction. Compare wired speakers with TV/Bluetooth output.");
      output.textContent = lines.join("\n\n");
    } finally { button.disabled = false; }
  });
  container.append(button, output);
}
