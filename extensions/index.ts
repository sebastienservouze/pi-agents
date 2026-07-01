/**
 * Point d'entrée de l'extension Agents
 *
 * Centralise l'enregistrement de tous les composants :
 *   - Outil `delegate` (délégation à des sous-agents)
 *   - Commande `/agent` (activation/désactivation)
 *   - Hook `before_agent_start` (injection system prompt)
 *
 * Les implémentations sont dans les modules voisins.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDelegateTool } from "./delegate.js";
import { registerAgentCommand, showAgentSelector } from "./cmd-agent.js";
import { registerHooks } from "./hook.js";
import type { ActiveAgentState } from "./types.js";

export default function (pi: ExtensionAPI) {
  // État partagé entre la commande et le hook
  let activeAgentState: ActiveAgentState | null = null;

  const getState = () => activeAgentState;
  const setState = (s: ActiveAgentState | null) => { activeAgentState = s; };

  // Enregistrement
  registerDelegateTool(pi);
  registerAgentCommand(pi, getState, setState);
  registerHooks(pi, () => activeAgentState?.name ?? null, {
    autoActivateAgentName: "cloude",
    setActiveAgentState: setState,
  });

  // Raccourci Alt+A → sélecteur d'agent
  pi.registerShortcut("alt+a", {
    description: "Sélectionner un agent",
    handler: async (ctx) => {
      await showAgentSelector(pi, ctx, getState, setState);
    },
  });

  // Nettoyer la variable d'environnement au shutdown pour éviter les faux positifs
  pi.on("session_shutdown", async () => {
    delete process.env.PI_ACTIVE_AGENT;
  });
}
