import {
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { getFlowcodeDir } from "../config/loader.js";

const CONVENTIONS_FILE = "conventions.json";

export interface ProjectConventions {
  modules: string[];
  packagePrefix: string;
  sourcePath: string;
  testPath: string;
  buildTool: string;
  lintTool: string;
  testTool: string;
  useCasePattern: string;
  diFramework: string;
  language: string;
  lastScanned: string;
}

export function getConventionsPath(): string {
  return join(getFlowcodeDir(), CONVENTIONS_FILE);
}

export function loadConventions(): ProjectConventions | null {
  const path = getConventionsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function scanConventions(): ProjectConventions {
  const existing = loadConventions();
  if (existing && !isStale(existing)) return existing;

  const conv: ProjectConventions = {
    modules: scanModules(),
    packagePrefix: scanPackagePrefix(),
    sourcePath: scanSourcePath(),
    testPath: scanTestPath(),
    buildTool: detectBuildTool(),
    lintTool: detectLintTool(),
    testTool: detectTestTool(),
    useCasePattern: scanUseCasePattern(),
    diFramework: detectDIFramework(),
    language: detectLanguage(),
    lastScanned: new Date().toISOString(),
  };

  saveConventions(conv);
  return conv;
}

function isStale(conv: ProjectConventions): boolean {
  const age = Date.now() - new Date(conv.lastScanned).getTime();
  return age > 24 * 60 * 60 * 1000;
}

export function saveConventions(conv: ProjectConventions): void {
  const dir = getFlowcodeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getConventionsPath(), JSON.stringify(conv, null, 2), "utf-8");
}

export function buildConventionsPrompt(conv: ProjectConventions): string {
  let prompt = `## PROJECT CONVENTIONS (pre-scanned)\n`;
  prompt += `- Language: ${conv.language}\n`;
  prompt += `- Build tool: ${conv.buildTool}\n`;
  prompt += `- Source path: ${conv.sourcePath}\n`;
  prompt += `- Test path: ${conv.testPath}\n`;
  prompt += `- Package prefix: ${conv.packagePrefix}\n`;
  prompt += `- Lint tool: ${conv.lintTool}\n`;
  prompt += `- Test command: ${conv.testTool}\n`;
  prompt += `- DI framework: ${conv.diFramework}\n`;
  prompt += `- UseCase pattern: ${conv.useCasePattern}\n`;
  if (conv.modules.length > 0) {
    prompt += `- Modules (${conv.modules.length}): ${conv.modules.slice(0, 30).join(", ")}`;
    if (conv.modules.length > 30) prompt += ` ... and ${conv.modules.length - 30} more`;
    prompt += "\n";
  }
  prompt += `\nUse this information directly. Do NOT re-explore project structure to discover these conventions.\n`;
  return prompt;
}

function scanModules(): string[] {
  const modules: string[] = [];

  const settingsGradle = findFile(["settings.gradle", "settings.gradle.kts"]);
  if (settingsGradle) {
    try {
      const content = readFileSync(settingsGradle, "utf-8");
      const matches = content.matchAll(/include\s*[(:'"]([^)'"]+)/g);
      for (const m of matches) {
        modules.push(m[1].replace(/['"]/g, "").replace(/:/g, "/"));
      }
    } catch {}
  }

  if (modules.length === 0) {
    const cwd = process.cwd();
    const topDirs = readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name);
    for (const dir of topDirs.slice(0, 5)) {
      try {
        const subDirs = readdirSync(join(cwd, dir), { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => `${dir}/${d.name}`);
        modules.push(...subDirs);
      } catch {}
    }
  }

  return modules;
}

function scanPackagePrefix(): string {
  const manifest = findFileGlob("**/AndroidManifest.xml");
  if (manifest) {
    try {
      const content = readFileSync(manifest, "utf-8");
      const match = content.match(/package\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }

  const ktFiles = findFilesRecursive(process.cwd(), /\.kt$/, 20);
  for (const f of ktFiles.slice(0, 10)) {
    try {
      const content = readFileSync(f, "utf-8");
      const match = content.match(/^package\s+([\w.]+)/m);
      if (match) return match[1];
    } catch {}
  }

  return "unknown";
}

function scanSourcePath(): string {
  const candidates = ["src/main/java", "src/main/kotlin", "src"];
  const cwd = process.cwd();
  for (const c of candidates) {
    if (existsSync(join(cwd, "feature"))) {
      const firstModule = readdirSync(join(cwd, "feature"), { withFileTypes: true })
        .find((d) => d.isDirectory());
      if (firstModule) {
        const deep = join(cwd, "feature", firstModule.name, c);
        if (existsSync(deep)) return c;
      }
    }
    if (existsSync(join(cwd, c))) return c;
  }
  return "src";
}

function scanTestPath(): string {
  const candidates = ["src/test/java", "src/test/kotlin", "src/test"];
  const cwd = process.cwd();
  for (const c of candidates) {
    if (existsSync(join(cwd, c))) return c;
  }
  return "src/test";
}

function detectBuildTool(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "gradlew")) || existsSync(join(cwd, "gradlew.bat")))
    return "gradle";
  if (existsSync(join(cwd, "pom.xml"))) return "maven";
  if (existsSync(join(cwd, "package.json"))) return "npm";
  return "unknown";
}

function detectLintTool(): string {
  const cwd = process.cwd();

  const buildFiles = ["build.gradle", "build.gradle.kts"];
  for (const bf of buildFiles) {
    if (existsSync(join(cwd, bf))) {
      try {
        const content = readFileSync(join(cwd, bf), "utf-8");
        if (content.includes("detekt")) return "detekt";
        if (content.includes("ktlint")) return "ktlint";
        if (content.includes("androidlint")) return "android-lint";
      } catch {}
    }
  }

  if (existsSync(join(cwd, "detekt.yml")) || existsSync(join(cwd, "detekt-config.yml")))
    return "detekt";
  if (existsSync(join(cwd, ".eslintrc")) || existsSync(join(cwd, ".eslintrc.js")))
    return "eslint";

  return "none detected";
}

function detectTestTool(): string {
  const cwd = process.cwd();
  const buildTool = detectBuildTool();

  if (buildTool === "gradle") {
    try {
      const settingsPath = findFile(["settings.gradle", "settings.gradle.kts"]);
      if (settingsPath) {
        const content = readFileSync(settingsPath, "utf-8");
        const firstModule = content.match(/include\s*[:'"]([^:'"]+)/);
        if (firstModule) {
          return `./gradlew :${firstModule[1]}:testReleaseUnitTest`;
        }
      }
    } catch {}
    return "./gradlew test";
  }

  if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
      if (pkg.scripts?.test) return "npm test";
    } catch {}
  }

  return "unknown";
}

function scanUseCasePattern(): string {
  const files = findFilesRecursive(process.cwd(), /UseCase\.kt$/, 30);
  if (files.length === 0) return "unknown";

  for (const f of files.slice(0, 3)) {
    try {
      const content = readFileSync(f, "utf-8");
      const lines = content.split("\n").slice(0, 20).join("\n");
      if (lines.includes("interface ")) return "interface with operator fun invoke()";
      if (lines.includes("class ")) return "class with fun invoke()/execute()/call()";
    } catch {}
  }

  return "class-based";
}

function detectDIFramework(): string {
  const files = findFilesRecursive(process.cwd(), /\.kt$/, 50);
  const sample = files.slice(0, 20);

  let allContent = "";
  for (const f of sample) {
    try {
      allContent += readFileSync(f, "utf-8") + "\n";
    } catch {}
  }

  if (allContent.includes("org.koin")) return "koin";
  if (allContent.includes("dagger.")) return "dagger";
  if (allContent.includes("hilt")) return "hilt";
  if (allContent.includes("@Inject")) return "javax-inject";
  if (allContent.includes("@Component")) return "dagger";

  return "unknown";
}

function detectLanguage(): string {
  const cwd = process.cwd();
  const ktCount = findFilesRecursive(cwd, /\.kt$/, 200).length;
  const javaCount = findFilesRecursive(cwd, /\.java$/, 200).length;

  if (ktCount > 0 && javaCount === 0) return "Kotlin";
  if (javaCount > 0 && ktCount === 0) return "Java";
  if (ktCount > 0 && javaCount > 0) return "Kotlin+Java";

  const tsCount = findFilesRecursive(cwd, /\.tsx?$/, 200).length;
  if (tsCount > 0) return "TypeScript";

  return "unknown";
}

function findFile(names: string[]): string | null {
  const cwd = process.cwd();
  for (const name of names) {
    if (existsSync(join(cwd, name))) return join(cwd, name);
  }
  return null;
}

function findFileGlob(pattern: string): string | null {
  const cwd = process.cwd();
  const regex = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\./g, "\\."));
  const results = findFilesRecursive(cwd, regex, 5);
  return results.length > 0 ? results[0] : null;
}

function findFilesRecursive(dir: string, pattern: RegExp | string, maxResults: number): string[] {
  const results: string[] = [];
  const ignoreDirs = new Set([
    "node_modules", ".git", "dist", "build", ".flowcode",
    "__pycache__", ".gradle", ".idea", ".vs", "target",
    ".cache", "out",
  ]);

  function walk(currentDir: string, depth: number) {
    if (depth > 8 || results.length >= maxResults) return;
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith(".") && entry.name !== ".flowcode") continue;
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (ignoreDirs.has(entry.name)) continue;
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          if (pattern instanceof RegExp) {
            if (pattern.test(entry.name)) results.push(fullPath);
          } else {
            if (entry.name.includes(pattern)) results.push(fullPath);
          }
        }
      }
    } catch {}
  }

  walk(dir, 0);
  return results;
}

