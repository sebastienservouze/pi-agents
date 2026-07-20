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

const markdown = `---
name: reviewer
description: Reviews code
tools: [read]
---

Review the code.
`;

function harness(cwd: string) {
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

test("validates a project agent written to its final path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-architect-"));
  const target = join(cwd, ".pi", "agents", "reviewer.md");
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(target, markdown);

  try {
    const { tools, execute } = harness(cwd);
    assert.equal(tools.has("agent_save"), false);

    const validation = await execute("agent_validate", { scope: "project", name: "reviewer" });
    assert.equal(validation.details.valid, true);
    assert.equal(validation.details.targetPath, target);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects missing and symlinked final agents", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-architect-"));
  const agents = join(cwd, ".pi", "agents");
  mkdirSync(agents, { recursive: true });

  try {
    const { execute } = harness(cwd);
    const missing = await execute("agent_validate", { scope: "project", name: "reviewer" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /agent_missing/);

    const source = join(cwd, "source.md");
    writeFileSync(source, markdown);
    symlinkSync(source, join(agents, "reviewer.md"));
    const symlinked = await execute("agent_validate", { scope: "project", name: "reviewer" });
    assert.equal(symlinked.isError, true);
    assert.match(symlinked.content[0].text, /symlink_agent/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
