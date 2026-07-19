import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateSessionStats,
  extractSession,
  findAgentSessions,
  registerSessionTools,
} from "../extensions/session-tools.ts";

const usage = (cost: number) => ({
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-session-tools-"));
  const project = join(root, "--project--");
  mkdirSync(project);
  const sessionPath = join(project, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" },
    { type: "custom", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", customType: "nerisma-agents/active", data: { name: "agent-session-reviewer" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "test", model: "model", stopReason: "toolUse", usage: usage(0.1), content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: `API_KEY=supersecret ${"x".repeat(300)}` },
      { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "echo ok", password: "hidden" } },
    ] } },
    { type: "message", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: "x", parentId: "c", timestamp: "2026-01-01T00:00:03.100Z", message: { role: "user", content: "abandoned branch" } },
    { type: "message", id: "y", parentId: "x", timestamp: "2026-01-01T00:00:03.200Z", message: { role: "assistant", provider: "test", model: "model", stopReason: "toolUse", usage: usage(9), content: [{ type: "toolCall", id: "abandoned", name: "read", arguments: {} }] } },
    { type: "message", id: "d", parentId: "c", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", provider: "test", model: "model", stopReason: "toolUse", usage: usage(0.2), content: [{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "/missing" } }] } },
    { type: "message", id: "e", parentId: "d", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolCallId: "tc2", toolName: "read", isError: true, content: [{ type: "text", text: "missing" }] } },
    { type: "message", id: "f", parentId: "e", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", provider: "test", model: "model", stopReason: "toolUse", usage: usage(0.3), content: [{ type: "toolCall", id: "tc3", name: "grep", arguments: { pattern: "x" } }] } },
    { type: "compaction", id: "g", parentId: "f", timestamp: "2026-01-01T00:00:07.000Z", summary: "summary", firstKeptEntryId: "e", tokensBefore: 100 },
    { type: "custom", id: "h", parentId: "g", timestamp: "2026-01-01T00:00:08.000Z", customType: "nerisma-agents/active", data: { name: "other-agent" } },
    { type: "message", id: "i", parentId: "h", timestamp: "2026-01-01T00:00:09.000Z", message: { role: "assistant", provider: "test", model: "model", stopReason: "stop", usage: usage(5), content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nnot-json\n`);
  return { root, sessionPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("finds the latest active-branch segment for an agent", async () => {
  const item = fixture();
  try {
    const result = await findAgentSessions("agent-session-reviewer", { sessionRoot: item.root });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0].path, item.sessionPath);
    assert.equal(result.matches[0].lastTimestamp, "2026-01-01T00:00:09.000Z");
    assert.equal(result.matches[0].activeAtLeaf, false);
    assert.equal(result.matches[0].latestSegment.startEntryId, "a");
    assert.equal(result.matches[0].latestSegment.endEntryId, "g");
    assert.deepEqual(result.matches[0].invalidLines, [13]);

    const excluded = await findAgentSessions("agent-session-reviewer", { sessionRoot: item.root, excludePath: item.sessionPath });
    assert.equal(excluded.totalMatches, 0);
  } finally {
    item.cleanup();
  }
});

test("computes calls and cost only for the selected branch and agent segment", async () => {
  const item = fixture();
  try {
    const stats = await calculateSessionStats(item.sessionPath, { agentName: "agent-session-reviewer" });
    assert.deepEqual(
      { total: stats.toolCalls.total, succeeded: stats.toolCalls.succeeded, failed: stats.toolCalls.failed, unresolved: stats.toolCalls.unresolved },
      { total: 3, succeeded: 1, failed: 1, unresolved: 1 },
    );
    assert.equal(Number(stats.usage.cost.total.toFixed(6)), 0.6);
    assert.equal(stats.compactions, 1);
    assert.deepEqual(stats.landmarks.failedToolResults.map((item) => item.id), ["e"]);
    assert.deepEqual(stats.landmarks.unresolvedToolCalls.map((item) => item.toolCallId), ["tc3"]);
    assert.deepEqual(stats.landmarks.actionCalls.map((item) => item.toolCallId), ["tc1"]);
    assert.deepEqual(stats.landmarks.compactions.map((item) => item.id), ["g"]);

    const wholeTree = await calculateSessionStats(item.sessionPath, { scope: "whole-tree" });
    assert.equal(wholeTree.toolCalls.total, 4);
    assert.equal(Number(wholeTree.usage.cost.total.toFixed(6)), 14.6);
  } finally {
    item.cleanup();
  }
});

test("extracts bounded evidence, omits thinking, redacts secrets, and paginates", async () => {
  const item = fixture();
  try {
    const first = await extractSession(item.sessionPath, {
      agentName: "agent-session-reviewer",
      toolNames: ["bash"],
      limit: 1,
      maxChars: 100,
    });
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].id, "b");
    assert.ok(first.nextCursor);
    const encoded = JSON.stringify(first.events[0]);
    assert.doesNotMatch(encoded, /private reasoning|supersecret|hidden/);
    assert.match(encoded, /thinking omitted|redacted/);
    assert.equal(first.truncatedEvents, 1);

    const second = await extractSession(item.sessionPath, {
      agentName: "agent-session-reviewer",
      toolNames: ["bash"],
      cursor: first.nextCursor!,
    });
    assert.equal(second.events[0].id, "c");
    assert.equal(second.nextCursor, null);
  } finally {
    item.cleanup();
  }
});

test("outlines, projects, expands causal context, and enforces a global budget", async () => {
  const item = fixture();
  try {
    const causal = await extractSession(item.sessionPath, {
      agentName: "agent-session-reviewer",
      view: "outline",
      entryIds: ["b"],
      fields: ["type", "role", "toolNames", "toolCallIds", "isError"],
      context: { parents: 1, toolPair: true },
    });
    assert.deepEqual(causal.events.map((event) => event.id), ["a", "b", "c"]);
    assert.deepEqual(Object.keys(causal.events[1]), ["line", "id", "type", "role", "toolNames", "toolCallIds"]);
    assert.deepEqual(causal.coveredLines, { first: 2, last: 4 });
    assert.equal(causal.endReached, true);

    const bounded = await extractSession(item.sessionPath, {
      agentName: "agent-session-reviewer",
      view: "outline",
      totalChars: 1000,
      limit: 50,
    });
    assert.ok(bounded.returnedChars <= 1000);
    assert.equal(bounded.budgetExhausted, true);
    assert.ok(bounded.nextCursor);
  } finally {
    item.cleanup();
  }
});

test("rejects invalid headers and propagates cancellation", async () => {
  const item = fixture();
  const invalid = join(item.root, "invalid.jsonl");
  writeFileSync(invalid, `${JSON.stringify({ type: "message", id: "x" })}\n`);
  try {
    await assert.rejects(() => calculateSessionStats(invalid, { scope: "whole-tree" }), /Invalid session header/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => calculateSessionStats(item.sessionPath, { scope: "whole-tree", signal: controller.signal }), { name: "AbortError" });
  } finally {
    item.cleanup();
  }
});

test("registers session tools and keeps them inactive outside explicit agent allow-lists", () => {
  const names: string[] = [];
  let onStart: (() => void) | undefined;
  let active = ["read", "session_find", "session_stats", "session_extract"];
  const pi = {
    registerTool(tool: { name: string }) { names.push(tool.name); },
    on(event: string, handler: () => void) { if (event === "session_start") onStart = handler; },
    getActiveTools() { return active; },
    setActiveTools(next: string[]) { active = next; },
  } as unknown as ExtensionAPI;

  registerSessionTools(pi);
  assert.deepEqual(names, ["session_find", "session_stats", "session_extract"]);
  onStart?.();
  assert.deepEqual(active, ["read"]);
});
