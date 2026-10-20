#!/usr/bin/env node
// Localhost bridge for okto-env test stacks (release-bot overlay only).
//
// Test stacks publish their ports on the Docker gateway (OKTO_ENV_BIND_ADDR,
// e.g. 172.19.0.1), but a browser inside this container must reach them as
// http://localhost:<port> (Cognito only accepts localhost callbacks). This
// forwards 127.0.0.1:<port> to ${OKTO_ENV_BIND_ADDR}:<port> for a fixed set of
// ports. No dependencies.
//
//   OKTO_ENV_BRIDGE=1             required; the entrypoint starts this only then
//   OKTO_ENV_BIND_ADDR            upstream host (required)
//   OKTO_ENV_BRIDGE_BASES         comma list of base ports   (default 9000,3020,3030,4000)
//   OKTO_ENV_BRIDGE_OFFSETS       comma list of offsets: N, or A-B:STEP
//                                 (default 100-900:100, i.e. 100,200,...,900)
//
// Listened ports are every base + every offset. Base 3000 is never listened on
// and bases themselves are not (only base + offset). A port already in use is
// logged and skipped. One failed connection never affects another.

import { realpathSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASES = "9000,3020,3030,4000";
export const DEFAULT_OFFSETS = "100-900:100";
const MAX_PORT = 65535;
const EXIT_CONFIG = 78; // tells the entrypoint's restart loop not to retry

function parseInteger(token, what) {
  if (!/^\d+$/.test(token)) throw new Error(`invalid ${what}: ${JSON.stringify(token)}`);
  return Number(token);
}

function splitList(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

export function parseBases(value) {
  return splitList(value).map((token) => parseInteger(token, "base"));
}

/** Offsets: "100,200" or "100-900:100" (step defaults to 1) in any mix. */
export function parseOffsets(value) {
  const offsets = [];
  for (const token of splitList(value)) {
    const range = /^(\d+)-(\d+)(?::(\d+))?$/.exec(token);
    if (!range) {
      offsets.push(parseInteger(token, "offset"));
      continue;
    }
    const [from, to, step] = [Number(range[1]), Number(range[2]), range[3] === undefined ? 1 : Number(range[3])];
    if (step < 1 || to < from) throw new Error(`invalid offset range: ${JSON.stringify(token)}`);
    for (let offset = from; offset <= to; offset += step) offsets.push(offset);
  }
  return offsets;
}

/** Sorted, unique, valid ports: base + offset. Base 3000 is always dropped. */
export function computePorts(basesValue = DEFAULT_BASES, offsetsValue = DEFAULT_OFFSETS) {
  const bases = parseBases(basesValue).filter((base) => base !== 3000);
  const offsets = parseOffsets(offsetsValue);
  const ports = new Set();
  for (const base of bases) {
    for (const offset of offsets) {
      const port = base + offset;
      if (port >= 1 && port <= MAX_PORT) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

function forward(client, targetHost, targetPort) {
  const upstream = net.connect({ host: targetHost, port: targetPort });
  // An error on either side tears down both; never let it escape.
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
  client.pipe(upstream);
  upstream.pipe(client);
}

function listenOne(port, targetHost, targetPort, listenHost, log) {
  return new Promise((resolve) => {
    const server = net.createServer((client) => forward(client, targetHost, targetPort(port)));
    server.on("error", (error) => {
      // Before listening: skip the port. After: log and keep serving.
      log(`skip ${listenHost}:${port}: ${error.code ?? error.message}`);
      resolve(null);
    });
    server.listen(port, listenHost, () => resolve(server));
  });
}

/**
 * Start listeners. Resolves to the servers that bound; ports that could not
 * bind (for example already in use) are logged and skipped.
 */
export async function startBridge({
  ports,
  targetHost,
  listenHost = "127.0.0.1",
  targetPort = (port) => port, // the real bridge keeps the same port; tests remap
  log = console.log,
}) {
  const servers = (await Promise.all(ports.map((port) => listenOne(port, targetHost, targetPort, listenHost, log))))
    .filter((server) => server !== null);
  return servers;
}

async function main() {
  const log = (message) => console.log(`okto-env-localhost-bridge: ${message}`);
  const targetHost = (process.env.OKTO_ENV_BIND_ADDR ?? "").trim();
  if (!targetHost) {
    log("OKTO_ENV_BIND_ADDR is not set; nothing to bridge to");
    process.exit(EXIT_CONFIG);
  }
  let ports;
  try {
    ports = computePorts(
      process.env.OKTO_ENV_BRIDGE_BASES ?? DEFAULT_BASES,
      process.env.OKTO_ENV_BRIDGE_OFFSETS ?? DEFAULT_OFFSETS,
    );
  } catch (error) {
    log(`bad configuration: ${error.message}`);
    process.exit(EXIT_CONFIG);
  }
  const servers = await startBridge({ ports, targetHost, log });
  log(`forwarding ${servers.length}/${ports.length} ports 127.0.0.1 -> ${targetHost}`);
  // Last-resort guard: a stray socket error must not take the bridge down.
  process.on("uncaughtException", (error) => log(`ignored error: ${error.message}`));
}

// realpath: import.meta.url is symlink-resolved, argv[1] is not.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
