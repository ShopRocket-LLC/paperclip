"use strict";
// Preloaded into every Node process of the release-bot container through
// NODE_OPTIONS=--require (docker/docker-compose.release-bot.yml). When the
// process is the Jest CLI, it adds --maxWorkers=2 unless the caller already
// chose a worker count. Jest defaults to one worker per core minus one, and a
// 24-core host ran 23 workers x ~1.5 GB into an out-of-memory hang.
//
// A shim on `jest` itself cannot do this: npx, yarn, pnpm and npm scripts all run
// the repo-local node_modules/.bin/jest ahead of PATH. A preload sees the Jest CLI
// however it was launched; it is loaded through NODE_OPTIONS or the `node` shim
// (scripts/jest-cap-shim.sh). It does nothing for any other Node program, and
// it never throws.
const MAX_WORKERS = 2;

try {
  // npm and yarn link node_modules/.bin/jest as a symlink, and Node leaves
  // process.argv[1] as that link path, so resolve it to the real jest/bin/jest.js.
  let main = process.argv[1] || "";
  try {
    main = require("node:fs").realpathSync(main);
  } catch {
    // Keep the path as given.
  }
  if (/[\\/](jest|jest-cli)[\\/]bin[\\/]jest\.js$/.test(main)) {
    const args = process.argv.slice(2);
    const chosen = args.some(
      (arg) =>
        /^--max-?workers(=|$)/i.test(arg) ||
        /^-w(\d|=|$)/.test(arg) ||
        /^(--run-?in-?band|-i)$/i.test(arg),
    );
    if (!chosen) process.argv.splice(2, 0, `--maxWorkers=${MAX_WORKERS}`);
  }
} catch {
  // Never break a Node process over a worker cap.
}
