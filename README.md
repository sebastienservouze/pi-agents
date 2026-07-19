# @nerisma/pi-agents

A specialized-agent system for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

`pi-agents` lets you switch from a general coding assistant to a focused role with a dedicated prompt, a least-privilege tool set, optional skills, and an appropriate model. It also provides safe workflows for creating agents, tools, and Agent Skills, plus evidence-based reviews of persisted sessions.

## What you get

| Bundled agent | Use it when you want to… |
|---|---|
| `agent-architect` | Decide whether a need calls for a prompt, skill, tool, or agent, then create an agent when justified. |
| `agent-skill-creator` | Compare existing public skills, create or adapt a standards-compliant skill, and install it safely. |
| `agent-tool-creator` | Implement the smallest reliable pi tool from an approved contract or a direct request. |
| `agent-session-reviewer` | Audit a session, including decision quality, tool usage, missed parallelism, and opportunities for agents, skills, or tools. |

The extension supports two execution modes:

- **Agent mode** replaces the current system prompt and enforces the selected agent's tool allow-list before the request reaches the model.
- **Delegation** runs a specialized agent in an isolated pi subprocess and returns its result with usage metrics.

## Install

```bash
pi install npm:@nerisma/pi-agents
```

The four bundled agents are installed in `~/.pi/agent/agents/`. Existing files with the same names are backed up as `*-old` files, which pi does not discover as agents. The architect inherits `defaultProvider` and `defaultModel` from `~/.pi/agent/settings.json` when both are configured.

Reload pi after installation:

```text
/reload
```

> Upgrading from a release that installed `tool-creator`? The bundled agent is now named `agent-tool-creator`. Review and remove the legacy `~/.pi/agent/agents/tool-creator.md` when you no longer need the old alias.

## Quick start

Open the agent selector:

```text
/agent
```

Or activate a role directly:

```text
/agent agent-architect
/agent agent-skill-creator
/agent agent-tool-creator
/agent agent-session-reviewer
```

Return to the normal pi prompt with:

```text
/agent off
```

### Create an agent

```text
/agent agent-architect
Create a project-local agent that reviews database migrations without modifying files.
```

The architect first checks existing capabilities and challenges whether a new agent is needed. If it is, it proposes the prompt, permissions, scope, and final path before writing anything. The final save shows a diff and requires confirmation.

### Create or reuse a skill

```text
/agent agent-skill-creator
I want a project skill for preparing safe PostgreSQL migration plans.
```

The skill creator:

1. clarifies triggers, inputs, outputs, scope, and success criteria;
2. checks loaded skills and searches public sources for close matches;
3. compares reuse, adaptation, and creation, including maintenance, license, dependencies, security, and portability;
4. proposes the exact `SKILL.md`, references, scripts, and assets that are actually needed;
5. writes to a non-discovered draft directory;
6. validates scripts and resources;
7. displays the complete change and asks before installing it.

Project skills are installed under `.pi/skills/<name>/`; global skills go under `~/.pi/agent/skills/<name>/`. Downloading or cloning a public skill and installing dependencies require separate confirmation. External skills and their scripts are treated as untrusted code and reviewed before installation.

### Create a tool

```text
/agent agent-tool-creator
Create a read-only tool that extracts the schema version from this project's migration files.
```

The tool creator prefers existing code, Node APIs, pi APIs, and installed dependencies. It adds the smallest useful test, runs relevant checks, and avoids speculative abstractions.

### Review a session

```text
/agent agent-session-reviewer
Review the latest session for agent-tool-creator.
```

The reviewer follows persisted branch relationships instead of treating JSONL as a flat log. It evaluates results, permissions, decision quality, validation, repeated Bash work, context usage, and calls that could safely have run in parallel. Recommendations require session evidence; a single occurrence is not presented as a general trend.

## Safety model

Agent definitions declare their tools explicitly. While an agent is active, pi-agents reapplies that allow-list to the request sent to the provider, including tools injected by other extensions.

Creation workflows use the same staged-save pattern:

```text
inspect existing capabilities
→ agree on a design
→ write a non-discovered draft
→ validate
→ show warnings and diff
→ ask for confirmation
→ save atomically
→ verify the written content
```

