import { z } from "zod";

export const StageConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  skills: z.array(z.string()).default([]),
  allowReturn: z.boolean().default(false),
  returnTo: z.string().optional(),
  interactive: z.boolean().default(false),
});

export const FlowConfigSchema = z.object({
  name: z.string(),
  stages: z.array(StageConfigSchema),
});

export const FlowcodeConfigSchema = z.object({
  flows: z.record(z.string(), FlowConfigSchema),
  maxRetries: z.number().default(3),
  retryTimeout: z.number().default(300000),
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type FlowConfig = z.infer<typeof FlowConfigSchema>;
export type FlowcodeConfig = z.infer<typeof FlowcodeConfigSchema>;

export const StageActionSchema = z.object({
  action: z.enum(["complete", "restart", "return"]),
  summary: z.string(),
  returnTo: z.string().optional(),
  issues: z.array(z.string()).default([]),
  checklist: z.array(z.string()).optional(),
});

export type StageAction = z.infer<typeof StageActionSchema>;

export interface ChecklistItem {
  id: number;
  task: string;
  status: "pending" | "in_progress" | "done" | "skipped";
}

export interface Checklist {
  items: ChecklistItem[];
}

export interface ReturnContext {
  fromStageId: string;
  fromStageName: string;
  issues: string[];
  gitDiffFiles: string[];
}

export interface FlowcodeState {
  currentFlow: string;
  currentStageIndex: number;
  checklist: Checklist;
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
  retryCount: number;
  status: "running" | "paused" | "completed" | "error";
  errorMessage?: string;
  returnContext?: ReturnContext;
}

export interface StageReport {
  stageId: string;
  stageName: string;
  stageIndex: number;
  timestamp: string;
  summary: string;
  fullResponse: string;
  filesChanged: string[];
  issues: string[];
  action: StageAction;
}

export interface QualityGateResult {
  approved: boolean;
  comment?: string;
  rollback: boolean;
}
