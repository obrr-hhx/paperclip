import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { notifyPoolPlanner } from "../services/task-pool-notifications.js";
import {
  createTaskPoolSchema,
  taskPoolActionSchema,
} from "@paperclipai/shared";
import type { PoolBatch } from "../services/task-pool-workspace.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const target = {
  provider: "codex" as const,
  threadId: "11111111-1111-4111-8111-111111111111",
  endpoint: "ws://127.0.0.1:39281",
};
function batch(status = "ready_for_review", generation = 1) {
  return {
    id: "batch",
    config: { plannerNotification: target },
    state: {
      status,
      generation,
      events: [{ id: "event", type: "ready_for_review", generation: 1 }],
    },
  } as unknown as PoolBatch;
}
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "pool-notify-test-"));
  roots.push(value);
  return value;
}
const submitted = () => ({
  status: "submitted" as const,
  updatedAt: new Date().toISOString(),
});
describe("planner notification delivery", () => {
  it("deduplicates concurrent scans and subsequent process reads", async () => {
    const dir = await root();
    const send = vi.fn(async () => submitted());
    await Promise.all(
      Array.from({ length: 6 }, () =>
        notifyPoolPlanner(batch(), dir, "http://localhost:3112/api", send),
      ),
    );
    await notifyPoolPlanner(batch(), dir, "http://localhost:3112/api", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      target,
      "event",
      expect.stringContaining("GET http://localhost:3112/api/task-pool/batch"),
    ]);
  });
  it("does not notify superseded, accepted, active or unbound requirements", async () => {
    const dir = await root();
    const send = vi.fn();
    for (const b of [
      batch("ready_for_review", 2),
      batch("accepted"),
      batch("active"),
      { ...batch(), config: {} },
    ])
      await notifyPoolPlanner(b as PoolBatch, dir, "api", send);
    expect(send).not.toHaveBeenCalled();
  });
  it("retains skipped and ambiguous outcomes without retrying", async () => {
    for (const fails of [false, true]) {
      const dir = await root();
      const send = vi.fn(async () => {
        if (fails) throw Error("private detail");
        return {
          status: "skipped" as const,
          reason: "endpoint_unavailable",
          updatedAt: "now",
        };
      });
      const receipt = await notifyPoolPlanner(batch(), dir, "api", send);
      expect(receipt?.status).toBe(fails ? "failed" : "skipped");
      await notifyPoolPlanner(batch(), dir, "api", send);
      expect(send).toHaveBeenCalledTimes(1);
      const file = (await readdir(path.join(dir, "batch")))[0];
      expect(
        await readFile(path.join(dir, "batch", file), "utf8"),
      ).not.toContain("private detail");
    }
  });
  it("notifies a replacement recipient of the current event", async () => {
    const dir = await root();
    const send = vi.fn(async () => submitted());
    const b = batch();
    await notifyPoolPlanner(b, dir, "api", send);
    b.config.plannerNotification = {
      ...target,
      threadId: "22222222-2222-4222-8222-222222222222",
    };
    await notifyPoolPlanner(b, dir, "api", send);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("restricts bindings to local existing-server addresses", () => {
    expect(
      taskPoolActionSchema.safeParse({
        action: "bind_planner",
        notification: target,
      }).success,
    ).toBe(true);
    expect(
      taskPoolActionSchema.safeParse({
        action: "bind_planner",
        notification: null,
      }).success,
    ).toBe(true);
    for (const endpoint of [
      "ws://example.com:80",
      "http://127.0.0.1:80",
      "ws://user:pass@localhost:80",
      "ws://localhost:80/?token=x",
      "ws://localhost:80/path",
    ])
      expect(
        taskPoolActionSchema.safeParse({
          action: "bind_planner",
          notification: { ...target, endpoint },
        }).success,
      ).toBe(false);
    expect(
      createTaskPoolSchema.shape.plannerNotification.safeParse(target).success,
    ).toBe(true);
  });
});

import { WebSocketServer } from "ws";
import { queuePlannerNotification } from "../services/task-pool-notifications.js";
async function endpoint(loaded: boolean, rejectQueue = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const methods: string[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      methods.push(request.method);
      if (!request.id) return;
      const result =
        request.method === "thread/loaded/list"
          ? { data: loaded ? [target.threadId] : [], nextCursor: null }
          : {};
      socket.send(
        JSON.stringify(
          rejectQueue && request.method === "thread/queue/add"
            ? { id: request.id, error: { message: "private data" } }
            : { id: request.id, result },
        ),
      );
    }),
  );
  return {
    methods,
    target: {
      ...target,
      endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
describe("Codex notification transport", () => {
  it("uses only initialized, loaded-list and queue-add on the existing server", async () => {
    const fixture = await endpoint(true);
    try {
      expect(
        (await queuePlannerNotification(fixture.target, "event", "notice"))
          .status,
      ).toBe("submitted");
      expect(fixture.methods).toEqual([
        "initialize",
        "initialized",
        "thread/loaded/list",
        "thread/queue/add",
      ]);
    } finally {
      await fixture.close();
    }
  });
  it("skips unloaded sessions without queueing or resuming", async () => {
    const fixture = await endpoint(false);
    try {
      expect(
        (await queuePlannerNotification(fixture.target, "event", "notice"))
          .reason,
      ).toBe("thread_not_loaded");
      expect(fixture.methods).not.toContain("thread/queue/add");
    } finally {
      await fixture.close();
    }
  });
  it("bounds a server that accepts connections but never responds", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const started = Date.now();
    try {
      const result = await queuePlannerNotification(
        {
          ...target,
          endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
        },
        "event",
        "notice",
      );
      expect(result.status).toBe("skipped");
      expect(Date.now() - started).toBeLessThan(6500);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("handles stopped servers and rejected delivery without leaking responses", async () => {
    const fixture = await endpoint(true, true);
    try {
      expect(
        (await queuePlannerNotification(fixture.target, "event", "notice"))
          .reason,
      ).toBe("delivery_unconfirmed");
    } finally {
      await fixture.close();
    }
    expect(
      (await queuePlannerNotification(fixture.target, "event", "notice"))
        .status,
    ).toBe("skipped");
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { queueLocalPlannerNotification } from "../services/task-pool-notifications.js";
describe("local planner queue", () => {
  async function fixture() {
    const home = await root();
    const sessions = path.join(home, "sessions", "2026", "09", "11");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, `rollout-test-${target.threadId}.jsonl`),
      "",
    );
    return home;
  }
  it("queues only to a session held by an existing Codex process", async () => {
    const home = await fixture();
    const run = vi.fn(async (command: string) => ({
      stdout: command.endsWith("lsof")
        ? "123\n"
        : command.endsWith("ps")
          ? "/path/codex\n"
          : "Queued message",
    }));
    expect(
      (
        await queueLocalPlannerNotification(
          { ...target, endpoint: "local" },
          "notice",
          { home, run },
        )
      ).status,
    ).toBe("submitted");
    expect(run.mock.calls.at(-1)?.[0]).toContain("codex");
    expect(run.mock.calls).toHaveLength(3);
  });
  it("skips an absent or closed session without invoking queue", async () => {
    const home = await fixture();
    const run = vi.fn(async () => {
      throw Error("no holder");
    });
    expect(
      (await queueLocalPlannerNotification(target, "notice", { home, run }))
        .reason,
    ).toBe("session_not_running");
    expect(run).toHaveBeenCalledTimes(1);
    const absent = vi.fn();
    expect(
      (
        await queueLocalPlannerNotification(
          { ...target, threadId: "22222222-2222-4222-8222-222222222222" },
          "notice",
          { home, run: absent },
        )
      ).status,
    ).toBe("skipped");
    expect(absent).not.toHaveBeenCalled();
  });
  it("does not mistake another process holding the rollout for Codex", async () => {
    const home = await fixture();
    const run = vi.fn(async (command: string) => ({
      stdout: command.endsWith("lsof") ? "123" : "tail",
    }));
    expect(
      (await queueLocalPlannerNotification(target, "notice", { home, run }))
        .status,
    ).toBe("skipped");
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      taskPoolActionSchema.safeParse({
        action: "bind_planner",
        notification: { provider: "codex", threadId: target.threadId },
      }).success,
    ).toBe(true);
  });
});
