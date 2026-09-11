import { Activity, ArrowDown, Clock3 } from "lucide-react";
import { WorkerActivityView } from "./WorkerActivityView";
import { workerActivities, workerToolLabel } from "../../lib/worker-activity";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PoolAttempt } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../../api/heartbeats";
import { agentsApi } from "../../api/agents";
import {
  buildTranscript,
  getUIAdapter,
  type RunLogChunk,
} from "../../adapters";
import {
  RunTranscriptView,
  type TranscriptMode,
} from "../transcript/RunTranscriptView";
import { Button } from "../ui/button";
import { appendPoolLog } from "../../lib/task-pool";
import {
  formatDateTime,
  formatDurationMs,
  relativeTime,
} from "../../lib/utils";

function useExecutionLog(runId: string | undefined, running: boolean) {
  const [state, setState] = useState<{
    rows: RunLogChunk[];
    loading: boolean;
    error: string | null;
    bytes: number;
  }>({ rows: [], loading: true, error: null, bytes: 0 });
  useEffect(() => {
    if (!runId) {
      setState({ rows: [], loading: false, error: null, bytes: 0 });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;
    let remainder = "";
    let rows: RunLogChunk[] = [];
    setState({ rows: [], loading: true, error: null, bytes: 0 });
    async function read() {
      try {
        let caughtUp = false;
        for (let page = 0; page < 8; page++) {
          const chunk = await heartbeatsApi.log(runId!, offset, 128000, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          const parsed = appendPoolLog(remainder, chunk.content);
          remainder = parsed.remainder;
          rows = [...rows, ...parsed.rows].slice(-1500);
          const next =
            chunk.nextOffset ??
            offset + new TextEncoder().encode(chunk.content).length;
          if (!chunk.content || next <= offset) {
            caughtUp = true;
            break;
          }
          offset = next;
          if (chunk.nextOffset === undefined) {
            caughtUp = true;
            break;
          }
        }
        setState({
          rows: [...rows],
          loading: !caughtUp,
          error: null,
          bytes: offset,
        });
        if (running || !caughtUp)
          timer = setTimeout(read, caughtUp ? 3000 : 100);
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          rows: [...rows],
          loading: false,
          error: error instanceof Error ? error.message : "日志读取失败",
          bytes: offset,
        });
        if (running) timer = setTimeout(read, 5000);
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, running]);
  return state;
}

export function ExecutionTrace({
  attempt,
  showRunLink = true,
}: {
  attempt: PoolAttempt;
  showRunLink?: boolean;
}) {
  const latestRef = useRef<HTMLDivElement>(null);
  const active = ["running", "reserved"].includes(attempt.status);
  const [mode, setMode] = useState<TranscriptMode>("nice");
  const run = useQuery({
    queryKey: ["pool-run", attempt.runId],
    queryFn: () => heartbeatsApi.get(attempt.runId!),
    enabled: !!attempt.runId,
    refetchInterval: active ? 5000 : false,
  });
  const agent = useQuery({
    queryKey: ["pool-agent", attempt.agentId],
    queryFn: () => agentsApi.get(attempt.agentId),
  });
  const log = useExecutionLog(attempt.runId, active);
  const transcript = useMemo(
    () =>
      buildTranscript(
        log.rows,
        getUIAdapter(agent.data?.adapterType ?? "process"),
        { censorUsernameInLogs: true },
      ),
    [log.rows, agent.data?.adapterType],
  );
  const last = log.rows.at(-1)?.ts;
  const latestAction = useMemo(
    () =>
      workerActivities(transcript).findLast(
        (item) => item.entry.kind === "tool_call",
      ),
    [transcript],
  );
  const latestTool = latestAction?.entry;
  const duration = run.data?.startedAt
    ? formatDurationMs(
        (run.data.finishedAt
          ? Date.parse(String(run.data.finishedAt))
          : Date.now()) - Date.parse(String(run.data.startedAt)),
      )
    : "尚未启动";
  return (
    <section className="space-y-5" aria-label="执行过程">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">执行过程</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {agent.data?.name ?? "Worker"}
          </p>
        </div>
        {showRunLink && attempt.runId && (
          <Link
            className="text-sm underline"
            to={`/executions/${attempt.runId}`}
          >
            专注查看本次执行
          </Link>
        )}
      </div>
      <div className="rounded-2xl bg-muted/50 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <Activity className="size-3.5" />
            最近工作动作{latestAction?.result ? " · 已返回" : ""}
          </span>
          <span className="flex items-center gap-2">
            <Clock3 className="size-3.5" />
            耗时 {duration}
          </span>
        </div>
        <p className="mt-3 line-clamp-2 break-words text-base font-medium leading-relaxed">
          {latestTool?.kind === "tool_call"
            ? workerToolLabel(latestTool)
            : "等待 worker 的第一条工作记录"}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span title={last ? formatDateTime(last) : undefined}>
            最近更新 ·{" "}
            {last ? relativeTime(last) : log.loading ? "正在读取…" : "暂无输出"}
          </span>
          <span>
            {attempt.status === "succeeded"
              ? "交付结果由规划者独立验收"
              : attempt.status === "failed"
                ? "本次尝试未完成交付"
                : "执行记录持续更新"}
          </span>
        </div>
      </div>
      {(run.error || agent.error) && (
        <p role="alert" className="text-sm text-destructive">
          运行信息读取失败：{String(run.error ?? agent.error)}
        </p>
      )}
      {attempt.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive p-3 text-sm text-destructive"
        >
          {attempt.error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {attempt.summary && (
          <details className="rounded-xl border border-border px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">交付报告</summary>
            <p className="mt-3 whitespace-pre-wrap">{attempt.summary}</p>
          </details>
        )}
        {!!attempt.tests?.length && (
          <details className="rounded-xl border border-border px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">
              Worker 自测报告（{attempt.tests.length}）
            </summary>
            <ul className="list-disc pl-5 text-sm space-y-2">
              {attempt.tests.map((test, index) => (
                <li key={index}>{test}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Button
          size="sm"
          variant="ghost"
          className="order-last ml-auto text-xs text-muted-foreground"
          onClick={() => latestRef.current?.scrollIntoView({ block: "end" })}
        >
          <ArrowDown className="mr-1 size-3.5" />
          最新输出
        </Button>
        <Button
          size="sm"
          variant={mode === "nice" ? "secondary" : "ghost"}
          onClick={() => setMode("nice")}
        >
          过程视图
        </Button>
        <Button
          size="sm"
          variant={mode === "raw" ? "secondary" : "ghost"}
          onClick={() => setMode("raw")}
        >
          原始事件
        </Button>
        <span className="text-xs text-muted-foreground">
          {log.loading
            ? "正在追赶日志…"
            : active
              ? "每 3 秒更新"
              : "执行已结束"}{" "}
          · 最近记录
        </span>
      </div>
      {log.error && (
        <p role="alert" className="text-sm text-destructive">
          日志读取失败：{log.error}
        </p>
      )}
      {!attempt.runId ? (
        <p className="text-sm text-muted-foreground">
          已预留 worker，等待启动运行。
        </p>
      ) : mode === "nice" ? (
        <WorkerActivityView entries={transcript} active={active} />
      ) : (
        <RunTranscriptView
          entries={transcript}
          mode={mode}
          streaming={active}
          collapseStdout
          emptyMessage={
            log.loading ? "正在读取执行日志…" : "尚无可显示的执行日志"
          }
        />
      )}
      <div ref={latestRef} />
    </section>
  );
}