const IGNORED_PATHS = new Set([
  ".flowcode/",
  "node_modules/",
  ".git/",
]);

export function getGitDiffFiles(): string[] {
  try {
    const output = execSync("git diff --name-only HEAD", {
      encoding: "utf-8",
      timeout: 5000,
      cwd: process.cwd(),
    }).trim();
    if (!output) return [];
    return output.split("\n").filter(Boolean).filter((f) => !IGNORED_PATHS.has(f) && !f.startsWith(".flowcode/") && !f.startsWith("node_modules/"));
  } catch {
    return [];
  }
}

export function stageChanges(): void {
  try {
    const diffOutput = execSync("git diff --name-only HEAD", {
      encoding: "utf-8",
      timeout: 5000,
      cwd: process.cwd(),
    }).trim();
    const stagedOutput = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
      timeout: 5000,
      cwd: process.cwd(),
    }).trim();
    const allFiles = [...diffOutput.split("\n"), ...stagedOutput.split("\n")]
      .filter(Boolean)
      .filter((f) => !f.startsWith(".flowcode/") && !f.startsWith("node_modules/"));
    if (allFiles.length > 0) {
      const result = spawnSync("git", ["add", ...allFiles], {
        cwd: process.cwd(),
        timeout: 10000,
        stdio: "pipe",
      });
      if (result.error) {
        console.error(`stageChanges failed: ${result.error.message}`);
      } else {
        console.log(`[flowcode] Staged ${allFiles.length} files for git`);
      }
    } else {
      console.log("[flowcode] No changes to stage");
    }
  } catch (err) {
    console.error(`stageChanges failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function getGitDiffContent(): string {
  try {
    const output = execSync("git diff HEAD", {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
    }).trim();
    return output.slice(0, 15000);
  } catch {
    return "";
  }
}
