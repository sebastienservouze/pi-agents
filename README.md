# @nerisma/pi-agents

Specialized-agent system for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Agents are defined in `.md` files (YAML frontmatter + system prompt). The extension uses them two ways:

- **Agent mode** — activate an agent to fully **replace the system prompt**, **restrict the allowed tools** (enforced on the request *before* it reaches the provider), and set the **model** and **thinking level**.
- **Delegation** — the `delegate` tool runs an agent in an isolated `pi` sub-process; it works autonomously and returns a targeted summary with usage metrics.

## Installation

```bash
pi install npm:@nerisma/pi-agents
```

Installation also deploys the bundled `agent-architect` to
`~/.pi/agent/agents/agent-architect.md`. Its `model` frontmatter is built from
`defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`; when either
setting is absent, the field is omitted so pi keeps its normal model fallback.
An existing agent is backed up first as `agent-architect-old` (without `.md`, so
it is not discovered as another agent).

Activate it with:

```text
/agent agent-architect
```

## Agent files

Agents are discovered from two locations (project overrides global on name conflict):

- `.pi/agents/*.md` — project agents (take priority)
- `~/.pi/agent/agents/*.md` — global agents

Each file is a YAML frontmatter block followed by the system prompt body:

```markdown
---
name: explorer
description: Explores a codebase and reports where things live
tools: read, grep, find, ls          # list or comma-separated string
skills: research, code-review        # list or comma-separated string
model: anthropic/claude-sonnet-5     # "provider/model" or a bare model id
thinkingLevel: medium
useAgentFile: true
---

You are a codebase explorer. Locate the relevant code and report file:line
references. Do not modify anything.
```

### Frontmatter fields

| Field | Required | Description |
|----------------|----------|-------------|
| `name` | yes | Unique agent name (used by `/agent` and `delegate`). |
| `description` | yes | Shown in selectors and delegation guidelines. |
| `tools` | no | Allowed tools, as a YAML list or a comma-separated string. Omitted ⇒ defaults including `bash`; declare tools explicitly for least privilege. |
| `skills` | no | Skill names to advertise, as a YAML list or a comma-separated string. Project-local skills are always added and de-duplicated by name. Omitted ⇒ project-local skills only. |
| `model` | no | `provider/model` or a bare model id. |
| `thinkingLevel` | no | Thinking level passed to the agent. |
| `useAgentFile` | no | `true` to append the current directory's `AGENTS.md` to the system prompt. |

The body (everything after the frontmatter) becomes the agent's system prompt. For
agent mode (`/agent`, auto-activation), it is composed with the selected and project-local skills,
pi's `contextFiles`, an environment block and the current date. Use `/agent-prompt`
to inspect the prompt actually sent.

## Agent architect tools

The extension registers three deterministic tools for agents that design or maintain
`pi-agents` definitions. They are inactive in normal sessions; add them to an agent's
`tools:` allow-list when needed.

### `agent_capabilities`

Lists the tools, authenticated models, loaded skills, and agents available in the
current pi runtime. Results can be filtered by category or name. This is the source
of truth for capability names; newly installed extensions appear only after pi is
reloaded.

```text
agent_capabilities category=models
agent_capabilities category=tools query=web
```

### Agent drafts

The architect writes each candidate once, then applies targeted edits in a staging
directory that is not scanned for agents:

- global: `~/.pi/agent/agents/.drafts/<name>.md`
- project: `<cwd>/.pi/agents/.drafts/<name>.md`

Drafts remain available for later corrections; saving never deletes them.

### `agent_validate`

Reads and validates the staged draft without writing it:

- frontmatter syntax, recognized fields, required values, filename and agent name;
- tools, skills, model authentication, and thinking level;
- global/project shadowing and existing-target diff;
- empty prompts, duplicate entries, and implicit default tools.

```text
agent_validate scope=project name=reviewer
```

Errors are blocking. Warnings describe inherited defaults or shadowing. This tool is
optional: use it for a dry run or to check a corrected draft separately.

### `agent_save`

Reads and validates the draft, then atomically writes only to one of the two supported
targets:

- `~/.pi/agent/agents/<name>.md`
- `<cwd>/.pi/agents/<name>.md`

It derives both paths from `scope` and `name`, refuses symlinks, displays warnings and
the exact diff, and requires an interactive confirmation before every write. Draft and
target hashes are checked internally around confirmation; successful writes are read
back and verified.

```text
agent_save scope=project name=reviewer
```

The intended architect workflow is:

```text
agent_capabilities → design approval → write draft once → agent_save
                                      ↘ edit draft and retry on validation error
```

## Agent mode

Activate an agent to take over the current session:

- `/agent` — interactive selector (also `Alt+A`)
- `/agent <name>` — activate directly
- `/agent off` — deactivate and restore the original tools, model and thinking level
- `/agent-list` — list available agents
- `/agent-prompt [first]` — show the system prompt actually sent (post-rewrite);
  `first` shows the session-start prompt (persisted, survives reload). The full
  text is also dumped to `~/.pi/last-system-prompt.md`.
- `/agent-tools` — show the tools actually sent to the provider on the last
  request (post allow-list enforcement, not just the agent's configured
  `tools:`).

While an agent is active its `tools:` allow-list is enforced in
`before_agent_start` by re-applying it on the session's active tool set. This
strips tools injected by other extensions (e.g. the MCP `ctx_*` family) that
aren't in the list, and works for **all** providers — including custom
`streamSimple` transports (e.g. pi-anthropic-oauth) that bypass the
`before_provider_request` hook. The hook remains as a defense-in-depth safety
net.

## Default agent

Set an agent to auto-activate once at the start of every session. This is
persisted to `~/.pi/pi-agents.json`, so it survives pi restarts:

- `/agent-default <name>` — set the default (applies at the next pi start)
- `/agent-default off` — clear it
- `/agent-default` — show the current default

`PI_DEFAULT_AGENT` (environment variable) overrides the persisted value when set.

## Delegation

The `delegate` tool lets the model hand a sub-task to a specialized agent:

```
delegate agent=<name> task=<task with all the needed context>
```

The agent runs in an isolated `pi --mode json` sub-process with its own system
prompt — the agent's `.md` composed with a delegation notice, an environment
block and the current date, passed natively via `--system-prompt` (no default
pi prompt, no temp file) — tools, model and thinking level. The result is
streamed back with live activity and usage metrics (tokens, cost, duration,
tool calls).

## License

MIT
