import { test } from "node:test";
import assert from "node:assert/strict";
import { mountMessage } from "../../src/hosted/message.js";

function fixture(t) {
  const node = () => ({ children: [], handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute() {}, setPointerCapture() {},
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
  });
  const timers = new Map(); let id = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { timers.set(++id, { callback, delay }); return id; });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: node } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete globalThis.document;
  });
  const container = node();
  return { container, timers, tell: mountMessage(container) };
}

test("messages expire after eight seconds and replacements receive a fresh timeout", t => {
  const { container, timers, tell } = fixture(t);
  tell("First"); tell("Second");
  assert.equal(timers.size, 1);
  assert.equal(container.children[0].textContent, "Second");
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 8000);
  timer.callback();
  assert.equal(container.children.length, 0);
  assert.equal(timers.size, 0);
});

test("close buttons and touch swipes dismiss messages, while taps leave them visible", t => {
  const { container, timers, tell } = fixture(t);
  tell("Close me");
  container.children[1].handlers.click();
  assert.equal(container.children.length, 0);
  assert.equal(timers.size, 0);
  tell("Swipe me");
  const down = { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 };
  container.handlers.pointerdown(down);
  container.handlers.pointerup({ ...down, clientX: 25 });
  assert.equal(container.children.length, 2);
  container.handlers.pointerdown(down);
  container.handlers.pointerup({ ...down, clientX: 100 });
  assert.equal(container.children.length, 0);
  assert.equal(timers.size, 0);
});
