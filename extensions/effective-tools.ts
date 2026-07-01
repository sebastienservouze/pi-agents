/**
 * Source de vérité unique : les outils RÉELLEMENT transmis au provider.
 *
 * Le bridge MCP de context-mode enregistre toute sa famille `ctx_*` via
 * `pi.registerTool()`, ce qui les ajoute à l'ENSEMBLE ACTIF (`getActiveTools()`)
 * même quand le frontmatter de l'agent ne les déclare pas. Le garde
 * `before_provider_request` (hook.ts) les retire du payload au dernier moment ;
 * mais `getActiveTools()` reste pollué, donc toute UI qui l'affiche tel quel MENT
 * sur ce qui part sur le réseau.
 *
 * Cette fonction calcule ce qui part vraiment : `actifs ∩ allow-list frontmatter`.
 * Le garde (hook.ts) ET l'UI (nerisma-input) doivent s'aligner dessus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findAgent } from "./registry.js";

/**
 * Liste des noms d'outils effectivement envoyés au provider pour (cwd, agent actif).
 *
 *   - pas d'agent actif, ou agent sans `tools:` → tous les outils actifs (pas de filtrage).
 *   - sinon → intersection des outils actifs avec l'allow-list du frontmatter.
 *
 * `agentName` provient typiquement de `process.env.PI_ACTIVE_AGENT` (posé par
 * l'extension agents) côté UI, ou de l'état interne côté hook.
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
