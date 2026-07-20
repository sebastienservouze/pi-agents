import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const compiled = mkdtempSync(join(process.cwd(), ".cmd-agent-test-"));
for (const name of ["cmd-agent", "registry", "activation", "config", "prompt-store", "tools-store", "types"]) {
  const source = readFileSync(join(process.cwd(), "extensions", `${name}.ts`), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(compiled, `${name}.js`), output);
}
const { activateAgent } = await import(pathToFileURL(join(compiled, "cmd-agent.js")).href);
rmSync(compiled, { recursive: true, force: true });

const webArchitect = `---
name: agent-architect-web
description: Web architect
tools: [web_search, fetch_content, get_search_content]
---

Design agents.
`;

test("refuses the web architect when pi-web-access is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agents-cmd-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const notifications: Array<{ message: string; level: string }> = [];
  let stateChanges = 0;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "agents"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "agents", "agent-architect-web.md"), webArchitect);

  const pi = {
    getAllTools: () => [{ name: "read" }],
  };
  const ctx = {
    cwd: root,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  try {
    await activateAgent(pi as any, ctx as any, "agent-architect-web", () => null, () => { stateChanges++; });

    assert.equal(stateChanges, 0);
    assert.deepEqual(notifications, [{
      message: 'Agent "agent-architect-web" requires pi-web-access (missing: web_search, fetch_content, get_search_content). Install it with "pi install npm:pi-web-access", then run /reload; or use /agent agent-architect.',
      level: "error",
    }]);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});
