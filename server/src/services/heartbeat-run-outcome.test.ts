import { describe, expect, it } from "vitest";
import { legacyAdapterOutcome } from "./heartbeat-run-outcome.js";

describe("legacy adapter process outcome", () => {
  it.each(["SIGKILL", "SIGTERM", "SIGSEGV"])("does not report %s as success", (signal) => {
    expect(legacyAdapterOutcome({ exitCode: null, signal })).toBe("failed");
    expect(legacyAdapterOutcome({ exitCode: 0, signal })).toBe("failed");
  });
  it("preserves timeout precedence", () => {
    expect(legacyAdapterOutcome({ timedOut: true, signal: "SIGKILL", exitCode: null })).toBe("timed_out");
  });
  it("handles normal exits and adapters without a child process", () => {
    expect(legacyAdapterOutcome({ exitCode: 0 })).toBe("succeeded");
    expect(legacyAdapterOutcome({})).toBe("succeeded");
    expect(legacyAdapterOutcome({ exitCode: 1 })).toBe("failed");
    expect(legacyAdapterOutcome({ exitCode: 0, errorMessage: "provider failure" })).toBe("failed");
  });
});
