import { describe, expect, it, vi } from "vitest";
vi.mock("../utils.js", async (original) => ({
  ...await original<typeof import("../utils.js")>(),
  runChildProcess: vi.fn(),
}));
import { runChildProcess } from "../utils.js";
import { execute } from "./execute.js";
import { legacyAdapterOutcome } from "../../services/heartbeat-run-outcome.js";

describe("process adapter signal termination", () => {
  it.each(["SIGKILL", "SIGTERM"])("reports %s and a failed heartbeat outcome", async (signal) => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: null, signal, timedOut: false, stdout: "partial output", stderr: "", pid: 123, startedAt: new Date().toISOString(),
    });
    const result = await execute({
      runId: "run", agent: { id: "agent", companyId: "company", name: "worker", adapterType: "process", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, context: {},
      config: { command: process.execPath }, onLog: async () => {},
    });
    expect(result.signal).toBe(signal);
    expect(result.errorMessage).toContain(signal);
    expect(result.resultJson?.stdout).toBe("partial output");
    expect(legacyAdapterOutcome(result)).toBe("failed");
  });
});
