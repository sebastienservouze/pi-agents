/**
 * Runs an agent in an isolated in-process SDK session.
 *
 * Each agent runs in its own `createAgentSession` (in-memory, no session
 * file), with its own model, tools and system prompt. `pi-agents` itself is
 * excluded from the sub-session's extensions (no `/agent`, no auto-activation,
 * no recursive `delegate`) via `extensionsOverride` on the resource loader —
 * every other extension (context-mode, etc.) is loaded normally so the
 * delegated agent keeps access to their tools when its frontmatter allows
 * them. The `tools:` allow-list itself is enforced natively by the SDK
 * (`CreateAgentSessionOptions.tools`), including for tools registered late by
 * other extensions (e.g. context-mode's lazily-bootstrapped MCP bridge) — no
 * custom guard hook is needed.
 *
 * The system prompt is injected natively via `systemPromptOverride` on the
 * resource loader (replaces pi's default prompt without depending on this
 * extension being loaded in the sub-session), composed with a delegation
 * notice, an environment block and the current date.
 *
 * The session emits AgentSessionEvent objects (message_update,
 * tool_execution_start/end, message_end…) consumed in real time via
 * `session.subscribe()` to:
 *   - Track activity (tools used, thinking, writing)
 *   - Accumulate consumption metrics (tokens, cost)
 *   - Collect the final output
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "./registry.js";
import { currentDateSnippet, delegationSnippet, environmentSnippet } from "./prompt-build.js";
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

// ─── Event stream processing ───────────────────────────────────────────────────

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

/**
 * Processes one AgentSessionEvent from `session.subscribe()`. Same shape and
 * semantics as the former `pi --mode json` stdout events (message_update,
 * tool_execution_start/end, message_end) — this is a direct mapping, not a
 * behavioral change.
 */
function processEvent(
  event: AgentSessionEvent,
  state: StreamState,
  startTime: number,
  onUpdate?: AgentProgressCallback,
): void {
  const elapsed = Date.now() - startTime;

  switch (event.type) {
    // ── Text streaming ──
    case "message_update": {
      const ame = event.assistantMessageEvent as { type: string; delta?: string } | undefined;
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
          state.thinkingText += ame.delta ?? "";
          actionLine = "�� thinking…";
          break;
        case "thinking_start":
        case "thinking_end":
          actionLine = "�� thinking…";
          break;
        case "text_delta":
        case "text_start":
          actionLine = "�� writing…";
          break;
        case "toolcall_delta":
        case "toolcall_start":
          actionLine = ""; // hidden: the real tool name arrives in tool_execution_start
          break;
        default:
          actionLine = "�� writing…";
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
      const actionLine = `�� ${toolName}${detail ? " • " + detail : ""}`;
      state.actions.push(actionLine);
      state.activeTools.push(actionLine);
      state.toolCount++;
      onUpdate?.(snapshot(state, elapsed));
      break;
    }

    // ── Tool end ──
    case "tool_execution_end": {
      const { toolName, isError } = event;
      const idx = state.activeTools.findIndex(a => a.includes(`�� ${toolName}`));
      if (idx !== -1) state.activeTools.splice(idx, 1);
      if (isError) state.toolFailCount++;
      state.actions.push(`${isError ? "❌" : "✅"} ${toolName} done`);
      onUpdate?.(snapshot(state, elapsed));
      break;
    }

    // ── Final message ──
    case "message_end": {
      const msg = event.message as {
        role?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
        model?: string;
        errorMessage?: string;
        content?: Array<{ type: string; text?: string }>;
      };
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

      for (const part of msg.content ?? []) {
        if (part.type === "text" && part.text) {
          state.output = state.output ? state.output + "\n\n" + part.text : part.text;
          const truncated = part.text.length > 100 ? `${part.text.slice(0, 100)}…` : part.text;
          state.actions.push(`�� ${truncated}`);
          onUpdate?.(snapshot(state, elapsed));
        }
      }
      break;
    }
  }
}

