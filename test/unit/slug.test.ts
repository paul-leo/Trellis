import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../../src/lib/slug.js";

test("slugify: spaces and mixed case become a kebab-case slug", () => {
  assert.equal(slugify("Sprint Tasks Q2"), "sprint-tasks-q2");
});

test("slugify: punctuation collapses into single hyphens, no leading/trailing hyphen", () => {
  assert.equal(slugify("  Web Series (memo!)  "), "web-series-memo");
});

test("slugify: two different inputs can produce the same slug — this function does not detect that", () => {
  assert.equal(slugify("a b"), slugify("a-b"));
});
