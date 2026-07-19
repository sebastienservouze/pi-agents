import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import {
  truncateHead,
  truncateLine,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const ACTIVE_AGENT_TYPE = "nerisma-agents/active";
const SYSTEM_PROMPT_TYPE = "nerisma-agents/system-prompt";
const SESSION_TOOL_NAMES = new Set(["session_find", "session_stats", "session_extract"]);
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_CHARS = 800;

type JsonObject = Record<string, unknown>;
type SessionScope = "agent-segment" | "active-branch" | "whole-tree";

interface AgentMarker {
  agentName: string | null;
  kind: "active" | "system-prompt";
}

interface IndexedEntry {
  id: string;
  parentId: string | null;
  line: number;
  type: string;
  timestamp?: string;
  marker?: AgentMarker;
  toolCallIds: string[];
}

interface SessionIndex {
  path: string;
  header: JsonObject;
  entries: Map<string, IndexedEntry>;
  branch: IndexedEntry[];
  leafId: string | null;
  lastTimestamp: string | null;
  invalidLineCount: number;
  invalidLines: number[];
  duplicateIdCount: number;
  duplicateIds: string[];
  branchIssue?: string;
  size: number;
  mtimeMs: number;
  changedDuringRead: boolean;
}

export interface AgentSegment {
  startLine: number;
  endLine: number;
  startEntryId: string;
  endEntryId: string;
  startTimestamp?: string;
  endTimestamp?: string;
}

interface SessionLandmark {
  line: number;
  id: string;
  timestamp?: string;
  toolName?: string;
  toolCallId?: string;
  chars?: number;
}

interface SessionLandmarks {
  userRequests: SessionLandmark[];
  finalAnswers: SessionLandmark[];
  agentTransitions: SessionLandmark[];
  failedToolResults: SessionLandmark[];
  unresolvedToolCalls: SessionLandmark[];
  actionCalls: SessionLandmark[];
  confirmations: SessionLandmark[];
  compactions: SessionLandmark[];
  largestEntries: SessionLandmark[];
}

export interface SessionStats {
  path: string;
  scope: SessionScope;
  agentName?: string;
  selectedEntries: number;
  toolCalls: {
    total: number;
    succeeded: number;
    failed: number;
    unresolved: number;
    orphanResults: number;
    duplicateResults: number;
    byTool: Record<string, { total: number; succeeded: number; failed: number; unresolved: number }>;
  };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    byModel: Record<string, number>;
  };
  compactions: number;
  assistantErrors: number;
  landmarks: SessionLandmarks;
  invalidLineCount: number;
  invalidLines: number[];
  duplicateIdCount: number;
  duplicateIds: string[];
  branchIssue?: string;
  changedDuringRead: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addSample<T>(items: T[], value: T): void {
  if (items.length < 100) items.push(value);
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(homedir(), input.slice(2));
  return input;
}

async function resolveJsonlPath(input: string, signal?: AbortSignal): Promise<{ path: string; size: number; mtimeMs: number }> {
  signal?.throwIfAborted();
  const resolved = await realpath(path.resolve(expandHome(input)));
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`Session path is not a regular file: ${resolved}`);
  if (path.extname(resolved).toLowerCase() !== ".jsonl") throw new Error(`Session path must end in .jsonl: ${resolved}`);
  return { path: resolved, size: metadata.size, mtimeMs: metadata.mtimeMs };
}

async function* readLines(filePath: string, signal?: AbortSignal): AsyncGenerator<{ line: number; text: string }> {
  signal?.throwIfAborted();
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const abort = () => stream.destroy(new DOMException("Session read aborted", "AbortError"));
  signal?.addEventListener("abort", abort, { once: true });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of lines) {
      signal?.throwIfAborted();
      yield { line: ++line, text };
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    lines.close();
    stream.destroy();
  }
}

function markerFromEntry(entry: JsonObject): AgentMarker | undefined {
  if (entry.type !== "custom" || !isObject(entry.data)) return undefined;
  if (entry.customType === ACTIVE_AGENT_TYPE) {
    const name = entry.data.name;
    return { agentName: typeof name === "string" ? name : null, kind: "active" };
  }
  if (entry.customType === SYSTEM_PROMPT_TYPE && typeof entry.data.agentName === "string") {
    return { agentName: entry.data.agentName, kind: "system-prompt" };
  }
  return undefined;
}

function buildBranch(entries: Map<string, IndexedEntry>, leafId: string | null): { branch: IndexedEntry[]; issue?: string } {
  if (!leafId) return { branch: [] };
  const reversed: IndexedEntry[] = [];
  const seen = new Set<string>();
  let id: string | null = leafId;
  while (id) {
    if (seen.has(id)) return { branch: reversed.reverse(), issue: `Cycle detected at entry ${id}` };
    seen.add(id);
    const entry: IndexedEntry | undefined = entries.get(id);
    if (!entry) return { branch: reversed.reverse(), issue: `Missing parent entry ${id}` };
    reversed.push(entry);
    id = entry.parentId;
  }
  return { branch: reversed.reverse() };
}

