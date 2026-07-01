/**
 * Agent system hooks
 *
 * - before_agent_start:
 *   - Delegated sub-agent (PI_DELEGATED_SUBAGENT=1):
 *       Reads PI_DELEGATED_AGENT_PROMPT_FILE and uses it as the EXCLUSIVE system
 *       prompt. Guarantees: no default pi prompt, only the agent's .md.
 *
 *   - Active agent (`/agent <name>` mode):
 *       Replaces the system prompt with the agent's.
 *
 *   - Auto-activation:
 *       Activates a default agent once per session (system prompt, tools, model,
 *       thinking level). Opt-in via PI_DEFAULT_AGENT.
 *
 *   - Main agent (normal mode):
 *       No modification — pi handles APPEND_SYSTEM.md.
 *
 * - before_provider_request:
 *       Enforces the active agent's tool allow-list on the payload. The MCP
 *       bridge (context-mode) injects its whole ctx_* family on top of the
 *       frontmatter; here, at the last moment before sending, we keep only the
 *       tools declared in `tools:`. Fail-open.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findAgent, DEFAULT_AGENT_TOOLS } from "./registry.js";
import type { ActiveAgentState } from "./types.js";

// ─── useAgentFile: loading the cwd's AGENTS.md file ──────────────────────────

/**
 * Looks for AGENTS.md in `cwd`.
 * Returns the content wrapped in <project_context> tags (same format as pi),
 * or null if no file is found or it cannot be read.
 */
function loadAgentFileFromCwd(cwd: string): string | null {
  const filePath = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return (
      `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n` +
      `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n` +
      `</project_context>\n`
    );
  } catch {
    return null;
  }
}

// ─── Reading the `tools` array from the provider payload ─────────────────────

/**
 * Looks for the `tools` array in the provider payload (shape is `unknown`,
 * provider-specific). We try the common locations.
 */
function findToolsArray(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const nested = (k: string) => (p[k] as Record<string, unknown> | undefined)?.tools;
  for (const c of [p.tools, nested("body"), nested("request"), nested("params")]) {
    if (Array.isArray(c)) return c;
  }
  return null;
}

