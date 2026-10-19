// Explicit browser services: no preload globals, filesystem paths, or loopback URLs.
export class BrowserServices {
  constructor() {
    this.csrf = null;
  }
  async request(path, { method = "GET", body, keepalive = false } = {}) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      keepalive,
      headers: {
        "Content-Type": "application/json",
        ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(
        value.error ||
          (value.pending ? "display_release_pending" : "request_failed"),
      );
      error.retryAfterMs = value.retryAfterMs;
      error.status = response.status;
      throw error;
    }
    if (value.csrf) this.csrf = value.csrf;
    return value;
  }
  media(assetId, roomId) {
    if (!/^[a-f0-9]{64}$/.test(assetId)) throw new Error("invalid_asset_id");
    return `/media/${assetId}?roomId=${encodeURIComponent(roomId)}`;
  }
  command(roomId, type, payload = {}, expectedRevision) {
    return this.request(`/api/rooms/${roomId}/commands`, {
      method: "POST",
      body: { commandId: crypto.randomUUID(), type, payload, expectedRevision },
    });
  }
}