async function indexSession(inputPath: string, signal?: AbortSignal): Promise<SessionIndex> {
  const resolved = await resolveJsonlPath(inputPath, signal);
  let header: JsonObject | undefined;
  const entries = new Map<string, IndexedEntry>();
  const invalidLines: number[] = [];
  const duplicateIds: string[] = [];
  let invalidLineCount = 0;
  let duplicateIdCount = 0;
  let leafId: string | null = null;
  let lastTimestamp: string | null = null;

  for await (const item of readLines(resolved.path, signal)) {
    if (!item.text.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(item.text);
    } catch {
      invalidLineCount++;
      addSample(invalidLines, item.line);
      continue;
    }
    if (!isObject(raw)) {
      invalidLineCount++;
      addSample(invalidLines, item.line);
      continue;
    }
    if (item.line === 1) {
      if (raw.type !== "session" || typeof raw.id !== "string") {
        throw new Error(`Invalid session header at ${resolved.path}:1`);
      }
      header = raw;
      continue;
    }
    if (typeof raw.id !== "string" || typeof raw.type !== "string" || !(typeof raw.parentId === "string" || raw.parentId === null)) {
      invalidLineCount++;
      addSample(invalidLines, item.line);
      continue;
    }
    const entry: IndexedEntry = {
      id: raw.id,
      parentId: raw.parentId,
      line: item.line,
      type: raw.type,
      timestamp: stringValue(raw.timestamp),
      marker: markerFromEntry(raw),
      toolCallIds: entryToolCallIds(raw),
    };
    if (entries.has(entry.id)) {
      duplicateIdCount++;
      addSample(duplicateIds, entry.id);
    }
    entries.set(entry.id, entry);
    leafId = entry.id;
    if (entry.timestamp && Number.isFinite(Date.parse(entry.timestamp))) lastTimestamp = entry.timestamp;
  }

  if (!header) throw new Error(`Session header is missing: ${resolved.path}`);
  const built = buildBranch(entries, leafId);
  const after = await stat(resolved.path);
  return {
    path: resolved.path,
    header,
    entries,
    branch: built.branch,
    leafId,
    lastTimestamp,
    invalidLineCount,
    invalidLines,
    duplicateIdCount,
    duplicateIds,
    branchIssue: built.issue,
    size: resolved.size,
    mtimeMs: resolved.mtimeMs,
    changedDuringRead: after.size !== resolved.size || after.mtimeMs !== resolved.mtimeMs,
  };
}

function agentSegments(branch: IndexedEntry[], agentName: string): { segments: AgentSegment[]; activeAtLeaf: boolean } {
  const segments: AgentSegment[] = [];
  let currentAgent: string | null | undefined;
  let start = 0;

  const close = (end: number) => {
    if (currentAgent !== agentName || end < start) return;
    const first = branch[start];
    const last = branch[end];
    segments.push({
      startLine: first.line,
      endLine: last.line,
      startEntryId: first.id,
      endEntryId: last.id,
      startTimestamp: first.timestamp,
      endTimestamp: last.timestamp,
    });
  };

  for (let i = 0; i < branch.length; i++) {
    const marker = branch[i].marker;
    if (!marker) continue;
    const establishesAgent = marker.kind === "active" || (marker.kind === "system-prompt" && currentAgent === undefined);
    if (!establishesAgent || marker.agentName === currentAgent) continue;
    close(i - 1);
    currentAgent = marker.agentName;
    start = i;
  }
  close(branch.length - 1);
  return { segments, activeAtLeaf: currentAgent === agentName };
}

async function* jsonlFiles(rootInput: string, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  const root = await realpath(path.resolve(expandHome(rootInput)));
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error(`Session root is not a directory: ${root}`);

  async function* walk(dir: string): AsyncGenerator<string> {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield child;
    }
  }

  yield* walk(root);
}

