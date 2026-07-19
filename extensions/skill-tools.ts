import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import {
  parseFrontmatter,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const CandidateSchema = Type.Object({
  scope: ScopeSchema,
  name: Type.String({ description: "Skill name and directory name" }),
});
const FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".css", ".html", ".xml", ".csv"]);

interface SkillDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
}

interface SkillFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mode: number;
  sha256: string;
}

interface SkillChange {
  path: string;
  status: "added" | "modified";
  size: number;
  diff?: string;
}

interface SkillValidationResult {
  valid: boolean;
  diagnostics: SkillDiagnostic[];
  draftPath: string;
  targetPath: string;
  existing: boolean;
  files: Array<{ path: string; size: number }>;
  changes: SkillChange[];
  diff: string;
  draftSha256?: string;
  targetSha256?: string;
  normalized?: { name: string; description: string };
}

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function skillPaths(cwd: string, scope: "global" | "project", name: string) {
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) throw new Error("Invalid skill name");
  const root = scope === "global"
    ? path.join(homedir(), ".pi", "agent", "skills")
    : path.join(cwd, ".pi", "skills");
  return {
    draftPath: path.join(root, ".drafts", name),
    targetPath: path.join(root, name),
  };
}

function addDiagnostic(
  diagnostics: SkillDiagnostic[],
  severity: SkillDiagnostic["severity"],
  code: string,
  message: string,
): void {
  diagnostics.push({ severity, code, message });
}

function walkFiles(root: string, diagnostics: SkillDiagnostic[], label: string): SkillFile[] {
  const files: SkillFile[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const metadata = fs.lstatSync(absolutePath);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (metadata.isSymbolicLink()) {
        addDiagnostic(diagnostics, "error", "symlink", `${label} contains a symbolic link: ${relativePath}`);
      } else if (metadata.isDirectory()) {
        walk(absolutePath);
      } else if (metadata.isFile()) {
        const content = fs.readFileSync(absolutePath);
        files.push({ relativePath, absolutePath, size: metadata.size, mode: metadata.mode & 0o777, sha256: sha256(content) });
      } else {
        addDiagnostic(diagnostics, "error", "unsupported_file", `${label} contains an unsupported file type: ${relativePath}`);
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function treeHash(files: SkillFile[]): string {
  return sha256(files.map((file) => `${file.relativePath}\0${file.mode}\0${file.sha256}`).join("\n"));
}

function unifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return "";
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++;
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${prefix + 1},${oldChanged.length} +${prefix + 1},${newChanged.length} @@`,
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
  ].join("\n");
}

function textDiff(relativePath: string, oldPath: string | undefined, newPath: string): string | undefined {
  if (!TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return undefined;
  const newMetadata = fs.statSync(newPath);
  const oldMetadata = oldPath && fs.existsSync(oldPath) ? fs.statSync(oldPath) : undefined;
  if (newMetadata.size > 100_000 || (oldMetadata?.size ?? 0) > 100_000) return undefined;
  return unifiedDiff(relativePath, oldPath && fs.existsSync(oldPath) ? fs.readFileSync(oldPath, "utf8") : "", fs.readFileSync(newPath, "utf8"));
}

function renderDiff(changes: SkillChange[]): string {
  if (!changes.length) return "No file changes.";
  const sections: string[] = [];
  for (const change of changes) {
    const body = change.diff || `${change.status.toUpperCase()} ${change.path} (${change.size} bytes; binary or large text)`;
    if (sections.join("\n\n").length + body.length > 20_000) {
      sections.push(`[diff truncated; ${changes.length - sections.length} additional file(s)]`);
      break;
    }
    sections.push(body);
  }
  return sections.join("\n\n");
}

function formatValidation(result: SkillValidationResult): string {
  const lines = [
    `${result.valid ? "VALID" : "INVALID"}: ${result.draftPath}`,
    `Target: ${result.targetPath}`,
    result.existing ? "Target already exists; files absent from the draft will be preserved." : "Target is new.",
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.severity === "error" ? "ERROR" : "WARNING"} [${diagnostic.code}]: ${diagnostic.message}`);
  }
  if (!result.diagnostics.length) lines.push("No diagnostics.");
  lines.push(`Files: ${result.files.length}; changes: ${result.changes.length}`);
  if (result.changes.length) lines.push(`\nProposed diff:\n${result.diff}`);
  return lines.join("\n");
}

