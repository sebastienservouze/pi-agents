/**
 * `delegate` tool — delegates a task to a specialized agent
 *
 * Single entry point for orchestration:
 *   - explorer (codebase exploration)
 *   - researcher (web/doc research)
 *   - planner (technical plan)
 *   - worker (execution)
 *
 * Each agent runs in a separate `pi --mode json` process.
 * The result includes consumption metrics (tokens, cost).
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./registry.js";
import { runAgent, formatDuration, formatTokens } from "./runner.js";
import type { AgentResult, DelegateDetails } from "./types.js";

const DelegateParams = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate, with all necessary context" }),
});

/**
 * Builds promptGuidelines dynamically from the discovered agents.
 */
function buildPromptGuidelines(agents: ReturnType<typeof discoverAgents>): string[] {
  const guidelines: string[] = [
    "Use delegate to hand off to specialized agents. Describe the CONCEPT or TASK to solve.",
  ];
  
  for (const agent of agents) {
    guidelines.push(`delegate ${agent.name} — ${agent.description}`);
  }
  
  return guidelines;
}

export function registerDelegateTool(pi: ExtensionAPI): void {
  let cachedGuidelines: string[] | null = null;
  
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: [
      "Delegates a task to a specialized agent working in an isolated context.",
      "The agent receives the task, works autonomously, and returns its result.",
      "Use to break down complex requests into specialized sub-tasks.",
    ].join(" "),
    promptSnippet: "Delegate a task to a specialized agent that works in isolation and returns a targeted summary",
    promptGuidelines: (() => cachedGuidelines || [
      "Use delegate to hand off to specialized agents. Describe the CONCEPT or TASK to solve.",
    ]) as unknown as string[],
    parameters: DelegateParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Discover agents and cache the guidelines on the first call
      const agents = discoverAgents(ctx.cwd);
      if (!cachedGuidelines) {
        cachedGuidelines = buildPromptGuidelines(agents);
      }

      // Normalize case: the LLM may pass "EXPLORER" while the frontmatter
      // declares name: explorer. Match case-insensitively, then use the
      // canonical name from the frontmatter.
      const needle = params.agent.toLowerCase();
      const agent = agents.find((a) => a.name.toLowerCase() === needle);

      if (!agent) {
        const available = agents.map((a) => a.name).join(", ");
        return {
          content: [{ type: "text", text: `Unknown agent "${params.agent}". Available agents: ${available}` }],
          details: {
            agent: params.agent,
            task: params.task,
            exitCode: 1,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            errorMessage: `Unknown agent "${params.agent}".`,
          } as DelegateDetails,
        };
      }

      // Run the agent
      const result: AgentResult = await runAgent(
        ctx.cwd,
        agent,
        params.task,
        signal,
        onUpdate
          ? (progress) => {
              const latestAction = progress.actions[progress.actions.length - 1] || "";
              onUpdate({
                content: [{ type: "text", text: latestAction }],
                details: {
                  agent: agent.name,
                  task: params.task,
                  exitCode: 0,
                  usage: progress.usage,
                  actions: progress.actions,
                  activeTools: progress.activeTools,
                  durationMs: progress.durationMs,
                  toolCount: progress.toolCount,
                  toolFailCount: progress.toolFailCount,
                  thinkingPhases: progress.thinkingPhases,
                  thinkingText: progress.thinkingText,
                } as DelegateDetails,
              });
            }
          : undefined,
      );

      const details: DelegateDetails = {
        agent: result.agent,
        task: result.task,
        exitCode: result.exitCode,
        usage: result.usage,
        model: result.model,
        errorMessage: result.errorMessage,
        actions: result.actions,
        durationMs: result.durationMs,
        toolCount: result.toolCount,
        toolFailCount: result.toolFailCount,
        thinkingPhases: result.thinkingPhases,
        thinkingText: result.thinkingText,
      };

      // ── Error ──
      if (result.exitCode !== 0 || result.errorMessage) {
        const errMsg = result.errorMessage || result.stderr || result.output || "Unknown error";
        return {
          content: [{ type: "text", text: `❌ ${result.agent} failed: ${errMsg}` }],
          details,
          isError: true,
        };
      }

      // ── Success — metrics go in details, not in the text ──
      const outputText = result.output || "(no output)";

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },

    // ── TUI rendering ──
    renderCall(args, theme, _context) {
      const agentName = args.agent || "...";
      const task = args.task || "...";

      // Compact mode: agent + full prompt
      let text = theme.fg("toolTitle", theme.bold(`delegate → ${agentName}`));
      text += `\n\n${theme.fg("toolOutput", `"${task}"`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial, expanded }, theme, context) {
      const details = result.details as DelegateDetails | undefined;
      const output = result.content?.[0];
      const outputText = output?.type === "text" ? output.text : "(no output)";
      const isError = context.isError;

      // ── Partial update (live status) ──
      if (isPartial) {
        const details = result.details as DelegateDetails | undefined;
        const actions = details?.actions ?? [];

        // Filter out successes (✅) but keep failures (❌) visible
        const filtered = actions.filter(a => !a.startsWith("✅"));

        // Live metrics: tokens ↑↓, cost, duration
        const metricsLine = buildMetricsLine(details, "  ");

        // Live expanded view: all accumulated actions + thinking text
        if (expanded) {
          const allActions = filtered.length > 0
            ? filtered.map(a => `  ${a}`).join("\n")
            : "…";
          let text = `
${theme.fg("toolTitle", theme.bold(`delegate → ${details?.agent ?? "?"}`))}

${theme.fg("toolOutput", allActions)}`;
          if (details?.thinkingText) {
            const truncatedThinking = details.thinkingText.length > 500
              ? details.thinkingText.slice(0, 500) + "…"
              : details.thinkingText;
            text += `

${theme.fg("dim", `🧠 ${truncatedThinking}`)}`;
          }
          if (metricsLine) text += `

${theme.fg("dim", metricsLine)}`;
          return new Text(text, 0, 0);
        }

        // Live compact view: last action only
        const last = filtered[filtered.length - 1];
        const actionLine = last ?? (result.content?.[0]?.type === "text" ? result.content[0].text : "…");

        let text = `
${theme.fg("toolOutput", actionLine)}`;
        if (metricsLine) text += `

${theme.fg("dim", metricsLine)}`;
        return new Text(text, 0, 0);
      }

      const icon = isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");

      // Expanded or compact view (final)
      let text = `
${icon} ${theme.fg("toolTitle", theme.bold(details?.agent ?? "?"))}`;
      if (expanded) {
        text += `\n${theme.fg("toolOutput", outputText)}`;
        if (details?.thinkingText) {
          const truncatedThinking = details.thinkingText.length > 500
            ? details.thinkingText.slice(0, 500) + "…"
            : details.thinkingText;
          text += `\n\n${theme.fg("dim", `🧠 ${truncatedThinking}`)}`;
        }
      } else {
        text += `\n\n${theme.fg("toolOutput", "(Ctrl+O to see full response)")}`;
      }
      if (details?.usage) {
        const metricsLine = buildMetricsLine(details, "");
        if (metricsLine) text += `\n${theme.fg("dim", metricsLine)}`;
      }
      return new Text(text, 0, 0);
    },
  });
}

function buildMetricsLine(details: DelegateDetails | undefined, prefix: string): string {
  if (!details?.usage) return "";
  const parts: string[] = [];
  if (details.usage.input) parts.push(`↑${formatTokens(details.usage.input)}`);
  if (details.usage.output) parts.push(`↓${formatTokens(details.usage.output)}`);
  if (details.usage.cost) parts.push(`$${details.usage.cost.toFixed(4)}`);
  if (details.model) parts.push(details.model);
  if (details.toolCount) parts.push(`🔧 ${details.toolCount}`);
  if (details.toolFailCount) parts.push(`❌ ${details.toolFailCount}`);
  if (details.thinkingPhases) parts.push(`🧠 ${details.thinkingPhases}`);
  if (details.durationMs) parts.push(formatDuration(details.durationMs));
  return parts.length ? prefix + parts.join(" • ") : "";
}
