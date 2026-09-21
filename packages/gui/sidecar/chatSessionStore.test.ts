import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatSessionStore } from "./chatSessionStore.js";

test("chatSessionStore: start() issues a fresh id every time", () => {
  const store = createChatSessionStore();
  const a = store.start("qoder");
  const b = store.start("qoder");
  assert.notEqual(a.chatId, b.chatId);
  assert.equal(a.targetId, "qoder");
});

test("chatSessionStore: get() on an unknown id returns undefined, not a throw", () => {
  const store = createChatSessionStore();
  assert.equal(store.get("not-a-real-chat-id"), undefined);
});

test("chatSessionStore: get() after start() returns the same session, with persona carried through", () => {
  const store = createChatSessionStore();
  const started = store.start("qoder", "a terse reviewer");
  const fetched = store.get(started.chatId);
  assert.equal(fetched?.targetId, "qoder");
  assert.equal(fetched?.persona, "a terse reviewer");
  assert.equal(fetched?.activeTurn, undefined);
});
