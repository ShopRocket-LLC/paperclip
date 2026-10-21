import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "jest-worker-cap.cjs");
const root = mkdtempSync(path.join(tmpdir(), "jest-worker-cap-"));

// A script that prints the argv a program sees after the preload ran. The
// "jest" one sits where the Jest CLI does (node_modules/jest/bin/jest.js).
function makeScript(relativePath) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return file;
}
const jestCli = makeScript("node_modules/jest/bin/jest.js");
const jestCliPackage = makeScript("node_modules/jest-cli/bin/jest.js");
const other = makeScript("tool/index.js");

function argvSeenBy(script, args) {
  const result = spawnSync(process.execPath, ["--require", preload, script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("caps the Jest CLI at two workers when none was requested", () => {
  assert.deepEqual(argvSeenBy(jestCli, ["path/to/a.test.js"]), ["--maxWorkers=2", "path/to/a.test.js"]);
  assert.deepEqual(argvSeenBy(jestCliPackage, []), ["--maxWorkers=2"]);
});

test("caps the Jest CLI when launched through the node_modules/.bin symlink", () => {
  const bin = path.join(root, "node_modules/.bin/jest");
  mkdirSync(path.dirname(bin), { recursive: true });
  symlinkSync(jestCli, bin);
  assert.deepEqual(argvSeenBy(bin, ["a.test.js"]), ["--maxWorkers=2", "a.test.js"]);
  assert.deepEqual(argvSeenBy(bin, ["-w", "3"]), ["-w", "3"]);
});

test("leaves a caller-chosen worker count alone", () => {
  for (const args of [
    ["--maxWorkers=8"], ["--maxWorkers", "8"], ["--max-workers=50%"], ["-w", "3"], ["-w3"], ["-i"], ["--runInBand"],
  ]) {
    assert.deepEqual(argvSeenBy(jestCli, args), args);
  }
});

test("does nothing for other Node programs", () => {
  assert.deepEqual(argvSeenBy(other, ["--foo"]), ["--foo"]);
});

function installShim(name, realProgram) {
  const dir = mkdtempSync(path.join(root, "shims-"));
  const shim = path.join(dir, "jest-cap-shim.sh");
  writeFileSync(
    shim,
    readFileSync(path.join(path.dirname(preload), "jest-cap-shim.sh"), "utf8")
      .replaceAll("/usr/local/bin/node", process.execPath)
      .replace("/usr/local/bin/$name", realProgram)
      .replace("preload=/usr/local/lib/paperclip/jest-worker-cap.cjs", `preload=${preload}`),
    { mode: 0o755 },
  );
  const linked = path.join(dir, name);
  if (name !== "jest-cap-shim.sh") symlinkSync(shim, linked);
  return linked;
}

test("node shim starts Node with the preload so the Jest CLI is capped", () => {
  const shim = installShim("node");
  const run = (script, args) => {
    const result = spawnSync(shim, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(run(jestCli, ["a.test.js"]), ["--maxWorkers=2", "a.test.js"]);
  assert.deepEqual(run(other, ["--foo"]), ["--foo"]);
});

test("yarn shim runs the real yarn with the preload in NODE_OPTIONS, keeping existing options", () => {
  const fakeYarn = path.join(root, "fake-yarn.sh");
  writeFileSync(fakeYarn, '#!/bin/sh\necho "$NODE_OPTIONS|$*"\n', { mode: 0o755 });
  const shim = installShim("yarn", fakeYarn);
  const run = (env) => spawnSync(shim, ["jest", "x"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).stdout.trim();
  assert.equal(run({}), `--require ${preload}|jest x`);
  assert.equal(run({ NODE_OPTIONS: "--max-old-space-size=512" }), `--max-old-space-size=512 --require ${preload}|jest x`);
});