export function registerSkillTools(pi: ExtensionAPI): void {
  const toolNames = new Set(["skill_validate", "skill_save"]);
  pi.on("session_start", () => {
    try {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !toolNames.has(name)));
    } catch {
      // L'activation de l'agent réapplique ensuite sa liste explicite.
    }
  });

  function validate(ctx: ExtensionContext, params: { scope: "global" | "project"; name: string }): SkillValidationResult {
    const diagnostics: SkillDiagnostic[] = [];
    if (!SKILL_NAME_PATTERN.test(params.name) || params.name.length > 64) {
      return {
        valid: false,
        diagnostics: [{ severity: "error", code: "invalid_name", message: "Name must be 1-64 lowercase letters, numbers, or single hyphens" }],
        draftPath: "(invalid draft name)",
        targetPath: "(invalid target name)",
        existing: false,
        files: [],
        changes: [],
        diff: "",
      };
    }

    const { draftPath, targetPath } = skillPaths(ctx.cwd, params.scope, params.name);
    if (!fs.existsSync(draftPath)) addDiagnostic(diagnostics, "error", "draft_missing", `Draft does not exist: ${draftPath}`);
    else if (fs.lstatSync(draftPath).isSymbolicLink() || !fs.lstatSync(draftPath).isDirectory()) {
      addDiagnostic(diagnostics, "error", "invalid_draft", "Skill draft must be a regular directory, not a symlink");
    }

    let draftFiles: SkillFile[] = [];
    if (!diagnostics.some((item) => item.code === "draft_missing" || item.code === "invalid_draft")) {
      try { draftFiles = walkFiles(draftPath, diagnostics, "Draft"); }
      catch (error) { addDiagnostic(diagnostics, "error", "unreadable_draft", error instanceof Error ? error.message : String(error)); }
    }

    const skillFile = draftFiles.find((file) => file.relativePath === "SKILL.md");
    let normalized: SkillValidationResult["normalized"];
    if (!skillFile) {
      addDiagnostic(diagnostics, "error", "skill_missing", "Draft must contain SKILL.md at its root");
    } else {
      try {
        const content = fs.readFileSync(skillFile.absolutePath, "utf8");
        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
        const name = frontmatter.name;
        const description = frontmatter.description;
        if (name !== params.name) addDiagnostic(diagnostics, "error", "name_mismatch", "Frontmatter name must match the skill directory name");
        if (typeof description !== "string" || !description.trim()) addDiagnostic(diagnostics, "error", "description_missing", "Description is required");
        else if (description.length > 1024) addDiagnostic(diagnostics, "error", "description_too_long", "Description must not exceed 1024 characters");
        if (frontmatter.compatibility !== undefined && (typeof frontmatter.compatibility !== "string" || !frontmatter.compatibility.trim() || frontmatter.compatibility.length > 500)) {
          addDiagnostic(diagnostics, "error", "invalid_compatibility", "Compatibility must be a non-empty string of at most 500 characters");
        }
        if (frontmatter["allowed-tools"] !== undefined && typeof frontmatter["allowed-tools"] !== "string") {
          addDiagnostic(diagnostics, "error", "invalid_allowed_tools", "allowed-tools must be a space-separated string");
        }
        if (frontmatter["disable-model-invocation"] !== undefined && typeof frontmatter["disable-model-invocation"] !== "boolean") {
          addDiagnostic(diagnostics, "error", "invalid_invocation_flag", "disable-model-invocation must be a boolean");
        }
        if (frontmatter.metadata !== undefined && (typeof frontmatter.metadata !== "object" || frontmatter.metadata === null || Array.isArray(frontmatter.metadata) || Object.values(frontmatter.metadata).some((value) => typeof value !== "string"))) {
          addDiagnostic(diagnostics, "error", "invalid_metadata", "Metadata must map string keys to string values");
        }
        for (const field of Object.keys(frontmatter)) {
          if (!FRONTMATTER_FIELDS.has(field)) addDiagnostic(diagnostics, "warning", "unknown_field", `Unknown frontmatter field ignored by pi: ${field}`);
        }
        if (!body.trim()) addDiagnostic(diagnostics, "error", "empty_body", "SKILL.md instructions are empty");
        if (body.split("\n").length > 500) addDiagnostic(diagnostics, "warning", "long_skill", "SKILL.md exceeds the recommended 500 lines; move details to references/");
        if (typeof name === "string" && typeof description === "string") normalized = { name, description };
      } catch (error) {
        addDiagnostic(diagnostics, "error", "invalid_frontmatter", error instanceof Error ? error.message : String(error));
      }
    }

    const existing = fs.existsSync(targetPath);
    let targetFiles: SkillFile[] = [];
    if (existing) {
      try {
        if (fs.lstatSync(targetPath).isSymbolicLink() || !fs.lstatSync(targetPath).isDirectory()) {
          addDiagnostic(diagnostics, "error", "invalid_target", "Skill target must be a regular directory, not a symlink");
        } else targetFiles = walkFiles(targetPath, diagnostics, "Target");
      } catch (error) { addDiagnostic(diagnostics, "error", "unreadable_target", error instanceof Error ? error.message : String(error)); }
    }

    const oppositeRoot = params.scope === "global" ? path.join(ctx.cwd, ".pi", "skills") : path.join(homedir(), ".pi", "agent", "skills");
    const opposite = path.join(oppositeRoot, params.name);
    if (fs.existsSync(opposite)) addDiagnostic(diagnostics, "warning", "scope_collision", `A skill with this name also exists at ${opposite}`);

    const targetByPath = new Map(targetFiles.map((file) => [file.relativePath, file]));
    const changes = draftFiles
      .filter((file) => targetByPath.get(file.relativePath)?.sha256 !== file.sha256 || targetByPath.get(file.relativePath)?.mode !== file.mode)
      .map((file): SkillChange => {
        const previous = targetByPath.get(file.relativePath);
        return {
          path: file.relativePath,
          status: previous ? "modified" : "added",
          size: file.size,
          diff: textDiff(file.relativePath, previous?.absolutePath, file.absolutePath),
        };
      });

    return {
      valid: !diagnostics.some((item) => item.severity === "error"),
      diagnostics,
      draftPath,
      targetPath,
      existing,
      files: draftFiles.map((file) => ({ path: file.relativePath, size: file.size })),
      changes,
      diff: renderDiff(changes),
      draftSha256: draftFiles.length ? treeHash(draftFiles) : undefined,
      targetSha256: existing && targetFiles.length ? treeHash(targetFiles) : existing ? sha256("") : undefined,
      normalized,
    };
  }

  const runValidation = async (ctx: ExtensionContext, params: { scope: "global" | "project"; name: string }) => {
    const result = validate(ctx, params);
    return { content: [{ type: "text" as const, text: formatValidation(result) }], details: result, isError: !result.valid };
  };

  pi.registerTool({
    name: "skill_validate",
    label: "Validate skill",
    description: "Validates a staged skill directory and previews additions or modifications without writing the installed skill.",
    promptSnippet: "Validate a staged skill draft without saving it",
    promptGuidelines: ["Use only for a requested dry run or after correcting a rejected draft; skill_save validates automatically."],
    parameters: CandidateSchema,
    async execute(_id, params, _signal, _update, ctx) {
      if (!SKILL_NAME_PATTERN.test(params.name) || params.name.length > 64) return runValidation(ctx, params);
      const paths = skillPaths(ctx.cwd, params.scope, params.name);
      return withFileMutationQueue(paths.draftPath, () => withFileMutationQueue(paths.targetPath, () => runValidation(ctx, params)));
    },
  });

  pi.registerTool({
    name: "skill_save",
    label: "Save skill",
    description: "Validates and atomically overlays a staged skill directory onto its authorized global or project target after confirmation.",
    promptSnippet: "Validate and save a staged skill to its exact authorized directory",
    promptGuidelines: [
      "Call directly after all draft files and script checks are complete; do not call in parallel with write, edit, or bash.",
      "Every create or update requires interactive confirmation; files absent from the draft are preserved.",
    ],
    parameters: CandidateSchema,
    async execute(_id, params, signal, _update, ctx) {
      if (!SKILL_NAME_PATTERN.test(params.name) || params.name.length > 64) return runValidation(ctx, params);
      const paths = skillPaths(ctx.cwd, params.scope, params.name);
      return withFileMutationQueue(paths.draftPath, () => withFileMutationQueue(paths.targetPath, async () => {
        const result = validate(ctx, params);
        if (!result.valid) return { content: [{ type: "text" as const, text: `Skill not saved.\n${formatValidation(result)}` }], details: result, isError: true };
        if (!result.changes.length) return { content: [{ type: "text" as const, text: `No changes: ${result.targetPath}` }], details: result };
        if (!ctx.hasUI) return { content: [{ type: "text" as const, text: "Skill not saved: every write requires interactive confirmation." }], details: result, isError: true };

        const approved = await ctx.ui.confirm(
          `${result.existing ? "Update" : "Create"} skill "${params.name}"?`,
          `${result.draftPath}\n→ ${result.targetPath}\n\n${result.diff}`,
          { signal },
        );
        if (!approved) return { content: [{ type: "text" as const, text: "Skill not saved: write declined by user." }], details: result, isError: true };

        const current = validate(ctx, params);
        if (!current.valid || current.draftSha256 !== result.draftSha256 || current.targetSha256 !== result.targetSha256) {
          return { content: [{ type: "text" as const, text: "Skill not saved: draft or target changed after confirmation; save again." }], details: current, isError: true };
        }

        const parent = path.dirname(result.targetPath);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const temporary = fs.mkdtempSync(path.join(parent, `.${params.name}.new-`));
        const previous = path.join(parent, `.${params.name}.old-${crypto.randomUUID()}`);
        let targetMoved = false;
        try {
          if (result.existing) {
            for (const entry of fs.readdirSync(result.targetPath)) fs.cpSync(path.join(result.targetPath, entry), path.join(temporary, entry), { recursive: true, preserveTimestamps: true });
          }
          for (const file of walkFiles(result.draftPath, [], "Draft")) {
            const destination = path.join(temporary, file.relativePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(file.absolutePath, destination);
            fs.chmodSync(destination, file.mode);
          }
          const expected = treeHash(walkFiles(temporary, [], "Staged target"));
          if (result.existing) {
            fs.renameSync(result.targetPath, previous);
            targetMoved = true;
          }
          fs.renameSync(temporary, result.targetPath);
          if (treeHash(walkFiles(result.targetPath, [], "Saved target")) !== expected) throw new Error("Post-write verification failed");
          if (targetMoved) fs.rmSync(previous, { recursive: true, force: true });
        } catch (error) {
          if (targetMoved && fs.existsSync(previous)) {
            if (fs.existsSync(result.targetPath)) fs.rmSync(result.targetPath, { recursive: true, force: true });
            fs.renameSync(previous, result.targetPath);
          } else if (!result.existing && fs.existsSync(result.targetPath)) {
            fs.rmSync(result.targetPath, { recursive: true, force: true });
          }
          throw error;
        } finally {
          fs.rmSync(temporary, { recursive: true, force: true });
        }

        return {
          content: [{ type: "text" as const, text: `Skill saved and verified: ${result.targetPath}\nRun /reload to load it.` }],
          details: { ...result, saved: true, verified: true },
        };
      }));
    },
  });
}
