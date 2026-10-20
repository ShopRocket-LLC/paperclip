import assert from "node:assert/strict";
import test from "node:test";

import { buildStandupFacts, publishPlan, resolveWindowStart } from "./standup.mjs";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const windowStart = "2026-10-19T12:00:00.000Z";
const hoursAgo = (hours) => new Date(now - hours * 3600 * 1000).toISOString();

function agent(overrides = {}) {
  return {
    id: "agent-a",
    name: "Builder",
    status: "idle",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-a",
    status: "succeeded",
    createdAt: hoursAgo(1),
    finishedAt: hoursAgo(1),
    costUsd: 0,
    error: null,
    contextSnapshot: { issueId: null },
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Example",
    status: "todo",
    assigneeAgentId: "agent-a",
    updatedAt: hoursAgo(1),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    selfAgentId: "standup",
    currentIssue: { id: "standup-issue" },
    agents: [agent({ id: "standup", name: "Standup" }), agent()],
    openIssues: [],
    doneIssues: [],
    approvals: [],
    runsByAgent: {},
    interactionsByIssue: {},
    ...overrides,
  };
}

const build = (overrides) => buildStandupFacts(snapshot(overrides), { now, windowStart });
const kinds = (facts) => facts.needsYou.map((item) => item.kind);

test("quiet day: nothing needs you, idle agents are counted, issue closes as done", () => {
  const facts = build();
  assert.deepEqual(facts.needsYou, []);
  assert.deepEqual(facts.agents, []);
  assert.equal(facts.idleCount, 1);
  assert.equal(facts.disposition, "done");
});

test("blocked issue needs you with its age and blockers", () => {
  const facts = build({
    openIssues: [issue({
      status: "blocked",
      blockedTransitionAt: hoursAgo(50),
      blockedBy: [{ id: "x", identifier: "PAP-9" }],
    })],
  });
  assert.deepEqual(kinds(facts), ["blocked"]);
  assert.equal(facts.needsYou[0].ageHours, 50);
  assert.match(facts.needsYou[0].detail, /PAP-9/);
  assert.equal(facts.disposition, "in_review");
  assert.equal(facts.idleCount, 0, "a blocked agent always appears");
  assert.equal(facts.agents[0].agentId, "agent-a");
});

test("stalled: in_progress counts from 24 hours without run activity", () => {
  const stalled = (lastRunHours) => build({
    openIssues: [issue({ status: "in_progress", startedAt: hoursAgo(100) })],
    runsByAgent: { "agent-a": [run({ createdAt: hoursAgo(lastRunHours), finishedAt: hoursAgo(lastRunHours), contextSnapshot: { issueId: "issue-1" } })] },
  });
  assert.deepEqual(kinds(stalled(23.9)), []);
  assert.deepEqual(kinds(stalled(24)), ["stalled"]);
});

test("stalled ignores issues with a live run", () => {
  const facts = build({
    openIssues: [issue({ status: "in_progress", startedAt: hoursAgo(100) })],
    runsByAgent: { "agent-a": [run({ status: "running", createdAt: hoursAgo(30), finishedAt: null, contextSnapshot: { issueId: "issue-1" } })] },
  });
  assert.ok(!kinds(facts).includes("stalled"));
});

test("failing needs two failed runs in a row; one is only a problem", () => {
  const one = build({ runsByAgent: { "agent-a": [run({ status: "failed", error: "auth 403" }), run({ createdAt: hoursAgo(2) })] } });
  assert.deepEqual(kinds(one), []);
  assert.equal(one.agents[0].problems.failedRuns, 1);
  assert.equal(one.dives[0].kind, "problems", "an agent with failed runs is still investigated");

  const two = build({
    runsByAgent: { "agent-a": [run({ status: "timed_out" }), run({ status: "failed", createdAt: hoursAgo(2) })] },
  });
  assert.deepEqual(kinds(two), ["failing"]);
});

test("budget triggers above 80 percent, not at it", () => {
  assert.deepEqual(kinds(build({ agents: [agent({ budgetMonthlyCents: 1000, spentMonthlyCents: 800 })] })), []);
  assert.deepEqual(kinds(build({ agents: [agent({ budgetMonthlyCents: 1000, spentMonthlyCents: 801 })] })), ["budget"]);
});

test("not running: open assigned work with no run in 48 hours, paused agents included", () => {
  const facts = (lastRunHours, status = "idle") => build({
    agents: [agent({ status })],
    openIssues: [issue({ status: "todo" })],
    runsByAgent: { "agent-a": [run({ createdAt: hoursAgo(lastRunHours) })] },
  });
  assert.deepEqual(kinds(facts(47)), []);
  assert.deepEqual(kinds(facts(48)), ["not_running"]);
  assert.deepEqual(kinds(facts(72, "paused")), ["not_running"]);
});

test("an idle agent with no assigned work is not flagged", () => {
  const facts = build({ runsByAgent: { "agent-a": [run({ createdAt: hoursAgo(500) })] } });
  assert.deepEqual(kinds(facts), []);
  assert.equal(facts.idleCount, 1);
});

