# Deploying this fork to release-bot

Every push (merge) to `master` of `ShopRocket-LLC/paperclip` runs
`.github/workflows/deploy-release-bot.yml`, which executes on a **self-hosted
GitHub Actions runner installed on release-bot** (GitHub-hosted runners cannot
reach the LAN host 192.168.10.181). Manual runs: `gh workflow run deploy-release-bot.yml`.

Note: every upstream merge pushed to `master` triggers a deploy.

## What the job does

1. In `~/apps/paperclip` on the host: `git fetch origin master`, `git checkout master`,
   `git reset --hard origin/master` (no `git clean`, so untracked/ignored files survive).
2. `cd docker && docker compose -f docker-compose.quickstart.yml -f docker-compose.release-bot.yml up --build -d --remove-orphans`.
   The release-bot overlay is always layered (see "Agent tools" below); there is no
   switch that starts a different stack.
3. Polls `http://localhost:3100/` and `http://localhost:3100/api/health` for HTTP 200
   and container `docker-paperclip-1` running, up to 5 minutes. On failure it prints
   `docker logs --tail 50`, the previous SHA and the rollback command. A final,
   non-fatal step runs `docker exec -u node docker-paperclip-1 docker version` to
   check the rootless Docker socket; a failure there warns but does not fail the deploy.
4. Logs the deployed commit / image id and runs `docker image prune -f`
   (dangling only; never `-a`, never volumes).

Deploys are serialized by a `concurrency` group (`cancel-in-progress: false`).
The first build after a large upstream change can take 10+ minutes.

## Secrets and data (never touched by deploys)

- `~/apps/paperclip/docker/.env` (mode 600, untracked) holds `BETTER_AUTH_SECRET`,
  `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, `PAPERCLIP_PUBLIC_URL`,
  `PAPERCLIP_ALLOWED_HOSTNAMES`, `CLAUDE_CODE_OAUTH_TOKEN`, and optionally
  `PAPERCLIP_UID` / `PAPERCLIP_GID` (default `1001`, the host `paperclip` account;
  see "Agent tools"). Compose reads it automatically. `.dockerignore` excludes
  `.env` files, so `docker/.env` is never copied into an image layer. It is not in GitHub secrets and the workflow never prints it.
  Do not run `docker compose config` in CI logs (it expands secrets).
- Persistent data is `~/apps/paperclip/data/docker-paperclip` (gitignored via
  `data/`). Never run `docker compose down -v`, `git clean -x`, or `rm -rf` in the clone.
  To move it out of the clone, stop the stack, `mv` the directory, set
  `PAPERCLIP_DATA_DIR=/new/path` in `docker/.env`, and start again.

## Security model

The repo is public and the runner executes on a shared internal host. The workflow
therefore triggers **only** on `push` to `master` and `workflow_dispatch`, uses
`permissions: contents: read`, `runs-on: [self-hosted, release-bot]`, and is guarded
by `github.repository == 'ShopRocket-LLC/paperclip'`. Never add `pull_request`,
`pull_request_target`, `issues`, or `workflow_run` triggers, and never use
`runs-on: self-hosted` in any other workflow. Anyone who can push to `master` can
run code on the host; keep `master` protected (PR required) and restrict write access.

## Agent tools: rootless Docker and Playwright for agents

`docker/docker-compose.release-bot.yml` is layered on the quickstart file by every
deploy. It lets agents run okto-env / okto-stack test environments with Docker and
browser tests with Playwright, without giving them root on the host. Upstream users
who do not layer it get the unchanged image and stack.

The old privileged Docker-in-Docker overlay (`docker-compose.agent-tools.yml`, switched
by the repository variable `PAPERCLIP_AGENT_TOOLS`) is gone. The variable is no longer
read and can be deleted. `--remove-orphans` removes a leftover `dind` container on the
first deploy; its `docker_dind-data` volume stays until you run `docker volume rm`.

Host prerequisites (not managed by this repo or by compose):

- A host account `paperclip`, uid/gid `1001`.
- A rootless Docker daemon for that account with its socket at
  `/srv/paperclip/run/docker.sock` (directory `/srv/paperclip/run`, owner 1001, mode 0700).
- A workspace `/srv/paperclip/work`, owner 1001.

What the overlay does:

- **Runs as uid/gid 1001.** Build args and runtime `USER_UID` / `USER_GID` come from
  `PAPERCLIP_UID` / `PAPERCLIP_GID` in `docker/.env` (default 1001). The image's `node`
  user is built with that uid, and the entrypoint also remaps it at start-up. Agents
  therefore have the same uid as the rootless daemon's owner.
- **Image** is built with `INSTALL_AGENT_TOOLS=true`: the Docker CLI with the compose v2
  and buildx plugins (Docker's Debian repo), plus `perl` (okto-env needs Perl `Fcntl`),
  `jq` and `lsof`. There is no daemon in the image and `node` is **not** in a `docker`
  group. `INSTALL_DOTNET=true` additionally installs the .NET 8 SDK
  (`/usr/local/bin/dotnet`); it is on here, because agents run oktorocket's .NET
  suites.
- **Playwright.** `INSTALL_PLAYWRIGHT_BROWSERS=true` installs Playwright 1.62.1's
  Chromium and its system libraries into `/opt/ms-playwright` (world readable and
  executable), and `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` is set. A repo whose
  `@playwright/test` is a different version must either pin 1.62.1 or run
  `npx playwright install chromium` itself (it will then try to write the same path,
  which is read-only for `node`; unset `PLAYWRIGHT_BROWSERS_PATH` for that run).
- **Docker access.** `DOCKER_HOST=unix:///srv/paperclip/run/docker.sock`. The host
  `/srv/paperclip/run` directory is mounted read-only at the same path. The host's
  `/var/run/docker.sock` is never mounted.
