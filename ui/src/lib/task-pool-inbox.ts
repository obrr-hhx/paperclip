import type { HeartbeatRun } from "@paperclipai/shared";
import type { TaskPoolBatch } from "../api/taskPool";
export function poolInboxState(batches: TaskPoolBatch[]) {
  const runIds = new Set<string>();
  const issueIds = new Set<string>();
  const notices: {
    batch: TaskPoolBatch;
    kind: "review" | "attention";
    reason: string;
  }[] = [];
  for (const batch of batches) {
    issueIds.add(batch.issueId);
    for (const task of batch.state.tasks) {
      issueIds.add(task.issueId);
      for (const attempt of task.attempts)
        if (attempt.runId) runIds.add(attempt.runId);
    }
    if (["accepted", "closed", "superseded"].includes(batch.state.status))
      continue;
    if (batch.state.status === "ready_for_review") {
      notices.push({
        batch,
        kind: "review",
        reason: "所有任务已交付，需要规划者独立验收。",
      });
      continue;
    }
    const blocked = batch.state.tasks.find((t) => t.status === "blocked");
    const uncertain = batch.state.tasks.find((t) => {
      const attempt = t.attempts.at(-1) as
        | { lease?: { recoveryError?: string }; error?: string }
        | undefined;
      return (
        t.status === "running" &&
        (attempt?.lease?.recoveryError || attempt?.error)
      );
    });
    if (batch.state.status === "needs_attention" || blocked || uncertain) {
      notices.push({
        batch,
        kind: "attention",
        reason: uncertain
          ? `${uncertain.title}：执行状态需要核实，确认旧执行停止前不要重试。`
          : blocked
            ? `${blocked.title}：已受阻，需要诊断并决定是否重试。`
            : "需求交付或集成受阻，需要规划者处理。",
      });
    }
  }
  return { notices, issueIds, runIds };
}
export function isPoolInboxRun(
  run: { id: string; contextSnapshot?: HeartbeatRun["contextSnapshot"] },
  runIds: Set<string>,
) {
  return (
    runIds.has(run.id) ||
    typeof run.contextSnapshot?.taskPoolBatchId === "string"
  );
}
