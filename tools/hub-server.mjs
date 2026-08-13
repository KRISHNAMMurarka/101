#!/usr/bin/env node
import { LocalHubServer, localAddresses } from "../packages/hub-server/src/index.ts";

const port = Number(process.env.PORT || process.argv[2] || 10101);
const advertisedHost = process.env.ADVERTISED_HOST || localAddresses()[0] || "127.0.0.1";
const server = new LocalHubServer({ port, advertisedHost });
const endpoint = await server.start();
console.log(`101 Hub signaling: ${endpoint}`);
console.log(`LAN addresses: ${localAddresses().join(", ") || "none detected"}`);
console.log("No account, cloud service, or external signaling is used.");

const stop = async () => { await server.stop(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
