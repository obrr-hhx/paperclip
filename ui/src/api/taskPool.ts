import type { PoolState } from "@paperclipai/shared";
import { api } from "./client";

export interface TaskPoolBatch {
  id: string;
  companyId: string;
  issueId: string;
  config: {
    title: string;
    requirement: string;
    repository: string;
    baseSha: string;
    concurrency: number;
  };
  state: PoolState;
  createdAt: string;
  updatedAt: string;
}
export const taskPoolApi = {
  list: (companyId: string) =>
    api.get<TaskPoolBatch[]>(`/companies/${companyId}/task-pool`),
  get: (id: string) => api.get<TaskPoolBatch>(`/task-pool/${id}`),
};
