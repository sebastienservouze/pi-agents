/**
 * System prompt composition for agent mode.
 *
 * The final prompt is assembled as:
 *
 *   agent.systemPrompt                (stable — cache-friendly prefix)
 *   + <available_skills>              (skills selected via frontmatter `skills:`)
 *   + <project_context>               (pi's contextFiles when `useAgentFile: true`)
 *   + <environment>                   (cwd, platform, model, effective tools, git)
 *   + <current_date>                  (volatile — kept last for prompt caching)
 *
 * Skills and context files come from `event.systemPromptOptions` (what pi
 * actually loaded) instead of being re-read from disk. Every accessor is
 * defensive: the shapes are provider/version-specific and must fail-open.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveToolNames } from "./effective-tools.js";
import type { AgentConfig } from "./types.js";

// ─── Date ────────────────────────────────────────────────────────────────────

export function currentDateSnippet(): string {
  const iso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `\n\n<current_date>Today's date: ${iso} (format: YYYY-MM-DD, ISO 8601)</current_date>`;
}

// ─── Environment ─────────────────────────────────────────────────────────────

/** Git facts are computed once per cwd and cached: they are a session-start
 * snapshot (like Claude Code's env block), not a live view. */
const _gitCache = new Map<string, string[]>();

function git(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

function gitLines(cwd: string): string[] {
  const cached = _gitCache.get(cwd);
  if (cached) return cached;

  let lines: string[];
  if (git(cwd, "rev-parse --is-inside-work-tree") === "true") {
    const branch = git(cwd, "rev-parse --abbrev-ref HEAD") ?? "unknown";
    const dirty = git(cwd, "status --porcelain");
    lines = [
      `Git repository: yes (branch: ${branch}, ${dirty ? "uncommitted changes" : "clean"} at session start)`,
    ];
  } else {
    lines = ["Git repository: no"];
  }
  _gitCache.set(cwd, lines);
  return lines;
}

/**
 * Environment block: working dir, platform, active model, tools ACTUALLY sent
 * to the provider (effective allow-list ∩ active set), git snapshot.
 */
export function environmentSnippet(cwd: string, modelId?: string, tools?: string[]): string {
  const lines = [
    `Working directory: ${cwd}`,
    `Platform: ${process.platform} (${os.release()})`,
  ];
  if (modelId) lines.push(`Model: ${modelId}`);
  if (tools?.length) {
    lines.push(`Available tools (authoritative — only these are callable): ${tools.join(", ")}`);
  }
  lines.push(...gitLines(cwd));
  return `\n\n<environment>\n${lines.join("\n")}\n</environment>`;
}

// ─── Skills ──────────────────────────────────────────────────────────────────

interface SkillLike {
  name?: string;
  description?: string;
  filePath?: string;
}

/**
 * Renders the skills selected by the agent's frontmatter `skills:` allow-list,
 * resolved against the skills pi actually loaded (systemPromptOptions.skills).
 * No `skills:` in the frontmatter → no skills block (explicit opt-in).
 */
export function skillsSnippet(
  wanted: string[] | undefined,
  available: unknown,
): { snippet: string; missing: string[] } {
  if (!wanted?.length) return { snippet: "", missing: [] };

  const list: SkillLike[] = Array.isArray(available)
    ? (available.filter((s) => s && typeof s === "object") as SkillLike[])
    : [];
  const byName = new Map(list.map((s) => [s.name, s]));

  const found: SkillLike[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const s = byName.get(name);
    if (s) found.push(s);
    else missing.push(name);
  }
  if (!found.length) return { snippet: "", missing };

  const entries = found
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description ?? ""}</description>\n    <location>${s.filePath ?? ""}</location>\n  </skill>`,
    )
    .join("\n");

  const snippet =
    `\n\n<available_skills>\n` +
    `When a task matches a skill below, read its SKILL.md at the given location and follow its instructions.\n` +
    `${entries}\n</available_skills>`;
  return { snippet, missing };
}

// ─── Context files (AGENTS.md) ───────────────────────────────────────────────

/**
 * Legacy fallback: cwd/AGENTS.md only. Used when systemPromptOptions.contextFiles
 * is absent or in an unrecognized shape.
 */
export function loadAgentFileFromCwd(cwd: string): string | null {
  const filePath = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return wrapProjectContext([
      `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`,
    ]);
  } catch {
    return null;
  }
}

function wrapProjectContext(blocks: string[]): string {
  return (
    `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n` +
    `${blocks.join("\n\n")}\n\n</project_context>\n`
  );
}

/**
 * Renders pi's already-loaded context files (AGENTS.md hierarchy, global files)
 * from systemPromptOptions.contextFiles. Falls back to cwd/AGENTS.md when the
 * shape is unusable. Returns "" when nothing is available.
 */
export function contextFilesSnippet(contextFiles: unknown, cwd: string): string {
  const blocks: string[] = [];
  if (Array.isArray(contextFiles)) {
    for (const f of contextFiles) {
      if (typeof f === "string" && f.trim()) {
        blocks.push(`<project_instructions>\n${f}\n</project_instructions>`);
        continue;
      }
      if (f && typeof f === "object") {
        const o = f as { path?: string; filePath?: string; content?: string };
        if (typeof o.content === "string" && o.content.trim()) {
          const p = o.path ?? o.filePath ?? "";
          blocks.push(
            `<project_instructions${p ? ` path="${p}"` : ""}>\n${o.content}\n</project_instructions>`,
          );
        }
      }
    }
  }
  if (blocks.length) return wrapProjectContext(blocks);
  return loadAgentFileFromCwd(cwd) ?? "";
}

// ─── Delegated sub-agent notice ──────────────────────────────────────────────

export function delegationSnippet(agentName: string | undefined): string {
  return (
    `\n\n<delegation_context>You are "${agentName ?? "sub-agent"}", a delegated sub-agent. ` +
    `Your final message is consumed by the orchestrating agent — not a human. ` +
    `Return dense, complete, self-contained results. Never ask questions or wait for input.</delegation_context>`
  );
}

// ─── Full composition ────────────────────────────────────────────────────────

/**
 * Builds the complete system prompt for an active agent.
 * `systemPromptOptions` is the (unknown-shaped) event.systemPromptOptions.
 */
export function composeAgentPrompt(
  pi: ExtensionAPI,
  cwd: string,
  agent: AgentConfig,
  opts: { systemPromptOptions?: unknown; modelId?: string },
): { prompt: string; missingSkills: string[] } {
  const spo = (opts.systemPromptOptions ?? {}) as {
    skills?: unknown;
    contextFiles?: unknown;
  };

  let out = agent.systemPrompt;

  const { snippet, missing } = skillsSnippet(agent.skills, spo.skills);
  out += snippet;

  if (agent.useAgentFile) {
    out += contextFilesSnippet(spo.contextFiles, cwd);
  }

  let tools: string[] | undefined;
  try {
    tools = effectiveToolNames(pi, cwd, agent.name);
  } catch {
    /* fail-open: no tools line */
  }

  out += environmentSnippet(cwd, agent.model ?? opts.modelId, tools);
  out += currentDateSnippet();

  return { prompt: out, missingSkills: missing };
}