export async function findAgentSessions(
  agentName: string,
  options: { sessionRoot?: string; limit?: number; excludePath?: string; signal?: AbortSignal } = {},
) {
  if (!AGENT_NAME_PATTERN.test(agentName)) throw new Error(`Invalid agent name: ${agentName}`);
  const limit = options.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be an integer between 1 and 20");
  const excludedPath = options.excludePath ? (await resolveJsonlPath(options.excludePath, options.signal)).path : undefined;
  const matches: Array<{
    path: string;
    sessionId: string;
    cwd?: string;
    size: number;
    leafId: string | null;
    lastTimestamp: string | null;
    activeAtLeaf: boolean;
    latestSegment: AgentSegment;
    segmentCount: number;
    invalidLineCount: number;
    invalidLines: number[];
    duplicateIdCount: number;
    duplicateIds: string[];
    branchIssue?: string;
    changedDuringRead: boolean;
  }> = [];
  const skipped: Array<{ path: string; error: string }> = [];
  let skippedCount = 0;

  for await (const filePath of jsonlFiles(options.sessionRoot ?? path.join(homedir(), ".pi", "agent", "sessions"), options.signal)) {
    try {
      if (excludedPath && await realpath(filePath) === excludedPath) continue;
      const index = await indexSession(filePath, options.signal);
      const found = agentSegments(index.branch, agentName);
      const latestSegment = found.segments.at(-1);
      if (!latestSegment) continue;
      matches.push({
        path: index.path,
        sessionId: String(index.header.id),
        cwd: stringValue(index.header.cwd),
        size: index.size,
        leafId: index.leafId,
        lastTimestamp: index.lastTimestamp,
        activeAtLeaf: found.activeAtLeaf,
        latestSegment,
        segmentCount: found.segments.length,
        invalidLineCount: index.invalidLineCount,
        invalidLines: index.invalidLines,
        duplicateIdCount: index.duplicateIdCount,
        duplicateIds: index.duplicateIds,
        branchIssue: index.branchIssue,
        changedDuringRead: index.changedDuringRead,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      skippedCount++;
      addSample(skipped, { path: filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  matches.sort((a, b) => {
    const byTimestamp = (b.lastTimestamp ? Date.parse(b.lastTimestamp) : -Infinity) - (a.lastTimestamp ? Date.parse(a.lastTimestamp) : -Infinity);
    return byTimestamp || b.path.localeCompare(a.path);
  });
  return { agentName, matches: matches.slice(0, limit), totalMatches: matches.length, skippedCount, skipped };
}

function selection(index: SessionIndex, scope: SessionScope, agentName?: string): Set<string> | undefined {
  if (scope === "whole-tree") return undefined;
  if (scope === "active-branch") return new Set(index.branch.map((entry) => entry.id));
  if (!agentName) throw new Error("agentName is required when scope is agent-segment");
  const segment = agentSegments(index.branch, agentName).segments.at(-1);
  if (!segment) throw new Error(`Agent ${agentName} was not found on the active branch`);
  return new Set(index.branch
    .filter((entry) => entry.line >= segment.startLine && entry.line <= segment.endLine)
    .map((entry) => entry.id));
}

async function forEachSelectedEntry(
  index: SessionIndex,
  selected: Set<string> | undefined,
  signal: AbortSignal | undefined,
  visit: (entry: JsonObject, line: number, rawLine: string) => boolean | void,
): Promise<void> {
  for await (const item of readLines(index.path, signal)) {
    if (item.line === 1 || !item.text.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (
      !isObject(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.type !== "string" ||
      !(typeof raw.parentId === "string" || raw.parentId === null) ||
      (selected && !selected.has(raw.id))
    ) continue;
    if (visit(raw, item.line, item.text) === false) break;
  }
}

export async function calculateSessionStats(
  inputPath: string,
  options: { scope?: SessionScope; agentName?: string; signal?: AbortSignal } = {},
): Promise<SessionStats> {
  const scope = options.scope ?? "agent-segment";
  if (options.agentName && !AGENT_NAME_PATTERN.test(options.agentName)) throw new Error(`Invalid agent name: ${options.agentName}`);
  const index = await indexSession(inputPath, options.signal);
  const selected = selection(index, scope, options.agentName);
  const calls = new Map<string, { name: string; entry: SessionLandmark; status?: "succeeded" | "failed" }>();
  const earlyResults = new Map<string, boolean>();
  const landmarks: SessionLandmarks = {
    userRequests: [],
    finalAnswers: [],
    agentTransitions: [],
    failedToolResults: [],
    unresolvedToolCalls: [],
    actionCalls: [],
    confirmations: [],
    compactions: [],
    largestEntries: [],
  };
  const landmark = (entry: JsonObject, line: number, extra: Partial<SessionLandmark> = {}): SessionLandmark => ({
    line,
    id: String(entry.id),
    timestamp: stringValue(entry.timestamp),
    ...extra,
  });
  const remember = (items: SessionLandmark[], item: SessionLandmark) => { if (items.length < 20) items.push(item); };
  const byModel: Record<string, number> = {};
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    byModel,
  };
  let selectedEntries = 0;
  let orphanResults = 0;
  let duplicateResults = 0;
  let compactions = 0;
  let assistantErrors = 0;

  await forEachSelectedEntry(index, selected, options.signal, (entry, line, rawLine) => {
    selectedEntries++;
    landmarks.largestEntries.push(landmark(entry, line, { chars: rawLine.length }));
    landmarks.largestEntries.sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0));
    landmarks.largestEntries.length = Math.min(10, landmarks.largestEntries.length);
    if (entry.type === "compaction") {
      compactions++;
      remember(landmarks.compactions, landmark(entry, line));
    }
    if (entry.type === "custom" && markerFromEntry(entry)) remember(landmarks.agentTransitions, landmark(entry, line));
    if (entry.type !== "message" || !isObject(entry.message)) return;
    const message = entry.message;
    if (message.role === "user") remember(landmarks.userRequests, landmark(entry, line));
    if (message.role === "assistant") {
      if (message.stopReason === "error") assistantErrors++;
      if (message.stopReason === "stop") remember(landmarks.finalAnswers, landmark(entry, line));
      if (isObject(message.usage)) {
        usage.input += finiteNumber(message.usage.input);
        usage.output += finiteNumber(message.usage.output);
        usage.cacheRead += finiteNumber(message.usage.cacheRead);
        usage.cacheWrite += finiteNumber(message.usage.cacheWrite);
        usage.totalTokens += finiteNumber(message.usage.totalTokens);
        if (isObject(message.usage.cost)) {
          usage.cost.input += finiteNumber(message.usage.cost.input);
          usage.cost.output += finiteNumber(message.usage.cost.output);
          usage.cost.cacheRead += finiteNumber(message.usage.cost.cacheRead);
          usage.cost.cacheWrite += finiteNumber(message.usage.cost.cacheWrite);
          usage.cost.total += finiteNumber(message.usage.cost.total);
        }
      }
      const model = `${stringValue(message.provider) ?? "unknown"}/${stringValue(message.model) ?? "unknown"}`;
      byModel[model] = (byModel[model] ?? 0) + (isObject(message.usage) && isObject(message.usage.cost) ? finiteNumber(message.usage.cost.total) : 0);
      if (!Array.isArray(message.content)) return;
      for (const block of message.content) {
        if (!isObject(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        const callEntry = landmark(entry, line, { toolName: block.name, toolCallId: block.id });
        const call = { name: block.name, entry: callEntry } as { name: string; entry: SessionLandmark; status?: "succeeded" | "failed" };
        const early = earlyResults.get(block.id);
        if (early !== undefined) call.status = early ? "failed" : "succeeded";
        calls.set(block.id, call);
        if (["bash", "edit", "write"].includes(block.name)) remember(landmarks.actionCalls, callEntry);
        if (block.name === "ask_user_question") remember(landmarks.confirmations, callEntry);
      }
      return;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return;
    const isError = message.isError === true;
    if (isError) remember(landmarks.failedToolResults, landmark(entry, line, {
      toolName: stringValue(message.toolName),
      toolCallId: message.toolCallId,
    }));
    const call = calls.get(message.toolCallId);
    if (!call) {
      earlyResults.set(message.toolCallId, isError);
      orphanResults++;
    } else if (call.status) {
      duplicateResults++;
    } else {
      call.status = isError ? "failed" : "succeeded";
    }
  });

  const byTool: SessionStats["toolCalls"]["byTool"] = {};
  let succeeded = 0;
  let failed = 0;
  let unresolved = 0;
  for (const call of calls.values()) {
    const item = byTool[call.name] ?? { total: 0, succeeded: 0, failed: 0, unresolved: 0 };
    item.total++;
    if (call.status === "succeeded") { item.succeeded++; succeeded++; }
    else if (call.status === "failed") { item.failed++; failed++; }
    else {
      item.unresolved++;
      unresolved++;
      remember(landmarks.unresolvedToolCalls, call.entry);
    }
    byTool[call.name] = item;
  }
  const after = await stat(index.path);
  return {
    path: index.path,
    scope,
    agentName: options.agentName,
    selectedEntries,
    toolCalls: { total: calls.size, succeeded, failed, unresolved, orphanResults, duplicateResults, byTool },
    usage,
    compactions,
    assistantErrors,
    landmarks,
    invalidLineCount: index.invalidLineCount,
    invalidLines: index.invalidLines,
    duplicateIdCount: index.duplicateIdCount,
    duplicateIds: index.duplicateIds,
    branchIssue: index.branchIssue,
    changedDuringRead: index.changedDuringRead || after.size !== index.size || after.mtimeMs !== index.mtimeMs,
  };
}

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s]+)/g, "$1=[redacted]");
}

function safeValue(value: unknown, maxChars: number, depth = 0): unknown {
  if (depth > 3) return "[depth limit]";
  if (typeof value === "string") return truncateLine(redactText(value), maxChars).text;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => safeValue(item, maxChars, depth + 1));
  if (!isObject(value)) return truncateLine(String(value), maxChars).text;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[redacted]" : safeValue(item, maxChars, depth + 1),
  ]));
}

