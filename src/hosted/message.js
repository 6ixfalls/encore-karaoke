export function mountMessage(container) {
  let timer, gesture;
  const dismiss = () => {
    clearTimeout(timer);
    gesture = null;
    container.replaceChildren();
  };
  container.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" || event.target?.closest?.("button")) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    container.setPointerCapture(event.pointerId);
  });
  container.addEventListener("pointerup", event => {
    if (gesture?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 50) dismiss();
    gesture = null;
  });
  container.addEventListener("pointercancel", () => { gesture = null; });
  return value => {
    dismiss();
    if (!value) return;
    const text = document.createElement("span"); text.textContent = value;
    const close = document.createElement("button"); close.type = "button";
    close.className = "message-dismiss"; close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss message");
    close.addEventListener("click", dismiss);
    container.append(text, close);
    timer = setTimeout(dismiss, 8000);
  };
}
