/**
 * `/agent` command — activate/deactivate/interactive selection of agents
 *
 * Usage:
 *   /agent           → interactive selector (SelectList)
 *   /agent <name>    → activate an agent directly
 *   /agent off       → deactivate the active agent mode
 *
 * Exports showAgentSelector() for the Alt+A shortcut.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, type SelectItem, type AutocompleteItem, SelectList, Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./registry.js";
import { applyAgent, persistActiveAgent } from "./activation.js";
import { getDefaultAgentName, setDefaultAgentName } from "./config.js";
import {
  AGENT_PROMPT_VIEW_TYPE,
  getFirstSentPrompt,
  getLatestSentPrompt,
  readPersistedPrompt,
  type SentPromptRecord,
} from "./prompt-store.js";
import { AGENT_TOOLS_VIEW_TYPE, getLatestSentTools } from "./tools-store.js";
import type { ActiveAgentState } from "./types.js";

// ── Activate an agent ──
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
    ctx.ui.notify(`Agent "${agentName}" not found`, "error");
    return;
  }

  if (agent.name === "agent-architect-web") {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const missing = ["web_search", "fetch_content", "get_search_content"].filter((name) => !available.has(name));
    if (missing.length) {
      ctx.ui.notify(
        `Agent "${agent.name}" requires pi-web-access (missing: ${missing.join(", ")}). Install it with "pi install npm:pi-web-access", then run /reload; or use /agent agent-architect.`,
        "error",
      );
      return;
    }
  }

  // Apply settings (keeping the original restore point on a first switch),
  // record the state, and persist it so it survives a reload.
  const state = await applyAgent(pi, ctx, agent, getState());
  setState(state);
  process.env.PI_ACTIVE_AGENT = agent.name;
  persistActiveAgent(pi, agent.name);
  ctx.ui.setStatus("agent", ctx.ui.theme.fg("accent", `Agent: ${agent.name}`));
  ctx.ui.notify(`Agent "${agent.name}" activated`, "info");
}

// ── Deactivate the current agent ──
async function deactivateAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getState: () => ActiveAgentState | null,
  setState: (s: ActiveAgentState | null) => void,
): Promise<void> {
  const state = getState();
  if (!state) {
    ctx.ui.notify("No active agent", "info");
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
  persistActiveAgent(pi, null); // record the "off" intent so reload respects it
  ctx.ui.setStatus("agent", undefined);
  ctx.ui.notify("Agent deactivated — tools, model and thinking level restored", "info");
}

// ── Interactive selector ──
export async function showAgentSelector(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getState: () => ActiveAgentState | null,
  setState: (s: ActiveAgentState | null) => void,
): Promise<void> {
  const agents = discoverAgents(ctx.cwd);
  if (agents.length === 0) {
    ctx.ui.notify("No project, global or system agents found", "warning");
    return;
  }

  const state = getState();
  const items: SelectItem[] = [];
  const headerPrefix = "__section__:";
  const sections = [
    { source: "project", label: "Locaux" },
    { source: "user", label: "Globaux" },
    { source: "system", label: "Système" },
  ] as const;

  for (const section of sections) {
    const sectionAgents = agents.filter((agent) => agent.source === section.source);
    if (!sectionAgents.length) continue;
    items.push({ value: `${headerPrefix}${section.source}`, label: `── ${section.label} ──` });

    for (const agent of sectionAgents) {
      const isActive = agent.name === state?.name;
      const label = isActive ? `${agent.name}  ●` : agent.name;
      const modelInfo = agent.model ? `Model: ${agent.model}` : "";
      items.push({
        value: agent.name,
        label,
        description: modelInfo ? `${agent.description} — ${modelInfo}` : agent.description,
      });
    }
  }

  // "Deactivate" goes LAST so a reflexive Enter never lands on it.
  if (state) {
    items.push({
      value: "off",
      label: `Deactivate (${state.name})`,
      description: "Restore default tools, model and thinking level",
    });
  }

  const activeIndex = state
    ? items.findIndex((item) => item.value === state.name)
    : items.findIndex((item) => !item.value.startsWith(headerPrefix));

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Select an agent")), 1, 0),
    );

    const selectList = new SelectList(items, Math.min(items.length + 2, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    // Les en-têtes restent visibles mais ne peuvent pas être sélectionnés.
    if (activeIndex >= 0) selectList.setSelectedIndex(activeIndex);
    selectList.onSelect = (item) => {
      if (!item.value.startsWith(headerPrefix)) done(item.value);
    };
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate  ·  enter select  ·  esc cancel"), 1, 0),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        const beforeItem = selectList.getSelectedItem();
        const before = beforeItem ? items.indexOf(beforeItem) : -1;
        selectList.handleInput(data);
        const selected = selectList.getSelectedItem();
        if (selected?.value.startsWith(headerPrefix)) {
          const headerIndex = items.indexOf(selected);
          const movingDown = headerIndex > before || (before === items.length - 1 && headerIndex === 0);
          const nextIndex = (headerIndex + (movingDown ? 1 : -1) + items.length) % items.length;
          selectList.setSelectedIndex(nextIndex);
        }
        tui.requestRender();
      },
    };
  });

  // RPC fallback: ctx.ui.custom() returns undefined (unsupported) → use ctx.ui.select()
  // Note: null = user cancellation, do nothing
  let choice: string | null | undefined;
  if (result !== undefined) {
    choice = result;
  } else {
    choice = await ctx.ui.select(
      "Select an agent",
      items.filter((item) => !item.value.startsWith(headerPrefix)).map((item) => item.value),
    );
  }

  if (choice === "off") {
    await deactivateAgent(pi, ctx, getState, setState);
  } else if (choice) {
    await activateAgent(pi, ctx, choice, getState, setState);
  }
}

// ── Registration of the /agent command ──
export function registerAgentCommand(
  pi: ExtensionAPI,
  getState: () => ActiveAgentState | null,
  setState: (state: ActiveAgentState | null) => void,
): void {
  pi.registerCommand("agent", {
    description: "Activate, deactivate or list agents. Usage: /agent [name|off]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // NOTE: uses process.cwd() because this callback isn't passed a ctx.
      // If the project cwd differs from the process cwd, completions may be off.
      const agents = discoverAgents(process.cwd());
      const state = getState();
      const items: AutocompleteItem[] = [];

      // "off" option if an agent is active
      if (state && "off".startsWith(prefix.toLowerCase())) {
        items.push({
          value: "off",
          label: "off",
          description: `Deactivate (${state.name}) — restore tools, model and thinking level`,
        });
      }

      for (const a of agents) {
        if (!a.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const isActive = a.name === state?.name;
        const modelInfo = a.model ? ` — Model: ${a.model}` : "";
        items.push({
          value: a.name,
          label: isActive ? `${a.name} (active)` : a.name,
          description: `${a.description}${modelInfo}`,
        });
      }

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args?.trim() ?? "";

      // ── Case 1: /agent (no argument) → interactive selector ──
      if (!input) {
        await showAgentSelector(pi, ctx, getState, setState);
        return;
      }

      // ── Case 2: /agent off → deactivate ──
      if (input === "off") {
        await deactivateAgent(pi, ctx, getState, setState);
        return;
      }

      // ── Case 3: /agent <name> → activate directly ──
      await activateAgent(pi, ctx, input, getState, setState);
    },
  });

  // ── /agent-default command: set the agent auto-activated at startup ──
  // Persisted to <agent dir>/config.json, so it survives pi restarts.
  pi.registerCommand("agent-default", {
    description: "Sets the agent activated at pi startup (persistent). Usage: /agent-default [name|off]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const agents = discoverAgents(process.cwd());
      const current = getDefaultAgentName();
      const items: AutocompleteItem[] = [];

      // "off" option if a default is currently set
      if (current && "off".startsWith(prefix.toLowerCase())) {
        items.push({
          value: "off",
          label: "off",
          description: `Remove default agent (${current})`,
        });
      }

      for (const a of agents) {
        if (!a.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const isDefault = a.name === current;
        items.push({
          value: a.name,
          label: isDefault ? `${a.name} (default)` : a.name,
          description: a.description,
        });
      }

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args?.trim() ?? "";

      // ── No argument → show the current default ──
      if (!input) {
        const current = getDefaultAgentName();
        ctx.ui.notify(
          current ? `Default agent: ${current}` : "No default agent",
          "info",
        );
        return;
      }

      // ── /agent-default off → clear the default ──
      if (input === "off") {
        setDefaultAgentName(undefined);
        ctx.ui.notify("Default agent removed", "info");
        return;
      }

      // ── /agent-default <name> → persist it (applies at next pi start) ──
      const agent = discoverAgents(ctx.cwd).find((a) => a.name === input);
      if (!agent) {
        ctx.ui.notify(`Agent "${input}" not found`, "error");
        return;
      }
      setDefaultAgentName(agent.name);
      ctx.ui.notify(
        `Default agent: ${agent.name} — active at next pi start (or /agent ${agent.name} to activate now)`,
        "info",
      );
    },
  });

  // ── /agent-prompt command: inspect the system prompt actually sent ──
  // Shows the prompt recorded by the before_agent_start hook (post-rewrite).
  //   /agent-prompt          → latest sent prompt (this session)
  //   /agent-prompt first    → session-start prompt (survives reload via session entry)
  // The full text is written to ~/.pi/last-system-prompt.md for easy viewing.
  pi.registerCommand("agent-prompt", {
    description: "Show the system prompt actually sent (post-rewrite). Usage: /agent-prompt [first]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [];
      if ("first".startsWith(prefix.toLowerCase())) {
        items.push({ value: "first", label: "first", description: "Session-start prompt (persisted, survives reload)" });
      }
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const wantFirst = (args?.trim() ?? "") === "first";

      // In-memory record first; fall back to the persisted session entry
      // (covers reload/resume where memory is empty).
      let rec: SentPromptRecord | null = wantFirst ? getFirstSentPrompt() : getLatestSentPrompt();
      if (!rec) {
        try {
          rec = readPersistedPrompt(ctx.sessionManager.getEntries());
        } catch {
          rec = null;
        }
      }
      if (!rec) {
        ctx.ui.notify(
          "No rewritten system prompt recorded for this session (no agent active, or no turn sent yet)",
          "info",
        );
        return;
      }

      // Dump the full text to a stable path — the reliable viewer regardless
      // of UI capabilities.
      const dumpPath = path.join(os.homedir(), ".pi", "last-system-prompt.md");
      let dumped = false;
      try {
        fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
        fs.writeFileSync(dumpPath, rec.prompt, "utf-8");
        dumped = true;
      } catch { /* dump is best-effort */ }

      const when = rec.timestamp ? new Date(rec.timestamp).toISOString() : "unknown";
      const header =
        `Agent: ${rec.agentName ?? "(none)"} · source: ${rec.source} · sent: ${when} · ${rec.prompt.length} chars` +
        (dumped ? `\nFull text: ${dumpPath}` : "");

      // Posted as a chat message (not a modal) so it's part of the scrollable
      // transcript. Filtered out of the LLM context by the "context" hook
      // (see hook.ts) — display-only, never sent to the model.
      pi.sendMessage({
        customType: AGENT_PROMPT_VIEW_TYPE,
        content: `**System prompt (as sent)**\n\n${header}\n\n\`\`\`\n${rec.prompt}\n\`\`\``,
        display: true,
      });
    },
  });

  // ── /agent-tools command: inspect the tools actually sent to the provider ──
  // Captured in before_provider_request AFTER the allow-list guard runs, so
  // this is the real, final list — not just the agent's configured `tools:`.
  pi.registerCommand("agent-tools", {
    description: "Show the tools actually sent to the provider on the last request",
    handler: async () => {
      const rec = getLatestSentTools();
      if (!rec) {
        pi.sendMessage({
          customType: AGENT_TOOLS_VIEW_TYPE,
          content: "No provider request sent yet this session — send a turn first.",
          display: true,
        });
        return;
      }

      const when = new Date(rec.timestamp).toISOString();
      const header = `Agent: ${rec.agentName ?? "(none)"} · sent: ${when} · ${rec.tools.length} tool(s)` +
        (rec.guardApplied ? " · allow-list enforced" : "") +
        (!rec.found ? " · ⚠ tools array not found in payload (guard could not verify)" : "");

      const list = rec.tools.length
        ? rec.tools.map((t) => `- ${t}`).join("\n")
        : "_(none)_";

      // Same pattern as /agent-prompt: a scrollable chat message, filtered
      // out of the LLM context by the "context" hook (see hook.ts).
      pi.sendMessage({
        customType: AGENT_TOOLS_VIEW_TYPE,
        content: `**Tools sent to the provider (last request)**\n\n${header}\n\n${list}`,
        display: true,
      });
    },
  });

  // ── /agent-list command: returns the list of agents (for a UI dropdown) ──
  pi.registerCommand("agent-list", {
    description: "List available agents",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(ctx.cwd);
      if (agents.length === 0) {
        ctx.ui.notify("No agents found", "warning");
        return;
      }
      const agentNames = agents.map((a) => a.name);
      await ctx.ui.select("Available agents", agentNames);
      // Do nothing after selection — the frontend sends /agent <name> separately
    },
  });
}
