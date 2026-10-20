# Deploying this fork to release-bot

Every push (merge) to `master` of `ShopRocket-LLC/paperclip` runs
`.github/workflows/deploy-release-bot.yml`, which executes on a **self-hosted
GitHub Actions runner installed on release-bot** (GitHub-hosted runners cannot
reach the LAN host 192.168.10.181). Manual runs: `gh workflow run deploy-release-bot.yml`.

Note: every upstream merge pushed to `master` triggers a deploy.

## What the job does

1. In `~/apps/paperclip` on the host: `git fetch origin master`, `git checkout master`,
   `git reset --hard origin/master` (no `git clean`, so untracked/ignored files survive).
2. `cd docker && docker compose -f docker-compose.quickstart.yml -f docker-compose.agent-tools.yml up --build -d`
   (see "Agent tools" below).
3. Polls `http://localhost:3100/` for HTTP 200 and container `docker-paperclip-1`
   running, up to 5 minutes. On failure it prints `docker logs --tail 50`, the
   previous SHA and the rollback command.
4. Logs the deployed commit / image id and runs `docker image prune -f`
   (dangling only; never `-a`, never volumes).

Deploys are serialized by a `concurrency` group (`cancel-in-progress: false`).
The first build after a large upstream change can take 10+ minutes.

## Secrets and data (never touched by deploys)

- `~/apps/paperclip/docker/.env` (mode 600, untracked) holds `BETTER_AUTH_SECRET`,
  `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, `PAPERCLIP_PUBLIC_URL`,
  `PAPERCLIP_ALLOWED_HOSTNAMES`, `CLAUDE_CODE_OAUTH_TOKEN`. Compose reads it
  automatically. It is not in GitHub secrets and the workflow never prints it.
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

## Agent tools: Docker and .NET for agents

`docker/docker-compose.agent-tools.yml` is layered on the quickstart file. It
gives agents a Docker daemon and the .NET 8 SDK, so they can run okto-env /
okto-stack test environments and build the C# parts of oktorocket. Without the
overlay (upstream users), the image and stack are unchanged.

- **`dind` service** (`docker:29-dind`, `privileged`). Its daemon listens only on
  a unix socket in the `dind-socket` volume (no TCP listener). Images, containers
  and volumes that agents create live in the `docker_dind-data` volume.
- **Paperclip image** is built with `INSTALL_AGENT_TOOLS=1`: Docker CLI with the
  compose v2 and buildx plugins (Docker's Debian repo), and the .NET 8 SDK
  (`dotnet-install.sh --channel 8.0`; every oktorocket project targets `net8.0`).
  `node` is in group `docker` (GID 2375), which owns the dind socket.
  `DOCKER_HOST=unix:///var/run/dind/docker.sock`.
- **Shared network namespace.** Paperclip runs with `network_mode: service:dind`,
  so ports that test stacks publish on `127.0.0.1` in dind are reachable from
  agents on `127.0.0.1`. Paperclip's port 3100 is therefore published on the
  `dind` service. Nested networks use `10.231.0.0/16` so they never shadow LAN
  routes. Avoid publishing port 3100 from a test stack.
- **Bind mounts.** The data directory is mounted at `/paperclip` in both services,
  so a compose file in an agent worktree (under `/paperclip/...`) can bind-mount
  its sources. Paths outside `/paperclip` (for example `/tmp`) do not exist in
  dind and come up as empty directories. Files that nested containers write as
  root into a bind mount are root-owned, and `node` cannot delete them directly.
  Remove them through dind (`docker run --rm -v "$PWD":/w alpine rm -rf /w/<dir>`).
- **Resource limits** on `dind` (they cover every nested container): 12 CPUs,
  20 GiB memory (no extra swap), 8192 pids. The host has 24 cores and 45 GiB;
  okto-ops uses under 1 GiB and Paperclip about 2 GiB, so a runaway test stack
  cannot starve okto-ops. Disk is not capped: check `docker system df` inside
  dind and prune when needed (`docker exec -u node docker-paperclip-1 docker system prune -f`).
- **Deploys.** A deploy recreates only `paperclip` when its image changes; `dind`
  and running test stacks survive. A change to the `dind` service recreates both,
  which stops test stacks (they restart if their restart policy says so).

### Security model

Agents have root over the dind daemon, not the host:

- The host socket `/var/run/docker.sock` is never mounted. Agents cannot list,
  stop or exec into `docker-paperclip-1`, the okto-ops containers, or anything
  else on the host daemon.
- `dind` is `privileged`, which dind requires. A container escape from a nested
  container, or an agent starting a nested container with `--privileged` and
  host devices, reaches the dind container, which is privileged on the host. So
  this is a strong boundary against mistakes and runaway stacks, not a boundary
  against a malicious agent with kernel exploits. The full boundary design is
  okto-ops WP6 (rootless runtime, separate user, explicit egress rules).
- Through dind, agents can read and write everything under `/paperclip` (they
  already can as `node`), including root-owned writes.
- Nested containers on a non-internal network have outbound network access
  through the host, like Paperclip itself, and can reach Paperclip's port 3100
  through the dind gateway. okto-env's synthetic stacks use an `internal: true`
  network, which has no route out.

## Rollback

On a failed health check the job log shows the previous SHA. To roll back manually:

```bash
ssh release-bot
git -C ~/apps/paperclip reset --hard <PREVIOUS_SHA>
cd ~/apps/paperclip/docker && docker compose -f docker-compose.quickstart.yml -f docker-compose.agent-tools.yml up --build -d
```

To roll back to a commit from before the agent-tools overlay existed, drop the
second `-f` and add `--remove-orphans` so the `dind` service is removed (its
`docker_dind-data` volume stays until you delete it with `docker volume rm`).

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
