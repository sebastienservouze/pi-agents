import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const compiled = mkdtempSync(join(process.cwd(), ".skill-tools-test-"));
const source = readFileSync(join(process.cwd(), "extensions", "skill-tools.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(join(compiled, "skill-tools.js"), output);
const { registerSkillTools } = await import(pathToFileURL(join(compiled, "skill-tools.js")).href);
rmSync(compiled, { recursive: true, force: true });

const skill = (name: string, body = "Follow the documented workflow.") => `---
name: ${name}
description: Processes example requests. Use when the user asks for an example workflow.
---

# Example workflow

${body}
`;

function harness(cwd: string, confirm: () => Promise<boolean> = async () => true) {
  const tools = new Map<string, any>();
  let active = ["read", "skill_validate", "skill_save"];
  let onStart: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) { if (event === "session_start") onStart = handler; },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getActiveTools() { return active; },
    setActiveTools(next: string[]) { active = next; },
  };
  registerSkillTools(pi as any);
  const ctx = { cwd, hasUI: true, ui: { confirm } };
  const execute = (name: string, params: object) =>
    tools.get(name).execute("call", params, new AbortController().signal, () => {}, ctx);
  return { tools, execute, start: () => onStart?.(), active: () => active };
}

test("validates and atomically saves a multi-file skill while preserving untouched files", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-skill-"));
  const draft = join(cwd, ".pi", "skills", ".drafts", "example-skill");
  const target = join(cwd, ".pi", "skills", "example-skill");
  mkdirSync(join(draft, "references"), { recursive: true });
  writeFileSync(join(draft, "SKILL.md"), skill("example-skill"));
  writeFileSync(join(draft, "references", "guide.md"), "# Guide\n");

  try {
    const { execute } = harness(cwd);
    const validation = await execute("skill_validate", { scope: "project", name: "example-skill" });
    assert.equal(validation.details.valid, true);
    assert.deepEqual(validation.details.changes.map((item: { path: string }) => item.path), ["references/guide.md", "SKILL.md"]);

    const created = await execute("skill_save", { scope: "project", name: "example-skill" });
    assert.equal(created.details.verified, true);
    assert.equal(readFileSync(join(target, "references", "guide.md"), "utf8"), "# Guide\n");
    assert.equal(existsSync(draft), false);

    mkdirSync(draft, { recursive: true });
    writeFileSync(join(draft, "SKILL.md"), skill("example-skill", "Follow the improved workflow."));
    const updated = await execute("skill_save", { scope: "project", name: "example-skill" });
    assert.equal(updated.details.verified, true);
    assert.equal(readFileSync(join(target, "references", "guide.md"), "utf8"), "# Guide\n");
    assert.match(readFileSync(join(target, "SKILL.md"), "utf8"), /improved workflow/);
    assert.equal(existsSync(draft), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects mismatched names and symlinks, and hides skill tools by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-skill-"));
  const draft = join(cwd, ".pi", "skills", ".drafts", "example-skill");
  mkdirSync(draft, { recursive: true });
  writeFileSync(join(draft, "SKILL.md"), skill("different-name"));
  const source = join(cwd, "source.txt");
  writeFileSync(source, "external");
  symlinkSync(source, join(draft, "linked.txt"));

  try {
    const instance = harness(cwd);
    const invalid = await instance.execute("skill_save", { scope: "project", name: "example-skill" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /name_mismatch|symlink/);
    instance.start();
    assert.deepEqual(instance.active(), ["read"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
