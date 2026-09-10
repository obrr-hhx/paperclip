import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { taskPoolBatches } from "@paperclipai/db";
import type { PoolTask, PoolAttempt } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactSensitiveText } from "../redaction.js";
import { poolPathAllowed, orderPoolTasks } from "./task-pool-policy.js";

export type PoolBatch = typeof taskPoolBatches.$inferSelect;
const exec = promisify(execFile);
export const poolHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const poolRoot = () => path.join(resolvePaperclipInstanceRoot(), "task-pool");
export const poolPublicRoot = () => process.env.PAPERCLIP_TASK_POOL_HOME ?? path.join(os.homedir(), ".paperclip");
export const poolInstance = () => poolHash(resolvePaperclipInstanceRoot()).slice(0, 16);
export async function poolGit(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", args, { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}
export async function atomicPoolFile(file: string, body: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, body, { mode: 0o600 }); await rename(temp, file);
}
export async function preparePoolWorkspace(batch: PoolBatch, cwd: string, commits: string[]) {
  await mkdir(path.dirname(cwd), { recursive: true });
  try { await access(path.join(cwd, ".git")); }
  catch { await poolGit(batch.config.repository, "worktree", "add", "--detach", cwd, batch.config.baseSha); }
  // A crash during preparation may leave a conflicted cherry-pick. This path
  // runs only before dispatch, never against an active worker's checkout.
  await poolGit(cwd, "reset", "--hard", batch.config.baseSha);
  for (const commit of commits) await poolGit(cwd, "-c", "core.hooksPath=/dev/null", "cherry-pick", "--allow-empty", commit);
  return poolGit(cwd, "rev-parse", "HEAD");
}
export function poolTaskMarkdown(batch: PoolBatch, task: PoolTask) {
  return `# ${task.key}: ${task.title}\n\nRequirement: ${batch.config.title}\nGeneration: ${batch.state.generation}\nStatus: ${task.status}\n\n## Requirement\n${batch.config.requirement}\n\n## Task\n${task.instructions}\n\n## Allowed changes\n${task.allowedPaths.map((p) => `- ${p}`).join("\n")}\n\n## Acceptance\n${task.acceptance.map((p) => `- ${p}`).join("\n")}\n\nDependencies: ${task.dependsOn.join(", ") || "none"}\nBase: ${batch.config.baseSha}\n`;
}
const resultSchema = z.object({ status: z.enum(["completed", "blocked"]), summary: z.string().min(1).max(10000), tests: z.array(z.string().max(2000)).max(50).default([]) });
export async function collectPoolResult(task: PoolTask, attempt: PoolAttempt) {
  const dir = path.dirname(attempt.cwd);
  const result = resultSchema.parse(JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")));
  if (result.status !== "completed") throw new Error(`Worker blocked: ${result.summary}`);
  const base = (await readFile(path.join(dir, "base.txt"), "utf8")).trim();
  await poolGit(attempt.cwd, "merge-base", "--is-ancestor", base, "HEAD");
  const tracked = (await poolGit(attempt.cwd, "diff", "--name-only", "--no-renames", "-z", base)).split("\0");
  const untracked = (await poolGit(attempt.cwd, "ls-files", "--others", "--exclude-standard", "-z")).split("\0");
  for (const file of [...tracked, ...untracked].filter(Boolean)) {
    if (!poolPathAllowed(file, task.allowedPaths)) throw new Error(`Change outside allowed paths: ${file}`);
  }
  // The worker must leave commits to the supervisor. This gives one patch per
  // task, excluding inherited dependency commits, with a predictable parent.
  const head = await poolGit(attempt.cwd, "rev-parse", "HEAD");
  if (head !== base) {
    // Recover the commit-before-DB-commit window without making another commit.
    const marker = JSON.parse(await readFile(path.join(dir, "commit-intent.json"), "utf8"));
    if (marker.base !== base || marker.attemptId !== attempt.id ||
      await poolGit(attempt.cwd, "rev-parse", "HEAD^") !== base ||
      await poolGit(attempt.cwd, "log", "-1", "--format=%s") !== `task-pool: ${task.key}` ||
      await poolGit(attempt.cwd, "status", "--porcelain")) throw new Error("Worker changed Git history; leave commits to Paperclip");
  } else {
    await atomicPoolFile(path.join(dir, "commit-intent.json"), JSON.stringify({ base, attemptId: attempt.id }));
    await poolGit(attempt.cwd, "add", "--all");
    await poolGit(attempt.cwd, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", `task-pool: ${task.key}`);
  }
  return { commit: await poolGit(attempt.cwd, "rev-parse", "HEAD"), summary: redactSensitiveText(result.summary), tests: result.tests.map(redactSensitiveText) };
}
export async function projectPoolBatch(batch: PoolBatch) {
  const root = path.join(poolPublicRoot(), "requirements", poolInstance(), batch.id);
  const baseUrl = process.env.PAPERCLIP_TASK_POOL_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3100}`;
  const context = { instanceId: poolInstance(), batchId: batch.id, companyId: batch.companyId, issueId: batch.issueId,
    apiUrl: `${baseUrl}/api`, generation: batch.state.generation, status: batch.state.status,
    syncedAt: new Date().toISOString(), candidate: batch.state.candidate,
    tasks: batch.state.tasks.map((t) => ({ key: t.key, issueId: t.issueId, status: t.status, attempts: t.attempts })),
    originSession: batch.config.originSession };
  await atomicPoolFile(path.join(root, "context.json"), JSON.stringify(context, null, 2));
  await atomicPoolFile(path.join(root, "REQUIREMENT.md"), redactSensitiveText(batch.config.requirement));
  await atomicPoolFile(path.join(root, "SUMMARY.md"), `# ${batch.config.title}\n\nStatus: ${batch.state.status}\nGeneration: ${batch.state.generation}\nSynced: ${context.syncedAt}\nBoard: ${baseUrl}/issues/${batch.issueId}\n\n${batch.state.tasks.map((t) => `- ${t.key}: ${t.status} (${t.attempts.length} attempts)`).join("\n")}\n\nRead current server state before claiming review or submitting a verdict. Files are a regenerable index, not the source of truth.\n`);
  for (const task of batch.state.tasks) await atomicPoolFile(path.join(root, "tasks", `${task.key}.md`), redactSensitiveText(poolTaskMarkdown(batch, task)));
  for (const event of batch.state.events) {
    await atomicPoolFile(path.join(poolPublicRoot(), "inbox", `${event.id}.json`), JSON.stringify({ ...event,
      batchId: batch.id, instanceId: poolInstance(), apiUrl: context.apiUrl, companyId: batch.companyId,
      currentStatus: batch.state.status, superseded: event.generation !== batch.state.generation || batch.state.status === "accepted",
      requirementPath: root }, null, 2));
  }
}
export async function integratePoolBatch(batch: PoolBatch) {
  const cwd = path.join(poolRoot(), batch.id, `integration-${batch.state.generation}`);
  const tasks = orderPoolTasks(batch.state.tasks);
  const commits = tasks.map((t) => t.attempts.at(-1)!.commit!);
  await preparePoolWorkspace(batch, cwd, commits);
  const commit = await poolGit(cwd, "rev-parse", "HEAD");
  const manifest = JSON.stringify({ batchId: batch.id, generation: batch.state.generation,
    requirement: batch.config.requirement, base: batch.config.baseSha, commit, tasks: tasks.map((t) => ({ key: t.key, instructions: t.instructions, acceptance: t.acceptance, allowedPaths: t.allowedPaths, dependsOn: t.dependsOn, commit: t.attempts.at(-1)!.commit })) });
  return { cwd, commit, manifest, sha256: poolHash(manifest) };
}