/** Name of a tool entry, whatever the wire format (OpenAI/Anthropic/pi). */
function toolName(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return undefined;
  const o = t as { name?: string; function?: { name?: string } };
  return o.name ?? o.function?.name;
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerHooks(
  pi: ExtensionAPI,
  getActiveAgentName: () => string | null,
  options?: {
    autoActivateAgentName?: string;
    setActiveAgentState?: (s: ActiveAgentState | null) => void;
  },
): void {
  // Auto-activation runs at most once per session. Set on the first attempt
  // (even if the agent is missing) so it never re-fires — and so a later
  // `/agent off` is respected instead of being undone next turn.
  let autoActivationAttempted = false;

  // The tool guard fails open. If it ever can't locate the payload's tools
  // array while an allow-list is active, the allow-list is NOT enforced — warn
  // once so a silent bypass doesn't go unnoticed.
  let warnedGuardBypass = false;

  pi.on("before_agent_start", async (event, ctx) => {
    const activeAgentName = getActiveAgentName();
    const isDelegatedSubAgent = process.env.PI_DELEGATED_SUBAGENT === "1";

    // ── Delegated sub-agent ──
    // Use ONLY the prompt file passed by the runner.
    // Guarantees: no default pi prompt, no parent/child stacking.
    if (isDelegatedSubAgent) {
      const promptFile = process.env.PI_DELEGATED_AGENT_PROMPT_FILE;
      if (promptFile) {
        try {
          const content = fs.readFileSync(promptFile, "utf-8");
          return { systemPrompt: content };
        } catch {
          // File unreadable: fall back without modification
        }
      }
      return;
    }

    // ── Active agent via /agent <name> ──
    // Full replacement of the system prompt with the agent's.
    if (activeAgentName) {
      const agent = findAgent(ctx.cwd, activeAgentName);
      if (!agent?.systemPrompt) {
        return;
      }
      const finalPrompt =
        agent.useAgentFile
          ? agent.systemPrompt + (loadAgentFileFromCwd(ctx.cwd) ?? "")
          : agent.systemPrompt;
      return { systemPrompt: finalPrompt };
    }

    // ── Auto-activation (main agent, a default agent is configured) ──
    const { autoActivateAgentName, setActiveAgentState } = options ?? {};
    if (autoActivateAgentName && !autoActivationAttempted) {
      autoActivationAttempted = true;
      const agent = findAgent(ctx.cwd, autoActivateAgentName);
      if (agent?.systemPrompt) {
        // Capture the ORIGINAL state before mutating anything, so `/agent off`
        // can restore the true defaults rather than the agent's own settings.
        const savedTools = pi.getActiveTools();
        const savedModelId = ctx.model?.id;
        const savedThinkingLevel = pi.getThinkingLevel();

        // Apply the agent's tools
        const toolsToSet = agent.tools?.length ? agent.tools : DEFAULT_AGENT_TOOLS;
        try { pi.setActiveTools(toolsToSet); } catch { /* fail open */ }

        // Apply the thinking level
        if (agent.thinkingLevel) {
          try { pi.setThinkingLevel(agent.thinkingLevel as any); } catch { /* fail open */ }
        }

        // Apply the model
        if (agent.model) {
          try {
            const slashIdx = agent.model.indexOf("/");
            const model = slashIdx !== -1
              ? ctx.modelRegistry.find(agent.model.slice(0, slashIdx), agent.model.slice(slashIdx + 1))
              : ctx.modelRegistry.getAll().find((m: any) => m.id === agent.model);
            if (model) await pi.setModel(model);
          } catch { /* fail open */ }
        }

        // Record the original state so before_provider_request filters tools and
        // `/agent off` restores the defaults.
        if (setActiveAgentState) {
          setActiveAgentState({
            name: agent.name,
            savedTools,
            savedModelId,
            savedThinkingLevel,
          });
        }
        process.env.PI_ACTIVE_AGENT = agent.name;
        try { ctx.ui.setStatus("agent", ctx.ui.theme.fg("accent", `Agent: ${agent.name}`)); } catch {}
        try { ctx.ui.notify(`Agent "${agent.name}" activated automatically`, "info"); } catch {}

        const finalPromptAuto =
          agent.useAgentFile
            ? agent.systemPrompt + (loadAgentFileFromCwd(ctx.cwd) ?? "")
            : agent.systemPrompt;
        return { systemPrompt: finalPromptAuto };
      }
    }

    // ── Main agent (no auto-activation) ──
    // pi injects APPEND_SYSTEM.md automatically — no modification.
    return;
  });

  // At provider-request time, enforce the active agent's allow-list on the
  // payload tools. Nothing else is touched (returning the payload, mutated in
  // place, sends it as-is).
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;

    // Active agent's frontmatter allow-list.
    let allowSet: Set<string> | undefined;
    try {
      const agentName = getActiveAgentName();
      if (agentName) {
        const allow = findAgent(ctx.cwd, agentName)?.tools;
        if (allow?.length) allowSet = new Set(allow);
      }
    } catch {
      // fail-open: no allow-list → no filtering
    }

    // Enforce the active agent's allow-list on the payload tools: keep only the
    // tools whose name is declared in `tools:`. Fail-open.
    try {
      const tools = findToolsArray(payload);

      // Allow-list active but the tools array couldn't be located: the guard
      // can't enforce anything and every tool goes through. Surface it once.
      if (allowSet && !tools && !warnedGuardBypass) {
        warnedGuardBypass = true;
        try {
          ctx.ui?.notify?.(
            `Tool guard inactive: "tools" array not found in payload — agent's allow-list is NOT applied.`,
            "warning",
          );
        } catch { /* no UI available in this context */ }
      }

      if (allowSet && tools) {
        const kept = tools.filter((t) => {
          const n = toolName(t);
          // Fail-open on undetectable names: keep the tool rather than risk
          // stripping a legitimate one whose wire format we don't recognize.
          return n === undefined || allowSet!.has(n);
        });
        if (kept.length !== tools.length) {
          tools.length = 0; // in-place mutation (same reference held by the payload)
          tools.push(...kept);
        }
      }
    } catch {
      // fail-open: payload unchanged
    }

    return payload;
  });
}
