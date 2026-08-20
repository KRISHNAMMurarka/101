#!/usr/bin/env node
/**
 * Refuse to start when something already holds the dev port.
 *
 * This exists because of a real failure that cost hours. A different project on this machine was
 * running its own dev server bound to `[::1]:3000`; this project's server binds `*:3000` on IPv4.
 * Both bind successfully — there is no EADDRINUSE, because they are different sockets — and macOS
 * resolves `localhost` to `::1` first. So every `http://localhost:3000` request was answered by the
 * *other application*, while this one sat there serving nobody.
 *
 * The symptom was maddening rather than obvious: deleted code appeared to still run, a rebuild
 * appeared to change nothing, and a chunk hash looked stale. Nothing was stale. We were reading a
 * different program.
 *
 * A port that is already listening is therefore treated as fatal, whoever owns it, on whichever
 * address family. Losing a second to an explicit error beats losing an afternoon to a silent one.
 */
import { execFileSync } from "node:child_process";

const port = Number(process.argv[2] ?? process.env.PORT ?? 3000);

function listeners() {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split("\n").slice(1).filter(Boolean).map((line) => {
      const [command, pid, , , , , , , name] = line.split(/\s+/);
      return { command, pid, name };
    });
  } catch (error) {
    // lsof exits non-zero when nothing matches, which is the common and healthy case. A missing
    // lsof (non-macOS) also lands here; a check that cannot run must not block the build.
    if (error && typeof error === "object" && "status" in error && error.status === 1) return [];
    return [];
  }
}

const held = listeners();
if (held.length === 0) process.exit(0);

const owners = held.map((l) => `  pid ${l.pid}  ${l.command}  ${l.name}`).join("\n");
let detail = "";
for (const { pid } of held) {
  try {
    const argv = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).trim();
    if (argv) detail += `\n  pid ${pid}: ${argv}`;
  } catch { /* the process may have exited between the two calls */ }
}

process.stderr.write(
  `\nPort ${port} is already being listened on:\n${owners}\n`
  + (detail ? `\nFull command lines:${detail}\n` : "")
  + `\nRefusing to start. Two servers can bind the same port on different address families — one on\n`
  + `IPv4, one on IPv6 — without either reporting a conflict, and "localhost" then reaches whichever\n`
  + `the resolver prefers. That makes it look like your changes are not taking effect.\n\n`
  + `Stop the process above, or start this one on another port:\n`
  + `  PORT=3001 npm start\n\n`,
);
process.exit(1);
