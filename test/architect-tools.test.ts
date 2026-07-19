import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

// The extension uses production-style .js specifiers. Transpile its two source
// modules so this source-only test exercises the same imports without a loader.
const compiled = mkdtempSync(join(process.cwd(), ".architect-tools-test-"));
for (const name of ["registry", "architect-tools"]) {
  const source = readFileSync(join(process.cwd(), "extensions", `${name}.ts`), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(compiled, `${name}.js`), output);
}
const { registerArchitectTools } = await import(pathToFileURL(join(compiled, "architect-tools.js")).href);
rmSync(compiled, { recursive: true, force: true });

const markdown = (description: string) => `---
name: reviewer
description: ${description}
tools: [read]
---

Review the code.
`;

function harness(cwd: string, confirm: () => Promise<boolean> = async () => true) {
  const tools = new Map<string, any>();
  const pi = {
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getAllTools() { return [{ name: "read" }]; },
    getActiveTools() { return []; },
    setActiveTools() {},
  };
  registerArchitectTools(pi as any);
  const ctx = {
    cwd,
    hasUI: true,
    ui: { confirm },
    modelRegistry: {
      getAll() { return []; },
      find() { return undefined; },
      hasConfiguredAuth() { return false; },
    },
  };
  const execute = (name: string, params: object) =>
    tools.get(name).execute("call", params, new AbortController().signal, () => {}, ctx);
  return { tools, execute };
}

test("validates and saves a staged project agent without retransmitting Markdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-architect-"));
  const draft = join(cwd, ".pi", "agents", ".drafts", "reviewer.md");
  const target = join(cwd, ".pi", "agents", "reviewer.md");
  mkdirSync(join(cwd, ".pi", "agents", ".drafts"), { recursive: true });
  writeFileSync(draft, markdown("First version"));

  try {
    const { tools, execute } = harness(cwd);
    assert.deepEqual(Object.keys(tools.get("agent_save").parameters.properties).sort(), ["name", "scope"]);

    const validation = await execute("agent_validate", { scope: "project", name: "reviewer" });
    assert.equal(validation.details.valid, true);
    assert.equal(validation.details.draftPath, draft);

    const created = await execute("agent_save", { scope: "project", name: "reviewer" });
    assert.equal(created.details.verified, true);
    assert.equal(readFileSync(target, "utf8"), markdown("First version"));

    writeFileSync(draft, markdown("Second version"));
    const overwritten = await execute("agent_save", { scope: "project", name: "reviewer" });
    assert.equal(overwritten.details.verified, true);
    assert.equal(readFileSync(target, "utf8"), markdown("Second version"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects missing and symlinked drafts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-architect-"));
  const drafts = join(cwd, ".pi", "agents", ".drafts");
  mkdirSync(drafts, { recursive: true });

  try {
    const { execute } = harness(cwd);
    const missing = await execute("agent_save", { scope: "project", name: "reviewer" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /draft_missing/);

    const source = join(cwd, "source.md");
    writeFileSync(source, markdown("Symlink"));
    symlinkSync(source, join(drafts, "reviewer.md"));
    const symlinked = await execute("agent_validate", { scope: "project", name: "reviewer" });
    assert.equal(symlinked.isError, true);
    assert.match(symlinked.content[0].text, /symlink_draft/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
