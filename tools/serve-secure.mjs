#!/usr/bin/env node
/**
 * A TLS front for the local production server, so a phone can use its camera.
 *
 * Why this exists: `getUserMedia` needs a secure context. A phone reaching the laptop at
 * `http://192.168.0.x:3000` is not one, so the camera never starts — the page looks broken in a way
 * that has nothing to do with the product. `localhost` is exempt from that rule, which is why the
 * laptop's own camera works and the phone's does not.
 *
 * Two ways out, and the cheaper one is not this file:
 *
 *   Android, over USB:  adb reverse tcp:3000 tcp:3000
 *   The phone then reaches the laptop at http://localhost:3000, which is a secure context by
 *   definition. No certificates, nothing to trust, nothing to clean up afterwards. Use this when the
 *   phone is an Android and a cable is to hand.
 *
 *   Anything else, including every iPhone:  this file.
 *   It terminates TLS on the LAN and proxies to the plain server, using a certificate generated on
 *   this machine and never leaving it. The phone has to be told to trust that certificate once.
 *
 * This is not deploying. Nothing is published, nothing is hosted, and the certificate is
 * self-signed, git-ignored and valid only for addresses on this network.
 */

import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const certDir = resolve(root, ".certs");
const keyPath = resolve(certDir, "lan.key");
const crtPath = resolve(certDir, "lan.crt");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 3443);
const targetPort = Number(args.get("--target-port") ?? 3000);
const targetHost = args.get("--target-host") ?? "127.0.0.1";

/** Every IPv4 address this machine answers on, so the certificate covers whichever the phone uses. */
function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

/*
 * A browser stopped accepting the Common Name years ago, so the addresses have to be Subject
 * Alternative Names or the certificate is rejected outright — with an error that says nothing about
 * the real cause. IP addresses go in as IP:, hostnames as DNS:; putting an IP under DNS: silently
 * fails to match.
 */
function ensureCertificate(addresses) {
  if (existsSync(keyPath) && existsSync(crtPath)) return false;
  mkdirSync(certDir, { recursive: true });
  const sans = ["DNS:localhost", "IP:127.0.0.1", "IP:::1", ...addresses.map((address) => `IP:${address}`)].join(",");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "90", "-nodes",
    "-keyout", keyPath, "-out", crtPath,
    "-subj", "/CN=101 local acceptance",
    "-addext", `subjectAltName=${sans}`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,digitalSignature,keyCertSign",
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("Could not generate a certificate.\n", result.stderr);
    process.exit(1);
  }
  return true;
}

const addresses = lanAddresses();
if (addresses.length === 0) {
  console.error("No network address found. The laptop and the phone have to be on the same Wi-Fi.");
  process.exit(1);
}
const generated = ensureCertificate(addresses);

const server = createHttpsServer(
  { key: readFileSync(keyPath), cert: readFileSync(crtPath) },
  (incoming, outgoing) => {
    const proxied = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: incoming.method,
        path: incoming.url,
        // The app builds absolute URLs from these, so the phone must be told the origin it actually
        // typed. Without them every generated link points back at plain http on another port, which
        // is the same broken camera by a longer route.
        headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": incoming.headers.host ?? "" },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    proxied.on("error", (cause) => {
      outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end(`The plain server on port ${targetPort} is not answering. Start it with: npm run start\n\n${cause.message}`);
    });
    incoming.pipe(proxied);
  },
);

server.on("upgrade", (incoming, socket, head) => {
  // Pairing runs over a websocket; without this the controller connects and then never links.
  const proxied = httpRequest({
    host: targetHost,
    port: targetPort,
    method: incoming.method,
    path: incoming.url,
    headers: incoming.headers,
  });
  proxied.on("upgrade", (response, upstream, upstreamHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (upstreamHead?.length) socket.unshift(upstreamHead);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  proxied.on("error", () => socket.destroy());
  if (head?.length) proxied.write(head);
  proxied.end();
});

server.listen(port, "0.0.0.0", () => {
  const fingerprint = spawnSync("openssl", ["x509", "-in", crtPath, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" })
    .stdout?.trim().split("=")[1] ?? "unknown";

  console.log(generated ? `Generated a 90-day certificate in .certs/ for ${addresses.join(", ")}\n` : "Reusing the certificate in .certs/\n");
  console.log("On the phone, open one of:");
  for (const address of addresses) console.log(`  https://${address}:${port}/`);
  console.log(`\nSHA-256 fingerprint: ${fingerprint}`);
  console.log(`
The phone will warn that the certificate is not trusted. That warning is correct — it was made on
this machine a moment ago. Check the fingerprint above matches, then:

  iPhone   Safari shows "This Connection Is Not Private". Tap Show Details, then "visit this
           website". Safari treats the origin as secure afterwards, which is what the camera needs.
           If a case needs it to survive a restart, install the certificate instead: AirDrop
           .certs/lan.crt to the phone, Settings > General > VPN & Device Management to install it,
           then Settings > General > About > Certificate Trust Settings to switch full trust on.

  Android  Chrome shows "Your connection isn't private". Tap Advanced, then "Proceed". Or skip all
           of this and use a cable:  adb reverse tcp:3000 tcp:3000  and open
           http://localhost:3000 — localhost is a secure context with nothing to trust.

Record whichever route you used in the receipt. It is part of the environment.
`);
});
