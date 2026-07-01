/**
 * Single source of truth: the tools ACTUALLY sent to the provider.
 *
 * The context-mode MCP bridge registers its whole `ctx_*` family via
 * `pi.registerTool()`, which adds them to the ACTIVE SET (`getActiveTools()`)
 * even when the agent frontmatter does not declare them. The
 * `before_provider_request` guard (hook.ts) strips them from the payload at the
 * last moment; but `getActiveTools()` stays polluted, so any UI that shows it
 * as-is LIES about what goes over the wire.
 *
 * This function computes what is actually sent: `active ∩ frontmatter allow-list`.
 * The guard (hook.ts) AND the UI (nerisma-input) must both align on it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findAgent } from "./registry.js";

/**
 * Names of the tools effectively sent to the provider for (cwd, active agent).
 *
 *   - no active agent, or agent without `tools:` → all active tools (no filtering).
 *   - otherwise → intersection of active tools with the frontmatter allow-list.
 *
 * `agentName` typically comes from `process.env.PI_ACTIVE_AGENT` (set by the
 * agents extension) on the UI side, or from internal state on the hook side.
 */
export function effectiveToolNames(
  pi: ExtensionAPI,
  cwd: string,
  agentName: string | null | undefined,
): string[] {
  const active = pi.getActiveTools();
  if (!agentName) return active;
  const allow = findAgent(cwd, agentName)?.tools;
  if (!allow?.length) return active;
  const allowSet = new Set(allow);
  return active.filter((name) => allowSet.has(name));
}
