import type { TranscriptEntry } from "../adapters";
export type WorkerActivity = {
  id: string;
  entry: TranscriptEntry;
  result?: Extract<TranscriptEntry, { kind: "tool_result" }>;
};
export function workerActivities(entries: TranscriptEntry[]): WorkerActivity[] {
  const items: WorkerActivity[] = [];
  const calls = new Map<string, WorkerActivity>();
  entries.forEach((entry, index) => {
    if (
      entry.kind === "init" ||
      (entry.kind === "system" && entry.text.startsWith("step started")) ||
      (entry.kind === "result" && !entry.isError)
    )
      return;
    if (entry.kind === "tool_call") {
      const id = entry.toolUseId ?? `call:${index}`;
      const previous = calls.get(id);
      if (previous) {
        previous.entry = entry;
        return;
      }
      const item = { id, entry };
      calls.set(id, item);
      items.push(item);
      return;
    }
    if (entry.kind === "tool_result") {
      const item = calls.get(entry.toolUseId);
      if (item) {
        item.result = entry;
        return;
      }
    }
    items.push({ id: `${entry.kind}:${index}`, entry });
  });
  return items;
}
export function workerToolLabel(
  entry: Extract<TranscriptEntry, { kind: "tool_call" }>,
) {
  const input =
    entry.input && typeof entry.input === "object"
      ? (entry.input as Record<string, unknown>)
      : {};
  const verb: Record<string, string> = {
    read: "读取",
    write: "写入",
    edit: "修改",
    apply_patch: "应用补丁",
    bash: "执行命令",
    shell: "执行命令",
    grep: "搜索",
    glob: "查找文件",
  };
  const target = [
    input.description,
    input.command,
    input.filePath,
    input.file_path,
    input.path,
    input.pattern,
  ].find((v) => typeof v === "string" && v.trim());
  return `${verb[entry.name] ?? entry.name}${target ? ` · ${String(target).slice(0, 240)}` : ""}`;
}
