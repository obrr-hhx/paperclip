import { describe, expect, it } from "vitest";
import type { TaskPoolBatch } from "../api/taskPool";
import { isPoolInboxRun, poolInboxState } from "./task-pool-inbox";
const fixture = (): TaskPoolBatch => ({
  id: "batch",
  companyId: "company",
  issueId: "parent",
  createdAt: "",
  updatedAt: "",
  config: {
    title: "Requirement",
    requirement: "spec",
    repository: "/repo",
    baseSha: "sha",
    concurrency: 1,
  },
  state: {
    status: "active",
    generation: 1,
    events: [],
    tasks: [
      {
        key: "task",
        issueId: "child",
        title: "Task",
        instructions: "work",
        allowedPaths: ["src"],
        acceptance: ["test"],
        dependsOn: [],
        status: "running",
        attempts: [
          {
            id: "one",
            runId: "old-run",
            agentId: "old-worker",
            cwd: "/old",
            startedAt: "",
            status: "failed",
            error: "timeout",
          },
          {
            id: "two",
            runId: "new-run",
            agentId: "new-worker",
            cwd: "/new",
            startedAt: "",
            status: "running",
          },
        ],
      },
    ],
  },
});
describe("requirement inbox", () => {
  it.each(["closed", "superseded"] as const)(
    "hides %s requirements while preserving trace membership",
    (status) => {
      const batch = fixture();
      batch.state.status = status;
      batch.state.tasks[0].status = "blocked";
      const result = poolInboxState([batch]);
      expect(result.notices).toEqual([]);
      expect(result.runIds.has("old-run")).toBe(true);
    },
  );
  it("hides superseded failures during retry and after acceptance without losing run membership", () => {
    const batch = fixture();
    expect(poolInboxState([batch]).notices).toEqual([]);
    batch.state.status = "accepted";
    const state = poolInboxState([batch]);
    expect(state.notices).toEqual([]);
    expect(state.runIds.has("old-run")).toBe(true);
    expect(state.issueIds).toEqual(new Set(["parent", "child"]));
  });
  it("emits one actionable notice per requirement for exhaustion and independent review", () => {
    const batch = fixture();
    batch.state.status = "needs_attention";
    batch.state.tasks[0].status = "blocked";
    expect(poolInboxState([batch]).notices.map((n) => n.kind)).toEqual([
      "attention",
    ]);
    batch.state.status = "ready_for_review";
    batch.state.tasks[0].status = "succeeded";
    expect(poolInboxState([batch]).notices.map((n) => n.kind)).toEqual([
      "review",
    ]);
    batch.state.status = "accepted";
    expect(poolInboxState([batch]).notices).toEqual([]);
  });
  it("surfaces unverified ownership even while the batch remains active, and clears on renewal", () => {
    const batch = fixture();
    const attempt = batch.state.tasks[0].attempts[1];
    Object.assign(attempt, { lease: { recoveryError: "stop unverified" } });
    expect(poolInboxState([batch]).notices[0].reason).toContain("旧执行停止");
    Object.assign(attempt, { lease: { renewedAt: "now" } });
    expect(poolInboxState([batch]).notices).toEqual([]);
  });
  it("keeps normal agent failures and recognizes pool provenance before batch loading", () => {
    expect(isPoolInboxRun({ id: "normal" }, new Set())).toBe(false);
    expect(
      isPoolInboxRun(
        {
          id: "pool",
          contextSnapshot: { taskPoolBatchId: "batch" },
        },
        new Set(),
      ),
    ).toBe(true);
    expect(
      isPoolInboxRun({ id: "old-run" }, poolInboxState([fixture()]).runIds),
    ).toBe(true);
  });
});
