---
name: paperclip-standup
description: Write the operator's daily standup for a Paperclip company — what each agent did, what it is doing, and every item that needs the operator (blocked issues, pending approvals and interactions, failing or stalled agents, budget near its cap, assigned work not running). Read-only toward other agents. Use when woken by the standup routine or asked for a "standup", "daily report on the agents", or "what needs me today".
---

# Paperclip Standup

A standup is a daily, read-only report to the operator. It covers the **standup window**: everything since the previous standup. The routine creates the standup issue; this skill fills it and hands it off.

## Hard rules

- **Read-only toward other agents.** Never comment on, reassign, wake, unblock, checkout, or change the status of any issue except the standup issue itself. Never resolve approvals or interactions. The operator acts; you report.
- **The script decides what needs the operator.** Do not add, drop, or reword Needs-you items based on your own judgement. Your dives only explain items the script already found.
- **Facts only.** Every claim in the report must come from `facts.json` or a dive. If a dive could not find the cause, say "cause unknown".

## 1. Collect

Check out the standup issue as the `paperclip` skill describes, then run the script that sits next to this file:

```bash
RUN_DIR="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_TASK_SCRATCH_DIR:-.}}/paperclip-standup"
node "<this skill's directory>/scripts/standup.mjs" collect --output-dir "$RUN_DIR"
```

It writes `facts.json` (what to report) and `snapshot.json` (raw API data, for reference). If the script fails, do not write a report by hand: leave the issue `blocked` with the script's error in a comment, so the failure shows up in the next standup.

`facts.json` holds:

- `needsYou`: ordered items. Each has `kind`, `agentName`, `identifier`/`title` when an issue is involved, `ageHours`, and `detail`. Kinds: `standup_failed`, `failing`, `blocked`, `approval`, `interaction`, `stalled`, `not_running`, `budget`.
- `agents`: only agents with activity in the window or a Needs-you item, each with `done`, `inProgress`, `problems`, `spendUsd`, and `monthlyBudget`.
- `idleCount`: agents with nothing to report.
- `dives`: at most 8 items to investigate. `notInvestigated` counts the rest.
- `truncatedAgents`: agents whose run history may be incomplete for the window.
- `disposition`: `in_review` when something needs the operator, otherwise `done`.

## 2. Dive with Haiku

For each entry in `dives`, start a subagent with `model: "haiku"`. Run them in parallel. Give each one the entry JSON plus the matching `needsYou` item, and this brief:

> Read-only investigation of one Paperclip item. Use only GET requests to `$PAPERCLIP_API_URL/api` with `Authorization: Bearer $PAPERCLIP_API_KEY`. Useful reads: `GET /issues/{issueId}`, `GET /issues/{issueId}/comments`, `GET /heartbeat-runs/{runId}`. Never POST, PATCH, PUT, or DELETE. Reply with at most three lines: **What happened**, **Likely cause**, **What the operator should do**. Say "unknown" rather than guess.

Do not dive into anything outside `dives`.

## 3. Write the report

Write `$RUN_DIR/report.md` with exactly these sections, in this order. Keep it terse: the operator scans it in under a minute.

```markdown
# Standup — {windowEnd date}

Window: {windowStart} → {windowEnd}

## Needs you ({count})
- **{kind label}** · {agentName} · {identifier} {title} · {age, e.g. "3d" or "14h"}
  {detail}. {dive's three lines, joined, if investigated}

## Per agent
### {name} ({status if paused/error})
- Done: {identifiers and titles, or "nothing"}
- In progress: {identifiers and titles, or "nothing"}
- Problems: {failed run count and last error, or "none"}
- Spend: ${spendUsd} this window · {monthly spent} of {monthly budget} this month

## Idle
{idleCount} idle agents not shown.
```

Rules:

- Kind labels: `standup_failed` "Standup failed", `failing` "Failing", `blocked` "Blocked", `approval` "Approval pending", `interaction` "Waiting on you", `stalled` "Stalled", `not_running` "Not running", `budget` "Budget".
- Empty Needs you: write `## Needs you (0)` and "Nothing needs you."
- If `notInvestigated > 0`, end the Needs you section with "{n} more not investigated."
- If `truncatedAgents` is non-empty, add one line under Per agent: "Run history may be incomplete for: {names}."
- Link issues by identifier as plain text (for example `PAP-412`); Paperclip links them.

## 4. Publish

```bash
node "<this skill's directory>/scripts/standup.mjs" publish \
  --facts "$RUN_DIR/facts.json" \
  --report "$RUN_DIR/report.md"
```

This writes the report as the issue's `standup` document and sets the disposition:

- **Something needs the operator:** the issue moves to `in_review` and is assigned to the operator (the run's responsible user, or `--assignee-user-id`), so it lands in their inbox.
- **Nothing needs the operator:** the issue is marked `done` with the report attached.

Use `--dry-run` to print what would be written without changing anything. Publishing is the last step; exit after it.
