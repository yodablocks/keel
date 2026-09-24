import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/index.ts";

test("package loads", () => {
  assert.equal(VERSION, "0.0.0");
});