The save tools derive all paths from a validated scope and name, reject symlinks, detect changes made during confirmation, and never accept arbitrary destination paths. Skill updates preserve target files that are absent from the draft; this version does not delete skill resources.

## Everyday commands

| Command | Purpose |
|---|---|
| `/agent` | Open the agent selector (`Alt+A` also works). |
| `/agent <name>` | Activate an agent. |
| `/agent off` | Restore the original prompt, tools, model, and thinking level. |
| `/agent-list` | List discovered agents. |
| `/agent-prompt [first]` | Inspect the effective prompt sent for the active agent. |
| `/agent-tools` | Inspect the effective tool list sent to the provider. |
| `/agent-default <name>` | Auto-activate an agent at the next pi start. |
| `/agent-default off` | Clear the default agent. |

`PI_DEFAULT_AGENT` overrides the persisted default when set.

## Delegation

The `delegate` tool runs a focused task in an isolated pi process:

```text
delegate agent=<name> task=<task with all required context>
```

The subprocess receives the selected agent's composed prompt, tools, model, and thinking level. Output is streamed back with token, cost, duration, and tool-call metrics. Delegation is useful when the main agent should keep its role or context while a specialist handles a bounded subtask.

## Built-in tools

Specialized tools are registered globally but kept inactive unless an agent explicitly allows them.

### Capability and agent creation

- `agent_capabilities` lists loaded tools, authenticated models, skills, and agents. Use it instead of inventing capability names.
- `agent_validate scope=<global|project> name=<name>` validates an agent draft on request.
- `agent_save scope=<global|project> name=<name>` validates, confirms, atomically saves, and verifies an agent draft.

Agent draft locations:

- project: `<cwd>/.pi/agents/.drafts/<name>.md`
- global: `~/.pi/agent/agents/.drafts/<name>.md`

### Skill creation

- `skill_validate scope=<global|project> name=<name>` checks a complete staged skill directory, its Agent Skills frontmatter, resources, collisions, symlinks, and proposed changes.
- `skill_save scope=<global|project> name=<name>` validates, confirms, overlays, atomically swaps, and verifies the skill directory. Existing files omitted from the draft are preserved.

Skill draft locations:

- project: `<cwd>/.pi/skills/.drafts/<name>/`
- global: `~/.pi/agent/skills/.drafts/<name>/`

Both tools enforce portable Agent Skills names and require a root `SKILL.md` with a non-empty `description`. Detailed knowledge belongs in `references/`, deterministic helpers in `scripts/`, and output resources in `assets/` only when the workflow uses them.

### Session review

- `session_find agentName=<name>` finds recent persisted sessions containing the requested agent on the active branch.
- `session_stats path=<file> agentName=<name>` computes branch-aware tool, cost, model, failure, confirmation, and compaction landmarks.
- `session_extract path=<file> agentName=<name>` returns bounded, redacted evidence with filters, projections, pagination, and causal context.

A typical audit uses `session_stats` first, then targeted `session_extract` calls. Thinking text and obvious credentials are omitted.

## Define your own agents

Agents are discovered from:

- `.pi/agents/*.md` for the current project;
- `~/.pi/agent/agents/*.md` globally.

Project agents override global agents with the same name. Each file contains YAML frontmatter followed by its system prompt:

```markdown
---
name: explorer
description: Explores a codebase and reports where relevant behavior lives
tools: read, fffind, ffgrep
skills: code-review
thinkingLevel: medium
useAgentFile: true
---

Locate the relevant flow and return concise file and symbol references. Do not modify files.
```

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Unique name used by `/agent` and `delegate`. |
| `description` | yes | Routing guidance shown to models and users. |
| `tools` | no | Explicit allow-list. Omission grants defaults including `bash`; explicit lists are safer. |
| `skills` | no | Skill names advertised to this agent. Project skills are always included and de-duplicated. |
| `model` | no | `provider/model` or a bare model ID. |
| `thinkingLevel` | no | Reasoning level supported by the selected model. |
| `useAgentFile` | no | Append the current directory's `AGENTS.md` when `true`. |

The prompt is composed with selected skills, optional project context, environment information, and the current date. Use `/agent-prompt` to inspect the effective result.

## Development

```bash
npm test
npm run typecheck
```

## License

MIT
