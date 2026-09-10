# Durable task pool

Approved flow: planner session writes a requirement and a published DAG; Paperclip scans and starts OpenCode workers; execution history stays in the existing agent/run UI; completed batches wait for the planner (including a replacement session) to verify. No automatic reviewer model.

Implementation: versioned batch aggregate in PostgreSQL, native issues as visible task cards, a fresh agent/run/worktree for each attempt, durable reservations before launch, bounded retries, exact Git candidate manifests, and regenerable public requirement/inbox files under ~/.paperclip. Pool workers are excluded from unrelated wake sources. Public files contain no credentials. Native HTTP API operations own publication, pause, takeover and verdicts.

Validation: DAG and scope rules; concurrent scans; delayed/failed processes; restart after reservation/launch; dependency handoff and integration conflicts; new-session review claim, expired claims and stale candidates; public projection rebuild; real OpenCode/DeepSeek tasks with independent planner verification.
