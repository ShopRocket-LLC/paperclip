#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HOUR_MS = 60 * 60 * 1000;
const STALLED_HOURS = 24;
const NOT_RUNNING_HOURS = 48;
const BUDGET_THRESHOLD = 0.8;
const MAX_DIVES = 8;
const RUNS_PER_AGENT = 100;
const FALLBACK_WINDOW_HOURS = 24;
const DOCUMENT_KEY = "standup";

const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const LIVE_RUN_STATUSES = new Set(["queued", "scheduled_retry", "running"]);
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

// Lower rank sorts first in "Needs you" and is investigated first.
const NEEDS_YOU_RANK = {
  standup_failed: 0,
  failing: 1,
  blocked: 2,
  approval: 3,
  interaction: 4,
  stalled: 5,
  not_running: 6,
  budget: 7,
};

class ApiError extends Error {
  constructor(status, message) {
    super(`${status}: ${message}`);
    this.name = "ApiError";
    this.status = status;
  }
}

function usage() {
  return `Usage:
  standup.mjs collect [--output-dir DIR] [--issue-id ID]
  standup.mjs publish --facts FILE --report FILE [--assignee-user-id ID] [--dry-run]

Environment:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_AGENT_ID,
  PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "collect";
  if (!["collect", "publish"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    if (key === "dry_run") {
      options.dry_run = true;
      continue;
    }
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    options[key] = value;
  }
  return { command, options };
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function runtime(options) {
  let apiBase = required(process.env.PAPERCLIP_API_URL, "PAPERCLIP_API_URL").replace(/\/+$/, "");
  if (apiBase.endsWith("/api")) apiBase = apiBase.slice(0, -4);
  return {
    apiBase,
    apiKey: required(process.env.PAPERCLIP_API_KEY, "PAPERCLIP_API_KEY"),
    companyId: required(process.env.PAPERCLIP_COMPANY_ID, "PAPERCLIP_COMPANY_ID"),
    agentId: required(process.env.PAPERCLIP_AGENT_ID, "PAPERCLIP_AGENT_ID"),
    issueId: required(options.issue_id ?? process.env.PAPERCLIP_TASK_ID, "PAPERCLIP_TASK_ID (or --issue-id)"),
    runId: process.env.PAPERCLIP_RUN_ID ?? null,
  };
}

async function api(context, path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${context.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && context.runId) headers["X-Paperclip-Run-Id"] = context.runId;
  const response = await fetch(`${context.apiBase}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" ? parsed.error ?? parsed.message : parsed;
    throw new ApiError(response.status, String(message ?? response.statusText));
  }
  return parsed;
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return search.toString();
}

