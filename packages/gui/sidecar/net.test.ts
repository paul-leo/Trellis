import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackAddress } from "./net.js";

test("isLoopbackAddress: recognizes IPv4 and IPv6 loopback forms", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
});

test("isLoopbackAddress: rejects non-loopback addresses and undefined", () => {
  assert.equal(isLoopbackAddress("192.168.1.5"), false);
  assert.equal(isLoopbackAddress("0.0.0.0"), false);
  assert.equal(isLoopbackAddress("::"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});
