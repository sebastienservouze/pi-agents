import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { installBundledAgents } = require("../scripts/install-agent-architect.cjs");

const agents = ["agent-architect", "agent-session-reviewer", "tool-creator"];

test("installs bundled agents with pi defaults and backs up previous agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "test-provider", defaultModel: "test-model" }));
  for (const agent of agents) writeFileSync(join(agentsDir, `${agent}.md`), `previous ${agent}`);

  try {
    const installed = installBundledAgents(dir);

    assert.deepEqual(installed.map((item: { target: string }) => item.target), agents.map((agent) => join(agentsDir, `${agent}.md`)));
    assert.match(readFileSync(join(agentsDir, "agent-architect.md"), "utf8"), /model: "test-provider\/test-model"/);
    assert.match(readFileSync(join(agentsDir, "agent-session-reviewer.md"), "utf8"), /## Qualité des décisions|## Ce qu’il faut juger/);
    assert.match(readFileSync(join(agentsDir, "tool-creator.md"), "utf8"), /name: tool-creator/);
    for (const agent of agents) {
      assert.equal(readFileSync(join(agentsDir, `${agent}-old`), "utf8"), `previous ${agent}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
