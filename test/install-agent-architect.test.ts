import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { installAgentArchitect } = require("../scripts/install-agent-architect.cjs");

test("installs agent-architect with pi defaults and backs up the previous agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "test-provider", defaultModel: "test-model" }));
  writeFileSync(join(dir, "agents", "agent-architect.md"), "previous agent");

  try {
    installAgentArchitect(dir);
    assert.match(readFileSync(join(dir, "agents", "agent-architect.md"), "utf8"), /model: "test-provider\/test-model"/);
    assert.equal(readFileSync(join(dir, "agents", "agent-architect-old"), "utf8"), "previous agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