function safeJson(value: unknown, maxChars: number): string {
  return truncateLine(JSON.stringify(safeValue(value, Math.min(maxChars, 500))), maxChars).text;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return redactText(content);
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!isObject(block)) return "";
    if (block.type === "text" && typeof block.text === "string") return redactText(block.text);
    if (block.type === "image") return `[image ${stringValue(block.mimeType) ?? "unknown"}]`;
    if (block.type === "thinking") return "[thinking omitted]";
    return "";
  }).filter(Boolean).join("\n");
}

function entryToolNames(entry: JsonObject): string[] {
  if (entry.type !== "message" || !isObject(entry.message)) return [];
  if (entry.message.role === "toolResult" && typeof entry.message.toolName === "string") return [entry.message.toolName];
  if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content
    .filter((block): block is JsonObject => isObject(block) && block.type === "toolCall" && typeof block.name === "string")
    .map((block) => block.name as string);
}

function entryToolCallIds(entry: JsonObject): string[] {
  if (entry.type !== "message" || !isObject(entry.message)) return [];
  if (entry.message.role === "toolResult" && typeof entry.message.toolCallId === "string") return [entry.message.toolCallId];
  if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content
    .filter((block): block is JsonObject => isObject(block) && block.type === "toolCall" && typeof block.id === "string")
    .map((block) => block.id as string);
}

