# Durable task pool

The planner records an agreed requirement and bounded tasks. Paperclip executes published work independently of that conversation, retains each attempt in its existing agent/run dashboard, and waits for independent planner acceptance. Acceptance does not merge or deploy code.

## Storage and discovery

PostgreSQL `task_pool_batches` is authoritative. Each batch has a native parent issue and task issues. Each attempt has its own native agent, heartbeat run and detached Git worktree. Agent records are retained and paused after completion.

The server regenerates these mode-600 discovery files (directories mode 700):

```text
~/.paperclip/
  requirements/<instance-id>/<batch-id>/
    SUMMARY.md
    REQUIREMENT.md
    context.json
    tasks/<task-key>.md
  inbox/<event-id>.json
```

Instance IDs distinguish server data directories. `PAPERCLIP_TASK_POOL_HOME` overrides only the public index root. `PAPERCLIP_HOME` controls normal Paperclip instance data, including `instances/<instance>/task-pool/<batch>/<attempt>/` with `TASK.md`, `base.txt`, `result.json`, the collection marker, and the worktree. Keep this directory and the source repository available to the background server.

Indexes may be stale: always fetch the batch before acting. Deleting an inbox file does not acknowledge or accept anything; synchronization recreates it. Historical notifications indicate when they are superseded. Review capabilities and template credentials are excluded from these indexes.

## Planner skill and API

Install `.agents/skills/paperclip-planner` into the planner's personal skills directory. Its Python client only performs discovery and HTTP calls. Scheduling and OpenCode invocation live in the server.

```sh
python3 /path/to/paperclip-planner/scripts/pool.py discover
python3 /path/to/paperclip-planner/scripts/pool.py GET task-pool/BATCH_ID --url http://127.0.0.1:3112
```

Pass POST bodies on stdin. Use existing `PAPERCLIP_API_KEY` authentication for authenticated deployments. Local trusted mode uses the existing Paperclip board access model.

Create a draft with `POST /api/companies/:companyId/task-pool`:

```json
{
  "title": "Expense summary",
  "requirement": "Use integer cents, normalize category names, aggregate in sorted order. The planner verifies the combined result independently.",
  "repository": "/absolute/server-local/expense-repo",
  "baseRef": "HEAD",
  "templateAgentId": "<same-company OpenCode template UUID>",
  "originSession": "<planner session reference>",
  "concurrency": 2,
  "maxAttempts": 2,
  "tasks": [
    {
      "key": "amounts",
      "title": "Parse monetary strings",
      "instructions": "Implement parse_amount in amounts.py; reject invalid syntax and never round through floating point. Add self-tests.",
      "allowedPaths": ["amounts.py", "test_amounts.py"],
      "acceptance": ["Exact integer cents for arbitrary precision inputs", "Invalid values raise ValueError"],
      "dependsOn": []
    }
  ]
}
```

Task keys are unique; dependencies must exist and be acyclic. Allowed paths are exact files or directory prefixes ending in `/`. Include concrete API behavior, exclusions, dependency contracts and self-test expectations. A downstream task receives all transitive dependency patches. Tasks that edit the same code should be ordered through dependencies. Independent work can run concurrently; Git integration conflicts stop the batch for planner attention.

Use `POST /api/task-pool/:id/actions` for lifecycle operations:

| Action | Behavior |
| --- | --- |
| `publish` | Release an agreed draft for background execution. |
| `pause` | Stop new dispatch; running attempts can finish. |
| `resume` | Resume a pause; do not reset exhausted retry limits. |
| `retry_task` + `taskKey`, `feedback` | Diagnose a blocked task, grant one extra attempt, advance generation and retain all failures. Maximum 10 total attempts per task. |
| `claim_review` + `session` | Claim a ready candidate for 30 minutes; the same owner/session can renew. |
| `accept` + `token`, `candidate`, `evidence` | Accept the exact manifest after independent checks. |
| `rework` + `token`, `candidate`, `feedback`, `tasks` | Append correction tasks with unique keys, advance generation and dispatch again. |

`candidate` is the manifest SHA-256 returned by the server. Old manifests, expired claims and another session's claim cannot accept a new candidate. Rework tasks must explicitly depend on prior work they need. Exhausted tasks use `retry_task`; an integration conflict requires correcting the task plan in a replacement batch in this first version.

Read with `GET /api/task-pool/:id` or `GET /api/companies/:companyId/task-pool`. `POST /api/task-pool/:id/sync` rebuilds discovery files. Mutations require planner task-assignment permission. Pool workers cannot manage the pool, and generic task-card mutations cannot bypass scheduler ownership; comments remain available.

## Background execution and recovery

The existing Paperclip heartbeat scheduler scans published batches. A reservation and dedicated agent are committed before dispatch. Scanners lock batch rows; an existing run for the reserved agent is reused after restart. The scheduler invokes the existing `opencode_local` adapter with the selected template model, or the `process` adapter for deterministic fixtures.

Run the server under an OS service manager such as launchd on macOS, with an absolute runtime path and accessible data/repository paths. A terminal child process is insufficient for conversation-independent operation. On macOS, prefer `~/.paperclip/` to Documents for daemon data because protected-directory permissions can prevent LaunchAgents from starting. The machine must be awake and the server running for scanning to continue.

