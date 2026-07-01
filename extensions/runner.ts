/**
 * Exécution d'un agent dans un sous-processus pi --mode json isolé.
 *
 * Chaque agent tourne dans spawn("pi", ["--mode", "json", "-p", "--no-session", ...])
 * avec son propre modèle, ses outils, et son system prompt.
 *
 * Le sous-processus émet des events JSON (message_update, tool_execution_start,
 * tool_execution_end, message_end) qui sont parsés en temps réel pour :
 *   - Suivre l'activité (outils utilisés, réflexion, écriture)
 *   - Accumuler les métriques de consommation (tokens, coût)
 *   - Récupérer la sortie finale
 *   - (Phase 1+2) Parser JSON structuré et compresser le codebase
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, AgentResult, AgentUsage } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const min = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${min}m${sec.toString().padStart(2, "0")}s`;
}

export function formatUsage(usage: AgentUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

// ─── Parsing JSON stream ────────────────────────────────────────────────────

interface StreamState {
  actions: string[];
  activeTools: string[];
  usage: AgentUsage;
  output: string;
  model?: string;
  errorMessage?: string;
  thinkingText: string;
  hasSeenNonThinking: boolean;
  toolCount: number;
  toolFailCount: number;
  thinkingPhases: number;
}

function processEvent(
  line: string,
  state: StreamState,
  startTime: number,
  onUpdate?: (actions: string[], usage: AgentUsage, activeTools: string[], durationMs: number, toolCount: number, toolFailCount: number, thinkingPhases: number, thinkingText: string) => void,
): void {
  const elapsed = Date.now() - startTime;
  if (!line.trim()) return;

  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  switch (event.type) {
    // ── Streaming de texte ──
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (!ame) return;

      // Compteur de phases de réflexion : incrémenté même après du non-thinking
      // (sinon thinkingPhases reste bloqué à 1)
      if (ame.type === "thinking_start") {
        state.thinkingPhases++;
      }

      // Ignorer uniquement les thinking_delta après avoir vu du non-thinking.
      // On garde thinking_start/end pour que l'UI montre "réfléchit…" et le compteur
      if (state.hasSeenNonThinking && ame.type === "thinking_delta") {
        return;
      }

      // Marquer qu'on a vu du contenu réel
      if (
        ame.type === "text_delta" ||
        ame.type === "text_start" ||
        ame.type === "toolcall_delta" ||
        ame.type === "toolcall_start"
      ) {
        state.hasSeenNonThinking = true;
      }

      // Activité (discriminée par ame.type)
      let actionLine: string;
      switch (ame.type) {
        case "thinking_delta":
          state.thinkingText += ame.delta;
          actionLine = "🧠 réfléchit…";
          break;
        case "thinking_start":
        case "thinking_end":
          actionLine = "🧠 réfléchit…";
          break;
        case "text_delta":
        case "text_start":
          actionLine = "💬 écrit…";
          break;
        case "toolcall_delta":
        case "toolcall_start":
          actionLine = ""; // masqué: le vrai nom d'outil arrive dans tool_execution_start
          break;
        default:
          actionLine = "💬 écrit…";
      }

      if (actionLine && state.actions[state.actions.length - 1] !== actionLine) {
        state.actions.push(actionLine);
      }
      onUpdate?.(state.actions, { ...state.usage }, [...state.activeTools], elapsed, state.toolCount, state.toolFailCount, state.thinkingPhases, state.thinkingText);
      break;
    }

    // ── Début d'outil ──
    case "tool_execution_start": {
      const { toolName, args } = event;
      let detail = "";
      if (typeof args === "object" && args !== null) {
        const a = args as Record<string, unknown>;
        if (typeof a.command === "string") {
          // bash : montrer la commande
          detail = a.command.length > 70 ? a.command.slice(0, 70) + "…" : a.command;
        } else if (typeof a.path === "string") {
          // read, write, edit, find, ls : chemin tronqué par la gauche
          detail = a.path.length > 60 ? "…" + a.path.slice(-57) : a.path;
        } else if (typeof a.query === "string") {
          // grep : query + path si dispo
          detail = `"${a.query.slice(0, 40)}"`;
          if (typeof a.path === "string") detail += ` in ${a.path}`;
        } else if (Array.isArray(a.queries)) {
          // web_search : première query
          const q = (a.queries as string[])[0] ?? "";
          detail = `"${q.slice(0, 50)}"`;
        } else if (typeof a.url === "string") {
          // fetch_content
          detail = a.url.length > 60 ? "…" + a.url.slice(-57) : a.url;
        } else {
          // fallback : premier arg
          const entries = Object.entries(a);
          if (entries.length > 0) {
            const [k, v] = entries[0]!;
            const str = typeof v === "string" ? v : JSON.stringify(v);
            detail = `${k}=${str.slice(0, 40)}`;
          }
        }
      }
      const actionLine = `🔧 ${toolName}${detail ? " • " + detail : ""}`;
      state.actions.push(actionLine);
      state.activeTools.push(actionLine);
      state.toolCount++;
      onUpdate?.(state.actions, { ...state.usage }, [...state.activeTools], elapsed, state.toolCount, state.toolFailCount, state.thinkingPhases, state.thinkingText);
      break;
    }

    // ── Fin d'outil ──
    case "tool_execution_end": {
      const { toolName, isError } = event;
      const idx = state.activeTools.findIndex(a => a.includes(`🔧 ${toolName}`));
      if (idx !== -1) state.activeTools.splice(idx, 1);
      if (isError) state.toolFailCount++;
      state.actions.push(`${isError ? "❌" : "✅"} ${toolName} terminé`);
      onUpdate?.(state.actions, { ...state.usage }, [...state.activeTools], elapsed, state.toolCount, state.toolFailCount, state.thinkingPhases, state.thinkingText);
      break;
    }

    // ── Message final ──
    case "message_end": {
      const msg = event.message;
      if (!msg || msg.role !== "assistant") return;

      if (msg.usage) {
        state.usage.input += msg.usage.input || 0;
        state.usage.output += msg.usage.output || 0;
        state.usage.cacheRead += msg.usage.cacheRead || 0;
        state.usage.cacheWrite += msg.usage.cacheWrite || 0;
        state.usage.cost += msg.usage.cost?.total || 0;
      }
      if (!state.model && msg.model) state.model = msg.model;
      if (msg.errorMessage) state.errorMessage = msg.errorMessage;

      // Reset thinking accumulator for next message
      state.thinkingText = "";

      for (const part of msg.content) {
        if (part.type === "text") {
          state.output = state.output ? state.output + "\n\n" + part.text : part.text;
          const truncated = part.text.length > 100 ? `${part.text.slice(0, 100)}…` : part.text;
          state.actions.push(`💬 ${truncated}`);
          onUpdate?.(state.actions, { ...state.usage }, [...state.activeTools], elapsed, state.toolCount, state.toolFailCount, state.thinkingPhases, state.thinkingText);
        }
      }
      break;
    }
  }
}

// ─── Exécution ──────────────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 600_000; // 10 min
const KILL_TIMEOUT_MS = 5_000;   // 5s entre SIGTERM et SIGKILL

/**
 * Exécute un agent dans un sous-processus isolé
 */
