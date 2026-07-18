/** Deterministic tools used by agent-architect. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AGENT_NAME_PATTERN,
  DEFAULT_AGENT_TOOLS,
  discoverAgents,
  getAgentDirectories,
  invalidateAgentCache,
  parseAgentMarkdown,
  type AgentDiagnostic,
} from "./registry.js";

const ScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const CandidateSchema = Type.Object({
  scope: ScopeSchema,
  name: Type.String({ description: "Agent name and target filename without .md" }),
  markdown: Type.String({ description: "Complete candidate agent Markdown, including YAML frontmatter" }),
});
const SaveSchema = Type.Object({
  scope: ScopeSchema,
  name: Type.String({ description: "Agent name and target filename without .md" }),
  markdown: Type.String({ description: "Complete candidate agent Markdown, including YAML frontmatter" }),
  expectedSha256: Type.Optional(
    Type.String({ description: "Hash returned by agent_validate when overwriting an existing agent" }),
  ),
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
  existing: boolean;
  existingSha256?: string;
  diff?: string;
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

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Compact single-hunk diff; enough for short agent Markdown files. */
function unifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const before = oldLines.slice(contextStart, prefix).map((line) => ` ${line}`);
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`);
  const added = newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`);
  const after = oldLines.slice(oldLines.length - suffix, oldEnd).map((line) => ` ${line}`);
  const oldCount = oldEnd - contextStart;
  const newCount = newEnd - contextStart;
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
    ...before,
    ...removed,
    ...added,
    ...after,
  ].join("\n");
}

