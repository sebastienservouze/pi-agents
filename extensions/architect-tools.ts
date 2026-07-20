/** Deterministic tools used by agent-architect. */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AGENT_NAME_PATTERN,
  DEFAULT_AGENT_TOOLS,
  discoverAgents,
  getAgentDirectories,
  parseAgentMarkdown,
  type AgentDiagnostic,
} from "./registry.js";

const ScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const CandidateSchema = Type.Object({
  scope: ScopeSchema,
  name: Type.String({ description: "Agent name and filename without .md" }),
});

interface SkillInfo {
  name: string;
  description?: string;
  filePath?: string;
  scope?: string;
}

interface ValidationResult {
  valid: boolean;
  diagnostics: AgentDiagnostic[];
  targetPath: string;
  normalized?: {
    name: string;
    description: string;
    tools?: string[];
    skills?: string[];
    model?: string;
    thinkingLevel?: string;
    useAgentFile: boolean;
  };
}

function agentPath(cwd: string, scope: "global" | "project", name: string): string {
  if (!AGENT_NAME_PATTERN.test(name)) throw new Error("Invalid agent name");
  const dirs = getAgentDirectories(cwd);
  return path.join(scope === "global" ? dirs.user : dirs.project, `${name}.md`);
}

function addDiagnostic(
  diagnostics: AgentDiagnostic[],
  severity: AgentDiagnostic["severity"],
  code: string,
  message: string,
): void {
  diagnostics.push({ severity, code, message });
}

function resolveModel(ctx: ExtensionContext, spec: string) {
  const slash = spec.indexOf("/");
  return slash >= 0
    ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))
    : ctx.modelRegistry.getAll().find((model) => model.id === spec);
}

