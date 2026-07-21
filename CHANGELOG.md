# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-07-21

### Changed

- README : bannière ASCII centrée, tagline et badges centrés, titre Markdown restauré.
- `agent-pi-engineer` : règles README mises à jour (centrage, `-w 120`, LICENSE obligatoire).

## [1.0.2] - 2026-07-20

### Added

- Bundled `agent-pi-engineer` for creating or modifying Pi extensions that expose tools or commands.
- `bundled` scope for `agent_validate`, validating uppercase bundled-agent filenames.

### Changed

- `agent-pi-engineer` replaces `agent-tool-creator`.
- `agent-architect` and `agent-architect-web` can run local shell checks with `bash`.
- `agent-skill-creator` uses the built-in `find` and `grep` tools.

## [1.0.1] - 2026-07-20

### Added

- Optional `agent-architect-web`, which requires `pi-web-access` for external research.
- Explicit activation error with installation and reload instructions when `pi-web-access` is unavailable.

### Changed

- `agent-architect` now works offline and validates agent definitions written directly to their final paths.

### Removed

- The `agent_save` tool and its staged agent-save workflow.

## [1.0.0] - 2026-07-19

### Added

- System-agent discovery directly from the installed `pi-agents` package.
- Grouped agent selector sections for project-local, global and system agents.

### Changed

- Agent precedence is now project-local, then global, then system.
- Successfully saved and verified agent and skill drafts are removed.
- Documented `Alt+A` as the agent-selector shortcut.

### Removed

- Post-install export of bundled agents into the global pi agent directory.
- Bundled-agent installation script and its obsolete test.

## [0.2.0] - 2026-07-18

### Added

- Bundled `agent-architect`, automatically deployed during installation with
  pi's configured default provider/model.
- Existing `agent-architect.md` files are backed up as `agent-architect-old`
  before deployment.
- Deterministic architect tools for capability discovery, validation and safe
  agent saving.

## [0.1.4] - 2026-07-18

### Added

- `skills:` frontmatter field: allow-list of skill names advertised in the
  agent's composed system prompt.
- `/agent-prompt [first]` command to inspect the system prompt actually sent
  (post-rewrite), dumped to `~/.pi/last-system-prompt.md`. Displayed as a
  scrollable chat message (filtered out of the LLM context), not a modal.
- `/agent-tools` command to inspect the tools actually sent to the provider on
  the last request, captured after the allow-list guard runs.

### Changed

- Project-local skills are always added to an agent's frontmatter `skills:`
  selection and de-duplicated by name.
- Agent system prompts (agent mode and delegation) are now composed with the
  skills allow-list, pi's `contextFiles`, an environment block and the current
  date instead of using the raw `.md` body.
- `delegate` now passes the composed prompt natively via `pi --system-prompt`
  instead of writing it to a temporary file.

## [0.1.2] - 2026-07-03

### Fixed

- Tool allow-list (`tools:` frontmatter) is now enforced in `before_agent_start`
  by re-applying it on `state.tools` after context-mode's `before_agent_start`
  handler has injected the `ctx_*` family. This makes the filtering work for
  **all** providers, including custom `streamSimple` transports (e.g.
  pi-anthropic-oauth) that bypass the `before_provider_request` hook.
- `/agent-tools` now records and shows the final tool list for every provider,
  not only those that fire `before_provider_request`.

### Changed

- `before_provider_request` hook repositioned as a defense-in-depth safety net;
  the primary filtering point is now `before_agent_start`.

## [0.1.1] - 2025-07-17

### Fixed

- Removed deprecated `outputFormat` field from frontmatter example in README.


## [0.1.0] - 2025-07-15

### Added

- Initial release: `delegate` tool, `/agent` and `/agent-list` commands, `before_agent_start` hook, `Alt+A` shortcut.
- Agent discovery from `.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (global).
