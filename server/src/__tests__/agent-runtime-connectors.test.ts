import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, companyMemberships, companySecrets, companySecretBindings, connectionGrants, createDb, instanceSettings, pluginConfig, plugins, toolApplications, toolConnections, toolCatalogEntries, toolConnectionInstalls, toolProfiles, toolProfileBindings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { registerPluginLifecycleDelivery } from "../services/plugin-lifecycle-delivery.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { toolAccessService } from "../services/tool-access.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";

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