test("pending approvals and human-addressed interactions need you", () => {
  const facts = build({
    approvals: [
      { id: "ap-1", status: "pending", type: "hire_agent", requestedByAgentId: "agent-a", createdAt: hoursAgo(6), payload: {} },
      { id: "ap-2", status: "approved", type: "hire_agent", createdAt: hoursAgo(6) },
    ],
    openIssues: [issue({ status: "in_review" })],
    interactionsByIssue: {
      "issue-1": [
        { id: "int-1", kind: "ask_user_questions", status: "pending", addresseeAgentId: null, createdAt: hoursAgo(3) },
        { id: "int-2", kind: "request_confirmation", status: "pending", addresseeAgentId: "agent-b", createdAt: hoursAgo(3) },
        { id: "int-3", kind: "request_confirmation", status: "accepted", addresseeAgentId: null, createdAt: hoursAgo(3) },
      ],
    },
  });
  assert.deepEqual(kinds(facts), ["approval", "interaction"]);
});

test("the standup's own failures need you; it never gets its own agent section", () => {
  const facts = build({
    runsByAgent: {
      standup: [run({ agentId: "standup", status: "failed", error: "boom", createdAt: hoursAgo(20) })],
    },
  });
  assert.deepEqual(kinds(facts), ["standup_failed"]);
  assert.ok(!facts.agents.some((section) => section.agentId === "standup"));
});

test("the standup's own failures before the window are not repeated", () => {
  const facts = build({
    runsByAgent: { standup: [run({ agentId: "standup", status: "failed", createdAt: hoursAgo(30) })] },
  });
  assert.deepEqual(kinds(facts), []);
});

test("agent section reports done, in progress, and spend within the window only", () => {
  const facts = build({
    openIssues: [issue({ id: "i-2", identifier: "PAP-2", status: "in_progress", startedAt: hoursAgo(2) })],
    doneIssues: [
      issue({ id: "i-3", identifier: "PAP-3", status: "done", completedAt: hoursAgo(5) }),
      issue({ id: "i-4", identifier: "PAP-4", status: "done", completedAt: hoursAgo(30) }),
    ],
    runsByAgent: {
      "agent-a": [
        run({ costUsd: 1.25, contextSnapshot: { issueId: "i-2" } }),
        run({ costUsd: 0.5, createdAt: hoursAgo(10) }),
        run({ costUsd: 9, createdAt: hoursAgo(30) }),
      ],
    },
  });
  const [section] = facts.agents;
  assert.deepEqual(section.done.map((row) => row.identifier), ["PAP-3"]);
  assert.deepEqual(section.inProgress.map((row) => row.identifier), ["PAP-2"]);
  assert.equal(section.spendUsd, 1.75);
  assert.equal(section.runCount, 2);
});

test("needs-you is ordered by kind then age, and dives cap at 8", () => {
  const openIssues = Array.from({ length: 10 }, (_, index) => issue({
    id: `b-${index}`,
    identifier: `PAP-${index}`,
    status: "blocked",
    blockedTransitionAt: hoursAgo(index + 1),
  }));
  const facts = build({
    openIssues,
    runsByAgent: { standup: [run({ agentId: "standup", status: "failed" })] },
  });
  assert.equal(facts.needsYou[0].kind, "standup_failed");
  assert.equal(facts.needsYou[1].identifier, "PAP-9", "oldest blocker first");
  assert.equal(facts.dives.length, 8);
  assert.equal(facts.notInvestigated, 3);
});

test("window starts at the previous standup, falling back to 24 hours", () => {
  const currentIssue = { id: "s-3", createdAt: hoursAgo(0) };
  assert.equal(
    resolveWindowStart({
      currentIssue,
      previousStandups: [currentIssue, { id: "s-1", createdAt: hoursAgo(96) }, { id: "s-2", createdAt: hoursAgo(72) }],
      now,
    }),
    hoursAgo(72),
    "Monday covers the weekend back to Friday's standup",
  );
  assert.equal(resolveWindowStart({ currentIssue, previousStandups: [currentIssue], now }), hoursAgo(24));
});

test("publish hands the issue to the operator only when something needs them", () => {
  const busy = publishPlan({ disposition: "in_review", needsYou: [{}, {}] }, { assigneeUserId: "user-1" });
  assert.equal(busy.status, "in_review");
  assert.equal(busy.assigneeUserId, "user-1");
  assert.equal(busy.assigneeAgentId, null);
  assert.match(busy.comment, /2 items need you/);

  const quiet = publishPlan({ disposition: "done", needsYou: [] }, { assigneeUserId: "user-1" });
  assert.equal(quiet.status, "done");
  assert.equal(quiet.assigneeUserId, undefined);

  assert.throws(() => publishPlan({ disposition: "in_review", needsYou: [{}] }, { assigneeUserId: null }), /operator/);
});
