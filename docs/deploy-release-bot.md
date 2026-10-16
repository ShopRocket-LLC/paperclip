# Deploying this fork to release-bot

Every push (merge) to `master` of `ShopRocket-LLC/paperclip` runs
`.github/workflows/deploy-release-bot.yml`, which executes on a **self-hosted
GitHub Actions runner installed on release-bot** (GitHub-hosted runners cannot
reach the LAN host 192.168.10.181). Manual runs: `gh workflow run deploy-release-bot.yml`.

Note: every upstream merge pushed to `master` triggers a deploy.

## What the job does

1. In `~/apps/paperclip` on the host: `git fetch origin master`, `git checkout master`,
   `git reset --hard origin/master` (no `git clean`, so untracked/ignored files survive).
2. `cd docker && docker compose -f docker-compose.quickstart.yml up --build -d`.
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

## Rollback

On a failed health check the job log shows the previous SHA. To roll back manually:

```bash
ssh release-bot
git -C ~/apps/paperclip reset --hard <PREVIOUS_SHA>
cd ~/apps/paperclip/docker && docker compose -f docker-compose.quickstart.yml up --build -d
```

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