- **Workspace.** `/srv/paperclip/work` is mounted read-write at the **same path** on
  both sides. This is required: a compose file an agent runs is resolved by the host's
  rootless daemon, so a bind-mount source path must mean the same thing in the container
  and on the host. Both mounts use `create_host_path: false`, so a missing host
  directory fails the start instead of creating a root-owned one.
- **okto-env.** `OKTO_ENV_HOME=/srv/paperclip/work/okto-env`,
  `OKTO_ENV_OKTOROCKET_REPO=/srv/paperclip/work/src/oktorocket`,
  `OKTO_ENV_DC_MANAGER_REPO=/srv/paperclip/work/src/dc-manager`. The container's `PATH`
  ends with `/srv/paperclip/work/okto-env/bin`, so `okto-env` resolves with no setup, and
  `OKTO_ENV_ROOTLESS`, `OKTO_ENV_MEMORY_BUDGET` (24576 MiB), `OKTO_ENV_LOCK_WAIT`,
  `OKTO_ENV_OFFSET_MAX` (3000: 30 slots; the memory budget, not the slot count, limits
  how many run), `OKTO_ENV_SSO_RELAY_URL` and `OKTO_ENV_PLAYWRIGHT_MODULE` are set. The controller itself is
  installed on the host (not by compose): from the oktorocket clone at
  `/srv/paperclip/work/src/oktorocket`, as the `paperclip` account,
  `OKTO_ENV_HOME=/srv/paperclip/work/okto-env scripts/okto-env/install.sh --ref <sha>`.
  The clone's `origin` is GitHub (the container's `gh` credential helper authenticates it).
- **Networking is unchanged**: the container stays on the compose default network
  (`docker_default`, gateway `172.19.0.1`). Test stacks publish their ports on the
  gateway (`OKTO_ENV_BIND_ADDR=172.19.0.1`). Avoid publishing port 3100 from a test stack.
- **Localhost bridge.** Cognito Unified Login only accepts `http://localhost:9000-9900`
  callbacks, so the browser in Paperclip must reach a test stack as `localhost:<port>`
  (`OKTO_ENV_PUBLIC_HOST=localhost`). With `OKTO_ENV_BRIDGE=1` the entrypoint starts
  `scripts/okto-env-localhost-bridge.mjs` in the background as the app user, restarting
  it if it dies. It forwards `127.0.0.1:<port>` to `${OKTO_ENV_BIND_ADDR}:<port>` for
  every base in `OKTO_ENV_BRIDGE_BASES` (default `9000,3020,3030,4000`) plus every offset
  the controller can hand out, `100-${OKTO_ENV_OFFSET_MAX}:100` (`OKTO_ENV_BRIDGE_OFFSETS`,
  a comma list of numbers or `FROM-TO:STEP` ranges, overrides it). Slot N is offset
  100·N: with 3000 that is 9100-12000, 3120-6020, 3130-6030 and 4100-7000 in steps of
  100, 120 ports. Base 3000 and the SSO relay's port are never bridged. A port that is already in use (such as Paperclip's 3100) is
  logged and skipped; a refused upstream just closes that one connection. It runs
  detached, so it cannot delay or fail Paperclip's start. Unit tests:
  `pnpm test:okto-env-bridge`.
