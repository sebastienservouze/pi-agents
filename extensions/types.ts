/**
 * Types partagés pour le système d'agents
 */

export interface AgentConfig {
  name: string;
  description: string;
  /** DEPRECATED : Les règles de délégation sont dans APPEND_SYSTEM.md
   * Ce champ est conservé pour compatibilité arrière mais n'est plus utilisé. */
  whenToDelegate?: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
  outputFormat?: "text" | "json" | "markdown";
  /** Si true, charge AGENTS.md / CLAUDE.md du répertoire courant et l'appende au system prompt. Silencieux si absent. */
  useAgentFile?: boolean;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

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

export interface AgentOverride {
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: string;
  outputFormat?: "text" | "json" | "markdown";
}

export interface AgentConfigFile {
  agents?: Record<string, AgentOverride>;
}

export interface DelegateParams {
  agent: string;
  task: string;
  outputFormat?: "text" | "json" | "markdown";
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
  outputFormat?: string;
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
