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
- optional projectId, originSession, concurrency (1–4), maxAttempts (1–3)
- tasks: key, title, instructions, allowedPaths, acceptance[], dependsOn[]

Allowed paths are exact files or directory prefixes ending in `/`. Each task must be independently executable. Dependencies are structural keys, not prose. Downstream tasks receive the transitive dependency commits in their worktree. Tell workers what to self-test, but do not equate their self-reports with acceptance.

Publish the whole draft with `POST /task-pool/:id/actions` and `{"action":"publish"}` only when it matches the user's agreed execution scope. No extra human confirmation is required for already-authorized work. Paperclip starts and records workers. Do not invoke them yourself or duplicate scheduling with confirmation interactions.

## Progress and interventions

`GET /task-pool/:id` returns current state. `POST /task-pool/:id/sync` rebuilds public files. `pause` stops new dispatch; running work may finish. `resume` releases a pause, but does not reset exhausted retry budgets. For an exhausted task, use `{"action":"retry_task","taskKey":"...","feedback":"concrete corrective direction"}`. This explicitly grants one additional attempt, advances the requirement generation, and preserves all prior attempts. Do not loop this action automatically; diagnose the blocker first.

Task cards and native agent/run pages retain execution history. Pool card status is server-maintained; comments are allowed, generic task checkout/status updates are rejected. Worker success means delivery and self-tests only.

## Independent acceptance

For `ready_for_review`, obtain a claim with `{"action":"claim_review","session":"<current conversation identifier>"}`. Claims expire after 30 minutes; renew with the same action. Another session can take over an expired claim. A read notification is not an acknowledgement or a verdict.

Read the candidate's manifest and commit. Use an independent review worktree at that exact commit; do not test an unrelated or mutable checkout. Reconstruct tools, skills and project instructions in the new conversation. Inspect task scope, combined diff, and run the agreed independent checks.

When using `scripts/pool.py`, supply `session` instead of `token` in an accept/rework body: the client renews the claim and submits the verdict with the capability held only in memory. It redacts claim capabilities from output. Direct API clients must handle claim tokens in memory as well.

Accept using `{"action":"accept","token":"<claim token>","candidate":"<manifest sha256>","evidence":"actual checks and results"}`. This approves the candidate, not a merge or deployment; merge authority remains with the user.

For defects, use `{"action":"rework","token":"<claim token>","candidate":"<manifest sha256>","feedback":"concrete failures","tasks":[...]}`. New task keys must be unique. Explicitly depend on the relevant previous tasks to inherit their code. This creates a new generation and leaves previous execution evidence intact. A prior candidate verdict cannot accept the new generation.

Notifications are durable local projections, not proof that a Codex/Claude conversation has been woken. This version does not auto-resume a closed conversation. At the next relevant conversation, discover pending requirements and take over explicitly.
