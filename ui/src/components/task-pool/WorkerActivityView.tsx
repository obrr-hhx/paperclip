import {
  Terminal,
  FileText,
  FilePenLine,
  Search,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { workerActivities, workerToolLabel } from "../../lib/worker-activity";
import { MarkdownBody } from "../MarkdownBody";
import { RunTranscriptView } from "../transcript/RunTranscriptView";
import { Button } from "../ui/button";
import { formatDateTime, relativeTime } from "../../lib/utils";
export function WorkerActivityView({
  entries,
  active,
}: {
  entries: TranscriptEntry[];
  active: boolean;
}) {
  const [all, setAll] = useState(false);
  const items = useMemo(() => workerActivities(entries), [entries]);
  const visible = all ? items : items.slice(-30);
  return (
    <div className="space-y-1">
      {items.length > 30 && (
        <Button variant="outline" size="sm" onClick={() => setAll(!all)}>
          {all
            ? "仅显示最近 30 项"
            : `展开更早的过程（${items.length - 30} 项）`}
        </Button>
      )}
      {!items.length && (
        <p className="text-sm text-muted-foreground">
          尚无工作进展输出。系统握手等记录可在原始事件中查看。
        </p>
      )}
      {visible.map(({ id, entry, result }) =>
        entry.kind === "tool_call" ? (
          <div
            key={id}
            className="relative ml-4 border-l border-border pb-2 pl-6"
          >
            <span className="absolute -left-4 top-3 flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
              {["bash", "shell"].includes(entry.name) ? (
                <Terminal className="size-3.5" />
              ) : ["write", "edit", "apply_patch"].includes(entry.name) ? (
                <FilePenLine className="size-3.5" />
              ) : ["grep", "glob"].includes(entry.name) ? (
                <Search className="size-3.5" />
              ) : (
                <FileText className="size-3.5" />
              )}
            </span>
            <details className="group rounded-xl transition-colors hover:bg-muted/50 open:bg-muted/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-sm">
                <span className="min-w-0 break-words font-medium leading-relaxed">
                  {workerToolLabel(entry)}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span
                    className="hidden text-xs text-muted-foreground/70 sm:block"
                    title={formatDateTime(entry.ts)}
                  >
                    {relativeTime(entry.ts)}
                  </span>
                  <span
                    className={`text-xs shrink-0 ${result?.isError ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {result
                      ? result.isError
                        ? "失败"
                        : "已返回"
                      : active
                        ? "等待结果"
                        : "未记录结果"}
                  </span>
                  <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="space-y-3 px-4 pb-4">
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(entry.ts)}
                </p>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-background p-4 text-xs leading-relaxed">
                  {JSON.stringify(entry.input, null, 2)}
                </pre>
                {result && (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-relaxed">
                    {result.content}
                  </pre>
                )}
              </div>
            </details>
          </div>
        ) : entry.kind === "assistant" ? (
          <div
            key={id}
            className="relative ml-4 border-l border-border pb-5 pl-10 pt-3"
          >
            <span className="absolute -left-4 top-3 flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
              <Sparkles className="size-3.5" />
            </span>
            <p className="mb-2 text-xs text-muted-foreground">
              进展记录 · {formatDateTime(entry.ts)}
            </p>
            <MarkdownBody>{entry.text}</MarkdownBody>
          </div>
        ) : (
          <RunTranscriptView
            key={id}
            entries={[entry]}
            mode="nice"
            collapseStdout
          />
        ),
      )}
    </div>
  );
}
