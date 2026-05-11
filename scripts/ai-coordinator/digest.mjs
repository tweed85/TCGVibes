#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const ROOT = process.cwd();
const QA_PATH = join(ROOT, "ai", "QA.md");
const INBOX_PATH = join(ROOT, "ai", "inbox.md");
const SNAPSHOT_FILES = [
  join(ROOT, "ai", "PROJECT_STATE.md"),
  join(ROOT, "ai", "CONTEXT_SUMMARY.md"),
  join(ROOT, "ai", "agent_ownership.md"),
];

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const agent = argValue("--agent") || process.env.AI_AGENT || "unknown";
const started = Date.now();

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    ...options,
  });
}

function git(args) {
  const result = run("git", args);
  if (result.status !== 0) return "";
  return result.stdout.replace(/[\r\n]+$/, "");
}

function parseStatusPaths(output) {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => {
      const raw = line.slice(3).trim();
      if (!raw) return "";
      if (raw.includes(" -> ")) return raw.split(" -> ").pop().trim();
      return raw.replace(/^"|"$/g, "");
    })
    .filter(Boolean);
}

function changedPaths() {
  const statusPaths = parseStatusPaths(git(["status", "--short"]));
  if (statusPaths.length > 0) return [...new Set(statusPaths)];

  const lastCommitPaths = git(["diff", "--name-only", "HEAD~1..HEAD"]);
  if (!lastCommitPaths) return [];
  return [...new Set(lastCommitPaths.split(/\r?\n/).filter(Boolean))];
}

function hasPath(paths, predicate) {
  return paths.some(predicate);
}

function checksFor(paths) {
  const checks = [];
  const add = (key, label, command, args) => {
    if (!checks.some((c) => c.key === key)) checks.push({ key, label, command, args });
  };

  const sourceChanged = hasPath(paths, (p) =>
    p.startsWith("src/engine/") ||
    p.startsWith("src/data/") ||
    p.startsWith("src/ui/") ||
    p === "src/App.tsx" ||
    p === "package.json" ||
    p === "package-lock.json" ||
    p === "tsconfig.json" ||
    p === "vite.config.ts");

  if (sourceChanged) add("typecheck", "typecheck", "npm", ["run", "typecheck"]);
  if (hasPath(paths, (p) => p.startsWith("src/engine/"))) {
    add("vitest-engine", "vitest engine", "npm", ["run", "test", "--", "src/engine"]);
  }
  if (hasPath(paths, (p) => p.startsWith("src/data/"))) {
    add("vitest-data", "vitest data", "npm", ["run", "test", "--", "src/data"]);
  }
  if (hasPath(paths, (p) => p.startsWith("src/ui/"))) {
    add("vitest-ui", "vitest ui", "npm", ["run", "test", "--", "src/ui"]);
  }

  return checks;
}

function manualFlags(paths) {
  const flags = [];
  if (hasPath(paths, (p) => p.startsWith("supabase/"))) {
    flags.push("manual SQL/privacy review required for supabase changes");
  }
  if (hasPath(paths, (p) => p.startsWith("data/pokemon/"))) {
    flags.push("manual dataset-version validation required for data/pokemon changes");
  }
  if (hasPath(paths, (p) => p === "package.json" || p === "package-lock.json")) {
    flags.push("dependency/script changes should be reviewed before merge");
  }
  if (hasPath(paths, (p) => p === "src/App.tsx")) {
    flags.push("App action-surface changed; consider npm run e2e");
  }
  return flags;
}

function tailLines(text, count = 30) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-count).join("\n");
}

function runChecks(checks) {
  return checks.map((check) => {
    const before = Date.now();
    const result = run(check.command, check.args);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      ...check,
      status: result.status ?? 1,
      durationMs: Date.now() - before,
      tail: tailLines(output),
    };
  });
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

function xfailWarnings() {
  const files = walkFiles(join(ROOT, "src"), (p) => /\.(test|spec)\.(ts|tsx)$/.test(p));
  const staleCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  let count = 0;
  const stale = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const matches = text
      .split(/\r?\n/)
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n")
      .match(/\bit\.fails\s*\(/g);
    if (!matches) continue;
    count += matches.length;
    if (statSync(file).mtimeMs < staleCutoff) stale.push(file.replace(`${ROOT}/`, ""));
  }
  if (count === 0) return [];
  const warnings = [`it.fails count: ${count}`];
  if (stale.length > 0) warnings.push(`stale xfail files (>14d): ${stale.join(", ")}`);
  return warnings;
}

