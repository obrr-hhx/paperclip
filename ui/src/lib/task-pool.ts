import type { PoolTask, PoolState } from "@paperclipai/shared";
import type { TaskPoolBatch } from "../api/taskPool";
import type { RunLogChunk } from "../adapters/transcript";

export const poolStatusLabels: Record<PoolState["status"], string> = {
  draft: "草稿 · 尚未发布",
  active: "执行中",
  paused: "已暂停",
  needs_attention: "需要处理",
  ready_for_review: "等待验收",
  accepted: "已验收",
  closed: "已关闭",
  superseded: "已替代",
};
export const taskStatusLabels: Record<PoolTask["status"], string> = {
  pending: "等待执行",
  running: "执行中",
  succeeded: "已交付",
  blocked: "受阻",
  closed: "已关闭",
  superseded: "已替代",
};
export function taskWaitReason(task: PoolTask, batch: TaskPoolBatch) {
  if (task.status !== "pending") return null;
  if (batch.state.status === "draft") return "需求尚未发布，不会启动 worker";
  const waiting = task.dependsOn.filter(
    (key) =>
      batch.state.tasks.find((t) => t.key === key)?.status !== "succeeded",
  );
  if (waiting.length) return `等待依赖：${waiting.join("、")}`;
  if (batch.state.status === "paused") return "需求已暂停";
  if (batch.state.status === "needs_attention") return "等待规划者处理阻塞";
  return "依赖已满足，等待调度名额";
}
export function poolExecutions(batches: TaskPoolBatch[]) {
  return batches
    .flatMap((batch) =>
      batch.state.tasks.flatMap((task) =>
        task.attempts.map((attempt, index) => ({
          batch,
          task,
          attempt,
          number: index + 1,
        })),
      ),
    )
    .sort(
      (a, b) =>
        Number(["running", "reserved"].includes(b.attempt.status)) -
          Number(["running", "reserved"].includes(a.attempt.status)) ||
        Date.parse(b.attempt.startedAt) - Date.parse(a.attempt.startedAt),
    );
}
export function appendPoolLog(
  previous: string,
  content: string,
): { rows: RunLogChunk[]; remainder: string } {
  const lines = (previous + content).split("\n");
  const remainder = lines.pop() ?? "";
  const rows: RunLogChunk[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (
        ["stdout", "stderr", "system"].includes(row.stream) &&
        typeof row.chunk === "string" &&
        typeof row.ts === "string"
      )
        rows.push(row);
    } catch {
      /* Incomplete or invalid transport rows are not executable UI content. */
    }
  }
  return { rows, remainder };
}
