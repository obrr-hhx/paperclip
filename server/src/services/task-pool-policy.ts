import type { PoolTaskSpec, PoolTask } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function orderPoolTasks<T extends PoolTaskSpec>(tasks: T[]): T[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  if (byKey.size !== tasks.length) throw unprocessable("Task keys must be unique");
  const seen = new Set<string>(); const visiting = new Set<string>(); const ordered: T[] = [];
  function visit(key: string) {
    if (seen.has(key)) return;
    if (visiting.has(key)) throw unprocessable("Task dependencies contain a cycle");
    const task = byKey.get(key);
    if (!task) throw unprocessable(`Unknown dependency: ${key}`);
    visiting.add(key); task.dependsOn.forEach(visit); visiting.delete(key); seen.add(key); ordered.push(task);
  }
  tasks.forEach((t) => visit(t.key)); return ordered;
}
export function poolDependencies(tasks: PoolTask[], task: PoolTask): PoolTask[] {
  const keys = new Set<string>();
  function collect(key: string) { if (keys.has(key)) return; keys.add(key); tasks.find((t) => t.key === key)!.dependsOn.forEach(collect); }
  task.dependsOn.forEach(collect);
  return orderPoolTasks(tasks).filter((t) => keys.has(t.key));
}
export function poolPathAllowed(file: string, paths: string[]) {
  return paths.some((p) => p.endsWith("/") ? file.startsWith(p) : file === p);
}
