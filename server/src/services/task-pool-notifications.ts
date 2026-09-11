import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { glob } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { PoolBatch } from "./task-pool-workspace.js";

type Target = NonNullable<PoolBatch["config"]["plannerNotification"]>;
export type NotificationReceipt = {
  status: "attempting" | "submitted" | "skipped" | "failed";
  reason?: string;
  updatedAt: string;
};

const exec = promisify(execFile);

// The local CLI can queue into an existing TUI without a WebSocket listener.
// Check the process that holds this exact rollout first, so closed sessions do
// not receive deferred queue entries that unexpectedly run on a future resume.
export async function queueLocalPlannerNotification(
  target: Target,
  message: string,
  options: {
    home?: string;
    run?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  } = {},
): Promise<NotificationReceipt> {
  const home =
    options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const run =
    options.run ??
    ((command: string, args: string[]) =>
      exec(command, args, { timeout: 5000, maxBuffer: 64 * 1024 }));
  let submitting = false;
  try {
    let alive = false;
    for await (const rollout of glob(
      path.join(
        home,
        "sessions",
        "*",
        "*",
        "*",
        `rollout-*-${target.threadId}.jsonl`,
      ),
    )) {
      let holders: string[];
      try {
        holders = (await run("/usr/sbin/lsof", ["-t", rollout])).stdout
          .trim()
          .split(/\s+/);
      } catch {
        continue;
      }
      for (const pid of holders) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const command = (
            await run("/bin/ps", ["-p", pid, "-o", "comm="])
          ).stdout.trim();
          if (path.basename(command) === "codex") {
            alive = true;
            break;
          }
        } catch {
          /* Process exited during inspection. */
        }
      }
      if (alive) break;
    }
    if (!alive)
      return {
        status: "skipped",
        reason: "session_not_running",
        updatedAt: new Date().toISOString(),
      };
    submitting = true;
    await run(
      process.env.PAPERCLIP_CODEX_COMMAND ??
        path.join(os.homedir(), ".local", "bin", "codex"),
      ["queue", "--thread", target.threadId, "--message", message],
    );
    return { status: "submitted", updatedAt: new Date().toISOString() };
  } catch {
    return {
      status: submitting ? "failed" : "skipped",
      reason: submitting ? "delivery_unconfirmed" : "session_unavailable",
      updatedAt: new Date().toISOString(),
    };
  }
}

// Connect only to the supplied running server. Never invoke Codex, start a
// daemon, resume a saved thread, or wait for model execution to finish.
export async function queuePlannerNotification(
  target: Target,
  eventId: string,
  message: string,
): Promise<NotificationReceipt> {
  if (target.endpoint === "local")
    return queueLocalPlannerNotification(target, message);
  const ws = new WebSocket(target.endpoint);
  let sequence = 0;
  let timedOut = false;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const stop = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop(new Error("timeout"));
    ws.close();
  }, 5000);
  ws.addEventListener("message", (event) => {
    try {
      const response = JSON.parse(String(event.data));
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      // Do not persist server error bodies: they may contain private context.
      if (response.error) request.reject(new Error("rpc_rejected"));
      else request.resolve(response.result);
    } catch {
      stop(new Error("invalid_response"));
    }
  });
  ws.addEventListener("close", () => stop(new Error("disconnected")));
  ws.addEventListener("error", () => stop(new Error("unreachable")));
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      if (timedOut || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("unreachable"));
        return;
      }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  let submitting = false;
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("unreachable")), {
        once: true,
      });
      ws.addEventListener("close", () => reject(new Error("disconnected")), {
        once: true,
      });
    });
    await rpc("initialize", {
      clientInfo: { name: "paperclip_planner_notifications", version: "1" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    let cursor: string | undefined;
    let found = false;
    do {
      const page = await rpc("thread/loaded/list", { cursor, limit: 100 });
      if (page.data.includes(target.threadId)) {
        found = true;
        break;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!found)
      return {
        status: "skipped",
        reason: "thread_not_loaded",
        updatedAt: new Date().toISOString(),
      };
    submitting = true;
    await rpc("thread/queue/add", {
      threadId: target.threadId,
      clientUserMessageId: eventId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
    return { status: "submitted", updatedAt: new Date().toISOString() };
  } catch {
    return {
      status: submitting ? "failed" : "skipped",
      reason: submitting ? "delivery_unconfirmed" : "endpoint_unavailable",
      updatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

export async function notifyPoolPlanner(
  batch: PoolBatch,
  receiptRoot: string,
  apiUrl: string,
  send = queuePlannerNotification,
): Promise<NotificationReceipt | undefined> {
  const target = batch.config.plannerNotification;
  const event = batch.state.events.findLast(
    (entry) =>
      entry.generation === batch.state.generation &&
      entry.type === batch.state.status,
  );
  if (
    !target ||
    !event ||
    !["needs_attention", "ready_for_review"].includes(batch.state.status)
  )
    return;
  const recipient = createHash("sha256")
    .update(JSON.stringify(target))
    .digest("hex")
    .slice(0, 24);
  const file = path.join(
    receiptRoot,
    batch.id,
    `${event.id}-${recipient}.json`,
  );
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const initial: NotificationReceipt = {
    status: "attempting",
    updatedAt: new Date().toISOString(),
  };
  // Claim before sending, across processes. A crash can lose a notification,
  // but never causes repeated model turns; durable Inbox remains authoritative.
  try {
    await writeFile(file, JSON.stringify(initial), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      return JSON.parse(await readFile(file, "utf8")) as NotificationReceipt;
    } catch {
      return { ...initial, reason: "receipt_unreadable" };
    }
  }
  const message = `Paperclip notification: ${event.type}. Requirement ${batch.id}, generation ${event.generation}.\nRead current state with the paperclip-planner skill: GET ${apiUrl}/task-pool/${batch.id}.\n${event.type === "ready_for_review" ? "All tasks delivered; perform independent acceptance." : "Work needs planner attention; inspect the blocker and decide the next step."}\nThis is a status notification, not approval to merge or deploy. Event: ${event.id}.`;
  let result: NotificationReceipt;
  try {
    result = await send(target, event.id, message);
  } catch {
    result = {
      status: "failed",
      reason: "delivery_unconfirmed",
      updatedAt: new Date().toISOString(),
    };
  }
  await writeFile(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return result;
}
