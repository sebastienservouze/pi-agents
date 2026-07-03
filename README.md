# @nerisma/pi-agents

Specialized-agent system for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Agents are defined in `.md` files (YAML frontmatter + system prompt). The extension uses them two ways:

- **Agent mode** — activate an agent to fully **replace the system prompt**, **restrict the allowed tools** (enforced on the request *before* it reaches the provider), and set the **model** and **thinking level**.
- **Delegation** — the `delegate` tool runs an agent in an isolated `pi` sub-process; it works autonomously and returns a targeted summary with usage metrics.

## Installation

```bash
pi install npm:@nerisma/pi-agents
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
| `tools` | no | Allowed tools, as a YAML list or a comma-separated string. Omitted ⇒ a sensible default set. |
| `skills` | no | Allow-list of skill names, as a YAML list or a comma-separated string. Only these are advertised in the agent's system prompt. Omitted ⇒ no skills block. |
| `model` | no | `provider/model` or a bare model id. |
| `thinkingLevel` | no | Thinking level passed to the agent. |
| `useAgentFile` | no | `true` to append the current directory's `AGENTS.md` to the system prompt. |

The body (everything after the frontmatter) becomes the agent's system prompt. For
agent mode (`/agent`, auto-activation), it is composed with the skills allow-list,
pi's `contextFiles`, an environment block and the current date. Use `/agent-prompt`
to inspect the prompt actually sent.

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
