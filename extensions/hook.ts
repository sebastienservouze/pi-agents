/**
 * Hooks du système d'agents
 *
 * - before_agent_start :
 *   - Sub-agent délégué (PI_DELEGATED_SUBAGENT=1) :
 *       Lit PI_DELEGATED_AGENT_PROMPT_FILE et l'utilise comme system prompt EXCLUSIF.
 *       Garantit : zéro prompt pi par défaut, uniquement le .md de l'agent.
 *
 *   - Agent actif (mode `/agent <nom>`) :
 *       Remplace le system prompt par celui de l'agent. Inchangé.
 *
 *   - Agent principal (mode normal) :
 *       Injecte un bloc de règles de délégation dans le system prompt,
 *       construit à partir des champs `promptSuggestion` et `whenToDelegate`
 *       du frontmatter de chaque agent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findAgent, discoverAgents } from "./registry.js";
import type { AgentConfig, ActiveAgentState } from "./types.js";

// ─── useAgentFile : chargement du fichier AGENTS.md / CLAUDE.md du cwd ────────

/**
 * Cherche AGENTS.md (ou CLAUDE.md) dans `cwd`.
 * Retourne le contenu formaté en balises <project_context> (même format que pi),
 * ou null si aucun fichier trouvé ou lecture impossible.
 */
function loadAgentFileFromCwd(cwd: string): string | null {
  const filePath = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return (
      `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n` +
      `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n` +
      `</project_context>\n`
    );
  } catch {
    return null;
  }
}

// ─── Debug : log du dernier system prompt ───────────────────────────────────

const DEBUG_PROMPT_FILE = path.join(os.homedir(), ".pi", "agent", "last_system_prompt");

/**
 * Rend les outils ACTIFS tels qu'ils sont empaquetés dans le champ `tools`
 * de la requête provider (donc HORS du system prompt visible ci-dessus).
 * Sert à voir/mesurer le vrai coût en tokens des schémas d'outils.
 *
 * `allow` (optionnel) = allow-list du frontmatter de l'agent actif. Si fournie,
 * on n'affiche QUE les outils réellement envoyés (actifs ∩ allow), pour ne pas
 * mentir avec les `ctx_*` que le bridge MCP a injectés dans l'ensemble actif.
 */
function renderInjectedTools(pi: ExtensionAPI, allow?: Set<string>): string {
  try {
    const active = new Set(pi.getActiveTools());
    const tools = pi
      .getAllTools()
      .filter((t) => active.has(t.name) && (!allow || allow.has(t.name)));
    if (tools.length === 0) return "";
    // name + description + JSON Schema des paramètres = ce qui devient des tokens.
    const serialized = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const json = JSON.stringify(serialized, null, 2);
    return (
      `\n\n# ===== OUTILS INJECTÉS VIA L'API (${tools.length} outils, ${json.length} chars) =====\n` +
      `# Absents du system prompt ci-dessus : transmis séparément dans le champ \`tools\` de la requête provider.\n` +
      `# Rendu représentatif (name + description + JSON Schema des paramètres).\n\n` +
      json
    );
  } catch (e) {
    return `\n\n# (rendu des outils impossible : ${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Cherche le tableau `tools` dans le payload provider (forme `unknown`,
 * spécifique au provider). On tente les emplacements courants.
 */
function findToolsArray(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const nested = (k: string) => (p[k] as Record<string, unknown> | undefined)?.tools;
  for (const c of [p.tools, nested("body"), nested("request"), nested("params")]) {
    if (Array.isArray(c)) return c;
  }
  return null;
}

/** Nom d'une entrée d'outil, quel que soit le format wire (OpenAI/Anthropic/pi). */
function toolName(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return undefined;
  const o = t as { name?: string; function?: { name?: string } };
  return o.name ?? o.function?.name;
}

/**
 * Rend les outils RÉELLEMENT envoyés, lus dans le payload (wire truth).
 * À défaut de tableau `tools` trouvé : diagnostic des clés + fallback registry.
 */
function renderPayloadTools(payload: unknown, pi: ExtensionAPI, allow?: Set<string>): string {
  const tools = findToolsArray(payload);
  if (!tools) {
    const keys =
      payload && typeof payload === "object"
        ? Object.keys(payload as Record<string, unknown>).join(", ")
        : typeof payload;
    return `\n\n# (payload.tools introuvable — clés du payload : ${keys})` + renderInjectedTools(pi, allow);
  }
  const json = JSON.stringify(tools, null, 2);
  return (
    `\n\n# ===== OUTILS RÉELLEMENT ENVOYÉS (payload : ${tools.length} outils, ${json.length} chars) =====\n` +
    `# Lu directement dans le payload de la requête provider — c'est ce qui part sur le réseau.\n\n` +
    json
  );
}