function time(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursSince(now, iso) {
  const t = time(iso);
  return t === null ? null : Math.floor((now - t) / HOUR_MS);
}

function excerpt(text, max = 200) {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || null;
}

function runIssueId(run) {
  return run.contextSnapshot?.issueId ?? run.issueId ?? null;
}

function latestTime(values) {
  let best = null;
  for (const value of values) {
    const t = time(value);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * The standup window starts where the previous standup started. The first
 * standup falls back to the last 24 hours.
 */
export function resolveWindowStart({ currentIssue, previousStandups, now }) {
  const currentCreated = time(currentIssue?.createdAt) ?? now;
  const previous = latestTime(
    (previousStandups ?? [])
      .filter((issue) => issue.id !== currentIssue?.id && (time(issue.createdAt) ?? Infinity) < currentCreated)
      .map((issue) => issue.createdAt),
  );
  return new Date(previous ?? now - FALLBACK_WINDOW_HOURS * HOUR_MS).toISOString();
}

/**
 * Turns a raw API snapshot into standup facts. Pure: everything time-based
 * comes from `now` and `windowStart`.
 */
export function buildStandupFacts(snapshot, { now, windowStart }) {
  const selfId = snapshot.selfAgentId;
  const windowStartMs = time(windowStart);
  const inWindow = (iso) => {
    const t = time(iso);
    return t !== null && t >= windowStartMs && t <= now;
  };
  const agents = snapshot.agents ?? [];
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  const runsByAgent = snapshot.runsByAgent ?? {};
  const openIssues = (snapshot.openIssues ?? []).filter((issue) => issue.id !== snapshot.currentIssue?.id);
  const needsYou = [];

  const issueRef = (issue) => ({
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
  });
  const push = (item) => {
    needsYou.push({
      agentId: null,
      agentName: item.agentId ? agentName.get(item.agentId) ?? null : null,
      issueId: null,
      identifier: null,
      title: null,
      ...item,
      ageHours: hoursSince(now, item.since),
    });
  };

  // Own failures stay visible so a broken standup can't go quiet.
  for (const run of runsByAgent[selfId] ?? []) {
    if (FAILED_RUN_STATUSES.has(run.status) && inWindow(run.createdAt)) {
      push({
        kind: "standup_failed",
        agentId: selfId,
        runId: run.id,
        since: run.createdAt,
        detail: excerpt(run.error) ?? run.status,
      });
    }
  }

  for (const agent of agents) {
    if (agent.id === selfId) continue;
    const runs = [...(runsByAgent[agent.id] ?? [])].sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0));
    const finished = runs.filter((run) => !LIVE_RUN_STATUSES.has(run.status));
    if (finished.length >= 2 && FAILED_RUN_STATUSES.has(finished[0].status) && FAILED_RUN_STATUSES.has(finished[1].status)) {
      push({
        kind: "failing",
        agentId: agent.id,
        runId: finished[0].id,
        since: finished[1].createdAt,
        detail: excerpt(finished[0].error) ?? finished[0].status,
      });
    }

    const hasLiveRun = runs.some((run) => LIVE_RUN_STATUSES.has(run.status));
    const assignedWork = openIssues.filter(
      (issue) => issue.assigneeAgentId === agent.id && (issue.status === "todo" || issue.status === "in_progress"),
    );
    const lastRunMs = time(runs[0]?.createdAt) ?? time(agent.lastHeartbeatAt);
    if (assignedWork.length > 0 && !hasLiveRun && (lastRunMs === null || now - lastRunMs >= NOT_RUNNING_HOURS * HOUR_MS)) {
      push({
        kind: "not_running",
        agentId: agent.id,
        since: lastRunMs === null ? null : new Date(lastRunMs).toISOString(),
        detail: `${assignedWork.length} open assigned issue(s); agent status ${agent.status}`,
      });
    }
  }

  for (const agent of agents) {
    const budget = agent.budgetMonthlyCents ?? 0;
    const spent = agent.spentMonthlyCents ?? 0;
    if (budget > 0 && spent / budget > BUDGET_THRESHOLD) {
      push({
        kind: "budget",
        agentId: agent.id,
        since: null,
        detail: `${Math.round((spent / budget) * 100)}% of monthly budget ($${(spent / 100).toFixed(2)} of $${(budget / 100).toFixed(2)})`,
      });
    }
  }

  for (const issue of openIssues) {
    if (issue.status === "blocked") {
      const blockers = (issue.blockedBy ?? []).map((blocker) => blocker.identifier ?? blocker.id).filter(Boolean);
      const attention = issue.blockedInboxAttention;
      push({
        kind: "blocked",
        agentId: issue.assigneeAgentId ?? null,
        ...issueRef(issue),
        since: issue.blockedTransitionAt ?? issue.updatedAt,
        detail: [
          blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : null,
          attention?.reason ?? attention?.state ?? null,
        ].filter(Boolean).join("; ") || null,
      });
    }
    if (issue.status === "in_progress" && issue.assigneeAgentId && issue.assigneeAgentId !== selfId) {
      const issueRuns = (runsByAgent[issue.assigneeAgentId] ?? []).filter((run) => runIssueId(run) === issue.id);
      if (issueRuns.some((run) => LIVE_RUN_STATUSES.has(run.status))) continue;
      const lastTouch = latestTime(issueRuns.flatMap((run) => [run.createdAt, run.finishedAt]))
        ?? time(issue.startedAt)
        ?? time(issue.updatedAt);
      if (lastTouch !== null && now - lastTouch >= STALLED_HOURS * HOUR_MS) {
        push({
          kind: "stalled",
          agentId: issue.assigneeAgentId,
          ...issueRef(issue),
          since: new Date(lastTouch).toISOString(),
          detail: "in_progress with no run activity",
        });
      }
    }
  }

  for (const approval of snapshot.approvals ?? []) {
    if (approval.status !== "pending") continue;
    push({
      kind: "approval",
      agentId: approval.requestedByAgentId ?? null,
      approvalId: approval.id,
      since: approval.createdAt,
      detail: excerpt(approval.payload?.title) ?? approval.type,
    });
  }

  const issueById = new Map(openIssues.map((issue) => [issue.id, issue]));
  for (const [issueId, interactions] of Object.entries(snapshot.interactionsByIssue ?? {})) {
    const issue = issueById.get(issueId);
    if (!issue) continue;
    for (const interaction of interactions) {
      if (interaction.status !== "pending" || interaction.addresseeAgentId) continue;
      push({
        kind: "interaction",
        agentId: issue.assigneeAgentId ?? null,
        ...issueRef(issue),
        interactionId: interaction.id,
        since: interaction.createdAt,
        detail: excerpt(interaction.title ?? interaction.summary) ?? interaction.kind,
      });
    }
  }

  needsYou.sort((a, b) =>
    NEEDS_YOU_RANK[a.kind] - NEEDS_YOU_RANK[b.kind] || (time(a.since) ?? Infinity) - (time(b.since) ?? Infinity));

  const flagged = new Set(needsYou.map((item) => item.agentId).filter(Boolean));
  const agentSections = [];
  let idleCount = 0;
  for (const agent of agents) {
    if (agent.id === selfId) continue;
    const runs = (runsByAgent[agent.id] ?? []).filter((run) => inWindow(run.createdAt));
    const done = (snapshot.doneIssues ?? []).filter(
      (issue) => issue.assigneeAgentId === agent.id && inWindow(issue.completedAt),
    );
    if (runs.length === 0 && done.length === 0 && !flagged.has(agent.id)) {
      idleCount += 1;
      continue;
    }
    const failedRuns = runs.filter((run) => FAILED_RUN_STATUSES.has(run.status));
    agentSections.push({
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      runCount: runs.length,
      done: done.map(issueRef),
      inProgress: openIssues
        .filter((issue) => issue.assigneeAgentId === agent.id && issue.status === "in_progress")
        .map(issueRef),
      problems: {
        failedRuns: failedRuns.length,
        lastError: excerpt(failedRuns[0]?.error) ?? null,
        lastFailedRunId: failedRuns[0]?.id ?? null,
      },
      spendUsd: Math.round(runs.reduce((sum, run) => sum + (Number(run.costUsd) || 0), 0) * 100) / 100,
      monthlyBudget: {
        spentCents: agent.spentMonthlyCents ?? 0,
        budgetCents: agent.budgetMonthlyCents ?? 0,
      },
    });
  }

  const diveCandidates = [
    ...needsYou.map((item, index) => ({ ref: `needsYou[${index}]`, ...pickDive(item) })),
    ...agentSections
      .filter((section) => section.problems.failedRuns > 0 && !needsYou.some((item) => item.kind === "failing" && item.agentId === section.agentId))
      .map((section) => ({
        ref: `agent:${section.agentId}`,
        kind: "problems",
        agentId: section.agentId,
        issueId: null,
        runId: section.problems.lastFailedRunId,
      })),
  ];

  const truncatedAgents = Object.entries(runsByAgent)
    .filter(([, runs]) => runs.length >= RUNS_PER_AGENT && (time(runs.at(-1)?.createdAt) ?? 0) > windowStartMs)
    .map(([agentId]) => agentName.get(agentId) ?? agentId);

  return {
    issueId: snapshot.currentIssue?.id ?? null,
    windowStart,
    windowEnd: new Date(now).toISOString(),
    needsYou,
    agents: agentSections,
    idleCount,
    dives: diveCandidates.slice(0, MAX_DIVES),
    notInvestigated: Math.max(0, diveCandidates.length - MAX_DIVES),
    truncatedAgents,
    disposition: needsYou.length > 0 ? "in_review" : "done",
  };
}

function pickDive(item) {
  return {
    kind: item.kind,
    agentId: item.agentId,
    issueId: item.issueId,
    runId: item.runId ?? null,
  };
}

async function collectSnapshot(context, now) {
  const { companyId } = context;
  const currentIssue = await api(context, `/issues/${context.issueId}`);
  const previousStandups = currentIssue.originId
    ? await api(context, `/companies/${companyId}/issues?${query({
      originKind: currentIssue.originKind,
      originId: currentIssue.originId,
      includeRoutineExecutions: true,
      limit: 20,
    })}`)
    : [];
  const windowStart = resolveWindowStart({ currentIssue, previousStandups, now });

  const [agents, openIssues, doneIssues, approvals] = await Promise.all([
    api(context, `/companies/${companyId}/agents`),
    api(context, `/companies/${companyId}/issues?${query({
      status: OPEN_ISSUE_STATUSES.join(","),
      includeBlockedBy: true,
      includeBlockedInboxAttention: true,
      includeRoutineExecutions: true,
      limit: 1000,
    })}`),
    api(context, `/companies/${companyId}/issues?${query({
      status: "done",
      updatedSince: windowStart,
      includeRoutineExecutions: true,
      limit: 1000,
    })}`),
    api(context, `/companies/${companyId}/approvals?status=pending`),
  ]);

  const runsByAgent = {};
  for (const agent of agents) {
    runsByAgent[agent.id] = await api(
      context,
      `/companies/${companyId}/heartbeat-runs?${query({ agentId: agent.id, limit: RUNS_PER_AGENT, summary: true })}`,
    );
  }

  const interactionsByIssue = {};
  for (const issue of openIssues.filter((row) => row.status === "in_review" && row.id !== currentIssue.id)) {
    interactionsByIssue[issue.id] = await api(context, `/issues/${issue.id}/interactions`);
  }

  return {
    windowStart,
    snapshot: {
      selfAgentId: context.agentId,
      currentIssue,
      agents,
      openIssues,
      doneIssues,
      approvals,
      runsByAgent,
      interactionsByIssue,
    },
  };
}

function responsibleUserId(apiKey) {
  const payload = apiKey.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).responsible_user_id ?? null;
  } catch {
    return null;
  }
}

