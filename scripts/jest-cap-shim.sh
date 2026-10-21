#!/bin/sh
# Installed as /usr/local/lib/paperclip/shims/node and shims/yarn (a symlink), first
# on PATH in the release-bot container (docker/docker-compose.release-bot.yml). Both
# make the real program load the Jest worker cap preload (scripts/jest-worker-cap.cjs).
#
# Why shims and not just NODE_OPTIONS: the Claude Agent SDK deletes NODE_OPTIONS from
# the Claude process, and Claude's Bash tool starts its shells without it, so a bare
# `npx jest` there never saw the cap.
#   node: always resolved through PATH. npx, npm and pnpm spawn it, and the shebang of
#         node_modules/.bin/jest is `#!/usr/bin/env node`.
#   yarn: yarn 1 prepends its own directory holding a `node` link to the real binary
#         when it runs a script, bypassing the node shim, so set NODE_OPTIONS for it.
preload=/usr/local/lib/paperclip/jest-worker-cap.cjs
name=${0##*/}
if [ "$name" = node ]; then
  exec /usr/local/bin/node --require "$preload" "$@"
fi
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $preload"
export NODE_OPTIONS
exec "/usr/local/bin/$name" "$@"
