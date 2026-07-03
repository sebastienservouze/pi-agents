# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `skills:` frontmatter field: allow-list of skill names advertised in the
  agent's composed system prompt.
- `/agent-prompt [first]` command to inspect the system prompt actually sent
  (post-rewrite), dumped to `~/.pi/last-system-prompt.md`. Displayed as a
  scrollable chat message (filtered out of the LLM context), not a modal.
- `/agent-tools` command to inspect the tools actually sent to the provider on
  the last request, captured after the allow-list guard runs.

### Changed

- Agent system prompts (agent mode and delegation) are now composed with the
  skills allow-list, pi's `contextFiles`, an environment block and the current
  date instead of using the raw `.md` body.
- `delegate` now passes the composed prompt natively via `pi --system-prompt`
  instead of writing it to a temporary file.

## [0.1.1] - 2025-07-17

### Fixed

- Removed deprecated `outputFormat` field from frontmatter example in README.


## [0.1.0] - 2025-07-15

### Added

- Initial release: `delegate` tool, `/agent` and `/agent-list` commands, `before_agent_start` hook, `Alt+A` shortcut.
- Agent discovery from `.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (global).
