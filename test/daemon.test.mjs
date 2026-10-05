import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jev-daemon.mjs");

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** A throwaway HOME, JEV_HOME and project, so nothing here touches the real ones. */
async function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "jev-daemon-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" } }),
  );
  const home = join(root, "home");
  mkdirSync(home);
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.JEV_DAEMON_SHA;
  Object.assign(env, {
    JEV_HOME: join(root, "jev-home"),
    JEV_PORT: String(port),
    JEV_STATE_FILE: join(root, "routing.json"),
  });
  const run = (cmd, extraEnv = {}) =>
    spawnSync(process.execPath, [DAEMON, cmd, "--project", project], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 15000,
    });
  t.after(() => run("stop"));
  const health = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/jev/health`, {
        signal: AbortSignal.timeout(500),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  return { run, health, port, jevHome: env.JEV_HOME };
}

test("ensure starts the daemon and health answers", async (t) => {
  const { run, health } = await sandbox(t);
  const result = run("ensure");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const body = await health();
  assert.equal(body?.jev, true);
  assert.ok(Number.isInteger(body.pid));
});

test("ensure is idempotent: a second ensure keeps the same pid", async (t) => {
  const { run, health } = await sandbox(t);
  assert.equal(run("ensure").status, 0);
  const first = (await health()).pid;
  assert.equal(run("ensure").status, 0);
  assert.equal((await health()).pid, first);
});

test("status prints pid, port and sha as JSON; exit 0 when running, 3 when not", async (t) => {
  const { run, port } = await sandbox(t);
  assert.equal(run("status").status, 3);
  assert.equal(run("ensure").status, 0);
  const running = run("status");
  assert.equal(running.status, 0);
  const info = JSON.parse(running.stdout);
  assert.equal(info.running, true);
  assert.equal(info.port, port);
  assert.ok(Number.isInteger(info.pid));
  assert.ok("sha" in info);
});

test("the daemon state file is private to its owner", { skip: process.platform === "win32" }, async (t) => {
  const { run, jevHome } = await sandbox(t);
  assert.equal(run("ensure").status, 0);
  assert.equal(statSync(join(jevHome, "daemon.json")).mode & 0o777, 0o600);
  assert.equal(statSync(jevHome).mode & 0o777, 0o700);
});

test("stop kills the daemon and removes daemon.json", async (t) => {
  const { run, health, jevHome } = await sandbox(t);
  assert.equal(run("ensure").status, 0);
  const stateFile = join(jevHome, "daemon.json");
  assert.ok(existsSync(stateFile));
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).pid, (await health()).pid);
  assert.equal(run("stop").status, 0);
  assert.equal(await health(), null);
  assert.equal(existsSync(stateFile), false);
});

test("ensure restarts a daemon whose sha differs from the install's", async (t) => {
  const { run, health } = await sandbox(t);
  assert.equal(run("ensure", { JEV_DAEMON_SHA: "old" }).status, 0);
  const stale = await health();
  assert.equal(stale.sha, "old");
  assert.equal(run("ensure").status, 0);
  const fresh = await health();
  assert.notEqual(fresh.pid, stale.pid);
  assert.notEqual(fresh.sha, "old");
});
