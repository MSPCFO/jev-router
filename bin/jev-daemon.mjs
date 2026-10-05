#!/usr/bin/env node
// Long-lived shared proxy for plain `claude` sessions (see "Daemon mode" in the README).
//
//   jev-daemon serve  --project <dir>   run the proxy in the foreground
//   jev-daemon ensure --project <dir>   start it if needed, restart it if it runs old code
//   jev-daemon stop                     stop it
//   jev-daemon status                   print its state as JSON; exit 3 when it is not running
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { bedrockConfig, bedrockSettingsFiles } from "../src/bedrock.mjs";
import { jevHome } from "../src/routing-switch.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(THIS_FILE));
const DEFAULT_PORT = 47823;

const port = () => Number(process.env.JEV_PORT) || DEFAULT_PORT;
const stateFile = () => join(jevHome(), "daemon.json");
const logFile = () => join(jevHome(), "daemon.log");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const projectDir = () => resolve(arg("--project") ?? process.cwd());

function ensureHome() {
  mkdirSync(jevHome(), { recursive: true, mode: 0o700 });
  chmodSync(jevHome(), 0o700);
}

/** Git HEAD of this install, or null when it is not a git checkout. */
function installSha() {
  const result = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/** What the daemon on our port says about itself, or null if nothing (jev) answers. */
function health(timeout = 300) {
  return new Promise((done) => {
    const req = http.get(
      { host: "127.0.0.1", port: port(), path: "/jev/health", timeout },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            done(res.statusCode === 200 && body?.jev === true ? body : null);
          } catch {
            done(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
  });
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

function removeState() {
  try {
    unlinkSync(stateFile());
  } catch {
    // Already gone.
  }
}

async function serve() {
  const project = projectDir();
  // Same precedence as jev-claude: the real environment wins, then the project's .env, then
  // the shared user-level files.
  for (const file of [
    join(project, ".env"),
    join(homedir(), ".jev-router.env"),
    join(homedir(), ".jev-claude.env"),
  ]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing or unreadable; the key may still come from the real environment.
    }
  }
  const bedrock = bedrockConfig(process.env, bedrockSettingsFiles(process.env, project, homedir()));
  const sha = process.env.JEV_DAEMON_SHA || installSha();
  let proxy;
  try {
    proxy = await startProxy({ ...(bedrock ? { bedrock } : {}), port: port(), host: "127.0.0.1", sha });
  } catch (err) {
    process.stderr.write(`[jev-daemon] could not listen on 127.0.0.1:${port()}: ${err.message}\n`);
    process.exit(1);
  }
  ensureHome();
  writeFileSync(
    stateFile(),
    JSON.stringify({ pid: process.pid, port: proxy.port, sha, project, startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  chmodSync(stateFile(), 0o600);
  process.stderr.write(`[jev-daemon] ${new Date().toISOString()} listening on 127.0.0.1:${proxy.port} (sha ${sha})\n`);
  const shutdown = () => {
    if (readState()?.pid === process.pid) removeState();
    proxy.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function stop() {
  const state = readState();
  const alive = await health();
  // Only signal a pid that the health endpoint vouches for, so a stale daemon.json can never
  // make us kill an unrelated process that reused the pid.
  if (alive?.pid) {
    try {
      process.kill(alive.pid, "SIGTERM");
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
    await waitFor(async () => !(await health()), 2000);
  }
  if (!state || state.pid === alive?.pid || !alive) removeState();
  return 0;
}

async function ensure() {
  const project = projectDir();
  const current = await health();
  if (current) {
    if (current.sha === installSha()) return 0;
    await stop();
  }
  ensureHome();
  const log = openSync(logFile(), "a", 0o600);
  try {
    const child = spawn(process.execPath, [THIS_FILE, "serve", "--project", project], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  if (await waitFor(async () => Boolean(await health()), 5000)) return 0;
  process.stderr.write(`[jev-daemon] the router did not start; see ${logFile()}\n`);
  return 1;
}

async function status() {
  const alive = await health();
  process.stdout.write(`${JSON.stringify({ ...readState(), running: Boolean(alive) })}\n`);
  return alive ? 0 : 3;
}

const commands = { serve, ensure, stop, status };
const command = commands[process.argv[2]];
if (!command) {
  process.stderr.write("usage: jev-daemon <serve|ensure|stop|status> [--project <dir>]\n");
  process.exit(1);
}
const code = await command();
// `serve` keeps running on its listening socket; every other command is done.
if (process.argv[2] !== "serve") process.exit(code);
