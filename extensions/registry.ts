/**
 * Discovery and loading of agents from .md files
 * - .pi/agents/*.md (project)
 * - ~/.pi/agent/agents/*.md (global)
 *
 * Project agents override user agents on name conflict.
 * All configuration comes from the YAML frontmatter of the .md files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

/** Default tools applied when an agent declares no `tools:` in its frontmatter. */
export const DEFAULT_AGENT_TOOLS = ["read", "grep", "find", "ls", "bash", "ask_user_question"];

// ─── Frontmatter coercion ─────────────────────────────────────────────────────
// The YAML parser may return strings, booleans or arrays depending on how a
// field is written. These helpers normalize each field so the loader tolerates
// both `tools: a, b` and `tools: [a, b]`, and both `useAgentFile: true` and
// `useAgentFile: "true"`.

/** Returns a trimmed non-empty string, or undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Accepts a YAML list (`[a, b]`) or a comma-separated string (`a, b`). */
function asToolsList(v: unknown): string[] | undefined {
  let list: string[];
  if (Array.isArray(v)) {
    list = v.map((t) => String(t).trim());
  } else if (typeof v === "string") {
    list = v.split(",").map((t) => t.trim());
  } else {
    return undefined;
  }
  const filtered = list.filter(Boolean);
  return filtered.length ? filtered : undefined;
}

/** Accepts a real boolean or the string "true". */
function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

// ─── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  agents: AgentConfig[];
  timestamp: number;
}

const _agentCache = new Map<string, CacheEntry>();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the global agents directory.
 */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return envDir ?? path.join(os.homedir(), ".pi", "agent");
}

/**
 * Loads agents from a directory containing .md files.
 */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
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
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      const parsed = parseFrontmatter<Record<string, unknown>>(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch {
      continue;
    }

    const name = asString(frontmatter.name);
    const description = asString(frontmatter.description);
    if (!name || !description) {
      continue;
    }

    const outputFormat = asString(frontmatter.outputFormat) as
      | "text"
      | "json"
      | "markdown"
      | undefined;

    agents.push({
      name,
      description,
      tools: asToolsList(frontmatter.tools),
      model: asString(frontmatter.model),
      thinkingLevel: asString(frontmatter.thinkingLevel),
      systemPrompt: body.trim(),
      source,
      filePath,
      outputFormat,
      useAgentFile: asBool(frontmatter.useAgentFile),
    });
  }

  return agents;
}

/**
 * Discovers all available agents (user + project).
 * Project overrides global on name conflict.
 */
export function discoverAgents(cwd: string): AgentConfig[] {
  const cached = _agentCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.agents;
  }

  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = path.join(cwd, ".pi", "agents");

  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = loadAgentsFromDir(projectDir, "project");

  // Project overrides user on name conflict
  const map = new Map<string, AgentConfig>();
  for (const a of userAgents) map.set(a.name, a);
  for (const a of projectAgents) map.set(a.name, a);

  const agents = Array.from(map.values());

  _agentCache.set(cwd, { agents, timestamp: Date.now() });
  return agents;
}

/**
 * Finds an agent by name.
 */
export function findAgent(cwd: string, name: string): AgentConfig | undefined {
  return discoverAgents(cwd).find((a) => a.name === name);
}
