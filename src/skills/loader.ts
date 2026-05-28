import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getGlobalSkillsDir } from "../config/loader.js";

export function loadSkillContent(skillName: string): string | null {
  const skillsDir = getGlobalSkillsDir();
  const skillPath = join(skillsDir, `${skillName}.md`);

  if (existsSync(skillPath)) {
    return readFileSync(skillPath, "utf-8");
  }
  return null;
}

export function loadSkillsForStage(skillNames: string[]): string {
  const parts: string[] = [];
  for (const name of skillNames) {
    const content = loadSkillContent(name);
    if (content) {
      parts.push(`--- SKILL: ${name} ---\n${content}\n--- END SKILL ---`);
    }
  }
  return parts.join("\n\n");
}

export function skillExists(skillName: string): boolean {
  const skillsDir = getGlobalSkillsDir();
  return existsSync(join(skillsDir, `${skillName}.md`));
}

export function listAvailableSkills(): string[] {
  const skillsDir = getGlobalSkillsDir();
  if (!existsSync(skillsDir)) {
    return [];
  }
  const { readdirSync } = require("node:fs");
  return readdirSync(skillsDir)
    .filter((f: string) => f.endsWith(".md"))
    .map((f: string) => f.replace(".md", ""));
}
