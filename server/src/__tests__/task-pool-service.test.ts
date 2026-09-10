import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, activityLog, companies, agents, projects, heartbeatRuns, taskPoolBatches } from "@paperclipai/db";
import { createTaskPoolSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { taskPoolService } from "../services/task-pool.js";
import { orderPoolTasks, poolPathAllowed } from "../services/task-pool-policy.js";
import { collectPoolResult, poolGit, poolInstance } from "../services/task-pool-workspace.js";

const task = (key: string, dependsOn: string[] = []) => ({ key, title: key, instructions: `Create ${key}.txt`, allowedPaths: [`${key}.txt`], acceptance: ["File exists"], dependsOn });
describe("durable task pool", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>; let root: string; let repository: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pool-")); repository = path.join(root, "repo"); await mkdir(repository);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home")); vi.stubEnv("PAPERCLIP_TASK_POOL_HOME", path.join(root, "public"));
    temp = await startEmbeddedPostgresTestDatabase("pool-db-"); db = createDb(temp.connectionString);
    await poolGit(repository, "init"); await poolGit(repository, "config", "user.name", "Pool test"); await poolGit(repository, "config", "user.email", "pool-test@example.invalid");
    await writeFile(path.join(repository, "README.md"), "fixture\n"); await poolGit(repository, "add", "."); await poolGit(repository, "commit", "-m", "fixture");
  }, 30000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  async function create(tasks = [task("a"), task("b"), task("c", ["a", "b"])]) {
    const companyId = randomUUID(); const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pool test", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Template", adapterType: "process", adapterConfig: { command: "true" } });
    return taskPoolService(db).create(companyId, createTaskPoolSchema.parse({ title: "Requirement", requirement: "Independent parallel files with a dependent task", repository, templateAgentId: agentId, tasks }));
  }
  function executor(fail = false, failKey?: string) {
    const calls: string[] = [];
    const wakeup = vi.fn(async (agentId: string) => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const config = agent!.adapterConfig; const env = Object.fromEntries(Object.entries(config.env as Record<string, unknown>).map(([key, value]) => [key, typeof value === "string" ? value : (value as { value: string }).value]));
      const key = env.PAPERCLIP_POOL_TASK_KEY!; calls.push(key);
      if (key === "c") { expect(await readFile(path.join(String(config.cwd), "a.txt"), "utf8")).toBe("a\n"); expect(await readFile(path.join(String(config.cwd), "b.txt"), "utf8")).toBe("b\n"); }
      await writeFile(path.join(String(config.cwd), `${key}.txt`), `${key}\n`);
      await writeFile(env.PAPERCLIP_POOL_RESULT!, JSON.stringify({ status: "completed", summary: "Created file", tests: ["Fixture assertion passed"] }));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: agent!.companyId, agentId, invocationSource: "automation", status: fail || key === failKey ? "failed" : "succeeded", finishedAt: new Date(), exitCode: fail ? 1 : 0 }).returning();
      return run!;
    });
    return { calls, wakeup };
  }
  it("rejects cycles, missing dependencies, duplicate keys and path-prefix escapes", () => {
    expect(() => orderPoolTasks([task("a", ["b"]), task("b", ["a"])])).toThrow("cycle");
    expect(() => orderPoolTasks([task("a", ["missing"])])).toThrow("Unknown");
    expect(() => orderPoolTasks([task("a"), task("a")])).toThrow("unique");
    expect(poolPathAllowed("src-other/file", ["src/"])).toBe(false);
    expect(poolPathAllowed("src/file", ["src/"])).toBe(true);
  });
  it("rejects a project from another company", async () => {
    const own = await create([task("own")]); const other = await create([task("other")]);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: other.companyId, name: "Other company project" });
    await expect(taskPoolService(db).create(own.companyId, createTaskPoolSchema.parse({
      title: "Cross-company attempt", requirement: "Must be rejected", repository, templateAgentId: own.config.templateAgentId, projectId, tasks: [task("cross")],
    }))).rejects.toThrow("Project must belong to the same company");
  });
  it("survives planner/service replacement, serializes scanners, integrates dependencies and hands review to a new session", async () => {
    const batch = await create(); const worker = executor(); let svc = taskPoolService(db);
    await svc.tick(worker); expect(worker.calls).toEqual([]);
    await svc.action(batch.id, { action: "publish" }, "user:planner");
    await Promise.all([svc.tick(worker), taskPoolService(db).tick(worker)]);
    for (let i = 0; i < 8; i++) { svc = taskPoolService(db); await svc.tick(worker); }
    const done = (await svc.get(batch.id))!;
    expect(done.state.status).toBe("ready_for_review");
    expect(worker.calls).toEqual(["a", "b", "c"]);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, batch.companyId));
    expect(logs.filter((entry) => entry.action === "task_pool.attempt_completed").every((entry) => entry.runId)).toBe(true);
    expect(done.state.tasks.every((t) => t.attempts.length === 1)).toBe(true);
    expect(done.state.events.filter((e) => e.type === "ready_for_review")).toHaveLength(1);
    expect(await readFile(path.join(done.state.candidate!.cwd, "c.txt"), "utf8")).toBe("c\n");
    const claim = (await svc.action(batch.id, { action: "claim_review", session: "new-session" }, "user:planner"))!;
    await expect(svc.action(batch.id, { action: "claim_review", session: "other-session" }, "user:planner")).rejects.toThrow("Another session");
    await expect(svc.action(batch.id, { action: "accept", token: claim.state.review!.token, candidate: "a".repeat(64), evidence: "verified" }, "user:planner")).rejects.toThrow("Candidate changed");
    await svc.action(batch.id, { action: "accept", token: claim.state.review!.token, candidate: done.state.candidate!.sha256, evidence: "Independently inspected all three files" }, "user:planner");
    await svc.sync(batch.id);
    const context = JSON.parse(await readFile(path.join(root, "public", "requirements", poolInstance(), batch.id, "context.json"), "utf8"));
    expect(context.status).toBe("accepted"); expect(JSON.stringify(context)).not.toContain(claim.state.review!.token);
    await rm(path.join(root, "public"), { recursive: true }); await svc.sync(batch.id);
    expect(await readFile(path.join(root, "public", "requirements", poolInstance(), batch.id, "SUMMARY.md"), "utf8")).toContain("accepted");
  }, 30000);
  it("bounds retries, keeps all attempts, and never releases dependents of failed work", async () => {
    const batch = await create([task("fail"), task("dependent", ["fail"])]); const worker = executor(true); const svc = taskPoolService(db);
    await svc.action(batch.id, { action: "publish" }, "user:planner");
    for (let i = 0; i < 8; i++) await svc.tick(worker);
    const failed = (await svc.get(batch.id))!;
    expect(worker.calls).toEqual(["fail", "fail"]);
    expect(failed.state.status).toBe("needs_attention");
    expect(failed.state.tasks[0]!.attempts).toHaveLength(2);
    expect(failed.state.tasks[1]!.attempts).toHaveLength(0);
  }, 30000);
  it("grants one explicit retry with feedback and preserves exhausted attempts", async () => {
    const batch = await create([task("retry")]); const svc = taskPoolService(db);
    await svc.action(batch.id, { action: "publish" }, "user:planner");
    for (let i = 0; i < 8; i++) await svc.tick(executor(true));
    await svc.action(batch.id, { action: "retry_task", taskKey: "retry", feedback: "Environment repaired; try once" }, "user:planner");
    const worker = executor();
    for (let i = 0; i < 4; i++) await svc.tick(worker);
    const result = (await svc.get(batch.id))!;
    expect(result.state.status).toBe("ready_for_review");
    expect(result.state.generation).toBe(2);
    expect(result.state.tasks[0]!.attempts.map((a) => a.status)).toEqual(["failed", "failed", "succeeded"]);
    expect(worker.calls).toEqual(["retry"]);
    expect(result.state.tasks[0]!.instructions).toContain("Environment repaired");
    await expect(svc.action(batch.id, { action: "retry_task", taskKey: "retry", feedback: "Again" }, "user:planner")).rejects.toThrow("Only a blocked task");
  }, 30000);
  it("rejects a missing result even when the native run succeeded", async () => {
    const batch = await create([task("missing")]); const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner"); await svc.tick(worker); await svc.tick(worker);
    const running = (await svc.get(batch.id))!;
    await rm(path.join(path.dirname(running.state.tasks[0]!.attempts[0]!.cwd), "result.json"));
    await svc.tick(worker);
    const result = (await svc.get(batch.id))!;
    expect(result.state.tasks[0]!.attempts[0]!.status).toBe("failed");
    expect(result.state.candidate).toBeUndefined();
    await svc.action(batch.id, { action: "pause" }, "user:planner");
  }, 30000);
  it("keeps scheduling other requirements when one execution template is unavailable", async () => {
    const broken = await create([task("broken")]); const healthy = await create([task("healthy")]);
    const svc = taskPoolService(db); const worker = executor();
    await db.delete(agents).where(eq(agents.id, broken.config.templateAgentId));
    await svc.action(broken.id, { action: "publish" }, "user:planner");
    await svc.action(healthy.id, { action: "publish" }, "user:planner");
    for (let i = 0; i < 4; i++) await svc.tick(worker);
    expect((await svc.get(broken.id))!.state.status).toBe("needs_attention");
    expect((await svc.get(broken.id))!.state.events[0]!.evidence).toContain("Execution template is missing");
    expect((await svc.get(healthy.id))!.state.status).toBe("ready_for_review");
    expect(worker.calls).toEqual(["healthy"]);
  }, 30000);
  it("does not dispatch reserved work after its company is archived", async () => {
    const batch = await create([task("archived")]); const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner"); await svc.tick(worker);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, batch.companyId));
    await svc.tick(worker);
    expect(worker.calls).toEqual([]); expect((await svc.get(batch.id))!.state.status).toBe("paused");
  }, 30000);
  it("removes pool rows before deleting their owning company and native issues", async () => {
    const batch = await create([task("remove")]);
    await companyService(db).remove(batch.companyId);
    expect(await taskPoolService(db).get(batch.id)).toBeNull();
  }, 30000);
  it("honors pause and detects a run already launched before a dispatcher restart", async () => {
    const batch = await create([task("once")]); const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner"); await svc.tick(worker);
    await svc.action(batch.id, { action: "pause" }, "user:planner"); await svc.tick(worker); expect(worker.calls).toHaveLength(0);
    await svc.action(batch.id, { action: "resume" }, "user:planner"); await svc.tick(worker);
    const row = (await svc.get(batch.id))!; row.state.tasks[0]!.attempts[0]!.status = "reserved"; delete row.state.tasks[0]!.attempts[0]!.runId;
    await db.update(taskPoolBatches).set({ state: row.state }).where(eq(taskPoolBatches.id, batch.id));
    await taskPoolService(db).tick(worker); await taskPoolService(db).tick(worker);
    expect(worker.calls).toEqual(["once"]);
    expect((await svc.get(batch.id))!.state.status).toBe("ready_for_review");
  }, 30000);
  it("returns a new candidate after planner rework and rejects an expired or old-generation verdict", async () => {
    const batch = await create([task("original")]); const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner");
    for (let i = 0; i < 4; i++) await svc.tick(worker);
    const first = (await svc.action(batch.id, { action: "claim_review", session: "old" }, "user:planner"))!;
    first.state.review!.expiresAt = new Date(0).toISOString();
    await db.update(taskPoolBatches).set({ state: first.state }).where(eq(taskPoolBatches.id, first.id));
    await expect(svc.action(batch.id, { action: "accept", token: first.state.review!.token, candidate: first.state.candidate!.sha256, evidence: "stale" }, "user:planner")).rejects.toThrow("current review claim");
    const claim = (await taskPoolService(db).action(batch.id, { action: "claim_review", session: "replacement" }, "user:planner"))!;
    await svc.action(batch.id, { action: "rework", token: claim.state.review!.token, candidate: claim.state.candidate!.sha256, feedback: "Add the missing file", tasks: [task("repair", ["original"])] }, "user:planner");
    for (let i = 0; i < 4; i++) await svc.tick(worker);
    const next = (await svc.action(batch.id, { action: "claim_review", session: "replacement" }, "user:planner"))!;
    expect(next.state.generation).toBe(2);
    expect(next.state.candidate!.sha256).not.toBe(first.state.candidate!.sha256);
    expect(worker.calls).toEqual(["original", "repair"]);
    await expect(svc.action(batch.id, { action: "accept", token: next.state.review!.token, candidate: first.state.candidate!.sha256, evidence: "old candidate" }, "user:planner")).rejects.toThrow("Candidate changed");
  }, 30000);
  it("recovers a collected commit after a DB rollback without rerunning the worker", async () => {
    const batch = await create([task("recover")]); const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner"); await svc.tick(worker); await svc.tick(worker);
    const running = (await svc.get(batch.id))!; const work = running.state.tasks[0]!;
    const candidate = await collectPoolResult(work, work.attempts[0]!);
    await svc.tick(worker);
    const done = (await svc.get(batch.id))!;
    expect(done.state.tasks[0]!.attempts[0]!.commit).toBe(candidate.commit);
    expect(done.state.status).toBe("ready_for_review"); expect(worker.calls).toEqual(["recover"]);
  }, 30000);
  it("stops on conflicting independent patches without manufacturing a review candidate", async () => {
    const batch = await create(["one", "two"].map((key) => ({ ...task(key), allowedPaths: [`${key}.txt`, "shared.txt"] })));
    const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner"); await svc.tick(worker); await svc.tick(worker);
    const running = (await svc.get(batch.id))!;
    for (const work of running.state.tasks) await writeFile(path.join(work.attempts[0]!.cwd, "shared.txt"), work.key);
    await svc.tick(worker);
    const result = (await svc.get(batch.id))!;
    expect(result.state.status).toBe("needs_attention");
    expect(result.state.events[0]!.evidence).toContain("Integration failed");
    expect(result.state.candidate).toBeUndefined();
    await expect(svc.action(batch.id, { action: "claim_review", session: "planner" }, "user:planner")).rejects.toThrow("not ready");
  }, 30000);
  it("does not deliver an out-of-scope change even when the process exits successfully", async () => {
    const batch = await create([task("scope")]); const svc = taskPoolService(db); const worker = executor();
    await svc.action(batch.id, { action: "publish" }, "user:planner"); await svc.tick(worker); await svc.tick(worker);
    const running = (await svc.get(batch.id))!;
    await writeFile(path.join(running.state.tasks[0]!.attempts[0]!.cwd, "forbidden.txt"), "outside contract");
    await svc.tick(worker);
    const current = (await svc.get(batch.id))!;
    expect(current.state.tasks[0]!.attempts[0]!.status).toBe("failed");
    expect(current.state.tasks[0]!.attempts[0]!.error).toContain("outside allowed paths");
    expect(current.state.candidate).toBeUndefined();
    await svc.action(batch.id, { action: "pause" }, "user:planner");
  }, 30000);

});
