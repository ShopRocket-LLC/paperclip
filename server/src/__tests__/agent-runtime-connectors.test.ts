import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, companyMemberships, principalPermissionGrants, companySecrets, companySecretBindings, companySecretProviderConfigs, connectionGrants, connectionGrantMembers, connectionGrantDelegations, userSecretDefinitions, createDb, instanceSettings, pluginConfig, plugins, toolApplications, toolConnections, toolCatalogEntries, toolConnectionInstalls, toolProfiles, toolPolicies, toolMcpGateways, toolProfileBindings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { registerPluginLifecycleDelivery } from "../services/plugin-lifecycle-delivery.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { toolAccessService } from "../services/tool-access.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { accessService } from "../services/access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("connector runtime synchronization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  let peerId: string;
  let pluginId: string;
  let applicationId: string;
  let connectionId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-connectors-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); peerId = randomUUID(); pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connector runtime fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready", manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(agents).values([agentId, peerId].map(id => ({ id, companyId, name: id, adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId] })));
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Fixture MCP", type: "mcp_http" }).returning(); applicationId = application.id;
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId, name: "Fixture connection", uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active" }).returning(); connectionId = connection.id;
  });
  const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);

  it("captures settings and removal while ignoring health bookkeeping and empty writes", async () => {
    const before = (await events()).length;
    await db.update(toolConnections).set({ healthCheckedAt: new Date(), lastHealthAt: new Date(), lastError: "fixture", updatedAt: new Date() }).where(eq(toolConnections.id, connectionId));
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, randomUUID()));
    expect(await events()).toHaveLength(before);
    await db.update(toolConnections).set({ config: { endpoint: "https://mcp.example.test/mcp" }, enabled: false }).where(eq(toolConnections.id, connectionId));
    expect((await events()).slice(before).map(row => row.resourceId).sort()).toEqual([agentId, peerId].sort());
    const changed = (await events()).length;
    await db.delete(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(await events()).toHaveLength(changed + 2);
  });
  it("batches catalog refresh fanout once per company per statement", async () => {
    const before = (await events()).length;
    await db.insert(toolCatalogEntries).values(Array.from({ length: 250 }, (_, index) => ({ companyId, applicationId, connectionId, name: `tool-${index}`, toolName: `tool-${index}`, versionHash: `fixture-${index}` })));
    expect(await events()).toHaveLength(before + 2);
    await db.update(toolCatalogEntries).set({ status: "quarantined" }).where(eq(toolCatalogEntries.connectionId, connectionId));
    expect(await events()).toHaveLength(before + 4);
  });
  it("does not invalidate runtime inputs when a real health probe records failure", async () => {
    const before = await events();
    await expect(toolAccessService(db).checkHealth(connectionId)).rejects.toThrow();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(connection.healthStatus).not.toBe("unknown");
    expect(connection.healthCheckedAt).not.toBeNull();
    expect(await events()).toEqual(before);
  });
  it.each([250, 2500])("batches a real %i-tool catalog refresh and ignores unchanged rediscovery", async count => {
    const tools = Array.from({ length: count }, (_, index) => ({ name: `search_${index}`, description: "Search fixture records", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }));
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    const service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools } }), { headers: { "content-type": "application/json" } });
      },
    });
    const before = (await events()).length;
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(count);
    const after = (await events()).length;
    expect(after - before).toBeGreaterThanOrEqual(2);
    expect(after - before).toBeLessThanOrEqual(count === 250 ? 12 : 24);
    const first = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(count);
    expect(await events()).toHaveLength(after);
    const second = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect(second.map(row => [row.id, row.firstSeenAt, row.status])).toEqual(first.map(row => [row.id, row.firstSeenAt, row.status]));
  });
  it.each(["catalog refresh", "profile edit", "policy edit"] as const)("serializes %s with action finalization before runtime locks", async change => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    let description = "Initial search";
    const options = {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      remoteHttpRequest: async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "search", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } }), { headers: { "content-type": "application/json" } });
      },
    };
    await toolAccessService(db, options).refreshCatalog(connectionId);
    const [entry] = await db.update(toolCatalogEntries).set({ status: "quarantined" }).where(eq(toolCatalogEntries.connectionId, connectionId)).returning();
    const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${connectionId}`)));
    const [policy] = change === "policy edit" ? await db.insert(toolPolicies).values({ companyId, name: "Managed search review", policyType: "require_approval", selectors: { catalogEntryId: entry.id }, config: { source: "app_gallery_finish", connectionId, catalogEntryId: entry.id } }).returning() : [];
    if (change === "catalog refresh") description = "Changed search";
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (service: ReturnType<typeof toolAccessService>, policies: ReturnType<typeof toolAccessPolicyService>) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(toolAccessService(tx as unknown as Db, options), toolAccessPolicyService(tx as unknown as Db));
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const finish = run(writer => writer.finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [entry.id], askFirstCatalogEntryIds: change === "policy edit" ? [entry.id] : [], reviewedCatalogEntryIds: [entry.id], access: "all_agents" }));
    let refresh: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      refresh = run((writer, policies) => change === "catalog refresh" ? writer.refreshCatalog(connectionId)
        : change === "profile edit" ? writer.updateProfile(profile.id, { description: "Edited concurrently" })
        : policies.updatePolicy({ companyId, policyId: policy!.id, body: { description: "Edited concurrently", config: null } }));
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([finish, refresh]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [updated] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, entry.id));
    expect(updated).toMatchObject({ status: "active", description });
    if (change === "profile edit") expect((await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile.id)))[0].description).toBe("Edited concurrently");
    if (change === "policy edit") expect((await db.select().from(toolPolicies).where(eq(toolPolicies.id, policy!.id)))[0].description).toBe("Edited concurrently");
  }, 15000);
  it("refreshes known tools from overlapping MCP pages using the last descriptor", async () => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    let overlap = false;
    const descriptor = (description: string) => ({ name: "search", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
    const service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" }
          : body.params?.cursor ? { tools: [descriptor("Last page")] }
          : { tools: [descriptor("First page")], ...(overlap ? { nextCursor: "overlap" } : {}) };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
      },
    });
    await service.refreshCatalog(connectionId);
    const [first] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    overlap = true;
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(1);
    const rows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, firstSeenAt: first.firstSeenAt, description: "Last page" });
  });
  it("captures referenced vault configuration and disablement through the real provider service", async () => {
    const [vault] = await db.insert(companySecretProviderConfigs).values({ companyId, provider: "aws_secrets_manager", displayName: "Fixture vault", config: { region: "us-east-1" } }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, provider: "aws_secrets_manager", providerConfigId: vault.id, key: "vault", name: "Vault fixture" }).returning();
    await db.update(toolConnections).set({ credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).where(eq(toolConnections.id, connectionId));
    const before = (await events()).length;
    await db.update(companySecretProviderConfigs).set({ healthStatus: "ok", healthCheckedAt: new Date(), healthDetails: { fixture: true } }).where(eq(companySecretProviderConfigs.id, vault.id));
    expect(await events()).toHaveLength(before);
    await secretService(db).updateProviderConfig(vault.id, { config: { region: "us-west-2" } });
    expect(await events()).toHaveLength(before + 2);
    await secretService(db).disableProviderConfig(vault.id);
    expect(await events()).toHaveLength(before + 4);
    const [unrelated] = await db.insert(companySecretProviderConfigs).values({ companyId, provider: "local_encrypted", displayName: "Unreferenced vault" }).returning();
    await secretService(db).disableProviderConfig(unrelated.id);
    expect(await events()).toHaveLength(before + 4);
  });
  it("skips unchanged grant audiences and coalesces replacements to one company refresh per transaction", async () => {
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization" }).returning();
    const service = toolAccessService(db);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, ["alice"]);
    const before = (await events()).length;
    expect((await service.replaceConnectionGrantMembers(connectionId, grant.id, ["alice", "alice"])).members).toHaveLength(1);
    expect(await events()).toHaveLength(before);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, ["bob"]);
    expect(await events()).toHaveLength(before + 2);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, []);
    expect(await events()).toHaveLength(before + 4);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, []);
    expect(await events()).toHaveLength(before + 4);
  });
  it("serializes named gateways targeting different agents without foreign-key lock upgrades", async () => {
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "gateway-fixture", name: "Gateway fixture" }).returning();
    const [lower, higher] = [agentId, peerId].sort();
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, lower)).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const saves = [higher, lower].map((target, index) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return createToolGatewayService(tx as unknown as Db).createNamedGateway({ companyId, body: { name: `Gateway ${index}`, profileId: profile.id, agentId: target } });
    }));
    const completed = Promise.allSettled(saves);
    try {
      await vi.waitFor(async () => {
        expect(pids).toHaveLength(2);
        const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE pid IN (${pids[0]}, ${pids[1]}) AND wait_event_type = 'Lock'`);
        expect(rows).toHaveLength(2);
      }, { timeout: 5000 });
    } finally { release(); await blocker; }
    const results = await completed;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, companyId))).toHaveLength(2);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(2);
  }, 15000);
  it.each(["archive", "preserved finish"] as const)("orders %s with application edits before connection mutations", async change => {
    if (change === "preserved finish") {
      await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connectionId}`, name: "Preserved profile" });
      await db.update(toolConnections).set({ config: { sourceTemplateKey: "executor", connectionMethodKey: "mcp", mcpPreserveAccess: true } }).where(eq(toolConnections.id, connectionId));
    }
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(toolApplications).where(eq(toolApplications.id, applicationId)).for("update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (service: ReturnType<typeof toolAccessService>) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(toolAccessService(tx as unknown as Db));
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const edit = run(writer => writer.updateApplication(applicationId, { name: "Edited concurrently" }));
    let mutation: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      mutation = run(writer => change === "archive" ? writer.archiveConnection(connectionId, companyId) : writer.finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" }));
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([edit, mutation]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationId));
    expect(application.name).toBe("Edited concurrently");
    expect((await toolAccessService(db).getConnection(connectionId, companyId)).status).toBe(change === "archive" ? "archived" : "active");
  }, 15000);
  it.each(["uninstall", "permission save"] as const)("serializes %s with finalization or role changes before runtime locks", async change => {
    let first: (client: Db) => Promise<unknown>;
    let second: (client: Db) => Promise<unknown>;
    let memberId: string | undefined;
    if (change === "uninstall") {
      await toolAccessService(db).putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: agentId }] });
      expect((await toolAccessService(db).getConnection(connectionId, companyId)).config.mcpAgentAccessConfigured).toBe(true);
      first = client => toolAccessService(client).putConnectionInstalls(connectionId, { installs: [] });
      second = client => toolAccessService(client).finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" });
    } else {
      const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active", membershipRole: "member" }).returning();
      memberId = member.id;
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "alice", permissionKey: "agents:create" });
      first = client => accessService(client).updateMemberAndPermissions(companyId, member.id, { membershipRole: "admin", grants: [{ permissionKey: "agents:create" }] }, null);
      second = client => accessService(client).setMemberPermissions(companyId, member.id, [{ permissionKey: "issues:create" }], null);
    }
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (client: Db) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(tx as unknown as Db);
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const initial = run(first);
    let concurrent: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      concurrent = run(second);
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([initial, concurrent]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    if (change === "uninstall") {
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId))).toHaveLength(0);
      const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId));
      expect(bindings.some(binding => binding.metadata?.source === "tool_connection_install")).toBe(false);
    } else {
      expect(await accessService(db).getMemberById(companyId, memberId!)).toMatchObject({ membershipRole: "admin" });
      expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId))).toEqual([expect.objectContaining({ permissionKey: "issues:create" })]);
    }
  }, 15000);
  it("ignores real trust-rule hits while retaining meaningful rule changes", async () => {
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId, applicationId, connectionId, name: "Search", toolName: "search", versionHash: "fixture" }).returning();
    const [rule] = await db.insert(toolPolicies).values({ companyId, name: "Trusted search", policyType: "trust_rule", selectors: { agentId, connectionId, toolName: "search" }, config: { trustRule: { hitCount: 0 } } }).returning();
    const before = await events();
    const decision = await toolAccessPolicyService(db).decide({ companyId, actor: { actorType: "agent", actorId: agentId, agentId }, request: { connectionId, catalogEntryId: entry.id, toolName: "search", arguments: {} }, consumeRateLimit: true });
    expect(decision).toMatchObject({ allowed: true, reasonCode: "allow_trust_rule" });
    const [used] = await db.select().from(toolPolicies).where(eq(toolPolicies.id, rule.id));
    expect(used.config).toMatchObject({ trustRule: { hitCount: 1, lastHitAt: expect.any(String) } });
    expect(await events()).toEqual(before);
    await db.update(toolPolicies).set({ config: { ...used.config, trustRule: { ...(used.config?.trustRule as object), revokedAt: new Date().toISOString() } } }).where(eq(toolPolicies.id, rule.id));
    expect(await events()).toHaveLength(before.length + 2);
  });
  it("serializes concurrent delegations before acquiring agent foreign-key locks", async () => {
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const grants = await db.insert(connectionGrants).values(["alice", "bob"].map(subjectUserId => ({ companyId, connectionId, kind: "user", subjectUserId }))).returning();
    const [lower, higher] = [agentId, peerId].sort();
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, lower)).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const saves = grants.map((grant, index) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, index === 0 ? higher : lower, grant.subjectUserId!);
    }));
    const completed = Promise.allSettled(saves);
    try {
      await vi.waitFor(async () => {
        expect(pids).toHaveLength(2);
        const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE pid IN (${pids[0]}, ${pids[1]}) AND wait_event_type = 'Lock'`);
        expect(rows).toHaveLength(2);
      }, { timeout: 5000 });
    } finally { release(); await blocker; }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.companyId, companyId))).toHaveLength(2);
    const before = await events();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grants[0].id, higher, grants[0].subjectUserId!);
    expect(await events()).toEqual(before);
  }, 15000);
  it("orders grant revocation with a concurrent delegation creation", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayCreate = new Promise<void>(resolve => { resume = resolve; });
    const revokerStarted = new Promise<number>(resolve => { started = resolve; });
    const creation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      locked(); await mayCreate;
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, peerId, "alice");
    });
    await held;
    const revocation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).revokeConnectionGrant(connectionId, grant.id);
    });
    const completed = Promise.allSettled([creation, revocation]);
    try {
      const pid = await revokerStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
    await expect(toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, peerId, "alice")).rejects.toThrow("Only the active personal grant owner");
  }, 15000);
  it.each((["suspended", "archived"] as const).flatMap(status => (["revocation", "settings"] as const).map(writer => ({ status, writer }))))("orders membership $status cleanup with concurrent $writer", async ({ status, writer }) => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", membershipRole: "member", status: "active" }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "cleanup", name: "Cleanup fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "cleanup", name: "Cleanup fixture", scope: "user", ownerUserId: "alice", userSecretDefinitionId: definition.id }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayRevoke = new Promise<void>(resolve => { resume = resolve; });
    const cleanupStarted = new Promise<number>(resolve => { started = resolve; });
    const revocation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      if (writer === "revocation") await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      else await tx.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).for("update");
      locked(); await mayRevoke;
      const service = toolAccessService(tx as unknown as Db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      return writer === "revocation" ? service.revokeConnectionGrant(connectionId, grant.id) : service.updateConnection(connectionId, { name: "Concurrent settings" });
    });
    await held;
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      const service = accessService(tx as unknown as Db);
      return status === "suspended" ? service.updateMember(companyId, member.id, { status }) : service.archiveMember(companyId, member.id);
    });
    const completed = Promise.allSettled([revocation, cleanup]);
    try {
      const pid = await cleanupStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe(status);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toEqual([]);
    if (writer === "settings") expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].name).toBe("Concurrent settings");
  }, 15000);
  it("orders audience replacement after membership cleanup without reversing grant locks", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const members = await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, membershipRole: "member", status: "active" }))).returning();
    const member = members.find(row => row.principalId === "alice")!;
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "audience", name: "Audience fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "audience", name: "Audience fixture", scope: "user", userSecretDefinitionId: definition.id, ownerUserId: "alice" }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] });
    const [organization] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", isDefault: true }).returning();
    await db.insert(connectionGrantMembers).values({ companyId, grantId: organization.id, subjectType: "user", subjectId: "alice" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const maySuspend = new Promise<void>(resolve => { resume = resolve; });
    const audienceStarted = new Promise<number>(resolve => { started = resolve; });
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)).for("update");
      locked(); await maySuspend;
      return accessService(tx as unknown as Db).updateMember(companyId, member.id, { status: "suspended" });
    });
    await held;
    const replacement = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).replaceConnectionGrantMembers(connectionId, organization.id, ["bob"]);
    });
    const completed = Promise.allSettled([cleanup, replacement]);
    try {
      const pid = await audienceStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe("suspended");
    expect((await db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, organization.id))).map(row => row.subjectId)).toEqual(["bob"]);
  }, 15000);
  it("invalidates only the owner of an agent secret binding", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "binding", name: "Binding fixture" }).returning();
    const before = (await events()).length;
    const [binding] = await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: agentId, configPath: "env.FIXTURE" }).returning();
    await db.update(companySecretBindings).set({ versionSelector: "2" }).where(eq(companySecretBindings.id, binding.id));
    await db.delete(companySecretBindings).where(eq(companySecretBindings.id, binding.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agentId, agentId, agentId]);
  });
  it("allows an agent configuration save to finish while a connector refresh waits on that agent", async () => {
    const higher = [agentId, peerId].sort().at(-1)!;
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "concurrent", name: "Concurrent fixture" }).returning();
    await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: higher, configPath: "env.FIXTURE" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const agentLocked = new Promise<void>(resolve => { locked = resolve; });
    const maySave = new Promise<void>(resolve => { resume = resolve; });
    const connectorStarted = new Promise<number>(resolve => { started = resolve; });
    const save = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(agents).where(eq(agents.id, higher)).for("update");
      locked(); await maySave;
      await updateAgentConfigurationInTransaction(tx as unknown as Db, higher, { adapterConfig: { env: {} } });
    });
    await agentLocked;
    const connector = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      await tx.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connectionId));
    });
    try {
      const pid = await connectorStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); await Promise.all([save, connector]); }
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, higher))).toEqual([]);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].enabled).toBe(false);
  }, 15000);
  it("captures profile assignment and revocation without exposing another agent's assignments", async () => {
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "fixture", name: "Fixture profile" }).returning();
    const [binding] = await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId }).returning();
    const [install] = await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: agentId }).returning();
    const owner = await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    expect(owner!.connectionAssignments).toMatchObject({ connections: [expect.objectContaining({ id: connectionId })], profileIds: [profile.id] });
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, peerId))!.connectionAssignments).toMatchObject({ connections: [], profileIds: [] });
    const before = (await events()).length;
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.id, binding.id));
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.id, install.id));
    expect(await events()).toHaveLength(before + 4);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.connectionAssignments).toMatchObject({ connections: [], profileIds: [] });
  });
  it("captures grant revocation and referenced credential rotation without storing credentials in events", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "fixture", name: "Fixture secret" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).returning();
    const before = (await events()).length;
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, secret.id));
    expect(await events()).toHaveLength(before + 2);
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toHaveLength(before + 4);
    expect(Object.keys((await events()).at(-1)!).sort()).toEqual(["action", "companyId", "createdAt", "id", "resourceId", "resourceType"]);
    const unrelated = await db.insert(companySecrets).values({ companyId, key: "unrelated", name: "Unrelated" }).returning();
    const unchanged = (await events()).length;
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, unrelated[0].id));
    expect(await events()).toHaveLength(unchanged);
  });
  it("keeps connector changes and their events atomic and company-scoped", async () => {
    const before = await events();
    await expect(db.transaction(async tx => {
      await tx.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connectionId));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await events()).toEqual(before);
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT connector_fixture_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connectionId))).rejects.toThrow(); }
    finally { await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT connector_fixture_failure`); }
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].enabled).toBe(true);
    const other = randomUUID();
    await db.insert(companies).values({ id: other, name: "Other company", issuePrefix: `X${other.slice(0, 6)}` });
    await db.insert(toolApplications).values({ companyId: other, name: "Other MCP", type: "mcp_http" });
    expect(await events()).toEqual(before);
  });
  it("fails closed when standing assignments exceed the bounded snapshot", async () => {
    const added = await db.insert(toolConnections).values(Array.from({ length: 513 }, (_, index) => ({ companyId, applicationId, name: `bounded-${index}`, uid: randomUUID(), transport: "mcp_remote" as const, authKind: "none" as const }))).returning({ id: toolConnections.id });
    await db.insert(toolConnectionInstalls).values(added.map(connection => ({ companyId, connectionId: connection.id, targetType: "agent" as const, targetId: agentId })));
    await expect(pluginAgentRuntimeState(db, pluginId, companyId, agentId)).rejects.toMatchObject({ status: 422 });
  });
  it("invalidates connector feature switches and returns their effective standing state", async () => {
    await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    const before = (await events()).length;
    await db.update(instanceSettings).set({ experimental: { enableChatConnectors: true } });
    expect(await events()).toHaveLength(before + 2);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.connectionAssignments.features).toEqual({ publicMcp: false, chatConnectors: true });
  });
  it("refreshes acknowledged runtime state after managed feature overlays change across restarts", async () => {
    await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {} });
    const inbox = pluginLifecycleInbox(db, pluginId);
    for (const event of await events()) await inbox.acknowledge(companyId, String(event.id));
    for (const enabled of [true, false]) {
      vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "2026.720.0", features: { enablePublicMcp: enabled, enableChatConnectors: enabled }, plugins: { autoInstall: [] } }));
      const before = (await events()).length;
      const snapshots: Array<{ publicMcp: boolean; chatConnectors: boolean }> = [];
      const call = vi.fn(async (_plugin, _method, event) => {
        const state = await pluginAgentRuntimeState(db, pluginId, companyId, event.resourceId);
        snapshots.push(state!.connectionAssignments.features);
        return { eventId: event.id, status: "acknowledged" };
      });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const delivery = registerPluginLifecycleDelivery(coordinator, db, { call, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
      try {
        await delivery.ready;
        await vi.waitFor(() => expect(snapshots).toEqual(Array(2).fill({ publicMcp: enabled, chatConnectors: enabled })), { timeout: 5000 });
        await vi.waitFor(async () => expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([]), { timeout: 5000 });
        expect(await events()).toHaveLength(before + 2);
      } finally { delivery.dispose(); await coordinator.stop(); }
    }
  });
});
