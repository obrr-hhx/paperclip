import { ArrowUpRight, Layers3 } from "lucide-react";
import { StatusBadge } from "../components/StatusBadge";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useParams, useSearchParams } from "@/lib/router";
import { AgentDetail } from "./AgentDetail";
import { taskPoolApi } from "../api/taskPool";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ExecutionTrace } from "../components/task-pool/ExecutionTrace";
import { MarkdownBody } from "../components/MarkdownBody";
import type { TaskPoolBatch } from "../api/taskPool";
import type { PoolTask, PoolAttempt } from "@paperclipai/shared";
function FocusedRun({
  batch,
  task,
  attempt,
}: {
  batch: TaskPoolBatch;
  task: PoolTask;
  attempt: PoolAttempt;
}) {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(
    () =>
      setBreadcrumbs([
        { label: "执行记录", href: "/executions" },
        { label: task.title },
      ]),
    [setBreadcrumbs, task.title],
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-6 sm:px-8 sm:py-10">
      <header className="space-y-4">
        <Link
          className="inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          to={`/requirements/${batch.id}`}
        >
          <Layers3 className="size-3.5" />
          {batch.config.title}
          <ArrowUpRight className="size-3" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {task.title}
        </h1>
        <div className="flex items-center gap-3">
          <StatusBadge
            status={attempt.status === "reserved" ? "queued" : attempt.status}
            label={
              attempt.status === "succeeded"
                ? "已交付"
                : attempt.status === "failed"
                  ? "执行失败"
                  : attempt.status === "reserved"
                    ? "等待启动"
                    : "正在执行"
            }
          />
          <span className="text-xs text-muted-foreground">
            第 {task.attempts.findIndex((a) => a.id === attempt.id) + 1} 次尝试
          </span>
          <span className="text-xs text-muted-foreground">
            {task.allowedPaths.length} 项修改范围
          </span>
        </div>
      </header>
      <details className="group border-b border-border pb-5">
        <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
          任务边界、验收标准与高级详情
        </summary>
        <MarkdownBody className="mt-3">{task.instructions}</MarkdownBody>
        <p className="mt-3 text-sm break-all">
          允许修改：{task.allowedPaths.join("、")}
        </p>
        <ul className="my-3 list-disc pl-5 text-sm">
          {task.acceptance.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
        <Link
          className="text-sm underline"
          to={`/agents/${attempt.agentId}/runs/${attempt.runId}?view=manage`}
        >
          高级运行详情
        </Link>
      </details>
      <ExecutionTrace key={attempt.id} attempt={attempt} showRunLink={false} />
    </div>
  );
}
export function WorkerRun() {
  const { runId, agentId } = useParams();
  const [search] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const manage = search.get("view") === "manage";
  const query = useQuery({
    queryKey: ["task-pool", selectedCompanyId],
    queryFn: () => taskPoolApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !manage,
    refetchInterval: 5000,
  });
  if (manage) return <AgentDetail />;
  if (query.isLoading) return <p className="p-6">正在读取执行任务…</p>;
  const matches = (query.data ?? []).flatMap((batch) =>
    batch.state.tasks.flatMap((task) =>
      task.attempts
        .filter((attempt) => attempt.runId === runId)
        .map((attempt) => ({ batch, task, attempt })),
    ),
  );
  if (matches.length === 1)
    return agentId ? (
      <Navigate to={`/executions/${runId}`} replace />
    ) : (
      <FocusedRun {...matches[0]} />
    );
  return agentId ? (
    <AgentDetail />
  ) : (
    <p role="alert" className="p-6">
      {query.error
        ? `执行任务读取失败：${String(query.error)}`
        : "当前工作区中未找到该执行记录。"}
    </p>
  );
}
