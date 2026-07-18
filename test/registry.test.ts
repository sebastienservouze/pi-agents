import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentMarkdown } from "../extensions/registry.ts";

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