A successful process must also produce a valid result file and an allowed patch. The supervisor collects one commit per task, then builds a combined candidate. Tests reported by workers are evidence to inspect, not automatic acceptance. This is trusted local execution with post-run scope checks, not an OS sandbox or exactly-once external side effects. A crash may consume an attempt and trigger a fresh attempt within the configured budget.

Notifications are durable inbox records. Optional Codex notification bindings queue messages into an already-running local app-server; they never start a daemon or resume an unloaded thread. The current planner can poll progress; a replacement conversation uses the skill to discover pending work and reconstruct the requirement, DAG, runs and exact candidate without the original transcript.

## Board navigation

The company sidebar exposes **需求** (`/:companyPrefix/requirements`), **任务**, and **执行记录** (`/:companyPrefix/executions`). Requirement details show dependency progress and retained attempts. Execution history can be filtered to active workers; each run opens a focused task view with recent activity, tool inputs/results, delivery notes, and worker-reported tests.

The focused run route is `/:companyPrefix/executions/:runId`. Existing task-pool agent/run links redirect there. The task-boundary disclosure retains an advanced native run link with `?view=manage`; other agents retain their native pages. Process view filters routine round bookkeeping, while raw events remain available for diagnostics. The client retains a bounded log window; full run logs remain server-side.

The board Inbox groups task-pool notifications by requirement. Ready candidates request independent review; blocked work or uncertain execution ownership requests attention. Superseded failed attempts remain in execution history rather than appearing as separate actionable failures. Use planner lifecycle actions to retry pool work; worker delivery and self-tests do not constitute acceptance.

## Verification

`server/src/__tests__/task-pool-service.test.ts` exercises a real embedded PostgreSQL database and Git worktrees: concurrent scanners, dependent patches, pause/resume, bounded and explicit retries, missing/invalid delivery, commit-before-DB recovery, new-session claims, stale manifests and projection rebuild. `task-pool-routes.test.ts` checks tenant isolation, worker permissions and review capability visibility. Live model and forced-server-crash trial evidence is kept outside the repository.

## Planner session notifications

Creation accepts `plannerNotification: { provider: "codex", endpoint: "ws://127.0.0.1:PORT", threadId: "THREAD_UUID" }`. The planner action `bind_planner` takes `notification` with the same shape, or null to unbind. The binding lives in the existing JSON config, so no database migration is required. It does not change review ownership. The planner client can attach this binding using PAPERCLIP_CODEX_NOTIFY_ENDPOINT and CODEX_THREAD_ID.

For current needs_attention or ready_for_review events, projection connects to the existing endpoint, checks thread/loaded/list and invokes thread/queue/add. The native queue starts an idle thread or waits for its active turn. Closing a frontend window is not a delivery gate. Endpoints are restricted to credential-free loopback WebSockets; desktop/Claude transports require separate adapters and are not auto-discovered.

Each event/recipient pair gets one best-effort delivery attempt, recorded under the private instance task-pool/notifications directory and reflected in public Inbox as plannerNotification. Repeated scans, syncs and process restarts reuse that receipt. A claim is written before sending; a crash can lose the live reminder, but durable Inbox is preserved. Offline/unloaded targets are skipped. Unknown outcomes are recorded without automatic retry. A new recipient gets its own attempt for a still-current event; superseded, accepted and ordinary progress events do not notify. Transport operations have a five-second deadline and never wait for model completion. Notification failures do not prevent Inbox projection.

### Native local Codex binding

`endpoint: "local"` (default) supports an existing Codex TUI without a WebSocket listener. Paperclip locates the exact thread rollout under CODEX_HOME/sessions, checks via lsof/ps that a Codex process holds it, then invokes `codex queue --thread UUID --message TEXT`. It never invokes daemon start or resume. Without a running holder it records session_not_running and preserves Inbox. Executable defaults to ~/.local/bin/codex; PAPERCLIP_CODEX_COMMAND can override it. This local adapter currently requires the macOS lsof/ps paths. Exit between the process check and queue write is a race: the resulting message may remain queued until a later resume.

Planner skill defaults to local and auto-binds when CODEX_THREAD_ID is present. Explicit binding works for requirements created with a human-readable originSession. WebSocket targets remain optional; a retained backend thread may continue even after its frontend window closes.

### Planner status changes

`POST /api/task-pool/:id/actions` accepts `{"action":"set_status","status":"closed","reason":"No longer needed"}`. Add `taskKey` to change one child task; omit it to close the requirement and its unfinished tasks. For `superseded`, supply a `replacement` HTTP(S) URL and the reason. The server records actor and time in `state.closure` / `task.closure`, preserves attempts and successful deliveries, and projects native issue cards as cancelled. This operation requires planner management permission, just like publishing. It cannot mark work accepted or reopen terminal work. Active/reserved attempts must finish before closure; pause first to stop new dispatch. Closed dependencies do not count as successful delivery: dependent work remains blocked until the planner closes or replaces the requirement. Closing a requirement disables planner notifications and removes actionable Inbox reminders while retaining historical events.
