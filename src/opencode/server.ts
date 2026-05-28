import { spawn, execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function log(msg: string): void {
  const logPath = join(process.cwd(), ".flowcode", "debug.log");
  const dir = join(process.cwd(), ".flowcode");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, `[${new Date().toISOString()}] [server] ${msg}\n`, "utf-8");
}

let cachedBinPath: string | null = null;

function findOpencodeBin(): string {
  if (cachedBinPath) return cachedBinPath;
  if (process.platform !== "win32") {
    cachedBinPath = "opencode";
    return cachedBinPath;
  }
  try {
    const result = execSync("where opencode", { encoding: "utf-8" }).trim();
    const paths = result.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    const exe = paths.find(p => p.toLowerCase().endsWith(".exe"));
    if (exe) {
      cachedBinPath = exe;
      log(`Found opencode.exe: ${exe}`);
      return exe;
    }
    const cmdFile = paths.find(p => p.toLowerCase().endsWith(".cmd"));
    if (cmdFile) {
      const cmdDir = cmdFile.replace(/[/\\][^/\\]*$/, "");
      const exePath = join(cmdDir, "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (existsSync(exePath)) {
        cachedBinPath = exePath;
        log(`Found opencode.exe via .cmd: ${exePath}`);
        return exePath;
      }
      log(`Expected exe not found at: ${exePath}`);
    }
  } catch (e) {
    log(`findOpencodeBin failed: ${e}`);
  }
  cachedBinPath = "opencode";
  log(`Falling back to: opencode`);
  return cachedBinPath;
}

export interface OpenCodeResult {
  text: string;
  exitCode: number;
  raw: string;
  sessionId: string | null;
}

export interface ModelConfig {
  provider: string;
  model: string;
  full: string;
}

const WORKER_CODE = `
const { spawnSync } = require("child_process");
const { workerData, parentPort } = require("worker_threads");
try {
  const result = spawnSync(workerData.bin, workerData.args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    cwd: workerData.cwd,
    env: workerData.env,
    timeout: workerData.timeout,
    killSignal: "SIGKILL",
    maxBuffer: 50 * 1024 * 1024,
  });
  parentPort.postMessage({
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
    exitCode: result.status != null ? result.status : -1,
    error: result.error ? result.error.message : null,
  });
} catch (err) {
  parentPort.postMessage({
    stdout: "",
    stderr: "",
    exitCode: -1,
    error: err.message,
  });
}
`;

export class ServerManager extends EventEmitter {
  private shuttingDown = false;
  private modelConfig: ModelConfig | null = null;
  private activeSessionId: string | null = null;
  private activeWorker: Worker | null = null;

