import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  FlowcodeConfigSchema,
  FlowcodeConfig,
  FlowcodeState,
} from "./schema.js";

const FLOWCODE_CONFIG_FILE = "flowcode.json";
const FLOWCODE_DIR = ".flowcode";
const STATE_FILE = "state.json";
const REPORTS_DIR = "reports";

export function getGlobalConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "flowcode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "flowcode");
}

export function getGlobalSkillsDir(): string {
  return join(getGlobalConfigDir(), "skills");
}

export function getGlobalFlowsDir(): string {
  return join(getGlobalConfigDir(), "flows");
}

export function getProjectDir(): string {
  return process.cwd();
}

export function getFlowcodeDir(): string {
  return join(getProjectDir(), FLOWCODE_DIR);
}

export function getReportsDir(): string {
  return join(getFlowcodeDir(), REPORTS_DIR);
}

export function getStatePath(): string {
  return join(getFlowcodeDir(), STATE_FILE);
}

export function getConfigPath(): string {
  return join(getProjectDir(), FLOWCODE_CONFIG_FILE);
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function resetFlowcodeDir(): void {
  const dir = getFlowcodeDir();
  if (existsSync(dir)) {
    const keep = new Set(["model.json"]);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!keep.has(entry.name)) {
        const fullPath = join(dir, entry.name);
        try {
          rmSync(fullPath, { recursive: true, force: true });
        } catch {}
      }
    }
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const reportsDir = getReportsDir();
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
}

export function loadConfig(): FlowcodeConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `flowcode.json not found at ${configPath}. Run 'flowcode init' or create config manually.`
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return FlowcodeConfigSchema.parse(raw);
}

export function loadConfigOrDefault(): FlowcodeConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

export function getDefaultFlowConfig(): FlowcodeConfig {
  return FlowcodeConfigSchema.parse({
    flows: {
      default: {
        name: "Полный флоу",
        stages: [
          {
            id: "task",
            name: "Постановка задачи",
            skills: ["task-definition"],
            allowReturn: false,
            interactive: true,
          },
          {
            id: "analysis",
            name: "Анализ",
            skills: ["analysis"],
            allowReturn: false,
          },
          {
            id: "implementation",
            name: "Реализация",
            skills: ["implementation"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "lint",
            name: "Линтеры",
            skills: ["lint"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "test",
            name: "Тестирование",
            skills: ["testing"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "review",
            name: "Ревью",
            skills: ["review"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "done",
            name: "Итоги",
            skills: ["summary"],
            allowReturn: false,
          },
        ],
      },
      "quick-fix": {
        name: "Быстрый фикс",
        stages: [
          {
            id: "task",
            name: "Постановка задачи",
            skills: ["task-definition"],
            allowReturn: false,
            interactive: true,
          },
          {
            id: "implementation",
            name: "Реализация",
            skills: ["implementation"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "lint",
            name: "Линтеры",
            skills: ["lint"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "done",
            name: "Итоги",
            skills: ["summary"],
            allowReturn: false,
          },
        ],
      },
      fast: {
        name: "Быстрый флоу (без линтеров и тестов)",
        stages: [
          {
            id: "task",
            name: "Постановка задачи",
            skills: ["task-definition"],
            allowReturn: false,
            interactive: true,
          },
          {
            id: "analysis",
            name: "Анализ",
            skills: ["analysis"],
            allowReturn: false,
          },
          {
            id: "implementation",
            name: "Реализация",
            skills: ["implementation"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "review",
            name: "Ревью",
            skills: ["review"],
            allowReturn: true,
            returnTo: "implementation",
          },
          {
            id: "done",
            name: "Итоги",
            skills: ["summary"],
            allowReturn: false,
          },
        ],
      },
    },
    maxRetries: 3,
    retryTimeout: 300000,
  });
}

export function initDefaultConfig(): void {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    return;
  }
  const defaultConfig = getDefaultFlowConfig();
  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
}

export function loadState(): FlowcodeState | null {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    return raw as FlowcodeState;
  } catch {
    return null;
  }
}

export function saveState(state: FlowcodeState): void {
  const flowcodeDir = getFlowcodeDir();
  if (!existsSync(flowcodeDir)) {
    mkdirSync(flowcodeDir, { recursive: true });
  }
  const reportsDir = getReportsDir();
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

export function clearState(): void {
  const statePath = getStatePath();
  if (existsSync(statePath)) {
    unlinkSync(statePath);
  }
}

export function createInitialState(flowName: string): FlowcodeState {
  return {
    currentFlow: flowName,
    currentStageIndex: 0,
    checklist: { items: [] },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryCount: 0,
    status: "running",
  };
}

export function resolveFlow(config: FlowcodeConfig, flowName: string) {
  const flow = config.flows[flowName];
  if (!flow) {
    const available = Object.keys(config.flows).join(", ");
    throw new Error(`Flow "${flowName}" not found. Available: ${available}`);
  }
  return flow;
}

export function getFlowNames(config: FlowcodeConfig): string[] {
  return Object.keys(config.flows);
}

export function listAvailableFlows(config: FlowcodeConfig): Array<{
  name: string;
  displayName: string;
  stageCount: number;
}> {
  return Object.entries(config.flows).map(([key, flow]) => ({
    name: key,
    displayName: flow.name,
    stageCount: flow.stages.length,
  }));
}
