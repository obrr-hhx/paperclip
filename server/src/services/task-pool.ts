import { logger } from "../middleware/logger.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { hostname } from "node:os";
import { eq, desc } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, projects, taskPoolBatches, type Db } from "@paperclipai/db";
import { createTaskPoolSchema, type PoolTask, type PoolTaskSpec, type PoolAttempt, taskPoolActionSchema } from "@paperclipai/shared";
import type { z } from "zod";
import { agentService } from "./agents.js";
import { issueService } from "./issues.js";
import { redactSensitiveText } from "../redaction.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { orderPoolTasks, poolDependencies } from "./task-pool-policy.js";
import { atomicPoolFile, collectPoolResult, integratePoolBatch, poolGit, poolRoot, poolTaskMarkdown, preparePoolWorkspace, projectPoolBatch, type PoolBatch } from "./task-pool-workspace.js";
import type { heartbeatService } from "./heartbeat.js";

type Heartbeat = Pick<ReturnType<typeof heartbeatService>, "wakeup" | "inspectPoolExecution" | "cancelRun">;
const terminal = new Set(["succeeded", "failed", "timed_out", "cancelled"]);
const active = new Set(["reserved", "running"]);
const errorText = (error: unknown) => error instanceof Error ? redactSensitiveText(error.message).slice(0, 2000) : "Task pool operation failed";

const taskDescription = (task: PoolTaskSpec) => `${task.instructions}\n\nAcceptance:\n${task.acceptance.join("\n")}\n\nAllowed paths: ${task.allowedPaths.join(", ")}\nDependencies: ${task.dependsOn.join(", ") || "none"}`;
function batchDescription(batch: PoolBatch) {
  const candidate = batch.state.candidate;
  const verdict = batch.state.events.findLast((event) => event.type === "accepted");
  return `${batch.config.requirement}\n\n---\nTask pool: ${batch.id}\nGeneration: ${batch.state.generation}\nStatus: ${batch.state.status}\n${batch.state.closure ? `Closure: ${batch.state.closure.reason}\nReplacement: ${batch.state.closure.replacement ?? "none"}\n` : ""}${candidate ? `Candidate commit: ${candidate.commit}\nManifest SHA-256: ${candidate.sha256}\n` : ""}${verdict ? `\nPlanner acceptance: ${verdict.evidence}\n` : ""}`;
}