  async start(): Promise<void> {
    this.shuttingDown = false;
    this.loadModelConfig();
    log(`ServerManager started. Model: ${this.modelConfig?.full ?? "not set"}`);
    this.emit("started", "subprocess-mode");
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.activeWorker) {
      try { this.activeWorker.terminate(); } catch {}
      this.activeWorker = null;
    }
    this.emit("stopped", undefined);
  }

  get isRunning(): boolean {
    return !this.shuttingDown;
  }

  getModel(): ModelConfig | null {
    return this.modelConfig;
  }

  loadCurrentModel(): void {
    this.loadModelConfig();
  }

  setModel(provider: string, model: string): void {
    this.modelConfig = { provider, model, full: `${provider}/${model}` };
    this.saveModelConfig();
    log(`Model set to: ${this.modelConfig.full}`);
  }

  getSessionId(): string | null {
    return this.activeSessionId;
  }

  resetSession(): void {
    this.activeSessionId = null;
    log("Session reset");
  }

  private loadModelConfig(): void {
    try {
      const configPath = join(process.cwd(), ".flowcode", "model.json");
      if (existsSync(configPath)) {
        const data = JSON.parse(readFileSync(configPath, "utf-8"));
        this.modelConfig = { provider: data.provider, model: data.model, full: `${data.provider}/${data.model}` };
        log(`Loaded model config: ${this.modelConfig.full}`);
        return;
      }
    } catch (e) {
      log(`Failed to load model config: ${e}`);
    }
    this.modelConfig = { provider: "zai-coding-plan", model: "glm-5.1", full: "zai-coding-plan/glm-5.1" };
    log(`Using default model: ${this.modelConfig.full}`);
  }

  private saveModelConfig(): void {
    try {
      const dir = join(process.cwd(), ".flowcode");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "model.json");
      const data = { provider: this.modelConfig!.provider, model: this.modelConfig!.model };
      writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      log(`Failed to save model config: ${e}`);
    }
  }

  async runPrompt(prompt: string, continueSession: boolean = false): Promise<OpenCodeResult> {
    const args: string[] = ["run"];

    if (this.modelConfig) {
      args.push("-m", this.modelConfig.full);
    }

    args.push("--format", "json");
    args.push("--dangerously-skip-permissions");

    if (continueSession && this.activeSessionId) {
      args.push("--session", this.activeSessionId);
    }

    args.push("--");
    args.push(prompt);

    const bin = findOpencodeBin();
    const sessionLabel = (continueSession && this.activeSessionId) ? `session=${this.activeSessionId}` : "new session";
    log(`Running [${sessionLabel}]: ${bin} ${args.slice(0, 8).join(" ")} ... [prompt: ${prompt.length} chars]`);
    log(`Prompt preview: ${prompt.slice(0, 200).replace(/\n/g, "\\n")}`);

    const workerResult = await this.runInWorker(bin, args, 600000);

    log(`Exit code ${workerResult.exitCode}. stdout=${workerResult.stdout.length} stderr=${workerResult.stderr.length}`);
    if (workerResult.error) log(`Worker error: ${workerResult.error}`);
    if (workerResult.stderr) log(`stderr: ${workerResult.stderr.slice(0, 300)}`);

    if (!this.activeSessionId) {
      const sid = extractSessionId(workerResult.stdout);
      if (sid) {
        this.activeSessionId = sid;
        log(`Captured session ID: ${sid}`);
      }
    }

    const text = extractResponse(workerResult.stdout);
    log(`Extracted (${text.length} chars): ${text.slice(0, 300).replace(/\n/g, "\\n")}`);

    return {
      text,
      exitCode: workerResult.exitCode,
      raw: workerResult.stdout,
      sessionId: this.activeSessionId,
    };
  }

  private runInWorker(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number; error: string | null }> {
    return new Promise((resolve) => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: {
          bin: cmd,
          args,
          cwd: process.cwd(),
          env: { ...process.env },
          timeout,
        },
      });

      this.activeWorker = worker;

      worker.on("message", (msg: any) => {
        this.activeWorker = null;
        resolve(msg);
      });

      worker.on("error", (err) => {
        this.activeWorker = null;
        log(`Worker thread error: ${err.message}`);
        resolve({ stdout: "", stderr: "", exitCode: -1, error: err.message });
      });

      worker.on("exit", (code) => {
        if (this.activeWorker === worker) {
          this.activeWorker = null;
          resolve({ stdout: "", stderr: "", exitCode: code ?? -1, error: "worker exited without message" });
        }
      });
    });
  }

  async getModelInfo(): Promise<string> {
    return this.modelConfig?.full ?? "unknown";
  }

  async listModels(): Promise<ModelConfig[]> {
    return new Promise((resolve) => {
      const bin = findOpencodeBin();
      const child = spawn(bin, ["models"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.on("close", () => {
        const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
        const models: ModelConfig[] = [];
        for (const line of lines) {
          const match = line.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)$/);
          if (match) {
            models.push({ provider: match[1], model: match[2], full: line });
          }
        }
        log(`Listed ${models.length} models`);
        resolve(models);
      });
      child.on("error", () => resolve([]));
    });
  }
}

function extractSessionId(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.sessionID) return obj.sessionID;
    } catch {}
  }
  return null;
}

function extractResponse(stdout: string): string {
  if (!stdout.trim()) return "";

  const texts: string[] = [];
  const toolCalls: string[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const obj = JSON.parse(trimmed);

      if (obj.type === "text" && obj.part?.text) {
        texts.push(obj.part.text);
      } else if (obj.type === "tool_call" && obj.part) {
        const toolName = obj.part.toolName || obj.part.name || "tool";
        const args = obj.part.args ? JSON.stringify(obj.part.args).slice(0, 60) : "";
        toolCalls.push(`${toolName}(${args})`);
      }
    } catch {}
  }

  if (texts.length > 0) {
    let result = texts.join("\n");
    if (toolCalls.length > 0) {
      result += `\n\n[Tools: ${toolCalls.join(", ")}]`;
    }
    return result;
  }

  return stdout
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/^>.*$/gm, "")
    .trim();
}
