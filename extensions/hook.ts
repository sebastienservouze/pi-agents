/**
 * Agent system hooks
 *
 * - before_agent_start:
 *   - Delegated sub-agent (PI_DELEGATED_SUBAGENT=1):
 *       No prompt work here — the runner passes the composed prompt natively
 *       via `--system-prompt`. This hook only guards against agent-mode logic
 *       (auto-activation…) firing inside the sub-process.
 *
 *   - Active agent (`/agent <name>` mode):
 *       Replaces the system prompt with the agent's, composed with the skills
 *       allow-list, pi's contextFiles, an environment block and the date
 *       (see prompt-build.ts). The sent prompt is recorded for /agent-prompt.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findAgent, DEFAULT_AGENT_TOOLS } from "./registry.js";
import { applyAgent, readPersistedAgent } from "./activation.js";
import { composeAgentPrompt } from "./prompt-build.js";
import { recordSentPrompt } from "./prompt-store.js";
import type { ActiveAgentState } from "./types.js";

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

  // Restore the session's active agent when an existing session is loaded
  // (reload/resume/fork, or startup with a non-empty session). A fresh session
  // has no record, so nothing is restored and the default auto-activation
  // applies as usual. A persisted "off" is respected.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new") return; // brand-new session: nothing to restore

    let record: { name: string | null } | undefined;
    try {
      record = readPersistedAgent(ctx.sessionManager.getEntries());
    } catch {
      return; // fail-open: no restore
    }
    if (!record) return; // no prior intent → let default auto-activation handle it

    // Explicit "off": keep the session deactivated and stop the default from
    // coming back next turn.
    if (record.name === null) {
      autoActivationAttempted = true;
      return;
    }

    // The agent no longer exists → fall back to the default auto-activation.
    const agent = findAgent(ctx.cwd, record.name);
    if (!agent?.systemPrompt) return;

    // Re-apply it and record the state. Setting the state makes before_agent_start
    // take the "active agent" branch, which naturally skips auto-activation.
    try {
      const state = await applyAgent(pi, ctx, agent, null);
      options?.setActiveAgentState?.(state);
      process.env.PI_ACTIVE_AGENT = agent.name;
      try { ctx.ui.setStatus("agent", ctx.ui.theme.fg("accent", `Agent: ${agent.name}`)); } catch {}
    } catch {
      // fail-open: leave default behaviour
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const activeAgentName = getActiveAgentName();

    // ── Delegated sub-agent ──
    // The runner already passed the composed prompt via `--system-prompt`;
    // pi applies it natively. Just make sure no agent-mode logic fires here.
    if (process.env.PI_DELEGATED_SUBAGENT === "1") {
      return;
    }

    // ── Active agent via /agent <name> ──
    // Full replacement of the system prompt with the agent's (composed).
    if (activeAgentName) {
      const agent = findAgent(ctx.cwd, activeAgentName);
      if (!agent?.systemPrompt) {
        return;
      }
      const { prompt, missingSkills } = composeAgentPrompt(pi, ctx.cwd, agent, {
        systemPromptOptions: (event as { systemPromptOptions?: unknown }).systemPromptOptions,
        modelId: ctx.model?.id,
      });
      if (missingSkills.length) {
        try {
          ctx.ui.notify(`Agent "${agent.name}": unknown skills ignored: ${missingSkills.join(", ")}`, "warning");
        } catch { /* no UI */ }
      }
      recordSentPrompt(pi, { agentName: agent.name, prompt, source: "agent" });
      return { systemPrompt: prompt };
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

        const { prompt, missingSkills } = composeAgentPrompt(pi, ctx.cwd, agent, {
          systemPromptOptions: (event as { systemPromptOptions?: unknown }).systemPromptOptions,
          modelId: ctx.model?.id,
        });
        if (missingSkills.length) {
          try {
            ctx.ui.notify(`Agent "${agent.name}": unknown skills ignored: ${missingSkills.join(", ")}`, "warning");
          } catch { /* no UI */ }
        }
        recordSentPrompt(pi, { agentName: agent.name, prompt, source: "auto" });
        return { systemPrompt: prompt };
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