// Dernier system prompt capturé à before_agent_start, réutilisé pour réécrire
// le fichier avec la liste d'outils COMPLÈTE au moment de la requête provider.
// (Les outils MCP ctx_* sont enregistrés en async, APRÈS before_agent_start :
// les lire trop tôt n'en montre qu'une partie.)
let lastPrompt = "";
let lastLabel = "";

// ─── Debug : compteur d'outils transmis, par tour ────────────────────────────
// Rempli à CHAQUE before_provider_request (vérité réseau, APRÈS filtrage du
// garde), lu puis remis à zéro à turn_end pour une notification de debug.
// Un tour = plusieurs requêtes provider (boucle tool-use) : on garde donc une
// entrée par requête pour exposer une éventuelle asymétrie 1er vs Ne appel
// (les ctx_* du bridge MCP arrivent en async, cf. commentaires ci-dessus).
interface TurnToolSample {
  sent: number;   // outils réellement dans le payload (après filtrage)
  active: number; // pi.getActiveTools() au moment de la requête (ensemble « pollué »)
}
let turnToolSamples: TurnToolSample[] = [];

function writeLastSystemPrompt(prompt: string, label: string, toolsBlock = ""): void {
  lastPrompt = prompt;
  lastLabel = label;
  try {
    const header = `# ${label} — ${new Date().toISOString()}\n# system prompt: ${prompt.length} chars\n\n`;
    fs.writeFileSync(DEBUG_PROMPT_FILE, header + prompt + toolsBlock, "utf-8");
  } catch {
    // silencieux
  }
}

// ─── Construction du bloc de délégation ──────────────────────────────────────

/**
 * DEPRECATED : cette fonction n'est plus utilisée.
 * Les règles de délégation sont désormais dans APPEND_SYSTEM.md
 * (injecté automatiquement par PI pour l'agent principal).
 */
// function buildAgentGuidelines(agents: AgentConfig[]): string {
//   DEPRECATED — voir APPEND_SYSTEM.md
// }

// ─── Enregistrement ─────────────────────────────────────────────────────────

