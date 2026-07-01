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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, type SelectItem, type AutocompleteItem, SelectList, Text } from "@earendil-works/pi-tui";
import { discoverAgents, DEFAULT_AGENT_TOOLS } from "./registry.js";
import { getDefaultAgentName, setDefaultAgentName } from "./config.js";
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

  const state = getState();
  // Save the default state on the first switch
  const currentState = state ?? {
    name: agent.name,
    savedTools: pi.getActiveTools(),
    savedModelId: ctx.model?.id,
    savedThinkingLevel: pi.getThinkingLevel(),
  };

  // Apply the tools
  const toolsToSet = agent.tools?.length ? agent.tools : DEFAULT_AGENT_TOOLS;
  pi.setActiveTools(toolsToSet);

  // Apply the thinking level (if specified)
  if (agent.thinkingLevel) {
    pi.setThinkingLevel(agent.thinkingLevel as ThinkingLevel);
  }

  // Apply the model (if specified)
  if (agent.model) {
    // Supports both formats: "provider/model" (composite) and "model" (id only)
    const slashIdx = agent.model.indexOf("/");
    const model = slashIdx !== -1
      ? ctx.modelRegistry.find(agent.model.slice(0, slashIdx), agent.model.slice(slashIdx + 1))
      : ctx.modelRegistry.getAll().find((m) => m.id === agent.model);

    if (model) {
      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui.notify(
          `Agent "${agent.name}": model "${agent.model}" without configured API key`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `Agent "${agent.name}": model "${agent.model}" not found`,
        "warning",
      );
    }
  }

  setState({ ...currentState, name: agent.name });
  process.env.PI_ACTIVE_AGENT = agent.name;
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
    ctx.ui.notify("No agents found in .pi/agents/*.md or ~/.pi/agent/agents/*.md", "warning");
    return;
  }

  const state = getState();
  const items: SelectItem[] = [];

  // "Deactivate" option if an agent is active
  if (state) {
    items.push({
      value: "off",
      label: `Deactivate (${state.name})`,
      description: "Restore default tools, model and thinking level",
    });
  }

  for (const a of agents) {
    const isActive = a.name === state?.name;
    const label = isActive ? `${a.name}  ●` : a.name;
    const modelInfo = a.model ? `Model: ${a.model}` : "";
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
      new Text(theme.fg("accent", theme.bold("Select an agent")), 1, 0),
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
      new Text(theme.fg("dim", "↑↓ navigate  ·  enter select  ·  esc cancel"), 1, 0),
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

  // RPC fallback: ctx.ui.custom() returns undefined (unsupported) → use ctx.ui.select()
  // Note: null = user cancellation, do nothing
  let choice: string | null | undefined;
  if (result !== undefined) {
    choice = result;
  } else {
    choice = await ctx.ui.select("Select an agent", items.map((i) => i.value));
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
