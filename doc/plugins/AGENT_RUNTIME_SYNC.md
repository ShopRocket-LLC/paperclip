# Agent runtime synchronization

Plugins can opt into committed agent runtime changes with
`resourceLifecycle: ["agent_runtime"]` and `events.subscribe`.
Implement `onResourceLifecycle` and handle `update` and `delete`.
Existing agent and project subscriptions do not receive this new resource type.
Manual inbox reads retain both legacy streams regardless of automatic subscriptions.
They include runtime events only when the manifest opts into `agent_runtime`.

An event contains company identity, agent identity in `resourceId`, a numeric
sequence serialized as `id`, and its action. It contains no file contents,
configuration, or credentials. Treat `id` as an opaque decimal revision, not a
JavaScript floating-point value. Delivery is at least once and ordered per agent.
Return `acknowledged` only after external effects finish. Return `retry` after an
unfinished operation, or `deferred` when configuration is missing. Startup,
plugin startup, and configuration changes recover unacknowledged work.

The host records configuration changes at the database mutation boundary. This
covers API saves, rollback, plugin writes, and background writers. No-op updates
and heartbeat accounting do not create runtime work. Instruction edits, file
deletions, restores, and run writeback use the file audit boundary. Pending hires
produce no update until approval. Returning to the ready lifecycle phase requests
synchronization after preparation or resume. Existing agents receive a one-time
baseline when the migration runs. Agent deletion leaves a durable delete event.

PostgreSQL notifications wake the existing durable dispatcher only after commit,
including writes through independent clients. Notifications carry no identifiers
or contents. The journal remains authoritative. The listener scans on connection
and reconnection so a dropped notification does not lose committed work. There
is no recurring empty-inbox poll. Existing retry deadlines still retry failed work.
A process opens one listener connection only after a ready plugin opts into
`agent_runtime`. The database connection must support session-level `LISTEN`;
transaction-mode poolers are not supported for this opt-in feature. Startup waits
for listener registration. It releases the listener after the last runtime
subscriber is disabled or removed. Legacy subscriptions keep process-local work signals.

A plugin that also has `agents.lifecycle.manage` can call
`ctx.agents.getRuntime(agentId, companyId)` from a company-scoped invocation.
Only the enabled, ready plugin selected in that agent's required lifecycle set
can read these inputs. The result supplies the latest runtime revision, the
normalized agent configuration, instruction root and entry filename, and that
plugin's own instance secrets. Instruction paths use the same managed-folder
recovery as the instruction reader. A missing or cross-company agent returns null.
The instruction root identifies host files that the trusted worker can package
through its existing filesystem access. This API grants no arbitrary path reads.
Never expose instance secrets through UI data, logs, plugin state, or agent files.

Re-read current state before external effects. A queued event can be older than
the returned revision. Fence stale revisions at the destination and use its
conditional writes. Current configuration is desired state, not a frozen run
snapshot or permission to change an active provider session. Execution admission
and provider activation keep their existing checks. The private transport consumer
is a separate integration.

Filesystem changes outside Paperclip's managed write APIs do not emit these
hooks. Filesystem publication and the database journal are not one filesystem
transaction. A failed managed write must be repaired through the same API before
claiming synchronization. Upstream repository detection remains owned by the
source integration.

Successful file saves record the current desired state. Identical retries and
already-applied deletions repair a missing journal event if a prior save published
bytes before its database transaction failed. Audit rows carry their runtime
revision, so repeated identical saves against that revision create no audit rows
or events. Later runtime changes invalidate that deduplication. The file API still
returns `changed: false` for identical content and keeps conditional-write checks.
Consumers can skip rewriting content whose hash already matches.

## Skills

Migration 0348 invalidates referencing agents when installed skill content,
companion files, versions, source bindings, or identities change. Rename checks
both old and new keys. String selections, structured selections, and supported
legacy aliases are recognized. Unrelated agents and other companies receive no
content invalidation. Private-source bindings, membership, and privacy changes
invalidate only agents assigned skills from the affected sources. Project workspace
authorization-policy changes use the same boundary. Company policy
changes conservatively invalidate the company.
Source retry/lease bookkeeping and skill popularity counters do not emit changes.
Multi-skill source publication defers its skill invalidation until transaction
commit, after it acquires all skill rows. This avoids an agent-lock/skill-lock
cycle with concurrent version saves. Individual file edits retain immediate
journaling and their existing filesystem rollback behavior.

Assignment edits already use the configuration boundary. The runtime reader
returns selected skill entries with host source paths and immutable version IDs.
It uses the execution resolver, current agent access, the instance pin flag, and
legacy operational-skill rules. It performs no upstream refresh. The resolver can
rebuild an expired version cache from saved bytes. Slow materialization happens
outside the agent row lock. The reader rechecks ownership and revision afterward;
it retries concurrent changes three times and then returns a conflict.

Pinned assignments receive conservative content invalidations too. Their resolved
version and bytes stay pinned when pin support is enabled. Consumers can compare
versions or destination hashes and avoid rewriting unchanged trees. Task-only
skill mentions and a running task's saved version selection remain task-owned.


## MCP and connectors

Migration 0349 records changes to connections, application settings, catalogs,
installs, profile definitions/entries/bindings, policies, grants, delegation,
company permissions, named gateway settings, and connector endpoint configuration.
Referenced credential rotation and revocation also invalidate runtime state.
These events contain no credential values, phone numbers, or provider payloads.

Connector changes conservatively invalidate eligible agents in the same company.
A profile can inherit company, project, task, or gateway scope, so an agent-only
binding lookup is not sufficient for invalidation. Old and new companies are
covered if a mutation changes ownership. Statement-level transition tables batch
bulk catalog changes: each company gets one fanout per SQL statement, regardless
of the number of changed tools. Empty statements and health/use timestamps do
not create work. Failure to record work rolls back the connector mutation.

The owning runtime reader includes standing company/agent connection installs,
active profile IDs, and effective public-MCP/chat feature flags. The database
queries project only identity, name, transport, enabled/status fields, and profile
IDs. They exclude credential references, arbitrary configuration, and tool schemas.
The reader fails at 512 connection installs or 128 profiles rather than silently
truncating its desired state. Revision and ownership are rechecked after reads.

Standing assignments are preparation inputs, not authorization to use a tool.
Task-scoped profile bindings, responsible-user consent, gateway sessions and
credentials, automatic connector skill overlays, and connection instructions
remain in the existing run preparation path. The invalidation covers their
underlying configuration, but does not fabricate a run identity or activate a
provider session. A transport consumer must preserve those runtime boundaries.
