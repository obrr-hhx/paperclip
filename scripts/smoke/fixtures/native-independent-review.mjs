// Deterministic agent fixture. The server, not this process, schedules handoffs.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const base = process.env.PAPERCLIP_API_URL;
const headers = { Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID };
async function api(method, route, body, expected = 200) {
  const form = body instanceof FormData;
  const response = await fetch(`${base}/api/${route}`, {
    method, headers: { ...headers, ...(!form && body ? { "Content-Type": "application/json" } : {}) },
    body: body ? form ? body : JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}
const tasks = await api("GET", `companies/${process.env.PAPERCLIP_COMPANY_ID}/issues?assigneeAgentId=${process.env.PAPERCLIP_AGENT_ID}&status=todo,in_progress,in_review`);
assert.equal(tasks.length, 1);
const task = await api("GET", `issues/${tasks[0].id}`);
if (process.argv[2] === "executor") {
  const corrected = task.executionState?.status === "changes_requested";
  const content = JSON.stringify({ sum: corrected ? 5 : 4, inputs: [2, 3] });
  const sha256 = createHash("sha256").update(content).digest("hex");
  const form = new FormData();
  form.set("file", new Blob([content], { type: "application/json" }), "candidate.json");
  const attachment = await api("POST", `companies/${task.companyId}/issues/${task.id}/attachments`, form, 201);
  await api("PATCH", `issues/${task.id}`, {
    status: "in_review", comment: corrected ? "Corrected candidate after rejection" : "First candidate ready",
    reviewRequest: { instructions: "Independently verify sum equals the sum of inputs.", candidate: { attachmentId: attachment.id, sha256 } },
  });
  console.log(corrected ? "resubmitted" : "submitted");
} else {
  const candidate = task.executionState.reviewRequest.candidate;
  const response = await fetch(`${base}/api/attachments/${candidate.attachmentId}/content`, { headers });
  assert.equal(response.status, 200);
  const content = await response.text();
  assert.equal(createHash("sha256").update(content).digest("hex"), candidate.sha256);
  const data = JSON.parse(content);
  if (data.sum !== data.inputs.reduce((a, b) => a + b, 0)) {
    await api("PATCH", `issues/${task.id}`, { status: "in_progress", comment: "Independent check failed: 2 + 3 must be 5, received 4." });
    console.log("requested changes");
  } else {
    // Exercise the guard through authenticated reviewer HTTP calls.
    await api("PATCH", `issues/${task.id}`, { status: "done", comment: "Missing candidate must fail" }, 422);
    await api("PATCH", `issues/${task.id}`, { status: "done", comment: "Stale digest must fail", reviewedCandidate: { ...candidate, sha256: "0".repeat(64) } }, 422);
    await api("PATCH", `issues/${task.id}`, { status: "done", comment: "Independent check passed: 2 + 3 = 5; attachment digest verified.", reviewedCandidate: candidate });
    console.log("approved exact candidate");
  }
}