function formatValidation(result: ValidationResult): string {
  const lines = [`${result.valid ? "VALID" : "INVALID"}: ${result.targetPath}`];
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.severity === "error" ? "ERROR" : "WARNING"} [${diagnostic.code}]: ${diagnostic.message}`);
  }
  if (!result.diagnostics.length) lines.push("No diagnostics.");
  return lines.join("\n");
}

export function registerArchitectTools(pi: ExtensionAPI): void {
  let skillInventory: SkillInfo[] = [];
  let skillInventoryKnown = false;

  // Keep these specialized tools out of normal sessions. Activating an agent
  // whose frontmatter lists them re-enables them through pi-agents' allow-list.
  const architectToolNames = new Set(["agent_validate", "agent_capabilities"]);
  pi.on("session_start", () => {
    try {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !architectToolNames.has(name)));
    } catch {
      // Tool activation is re-applied by /agent; failing here only adds clutter.
    }
  });

  // pi has already resolved package/global/project skills at this point. Keep a
  // small catalog for validation and agent_capabilities without reloading any
  // extension or scanning package internals.
  pi.on("before_agent_start", (event) => {
    const skills = (event as { systemPromptOptions?: { skills?: unknown } }).systemPromptOptions?.skills;
    if (!Array.isArray(skills)) return;
    skillInventoryKnown = true;
    skillInventory = skills
      .filter((skill): skill is Record<string, unknown> => !!skill && typeof skill === "object")
      .filter((skill) => typeof skill.name === "string")
      .map((skill) => ({
        name: skill.name as string,
        description: typeof skill.description === "string" ? skill.description : undefined,
        filePath: typeof skill.filePath === "string" ? skill.filePath : undefined,
        scope:
          typeof (skill.sourceInfo as { scope?: unknown } | undefined)?.scope === "string"
            ? ((skill.sourceInfo as { scope: string }).scope)
            : undefined,
      }));
  });

  function validate(
    ctx: ExtensionContext,
    params: { scope: "global" | "project"; name: string },
  ): ValidationResult {
    const source = params.scope === "global" ? "user" : "project";
    if (!AGENT_NAME_PATTERN.test(params.name)) {
      return {
        valid: false,
        diagnostics: [{ severity: "error", code: "invalid_target_name", message: `Target name must match ${AGENT_NAME_PATTERN}` }],
        targetPath: "(invalid agent name)",
      };
    }

    const filePath = agentPath(ctx.cwd, params.scope, params.name);
    let markdown = "";
    const fileDiagnostics: AgentDiagnostic[] = [];
    try {
      if (!fs.existsSync(filePath)) {
        addDiagnostic(fileDiagnostics, "error", "agent_missing", `Agent does not exist: ${filePath}`);
      } else if (fs.lstatSync(filePath).isSymbolicLink()) {
        addDiagnostic(fileDiagnostics, "error", "symlink_agent", "Refusing to read an agent file symlink");
      } else if (!fs.lstatSync(filePath).isFile()) {
        addDiagnostic(fileDiagnostics, "error", "invalid_agent", "Agent is not a regular file");
      } else {
        markdown = fs.readFileSync(filePath, "utf-8");
      }
    } catch (error) {
      addDiagnostic(fileDiagnostics, "error", "unreadable_agent", error instanceof Error ? error.message : String(error));
    }
    const parsed = parseAgentMarkdown(markdown, source, filePath);
    const diagnostics = [...fileDiagnostics, ...parsed.diagnostics];
    const agent = parsed.agent;
    if (agent) {
      const configuredTools = new Set(pi.getAllTools().map((tool) => tool.name));
      if (!agent.tools?.length) {
        addDiagnostic(
          diagnostics,
          "warning",
          "default_tools",
          `No tools declared; pi-agents will grant defaults including: ${DEFAULT_AGENT_TOOLS.join(", ")}`,
        );
      } else {
        for (const tool of agent.tools) {
          if (!configuredTools.has(tool)) {
            addDiagnostic(diagnostics, "error", "unknown_tool", `Unknown or unloaded tool: ${tool}`);
          }
        }
      }

      if (agent.skills?.length) {
        if (!skillInventoryKnown) {
          addDiagnostic(diagnostics, "warning", "skills_unavailable", "Runtime skill inventory is unavailable");
        } else {
          const knownSkills = new Set(skillInventory.map((skill) => skill.name));
          for (const skill of agent.skills) {
            if (!knownSkills.has(skill)) {
              addDiagnostic(diagnostics, "error", "unknown_skill", `Unknown skill: ${skill}`);
            }
          }
        }
      }

      if (!agent.model) {
        addDiagnostic(diagnostics, "warning", "inherited_model", "No model declared; the active/default model will be inherited");
      } else {
        const model = resolveModel(ctx, agent.model);
        if (!model) {
          addDiagnostic(diagnostics, "error", "unknown_model", `Unknown model: ${agent.model}`);
        } else {
          if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
            addDiagnostic(diagnostics, "error", "model_auth", `No configured authentication for model: ${agent.model}`);
          }
          const level = agent.thinkingLevel;
          if (level && level !== "off") {
            const mapping = model.thinkingLevelMap as Record<string, unknown> | undefined;
            if (!model.reasoning || mapping?.[level] === null) {
              addDiagnostic(
                diagnostics,
                "error",
                "unsupported_thinking_level",
                `Model ${agent.model} does not support thinkingLevel ${level}`,
              );
            }
          }
        }
      }
      if (!agent.thinkingLevel) {
        addDiagnostic(
          diagnostics,
          "warning",
          "inherited_thinking_level",
          "No thinkingLevel declared; the active/default level will be inherited",
        );
      }
    }

    const dirs = getAgentDirectories(ctx.cwd);
    const globalPath = path.join(dirs.user, `${params.name}.md`);
    const projectPath = path.join(dirs.project, `${params.name}.md`);
    if (params.scope === "project" && fs.existsSync(globalPath)) {
      addDiagnostic(diagnostics, "warning", "shadows_global", `Project agent will shadow ${globalPath}`);
    }
    if (params.scope === "global" && fs.existsSync(projectPath)) {
      addDiagnostic(diagnostics, "warning", "shadowed_by_project", `Global agent is shadowed in this project by ${projectPath}`);
    }

    const result: ValidationResult = {
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
      targetPath: filePath,
    };
    if (agent) {
      result.normalized = {
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        skills: agent.skills,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        useAgentFile: !!agent.useAgentFile,
      };
    }
    return result;
  }

  pi.registerTool({
    name: "agent_validate",
    label: "Validate agent",
    description: "Validates a saved global or project agent definition without writing files.",
    promptSnippet: "Validate an agent after writing or editing it",
    promptGuidelines: [
      "Use agent_validate after writing an agent or correcting a validation failure.",
      "Treat agent_validate errors as blocking and correct the agent with edit.",
    ],
    parameters: CandidateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = validate(ctx, params);
      return {
        content: [{ type: "text" as const, text: formatValidation(result) }],
        details: result,
        isError: !result.valid,
      };
    },
  });

  pi.registerTool({
    name: "agent_capabilities",
    label: "Agent capabilities",
    description: "Lists the tools, authenticated models, skills, and agents currently available to pi-agents.",
    promptSnippet: "Inspect actual pi tools, models, skills, and existing agents before designing an agent",
    promptGuidelines: ["Use this instead of inventing tool, model, skill, or agent names."],
    parameters: Type.Object({
      category: Type.Optional(
        Type.Union([
          Type.Literal("all"),
          Type.Literal("tools"),
          Type.Literal("models"),
          Type.Literal("skills"),
          Type.Literal("agents"),
        ]),
      ),
      query: Type.Optional(Type.String({ description: "Optional case-insensitive name filter" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const category = params.category ?? "all";
      const query = params.query?.toLowerCase();
      const matches = (value: string) => !query || value.toLowerCase().includes(query);
      const activeTools = new Set(pi.getActiveTools());

      const tools = pi.getAllTools()
        .filter((tool) => matches(tool.name))
        .map((tool) => ({
          name: tool.name,
          active: activeTools.has(tool.name),
          description: tool.description,
          source: tool.sourceInfo.source,
          scope: tool.sourceInfo.scope,
          path: tool.sourceInfo.path,
        }));
      const models = ctx.modelRegistry.getAll()
        .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
        .filter((model) => matches(`${model.provider}/${model.id}`))
        .map((model) => ({
          id: `${model.provider}/${model.id}`,
          name: model.name,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          active: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
        }));
      const skills = skillInventory.filter((skill) => matches(skill.name));
      const agents = discoverAgents(ctx.cwd)
        .filter((agent) => matches(agent.name))
        .map((agent) => ({
          name: agent.name,
          description: agent.description,
          scope: agent.source === "user" ? "global" : agent.source === "project" ? "project" : "system",
          path: agent.filePath,
        }));

      const details = {
        ...(category === "all" || category === "tools" ? { tools } : {}),
        ...(category === "all" || category === "models" ? { models } : {}),
        ...(category === "all" || category === "skills"
          ? { skills, skillsInventoryAvailable: skillInventoryKnown }
          : {}),
        ...(category === "all" || category === "agents" ? { agents } : {}),
      };
      const sections: string[] = [];
      if ("tools" in details) {
        sections.push(`Tools (${tools.length})\n${tools.map((tool) => `- ${tool.name}${tool.active ? " [active]" : ""} — ${tool.source}`).join("\n") || "(none)"}`);
      }
      if ("models" in details) {
        sections.push(`Authenticated models (${models.length})\n${models.map((model) => `- ${model.id}${model.active ? " [active]" : ""}${model.reasoning ? " [reasoning]" : ""}`).join("\n") || "(none)"}`);
      }
      if ("skills" in details) {
        sections.push(`Skills (${skills.length})${skillInventoryKnown ? "" : " [inventory unavailable]"}\n${skills.map((skill) => `- ${skill.name}${skill.scope ? ` [${skill.scope}]` : ""}`).join("\n") || "(none)"}`);
      }
      if ("agents" in details) {
        sections.push(`Agents (${agents.length})\n${agents.map((agent) => `- ${agent.name} [${agent.scope}] — ${agent.description}`).join("\n") || "(none)"}`);
      }

      return { content: [{ type: "text", text: sections.join("\n\n") }], details };
    },
  });
}