export function publishPlan(facts, { assigneeUserId }) {
  const count = facts.needsYou.length;
  if (facts.disposition === "in_review") {
    if (!assigneeUserId) throw new Error("No operator to hand the standup to: pass --assignee-user-id");
    return {
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId,
      comment: `Standup posted. ${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you; see the \`${DOCUMENT_KEY}\` document.`,
    };
  }
  return {
    status: "done",
    comment: `Standup posted. Nothing needs you today; see the \`${DOCUMENT_KEY}\` document.`,
  };
}

async function publish(context, options) {
  const facts = JSON.parse(readFileSync(required(options.facts, "--facts"), "utf8"));
  const report = readFileSync(required(options.report, "--report"), "utf8");
  const issueId = facts.issueId ?? context.issueId;
  const patch = publishPlan(facts, {
    assigneeUserId: options.assignee_user_id ?? responsibleUserId(context.apiKey),
  });
  const title = `Standup ${facts.windowEnd.slice(0, 10)}`;
  if (options.dry_run) {
    console.log(JSON.stringify({ issueId, document: { key: DOCUMENT_KEY, title, bytes: report.length }, patch }, null, 2));
    return;
  }

  let baseRevisionId;
  try {
    baseRevisionId = (await api(context, `/issues/${issueId}/documents/${DOCUMENT_KEY}`)).latestRevisionId;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  await api(context, `/issues/${issueId}/documents/${DOCUMENT_KEY}`, {
    method: "PUT",
    body: { format: "markdown", title, body: report, ...(baseRevisionId ? { baseRevisionId } : {}) },
  });
  await api(context, `/issues/${issueId}`, { method: "PATCH", body: patch });
  console.log(`Published ${DOCUMENT_KEY} on ${issueId}; status ${patch.status}`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const context = runtime(options);
  if (command === "publish") {
    await publish(context, options);
    return;
  }
  const now = Date.now();
  const outputDir = resolve(options.output_dir ?? ".");
  mkdirSync(outputDir, { recursive: true });
  const { snapshot, windowStart } = await collectSnapshot(context, now);
  const facts = buildStandupFacts(snapshot, { now, windowStart });
  writeFileSync(resolve(outputDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(resolve(outputDir, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
  console.log(`Wrote ${resolve(outputDir, "facts.json")}: ${facts.needsYou.length} needs-you, ${facts.agents.length} active agents, ${facts.idleCount} idle, ${facts.dives.length} dives`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    process.exit(1);
  });
}
