import { describe, expect, it } from "vitest";
import type { TaskPoolBatch } from "../api/taskPool";
import { appendPoolLog, poolExecutions, taskWaitReason } from "./task-pool";
import { applyCompanyPrefix, toCompanyRelativePath } from "./company-routes";
const task = {
  key: "next",
  title: "Next",
  instructions: "Implement",
  allowedPaths: ["src"],
  acceptance: ["Tests pass"],
  dependsOn: ["first"],
  issueId: "issue",
  status: "pending" as const,
  attempts: [],
};
const batch: TaskPoolBatch = {
  id: "batch",
  companyId: "company",
  issueId: "parent",
  config: {
    title: "Requirement",
    requirement: "Spec",
    repository: "/repo",
    baseSha: "sha",
    concurrency: 2,
  },
  state: {
    generation: 1,
    status: "active",
    tasks: [{ ...task, key: "first", dependsOn: [] }, task],
    events: [],
  },
  createdAt: "",
  updatedAt: "",
};
describe("task pool navigation and execution", () => {
  it("keeps deep links and attempt selection in the selected company", () => {
    for (const path of [
      "/requirements",
      "/requirements/batch?attempt=one",
      "/executions",
    ]) {
      expect(applyCompanyPrefix(path, "DUR")).toBe(`/DUR${path}`);
      expect(toCompanyRelativePath(`/DUR${path}`)).toBe(path);
    }
  });
  it("distinguishes unpublished tasks, unfinished dependencies and scheduler waiting", () => {
    expect(
      taskWaitReason(task, {
        ...batch,
        state: { ...batch.state, status: "draft" },
      }),
    ).toContain("尚未发布");
    expect(taskWaitReason(task, batch)).toBe("等待依赖：first");
    expect(
      taskWaitReason(task, {
        ...batch,
        state: {
          ...batch.state,
          tasks: [{ ...task, key: "first", status: "succeeded" }],
        },
      }),
    ).toContain("等待调度名额");
    expect(taskWaitReason({ ...task, status: "running" }, batch)).toBeNull();
  });
  it("puts active attempts before newer historical results without discarding retries", () => {
    const old = {
      id: "old",
      agentId: "a",
      cwd: "/tmp",
      startedAt: "2026-09-10",
      status: "running" as const,
    };
    const latest = {
      ...old,
      id: "latest",
      startedAt: "2026-09-11",
      status: "failed" as const,
    };
    const rows = poolExecutions([
      {
        ...batch,
        state: {
          ...batch.state,
          tasks: [{ ...task, attempts: [old, latest] }],
        },
      },
    ]);
    expect(rows.map((row) => [row.attempt.id, row.number])).toEqual([
      ["old", 1],
      ["latest", 2],
    ]);
  });
  it("reassembles transport records split across reads and skips malformed events", () => {
    const row = { ts: "2026-09-11", stream: "stdout", chunk: "工具输出\n" };
    const encoded = JSON.stringify(row) + "\n";
    const first = appendPoolLog("", encoded.slice(0, 23));
    expect(first.rows).toEqual([]);
    const second = appendPoolLog(
      first.remainder,
      encoded.slice(23) + "bad\n" + JSON.stringify({ stream: "stdout" }) + "\n",
    );
    expect(second.rows).toEqual([row]);
    expect(second.remainder).toBe("");
  });
});