function normalizeEntry(entry: JsonObject, line: number, maxChars: number): JsonObject {
  let contentTruncated = false;
  const clip = (text: string) => {
    const result = truncateLine(text, maxChars);
    contentTruncated ||= result.wasTruncated;
    return result.text;
  };
  const normalized: JsonObject = {
    line,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    type: entry.type,
  };
  if (entry.type === "message" && isObject(entry.message)) {
    const message = entry.message;
    normalized.role = message.role;
    if (message.role === "assistant") {
      normalized.provider = message.provider;
      normalized.model = message.model;
      normalized.stopReason = message.stopReason;
      const text = contentText(message.content);
      if (text) normalized.text = clip(text);
      if (Array.isArray(message.content)) {
        const toolCalls = message.content
          .filter((block): block is JsonObject => isObject(block) && block.type === "toolCall")
          .slice(0, 10)
          .map((block) => ({ id: block.id, name: block.name, arguments: safeJson(block.arguments, Math.min(maxChars, 500)) }));
        if (toolCalls.length) normalized.toolCalls = toolCalls;
      }
      if (isObject(message.usage)) normalized.usage = safeValue(message.usage, maxChars);
    } else if (message.role === "toolResult") {
      normalized.toolCallId = message.toolCallId;
      normalized.toolName = message.toolName;
      normalized.isError = message.isError;
      normalized.text = clip(contentText(message.content));
    } else if (message.role === "bashExecution") {
      normalized.command = clip(redactText(String(message.command ?? "")));
      normalized.output = clip(redactText(String(message.output ?? "")));
      normalized.exitCode = message.exitCode;
      normalized.cancelled = message.cancelled;
      normalized.truncated = message.truncated;
    } else {
      normalized.text = clip(contentText(message.content));
    }
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    normalized.summary = clip(redactText(String(entry.summary ?? "")));
    if (entry.type === "compaction") normalized.tokensBefore = entry.tokensBefore;
  } else if (entry.type === "custom_message") {
    normalized.customType = entry.customType;
    normalized.text = clip(contentText(entry.content));
  } else if (entry.type === "custom") {
    normalized.customType = entry.customType;
    const marker = markerFromEntry(entry);
    if (marker) normalized.agentName = marker.agentName;
    if (entry.customType === SYSTEM_PROMPT_TYPE && isObject(entry.data)) {
      normalized.source = entry.data.source;
      if (typeof entry.data.prompt === "string") normalized.prompt = clip(redactText(entry.data.prompt));
    }
  } else if (entry.type === "model_change") {
    normalized.provider = entry.provider;
    normalized.modelId = entry.modelId;
  } else if (entry.type === "thinking_level_change") {
    normalized.thinkingLevel = entry.thinkingLevel;
  }
  if (contentTruncated) normalized.contentTruncated = true;
  return normalized;
}

type ExtractView = "evidence" | "outline";

const EXTRACT_FIELDS = [
  "parentId", "timestamp", "type", "sourceChars", "role", "provider", "model", "stopReason",
  "text", "toolCalls", "toolNames", "toolCallIds", "usage", "toolCallId", "toolName", "isError",
  "command", "output", "exitCode", "cancelled", "truncated", "summary", "tokensBefore", "customType",
  "agentName", "prompt", "source", "modelId", "thinkingLevel", "contentTruncated",
] as const;
const EXTRACT_FIELD_SET = new Set<string>(EXTRACT_FIELDS);

interface ExtractContext {
  before?: number;
  after?: number;
  parents?: number;
  toolPair?: boolean;
}

function outlineEntry(entry: JsonObject, line: number, sourceChars: number): JsonObject {
  const outlined: JsonObject = {
    line,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    type: entry.type,
    sourceChars,
  };
  if (entry.type === "message" && isObject(entry.message)) {
    outlined.role = entry.message.role;
    outlined.stopReason = entry.message.stopReason;
    outlined.toolNames = entryToolNames(entry);
    outlined.toolCallIds = entryToolCallIds(entry);
    if (entry.message.role === "toolResult") outlined.isError = entry.message.isError === true;
  } else if (entry.type === "custom") {
    outlined.customType = entry.customType;
    outlined.agentName = markerFromEntry(entry)?.agentName;
  }
  return outlined;
}

function projectEntry(entry: JsonObject, fields?: string[]): JsonObject {
  if (!fields?.length) return entry;
  const projected: JsonObject = { line: entry.line, id: entry.id };
  for (const field of fields) if (field in entry) projected[field] = entry[field];
  return projected;
}

