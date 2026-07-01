/**
 * Commande `/agent` — activation/désactivation/sélection interactive des agents
 *
 * Usage :
 *   /agent           → sélecteur interactif (SelectList)
 *   /agent <nom>     → active un agent directement
 *   /agent off       → désactive le mode agent actif
 *
 * Exporte showAgentSelector() pour le raccourci Ctrl+A.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, type SelectItem, type AutocompleteItem, SelectList, Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./registry.js";
import type { ActiveAgentState } from "./types.js";

// ── Activation d'un agent ──
export async function activateAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentName: string,
  getState: () => ActiveAgentState | null,
  setState: (s: ActiveAgentState | null) => void,
): Promise<void> {
  const agents = discoverAgents(ctx.cwd);
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    ctx.ui.notify(`Agent "${agentName}" introuvable`, "error");
    return;
  }

  const state = getState();
  // Sauvegarder l'état par défaut au premier switch
  const currentState = state ?? {
    name: agent.name,
    savedTools: pi.getActiveTools(),
    savedModelId: ctx.model?.id,
    savedThinkingLevel: pi.getThinkingLevel(),
  };

  // Appliquer les outils
  const toolsToSet = agent.tools?.length
    ? agent.tools
    : ["read", "grep", "find", "ls", "bash", "ask_user_question"];
  pi.setActiveTools(toolsToSet);

  // Appliquer le thinking level (si spécifié)
  if (agent.thinkingLevel) {
    pi.setThinkingLevel(agent.thinkingLevel as ThinkingLevel);
  }

  // Appliquer le modèle (si spécifié)
  if (agent.model) {
    // Supporte les deux formats : "provider/model" (composite) et "model" (ID seul)
    const slashIdx = agent.model.indexOf("/");
    const model = slashIdx !== -1
      ? ctx.modelRegistry.find(agent.model.slice(0, slashIdx), agent.model.slice(slashIdx + 1))
      : ctx.modelRegistry.getAll().find((m) => m.id === agent.model);

    if (model) {
      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui.notify(
          `Agent "${agent.name}" : modèle "${agent.model}" sans clé API configurée`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `Agent "${agent.name}" : modèle "${agent.model}" introuvable`,
        "warning",
      );
    }
  }

  setState({ ...currentState, name: agent.name });
  process.env.PI_ACTIVE_AGENT = agent.name;
  ctx.ui.setStatus("agent", ctx.ui.theme.fg("accent", `Agent: ${agent.name}`));
  ctx.ui.notify(`Agent "${agent.name}" activé`, "info");
}

// ── Désactivation de l'agent courant ──
async function deactivateAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getState: () => ActiveAgentState | null,
  setState: (s: ActiveAgentState | null) => void,
): Promise<void> {
  const state = getState();
  if (!state) {
    ctx.ui.notify("Aucun agent actif", "info");
    return;
  }

  pi.setActiveTools(state.savedTools);
  if (state.savedModelId) {
    const model = ctx.modelRegistry.getAll().find((m) => m.id === state.savedModelId);
    if (model) await pi.setModel(model);
  }
  if (state.savedThinkingLevel) {
    pi.setThinkingLevel(state.savedThinkingLevel as ThinkingLevel);
  }

  setState(null);
  delete process.env.PI_ACTIVE_AGENT;
  ctx.ui.setStatus("agent", undefined);
  ctx.ui.notify("Agent désactivé — outils, modèle et thinking level restaurés", "info");
}

// ── Sélecteur interactif ──
export async function showAgentSelector(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getState: () => ActiveAgentState | null,
  setState: (s: ActiveAgentState | null) => void,
): Promise<void> {
  const agents = discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    ctx.ui.notify("Aucun agent trouvé dans .pi/agents/*.md ou ~/.pi/agent/agents/*.md", "warning");
    return;
  }

  const state = getState();
  const items: SelectItem[] = [];

  // Option "Désactiver" si un agent est actif
  if (state) {
    items.push({
      value: "off",
      label: `Désactiver (${state.name})`,
      description: "Restaurer les outils, le modèle et le thinking level par défaut",
    });
  }

  for (const a of agents) {
    const isActive = a.name === state?.name;
    const label = isActive ? `${a.name}  ●` : a.name;
    const modelInfo = a.model ? `Modèle: ${a.model}` : "";
    items.push({
      value: a.name,
      label,
      description: modelInfo ? `${a.description} — ${modelInfo}` : a.description,
    });
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Sélectionner un agent")), 1, 0),
    );

    const selectList = new SelectList(items, Math.min(items.length + 2, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(
      new Text(theme.fg("dim", "↑↓ naviguer  ·  entrer sélectionner  ·  esc annuler"), 1, 0),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  // Fallback RPC : ctx.ui.custom() retourne undefined (non supporté) → utiliser ctx.ui.select()
  // Note: null = annulation utilisateur, on ne fait rien
  let choice: string | null | undefined;
  if (result !== undefined) {
    choice = result;
  } else {
    choice = await ctx.ui.select("Sélectionner un agent", items.map((i) => i.value));
  }

  if (choice === "off") {
    await deactivateAgent(pi, ctx, getState, setState);
  } else if (choice) {
    await activateAgent(pi, ctx, choice, getState, setState);
  }
}

// ── Enregistrement de la commande /agent ──
export function registerAgentCommand(
  pi: ExtensionAPI,
  getState: () => ActiveAgentState | null,
  setState: (state: ActiveAgentState | null) => void,
): void {
  pi.registerCommand("agent", {
    description: "Active, désactive ou liste les agents. Usage : /agent [nom|off]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const agents = discoverAgents(process.cwd());
      const state = getState();
      const items: AutocompleteItem[] = [];

      // Option "off" si un agent est actif
      if (state && "off".startsWith(prefix.toLowerCase())) {
        items.push({
          value: "off",
          label: "off",
          description: `Désactiver (${state.name}) — restaurer outils, modèle et thinking level`,
        });
      }

      for (const a of agents) {
        if (!a.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const isActive = a.name === state?.name;
        const modelInfo = a.model ? ` — Modèle: ${a.model}` : "";
        items.push({
          value: a.name,
          label: isActive ? `${a.name} (actif)` : a.name,
          description: `${a.description}${modelInfo}`,
        });
      }

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args?.trim() ?? "";

      // ── Cas 1 : /agent (sans argument) → sélecteur interactif ──
      if (!input) {
        await showAgentSelector(pi, ctx, getState, setState);
        return;
      }

      // ── Cas 2 : /agent off → désactiver ──
      if (input === "off") {
        await deactivateAgent(pi, ctx, getState, setState);
        return;
      }

      // ── Cas 3 : /agent <nom> → activer directement ──
      await activateAgent(pi, ctx, input, getState, setState);
    },
  });

  // ── Commande /agent-list : retourne la liste des agents (pour UI dropdown) ──
  pi.registerCommand("agent-list", {
    description: "Liste les agents disponibles",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(ctx.cwd);
      if (agents.length === 0) {
        ctx.ui.notify("Aucun agent trouvé", "warning");
        return;
      }
      const agentNames = agents.map((a) => a.name);
      await ctx.ui.select("Agents disponibles", agentNames);
      // Ne rien faire après la sélection — le frontend envoie /agent <nom> séparément
    },
  });
}
