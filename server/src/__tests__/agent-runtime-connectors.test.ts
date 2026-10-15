import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, companySecrets, connectionGrants, createDb, instanceSettings, plugins, toolApplications, toolConnections, toolCatalogEntries, toolConnectionInstalls, toolProfiles, toolProfileBindings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";

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
});