export async function runAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal?: AbortSignal,
  onUpdate?: (actions: string[], usage: AgentUsage, activeTools: string[], durationMs: number, toolCount: number, toolFailCount: number, thinkingPhases: number, thinkingText: string) => void,
): Promise<AgentResult> {
  const startTime = Date.now();
  const finalPrompt = agent.systemPrompt;
  // ── Construction des arguments ──
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);

  // Écrire le system prompt dans un fichier temporaire
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
  const tmpFile = path.join(tmpDir, `prompt-${agent.name}.md`);
  await fs.promises.writeFile(tmpFile, finalPrompt, "utf-8");
  // La tâche est le dernier argument positionnel
  args.push(task);

  // ── État initial ──
  const result: AgentResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    output: "",
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    model: agent.model,
  };

  const state: StreamState = {
    actions: [],
    activeTools: [],
    usage: { ...result.usage },
    output: "",
    thinkingText: "",
    hasSeenNonThinking: false,
    toolCount: 0,
    toolFailCount: 0,
    thinkingPhases: 0,
  };

  let wasAborted = false;

  // ── Spawn ──
  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn("pi", args, {
      cwd,
      env: {
        ...process.env,
        PI_DELEGATED_SUBAGENT: "1",
        PI_DELEGATED_SUBAGENT_NAME: agent.name,
        PI_DELEGATED_AGENT_PROMPT_FILE: tmpFile,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Timer périodique : force un rafraîchissement toutes les secondes
    // pour que la durée affichée s'incrémente même sans événement du sub-agent.
    const tickInterval = onUpdate
      ? setInterval(() => {
          const elapsed = Date.now() - startTime;
          onUpdate(state.actions, { ...state.usage }, [...state.activeTools], elapsed, state.toolCount, state.toolFailCount, state.thinkingPhases, state.thinkingText);
        }, 1000)
      : null;

    let buffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processEvent(line, state, startTime, onUpdate);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processEvent(buffer, state, startTime, onUpdate);
      resolve(code ?? 0);
    });

    proc.on("error", () => resolve(1));

    // ── Timeout ──
    const timeoutId = setTimeout(() => {
      wasAborted = true;
      if (tickInterval) clearInterval(tickInterval);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, KILL_TIMEOUT_MS);
    }, AGENT_TIMEOUT_MS);

    // ── AbortSignal ──
    const onAbort = () => {
      wasAborted = true;
      if (tickInterval) clearInterval(tickInterval);
      clearTimeout(timeoutId);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, KILL_TIMEOUT_MS);
    };

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    // Cleanup en fin de process
    proc.on("close", () => {
      if (tickInterval) clearInterval(tickInterval);
      clearTimeout(timeoutId);
    });
  });

  // ── Finalisation ──
  result.exitCode = exitCode;
  result.output = state.output;
  result.usage = { ...state.usage };
  result.model = state.model || result.model;
  result.errorMessage = state.errorMessage;
  result.actions = state.actions;
  result.durationMs = Date.now() - startTime;
  result.toolCount = state.toolCount;
  result.toolFailCount = state.toolFailCount;
  result.thinkingPhases = state.thinkingPhases;
  result.thinkingText = state.thinkingText;

  // Nettoyage des fichiers temporaires
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

  if (wasAborted) {
    throw new Error("Délégation annulée ou timeout atteint (5 min)");
  }

  return result;
}
