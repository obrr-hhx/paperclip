import { pgTable, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import type { PoolState } from "@paperclipai/shared";
export const taskPoolBatches = pgTable("task_pool_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  config: jsonb("config").$type<{ title: string; requirement: string; repository: string; baseRef: string; baseSha: string; templateAgentId: string; projectId?: string; concurrency: number; maxAttempts: number; originSession?: string }>().notNull(),
  state: jsonb("state").$type<PoolState>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ companyIdx: index("task_pool_batches_company_idx").on(table.companyId) }));
