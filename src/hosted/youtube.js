export function youtubeId(input) {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const id = host === "youtu.be" ? url.pathname.slice(1) :
      ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host) ?
        url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] : null;
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}