function snapshotWarnings() {
  const warnings = [];
  const now = Date.now();
  for (const file of SNAPSHOT_FILES) {
    if (!existsSync(file)) continue;
    const firstLine = readFileSync(file, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const freshness = firstLine.match(/freshness:\s*(\d+)h/);
    const touched = firstLine.match(/last-touched:\s*([^\s|]+)/);
    if (!freshness || !touched) continue;
    const freshnessMs = Number(freshness[1]) * 60 * 60 * 1000;
    const touchedMs = Date.parse(touched[1]);
    if (Number.isFinite(touchedMs) && now - touchedMs > freshnessMs) {
      warnings.push(`${file.replace(`${ROOT}/`, "")} is stale`);
    }
  }
  return warnings;
}

function formatBlock(paths, results, flags, warnings, turnIso) {
  const failed = results.filter((r) => r.status !== 0);
  const status = failed.length > 0 ? "open" : "resolved";
  const duration = ((Date.now() - started) / 1000).toFixed(2);
  const lines = [
    `## ${turnIso} [${agent}] digest run`,
    "",
    `**Status:** ${status}`,
    "**Re:** post-edit verification",
    "",
    `- changed: ${paths.length > 0 ? paths.join(", ") : "(none detected)"}`,
  ];

  if (results.length === 0) {
    lines.push("- checks: none selected");
  } else {
    for (const result of results) {
      const icon = result.status === 0 ? "✅" : "❌";
      lines.push(`- ${result.label}: ${icon} (${(result.durationMs / 1000).toFixed(2)}s)`);
    }
  }

  for (const flag of flags) lines.push(`- manual: ${flag}`);
  for (const warning of warnings) lines.push(`- warning: ${warning}`);
  lines.push(`- duration: ${duration}s`);

  const failedWithTail = results.filter((r) => r.status !== 0 || r.tail);
  for (const result of failedWithTail) {
    lines.push("", `<details><summary>${result.label} output tail</summary>`, "", "```text");
    lines.push(result.tail || "(no output)");
    lines.push("```", "", "</details>");
  }

  lines.push("", "---", "");
  return lines.join("\n");
}

function ensureFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) appendFileSync(path, "");
}

// Compact turn-end marker for inbox.md — the next agent's session-start
// hook surfaces the inbox tail, so this is the "I'm done" signal. Body
// stays one line; the full verification detail lives in QA.md.
function formatInboxBlock(paths, results, flags, warnings, turnIso) {
  const failed = results.filter((r) => r.status !== 0).length;
  const status = failed > 0 ? "open" : "informational";
  const summary =
    `${results.length} check(s), ${failed} failed, ` +
    `${flags.length} manual flag(s), ${warnings.length} warning(s)`;
  const top = paths.length > 0 ? paths.slice(0, 5).join(", ") : "(none detected)";
  const more = paths.length > 5 ? ` (+${paths.length - 5} more)` : "";
  const lines = [
    `## ${turnIso} [${agent}] turn-end digest`,
    "",
    `**Status:** ${status}`,
    `**Re:** handoff candidate (see ai/QA.md @ ${turnIso} for detail)`,
    "",
    `- summary: ${summary}`,
    `- changed: ${top}${more}`,
  ];
  if (failed > 0) lines.push(`- next agent: investigate failures in QA.md before claiming new work`);
  lines.push("", "---", "");
  return lines.join("\n");
}

const paths = changedPaths();
const selectedChecks = checksFor(paths);
const results = runChecks(selectedChecks);
const flags = manualFlags(paths);
const warnings = [...xfailWarnings(), ...snapshotWarnings()];
const turnIso = isoNow();
const block = formatBlock(paths, results, flags, warnings, turnIso);
const inboxBlock = formatInboxBlock(paths, results, flags, warnings, turnIso);

ensureFile(QA_PATH);
appendFileSync(QA_PATH, block, "utf8");
ensureFile(INBOX_PATH);
appendFileSync(INBOX_PATH, inboxBlock, "utf8");

const failures = results.filter((r) => r.status !== 0).length;
console.log(
  `[ai:digest] ${results.length} check(s), ${failures} failed, ${flags.length} manual flag(s), ${warnings.length} warning(s). Wrote ai/QA.md + ai/inbox.md.`,
);

process.exit(failures > 0 ? 1 : 0);
