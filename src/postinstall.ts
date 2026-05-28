import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function getGlobalSkillsDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "flowcode", "skills");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "flowcode", "skills");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "defaults", "skills");
const targetDir = getGlobalSkillsDir();

if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}

  if (existsSync(sourceDir)) {
  const files = readdirSync(sourceDir).filter((f) => f.endsWith(".md"));
  let copied = 0;
  for (const file of files) {
    const src = join(sourceDir, file);
    const dst = join(targetDir, file);
    copyFileSync(src, dst);
    copied++;
  }
  if (copied > 0) {
    console.log(`flowcode: installed ${copied} default skills to ${targetDir}`);
  }
} else {
  console.log("flowcode: no bundled skills found, skipping");
}
