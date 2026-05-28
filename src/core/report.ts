import {
  FlowcodeState,
  StageConfig,
  StageAction,
  StageReport,
  Checklist,
  ChecklistItem,
} from "../config/schema.js";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { getReportsDir, getFlowcodeDir, getStatePath, saveState } from "../config/loader.js";

const CHECKLIST_FILE = "checklist.json";
const REPORTS_SUBDIR = "reports";

export function getChecklistPath(): string {
  return join(getFlowcodeDir(), CHECKLIST_FILE);
}

export function loadChecklist(): Checklist {
  const path = getChecklistPath();
  if (!existsSync(path)) {
    return { items: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveChecklist(checklist: Checklist): void {
  const dir = getFlowcodeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getChecklistPath(), JSON.stringify(checklist, null, 2), "utf-8");
}

export function updateChecklistItem(
  checklist: Checklist,
  id: number,
  status: ChecklistItem["status"]
): Checklist {
  return {
    items: checklist.items.map((item) =>
      item.id === id ? { ...item, status } : item
    ),
  };
}

export function addChecklistItems(
  checklist: Checklist,
  tasks: string[]
): Checklist {
  const maxId = checklist.items.reduce((max, item) => Math.max(max, item.id), 0);
  const newItems: ChecklistItem[] = tasks.map((task, index) => ({
    id: maxId + index + 1,
    task,
    status: "pending" as const,
  }));
  return { items: [...checklist.items, ...newItems] };
}

export function getNextPendingItem(checklist: Checklist): ChecklistItem | null {
  return checklist.items.find((item) => item.status === "pending") ?? null;
}

export function getNextInProgressItem(checklist: Checklist): ChecklistItem | null {
  return checklist.items.find((item) => item.status === "in_progress") ?? null;
}

export function getChecklistProgress(checklist: Checklist): {
  total: number;
  done: number;
  skipped: number;
  pending: number;
} {
  return {
    total: checklist.items.length,
    done: checklist.items.filter((i) => i.status === "done").length,
    skipped: checklist.items.filter((i) => i.status === "skipped").length,
    pending: checklist.items.filter((i) => i.status === "pending").length,
  };
}

export function saveReport(stageIndex: number, stageId: string, report: StageReport): void {
  const reportsDir = getReportsDir();
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  const prefix = String(stageIndex + 1).padStart(2, "0");
  const mdPath = join(reportsDir, `${prefix}-${stageId}.md`);
  const jsonPath = join(reportsDir, `${prefix}-${stageId}.json`);

  const mdContent = `# ${report.stageName}

**Stage:** ${report.stageId}
**Timestamp:** ${report.timestamp}

## Summary
${report.summary}

## Files Changed
${report.filesChanged.length > 0 ? report.filesChanged.map((f) => `- ${f}`).join("\n") : "No files changed."}

## Issues
${report.issues.length > 0 ? report.issues.map((i) => `- ${i}`).join("\n") : "No issues."}
`;

  writeFileSync(mdPath, mdContent, "utf-8");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
}

export function loadReport(stageIndex: number, stageId: string): StageReport | null {
  const reportsDir = getReportsDir();
  const prefix = String(stageIndex + 1).padStart(2, "0");
  const jsonPath = join(reportsDir, `${prefix}-${stageId}.json`);
  if (!existsSync(jsonPath)) {
    return null;
  }
  return JSON.parse(readFileSync(jsonPath, "utf-8"));
}

export function loadAllReports(): StageReport[] {
  const reportsDir = getReportsDir();
  if (!existsSync(reportsDir)) {
    return [];
  }
  const files = readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) =>
    JSON.parse(readFileSync(join(reportsDir, f), "utf-8"))
  );
}

export function buildContextFromReports(reports: StageReport[]): string {
  if (reports.length === 0) {
    return "";
  }
  return reports
    .map((r) => {
      let ctx = `## ${r.stageName} (${r.stageId})\n${r.summary}`;
      if (r.filesChanged.length > 0) {
        ctx += `\nFiles changed: ${r.filesChanged.join(", ")}`;
      }
      if (r.issues.length > 0) {
        ctx += `\nIssues:\n${r.issues.map((i) => `- ${i}`).join("\n")}`;
      }
      return ctx;
    })
    .join("\n\n");
}

export function cleanupOldReports(keepStageIndex: number): void {
  const reportsDir = getReportsDir();
  if (!existsSync(reportsDir)) {
    return;
  }
  const keepPrefix = String(keepStageIndex + 1).padStart(2, "0");
  const files = readdirSync(reportsDir);
  for (const file of files) {
    if (!file.startsWith(keepPrefix)) {
      unlinkSync(join(reportsDir, file));
    }
  }
}
