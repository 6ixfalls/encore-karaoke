// Explicit browser services: no preload globals, filesystem paths, or loopback URLs.
export class BrowserServices {
  constructor() {
    this.token = sessionStorage.getItem("encore-participant");
  }
  async request(path, { method = "GET", body, keepalive = false } = {}) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      keepalive,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "X-Participant-Token": this.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(
        value.error ||
          "request_failed",
      );
      error.retryAfterMs = value.retryAfterMs;
      error.status = response.status;
      throw error;
    }
    if (value.token) {
      this.token = value.token;
      sessionStorage.setItem("encore-participant", value.token);
    }
    return value;
  }
  clear() {
    this.token = null;
    sessionStorage.removeItem("encore-participant");
  }
  command(roomId, type, payload = {}, expectedRevision) {
    return this.request(`/api/rooms/${roomId}/commands`, {
      method: "POST",
      body: { commandId: crypto.randomUUID(), type, payload, expectedRevision },
    });
  }
}
