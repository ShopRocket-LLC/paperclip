import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