function expandedContextIds(
  index: SessionIndex,
  selected: Set<string> | undefined,
  entryIds: string[],
  context: ExtractContext,
): Set<string> {
  const before = context.before ?? 0;
  const after = context.after ?? 0;
  const parents = context.parents ?? 0;
  for (const [name, value] of [["before", before], ["after", after], ["parents", parents]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error(`context.${name} must be an integer between 0 and 5`);
  }
  const ordered = [...index.entries.values()].filter((entry) => !selected || selected.has(entry.id));
  const positions = new Map(ordered.map((entry, i) => [entry.id, i]));
  const ids = new Set(entryIds.filter((id) => positions.has(id)));
  for (const seed of [...ids]) {
    const position = positions.get(seed)!;
    for (let i = Math.max(0, position - before); i <= Math.min(ordered.length - 1, position + after); i++) ids.add(ordered[i].id);
    let parentId = index.entries.get(seed)?.parentId;
    for (let depth = 0; depth < parents && parentId; depth++) {
      if (!selected || selected.has(parentId)) ids.add(parentId);
      parentId = index.entries.get(parentId)?.parentId;
    }
  }
  if (context.toolPair) {
    const callIds = new Set([...ids].flatMap((id) => index.entries.get(id)?.toolCallIds ?? []));
    for (const entry of ordered) if (entry.toolCallIds.some((id) => callIds.has(id))) ids.add(entry.id);
  }
  return ids;
}

export async function extractSession(
  inputPath: string,
  options: {
    scope?: SessionScope;
    agentName?: string;
    view?: ExtractView;
    fields?: string[];
    entryTypes?: string[];
    roles?: string[];
    toolNames?: string[];
    entryIds?: string[];
    toolCallIds?: string[];
    query?: string;
    fromTimestamp?: string;
    toTimestamp?: string;
    cursor?: number;
    limit?: number;
    maxChars?: number;
    totalChars?: number;
    context?: ExtractContext;
    signal?: AbortSignal;
  } = {},
) {
  const scope = options.scope ?? "agent-segment";
  const view = options.view ?? "evidence";
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const totalChars = options.totalChars ?? 12_000;
  const cursor = options.cursor ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer between 1 and 50");
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 2000) throw new Error("maxChars must be an integer between 100 and 2000");
  if (!Number.isInteger(totalChars) || totalChars < 1000 || totalChars > 30000) throw new Error("totalChars must be an integer between 1000 and 30000");
  if (!Number.isInteger(cursor) || cursor < 2) throw new Error("cursor must be an integer greater than or equal to 2");
  if (options.agentName && !AGENT_NAME_PATTERN.test(options.agentName)) throw new Error(`Invalid agent name: ${options.agentName}`);
  const invalidField = options.fields?.find((field) => !EXTRACT_FIELD_SET.has(field));
  if (invalidField) throw new Error(`Unsupported projection field: ${invalidField}`);
  if (options.context && !options.entryIds?.length) throw new Error("entryIds are required when context is requested");
  if (options.context && (options.entryTypes?.length || options.roles?.length || options.toolNames?.length || options.toolCallIds?.length || options.query || options.fromTimestamp || options.toTimestamp)) {
    throw new Error("context cannot be combined with content filters; entryIds define the evidence seeds");
  }
  const from = options.fromTimestamp === undefined ? undefined : Date.parse(options.fromTimestamp);
  const to = options.toTimestamp === undefined ? undefined : Date.parse(options.toTimestamp);
  if (from !== undefined && !Number.isFinite(from)) throw new Error("fromTimestamp must be an ISO timestamp");
  if (to !== undefined && !Number.isFinite(to)) throw new Error("toTimestamp must be an ISO timestamp");

  const index = await indexSession(inputPath, options.signal);
  const selected = selection(index, scope, options.agentName);
  const contextIds = options.context ? expandedContextIds(index, selected, options.entryIds!, options.context) : undefined;
  const events: JsonObject[] = [];
  let nextCursor: number | null = null;
  let returnedChars = 0;
  let budgetExhausted = false;
  let truncatedEvents = 0;
  let oversizedEvents = 0;
  const includes = (list: string[] | undefined, value: string | undefined) => !list?.length || (!!value && list.includes(value));

  await forEachSelectedEntry(index, selected, options.signal, (entry, line, rawLine) => {
    if (line < cursor) return;
    const role = entry.type === "message" && isObject(entry.message) ? stringValue(entry.message.role) : undefined;
    const timestamp = stringValue(entry.timestamp);
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN;
    if (contextIds) {
      if (!contextIds.has(String(entry.id))) return;
    } else {
      if (!includes(options.entryTypes, stringValue(entry.type))) return;
      if (!includes(options.roles, role)) return;
      const toolNames = entryToolNames(entry);
      if (options.toolNames?.length && !toolNames.some((name) => options.toolNames!.includes(name))) return;
      if (options.entryIds?.length && !options.entryIds.includes(String(entry.id))) return;
      const toolCallIds = entryToolCallIds(entry);
      if (options.toolCallIds?.length && !toolCallIds.some((id) => options.toolCallIds!.includes(id))) return;
      if (from !== undefined && (!Number.isFinite(timestampMs) || timestampMs < from)) return;
      if (to !== undefined && (!Number.isFinite(timestampMs) || timestampMs > to)) return;
    }
    const base = view === "outline" ? outlineEntry(entry, line, rawLine.length) : normalizeEntry(entry, line, maxChars);
    const wasContentTruncated = base.contentTruncated === true;
    let normalized = projectEntry(base, options.fields);
    if (!contextIds && options.query && !JSON.stringify(normalized).toLowerCase().includes(options.query.toLowerCase())) return;
    let eventChars = JSON.stringify(normalized).length + (events.length ? 1 : 0);
    if (eventChars > totalChars) {
      oversizedEvents++;
      normalized = {
        line,
        id: entry.id,
        timestamp: entry.timestamp,
        type: entry.type,
        omitted: `Event exceeds totalChars (${eventChars}); request fewer fields or a lower maxChars`,
      };
      eventChars = JSON.stringify(normalized).length + (events.length ? 1 : 0);
    }
    if (events.length === limit || (events.length > 0 && returnedChars + eventChars > totalChars)) {
      nextCursor = line;
      budgetExhausted = events.length < limit;
      return false;
    }
    events.push(normalized);
    if (wasContentTruncated) truncatedEvents++;
    returnedChars += eventChars;
  });

  const after = await stat(index.path);
  const firstLine = events.length ? Number(events[0].line) : null;
  const lastLine = events.length ? Number(events.at(-1)!.line) : null;
  return {
    path: index.path,
    scope,
    agentName: options.agentName,
    view,
    events,
    matched: events.length,
    returnedChars,
    coveredLines: firstLine === null ? null : { first: firstLine, last: lastLine },
    nextCursor,
    endReached: nextCursor === null,
    budgetExhausted,
    truncatedEvents,
    oversizedEvents,
    invalidLineCount: index.invalidLineCount,
    invalidLines: index.invalidLines,
    duplicateIdCount: index.duplicateIdCount,
    duplicateIds: index.duplicateIds,
    branchIssue: index.branchIssue,
    changedDuringRead: index.changedDuringRead || after.size !== index.size || after.mtimeMs !== index.mtimeMs,
  };
}

