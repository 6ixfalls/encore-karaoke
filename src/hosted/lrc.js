// This timing parser is shared with the desktop LyricsEngine. Text stays text in every view.
export function parseLrc(text) {
  if (!text) return [];
  const result = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(text)?.[1] || 0) / 1000;
  for (const line of text.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const content = line
      .replace(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g, "")
      .trim();
    if (!content) continue;
    for (const stamp of timestamps)
      result.push({
        time: Math.max(
          0,
          Number(stamp[1]) * 60 +
            Number(stamp[2]) +
            Number((stamp[3] || "0").padEnd(3, "0")) / 1000 +
            offset,
        ),
        text: content,
      });
  }
  return result.sort((a, b) => a.time - b.time);
}
