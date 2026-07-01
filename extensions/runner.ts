/**
 * Runs an agent in an isolated `pi --mode json` sub-process.
 *
 * Each agent runs in spawn("pi", ["--mode", "json", "-p", "--no-session", ...])
 * with its own model, tools, and system prompt.
 *
 * The sub-process emits JSON events (message_update, tool_execution_start,
 * tool_execution_end, message_end) parsed in real time to:
 *   - Track activity (tools used, thinking, writing)
 *   - Accumulate consumption metrics (tokens, cost)
 *   - Collect the final output
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, AgentResult, AgentUsage, AgentProgress, AgentProgressCallback } from "./types.js";

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatTokens(n: number): string {
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

// ─── JSON stream parsing ──────────────────────────────────────────────────────

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

/** Builds the progress snapshot passed to `onUpdate`. */
function snapshot(state: StreamState, durationMs: number): AgentProgress {
  return {
    actions: state.actions,
    activeTools: [...state.activeTools],
    usage: { ...state.usage },
    durationMs,
    toolCount: state.toolCount,
    toolFailCount: state.toolFailCount,
    thinkingPhases: state.thinkingPhases,
    thinkingText: state.thinkingText,
  };
}

/**
 * Summarizes a tool call's arguments into a short, readable one-liner
 * (bash command, file path, grep/web-search query, URL…).
 */
function describeToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;

  // bash: show the command
  if (typeof a.command === "string") {
    return a.command.length > 70 ? a.command.slice(0, 70) + "…" : a.command;
  }
  // read, write, edit, find, ls: path truncated on the left
  if (typeof a.path === "string") {
    return a.path.length > 60 ? "…" + a.path.slice(-57) : a.path;
  }
  // grep: query + path if available
  if (typeof a.query === "string") {
    const suffix = typeof a.path === "string" ? ` in ${a.path}` : "";
    return `"${a.query.slice(0, 40)}"${suffix}`;
  }
  // web_search: first query
  if (Array.isArray(a.queries)) {
    const q = (a.queries as string[])[0] ?? "";
    return `"${q.slice(0, 50)}"`;
  }
  // fetch_content: URL
  if (typeof a.url === "string") {
    return a.url.length > 60 ? "…" + a.url.slice(-57) : a.url;
  }
  // fallback: first argument
  const first = Object.entries(a)[0];
  if (!first) return "";
  const [key, value] = first;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return `${key}=${str.slice(0, 40)}`;
}

function processEvent(
  line: string,
  state: StreamState,
  startTime: number,
  onUpdate?: AgentProgressCallback,
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
    // ── Text streaming ──
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (!ame) return;

      // Thinking-phase counter: incremented even after non-thinking content
      // (otherwise thinkingPhases stays stuck at 1)
      if (ame.type === "thinking_start") {
        state.thinkingPhases++;
      }

      // Ignore thinking_delta only after we've seen non-thinking content.
      // Keep thinking_start/end so the UI shows "thinking…" and the counter works.
      if (state.hasSeenNonThinking && ame.type === "thinking_delta") {
        return;
      }

      // Mark that we've seen real content
      if (
        ame.type === "text_delta" ||
        ame.type === "text_start" ||
        ame.type === "toolcall_delta" ||
        ame.type === "toolcall_start"
      ) {
        state.hasSeenNonThinking = true;
      }

      // Activity line (discriminated by ame.type)
      let actionLine: string;
      switch (ame.type) {
        case "thinking_delta":
          state.thinkingText += ame.delta;
          actionLine = "🧠 thinking…";
          break;
        case "thinking_start":
        case "thinking_end":
          actionLine = "🧠 thinking…";
          break;
        case "text_delta":
        case "text_start":
          actionLine = "💬 writing…";
          break;
        case "toolcall_delta":
        case "toolcall_start":
          actionLine = ""; // hidden: the real tool name arrives in tool_execution_start
          break;
        default:
          actionLine = "💬 writing…";
      }

      if (actionLine && state.actions[state.actions.length - 1] !== actionLine) {
        state.actions.push(actionLine);
      }
      onUpdate?.(snapshot(state, elapsed));
      break;
    }

    // ── Tool start ──
    case "tool_execution_start": {
      const { toolName, args } = event;
      const detail = describeToolArgs(args);
      const actionLine = `🔧 ${toolName}${detail ? " • " + detail : ""}`;
      state.actions.push(actionLine);
      state.activeTools.push(actionLine);
      state.toolCount++;
      onUpdate?.(snapshot(state, elapsed));
      break;
    }

    // ── Tool end ──
    case "tool_execution_end": {
      const { toolName, isError } = event;
      const idx = state.activeTools.findIndex(a => a.includes(`🔧 ${toolName}`));
      if (idx !== -1) state.activeTools.splice(idx, 1);
      if (isError) state.toolFailCount++;
      state.actions.push(`${isError ? "❌" : "✅"} ${toolName} done`);
      onUpdate?.(snapshot(state, elapsed));
      break;
    }

    // ── Final message ──
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

      // Reset thinking accumulator for the next message
      state.thinkingText = "";

      for (const part of msg.content) {
        if (part.type === "text") {
          state.output = state.output ? state.output + "\n\n" + part.text : part.text;
          const truncated = part.text.length > 100 ? `${part.text.slice(0, 100)}…` : part.text;
          state.actions.push(`💬 ${truncated}`);
          onUpdate?.(snapshot(state, elapsed));
        }
      }
      break;
    }
  }
}

// ─── Execution ────────────────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 600_000; // 10 min
const KILL_TIMEOUT_MS = 5_000;    // 5s between SIGTERM and SIGKILL

/**
 * Runs an agent in an isolated sub-process.
 */
export async function runAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal?: AbortSignal,
  onUpdate?: AgentProgressCallback,
): Promise<AgentResult> {
  const startTime = Date.now();
  const finalPrompt = agent.systemPrompt;
  // ── Build the arguments ──
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);

  // The system prompt is written to a temporary file, cleaned up in `finally`.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
  const tmpFile = path.join(tmpDir, `prompt-${agent.name}.md`);
  const cleanupTmp = () => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  };

  try {
    await fs.promises.writeFile(tmpFile, finalPrompt, "utf-8");
    // The task is the last positional argument
    args.push(task);

    // ── Initial state ──
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

      // Periodic tick: forces a refresh every second so the displayed duration
      // keeps incrementing even without an event from the sub-agent.
      const tickInterval = onUpdate
        ? setInterval(() => {
            onUpdate(snapshot(state, Date.now() - startTime));
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

      // Cleanup when the process ends
      proc.on("close", () => {
        if (tickInterval) clearInterval(tickInterval);
        clearTimeout(timeoutId);
      });
    });

    // ── Finalization ──
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

    if (wasAborted) {
      throw new Error(`Delegation cancelled or timeout reached (${formatDuration(AGENT_TIMEOUT_MS)})`);
    }

    return result;
  } finally {
    cleanupTmp();
  }
}
