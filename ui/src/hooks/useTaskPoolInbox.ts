import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { taskPoolApi } from "../api/taskPool";
import { poolInboxState } from "../lib/task-pool-inbox";
export function useTaskPoolInbox(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["task-pool", companyId],
    queryFn: () => taskPoolApi.list(companyId!),
    enabled: !!companyId,
    refetchInterval: 5000,
    staleTime: 3000,
  });
  const state = useMemo(() => poolInboxState(query.data ?? []), [query.data]);
  return { ...state, error: query.error, loading: query.isLoading };
}
