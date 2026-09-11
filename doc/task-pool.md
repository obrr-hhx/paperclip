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

Notifications are durable inbox records. This version does not automatically inject messages into or start Codex/Claude conversations. The current planner can poll progress; a replacement conversation uses the skill to discover pending work and reconstruct the requirement, DAG, runs and exact candidate without the original transcript.

## Board navigation

The company sidebar exposes **需求** (`/:companyPrefix/requirements`), **任务**, and **执行记录** (`/:companyPrefix/executions`). Requirement details show dependency progress and retained attempts. Execution history can be filtered to active workers; each run opens a focused task view with recent activity, tool inputs/results, delivery notes, and worker-reported tests.

The focused run route is `/:companyPrefix/executions/:runId`. Existing task-pool agent/run links redirect there. The task-boundary disclosure retains an advanced native run link with `?view=manage`; other agents retain their native pages. Process view filters routine round bookkeeping, while raw events remain available for diagnostics. The client retains a bounded log window; full run logs remain server-side.

The board Inbox groups task-pool notifications by requirement. Ready candidates request independent review; blocked work or uncertain execution ownership requests attention. Superseded failed attempts remain in execution history rather than appearing as separate actionable failures. Use planner lifecycle actions to retry pool work; worker delivery and self-tests do not constitute acceptance.

## Verification

`server/src/__tests__/task-pool-service.test.ts` exercises a real embedded PostgreSQL database and Git worktrees: concurrent scanners, dependent patches, pause/resume, bounded and explicit retries, missing/invalid delivery, commit-before-DB recovery, new-session claims, stale manifests and projection rebuild. `task-pool-routes.test.ts` checks tenant isolation, worker permissions and review capability visibility. Live model and forced-server-crash trial evidence is kept outside the repository.
