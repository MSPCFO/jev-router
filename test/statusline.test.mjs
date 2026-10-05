import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeStatus } from "../src/status.mjs";

const STATUSLINE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jev-statusline.mjs");
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function render(sid) {
  const result = spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ session_id: sid, cwd: "/x/proj", context_window: { used_percentage: 5 } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return plain(result.stdout);
}

test("an off status renders ⏸ jev off and the model", () => {
  const sid = `statusline-off-${process.pid}`;
  writeStatus(sid, { off: true, model: "us.anthropic.claude-opus-5-5", tier: "opus", reason: "off" });
  const line = render(sid);
  assert.match(line, /⏸ jev off us\.anthropic\.claude-opus-5-5/);
  assert.doesNotMatch(line, /\(off\)/, "the reason is not printed a second time");
  assert.match(line, /proj/);
});

test("a routed status still renders the model", () => {
  const sid = `statusline-routed-${process.pid}`;
  writeStatus(sid, { model: "claude-sonnet-5", tier: "sonnet", confidence: 0.91, reason: "jev" });
  const line = render(sid);
  assert.match(line, /claude-sonnet-5 \(p=0\.91\)/);
  assert.doesNotMatch(line, /jev off/);
});