- **SSO relay.** A stack above slot 9 (dc-user past 9900) is not a Cognito callback.
  With `OKTO_ENV_SSO_RELAY_URL=http://localhost:9000` the entrypoint runs oktorocket's
  SSO relay on `127.0.0.1:9000` (a listed callback), supervised like the bridge: the
  pinned controller's copy, `$OKTO_ENV_HOME/sso-relay.cjs`, which `install.sh` links
  (until one is installed the supervisor waits). The okto-env controller records the
  relay on each ui-dev lease and points that stack's dc-user at it: Cognito returns to
  `localhost:9000/workspace`, and the relay redirects the code to the stack that started
  the sign-in (its origin is in the `okto_sso_return` cookie), only ever to a localhost
  origin. It is per container, so a Paperclip redeploy restarts it with the container;
  stacks keep running on the host daemon and sign in again once it is back.

### Agent environment

Agents run their shell commands with a filtered environment: the configured agent env plus
a fixed list of names (this applies to Codex agents (`codex_local`) and to Claude agents
(`claude_local`) on the ACP engine; Claude's CLI engine inherits the container env). To
expose container variables to agent shells on local targets, either:

- set `PAPERCLIP_AGENT_SHELL_ENV_PASSTHROUGH` on the container (comma-separated names, for
  example `DOCKER_HOST,PLAYWRIGHT_BROWSERS_PATH,OKTO_ENV_HOME,OKTO_ENV_OKTOROCKET_REPO,OKTO_ENV_DC_MANAGER_REPO,OKTO_ENV_BIND_ADDR,OKTO_ENV_PUBLIC_HOST`).
  Names containing `key`, `secret` or `token` (case-insensitive) are ignored, as for the
  per-agent env. Remote targets never receive them. `PATH` is always inherited, and
  `/etc/profile.d/okto-env.sh` re-adds the okto-env bin dir for login shells (`bash -l`),
  which otherwise reset `PATH`. Or
- set the same variables in each agent's `env` config in Paperclip.

### Jest worker cap

Jest defaults to one worker per core minus one, and an agent test run on this 24-core host
once exhausted memory. The overlay sets `NODE_OPTIONS=--require /usr/local/lib/paperclip/jest-worker-cap.cjs`
(and passes it through to agent shells). The preload adds `--maxWorkers=2` when the process
is the Jest CLI and the caller did not pass `--maxWorkers`, `--max-workers`, `-w`, `-i` or
`--runInBand`. A `PATH` shim would not work: `npx`, `yarn`, `pnpm` and npm scripts all run the
repo-local `node_modules/.bin/jest` ahead of `PATH`. Not covered: Jest run inside the nested
test stacks of the rootless daemon (separate containers), an agent whose own `env` config sets
`NODE_OPTIONS`, and a `maxWorkers` set in a repo's Jest config (the CLI flag overrides it).

### Memory-pressure kills (systemd-oomd)

The host runs `systemd-oomd` (package `systemd-oomd`, pinned to the installed systemd
version) for the agent workloads only: `user-1001.slice` (the rootless daemon and its test
stacks) and `paperclip.slice` (this container, through `cgroup_parent` in the overlay). Each
has `ManagedOOMMemoryPressure=kill` with a 70% limit (oomd's default 20 s duration). The host
files, which this repo does not deploy:

- `/etc/systemd/system/paperclip.slice`: `[Slice]` with `MemoryAccounting=yes`,
  `ManagedOOMMemoryPressure=kill`, `ManagedOOMMemoryPressureLimit=70%`.
- `/etc/systemd/system/user-1001.slice.d/oomd.conf`: the same three settings.
- `/etc/systemd/system/user@.service.d/99-oomd-agent-workloads-only.conf`: `[Service]`
  `ManagedOOMMemoryPressure=auto`. The package otherwise enables 50% kills for every user
  manager, which would cover other accounts.

Nothing else is monitored (`oomctl` lists only those cgroups) and nothing is swap-monitored
(`ManagedOOMSwap=auto` on the root slice), so `system.slice` and the okto-ops containers are
never oomd targets. When the container is killed, its restart policy brings it back; a kill
takes every agent run in it down, which is the trade for the host staying up.

### Security model

Agents have the privileges of an unprivileged host account and of its rootless daemon:

- There is no privileged container and no root-equivalent socket. The daemon runs as
  uid 1001; "root" inside a nested container maps to uid 1001 on the host.
- The host socket `/var/run/docker.sock` is never mounted. Agents cannot list, stop or
  exec into `docker-paperclip-1`, the okto-ops containers, or anything else on the root
  daemon.
- Agents can read and write `/paperclip` (their data directory) and `/srv/paperclip/work`,
  and control every container on the rootless daemon. They cannot read other host users'
  files, such as `dcsupport`'s home or the okto-ops credentials.
- Nested containers on a non-internal network have outbound network access through the
  host, like Paperclip itself, and can reach Paperclip's port 3100 through the gateway.
  okto-env's synthetic stacks use an `internal: true` network, which has no route out.
- Resource limits and disk use are governed by the rootless daemon's host configuration,
  not by this repo. Check `docker system df` as the `paperclip` account and prune when needed.

### One-time migration: Paperclip data directory to uid 1001

Before this change Paperclip ran as uid/gid 1000 (`dcsupport`). The data directory must be
owned by 1001 before the first deploy of the overlay, so the container does not spend its
start-up (the health check waits only 5 minutes) re-owning a large tree:

```bash
ssh release-bot
cd ~/apps/paperclip/docker
docker compose -f docker-compose.quickstart.yml stop   # stop Paperclip first
sudo chown -R 1001:1001 ~/apps/paperclip/data/docker-paperclip   # or $PAPERCLIP_DATA_DIR
```

Then merge (or re-run the workflow). The entrypoint remaps `node` to 1001 and verifies
ownership on every boot, so a missed chown is repaired automatically, only slower.
`PAPERCLIP_UID` / `PAPERCLIP_GID` in `docker/.env` override the default 1001.
To go back to the old uid, set both to `1000`, chown the directory back, and redeploy.

## Rollback

On a failed health check the job log shows the previous SHA. To roll back manually:

```bash
ssh release-bot
git -C ~/apps/paperclip reset --hard <PREVIOUS_SHA>
cd ~/apps/paperclip/docker && docker compose -f docker-compose.quickstart.yml -f docker-compose.release-bot.yml up --build -d --remove-orphans
```

To roll back to a commit from before the release-bot overlay existed, drop the second
`-f` (that commit has no overlay file). That also returns Paperclip to uid 1000 unless
`PAPERCLIP_UID`/`PAPERCLIP_GID` are set in `docker/.env`; chown the data directory back
to match (see the migration section) if you do.

The next push to `master` will deploy `origin/master` again, so also revert the
bad commit on `master`.

## Runner setup / re-registration

Runner lives in `~/actions-runner` on release-bot, installed as a systemd service
running as `dcsupport`, labels `release-bot` (plus the defaults `self-hosted,Linux,X64`).

```bash
# from a machine with gh authed as a repo admin
TOKEN=$(gh api -X POST repos/ShopRocket-LLC/paperclip/actions/runners/registration-token --jq .token)

# on release-bot (VERSION from https://github.com/actions/runner/releases; verify the sha256 from the release notes)
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSLO https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-x64-${VERSION}.tar.gz
echo "<sha256>  actions-runner-linux-x64-${VERSION}.tar.gz" | sha256sum -c
tar xzf actions-runner-linux-x64-${VERSION}.tar.gz
./config.sh --unattended --url https://github.com/ShopRocket-LLC/paperclip \
  --token "$TOKEN" --name release-bot --labels release-bot --work _work --replace
sudo ./svc.sh install dcsupport && sudo ./svc.sh start
```

The registration token is short-lived and single-purpose; do not store it.
To remove: `sudo ./svc.sh stop && sudo ./svc.sh uninstall && ./config.sh remove --token <new removal token>`
(`gh api -X POST repos/ShopRocket-LLC/paperclip/actions/runners/remove-token`).
Check status: `gh api repos/ShopRocket-LLC/paperclip/actions/runners` or `sudo ./svc.sh status`.

## App data location (release-bot overlay)

With the release-bot overlay, Paperclip's data lives at `/srv/paperclip/data` (owned by the app uid, 1001),
not `~/apps/paperclip/data/docker-paperclip`. Keeping it out of the git checkout keeps it out of the image
build context: the deploy user cannot read it, and BuildKit walks excluded directories when `.dockerignore`
has `!` re-includes. Migration (once, with the stack stopped):
`sudo mv ~/apps/paperclip/data/docker-paperclip /srv/paperclip/data`.