function statsText(stats: SessionStats): string {
  const tools = Object.entries(stats.toolCalls.byTool)
    .map(([name, item]) => `- ${name}: ${item.total} total, ${item.succeeded} succeeded, ${item.failed} failed, ${item.unresolved} unresolved`)
    .join("\n") || "- (none)";
  const landmarkLines = (Object.entries(stats.landmarks) as Array<[keyof SessionLandmarks, SessionLandmark[]]>)
    .filter(([name, items]) => name !== "largestEntries" && items.length)
    .map(([name, items]) => `- ${name}: ${items.map((item) => item.id).join(", ")}`);
  if (stats.landmarks.largestEntries.length) {
    landmarkLines.push(`- largestEntries: ${stats.landmarks.largestEntries.map((item) => `${item.id}(${item.chars})`).join(", ")}`);
  }
  return [
    `Session: ${stats.path}`,
    `Scope: ${stats.scope}${stats.agentName ? ` (${stats.agentName})` : ""}`,
    `Tool calls: ${stats.toolCalls.total} total, ${stats.toolCalls.succeeded} succeeded, ${stats.toolCalls.failed} failed, ${stats.toolCalls.unresolved} unresolved`,
    `Cost: $${stats.usage.cost.total.toFixed(6)}; tokens: ${stats.usage.totalTokens}`,
    `Compactions: ${stats.compactions}; assistant errors: ${stats.assistantErrors}`,
    `By tool:\n${tools}`,
    `Landmarks:\n${landmarkLines.join("\n") || "- (none)"}`,
    ...(stats.invalidLineCount ? [`Invalid JSONL lines: ${stats.invalidLineCount} (sample: ${stats.invalidLines.join(", ")})`] : []),
    ...(stats.duplicateIdCount ? [`Duplicate entry IDs: ${stats.duplicateIdCount} (sample: ${stats.duplicateIds.join(", ")})`] : []),
    ...(stats.branchIssue ? [`Branch issue: ${stats.branchIssue}`] : []),
    ...(stats.changedDuringRead ? ["Warning: the session changed while it was read; metrics are a partial snapshot."] : []),
  ].join("\n");
}

