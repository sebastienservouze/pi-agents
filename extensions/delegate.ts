/**
 * Outil `delegate` — délègue une tâche à un agent spécialisé
 *
 * Point d'entrée unique pour l'orchestration :
 *   - explorer (exploration codebase)
 *   - researcher (recherche web/doc)
 *   - planner (plan technique)
 *   - worker (exécution)
 *
 * Chaque agent tourne dans un processus pi --mode json séparé.
 * Le résultat inclut les métriques de consommation (tokens, coût).
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./registry.js";
import { runAgent, formatDuration } from "./runner.js";
import type { AgentResult, DelegateDetails } from "./types.js";

const DelegateParams = Type.Object({
  agent: Type.String({ description: "Nom de l'agent à invoquer" }),
  task: Type.String({ description: "Tâche à déléguer, avec tout le contexte nécessaire" }),
  outputFormat: Type.Optional(
    Type.Union(
      [
        Type.Literal("text"),
        Type.Literal("json"),
        Type.Literal("markdown"),
      ],
      { description: "Format de sortie attendu" }
    )
  ),
});

/**
 * Construit les promptGuidelines dynamiquement basées sur les agents découverts
 */
function buildPromptGuidelines(agents: ReturnType<typeof discoverAgents>): string[] {
  const guidelines: string[] = [
    "Utilise delegate pour déléguer à des agents spécialisés. Décris le CONCEPT ou la TÂCHE à résoudre.",
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
      "Délègue une tâche à un agent spécialisé qui travaille en contexte isolé.",
      "L'agent reçoit la tâche, travaille de façon autonome, et renvoie son résultat.",
      "Utilise pour décomposer une demande complexe en sous-tâches spécialisées.",
    ].join(" "),
    promptSnippet: "Délègue une tâche à un agent spécialisé qui travaille en contexte isolé et retourne un résumé ciblé",
    promptGuidelines: (() => cachedGuidelines || [
      "Utilise delegate pour déléguer à des agents spécialisés. Décris le CONCEPT ou la TÂCHE à résoudre.",
    ]) as unknown as string[],
    parameters: DelegateParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Découvrir les agents et mettre en cache les guidelines au premier appel
      const agents = discoverAgents(ctx.cwd);
      if (!cachedGuidelines) {
        cachedGuidelines = buildPromptGuidelines(agents);
      }

      // Normaliser la casse : le LLM peut passer "EXPLORER" alors que le
      // frontmatter déclare name: explorer. On cherche en case-insensitive
      // puis on utilise le nom canonique du frontmatter.
      const needle = params.agent.toLowerCase();
      const agent = agents.find((a) => a.name.toLowerCase() === needle);

      if (!agent) {
        const available = agents.map((a) => a.name).join(", ");
        return {
          content: [{ type: "text", text: `Agent "${params.agent}" inconnu. Agents disponibles : ${available}` }],
          details: {
            agent: params.agent,
            task: params.task,
            exitCode: 1,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            errorMessage: `Agent "${params.agent}" inconnu.`,
          } as DelegateDetails,
        };
      }

      // Injecter le format attendu dans la tâche si spécifié
      const taskWithHint = params.outputFormat
        ? `${params.task}\n\n[Format de sortie attendu : ${params.outputFormat}]`
        : params.task;

      // Lancer l'agent
      const result: AgentResult = await runAgent(
        ctx.cwd,
        agent,
        taskWithHint,
        signal,
        onUpdate
          ? (actions, usage, activeTools, durationMs, toolCount, toolFailCount, thinkingPhases, thinkingText) => {
              const latestAction = actions[actions.length - 1] || "";
              onUpdate({
                content: [{ type: "text", text: latestAction }],
                details: {
                  agent: agent.name,
                  task: params.task,
                  exitCode: 0,
                  usage,
                  actions,
                  activeTools,
                  durationMs,
                  toolCount,
                  toolFailCount,
                  thinkingPhases,
                  thinkingText,
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
        outputFormat: params.outputFormat,
        durationMs: result.durationMs,
        toolCount: result.toolCount,
        toolFailCount: result.toolFailCount,
        thinkingPhases: result.thinkingPhases,
        thinkingText: result.thinkingText,
      };

      // ── Erreur ──
      if (result.exitCode !== 0 || result.errorMessage) {
        const errMsg = result.errorMessage || result.stderr || result.output || "Erreur inconnue";
        return {
          content: [{ type: "text", text: `❌ ${result.agent} a échoué : ${errMsg}` }],
          details,
          isError: true,
        };
      }

      // ── Succès — métriques dans details, pas dans le texte ──
      const outputText = result.output || "(pas de sortie)";

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },

    // ── Rendu TUI ──
    renderCall(args, theme, _context) {
      const agentName = args.agent || "...";
      const task = args.task || "...";

      // Mode compact : agent + prompt complet
      let text = theme.fg("toolTitle", theme.bold(`delegate → ${agentName}`));
      text += `\n\n${theme.fg("toolOutput", `"${task}"`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial, expanded }, theme, context) {
      const details = result.details as DelegateDetails | undefined;
      const output = result.content?.[0];
      const outputText = output?.type === "text" ? output.text : "(pas de sortie)";
      const isError = context.isError;

      // ── Mise à jour partielle (statut live) ──
      if (isPartial) {
        const details = result.details as DelegateDetails | undefined;
        const actions = details?.actions ?? [];

        // Filtrer les succès (✅) mais garder les échecs (❌) visibles
        const filtered = actions.filter(a => !a.startsWith("✅"));

        // Métriques continues : tokens ↑↓, coût, durée
        const metricsLine = buildMetricsLine(details, "  ");

        // Vue expandée live : toutes les actions accumulées + thinking text
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

        // Vue compacte live : dernière action uniquement
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

      // Vue développée ou compacte (final)
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
        text += `\n\n${theme.fg("toolOutput", "(Ctrl+O pour voir la réponse complète)")}`;
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

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
