/**
 * Records the tool list ACTUALLY sent in the last provider request, captured
 * in the before_provider_request hook AFTER the allow-list guard has run —
 * so `/agent-tools` shows the real, final list (not the configured one).
 */

export interface SentToolsRecord {
  agentName: string | null;
  tools: string[];
  /** false when the guard couldn't locate a `tools` array in the payload
   * (provider/wire-format not recognized) — `tools` is empty in that case. */
  found: boolean;
  /** true when an active agent's allow-list was enforced on this request. */
  guardApplied: boolean;
  timestamp: number;
}

export const AGENT_TOOLS_VIEW_TYPE = "nerisma-agents/agent-tools-view";

let _latest: SentToolsRecord | null = null;

export function recordSentTools(rec: Omit<SentToolsRecord, "timestamp">): void {
  _latest = { ...rec, timestamp: Date.now() };
}

export function getLatestSentTools(): SentToolsRecord | null {
  return _latest;
}
