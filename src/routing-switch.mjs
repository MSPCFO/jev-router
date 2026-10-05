import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Base directory for daemon state; `JEV_HOME` overrides it (tests, unusual setups). */
export const jevHome = () => process.env.JEV_HOME || join(homedir(), ".jev-router");

/**
 * The routing switch is one small file per user so every running session, and every daemon,
 * sees a change on its next turn. Resolved at call time so tests and launchers can repoint it.
 */
export const switchFile = () => process.env.JEV_STATE_FILE || join(jevHome(), "routing.json");

/** True unless the user explicitly turned routing off. A missing or unreadable file means on. */
export function routingEnabled() {
  try {
    return JSON.parse(readFileSync(switchFile(), "utf8"))?.routing !== "off";
  } catch {
    return true;
  }
}

/** Persists the switch, private to the owner. */
export function setRouting(on) {
  const file = switchFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ routing: on ? "on" : "off" }), { mode: 0o600 });
  // `mode` only applies on creation.
  chmodSync(file, 0o600);
}
