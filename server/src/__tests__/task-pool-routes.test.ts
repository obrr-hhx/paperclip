import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), action: vi.fn(), canUser: vi.fn(), hasPermission: vi.fn(), getAgent: vi.fn() }));
vi.mock("../services/task-pool.js", () => ({ taskPoolService: () => mocks }));
vi.mock("../services/access.js", () => ({ accessService: () => mocks }));
vi.mock("../services/agents.js", () => ({ agentService: () => ({ getById: mocks.getAgent }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
import { taskPoolRoutes } from "../routes/task-pool.js";
import { errorHandler } from "../middleware/error-handler.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const token = "33333333-3333-4333-8333-333333333333";
function app(actor: express.Request["actor"]) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use(taskPoolRoutes({} as never)); server.use(errorHandler); return server;
}
describe("task pool authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const batch = { id, companyId, issueId: id, state: { generation: 1, review: { token } } };
    mocks.get.mockResolvedValue(batch); mocks.action.mockResolvedValue(batch);
  });
  it("does not expose review claims through reads", async () => {
    const response = await request(app({ type: "board", source: "local_implicit", userId: "local" })).get(`/task-pool/${id}`);
    expect(response.status).toBe(200); expect(response.text).not.toContain(token);
  });
  it("hides another company's batch", async () => {
    const response = await request(app({ type: "agent", agentId: id, companyId: "other" })).get(`/task-pool/${id}`);
    expect(response.status).toBe(404);
  });
  it("denies worker management even if assignment permission is granted", async () => {
    mocks.getAgent.mockResolvedValue({ metadata: { taskPoolAttemptId: id } }); mocks.hasPermission.mockResolvedValue(true);
    const response = await request(app({ type: "agent", agentId: id, companyId })).post(`/task-pool/${id}/actions`).send({ action: "publish" });
    expect(response.status).toBe(403); expect(mocks.action).not.toHaveBeenCalled();
  });
  it("does not let pool workers redirect planner notifications", async () => {
    mocks.getAgent.mockResolvedValue({ metadata: { taskPoolAttemptId: id } }); mocks.hasPermission.mockResolvedValue(true);
    const response = await request(app({ type: "agent", agentId: id, companyId })).post(`/task-pool/${id}/actions`)
      .send({ action: "bind_planner", notification: { provider: "codex", threadId: id, endpoint: "ws://127.0.0.1:39281" } });
    expect(response.status).toBe(403); expect(mocks.action).not.toHaveBeenCalled();
  });
  it("allows the local planner to claim review and receive its capability", async () => {
    const response = await request(app({ type: "board", source: "local_implicit", userId: "local" })).post(`/task-pool/${id}/actions`).send({ action: "claim_review", session: "replacement" });
    expect(response.status).toBe(200); expect(response.body.state.review.token).toBe(token);
  });
  it("denies an authenticated member without assignment permission", async () => {
    mocks.canUser.mockResolvedValue(false);
    const response = await request(app({ type: "board", source: "session", userId: "member", companyIds: [companyId] } as never)).post(`/task-pool/${id}/actions`).send({ action: "publish" });
    expect(response.status).toBe(403); expect(mocks.action).not.toHaveBeenCalled();
  });
});
