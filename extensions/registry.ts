/**
 * Discovery, parsing and loading of project, global and pi-agents system agents.
 *
 * Project agents override global agents, which override system agents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

/** Default tools applied when an agent declares no `tools:` in its frontmatter. */
export const DEFAULT_AGENT_TOOLS = ["read", "grep", "find", "ls", "bash", "ask_user_question"];

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const AGENT_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "skills",
  "model",
  "thinkingLevel",
  "useAgentFile",
]);
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ParsedAgentMarkdown {
  agent?: AgentConfig;
  frontmatter: Record<string, unknown>;
  body: string;
  diagnostics: AgentDiagnostic[];
}

/** Returns a trimmed non-empty string, or undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Accepts a YAML list or a comma-separated string, matching loader semantics. */
function asList(
  value: unknown,
  field: "tools" | "skills",
  diagnostics: AgentDiagnostic[],
): string[] | undefined {
  if (value === undefined) return undefined;

  let list: string[];
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== "string")) {
      diagnostics.push({
        severity: "error",
        code: `invalid_${field}`,
        message: `"${field}" must contain only strings`,
      });
    }
    list = value.map((item) => String(item).trim());
  } else if (typeof value === "string") {
    list = value.split(",").map((item) => item.trim());
  } else {
    diagnostics.push({
      severity: "error",
      code: `invalid_${field}`,
      message: `"${field}" must be a YAML list or a comma-separated string`,
    });
    return undefined;
  }

  const filtered = list.filter(Boolean);
  const duplicates = [...new Set(filtered.filter((item, index) => filtered.indexOf(item) !== index))];
  if (duplicates.length) {
    diagnostics.push({
      severity: "warning",
      code: `duplicate_${field}`,
      message: `Duplicate ${field}: ${duplicates.join(", ")}`,
    });
  }
  return filtered.length ? filtered : undefined;
}

/** Accepts the loader's boolean forms while diagnosing invalid values. */
function asBool(value: unknown, diagnostics: AgentDiagnostic[]): boolean {
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  diagnostics.push({
    severity: "error",
    code: "invalid_use_agent_file",
    message: '"useAgentFile" must be true or false',
  });
  return false;
}

/**
 * Parses one agent definition. Discovery and architect validation both use this
 * function so their frontmatter semantics cannot drift apart.
 *
 * `agent` is returned whenever the loader's two required fields are present,
 * even if stricter diagnostics exist. Discovery therefore remains tolerant;
 * callers such as agent_validate decide whether diagnostics are fatal.
 */
export function parseAgentMarkdown(
  content: string,
  source: "system" | "user" | "project",
  filePath: string,
): ParsedAgentMarkdown {
  const diagnostics: AgentDiagnostic[] = [];
  let frontmatter: Record<string, unknown> = {};
  let body = "";

  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "invalid_frontmatter",
      message: error instanceof Error ? error.message : String(error),
    });
    return { frontmatter, body, diagnostics };
  }

  for (const field of Object.keys(frontmatter)) {
    if (!AGENT_FRONTMATTER_FIELDS.has(field)) {
      diagnostics.push({
        severity: "error",
        code: "unknown_field",
        message: `Unknown frontmatter field: ${field}`,
      });
    }
  }

  const name = asString(frontmatter.name);
  const description = asString(frontmatter.description);
  const tools = asList(frontmatter.tools, "tools", diagnostics);
  const skills = asList(frontmatter.skills, "skills", diagnostics);
  const model = asString(frontmatter.model);
  const thinkingLevel = asString(frontmatter.thinkingLevel);
  const systemPrompt = body.trim();

  if (!name) {
    diagnostics.push({ severity: "error", code: "missing_name", message: 'Required field "name" is missing or empty' });
  } else {
    if (!AGENT_NAME_PATTERN.test(name)) {
      diagnostics.push({
        severity: "error",
        code: "invalid_name",
        message: `Agent name must match ${AGENT_NAME_PATTERN}`,
      });
    }
    const basename = path.basename(filePath, path.extname(filePath));
    const expectedName = source === "system" ? basename.toLowerCase() : basename;
    if (expectedName !== name) {
      diagnostics.push({
        severity: "error",
        code: "filename_mismatch",
        message: `Frontmatter name "${name}" does not match filename "${expectedName}.md"`,
      });
    }
  }

  if (!description) {
    diagnostics.push({
      severity: "error",
      code: "missing_description",
      message: 'Required field "description" is missing or empty',
    });
  }
  if (!systemPrompt) {
    diagnostics.push({ severity: "error", code: "empty_prompt", message: "System prompt body is empty" });
  }
  if (frontmatter.model !== undefined && !model) {
    diagnostics.push({ severity: "error", code: "invalid_model", message: '"model" must be a non-empty string' });
  }
  if (frontmatter.thinkingLevel !== undefined && !thinkingLevel) {
    diagnostics.push({
      severity: "error",
      code: "invalid_thinking_level",
      message: '"thinkingLevel" must be a non-empty string',
    });
  } else if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
    diagnostics.push({
      severity: "error",
      code: "invalid_thinking_level",
      message: `Unknown thinkingLevel "${thinkingLevel}"; expected one of: ${[...THINKING_LEVELS].join(", ")}`,
    });
  }

  const useAgentFile = asBool(frontmatter.useAgentFile, diagnostics);
  const agent = name && description
    ? {
        name,
        description,
        tools,
        skills,
        model,
        thinkingLevel,
        systemPrompt,
        source,
        filePath,
        useAgentFile,
      }
    : undefined;

  return { agent, frontmatter, body, diagnostics };
}

/** Returns the global pi agent directory. */
export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** Exact directories used for one cwd. */
export function getAgentDirectories(cwd: string): { user: string; project: string } {
  return {
    user: path.join(getAgentDir(), "agents"),
    project: path.join(cwd, ".pi", "agents"),
  };
}

function loadAgentsFromDir(dir: string, source: "system" | "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseAgentMarkdown(
        source === "system" ? content.replace(/^model: __PI_DEFAULT_MODEL__\r?\n/m, "") : content,
        source,
        filePath,
      );
      if (parsed.agent) agents.push(parsed.agent);
    } catch {
      // Discovery is intentionally fail-open per file.
    }
  }
  return agents;
}

/** Discovers agents in display and precedence order: project, global, system. */
export function discoverAgents(cwd: string): AgentConfig[] {
  const dirs = getAgentDirectories(cwd);
  const systemDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
  const byName = (agents: AgentConfig[]) => new Map(agents.map((agent) => [agent.name, agent]));
  const project = byName(loadAgentsFromDir(dirs.project, "project"));
  const user = byName(loadAgentsFromDir(dirs.user, "user"));
  const system = byName(loadAgentsFromDir(systemDir, "system"));
  const sortByName = (agents: AgentConfig[]) => agents.sort((a, b) => a.name.localeCompare(b.name));

  return [
    ...sortByName([...project.values()]),
    ...sortByName([...user.values()].filter((agent) => !project.has(agent.name))),
    ...sortByName([...system.values()].filter((agent) => !project.has(agent.name) && !user.has(agent.name))),
  ];
}

/** Finds an agent by exact name. */
export function findAgent(cwd: string, name: string): AgentConfig | undefined {
  return discoverAgents(cwd).find((agent) => agent.name === name);
}
