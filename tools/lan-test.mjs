#!/usr/bin/env node
/**
 * Play 101 on this machine with your own phone as the controller.
 *
 * Everything needed for a real two-device test already exists — the server binds every interface,
 * the Hub advertises itself on the LAN, and the browser controller needs no app install — but a
 * person still had to find their own IP, start two processes in the right order, and get a URL onto
 * a phone by hand. This does those four things and prints a QR code.
 *
 * Nothing here is a deployment. Both processes are local, the phone talks to this machine over your
 * own network, and no traffic leaves it.
 */
import { execFile, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

import QRCode from "qrcode";

const run = promisify(execFile);
const PORT = Number(process.env.PORT ?? 3000);
const children = [];

/**
 * The address a phone on the same Wi-Fi can actually reach.
 *
 * `localhost` is the one address that cannot work here: it means "this device", so a phone typing it
 * reaches itself. Link-local (169.254.x) addresses mean DHCP failed and nothing will route either.
 */
function lanAddress() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      // Prefer physical interfaces; en0 is Wi-Fi on a Mac, and a VPN or Docker bridge is rarely the
      // one the phone shares.
      const rank = name.startsWith("en") ? 0 : name.startsWith("wl") ? 1 : 2;
      candidates.push({ rank, name, address: address.address });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0];
}

async function built() {
  try {
    await run("node", ["-e", "require('node:fs').statSync('dist/client')"]);
    return true;
  } catch {
    return false;
  }
}

function start(label, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  children.push(child);
  const prefix = `  ${label.padEnd(6)} │ `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.trimEnd().split("\n")) {
        if (line.trim()) process.stdout.write(prefix + line + "\n");
      }
    });
  }
  return child;
}

function stopAll() {
  for (const child of children) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopAll(); process.exit(0); });

const lan = lanAddress();
if (!lan) {
  console.error("\nNo network interface a phone could reach.");
  console.error("Join this machine to the same Wi-Fi as the phone and run this again.\n");
  process.exit(1);
}

if (!await built()) {
  console.error("\nNo production build found. Run this first:\n\n  npm run build\n");
  process.exit(1);
}

const url = `http://${lan.address}:${PORT}`;
const qr = await QRCode.toString(url, { type: "terminal", small: true });

console.log(`
  101 — play on this machine, control it with your phone

${qr}
  Open on the phone:  ${url}
  (interface ${lan.name}; this machine also has it at http://localhost:${PORT})

  1. Both devices on the same Wi-Fi. Phone hotspots and "guest" networks usually
     block device-to-device traffic, which is the one thing this needs.
  2. On this machine open ${url}, pick a game, and press Connect device.
  3. The panel shows a SESSION code, six characters like 101R6A.
  4. On the phone, open:   ${url}/controller?session=THATCODE
     Scanning the on-screen QR does the same thing; typing the address is the
     path that works even when a camera or a scanner app gets in the way.
  5. The phone is now the controller. No app install — it runs in the browser.

  The native 101 Link app takes the same code: "Scan code", or "Enter code
  instead" on its first screen.

  Ctrl-C stops both processes.
`);

start("hub", "node", ["--experimental-strip-types", "tools/hub-server.mjs"]);
start("web", "npx", ["vinext", "start"], { PORT: String(PORT), WRANGLER_LOG_PATH: ".wrangler/wrangler.log" });
