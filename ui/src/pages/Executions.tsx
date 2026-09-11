import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { taskPoolApi } from "../api/taskPool";
import { poolExecutions } from "../lib/task-pool";
import { relativeTime } from "../lib/utils";
import { Button } from "../components/ui/button";

export function Executions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeOnly, setActiveOnly] = useState(false);
  const query = useQuery({
    queryKey: ["task-pool", selectedCompanyId],
    queryFn: () => taskPoolApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });
  useEffect(() => setBreadcrumbs([{ label: "执行记录" }]), [setBreadcrumbs]);
  const executions = useMemo(
    () =>
      poolExecutions(query.data ?? []).filter(
        ({ attempt }) =>
          !activeOnly || ["running", "reserved"].includes(attempt.status),
      ),
    [query.data, activeOnly],
  );
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">执行记录</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            按需求和任务追踪每次 worker
            尝试。运行中的任务排在前面，历史记录持续保留。
          </p>
        </div>
        <Button variant="outline" onClick={() => setActiveOnly(!activeOnly)}>
          {activeOnly ? "显示全部历史" : "只看执行中"}
        </Button>
      </header>
      {!selectedCompanyId && <p>请先选择工作区。</p>}
      {query.isLoading && <p>正在读取执行记录…</p>}
      {query.error && (
        <p role="alert" className="text-destructive">
          执行记录读取失败：{String(query.error)}
        </p>
      )}
      {query.isSuccess && !executions.length && (
        <p className="text-muted-foreground">
          {activeOnly ? "当前没有运行中的任务。" : "尚无 worker 执行记录。"}
        </p>
      )}
      {executions.map(({ batch, task, attempt, number }) => (
        <Link
          key={attempt.id}
          to={
            attempt.runId
              ? `/executions/${attempt.runId}`
              : `/requirements/${batch.id}?attempt=${attempt.id}`
          }
          className="block rounded-xl border border-border p-4 hover:bg-accent"
        >
          <p className="text-xs text-muted-foreground">{batch.config.title}</p>
          <div className="mt-2 flex flex-wrap justify-between gap-3">
            <h2 className="font-semibold">{task.title}</h2>
            <span className="text-sm">
              第 {number} 次 ·{" "}
              {attempt.status === "succeeded"
                ? "已交付"
                : attempt.status === "failed"
                  ? "失败"
                  : attempt.status === "reserved"
                    ? "待启动"
                    : "执行中"}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            启动于 {relativeTime(attempt.startedAt)} ·
            查看工具调用、输出与交付结果
          </p>
          {attempt.error && (
            <p className="mt-2 text-sm text-destructive line-clamp-2">
              {attempt.error}
            </p>
          )}
        </Link>
      ))}
    </div>
  );
}
