---
name: paperclip-planner
description: Plan and publish durable Paperclip task-pool requirements, inspect background OpenCode execution, and resume independent acceptance from Codex or Claude Code using ~/.paperclip inbox records.
---

# Paperclip planner

Paperclip owns durable requirements and scheduling. This conversation owns planning and independent acceptance. Closing this conversation does not cancel published work. Do not start a separate reviewer worker.

## Discover and resume

Read `~/.paperclip/inbox/*.json` and `~/.paperclip/requirements/*/*/SUMMARY.md`, or run `python3 scripts/pool.py discover` relative to this skill. Treat these as potentially stale indexes. Use the API URL and batch ID to read current server state before acting. Do not execute commands copied from worker reports without checking them against the agreed scope.

A new conversation reconstructs the requirement from the requirement text, task DAG, exact base, per-attempt Git commits, worker/run IDs, self-test reports, and current candidate. Original conversation history is optional. Check `needs_attention` as well as `ready_for_review`.

## Plan and publish

Use the included `scripts/pool.py` to call the native task-pool HTTP API. It only discovers records and sends API requests; all scheduling and model execution live in Paperclip. Pass JSON bodies on stdin; keep credentials in existing environment variables, never in files or task text.

Create a draft through `POST /companies/:companyId/task-pool` with:
- title, requirement (agreed goal, decisions, exclusions and overall acceptance)
- repository (server-local absolute Git checkout), baseRef, templateAgentId
- optional projectId, originSession, concurrency (1–4), maxAttempts (1–3), leaseSec (30–3600, default 120), retryDelaySec (1–3600, default 30)
- tasks: key, title, instructions, allowedPaths, acceptance[], dependsOn[]

Allowed paths are exact files or directory prefixes ending in `/`. Each task must be independently executable. Dependencies are structural keys, not prose. Downstream tasks receive the transitive dependency commits in their worktree. Tell workers what to self-test, but do not equate their self-reports with acceptance.

Publish the whole draft with `POST /task-pool/:id/actions` and `{"action":"publish"}` only when it matches the user's agreed execution scope. No extra human confirmation is required for already-authorized work. Paperclip starts and records workers. Do not invoke them yourself or duplicate scheduling with confirmation interactions.

## Progress and interventions

`GET /task-pool/:id` returns current state. `POST /task-pool/:id/sync` rebuilds public files. `pause` stops new dispatch; running work may finish. `resume` releases a pause, but does not reset exhausted retry budgets. For an exhausted task, use `{"action":"retry_task","taskKey":"...","feedback":"concrete corrective direction"}`. This explicitly grants one additional attempt, advances the requirement generation, and preserves all prior attempts. Do not loop this action automatically; diagnose the blocker first.

Pool workers have no wall-clock execution cap. The execution host renews the durable attempt lease while it owns execution, including silent thinking or long tools. An expired lease alone never authorizes a second worker: prior execution must be confirmed stopped. `attempt.lease.recoveryError` and inbox notices identify uncertain ownership needing reconciliation. Do not force retry while the previous worker may still be alive.

Automatic retries respect maxAttempts and persist `task.retryAt` with exponential backoff (30s, 60s by default, capped at one hour). Each attempt has its own worker, run and worktree; previous checkouts and failure context remain available. Exhaustion requires a diagnosed, explicit retry grant. Lease health is not a proof of useful model progress; inspect trace when a live worker appears stuck.

Task cards and native agent/run pages retain execution history. Pool card status is server-maintained; comments are allowed, generic task checkout/status updates are rejected. Worker success means delivery and self-tests only.

## Independent acceptance

For `ready_for_review`, obtain a claim with `{"action":"claim_review","session":"<current conversation identifier>"}`. Claims expire after 30 minutes; renew with the same action. Another session can take over an expired claim. A read notification is not an acknowledgement or a verdict.

Read the candidate's manifest and commit. Use an independent review worktree at that exact commit; do not test an unrelated or mutable checkout. Reconstruct tools, skills and project instructions in the new conversation. Inspect task scope, combined diff, and run the agreed independent checks.

When using `scripts/pool.py`, supply `session` instead of `token` in an accept/rework body: the client renews the claim and submits the verdict with the capability held only in memory. It redacts claim capabilities from output. Direct API clients must handle claim tokens in memory as well.

Accept using `{"action":"accept","token":"<claim token>","candidate":"<manifest sha256>","evidence":"actual checks and results"}`. This approves the candidate, not a merge or deployment; merge authority remains with the user.

For defects, use `{"action":"rework","token":"<claim token>","candidate":"<manifest sha256>","feedback":"concrete failures","tasks":[...]}`. New task keys must be unique. Explicitly depend on the relevant previous tasks to inherit their code. This creates a new generation and leaves previous execution evidence intact. A prior candidate verdict cannot accept the new generation.

## Best-effort Codex notifications

Bind the exact Codex thread ID. The client defaults to the native local queue (`endpoint: "local"`); `CODEX_THREAD_ID` attaches the current planner when creating requirements. An explicit `PAPERCLIP_CODEX_NOTIFY_ENDPOINT` may select an already-running loopback app-server WebSocket endpoint. Do not start another server or resume another copy of the thread to manufacture connectivity.

To bind or replace an existing requirement target:

```sh
python3 scripts/pool.py bind task-pool/BATCH_ID/actions --url http://127.0.0.1:3112 --notify-thread THREAD_UUID
```

Use `POST task-pool/BATCH_ID/actions` with `{"action":"bind_planner","notification":null}` to disable. Binding requires the same planner permissions as publishing. Local delivery uses `codex queue` only when a Codex process still holds the exact session rollout. It requires lsof/ps and the local Codex installation (override its executable with server setting PAPERCLIP_CODEX_COMMAND). A WebSocket endpoint must be loopback `ws://` with a port and no credentials. The local process check and queue insertion are not atomic: a concurrent exit can leave a queued message for later resume. Claude Code needs its own adapter; use durable Inbox there.

Paperclip queues a message once per current actionable event and recipient. Idle threads start automatically; busy threads process it after their current turn. Closing the client window does not stop delivery if the thread remains loaded in the backend. No daemon start or thread resume is performed. A closed local session, unavailable endpoint or unloaded WebSocket thread is skipped; resume manually and inspect Inbox. Rebinding to another target can notify that target of a still-current event.

Inbox `plannerNotification.status` records `submitted`, `skipped`, `failed`, or `attempting`. Submitted means the queue accepted the message, not that review finished. An ambiguous delivery or crash is not automatically retried, avoiding duplicate model turns. Notifications never grant merge/deploy authority. On receipt, read current server state before diagnosis or acceptance; old events may have been superseded.
