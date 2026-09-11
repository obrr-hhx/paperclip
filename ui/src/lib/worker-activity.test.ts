import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../adapters";
import { workerActivities, workerToolLabel } from "./worker-activity";
describe("worker activity", () => {
  it("merges repeated tool updates with their result and preserves failed output", () => {
    const call: TranscriptEntry = {
      kind: "tool_call",
      ts: "now",
      name: "bash",
      toolUseId: "one",
      input: { command: "pnpm test" },
    };
    const items = workerActivities([
      call,
      call,
      {
        kind: "tool_result",
        ts: "later",
        toolUseId: "one",
        content: "test failed",
        isError: true,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].result?.isError).toBe(true);
    expect(items[0].result?.content).toBe("test failed");
  });
  it("removes round bookkeeping while retaining assistant updates and errors", () => {
    const entries: TranscriptEntry[] = [
      { kind: "system", ts: "now", text: "step started (session)" },
      {
        kind: "result",
        ts: "now",
        text: "tool-calls",
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "tool-calls",
        isError: false,
        errors: [],
      },
      { kind: "assistant", ts: "now", text: "Fixing permission checks" },
      { kind: "stderr", ts: "now", text: "permission denied" },
    ];
    expect(workerActivities(entries).map((i) => i.entry.kind)).toEqual([
      "assistant",
      "stderr",
    ]);
  });
  it("shows concrete file paths and commands without inventing progress", () => {
    expect(
      workerToolLabel({
        kind: "tool_call",
        ts: "now",
        name: "read",
        input: { filePath: "src/api.ts" },
      }),
    ).toBe("读取 · src/api.ts");
    expect(
      workerToolLabel({
        kind: "tool_call",
        ts: "now",
        name: "bash",
        input: { command: "go test ./..." },
      }),
    ).toBe("执行命令 · go test ./...");
    expect(
      workerActivities([
        {
          kind: "tool_result",
          ts: "now",
          toolUseId: "missing",
          content: "orphan output",
          isError: false,
        },
      ])[0].entry.kind,
    ).toBe("tool_result");
  });
});
