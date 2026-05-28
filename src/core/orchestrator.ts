import {
  FlowcodeState,
  FlowcodeConfig,
  StageConfig,
  StageAction,
  StageReport,
  QualityGateResult,
  Checklist,
  ReturnContext,
} from "../config/schema.js";
import {
  loadConfig,
  resolveFlow,
  createInitialState,
  saveState,
  loadState,
  getFlowcodeDir,
  configExists,
} from "../config/loader.js";
import { ServerManager } from "../opencode/server.js";
import { loadSkillsForStage } from "../skills/loader.js";
import {
  saveReport,
  loadAllReports,
  buildContextFromReports,
  loadChecklist,
  saveChecklist,
  getNextPendingItem,
  getNextInProgressItem,
  getChecklistProgress,
} from "./report.js";
import { StageActionSchema } from "../config/schema.js";
import {
  scanConventions,
  loadConventions,
  buildConventionsPrompt,
  getGitDiffFiles,
  getGitDiffContent,
  ProjectConventions,
} from "./conventions.js";
import { EventEmitter } from "node:events";
import { mkdirSync, existsSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { execSync } from "node:child_process";

function log(msg: string): void {
  const logPath = join(process.cwd(), ".flowcode", "debug.log");
  const dir = join(process.cwd(), ".flowcode");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
}

export type OrchestratorEvent =
  | { type: "stage:start"; stageIndex: number; stage: StageConfig }
  | { type: "stage:progress"; stageIndex: number; message: string }
  | { type: "stage:complete"; stageIndex: number; action: StageAction }
  | { type: "stage:error"; stageIndex: number; error: Error }
  | { type: "quality:gate"; stageIndex: number; report: StageReport }
  | { type: "quality:approved"; stageIndex: number }
  | { type: "quality:rejected"; stageIndex: number; comment: string }
  | { type: "flow:complete" }
  | { type: "flow:error"; error: Error }
  | { type: "flow:paused" }
  | { type: "flow:resumed" }
  | { type: "user:message"; message: string }
  | { type: "agent:message"; message: string }
  | { type: "agent:thinking" }
  | { type: "agent:tool-call"; tool: string; input?: string }
  | { type: "agent:tool-result"; tool: string; output?: string }
  | { type: "checklist:update"; checklist: Checklist };

export class Orchestrator extends EventEmitter {
  private config: FlowcodeConfig;
  private state: FlowcodeState;
  private serverManager: ServerManager;
  private flowName: string;
  private paused = false;
  private interactiveMode = false;
  private interactiveResolve: ((action: StageAction) => void) | null = null;
  private stageExecuting = false;
  private interactiveStageIndex: number = -1;
  private interactiveStage: StageConfig | null = null;
  private interactiveFirstMessage = true;
  private conventions: ProjectConventions | null = null;

  constructor(flowName: string = "default") {
    super();
    this.config = loadConfig();
    this.flowName = flowName;
    this.serverManager = new ServerManager();

    const existingState = loadState();
    if (existingState && existingState.currentFlow === flowName && existingState.status !== "completed") {
      const flow = resolveFlow(this.config, flowName);
      if (existingState.currentStageIndex >= flow.stages.length) {
        log(`State stage ${existingState.currentStageIndex} out of range, resetting`);
        this.state = createInitialState(flowName);
      } else if (existingState.currentStageIndex > 0 && existingState.status === "error") {
        log(`State has error, resetting to 0`);
        this.state = createInitialState(flowName);
      } else {
        this.state = existingState;
        this.emit("flow:resumed");
      }
    } else {
      this.state = createInitialState(flowName);
    }
  }

  async start(): Promise<void> {
    this.ensureFlowcodeDir();
    log("Orchestrator.start() — subprocess mode");
    await this.serverManager.start();

    try {
      this.conventions = scanConventions();
      log(`Conventions scanned: ${this.conventions.language}, ${this.conventions.buildTool}, ${this.conventions.modules.length} modules`);
    } catch (e) {
      log(`Conventions scan failed: ${e}`);
    }

    try {
      await this.runFlow();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(`Flow error: ${error.message}`);
      this.state.status = "error";
      this.state.errorMessage = error.message;
      saveState(this.state);
      this.emit("flow:error", error);
    }
  }

  async stop(): Promise<void> {
    this.paused = true;
    this.state.status = "paused";
    saveState(this.state);
    this.emit("flow:paused");
    await this.serverManager.stop();
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.state.status = "running";
    saveState(this.state);
    await this.serverManager.start();
    this.emit("flow:resumed");
    try {
      await this.runFlow();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.state.status = "error";
      this.state.errorMessage = error.message;
      saveState(this.state);
      this.emit("flow:error", error);
    }
  }

  private async runFlow(): Promise<void> {
    const flow = resolveFlow(this.config, this.flowName);
    const startIndex = this.state.currentStageIndex;

    for (let i = startIndex; i < flow.stages.length; i++) {
      if (this.paused) return;

      const stage = flow.stages[i];
      this.state.currentStageIndex = i;
      saveState(this.state);

      log(`runFlow: stage ${i} "${stage.name}" interactive=${stage.interactive}`);
      this.emit("stage:start", i, stage);

      try {
        const action = await this.executeStage(i, stage);
        this.emit("stage:complete", i, action);

        if (action.action === "return" && action.returnTo) {
          const returnIndex = flow.stages.findIndex((s) => s.id === action.returnTo);
          if (returnIndex >= 0) {
            this.state.returnContext = {
              fromStageId: stage.id,
              fromStageName: stage.name,
              issues: action.issues,
              gitDiffFiles: getGitDiffFiles(),
            };
            log(`Return context set: from=${stage.id}, issues=${action.issues.length}, gitFiles=${this.state.returnContext.gitDiffFiles.length}`);
            this.state.currentStageIndex = returnIndex;
            saveState(this.state);
            i = returnIndex - 1;
            continue;
          }
        }

        if (action.action === "restart") {
          i = i - 1;
          continue;
        }

        const report = this.buildStageReport(i, stage, action);
        saveReport(i, stage.id, report);

        if (i < flow.stages.length - 1) {
          const gateResult = await this.runQualityGate(i, report);
          if (!gateResult.approved) {
            if (gateResult.rollback) {
              const rollbackIndex = Math.max(0, i - 1);
              this.state.currentStageIndex = rollbackIndex;
              saveState(this.state);
              i = rollbackIndex - 1;
              continue;
            } else {
              i = i - 1;
              continue;
            }
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit("stage:error", i, error);

        this.state.retryCount++;
        saveState(this.state);

        if (this.state.retryCount >= this.config.maxRetries) {
          this.state.status = "error";
          this.state.errorMessage = `Stage "${stage.name}" failed after ${this.config.maxRetries} retries: ${error.message}`;
          saveState(this.state);
          this.emit("flow:error", error);
          return;
        }

        i = i - 1;
        continue;
      }

      this.state.retryCount = 0;
      saveState(this.state);
    }

    this.state.status = "completed";
    saveState(this.state);
    this.emit("flow:complete");
  }

  private async executeStage(
    stageIndex: number,
    stage: StageConfig
  ): Promise<StageAction> {
    log(`Stage "${stage.name}" interactive=${stage.interactive}`);

    if (stage.interactive) {
      this.serverManager.resetSession();
      this.emit("stage:progress", stageIndex, `Waiting for your input...`);
      this.emit("agent:message", `Stage "${stage.name}" is ready. Type your message to begin.`);
      log(`Interactive mode: waiting for user input on "${stage.name}"`);
      return this.startInteractiveMode(stageIndex, stage);
    }

    this.serverManager.resetSession();
    const prompt = await this.buildStagePrompt(stageIndex, stage);
    this.emit("stage:progress", stageIndex, `Running agent...`);
    this.emit("agent:thinking");

    const result = await this.serverManager.runPrompt(prompt);
    log(`Stage "${stage.name}" exitCode=${result.exitCode} responseLen=${result.text.length}`);

    const responseText = parseRunOutput(result.text);

    if (responseText) {
      this.emit("agent:message", responseText);
    }

    const action = parseStageAction(responseText);
    if (action) {
      log(`Parsed action: ${action.action} for stage "${stage.name}"`);
      return action;
    }

    if (responseText.length < 20) {
      this.state.retryCount++;
      log(`Stage "${stage.name}" returned empty/short response (${responseText.length} chars), retry ${this.state.retryCount}`);
      saveState(this.state);
      if (this.state.retryCount >= this.config.maxRetries) {
        log(`Max retries reached for "${stage.name}", completing as error`);
        return {
          action: "complete",
          summary: `Stage "${stage.name}" produced no usable output after ${this.config.maxRetries} retries`,
          issues: [`empty/short response: "${responseText.slice(0, 50)}"`],
        };
      }
      this.emit("stage:progress", stageIndex, `Empty response, retrying (${this.state.retryCount}/${this.config.maxRetries})...`);
      return this.executeStage(stageIndex, stage);
    }

    log(`No action parsed, completing stage "${stage.name}" as complete`);
    return {
      action: "complete",
      summary: responseText.slice(0, 500),
      issues: [],
    };
  }

  private startInteractiveMode(stageIndex: number, stage: StageConfig): Promise<StageAction> {
    this.interactiveMode = true;
    this.stageExecuting = true;
    this.interactiveStageIndex = stageIndex;
    this.interactiveStage = stage;
    this.interactiveFirstMessage = true;
    this.emit("stage:interactive", true);

    return new Promise<StageAction>((resolve) => {
      this.interactiveResolve = resolve;
    });
  }

  private checkInteractiveComplete(responseText: string): boolean {
    if (!this.interactiveMode || !this.interactiveResolve) return false;

    const action = parseStageAction(responseText);
    if (action) {
      this.interactiveMode = false;
      this.stageExecuting = false;
      this.emit("stage:interactive", false);
      this.interactiveResolve(action);
      this.interactiveResolve = null;
      return true;
    }
    return false;
  }

  private async buildStagePrompt(
    stageIndex: number,
    stage: StageConfig
  ): Promise<string> {
    const skillsContent = loadSkillsForStage(stage.skills);
    const previousReports = loadAllReports();
    const context = buildContextFromReports(previousReports);
    const checklist = loadChecklist();

    const isDiffReturn = this.state.returnContext
      && this.state.returnContext.fromStageId !== stage.id
      && stage.id === "implementation";

    let prompt = `# FLOWCODE STAGE: ${stage.name}\n\n`;
    prompt += `You are executing stage "${stage.name}" (ID: ${stage.id}) in a flowcode pipeline.\n\n`;

    if (stage.interactive) {
      prompt += `## MODE: INTERACTIVE\nYou are in interactive mode. Ask the user questions to understand the task. When you have a clear understanding, set action to "complete" with a detailed summary.\n\n`;
    }

    if (this.conventions) {
      prompt += buildConventionsPrompt(this.conventions) + "\n\n";
    }

    if (skillsContent) {
      prompt += `## SKILLS (loaded for this stage)\n${skillsContent}\n\n`;
    }

    if (isDiffReturn && this.state.returnContext) {
      const rc = this.state.returnContext;
      prompt += `## FIX REQUIRED — returning from ${rc.fromStageName}\n\n`;
      prompt += `The previous stage "${rc.fromStageName}" found issues that need fixing in YOUR code.\n\n`;
      if (rc.issues.length > 0) {
        prompt += `### Issues to fix:\n`;
        for (const issue of rc.issues) {
          prompt += `- ${issue}\n`;
        }
        prompt += "\n";
      }
      const diffContent = getGitDiffContent();
      if (diffContent) {
        prompt += `### Current git diff (your recent changes):\n\`\`\`diff\n${diffContent}\n\`\`\`\n\n`;
      } else if (rc.gitDiffFiles.length > 0) {
        prompt += `### Files with changes:\n${rc.gitDiffFiles.map(f => `- ${f}`).join("\n")}\n\n`;
      }
      prompt += `**IMPORTANT:** Fix ONLY the listed issues. Do NOT re-explore the project, do NOT re-read files that haven't changed. Use the conventions and context above.\n\n`;
    } else if (context) {
      prompt += `## CONTEXT FROM PREVIOUS STAGES\n${context}\n\n`;
    }

    if (checklist.items.length > 0) {
      const progress = getChecklistProgress(checklist);
      prompt += `## CHECKLIST (Progress: ${progress.done}/${progress.total} done)\n`;
      for (const item of checklist.items) {
        const icon =
          item.status === "done"
            ? "[x]"
            : item.status === "in_progress"
            ? "[>]"
            : item.status === "skipped"
            ? "[-]"
            : "[ ]";
        prompt += `${icon} ${item.task}\n`;
      }
      const nextItem = getNextInProgressItem(checklist) ?? getNextPendingItem(checklist);
      if (nextItem) {
        prompt += `\n**Current task:** ${nextItem.task}\n`;
      }
      prompt += `\nIf you completed a checklist task, set action to "restart" to move to the next task.\nIf all tasks are done, set action to "complete".\n\n`;
    }

    if (stage.allowReturn && stage.returnTo) {
      prompt += `## RETURN POLICY\nThis stage CAN return to previous stage "${stage.returnTo}". If you detect an issue that requires rework in "${stage.returnTo}", set action to "return" and returnTo to "${stage.returnTo}".\n\n`;
    }

    if (stage.interactive) {
      prompt += `## RESPONSE FORMAT\nYou are in a CONVERSATION with the user. Follow these rules:\n\n1. ALWAYS offer the user numbered choices at the end of your message. Format:\nOPTIONS:\n1. First choice\n2. Second choice\n3. Third choice\n\n2. Keep options short (one line each). Offer 2-5 choices relevant to the current context.\n\n3. When the conversation is complete and the task is fully defined, end your response with:\n\`\`\`json\n{"action": "complete", "summary": "Task: ..."}\n\`\`\`\n\nDo NOT include JSON until you and the user have agreed on the task.\n`;
    } else {
      prompt += `## RESPONSE FORMAT\nYou MUST respond with a valid JSON object:\n- action: "complete" (stage done), "restart" (re-run for next task), or "return" (go back)\n- summary: What was accomplished\n- issues: List of problems found (if any)\n\nIMPORTANT: Do your work FIRST using available tools, THEN provide the structured output as your final action.\n`;
    }

    if (isDiffReturn) {
      this.state.returnContext = undefined;
      saveState(this.state);
    }

    return prompt;
  }

  private buildStageReport(
    stageIndex: number,
    stage: StageConfig,
    action: StageAction
  ): StageReport {
    let filesChanged: string[] = action.issues.length > 0 ? [] : getGitDiffFiles();
    return {
      stageId: stage.id,
      stageName: stage.name,
      stageIndex,
      timestamp: new Date().toISOString(),
      summary: action.summary,
      filesChanged,
      issues: action.issues,
      action,
    };
  }

  private async runQualityGate(
    stageIndex: number,
    report: StageReport
  ): Promise<QualityGateResult> {
    this.emit("quality:gate", stageIndex, report);

    return new Promise<QualityGateResult>((resolve) => {
      const onApproved = () => {
        this.removeListener(`quality:reject:${stageIndex}`, onRejected);
        resolve({ approved: true, rollback: false });
      };

      const onRejected = (comment: string, rollback: boolean) => {
        this.removeListener(`quality:approve:${stageIndex}`, onApproved);
        resolve({ approved: false, comment, rollback });
      };

      this.once(`quality:approve:${stageIndex}`, onApproved);
      this.on(`quality:reject:${stageIndex}`, onRejected);
    });
  }

  approveStage(stageIndex: number): void {
    this.emit("quality:approve", stageIndex);
    this.emit(`quality:approve:${stageIndex}`);
  }

  rejectStage(stageIndex: number, comment: string, rollback: boolean = false): void {
    this.emit("quality:reject", stageIndex, comment);
    this.emit(`quality:reject:${stageIndex}`, comment, rollback);
  }

  async sendUserMessage(message: string): Promise<void> {
    this.emit("user:message", message);
    if (!this.interactiveMode) return;

    this.emit("agent:thinking");
    log(`sendUserMessage: "${message.slice(0, 80)}" first=${this.interactiveFirstMessage}`);

    let textToSend = message;
    let continueSession = false;
    if (this.interactiveFirstMessage && this.interactiveStage) {
      this.interactiveFirstMessage = false;
      const stagePrompt = await this.buildStagePrompt(this.interactiveStageIndex, this.interactiveStage!);
      textToSend = `${stagePrompt}\n\n## USER MESSAGE\n${message}`;
      log(`First interactive message, prompt length: ${textToSend.length}`);
    } else {
      continueSession = true;
      log(`Continuing session`);
    }

    try {
      const result = await this.serverManager.runPrompt(textToSend, continueSession);
      const responseText = parseRunOutput(result.text);
      log(`Interactive response (${responseText.length} chars)`);

      if (this.checkInteractiveComplete(responseText)) return;

      if (responseText) {
        this.emit("agent:message", responseText);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`sendUserMessage ERROR: ${errorMsg}`);
      this.emit("agent:message", `[Error] ${errorMsg}`);
      this.emit("agent:thinking", false);
    }
  }

  async sendUserMessageWithContext(message: string, filePaths: string[]): Promise<void> {
    this.emit("user:message", message);
    if (!this.interactiveMode) return;

    this.emit("agent:thinking");

    let textToSend = message;
    let continueSession = false;
    if (this.interactiveFirstMessage && this.interactiveStage) {
      this.interactiveFirstMessage = false;
      const stagePrompt = await this.buildStagePrompt(this.interactiveStageIndex, this.interactiveStage!);
      textToSend = `${stagePrompt}\n\n## USER MESSAGE\n${message}`;
    } else {
      continueSession = true;
    }

    const fileContext = filePaths.map(fp => `\n--- File: ${fp} ---\n`).join("\n");
    const fullPrompt = fileContext ? `${textToSend}\n\nReferenced files:${fileContext}` : textToSend;

    try {
      const result = await this.serverManager.runPrompt(fullPrompt, continueSession);
      const responseText = parseRunOutput(result.text);

      if (this.checkInteractiveComplete(responseText)) return;

      if (responseText) {
        this.emit("agent:message", responseText);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit("agent:message", `[Error] ${errorMsg}`);
    }
  }

  updateChecklist(checklist: Checklist): void {
    saveChecklist(checklist);
    this.state.checklist = checklist;
    saveState(this.state);
    this.emit("checklist:update", checklist);
  }

  private ensureFlowcodeDir(): void {
    const dir = getFlowcodeDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  getState(): FlowcodeState {
    return { ...this.state };
  }

  getCurrentStage(): StageConfig | null {
    const flow = resolveFlow(this.config, this.flowName);
    if (this.state.currentStageIndex < flow.stages.length) {
      return flow.stages[this.state.currentStageIndex];
    }
    return null;
  }

  getFlowStages(): StageConfig[] {
    const flow = resolveFlow(this.config, this.flowName);
    return flow.stages;
  }

  isAgentWorking(): boolean {
    return this.stageExecuting && !this.paused;
  }

  async getModelInfo(): Promise<string> {
    try {
      return await this.serverManager.getModelInfo();
    } catch (e) {
      return `err: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

export function scanProjectFiles(query: string, maxResults: number = 10): string[] {
  const cwd = process.cwd();
  const results: string[] = [];
  const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", ".flowcode", "__pycache__", ".gradle", ".idea", ".vs"]);

  function walk(dir: string, depth: number) {
    if (depth > 5 || results.length >= maxResults * 3) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults * 3) break;
        if (entry.name.startsWith(".") && entry.name !== ".flowcode") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (ignoreDirs.has(entry.name)) continue;
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const rel = relative(cwd, fullPath).replace(/\\/g, "/");
          if (!query || rel.toLowerCase().includes(query.toLowerCase())) {
            results.push(rel);
          }
        }
      }
    } catch {}
  }

  walk(cwd, 0);
  return results.slice(0, maxResults);
}

function parseRunOutput(raw: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed.response) return parsed.response;
    if (parsed.message) return parsed.message;
    if (parsed.content) return parsed.content;
    if (parsed.text) return parsed.text;
    if (typeof parsed === "string") return parsed;
  } catch {}
  return raw;
}

function parseStageAction(text: string): StageAction | null {
  const jsonBlockRegex = /```json\s*\n?([\s\S]*?)\n?```/;
  const match = text.match(jsonBlockRegex);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      return StageActionSchema.parse(parsed);
    } catch {}
  }

  const braceRegex = /\{[\s\S]*"action"[\s\S]*"summary"[\s\S]*\}/;
  const braceMatch = text.match(braceRegex);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      return StageActionSchema.parse(parsed);
    } catch {}
  }

  return null;
}

export function parseAgentOptions(text: string): string[] {
  const options: string[] = [];
  const lines = text.split("\n");

  let foundOptions = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^OPTIONS:$/i.test(trimmed)) {
      foundOptions = true;
      continue;
    }
    if (foundOptions) {
      const numMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
      if (numMatch) {
        options.push(numMatch[2].trim());
      } else if (trimmed === "" && options.length > 0) {
        break;
      } else if (!/^\d+[.)]/.test(trimmed) && trimmed.length > 0) {
        break;
      }
    }
  }

  if (options.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      const numMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
      if (numMatch) {
        options.push(numMatch[2].trim());
      } else if (options.length > 0 && trimmed === "") {
        break;
      } else if (options.length > 0 && !/^\d+[.)]/.test(trimmed)) {
        break;
      }
    }
  }

  return options;
}
