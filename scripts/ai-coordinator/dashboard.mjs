#!/usr/bin/env node
// Live peer-process dashboard. Regenerates ai/dashboard.md on demand or
// in a polling loop (`--watch`). Open ai/dashboard.md in VSCode markdown
// preview — the preview auto-refreshes on file change, so a polling
// `npm run ai:dashboard:watch` in a terminal gives near-real-time
// visibility into running codex/claude peer sessions.
//
// Signals shown (scope intentionally narrow):
//   - Running codex/claude peer processes (pid, elapsed, command tail)
//   - Each running process paired with its peer-session log file
//   - Last 3 peer-session logs by mtime (whether or not the process is alive)
//
// Out of scope: phase progress, inbox tail, log tail rendering. Add those
// as new sections in render() if they ever become useful.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SESSIONS_DIR = join(ROOT, "ai", "peer-sessions");
const DASHBOARD_PATH = join(ROOT, "ai", "dashboard.md");

const watchIdx = process.argv.indexOf("--watch");
const watchFlag = watchIdx >= 0;
const intervalArg = watchFlag ? process.argv[watchIdx + 1] : undefined;
const intervalMs =
  intervalArg && /^\d+$/.test(intervalArg) ? Number(intervalArg) * 1000 : 3000;

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function listPeerProcesses() {
  const result = spawnSync(
    "ps",
    ["-ax", "-o", "pid=,etime=,command="],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 8 },
  );
  if (result.status !== 0 || !result.stdout) return [];
  const lines = result.stdout.split(/\r?\n/);
  const peers = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, etime, cmd] = m;
    // Skip the dashboard's own ps invocation if it ever shows up.
    if (cmd.includes("dashboard.mjs")) continue;
    if (
      cmd.includes("codex") &&
      cmd.includes("--ask-for-approval") &&
      cmd.includes("exec")
    ) {
      peers.push({ pid, agent: "codex", etime, cmd });
    } else if (/\bclaude\s+(-p|--print)\b/.test(cmd)) {
      // Chain-fired claude is invoked with a plain `claude -p "<prompt>"`.
      // Exclude false positives from other claude-CLI invocations that
      // also use -p: OpenClaw's card-audit cron (--mcp-config /...openclaw),
      // resumed interactive sessions (--resume <uuid>), and anything
      // explicitly loading external plugins/skills. Our chain-fire never
      // sets those flags.
      const falsePositive =
        /--mcp-config\b/.test(cmd) ||
        /--resume\b/.test(cmd) ||
        /--plugin-dir\b/.test(cmd) ||
        /openclaw/i.test(cmd);
      if (!falsePositive) peers.push({ pid, agent: "claude", etime, cmd });
    }
  }
  return peers;
}

function listRecentLogs(limit) {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".log"))
    .map((f) => {
      const p = join(SESSIONS_DIR, f);
      const s = statSync(p);
      return { name: f, mtimeMs: s.mtimeMs, sizeBytes: s.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

function pairProcessToLog(peers, logs) {
  // Reverse-chronological best-effort: for each running peer, claim the
  // newest unclaimed log whose filename starts with the peer agent name.
  const claimed = new Set();
  return peers.map((p) => {
    const candidate = logs.find(
      (l) => !claimed.has(l.name) && l.name.startsWith(`${p.agent}-`),
    );
    if (candidate) claimed.add(candidate.name);
    return { ...p, log: candidate };
  });
}

// Parse `ps`-style etime ("MM:SS", "HH:MM:SS", or "D-HH:MM:SS") to seconds.
// Used by the stuck heuristic; returns 0 on parse failure so a stuck
// session isn't incorrectly flagged due to a weird etime format.
function etimeToSeconds(etime) {
  if (!etime) return 0;
  const dayMatch = etime.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = etime;
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = dayMatch[2];
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return 0;
  return seconds + days * 86400;
}

// A peer is "stuck" when it's been running for a while but the log file
// is suspiciously empty and hasn't been touched recently. The 03:30:55Z
// zombie claude session that sat for 8 minutes with a 134-byte log
// after hitting "Not logged in" is the prototypical case.
function looksStuck(paired) {
  if (!paired.log) return false;
  const elapsedS = etimeToSeconds(paired.etime);
  const logIdleS = (Date.now() - paired.log.mtimeMs) / 1000;
  return elapsedS > 120 && paired.log.sizeBytes < 1024 && logIdleS > 60;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtAge(mtimeMs) {
  const ageS = Math.round((Date.now() - mtimeMs) / 1000);
  if (ageS < 60) return `${ageS}s ago`;
  const ageM = Math.round(ageS / 60);
  if (ageM < 60) return `${ageM}m ago`;
  return `${(ageM / 60).toFixed(1)}h ago`;
}

function render() {
  const now = isoNow();
  const peers = listPeerProcesses();
  // Pull a generous log window so we have enough candidates to pair AND
  // to show the "last 3" list, even if 2-3 processes are running.
  const logs = listRecentLogs(8);
  const paired = pairProcessToLog(peers, logs);

  const lines = [
    `<!-- freshness: 30s | last-touched: ${now} | owner: ai-coordinator -->`,
    "",
    "# AI Coordinator — Live Dashboard",
    "",
    `Updated: ${now} · refresh: open this in VSCode preview + run \`npm run ai:dashboard:watch\``,
    "",
    `## Running peer processes (${paired.length})`,
    "",
  ];

  if (paired.length === 0) {
    lines.push("_No peer processes running._", "");
  } else {
    lines.push("| pid | agent | elapsed | log file | log size | status |");
    lines.push("|---|---|---|---|---|---|");
    for (const p of paired) {
      const logCell = p.log
        ? `\`ai/peer-sessions/${p.log.name}\``
        : "_unknown_";
      const sizeCell = p.log ? fmtSize(p.log.sizeBytes) : "—";
      const stuck = looksStuck(p);
      const statusCell = stuck
        ? "⚠ stuck? (idle, tiny log, elapsed>2m — check auth?)"
        : "running";
      lines.push(
        `| ${p.pid} | ${p.agent} | ${p.etime} | ${logCell} | ${sizeCell} | ${statusCell} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    `## Recent peer-session logs (last ${Math.min(3, logs.length)} by mtime)`,
    "",
  );
  if (logs.length === 0) {
    lines.push("_No peer-session logs yet._");
  } else {
    for (const log of logs.slice(0, 3)) {
      lines.push(
        `- \`${log.name}\` · ${fmtSize(log.sizeBytes)} · ${fmtAge(log.mtimeMs)}`,
      );
    }
  }
  lines.push("");

  mkdirSync(join(ROOT, "ai"), { recursive: true });
  writeFileSync(DASHBOARD_PATH, lines.join("\n"), "utf8");
}

if (watchFlag) {
  render();
  process.stdout.write(
    `[ai:dashboard] watching ai/dashboard.md, refresh every ${intervalMs / 1000}s. Ctrl-C to stop.\n`,
  );
  setInterval(render, intervalMs);
} else {
  render();
  process.stdout.write(`[ai:dashboard] wrote ai/dashboard.md at ${isoNow()}.\n`);
}
