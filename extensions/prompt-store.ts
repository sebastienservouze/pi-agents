/**
 * Records the system prompt ACTUALLY returned by our before_agent_start hook,
 * so `/agent-prompt` can show what was really sent (post-rewrite).
 *
 * - In-memory: first + latest record for the current session.
 * - Persisted: the FIRST sent prompt is stored once as a custom session entry
 *   (never sent to the LLM), so it survives reload/resume/fork.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SentPromptRecord {
  agentName: string | null;
  prompt: string;
  timestamp: number;
  source: "agent" | "auto";
}

const SESSION_PROMPT_TYPE = "nerisma-agents/system-prompt";

let _first: SentPromptRecord | null = null;
let _latest: SentPromptRecord | null = null;

export function recordSentPrompt(
  pi: ExtensionAPI,
  rec: Omit<SentPromptRecord, "timestamp">,
): void {
  _latest = { ...rec, timestamp: Date.now() };
  if (!_first) {
    _first = _latest;
    // Persist once (session-start prompt). Best-effort.
    try {
      pi.appendEntry(SESSION_PROMPT_TYPE, {
        agentName: rec.agentName,
        source: rec.source,
        prompt: rec.prompt,
        timestamp: _latest.timestamp,
      });
    } catch {
      /* persistence is best-effort */
    }
  }
}

export function getFirstSentPrompt(): SentPromptRecord | null {
  return _first;
}

export function getLatestSentPrompt(): SentPromptRecord | null {
  return _latest;
}

/** Minimal session-entry shape (avoids importing the union type). */
interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Reads the persisted session-start prompt (reload/resume case). */
export function readPersistedPrompt(
  entries: readonly SessionEntryLike[],
): SentPromptRecord | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === SESSION_PROMPT_TYPE) {
      const d = e.data as Partial<SentPromptRecord> | undefined;
      if (typeof d?.prompt === "string") {
        return {
          agentName: typeof d.agentName === "string" ? d.agentName : null,
          prompt: d.prompt,
          timestamp: typeof d.timestamp === "number" ? d.timestamp : 0,
          source: d.source === "auto" ? "auto" : "agent",
        };
      }
    }
  }
  return null;
}
