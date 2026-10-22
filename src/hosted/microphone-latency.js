// These are best-effort requests: browsers and audio hardware retain control
// over capture, Opus packetization and the minimum stable playout buffer.
export function preferOpus(transceiver) {
  try {
    const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.("audio")?.codecs;
    if (!transceiver.setCodecPreferences || !codecs?.some(codec => codec.mimeType.toLowerCase() === "audio/opus")) return;
    transceiver.setCodecPreferences([
      ...codecs.filter(codec => codec.mimeType.toLowerCase() === "audio/opus"),
      ...codecs.filter(codec => codec.mimeType.toLowerCase() !== "audio/opus"),
    ]);
  } catch { /* Older implementations keep their codec defaults. */ }
}

export function tuneMicrophoneReceiver(receiver, target = 0) {
  if (!receiver) return;
  try {
    if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = target; // milliseconds
    else if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = target === null ? null : target / 1000; // seconds (legacy Chromium)
  } catch { /* Unsupported hints must never prevent microphone playback. */ }
}

export function lowLatencyDescription(description) {
  if (!description.sdp) return description;
  // ptime is a receive preference, so the TV answer requests short packets
  // from the phone. Preserve other media sections and negotiated payload IDs.
  const sections = description.sdp.split(/(?=^m=)/m);
  const sdp = sections.map(section => {
    if (!section.startsWith("m=audio ") || !/^a=rtpmap:\d+ opus\/48000/im.test(section)) return section;
    const newline = section.includes("\r\n") ? "\r\n" : "\n";
    const lines = section.trimEnd().split(/\r?\n/).filter(line => !/^a=(?:ptime|maxptime):/.test(line));
    lines.push("a=ptime:10", "a=maxptime:10");
    return lines.join(newline) + newline;
  }).join("");
  return { type: description.type, sdp };
}
