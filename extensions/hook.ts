/**
 * Agent system hooks
 *
 * Note: delegated sub-agents no longer load this extension at all — the
 * runner (runner.ts) excludes pi-agents from the sub-session's extensions via
 * `extensionsOverride` and injects the system prompt/tools directly through
 * the SDK (`systemPromptOverride`, `tools:`). There is nothing to guard
 * against here anymore for delegated sub-agents; this file only runs in the
 * orchestrating (parent) session.
 *
 * - before_agent_start:
 *   - Active agent (`/agent <name>` mode):
 *       Replaces the system prompt with the agent's, composed with the skills
 *       allow-list, pi's contextFiles, an environment block and the date
 *       (see prompt-build.ts). The sent prompt is recorded for /agent-prompt.
 *       Also re-applies the tool allow-list on `state.tools` so ctx_* (injected
 *       by context-mode's `before_agent_start` handler, which fires first
 *       because npm extensions load before local ones) are stripped — works for
 *       ALL providers including custom streamSimple transports that bypass
 *       `before_provider_request` (e.g. pi-anthropic-oauth).
 *
 *   - Auto-activation:
 *       Activates a default agent once per session (system prompt, tools, model,
 *       thinking level). Opt-in via PI_DEFAULT_AGENT.
 *
 *   - Main agent (normal mode):
 *       No modification — pi handles APPEND_SYSTEM.md.
 *
 * - before_provider_request (safety net):
 *       Also enforces the tool allow-list on the provider payload. This is the
 *       SECOND filtering point — the primary one is `before_agent_start`
 *       (above), which works for ALL providers. This hook only fires for the
 *       built-in transport; it stays as a defense-in-depth guard and a fallback
 *       `recordSentTools` for providers that do call `onPayload`.
 *
 * - context:
 *       Strips the /agent-prompt and /agent-tools viewer messages (display-only
 *       chat messages) from the LLM context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findAgent, DEFAULT_AGENT_TOOLS } from "./registry.js";
import { applyAgent, readPersistedAgent } from "./activation.js";
import { composeAgentPrompt } from "./prompt-build.js";
import { AGENT_PROMPT_VIEW_TYPE, recordSentPrompt } from "./prompt-store.js";
import { AGENT_TOOLS_VIEW_TYPE, recordSentTools } from "./tools-store.js";
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

  async function activateDefaultAgent(ctx: ExtensionContext): Promise<void> {
    const agentName = options?.autoActivateAgentName;
    if (!agentName || autoActivationAttempted) return;
    autoActivationAttempted = true;

    const agent = findAgent(ctx.cwd, agentName);
    if (!agent?.systemPrompt) return;

    try {
      const state = await applyAgent(pi, ctx, agent, null);
      options?.setActiveAgentState?.(state);
      process.env.PI_ACTIVE_AGENT = agent.name;
      try { ctx.ui.setStatus("agent", ctx.ui.theme.fg("accent", `Agent: ${agent.name}`)); } catch {}
      try { ctx.ui.notify(`Agent "${agent.name}" activated automatically`, "info"); } catch {}
    } catch {
      // fail-open: use Pi's default session settings
    }
  }

  // Restore the session's active agent when an existing session is loaded
  // (reload/resume/fork, or startup with a non-empty session). A fresh session
  // has no record, so nothing is restored and the default auto-activation
  // applies as usual. A persisted "off" is respected.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new") {
      await activateDefaultAgent(ctx);
      return;
    }

    let record: { name: string | null } | undefined;
    try {
      record = readPersistedAgent(ctx.sessionManager.getEntries());
    } catch {
      return; // fail-open: no restore
    }
    if (!record) {
      await activateDefaultAgent(ctx);
      return;
    }

    // Explicit "off": keep the session deactivated and stop the default from
    // coming back next turn.
    if (record.name === null) {
      autoActivationAttempted = true;
      return;
    }

    // The agent no longer exists → fall back to the default auto-activation.
    const agent = findAgent(ctx.cwd, record.name);
    if (!agent?.systemPrompt) {
      await activateDefaultAgent(ctx);
      return;
    }

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

      // Re-apply the tool allow-list on `state.tools` so ctx_* (injected by
      // context-mode's before_agent_start handler, which fires before ours
      // because npm extensions load before local ones) are stripped. This makes
      // the filtering work for ALL providers — including custom streamSimple
      // transports (e.g. pi-anthropic-oauth) that bypass before_provider_request.
      // Also records the final list so /agent-tools works for every provider.
      try {
        const toolsToSet = agent.tools?.length ? agent.tools : DEFAULT_AGENT_TOOLS;
        pi.setActiveTools(toolsToSet);
        recordSentTools({
          agentName: agent.name,
          tools: pi.getActiveTools(),
          found: true,
          guardApplied: true,
        });
      } catch { /* fail-open */ }

      return { systemPrompt: prompt };
    }

    // ── Main agent (no auto-activation) ──
    // pi injects APPEND_SYSTEM.md automatically — no modification.
    return;
  });

  // The /agent-prompt viewer message (customType AGENT_PROMPT_VIEW_TYPE) is
  // display-only: strip it from the LLM context so it never burns tokens or
  // confuses the model with its own prompt.
  const VIEWER_TYPES = new Set([AGENT_PROMPT_VIEW_TYPE, AGENT_TOOLS_VIEW_TYPE]);
  pi.on("context", async (event) => {
    const messages = event.messages as Array<{ role?: string; customType?: string }>;
    const filtered = messages.filter(
      (m) => !(m.role === "custom" && m.customType && VIEWER_TYPES.has(m.customType)),
    );
    if (filtered.length !== messages.length) {
      return { messages: filtered as typeof event.messages };
    }
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

      // Record the FINAL tool list for /agent-tools — taken after the guard
      // above ran, so it reflects exactly what goes out on the wire.
      recordSentTools({
        agentName: getActiveAgentName(),
        tools: (tools ?? []).map(toolName).filter((n): n is string => !!n).sort(),
        found: !!tools,
        guardApplied: !!allowSet,
      });
    } catch {
      // fail-open: payload unchanged
    }

    return payload;
  });
}
