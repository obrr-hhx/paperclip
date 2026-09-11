import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { taskPoolApi } from "../api/taskPool";
import {
  poolStatusLabels,
  taskStatusLabels,
  taskWaitReason,
} from "../lib/task-pool";
import { MarkdownBody } from "../components/MarkdownBody";
import { ExecutionTrace } from "../components/task-pool/ExecutionTrace";
import { Button } from "../components/ui/button";

export function Requirements() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [all, setAll] = useState(false);
  const query = useQuery({
    queryKey: ["task-pool", selectedCompanyId],
    queryFn: () => taskPoolApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });
  useEffect(() => setBreadcrumbs([{ label: "需求" }]), [setBreadcrumbs]);
  const batches = (query.data ?? []).filter(
    (batch) => all || batch.state.status !== "accepted",
  );
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">需求</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            规划者发布需求与任务，后台调度 worker，交付后独立验收。每 5 秒更新。
          </p>
        </div>
        <Button variant="outline" onClick={() => setAll(!all)}>
          {all ? "隐藏已验收" : "包含已验收"}
        </Button>
      </header>
      {!selectedCompanyId && <p>请先选择工作区。</p>}
      {query.isLoading && <p>正在读取需求…</p>}
      {query.error && (
        <p role="alert" className="text-destructive">
          需求读取失败：{String(query.error)}
        </p>
      )}
      {query.isSuccess && !batches.length && (
        <p className="text-muted-foreground">
          暂无{all ? "" : "未验收的"}需求。通过 paperclip-planner skill
          发布后，会出现在这里。
        </p>
      )}
      {batches.map((batch) => (
        <Link
          key={batch.id}
          to={`/requirements/${batch.id}`}
          className="block rounded-xl border border-border p-5 transition-colors hover:bg-accent focus-visible:outline-ring"
        >
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="font-semibold">{batch.config.title}</h2>
            <span className="text-sm text-muted-foreground">
              {poolStatusLabels[batch.state.status]}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground break-all">
            {batch.config.repository}
          </p>
          <p className="mt-4 text-sm">
            已交付{" "}
            {batch.state.tasks.filter((t) => t.status === "succeeded").length} /{" "}
            {batch.state.tasks.length} · 执行中{" "}
            {batch.state.tasks.filter((t) => t.status === "running").length} ·
            受阻{" "}
            {batch.state.tasks.filter((t) => t.status === "blocked").length}
          </p>
        </Link>
      ))}
    </div>
  );
}

export function RequirementDetail() {
  const { batchId } = useParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const query = useQuery({
    queryKey: ["task-pool-detail", selectedCompanyId, batchId],
    queryFn: () => taskPoolApi.get(batchId!),
    enabled: !!batchId && !!selectedCompanyId,
    refetchInterval: 5000,
  });
  const batch =
    query.data?.companyId === selectedCompanyId ? query.data : undefined;
  useEffect(
    () =>
      setBreadcrumbs([
        { label: "需求", href: "/requirements" },
        { label: batch?.config.title ?? "需求详情" },
      ]),
    [batch?.config.title, setBreadcrumbs],
  );
  if (query.isLoading) return <p className="p-6">正在读取需求…</p>;
  if (query.error || !batch)
    return (
      <p role="alert" className="p-6">
        {query.error
          ? `需求读取失败：${String(query.error)}`
          : "当前工作区中未找到该需求。"}
      </p>
    );
  const chosen =
    batch.state.tasks.find((t) =>
      t.attempts.some((a) => a.id === params.get("attempt")),
    ) ??
    batch.state.tasks.find((t) => t.key === params.get("task")) ??
    batch.state.tasks.find((t) => t.status === "running") ??
    batch.state.tasks.find((t) => t.status === "blocked") ??
    batch.state.tasks[0];
  const attempt =
    chosen?.attempts.find((a) => a.id === params.get("attempt")) ??
    chosen?.attempts.at(-1);
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <header>
        <div className="flex flex-wrap justify-between gap-3">
          <h1 className="text-2xl font-semibold">{batch.config.title}</h1>
          <span>{poolStatusLabels[batch.state.status]}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground break-all">
          {batch.config.repository} · 并发上限 {batch.config.concurrency}
        </p>
        <Link className="text-sm underline" to={`/issues/${batch.issueId}`}>
          需求任务卡与讨论
        </Link>
      </header>
      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer font-medium">需求说明</summary>
        <MarkdownBody className="mt-4">{batch.config.requirement}</MarkdownBody>
      </details>
      {batch.state.status === "ready_for_review" && (
        <p className="rounded-lg bg-muted p-4">
          所有任务已交付，等待 Codex / Claude Code 独立验收。尚未合并。
        </p>
      )}
      {batch.state.candidate && (
        <details className="text-sm">
          <summary className="cursor-pointer">验收候选提交</summary>
          <p className="break-all">{batch.state.candidate.commit}</p>
          <p className="break-all text-muted-foreground">
            {batch.state.candidate.cwd}
          </p>
        </details>
      )}
      <div className="grid gap-6 lg:grid-cols-4">
        <aside className="space-y-2 lg:col-span-1" aria-label="需求任务">
          <h2 className="font-semibold">任务与依赖</h2>
          {batch.state.tasks.map((task) => (
            <button
              key={task.key}
              onClick={() => setParams({ task: task.key })}
              aria-pressed={chosen?.key === task.key}
              className={`w-full rounded-lg border p-3 text-left ${chosen?.key === task.key ? "border-ring bg-accent" : "border-border hover:bg-accent"}`}
            >
              <p className="font-medium">{task.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {taskStatusLabels[task.status]} · {task.attempts.length} 次尝试
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {taskWaitReason(task, batch) ??
                  (task.dependsOn.length
                    ? `依赖：${task.dependsOn.join("、")}`
                    : "无前置依赖")}
              </p>
            </button>
          ))}
        </aside>
        {chosen && (
          <section className="min-w-0 space-y-5 lg:col-span-3">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="text-lg font-semibold">{chosen.title}</h2>
              <Link
                className="text-sm underline"
                to={`/issues/${chosen.issueId}`}
              >
                任务卡
              </Link>
            </div>
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer">执行边界与验收标准</summary>
              <MarkdownBody className="mt-3">
                {chosen.instructions}
              </MarkdownBody>
              <p className="mt-3 text-sm break-all">
                允许修改：{chosen.allowedPaths.join("、")}
              </p>
              <ul className="mt-3 list-disc pl-5 text-sm">
                {chosen.acceptance.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </details>
            {chosen.attempts.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-2" aria-label="执行尝试">
                  {chosen.attempts.map((item, index) => (
                    <Button
                      key={item.id}
                      variant={
                        item.id === attempt?.id ? "secondary" : "outline"
                      }
                      size="sm"
                      onClick={() => setParams({ attempt: item.id })}
                    >
                      第 {index + 1} 次 ·{" "}
                      {item.status === "succeeded"
                        ? "已交付"
                        : item.status === "failed"
                          ? "失败"
                          : item.status === "reserved"
                            ? "待启动"
                            : "执行中"}
                    </Button>
                  ))}
                </div>
                {attempt && (
                  <ExecutionTrace key={attempt.id} attempt={attempt} />
                )}
              </>
            ) : (
              <p className="rounded-lg bg-muted p-4 text-sm">
                {taskWaitReason(chosen, batch) ?? "尚无执行记录"}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