export function taskPoolService(db: Db, now: () => number = Date.now) {
  async function get(id: string) { return db.select().from(taskPoolBatches).where(eq(taskPoolBatches.id, id)).then((r) => r[0] ?? null); }
  async function locked<T>(id: string, fn: (batch: PoolBatch, tx: Db) => Promise<T>, skipLocked = false) {
    return db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const [batch] = await tx.select().from(taskPoolBatches).where(eq(taskPoolBatches.id, id)).for("update", skipLocked ? { skipLocked: true } : {});
      if (!batch) { if (skipLocked) return undefined; throw notFound("Task pool batch not found"); }
      const result = await fn(batch, tx);
      await tx.update(taskPoolBatches).set({ state: batch.state, updatedAt: new Date() }).where(eq(taskPoolBatches.id, id));
      return result;
    });
  }
  function event(batch: PoolBatch, type: "ready_for_review" | "needs_attention" | "accepted", evidence?: string) {
    if (batch.state.events.some((e) => e.type === type && e.generation === batch.state.generation)) return;
    batch.state.events.push({ id: randomUUID(), type, generation: batch.state.generation, createdAt: new Date().toISOString(), candidate: batch.state.candidate?.sha256, evidence });
  }
  async function addTasks(tx: Db, batch: Pick<PoolBatch, "companyId" | "issueId" | "config">, specs: PoolTaskSpec[]) {
    const result: PoolTask[] = [];
    for (const spec of specs) {
      const task = await issueService(tx).create(batch.companyId, { title: spec.title,
        description: taskDescription(spec),
        parentId: batch.issueId, projectId: batch.config.projectId, status: "backlog", originKind: "task_pool", originId: batch.issueId });
      result.push({ ...spec, issueId: task.id, status: "pending", attempts: [] });
    }
    return result;
  }
  async function create(companyId: string, input: z.infer<typeof createTaskPoolSchema>) {
    orderPoolTasks(input.tasks);
    const template = await agentService(db).getById(input.templateAgentId);
    if (!template || template.companyId !== companyId || !["opencode_local", "process"].includes(template.adapterType)) throw unprocessable("Choose a same-company OpenCode or process execution template");
    if (input.projectId) {
      const [project] = await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, input.projectId));
      if (!project || project.companyId !== companyId) throw unprocessable("Project must belong to the same company");
    }
    const repository = await poolGit(input.repository, "rev-parse", "--show-toplevel");
    const baseSha = await poolGit(repository, "rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`);
    if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw unprocessable("Invalid Git base");
    const { tasks, ...rest } = input;
    const batch = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const root = await issueService(tx).create(companyId, { title: input.title, description: input.requirement,
        projectId: input.projectId, status: "backlog", originKind: "task_pool" });
      const config = { ...rest, repository, baseSha };
      const initial = await addTasks(tx, { companyId, issueId: root.id, config }, tasks);
      return tx.insert(taskPoolBatches).values({ companyId, issueId: root.id, config,
        state: { generation: 1, status: "draft", tasks: initial, events: [] } }).returning().then((r) => r[0]!);
    });
    return batch;
  }
  async function action(id: string, input: z.infer<typeof taskPoolActionSchema>, owner: string) {
    await locked(id, async (batch, tx) => {
      const state = batch.state;
      if (input.action === "set_status") {
        if (["accepted", "closed", "superseded"].includes(state.status)) throw conflict("Requirement is already terminal");
        if (input.status === "superseded" && !input.replacement) throw unprocessable("Superseded requires a replacement URL");
        if (input.replacement && !["http:", "https:"].includes(new URL(input.replacement).protocol)) throw unprocessable("Replacement must be an HTTP URL");
        const target = input.taskKey ? state.tasks.find((t) => t.key === input.taskKey) : undefined;
        if (input.taskKey && !target) throw notFound("Task key not found");
        const affected = target ? [target] : state.tasks;
        if (affected.some((t) => t.status === "running" || t.attempts.some((a) => active.has(a.status)))) throw conflict("Pause dispatch and wait for running attempts to stop before closing");
        if (target && ["succeeded", "closed", "superseded"].includes(target.status)) throw conflict("Task is already terminal");
        const closure = { status: input.status, reason: input.reason, replacement: input.replacement, owner, createdAt: new Date(now()).toISOString() };
        for (const task of affected) {
          if (["succeeded", "closed", "superseded"].includes(task.status)) continue;
          task.status = input.status; task.closure = closure; delete task.retryAt;
          await tx.update(issues).set({ status: "cancelled", description: `${taskDescription(task)}\n\n${input.status}: ${input.reason}\n${input.replacement ?? ""}`, updatedAt: new Date() }).where(eq(issues.id, task.issueId));
        }
        delete state.review;
        if (!target) {
          state.status = input.status; state.closure = closure;
          delete batch.config.plannerNotification;
          await tx.update(taskPoolBatches).set({ config: batch.config }).where(eq(taskPoolBatches.id, id));
        } else if (state.status === "ready_for_review") {
          state.status = "needs_attention";
        }
      } else if (input.action === "bind_planner") {
        if (input.notification) batch.config.plannerNotification = input.notification;
        else delete batch.config.plannerNotification;
        await tx.update(taskPoolBatches).set({ config: batch.config }).where(eq(taskPoolBatches.id, id));
      } else if (input.action === "publish") {
        if (state.status !== "draft") throw conflict("Only a draft can be published");
        state.status = "active";
      } else if (input.action === "pause") {
        if (state.status !== "active") throw conflict("Only an active batch can be paused");
        state.status = "paused";
      } else if (input.action === "resume") {
        if (!["paused", "needs_attention"].includes(state.status)) throw conflict("Batch is not paused or blocked");
        const exhausted = state.tasks.some((task) => task.status === "blocked" && task.attempts.length >= (task.retryLimit ?? batch.config.maxAttempts));
        if (exhausted) {
          if (state.status !== "paused") throw conflict("Attempts exhausted; diagnose the failure and use retry_task with corrective feedback");
          state.status = "needs_attention";
          event(batch, "needs_attention", "Execution failed while paused; diagnose and explicitly grant a retry");
        } else {
          for (const task of state.tasks) if (task.status === "blocked") task.status = "pending";
          state.status = "active";
        }
      } else if (input.action === "retry_task") {
        const task = state.tasks.find((t) => t.key === input.taskKey);
        if (state.status !== "needs_attention" || task?.status !== "blocked") throw conflict("Only a blocked task in a needs-attention batch can be retried");
        if (task.attempts.length >= 10) throw conflict("Manual attempt limit reached; create a replacement requirement");
        task.instructions += `\n\nPlanner retry feedback:\n${input.feedback}`;
        await tx.update(issues).set({ description: taskDescription(task), updatedAt: new Date() }).where(eq(issues.id, task.issueId));
        task.retryLimit = task.attempts.length + 1;
        task.status = "pending"; delete task.retryAt; state.generation++; state.status = "active";
        delete state.candidate; delete state.review;
      } else if (input.action === "claim_review") {
        if (state.status !== "ready_for_review") throw conflict("Batch is not ready for review");
        if (state.review && Date.parse(state.review.expiresAt) > Date.now() && (state.review.owner !== owner || state.review.session !== input.session)) throw conflict("Another session is reviewing this batch");
        state.review = { owner, session: input.session, token: state.review?.owner === owner && state.review.session === input.session ? state.review.token : randomUUID(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
      } else {
        if (state.status !== "ready_for_review" || state.review?.owner !== owner || state.review.token !== input.token || Date.parse(state.review.expiresAt) <= Date.now()) throw conflict("Acquire a current review claim before submitting a verdict");
        if (state.candidate?.sha256 !== input.candidate) throw conflict("Candidate changed; review the current manifest");
        if (input.action === "accept") {
          state.status = "accepted"; event(batch, "accepted", input.evidence);
        } else {
          if (state.tasks.length + input.tasks.length > 100) throw unprocessable("Batch task limit exceeded");
          orderPoolTasks([...state.tasks, ...input.tasks]);
          const newTasks = await addTasks(tx, batch, input.tasks.map((t) => ({ ...t, instructions: `${t.instructions}\n\nPlanner feedback:\n${input.feedback}` })));
          state.tasks.push(...newTasks); state.generation++; state.status = "active";
          delete state.candidate;
        }
        delete state.review;
      }
      await tx.update(issues).set({ description: batchDescription(batch), status: ["closed", "superseded"].includes(state.status) ? "cancelled" : state.status === "accepted" ? "done" : state.status === "ready_for_review" ? "in_review" : state.status === "needs_attention" ? "blocked" : "in_progress", updatedAt: new Date() }).where(eq(issues.id, batch.issueId));
    });
    return get(id);
  }
  async function reserve(batch: PoolBatch, task: PoolTask, tx: Db) {
    const template = await agentService(tx).getById(batch.config.templateAgentId);
    if (!template || template.companyId !== batch.companyId) throw new Error("Execution template is missing");
    const id = randomUUID();
    const cwd = path.join(poolRoot(), batch.id, id, "worktree");
    const agent = await agentService(tx).create(batch.companyId, {
      name: `${task.key} · attempt ${task.attempts.length + 1}`, adapterType: template.adapterType,
      adapterConfig: { ...template.adapterConfig, cwd, timeoutSec: 0 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {}, metadata: { taskPoolAttemptId: id, taskPoolBatchId: batch.id, taskPoolIssueId: task.issueId },
    });
    task.attempts.push({ id, agentId: agent.id, cwd, startedAt: new Date().toISOString(), status: "reserved" });
    task.status = "running";
    delete task.retryAt;
    await tx.update(issues).set({ assigneeAgentId: agent.id, status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, task.issueId));
  }
  async function dispatch(batch: PoolBatch, task: PoolTask, attempt: PoolAttempt, heartbeat: Heartbeat) {
    // Agent and reservation were committed on a prior tick. A crash after
    // enqueue cannot duplicate execution: this dedicated agent has only one run.
    const existing = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, attempt.agentId)).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    if (existing[0]) { attempt.runId = existing[0].id; attempt.status = "running"; return; }
    const deps = poolDependencies(batch.state.tasks, task);
    const base = await preparePoolWorkspace(batch, attempt.cwd, deps.map((t) => t.attempts.at(-1)!.commit!));
    const dir = path.dirname(attempt.cwd);
    const resultPath = path.join(dir, "result.json");
    const previous = task.attempts.slice(0, -1).map((a) => `- ${a.id}: ${a.error ?? a.status}. Previous checkout (read only): ${a.cwd}`).join("\n");
    const prompt = `${poolTaskMarkdown(batch, task)}${previous ? `\n## Previous attempts\n${previous}\nInspect previous work as untrusted evidence; reuse only changes within this task's allowed paths. Do not modify previous checkouts.\n` : ""}\n\n## Execution protocol\nYou are a bounded coding worker. Implement and self-test this task in ${attempt.cwd}. Do not invoke Paperclip APIs, spawn other workers, edit Git history, commit, or modify files outside the allowed paths. Dependency changes are already applied. Leave commits to Paperclip. Finish by writing ${resultPath} as JSON: {"status":"completed" or "blocked","summary":"what changed or why blocked","tests":["actual command and observed result"]}. This result file is outside the repository and must not be committed. A successful process alone is not a delivery. The planner independently reviews the final batch.\n`;
    await atomicPoolFile(path.join(dir, "TASK.md"), prompt);
    await atomicPoolFile(path.join(dir, "base.txt"), base);
    const agent = await agentService(db).getById(attempt.agentId);
    await agentService(db).update(attempt.agentId, { adapterConfig: { ...agent!.adapterConfig, cwd: attempt.cwd, promptTemplate: prompt,
      env: { ...(agent!.adapterConfig.env as Record<string, unknown> ?? {}), PYTHONDONTWRITEBYTECODE: "1", PAPERCLIP_POOL_RESULT: resultPath, PAPERCLIP_POOL_TASK: path.join(dir, "TASK.md"), PAPERCLIP_POOL_TASK_KEY: task.key } } });
    const run = await heartbeat.wakeup(attempt.agentId, { source: "automation", triggerDetail: "system", reason: "task_pool_dispatch",
      idempotencyKey: `task-pool:${attempt.id}`, requestedByActorType: "system", requestedByActorId: "task-pool",
      contextSnapshot: { taskPoolBatchId: batch.id, taskPoolIssueId: task.issueId, taskPoolAttemptId: attempt.id } });
    if (!run) throw new Error("Worker wake was rejected or suppressed");
    attempt.runId = run.id; attempt.status = "running";
    attempt.lease = { host: hostname(), renewedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + (batch.config.leaseSec ?? 120) * 1000).toISOString() };
  }
  async function tick(heartbeat: Heartbeat) {
    const batches = await db.select({ id: taskPoolBatches.id }).from(taskPoolBatches);
    for (const { id } of batches) {
      // Separate reservation commit from dispatch. Row locks serialize scanners
      // across processes; skip locked avoids a backlog behind another scanner.
      try {
      await locked(id, async (batch, tx) => {
        if (!["active", "paused"].includes(batch.state.status)) return;
        const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, batch.companyId));
        if (company?.status !== "active") batch.state.status = "paused";
        for (const task of batch.state.tasks) {
          const attempt = task.attempts.at(-1);
          if (!attempt || !active.has(attempt.status)) continue;
          try {
            if (attempt.status === "reserved") { if (batch.state.status === "active") await dispatch(batch, task, attempt, heartbeat); continue; }
            let run: typeof heartbeatRuns.$inferSelect | undefined;
            try { [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, attempt.runId!)); }
            catch (error) { attempt.error = errorText(error); continue; }
            if (!run) {
              // A missing durable run is not proof that its worker has stopped.
              attempt.error = "Run record missing; execution ownership must be reconciled before retry";
              continue;
            }
            if (!terminal.has(run.status)) {
              const leaseMs = (batch.config.leaseSec ?? 120) * 1000;
              // Persist a grace period for historical attempts on first observation.
              attempt.lease ??= { renewedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + leaseMs).toISOString() };
              let health: Awaited<ReturnType<Heartbeat["inspectPoolExecution"]>>;
              try { health = await heartbeat.inspectPoolExecution(run.id, attempt.lease.host); }
              catch (error) { attempt.lease.recoveryError = errorText(error); continue; }
              if (health === "owned") {
                attempt.lease = { host: hostname(), renewedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + leaseMs).toISOString() };
              } else if (now() >= Date.parse(attempt.lease.expiresAt)) {
                if (health !== "stopped") {
                  attempt.lease.recoveryError = "Lease expired; previous execution stop is unverified. Retry withheld to avoid duplicate workers.";
                  event(batch, "needs_attention", `${task.key}: ${attempt.lease.recoveryError}`);
                } else {
                  try {
                    await heartbeat.cancelRun(run.id, "Task pool execution lease expired", { errorCode: "task_pool_lease_expired" });
                  } catch (error) {
                    attempt.lease.recoveryError = errorText(error);
                  }
                }
              }
              // Always observe a committed terminal run on a later scan before retry.
              continue;
            }
            const cancellation = run.resultJson?.executionCancellation as { state?: string } | undefined;
            if (cancellation && cancellation.state !== "acknowledged") {
              attempt.error = "Execution cancellation is not acknowledged; retry withheld until stop is verified";
              continue;
            }
            if (run.status !== "succeeded") throw new Error(`Run ${run.status}: ${run.error ?? run.signal ?? "no result"}`);
            Object.assign(attempt, await collectPoolResult(task, attempt), { status: "succeeded" });
            task.status = "succeeded";
          } catch (error) {
            attempt.status = "failed"; attempt.error = errorText(error);
            task.status = task.attempts.length < (task.retryLimit ?? batch.config.maxAttempts) ? "pending" : "blocked";
            if (task.status === "pending") task.retryAt = new Date(now() + Math.min((batch.config.retryDelaySec ?? 30) * 2 ** (task.attempts.length - 1), 3600) * 1000).toISOString();
          }
          if (!active.has(attempt.status)) {
            await tx.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, attempt.agentId));
            await tx.update(issues).set({ status: task.status === "succeeded" ? "done" : task.status === "blocked" ? "blocked" : "backlog", updatedAt: new Date() }).where(eq(issues.id, task.issueId));
            await logActivity(tx, { companyId: batch.companyId, actorType: "system", actorId: "task-pool", action: "task_pool.attempt_completed", runId: attempt.runId, entityType: "issue", entityId: task.issueId,
              details: { batchId: batch.id, attemptId: attempt.id, runId: attempt.runId, status: attempt.status, error: attempt.error, commit: attempt.commit } });
          }
        }
        if (batch.state.status !== "active") return;
        if (batch.state.tasks.every((t) => t.status === "succeeded")) {
          try { batch.state.candidate = await integratePoolBatch(batch); batch.state.status = "ready_for_review"; event(batch, "ready_for_review"); }
          catch (error) { batch.state.status = "needs_attention"; event(batch, "needs_attention", `Integration failed: ${errorText(error)}`); }
        } else {
          let slots = batch.config.concurrency - batch.state.tasks.filter((t) => t.status === "running").length;
          for (const task of orderPoolTasks(batch.state.tasks)) {
            if (slots <= 0) break;
            if (task.status !== "pending" || (task.retryAt && now() < Date.parse(task.retryAt)) || !poolDependencies(batch.state.tasks, task).every((t) => t.status === "succeeded")) continue;
            try { await reserve(batch, task, tx); slots--; }
            catch (error) {
              task.status = "blocked";
              event(batch, "needs_attention", `Cannot reserve ${task.key}: ${errorText(error)}`);
            }
          }
          if (!batch.state.tasks.some((t) => t.status === "running") && batch.state.tasks.some((t) => ["blocked", "closed", "superseded"].includes(t.status))) {
            batch.state.status = "needs_attention"; event(batch, "needs_attention", batch.state.tasks.some((t) => ["closed", "superseded"].includes(t.status)) ? "Closed tasks cannot satisfy delivery dependencies; planner disposition required" : "Task attempts exhausted");
          }
        }
        await tx.update(issues).set({ description: batchDescription(batch), status: batch.state.status === "ready_for_review" ? "in_review" : batch.state.status === "needs_attention" ? "blocked" : "in_progress", updatedAt: new Date() }).where(eq(issues.id, batch.issueId));
      }, true);
      const batch = await get(id);
      if (batch) await projectPoolBatch(batch);
      } catch (error) {
        // A broken repository, unavailable template or projection must not
        // starve unrelated requirements later in the scan.
        logger.error({ batchId: id, error: errorText(error) }, "task pool batch scan failed");
      }
    }
  }
  return { create, get, action, tick, list: (companyId: string) => db.select().from(taskPoolBatches).where(eq(taskPoolBatches.companyId, companyId)),
    sync: async (id: string) => { const batch = await get(id); if (!batch) throw notFound("Task pool batch not found"); await projectPoolBatch(batch); return batch; } };
}
