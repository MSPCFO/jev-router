import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routingEnabled, setRouting, switchFile } from "../src/routing-switch.mjs";

function withSwitchFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-switch-"));
  const file = join(dir, "routing.json");
  const previous = process.env.JEV_STATE_FILE;
  process.env.JEV_STATE_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_STATE_FILE;
    else process.env.JEV_STATE_FILE = previous;
  });
  return file;
}

test("routing is on when no switch file exists", (t) => {
  withSwitchFile(t);
  assert.equal(routingEnabled(), true);
});

test("setRouting(false) persists off and the file is mode 600", (t) => {
  const file = withSwitchFile(t);
  setRouting(false);
  assert.equal(routingEnabled(), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { routing: "off" });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("setRouting(true) turns it back on", (t) => {
  withSwitchFile(t);
  setRouting(false);
  setRouting(true);
  assert.equal(routingEnabled(), true);
});

test("a malformed switch file reads as on", (t) => {
  const file = withSwitchFile(t);
  writeFileSync(file, "{not json");
  assert.equal(routingEnabled(), true);
});

test("the switch file defaults to routing.json under JEV_HOME", (t) => {
  const previousState = process.env.JEV_STATE_FILE;
  const previousHome = process.env.JEV_HOME;
  delete process.env.JEV_STATE_FILE;
  process.env.JEV_HOME = "/tmp/some-jev-home";
  t.after(() => {
    if (previousState !== undefined) process.env.JEV_STATE_FILE = previousState;
    if (previousHome === undefined) delete process.env.JEV_HOME;
    else process.env.JEV_HOME = previousHome;
  });
  assert.equal(switchFile(), join("/tmp/some-jev-home", "routing.json"));
});
