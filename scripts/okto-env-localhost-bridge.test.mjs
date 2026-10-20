import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import {
  DEFAULT_BASES,
  DEFAULT_OFFSETS,
  computePorts,
  parseBases,
  parseOffsets,
  startBridge,
} from "./okto-env-localhost-bridge.mjs";

test("parseOffsets expands ranges with a step and plain numbers", () => {
  assert.deepEqual(parseOffsets("100-900:100"), [100, 200, 300, 400, 500, 600, 700, 800, 900]);
  assert.deepEqual(parseOffsets("5, 10-12"), [5, 10, 11, 12]);
  assert.deepEqual(parseOffsets(""), []);
});

test("parse functions reject malformed input", () => {
  assert.throws(() => parseBases("9000,abc"));
  assert.throws(() => parseOffsets("100-50"));
  assert.throws(() => parseOffsets("1-5:0"));
  assert.throws(() => parseOffsets("-5"));
});

test("computePorts defaults cover the Cognito range and never include base 3000 or 3100", () => {
  const ports = computePorts(DEFAULT_BASES, DEFAULT_OFFSETS);
  assert.equal(ports.length, 36);
  for (let port = 9100; port <= 9900; port += 100) assert.ok(ports.includes(port), String(port));
  assert.ok(ports.includes(3120) && ports.includes(3930) && ports.includes(4900));
  assert.ok(!ports.includes(3100));
  assert.ok(!ports.some((port) => port > 3000 && port < 3100));
});

test("computePorts drops base 3000, dedupes, sorts and bounds ports", () => {
  assert.deepEqual(computePorts("3000,10", "1,2"), [11, 12]);
  assert.deepEqual(computePorts("100,200", "100"), [200, 300]);
  assert.deepEqual(computePorts("65000", "100,1000"), [65100]);
});

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function exchange(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(data));
    socket.on("connect", () => socket.write(payload));
    setTimeout(() => socket.end(), 200).unref();
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("skips a port that is already in use instead of failing", async () => {
  const busy = net.createServer();
  const busyPort = await listen(busy);
  const logs = [];
  const servers = await startBridge({ ports: [busyPort], targetHost: "127.0.0.1", log: (m) => logs.push(m) });
  assert.equal(servers.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EADDRINUSE/);
  busy.close();
});

test("forwards to the upstream, and survives the upstream refusing connections", async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const bridgePort = await freePort();

  const [bridge] = await startBridge({
    ports: [bridgePort],
    targetHost: "127.0.0.1",
    targetPort: () => echoPort,
    log: () => {},
  });
  assert.ok(bridge.listening);
  assert.equal(await exchange(bridgePort, "ping"), "ping");

  // Upstream goes away: the client is closed, the bridge keeps listening and
  // still forwards once the upstream is back.
  await new Promise((resolve) => echo.close(resolve));
  assert.equal(await exchange(bridgePort, "ping"), "");
  assert.ok(bridge.listening);

  const again = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => again.listen(echoPort, "127.0.0.1", resolve));
  assert.equal(await exchange(bridgePort, "pong"), "pong");

  bridge.close();
  again.close();
});
