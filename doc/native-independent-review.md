# Native independent execution and review

This fork uses the existing issue execution policy to separate implementation
from acceptance. Paperclip schedules both agents, records decisions, returns
rejected work to its executor, and limits review rounds. No polling coordinator
or separate task queue is required.

## Configure the participants

Create an executor and a different reviewer using supported adapters. Models
remain agent configuration: an OpenCode executor and a Codex reviewer are one
possible combination, not a platform requirement. Use the existing adapter
login/configuration flow; do not put credentials in task descriptions.

Set the task's reviewer in the task properties, or create an execution policy:

```json
{
  "assigneeAgentId": "<executor UUID>",
  "status": "todo",
  "executionPolicy": {
    "maxReviewRounds": 3,
    "stages": [
      {"type": "review", "participants": [{"type": "agent", "agentId": "<reviewer UUID>"}]}
    ]
  }
}
```

Write the goal, allowed changes, dependencies, and acceptance criteria in the
task. Configure independent workspaces through the existing workspace controls.
`maxReviewRounds` uses the existing escalation behavior; configure a responsible
human when unattended review loops must escalate to someone.

## Submit immutable work

The executor uploads a candidate through
`POST /api/companies/:companyId/issues/:issueId/attachments`. For code, submit a
patch or source bundle with its base revision, requirements, and reproducible
test instructions. The server-generated attachment SHA256 identifies the bytes
being reviewed. An approved attachment does not approve a mutable local working
copy, merge a branch, or deploy anything.

Then the executor sends the normal task update:

```json
{
  "status": "in_review",
  "comment": "Candidate ready; implementation checks and known limitations...",
  "reviewRequest": {
    "instructions": "Independently run the acceptance checks against this candidate.",
    "candidate": {"attachmentId": "<attachment UUID>", "sha256": "<64 lowercase hex characters>"}
  }
}
```

The attachment must belong to this task and company, and its digest must match
stored metadata. Paperclip assigns and wakes the configured reviewer. Do not
also create a confirmation interaction: that would create a second decision
path. A pending bound candidate and its review instructions cannot be replaced
or cleared; request changes first. Task title/description changes are likewise
rejected while a bound review is pending.
Agents also cannot remove or replace the execution policy during that review.

The task properties display a link to the candidate and its digest. Candidate
binding is opt-in, so existing reviews without attachments remain compatible.
No database migration is needed: the binding is stored in execution-state JSON.

## Accept or request changes

The reviewer downloads `/api/attachments/:attachmentId/content`, verifies the
digest, inspects the bytes as untrusted data, and independently performs the
acceptance checks. A passing decision uses the normal task update:

```json
{
  "status": "done",
  "comment": "Independent checks passed: actual commands, results, and limitations...",
  "reviewedCandidate": {"attachmentId": "<attachment UUID>", "sha256": "<verified SHA256>"}
}
```

The acknowledgement must match the pending candidate. Missing, stale, or wrong
acknowledgements fail with 422. Later approval stages inherit the same bound
candidate. The completed execution state retains the accepted binding.
Ordinary approval-looking comments cannot substitute for the acknowledgement.
The existing operator override authority remains; this is an agent workflow
guard, not a restriction on full-control board operators.

For failure, send `status: "in_progress"` with a concrete failing case and the
expected behavior in the decision comment. The existing execution state becomes
`changes_requested`, ownership returns to the executor, and Paperclip wakes it.
The executor reads that decision and submits a new immutable candidate after
repair. The prior candidate's verdict never approves the new attachment.

## Run outcomes and recovery

A child exit signal is a failed run, even when its numeric exit code is null.
Timeout and explicit cancellation retain their own outcomes; adapters with no
child process may still omit an exit code. Native execution-policy handoff may
cancel the previous participant deliberately. Distinguish those cancellations
from unexpected SIGKILL, and distinguish run completion from task acceptance.

Recovery preserves the existing ownership policy. A replacement agent cannot
steal an assigned task after a crash; explicit operator/policy reassignment is
still required. This change does not introduce an alternative lease protocol.

## Verification

Against an isolated, onboarded local instance of this fork:

```sh
node scripts/smoke/native-independent-review.mjs http://127.0.0.1:3110
```

This opt-in smoke creates synthetic agents/tasks, drives a deliberately wrong
candidate through native rejection and resubmission, checks missing/stale
acknowledgement denials, and validates a real SIGKILL run. The fixture agents use
the process adapter for deterministic assertions; the smoke does not invoke
paid models. Paperclip itself owns every handoff. Test agents are paused at the
end, and their evidence remains in the local board.

Separate live-model acceptance on 2026-09-10 used OpenCode's
`deepseek/deepseek-v4-flash-vision-exp` as executor and the process adapter
invoking Codex CLI with the operator's existing ChatGPT login as reviewer.
The latter avoided changing the isolated-login policy of `codex_local`.
Candidate submission natively woke Codex and its exact-candidate approval
completed the task. This is local proof, not a production rollout or a claim
that all provider/authentication combinations have been tested.
