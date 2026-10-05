#!/usr/bin/env node
// Turns Jev routing on or off for this user. A running daemon (and any jev-claude proxy)
// reads the switch on every fresh turn, so the change applies from the next prompt.
//
//   jev-routing on | off | status
import { routingEnabled, setRouting } from "../src/routing-switch.mjs";

const command = process.argv[2] ?? "status";

if (command === "on" || command === "off") {
  setRouting(command === "on");
} else if (command !== "status") {
  process.stderr.write("usage: jev-routing [on|off|status]\n");
  process.exit(1);
}

process.stdout.write(`routing: ${routingEnabled() ? "on" : "off"}\n`);
