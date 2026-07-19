import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const compiled = mkdtempSync(join(process.cwd(), ".hook-test-"));
compileDirectory(join(process.cwd(), "extensions"), compiled);
const { registerHooks } = await import(pathToFileURL(join(compiled, "hook.js")).href);
rmSync(compiled, { recursive: true, force: true });

interface ActiveAgentState {
  name: string;
  savedTools: string[];
  savedModelId?: string;
  savedThinkingLevel?: string;
}

function compileDirectory(sourceDirectory: string, targetDirectory: string): void {
  mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name);
    if (entry.isDirectory()) {
      compileDirectory(sourcePath, join(targetDirectory, entry.name));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    writeFileSync(join(targetDirectory, entry.name.replace(/\.ts$/, ".js")), output);
  }
}

test("activates the default agent when a new session starts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-hook-"));
  const agentDirectory = join(cwd, ".pi", "agents");
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(join(agentDirectory, "default-agent.md"), `---
name: default-agent
description: Default test agent
tools:
  - read
thinkingLevel: high
---

Default prompt.
`);

  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "missing-global-agents");

  let activeAgent: ActiveAgentState | null = null;
  let tools = ["read", "bash"];
  let thinkingLevel = "medium";
  let sessionStart: ((event: { reason: string }, context: any) => Promise<void>) | undefined;
  const statuses: string[] = [];
  const pi = {
    getActiveTools: () => tools,
    getThinkingLevel: () => thinkingLevel,
    on(event: string, handler: typeof sessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
    setActiveTools: (next: string[]) => { tools = next; },
    setThinkingLevel: (next: string) => { thinkingLevel = next; },
  };
  const context = {
    cwd,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    ui: {
      notify: () => undefined,
      setStatus: (_key: string, value: string) => statuses.push(value),
      theme: { fg: (_tone: string, value: string) => value },
    },
  };

  try {
    registerHooks(pi as never, () => activeAgent?.name ?? null, {
      autoActivateAgentName: "default-agent",
      setActiveAgentState: (state) => { activeAgent = state; },
    });

    await sessionStart?.({ reason: "new" }, context);

    assert.equal(activeAgent?.name, "default-agent");
    assert.deepEqual(tools, ["read"]);
    assert.equal(thinkingLevel, "high");
    assert.deepEqual(statuses, ["Agent: default-agent"]);
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    rmSync(cwd, { recursive: true, force: true });
  }
});
