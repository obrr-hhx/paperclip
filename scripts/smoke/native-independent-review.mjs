// Opt-in live-server smoke test. Creates only synthetic data in a local instance.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const base = process.argv[2] ?? "http://127.0.0.1:3110";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Use an isolated local instance");
const fixture = fileURLToPath(new URL("./fixtures/native-independent-review.mjs", import.meta.url));
async function api(method, route, body) {
  const response = await fetch(`${base}/api/${route}`, { method,
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function until(read, accept, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read(); if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for native workflow");
}
const company = await api("POST", "companies", { name: "Native independent review smoke" });
const agents = [];
try {
  async function agent(name, args) {
    const value = await api("POST", `companies/${company.id}/agents`, {
      name, adapterType: "process", adapterConfig: { command: process.execPath, args,
        cwd: process.cwd(), timeoutSec: 45, env: { PAPERCLIP_API_URL: base } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    });
    agents.push(value.id); return value;
  }
  const executor = await agent("Executor", [fixture, "executor"]);
  const reviewer = await agent("Independent reviewer", [fixture, "reviewer"]);
  const issue = await api("POST", `companies/${company.id}/issues`, {
    title: "Native submit → reject → rework → approve", status: "todo", assigneeAgentId: executor.id,
    executionPolicy: { maxReviewRounds: 3, stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] },
  });
  const done = await until(() => api("GET", `issues/${issue.id}`), (value) => value.status === "done");
  assert.equal(done.executionState.status, "completed");
  assert.equal(done.executionState.lastDecisionOutcome, "approved");
  assert.ok(done.executionState.reviewRequest.candidate.sha256);
  await until(() => api("GET", `companies/${company.id}/heartbeat-runs`), (runs) => runs.every((r) => !["running", "queued"].includes(r.status)));
  const runs = await api("GET", `companies/${company.id}/heartbeat-runs`);
  assert.equal(runs.filter((r) => r.agentId === executor.id).length, 2);
  assert.equal(runs.filter((r) => r.agentId === reviewer.id).length, 2);
  // Ownership transfer deliberately interrupts the previous participant.
  assert.ok(runs.every((r) => ["succeeded", "cancelled"].includes(r.status) && !r.errorMessage));
  assert.ok(runs.some((r) => r.agentId === reviewer.id && r.status === "succeeded"));
  const crash = await agent("Crash fixture", ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  const invocation = await api("POST", `agents/${crash.id}/heartbeat/invoke`, {});
  const terminal = await until(() => api("GET", `heartbeat-runs/${invocation.id}`), (r) => !["running", "queued"].includes(r.status));
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.signal, "SIGKILL");
  console.log(JSON.stringify({ companyId: company.id, issueId: issue.id, identifier: issue.identifier,
    status: done.status, runs: runs.map((r) => ({ id: r.id, agentId: r.agentId, status: r.status })),
    candidate: done.executionState.reviewRequest.candidate, crashRunId: terminal.id, crashStatus: terminal.status }, null, 2));
} finally {
  for (const id of agents) await api("POST", `agents/${id}/pause`, {});
}
