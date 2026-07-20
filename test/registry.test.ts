import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, parseAgentMarkdown } from "../extensions/registry.ts";

const validAgent = `---
name: reviewer
description: Reviews code
tools: [read, ffgrep]
model: openai-codex/gpt-5.6-sol
thinkingLevel: high
---

Review the requested code.
`;

test("parseAgentMarkdown normalizes a valid agent", () => {
  const parsed = parseAgentMarkdown(validAgent, "project", "/tmp/reviewer.md");
  assert.equal(parsed.agent?.name, "reviewer");
  assert.deepEqual(parsed.agent?.tools, ["read", "ffgrep"]);
  assert.deepEqual(parsed.diagnostics, []);
});

test("parseAgentMarkdown reports strict frontmatter diagnostics", () => {
  const parsed = parseAgentMarkdown(
    validAgent.replace("name: reviewer", "name: Bad/Name").replace("tools:", "unknown: value\ntools:"),
    "project",
    "/tmp/reviewer.md",
  );
  const codes = parsed.diagnostics.map((diagnostic) => diagnostic.code);
  assert.ok(codes.includes("unknown_field"));
  assert.ok(codes.includes("invalid_name"));
  assert.ok(codes.includes("filename_mismatch"));
});

test("parseAgentMarkdown rejects an empty prompt", () => {
  const parsed = parseAgentMarkdown("---\nname: empty\ndescription: Empty\n---\n", "user", "/tmp/empty.md");
  assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === "empty_prompt"));
});

test("discovers project, global and system agents with precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agents-registry-"));
  const cwd = join(root, "project");
  const globalAgents = join(root, "agent-home", "agents");
  const projectAgents = join(cwd, ".pi", "agents");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const agent = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nAct.\n`;
  mkdirSync(globalAgents, { recursive: true });
  mkdirSync(projectAgents, { recursive: true });
  writeFileSync(join(globalAgents, "agent-session-reviewer.md"), agent("agent-session-reviewer", "Global override"));
  writeFileSync(join(globalAgents, "global-only.md"), agent("global-only", "Global"));
  writeFileSync(join(projectAgents, "agent-session-reviewer.md"), agent("agent-session-reviewer", "Project override"));
  writeFileSync(join(projectAgents, "local-only.md"), agent("local-only", "Local"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");

  try {
    const agents = discoverAgents(cwd);
    assert.deepEqual(agents.slice(0, 2).map(({ name, source }) => [name, source]), [
      ["agent-session-reviewer", "project"],
      ["local-only", "project"],
    ]);
    assert.equal(agents.find((item) => item.name === "global-only")?.source, "user");
    assert.equal(agents.find((item) => item.name === "agent-session-reviewer")?.source, "project");
    assert.equal(agents.filter((item) => item.name === "agent-session-reviewer").length, 1);
    assert.equal(agents.find((item) => item.name === "agent-architect")?.source, "system");
    assert.equal(agents.find((item) => item.name === "agent-architect")?.model, undefined);
    assert.equal(agents.find((item) => item.name === "agent-architect-web")?.source, "system");
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});