// ─── Model resolution ────────────────────────────────────────────────────────

/**
 * Resolves an agent's `model:` frontmatter value ("provider/id" or bare id)
 * against a ModelRegistry. Same lookup rules as activation.ts/hook.ts.
 */
function resolveModel(registry: ModelRegistry, modelSpec: string | undefined) {
  if (!modelSpec) return undefined;
  const slashIdx = modelSpec.indexOf("/");
  return slashIdx !== -1
    ? registry.find(modelSpec.slice(0, slashIdx), modelSpec.slice(slashIdx + 1))
    : registry.getAll().find((m) => m.id === modelSpec);
}

// ─── Execution ────────────────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 600_000; // 10 min

/**
 * Runs an agent in an isolated in-process SDK session.
 */
export async function runAgent(
  cwd: string,
  agent: AgentConfig,
  task: string,
  signal?: AbortSignal,
  onUpdate?: AgentProgressCallback,
): Promise<AgentResult> {
  const startTime = Date.now();
  const agentDir = getAgentDir();

  // Composed prompt: agent .md + delegation notice + environment + date.
  // (Skills are not resolved here: they live in the parent's loader; the
  // sub-session loads its own if `useAgentFile`/skills support is added later.)
  const finalPrompt =
    agent.systemPrompt +
    delegationSnippet(agent.name) +
    environmentSnippet(cwd, agent.model, agent.tools) +
    currentDateSnippet();

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
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let tickInterval: ReturnType<typeof setInterval> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    // ── Resource loader: exclude pi-agents, keep every other extension ──
    // (context-mode, etc.) so the delegated agent gets their tools if its
    // frontmatter `tools:` allows them. Excluding pi-agents avoids its
    // /agent + auto-activation + delegate machinery firing recursively
    // inside the sub-session and overwriting the systemPrompt/tools we set
    // here.
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => finalPrompt,
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (ext) => !ext.resolvedPath.includes("/pi-agents/"),
        ),
      }),
    });
    await loader.reload();

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const resolvedModel = resolveModel(modelRegistry, agent.model);

    const { session: createdSession } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      // Native allow-list enforcement — works even for tools registered late
      // by other extensions (e.g. context-mode's MCP bridge, bootstrapped
      // lazily from its own before_agent_start). No custom guard needed.
      tools: agent.tools?.length ? agent.tools : undefined,
      model: resolvedModel,
      thinkingLevel: agent.thinkingLevel as ThinkingLevel | undefined,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
    });
    session = createdSession;

    // ── Subscribe: map SDK events to the same StreamState as before ──
    unsubscribe = session.subscribe((event) => {
      processEvent(event, state, startTime, onUpdate);
    });

    // Periodic tick: forces a refresh every second so the displayed duration
    // keeps incrementing even without an event from the sub-agent.
    if (onUpdate) {
      tickInterval = setInterval(() => {
        onUpdate(snapshot(state, Date.now() - startTime));
      }, 1000);
    }

    // ── Timeout / abort plumbing ──
    const abortSession = () => {
      wasAborted = true;
      if (tickInterval) clearInterval(tickInterval);
      if (timeoutId) clearTimeout(timeoutId);
      void session?.abort();
    };

    timeoutId = setTimeout(abortSession, AGENT_TIMEOUT_MS);

    onAbort = abortSession;
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    // ── Run the prompt (equivalent of `pi --mode json -p --no-session <task>`) ──
    if (!wasAborted) {
      await session.prompt(task);
    }

    if (tickInterval) clearInterval(tickInterval);
    if (timeoutId) clearTimeout(timeoutId);

    // ── Finalization ──
    result.exitCode = wasAborted ? 1 : 0;
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
    if (tickInterval) clearInterval(tickInterval);
    if (timeoutId) clearTimeout(timeoutId);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    unsubscribe?.();
    session?.dispose();
  }
}
