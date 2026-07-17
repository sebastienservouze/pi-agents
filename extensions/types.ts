/**
 * Shared types for the agent system
 */

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  /** Skill names selected in frontmatter. Project-local skills are always
   * advertised as well; absent → project-local skills only. */
  skills?: string[];
  model?: string;
  thinkingLevel?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
  /** If true, loads AGENTS.md from the current directory and appends it to the
   * system prompt. Silent if absent. */
  useAgentFile?: boolean;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * Progress snapshot of a delegated agent, emitted on every sub-process event.
 * Replaces a callback that took 8 positional arguments.
 */
export interface AgentProgress {
  actions: string[];
  activeTools: string[];
  usage: AgentUsage;
  durationMs: number;
  toolCount: number;
  toolFailCount: number;
  thinkingPhases: number;
  thinkingText: string;
}

export type AgentProgressCallback = (progress: AgentProgress) => void;

export interface AgentResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  usage: AgentUsage;
  model?: string;
  errorMessage?: string;
  actions?: string[];
  durationMs?: number;
  toolCount?: number;
  toolFailCount?: number;
  thinkingPhases?: number;
  thinkingText?: string;
}

export interface DelegateParams {
  agent: string;
  task: string;
}

export interface DelegateDetails {
  agent: string;
  task: string;
  exitCode: number;
  usage: AgentUsage;
  model?: string;
  errorMessage?: string;
  actions?: string[];
  activeTools?: string[];
  durationMs?: number;
  toolCount?: number;
  toolFailCount?: number;
  thinkingPhases?: number;
  thinkingText?: string;
}

export interface ActiveAgentState {
  name: string;
  savedTools: string[];
  savedModelId?: string;
  savedThinkingLevel?: string;
}
