/**
 * Shared agent-activation core + per-session persistence.
 *
 * - `applyAgent` mutates the live session (tools, thinking level, model) and
 *   returns the state to record. Used by `/agent`, auto-activation restore, and
 *   the session restore hook.
 * - The session helpers persist the active agent as a `custom` session entry so
 *   it can be restored on reload/resume/fork (see hook.ts `session_start`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_AGENT_TOOLS } from "./registry.js";
import type { AgentConfig, ActiveAgentState } from "./types.js";

/**
 * Applies an agent's tools, thinking level and model to the live session.
 *
 * `prevState` carries the original (pre-agent) settings to preserve for
 * `/agent off`: pass the current state to keep an already-saved restore point,
 * or null to capture the current settings as the restore point. Returns the
 * state to record via `setState`.
 */
export async function applyAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agent: AgentConfig,
  prevState: ActiveAgentState | null,
): Promise<ActiveAgentState> {
  // Capture the pre-activation settings once, so `/agent off` can restore them.
  const saved = prevState ?? {
    name: agent.name,
    savedTools: pi.getActiveTools(),
    savedModelId: ctx.model?.id,
    savedThinkingLevel: pi.getThinkingLevel(),
  };

  const toolsToSet = agent.tools?.length ? agent.tools : DEFAULT_AGENT_TOOLS;
  pi.setActiveTools(toolsToSet);

  if (agent.thinkingLevel) {
    pi.setThinkingLevel(agent.thinkingLevel as ThinkingLevel);
  }

  if (agent.model) {
    // Supports both "provider/model" (composite) and "model" (id only)
    const slashIdx = agent.model.indexOf("/");
    const model = slashIdx !== -1
      ? ctx.modelRegistry.find(agent.model.slice(0, slashIdx), agent.model.slice(slashIdx + 1))
      : ctx.modelRegistry.getAll().find((m) => m.id === agent.model);

    if (model) {
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`Agent "${agent.name}": model "${agent.model}" without configured API key`, "warning");
      }
    } else {
      ctx.ui.notify(`Agent "${agent.name}": model "${agent.model}" not found`, "warning");
    }
  }

  return { ...saved, name: agent.name };
}

// ─── Per-session persistence ──────────────────────────────────────────────────

/** customType tag for our session entries. */
const SESSION_AGENT_TYPE = "nerisma-agents/active";

/** Minimal shape of a session entry we care about (avoids importing the union). */
interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * Records the active agent (or `null` when deactivated) as a custom session
 * entry, so it can be restored on reload. Append-only; the last entry wins.
 * Never sent to the LLM. Non-fatal on failure.
 */
export function persistActiveAgent(pi: ExtensionAPI, name: string | null): void {
  try {
    pi.appendEntry(SESSION_AGENT_TYPE, { name });
  } catch {
    // persistence is best-effort
  }
}

/**
 * Reads the last recorded active-agent intent from the session entries.
 *   - `{ name: "<agent>" }` — an agent was active
 *   - `{ name: null }`      — explicitly deactivated (`/agent off`)
 *   - `undefined`           — no record (fresh session)
 */
export function readPersistedAgent(
  entries: readonly SessionEntryLike[],
): { name: string | null } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === SESSION_AGENT_TYPE) {
      const data = e.data as { name?: string | null } | undefined;
      return { name: typeof data?.name === "string" ? data.name : null };
    }
  }
  return undefined;
}