export function registerSessionTools(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    try {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !SESSION_TOOL_NAMES.has(name)));
    } catch {
      // Agent activation re-applies its explicit allow-list after this hook.
    }
  });

  pi.registerTool({
    name: "session_find",
    label: "Find agent sessions",
    description: "Finds the most recent persisted pi JSONL sessions whose active branch contains a named pi-agent activation. Use before auditing when no session path was supplied.",
    promptSnippet: "Find the latest persisted session for a named pi-agent",
    promptGuidelines: ["Prefer the first match and report skipped or malformed sessions as audit limitations."],
    parameters: Type.Object({
      agentName: Type.String({ pattern: AGENT_NAME_PATTERN.source, description: "Exact pi-agent name" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum matches, newest first (default 1)" })),
      sessionRoot: Type.Optional(Type.String({ description: "Session directory; defaults to ~/.pi/agent/sessions" })),
      excludePath: Type.Optional(Type.String({ description: "Exact session .jsonl path to exclude, typically the current audit session" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await findAgentSessions(params.agentName, { sessionRoot: params.sessionRoot, limit: params.limit, excludePath: params.excludePath, signal });
      const text = result.matches.length
        ? result.matches.map((item, i) => `${i + 1}. ${item.path}\n   last=${item.lastTimestamp ?? "unknown"} activeAtLeaf=${item.activeAtLeaf} segment=${item.latestSegment.startEntryId}..${item.latestSegment.endEntryId}`).join("\n")
        : `No persisted session found for agent ${params.agentName}.`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "session_stats",
    label: "Session statistics",
    description: "Computes branch-aware metrics and compact evidence landmarks (requests, finals, failures, action calls, confirmations, compactions, and largest entries) from a pi session JSONL. Use before extraction.",
    promptSnippet: "Compute metrics and evidence landmarks for a pi JSONL session or one agent segment",
    promptGuidelines: ["Treat unresolved tool calls and changedDuringRead as evidence that the snapshot may be incomplete."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to a pi session .jsonl file" }),
      scope: Type.Optional(Type.Union([Type.Literal("agent-segment"), Type.Literal("active-branch"), Type.Literal("whole-tree")])),
      agentName: Type.Optional(Type.String({ pattern: AGENT_NAME_PATTERN.source, description: "Required for agent-segment scope" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await calculateSessionStats(params.path, { scope: params.scope, agentName: params.agentName, signal });
      return { content: [{ type: "text", text: statsText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "session_extract",
    label: "Extract session events",
    description: "Returns a globally bounded, branch-aware outline or detailed evidence from a pi session. Supports projections and causal context around known entry IDs; thinking and obvious credentials are omitted.",
    promptSnippet: "Outline a session, then extract causal evidence by landmark entry ID without loading the whole JSONL",
    promptGuidelines: ["Start with session_stats landmarks; use outline only when structure is unclear, then request evidence by entryIds with context."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to a pi session .jsonl file" }),
      scope: Type.Optional(Type.Union([Type.Literal("agent-segment"), Type.Literal("active-branch"), Type.Literal("whole-tree")])),
      agentName: Type.Optional(Type.String({ pattern: AGENT_NAME_PATTERN.source, description: "Required for agent-segment scope" })),
      view: Type.Optional(Type.Union([Type.Literal("evidence"), Type.Literal("outline")], { description: "outline omits content and arguments; evidence is detailed (default)" })),
      fields: Type.Optional(Type.Array(Type.Union(EXTRACT_FIELDS.map((field) => Type.Literal(field))), { maxItems: 20, description: "Projection; line and id are always retained" })),
      entryTypes: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      roles: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      toolNames: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      entryIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
      toolCallIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
      query: Type.Optional(Type.String({ maxLength: 200, description: "Case-insensitive literal search on normalized output" })),
      fromTimestamp: Type.Optional(Type.String()),
      toTimestamp: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.Integer({ minimum: 2, description: "JSONL line cursor returned by the previous call" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: `Maximum events (default ${DEFAULT_LIMIT})` })),
      maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 2000, description: `Maximum text characters per event (default ${DEFAULT_MAX_CHARS})` })),
      totalChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000, description: "Global serialized event budget (default 12000)" })),
      context: Type.Optional(Type.Object({
        before: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
        after: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
        parents: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
        toolPair: Type.Optional(Type.Boolean({ description: "Include matching tool call/result entries" })),
      }, { description: "Causal expansion around entryIds; cannot be combined with content filters" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await extractSession(params.path, { ...params, signal });
      const body = result.events.map((event) => JSON.stringify(event)).join("\n") || "(no matching events)";
      const rendered = truncateHead(body, { maxBytes: 30_000, maxLines: 100 });
      const coverage = `matched=${result.matched} coveredLines=${result.coveredLines ? `${result.coveredLines.first}..${result.coveredLines.last}` : "none"} nextCursor=${result.nextCursor ?? "none"} endReached=${result.endReached} budgetExhausted=${result.budgetExhausted} truncatedEvents=${result.truncatedEvents} oversizedEvents=${result.oversizedEvents}`;
      return {
        content: [{ type: "text", text: `${rendered.content}${rendered.truncated ? "\n[output truncated]" : ""}\n${coverage}` }],
        details: { ...result, contentTruncated: rendered.truncated },
      };
    },
  });
}