export function registerHooks(
  pi: ExtensionAPI,
  getActiveAgentName: () => string | null,
  options?: {
    autoActivateAgentName?: string;
    setActiveAgentState?: (s: ActiveAgentState | null) => void;
  },
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const activeAgentName = getActiveAgentName();
    const isDelegatedSubAgent = process.env.PI_DELEGATED_SUBAGENT === "1";
    const toolsBlock = renderInjectedTools(pi);

    // ── Sub-agent délégué ──
    // Utiliser UNIQUEMENT le contenu du fichier prompt transmis par le runner.
    // Garantit : pas de prompt pi par défaut, pas de stacking parent/enfant.
    if (isDelegatedSubAgent) {
      const promptFile = process.env.PI_DELEGATED_AGENT_PROMPT_FILE;
      if (promptFile) {
        try {
          const content = fs.readFileSync(promptFile, "utf-8");
          writeLastSystemPrompt(content, `sub-agent (${process.env.PI_DELEGATED_SUBAGENT_NAME || "?"})`, toolsBlock);
          return { systemPrompt: content };
        } catch {
          // Fichier inaccessible : fallback sans modification
        }
      }
      writeLastSystemPrompt(event.systemPrompt, "sub-agent (fallback)", toolsBlock);
      return;
    }

    // ── Agent actif via /agent <nom> ──
    // Remplacement complet du system prompt par celui de l'agent.
    if (activeAgentName) {
      const agent = findAgent(ctx.cwd, activeAgentName);
      if (!agent?.systemPrompt) {
        writeLastSystemPrompt(event.systemPrompt, `agent "${activeAgentName}" (pas de systemPrompt)`, toolsBlock);
        return;
      }
      const agentAllow = agent.tools?.length ? new Set(agent.tools) : undefined;
      writeLastSystemPrompt(agent.systemPrompt, `agent "${activeAgentName}"`, renderInjectedTools(pi, agentAllow));
      const finalPrompt =
        agent.useAgentFile
          ? agent.systemPrompt + (loadAgentFileFromCwd(ctx.cwd) ?? "")
          : agent.systemPrompt;
      return { systemPrompt: finalPrompt };
    }

    // ── Auto-activation (agent principal, mais un agent est configuré) ──
    const { autoActivateAgentName, setActiveAgentState } = options ?? {};
    if (autoActivateAgentName) {
      const agent = findAgent(ctx.cwd, autoActivateAgentName);
      if (agent?.systemPrompt) {
        // Appliquer les outils de l'agent
        const toolsToSet = agent.tools?.length
          ? agent.tools
          : ["read", "grep", "find", "ls", "bash", "ask_user_question"];
        try { pi.setActiveTools(toolsToSet); } catch { /* fail open */ }

        // Appliquer le thinking level
        if (agent.thinkingLevel) {
          try { pi.setThinkingLevel(agent.thinkingLevel as any); } catch { /* fail open */ }
        }

        // Appliquer le modèle
        if (agent.model) {
          try {
            const slashIdx = agent.model.indexOf("/");
            const model = slashIdx !== -1
              ? ctx.modelRegistry.find(agent.model.slice(0, slashIdx), agent.model.slice(slashIdx + 1))
              : ctx.modelRegistry.getAll().find((m: any) => m.id === agent.model);
            if (model) await pi.setModel(model);
          } catch { /* fail open */ }
        }

        // Mettre à jour l'état global pour que before_provider_request filtre les outils
        if (setActiveAgentState) {
          setActiveAgentState({
            name: agent.name,
            savedTools: pi.getActiveTools(),
            savedModelId: ctx.model?.id,
            savedThinkingLevel: pi.getThinkingLevel(),
          });
        }
        process.env.PI_ACTIVE_AGENT = agent.name;
        try { ctx.ui.setStatus("agent", ctx.ui.theme.fg("accent", `Agent: ${agent.name}`)); } catch {}
        try { ctx.ui.notify(`Agent "${agent.name}" activé automatiquement`, "info"); } catch {}

        const autoAllow = agent.tools?.length ? new Set(agent.tools) : undefined;
        writeLastSystemPrompt(agent.systemPrompt, `auto: "${autoActivateAgentName}"`, renderInjectedTools(pi, autoAllow));
        const finalPromptAuto =
          agent.useAgentFile
            ? agent.systemPrompt + (loadAgentFileFromCwd(ctx.cwd) ?? "")
            : agent.systemPrompt;
        return { systemPrompt: finalPromptAuto };
      }
    }

    // ── Agent principal (pas d'auto-activation) ──
    // APPEND_SYSTEM.md est injecté automatiquement par PI
    writeLastSystemPrompt(event.systemPrompt, "principal", toolsBlock);
    return; // Pas de modification — PI gère APPEND_SYSTEM.md
  });

  // Au moment de la requête provider, le bridge MCP a fini d'enregistrer les
  // outils ctx_* : on réécrit le fichier avec la liste COMPLÈTE (race-free).
  // On ne touche pas au payload (retour void = payload inchangé).
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;

    // Allow-list du frontmatter de l'agent actif : source de vérité partagée
    // par le filtrage du payload ET le rendu debug (renderPayloadTools).
    let allowSet: Set<string> | undefined;
    try {
      const agentName = getActiveAgentName();
      if (agentName) {
        const allow = findAgent(ctx.cwd, agentName)?.tools;
        if (allow?.length) allowSet = new Set(allow);
      }
    } catch {
      // fail-open : pas d'allow-list → pas de filtrage
    }

    // Enforce l'allow-list de l'agent actif sur les outils du payload.
    // Le bridge MCP (context-mode) injecte TOUTE sa famille ctx_* par-dessus le
    // frontmatter ; ici, au moment de l'envoi, on remet l'allow-list : on garde
    // uniquement les outils dont le name est déclaré dans `tools:`. Fail-open.
    try {
      const tools = findToolsArray(payload);
      if (allowSet && tools) {
        const kept = tools.filter((t) => {
          const n = toolName(t);
          return n === undefined || allowSet!.has(n); // garde si nom indétectable
        });
        if (kept.length !== tools.length) {
          tools.length = 0; // mutation en place (même référence dans le payload)
          tools.push(...kept);
        }
      }
    } catch {
      // fail-open : payload inchangé
    }

    // Échantillon debug : nombre d'outils réellement transmis (après filtrage)
    // vs nombre d'outils actifs. Relu à turn_end pour la notification.
    try {
      const finalTools = findToolsArray(payload);
      let active = 0;
      try { active = pi.getActiveTools().length; } catch { /* fail open */ }
      if (finalTools) turnToolSamples.push({ sent: finalTools.length, active });
    } catch {
      // fail-open : pas d'échantillon
    }

    // Trace après filtrage = ce qui part réellement sur le réseau.
    if (lastPrompt) writeLastSystemPrompt(lastPrompt, lastLabel, renderPayloadTools(payload, pi, allowSet));
    return payload;
  });

  // ─── Notification debug : outils transmis à l'API, par tour ────────────────
  // Affiche le nombre d'outils réellement présents dans le payload (vérité
  // réseau). Format : `> tools 18` ; `18 (28 actifs)` si le garde en a stripé ;
  // `8→18` si le compte a varié entre les requêtes du tour (× N req).
  pi.on("turn_end", async (event, ctx) => {
    const samples = turnToolSamples;
    turnToolSamples = [];
    if (samples.length === 0) return;

    const sent = samples.map((s) => s.sent);
    const active = samples.map((s) => s.active);
    const sMin = Math.min(...sent), sMax = Math.max(...sent);
    const aMax = Math.max(...active);

    const sentLabel = sMin === sMax ? `${sMax}` : `${sMin}→${sMax}`;

    try {
      const thm = ctx.ui.theme;
      const accentAnsi = thm.getFgAnsi("accent");
      const mutedAnsi = thm.getFgAnsi("muted");
      const dimAnsi = thm.getFgAnsi("dim");
      const reset = "\x1b[39m";
      const muted = (s: string) => `${mutedAnsi}${s}${reset}`;

      const segments: string[] = [muted(`tools ${sentLabel}`)];
      // Écart envoyé/actif = ce que le garde a retiré du payload.
      if (aMax > sMax) segments.push(muted(`${aMax} actifs`));
      // Plusieurs requêtes dans le tour : utile pour lire l'asymétrie 1er/Ne.
      if (samples.length > 1) segments.push(muted(`×${samples.length} req`));

      const body = segments.join(` ${dimAnsi}·${reset} `);
      ctx.ui.notify(`${accentAnsi}>${reset} ${body}`, "info");
    } catch {
      // fail-open : pas de notification
    }
  });
}
