import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createTaskPoolSchema, taskPoolActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { taskPoolService } from "../services/task-pool.js";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { logActivity } from "../services/activity-log.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

export function taskPoolRoutes(db: Db) {
  const router = Router(); const svc = taskPoolService(db); const permissions = accessService(db);
  async function manage(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin || await permissions.canUser(companyId, req.actor.userId, "tasks:assign")) return;
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      const agent = await agentService(db).getById(req.actor.agentId);
      if (agent && !agent.metadata?.taskPoolAttemptId && await permissions.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign")) return;
    }
    throw forbidden("Task pool management requires planner task-assignment permission");
  }
  function view<T extends { state: { review?: { token: string } } }>(batch: T) {
    const copy = structuredClone(batch);
    if (copy.state.review) copy.state.review.token = "";
    return copy;
  }
  router.get("/companies/:companyId/task-pool", async (req, res) => {
    assertCompanyAccess(req, String(req.params.companyId));
    res.json((await svc.list(String(req.params.companyId))).map(view));
  });
  router.post("/companies/:companyId/task-pool", validate(createTaskPoolSchema), async (req, res) => {
    await manage(req, String(req.params.companyId));
    const batch = await svc.create(String(req.params.companyId), req.body);
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: batch.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "task_pool.created", entityType: "issue", entityId: batch.issueId, details: { batchId: batch.id } });
    res.status(201).json(view(batch));
  });
  router.get("/task-pool/:id", async (req, res) => {
    const batch = await getAccessibleResource(req, res, svc.get(String(req.params.id)), "Task pool batch not found");
    if (batch) res.json(view(batch));
  });
  router.post("/task-pool/:id/sync", async (req, res) => {
    const batch = await getAccessibleResource(req, res, svc.get(String(req.params.id)), "Task pool batch not found");
    if (!batch) return;
    await manage(req, batch.companyId); res.json(view(await svc.sync(batch.id)));
  });
  router.post("/task-pool/:id/actions", validate(taskPoolActionSchema), async (req, res) => {
    const batch = await getAccessibleResource(req, res, svc.get(String(req.params.id)), "Task pool batch not found");
    if (!batch) return;
    await manage(req, batch.companyId);
    const actor = getActorInfo(req);
    const updated = (await svc.action(batch.id, req.body, `${actor.actorType}:${actor.actorId}`))!;
    await logActivity(db, { companyId: batch.companyId, actorType: actor.actorType, actorId: actor.actorId, action: `task_pool.${req.body.action}`, entityType: "issue", entityId: batch.issueId, details: { batchId: batch.id, generation: updated.state.generation } });
    res.json(req.body.action === "claim_review" ? updated : view(updated));
  });
  return router;
}
