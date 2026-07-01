/**
 * Découverte et chargement des agents depuis les fichiers .md
 * - .pi/agents/*.md (projet)
 * - ~/.pi/agent/agents/*.md (global)
 *
 * Les agents projet écrasent les agents user en cas de conflit de nom.
 * Toute la configuration provient du frontmatter YAML des fichiers .md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

// ─── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000; // 30 secondes

interface CacheEntry {
  agents: AgentConfig[];
  timestamp: number;
}

const _agentCache = new Map<string, CacheEntry>();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Récupère le répertoire global des agents
 */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return envDir ?? path.join(os.homedir(), ".pi", "agent");
}

/**
 * Charge les agents depuis un répertoire contenant des fichiers .md
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

    let frontmatter: Record<string, string>;
    let body: string;
    try {
      const parsed = parseFrontmatter<Record<string, string>>(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch {
      continue;
    }

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const outputFormat = frontmatter.outputFormat as "text" | "json" | "markdown" | undefined;

    // DEPRECATED : whenToDelegate n'est plus utilisé.
    // Les règles de délégation sont dans APPEND_SYSTEM.md
    const whenToDelegate = frontmatter.whenToDelegate || undefined; // Garder pour compat

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      whenToDelegate, // DEPRECATED — peut être supprimé dans une version future
      tools: tools?.length ? tools : undefined,
      model: frontmatter.model || undefined,
      thinkingLevel: frontmatter.thinkingLevel || undefined,
      systemPrompt: body.trim(),
      source,
      filePath,
      outputFormat,
      useAgentFile: frontmatter.useAgentFile === "true",
    });
  }

  return agents;
}

export interface AgentDiscoveryOptions {
  includeMetadata?: boolean;
}


/**
 * Découvre tous les agents disponibles (user + projet),
 * Le projet écrase le global en cas de conflit de nom.
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

  // Projet écrase user en cas de conflit de nom
  const map = new Map<string, AgentConfig>();
  for (const a of userAgents) map.set(a.name, a);
  for (const a of projectAgents) map.set(a.name, a);

  const agents = Array.from(map.values());

  _agentCache.set(cwd, { agents, timestamp: Date.now() });
  return agents;
}

/**
 * Trouve un agent par son nom
 */
export function findAgent(cwd: string, name: string): AgentConfig | undefined {
  return discoverAgents(cwd).find((a) => a.name === name);
}

/**
 * Vérifie si un répertoire contient des fichiers .md d'agents projet
 */
export function hasProjectAgents(cwd: string): boolean {
  const projectDir = path.join(cwd, ".pi", "agents");
  if (!fs.existsSync(projectDir)) return false;
  try {
    return fs.readdirSync(projectDir).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}