function targetPath(cwd: string, scope: "global" | "project", name: string): string {
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
  const lines = [
    `${result.valid ? "VALID" : "INVALID"}: ${result.targetPath}`,
    result.existing ? "Target already exists." : "Target is new.",
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.severity === "error" ? "ERROR" : "WARNING"} [${diagnostic.code}]: ${diagnostic.message}`);
  }
  if (!result.diagnostics.length) lines.push("No diagnostics.");
  if (result.diff) lines.push(`\nProposed diff:\n${result.diff}`);
  return lines.join("\n");
}

export function registerArchitectTools(pi: ExtensionAPI): void {
  let skillInventory: SkillInfo[] = [];
  let skillInventoryKnown = false;

  // Keep these specialized tools out of normal sessions. Activating an agent
  // whose frontmatter lists them re-enables them through pi-agents' allow-list.
  const architectToolNames = new Set(["agent_validate", "agent_capabilities", "agent_save"]);
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
    params: { scope: "global" | "project"; name: string; markdown: string },
  ): ValidationResult {
    const source = params.scope === "global" ? "user" : "project";
    if (!AGENT_NAME_PATTERN.test(params.name)) {
      const dirs = getAgentDirectories(ctx.cwd);
      const safePath = path.join(params.scope === "global" ? dirs.user : dirs.project, "__invalid__.md");
      const parsed = parseAgentMarkdown(params.markdown, source, safePath);
      const diagnostics = [...parsed.diagnostics];
      addDiagnostic(diagnostics, "error", "invalid_target_name", `Target name must match ${AGENT_NAME_PATTERN}`);
      return {
        valid: false,
        diagnostics,
        targetPath: "(invalid target name)",
        existing: false,
      };
    }

    const filePath = targetPath(ctx.cwd, params.scope, params.name);
    const parsed = parseAgentMarkdown(params.markdown, source, filePath);
    const diagnostics = [...parsed.diagnostics];
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

    let existingContent: string | undefined;
    if (fs.existsSync(filePath)) {
      try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
          addDiagnostic(diagnostics, "error", "symlink_target", "Refusing to overwrite an agent file symlink");
        } else {
          existingContent = fs.readFileSync(filePath, "utf-8");
        }
      } catch (error) {
        addDiagnostic(
          diagnostics,
          "error",
          "unreadable_target",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const result: ValidationResult = {
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
      targetPath: filePath,
      existing: existingContent !== undefined,
    };
    if (existingContent !== undefined) {
      result.existingSha256 = sha256(existingContent);
      if (existingContent !== params.markdown) {
        result.diff = unifiedDiff(filePath, existingContent, params.markdown);
      }
    }
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
    description: "Deterministically validates a candidate pi-agents Markdown definition without writing files.",
    promptSnippet: "Validate candidate agent frontmatter and runtime capabilities before saving",
    promptGuidelines: [
      "Call agent_validate on the exact final Markdown before agent_save.",
      "Treat errors as blocking; show warnings and any proposed diff to the user.",
    ],
    parameters: CandidateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = validate(ctx, params);
      return {
        content: [{ type: "text", text: formatValidation(result) }],
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
          scope: agent.source === "user" ? "global" : "project",
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

  pi.registerTool({
    name: "agent_save",
    label: "Save agent",
    description: "Validates and atomically saves an agent only to an authorized global or project agents directory.",
    promptSnippet: "Save a validated agent to its exact authorized path",
    promptGuidelines: [
      "Use only after agent_validate accepted the exact Markdown.",
      "The tool requires a final interactive confirmation before every write.",
    ],
    parameters: SaveSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = validate(ctx, params);
      if (!result.valid) {
        return {
          content: [{ type: "text", text: `Agent not saved.\n${formatValidation(result)}` }],
          details: result,
          isError: true,
        };
      }

      if (result.existing && !result.diff) {
        return {
          content: [{ type: "text", text: `No changes: ${result.targetPath}` }],
          details: result,
        };
      }
      if (result.existing && params.expectedSha256 !== result.existingSha256) {
        return {
          content: [{ type: "text", text: "Agent not saved: existingSha256 changed or was not supplied; validate the exact candidate again." }],
          details: result,
          isError: true,
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Agent not saved: every write requires interactive confirmation." }],
          details: result,
          isError: true,
        };
      }
      const approved = await ctx.ui.confirm(
        `${result.existing ? "Overwrite" : "Create"} agent "${params.name}"?`,
        result.existing
          ? `${result.targetPath}\n\n${result.diff}`
          : [
              result.targetPath,
              result.normalized?.description ?? "",
              `Tools: ${result.normalized?.tools?.join(", ") || "defaults"}`,
              `Model: ${result.normalized?.model ?? "inherited"}`,
              `Thinking: ${result.normalized?.thinkingLevel ?? "inherited"}`,
            ].join("\n"),
      );
      if (!approved) {
        return {
          content: [{ type: "text", text: "Agent not saved: write declined by user." }],
          details: result,
          isError: true,
        };
      }
      if (result.existing) {
        const current = fs.readFileSync(result.targetPath, "utf-8");
        if (sha256(current) !== result.existingSha256) {
          return {
            content: [{ type: "text", text: "Agent not saved: file changed after confirmation; validate again." }],
            details: result,
            isError: true,
          };
        }
      } else if (fs.existsSync(result.targetPath)) {
        return {
          content: [{ type: "text", text: "Agent not saved: target appeared after confirmation; validate again." }],
          details: result,
          isError: true,
        };
      }

      const dir = path.dirname(result.targetPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tempPath = path.join(dir, `.${params.name}.${crypto.randomUUID()}.tmp`);
      try {
        const mode = result.existing ? fs.statSync(result.targetPath).mode & 0o777 : 0o600;
        fs.writeFileSync(tempPath, params.markdown, { encoding: "utf-8", flag: "wx", mode });
        fs.renameSync(tempPath, result.targetPath);
      } finally {
        try { fs.unlinkSync(tempPath); } catch { /* rename succeeded or cleanup is best-effort */ }
      }
      invalidateAgentCache();

      return {
        content: [{ type: "text", text: `Agent saved: ${result.targetPath}` }],
        details: { ...result, saved: true },
      };
    },
  });
}
