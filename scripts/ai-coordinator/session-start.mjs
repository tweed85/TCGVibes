#!/usr/bin/env node
// Surfaces the session-start context for the next agent: last ~3 inbox
// messages + unclaimed/stale-claimed TODOs. Wired into Claude Code's
// SessionStart hook so the agent's first context window already contains
// the handoff signal.
//
// Output is markdown-formatted to stdout. Best-effort: missing files
// produce a minimal "no inbox / no TODOs" banner; never errors.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const INBOX_PATH = join(ROOT, "ai", "inbox.md");
const TODO_PATH = join(ROOT, "ai", "TODO.md");
const PROJECT_STATE_PATH = join(ROOT, "ai", "PROJECT_STATE.md");

const INBOX_TAIL_COUNT = 3;
const TODO_LIST_LIMIT = 5;
const STALE_CLAIM_HOURS = 1;

function readInboxBlocks() {
  if (!existsSync(INBOX_PATH)) return [];
  const text = readFileSync(INBOX_PATH, "utf8");
  // Schema A: blocks separated by "\n---\n". Header lines start with "## ".
  const blocks = text
    .split(/\n---\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => /^## \S+ \[/.test(chunk));
  return blocks;
}

function tailBlocks(blocks, n) {
  return blocks.slice(-n);
}

function summarizeBlock(block) {
  const lines = block.split(/\r?\n/);
  const header = lines[0] ?? "";
  const status =
    (lines.find((l) => l.startsWith("**Status:**")) || "**Status:** ?")
      .replace(/^\*\*Status:\*\*\s*/, "")
      .trim();
  const re = (lines.find((l) => l.startsWith("**Re:**")) || "")
    .replace(/^\*\*Re:\*\*\s*/, "")
    .trim();
  return { header, status, re };
}

function readTodoLines() {
  if (!existsSync(TODO_PATH)) return [];
  const text = readFileSync(TODO_PATH, "utf8");
  return text.split(/\r?\n/).filter((l) => /^- \[ \]/.test(l));
}

function isStaleClaim(line, hours = STALE_CLAIM_HOURS) {
  const m = line.match(/\[claimed:[^:]+:([^\]]+)\]/);
  if (!m) return false;
  const claimedAt = Date.parse(m[1]);
  if (!Number.isFinite(claimedAt)) return false;
  return Date.now() - claimedAt > hours * 60 * 60 * 1000;
}

function actionableTodos(lines) {
  // Surface unclaimed first, then stale-claimed. Skip fresh active claims —
  // they belong to another agent's in-progress turn.
  const unclaimed = lines.filter((l) => /\[unowned\]/.test(l));
  const stale = lines.filter((l) => isStaleClaim(l));
  return [...unclaimed, ...stale].slice(0, TODO_LIST_LIMIT);
}

function projectStateBanner() {
  if (!existsSync(PROJECT_STATE_PATH)) return null;
  const firstLine = readFileSync(PROJECT_STATE_PATH, "utf8").split(/\r?\n/, 1)[0] ?? "";
  const touched = firstLine.match(/last-touched:\s*([^\s|]+)/);
  if (!touched) return null;
  const ageMs = Date.now() - Date.parse(touched[1]);
  if (!Number.isFinite(ageMs)) return null;
  const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
  const mtimeAgeMs = existsSync(PROJECT_STATE_PATH)
    ? Date.now() - statSync(PROJECT_STATE_PATH).mtimeMs
    : 0;
  const mtimeAgeHours = (mtimeAgeMs / (60 * 60 * 1000)).toFixed(1);
  return `ai/PROJECT_STATE.md last-touched ${ageHours}h ago (mtime ${mtimeAgeHours}h ago)`;
}

const inboxBlocks = readInboxBlocks();
const todoLines = readTodoLines();
const actionable = actionableTodos(todoLines);
const banner = projectStateBanner();

const out = ["=== ai-coordinator session context ==="];
if (banner) out.push(banner);
out.push("");

out.push(`Inbox tail (last ${INBOX_TAIL_COUNT}):`);
if (inboxBlocks.length === 0) {
  out.push("  (empty)");
} else {
  for (const block of tailBlocks(inboxBlocks, INBOX_TAIL_COUNT)) {
    const { header, status, re } = summarizeBlock(block);
    out.push(`  ${header}`);
    out.push(`    status=${status} re=${re}`);
  }
}
out.push("");

out.push(`Actionable TODOs (unclaimed + stale claims >${STALE_CLAIM_HOURS}h):`);
if (actionable.length === 0) {
  out.push("  (none)");
} else {
  for (const line of actionable) out.push(`  ${line}`);
}
out.push("");

out.push("Read ai/inbox.md + ai/TODO.md before claiming work.");
out.push("=== end session context ===");

process.stdout.write(out.join("\n") + "\n");
