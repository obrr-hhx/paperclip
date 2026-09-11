import { z } from "zod";

const relativePath = z.string().min(1).max(300).refine((p) =>
  !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === ".." || s === ".git") && p !== ".",
"Use a repository-relative file or directory prefix");
export const poolTaskSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20000),
  allowedPaths: z.array(relativePath).min(1).max(50),
  acceptance: z.array(z.string().min(1).max(2000)).min(1).max(30),
  dependsOn: z.array(z.string()).max(100).default([]),
}).strict();
export const plannerNotificationSchema = z.object({
  provider: z.literal("codex"),
  threadId: z.string().uuid(),
  endpoint: z.string().max(200).refine((value) => {
    if (value === "local") return true;
    try {
      const url = new URL(value);
      return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        && !!url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    } catch { return false; }
  }, "Use local or an existing loopback Codex WebSocket endpoint, without credentials").default("local"),
}).strict();
export type PlannerNotification = z.infer<typeof plannerNotificationSchema>;
export const createTaskPoolSchema = z.object({
  title: z.string().min(1).max(200),
  requirement: z.string().min(1).max(50000),
  repository: z.string().min(1),
  baseRef: z.string().min(1).default("HEAD"),
  templateAgentId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  concurrency: z.number().int().min(1).max(4).default(2),
  leaseSec: z.number().int().min(30).max(3600).default(120),
  retryDelaySec: z.number().int().min(1).max(3600).default(30),
  maxAttempts: z.number().int().min(1).max(3).default(2),
  originSession: z.string().max(200).optional(),
  plannerNotification: plannerNotificationSchema.optional(),
  tasks: z.array(poolTaskSchema).min(1).max(100),
}).strict();
export const taskPoolActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bind_planner"), notification: plannerNotificationSchema.nullable() }).strict(),
  z.object({ action: z.literal("set_status"), status: z.enum(["closed", "superseded"]), taskKey: z.string().min(1).optional(), reason: z.string().trim().min(1).max(20000), replacement: z.string().url().max(2000).optional() }).strict(),
  z.object({ action: z.literal("publish") }).strict(),
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("retry_task"), taskKey: z.string().min(1), feedback: z.string().min(1).max(20000) }).strict(),
  z.object({ action: z.literal("claim_review"), session: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("accept"), token: z.string().uuid(), candidate: z.string().regex(/^[a-f0-9]{64}$/), evidence: z.string().min(1).max(20000) }).strict(),
  z.object({ action: z.literal("rework"), token: z.string().uuid(), candidate: z.string().regex(/^[a-f0-9]{64}$/), feedback: z.string().min(1).max(20000), tasks: z.array(poolTaskSchema).min(1).max(100) }).strict(),
]);
export type PoolTaskSpec = z.infer<typeof poolTaskSchema>;
export type PoolAttempt = { id: string; agentId: string; cwd: string; startedAt: string; runId?: string; status: "reserved" | "running" | "succeeded" | "failed"; error?: string; commit?: string; summary?: string; tests?: string[]; lease?: { host?: string; renewedAt: string; expiresAt: string; recoveryError?: string } };
export type PoolClosure = { status: "closed" | "superseded"; reason: string; replacement?: string; owner: string; createdAt: string };
export type PoolTask = PoolTaskSpec & { issueId: string; status: "pending" | "running" | "succeeded" | "blocked" | "closed" | "superseded"; closure?: PoolClosure; retryLimit?: number; retryAt?: string; attempts: PoolAttempt[] };
export type PoolEvent = { id: string; type: "ready_for_review" | "needs_attention" | "accepted"; generation: number; createdAt: string; candidate?: string; evidence?: string };
export type PoolState = {
  generation: number; status: "draft" | "active" | "paused" | "needs_attention" | "ready_for_review" | "accepted" | "closed" | "superseded";
  closure?: PoolClosure;
  tasks: PoolTask[]; events: PoolEvent[];
  candidate?: { sha256: string; commit: string; cwd: string; manifest: string };
  review?: { session: string; owner: string; token: string; expiresAt: string };
};
