#!/usr/bin/env node
// npm run ai:handoff -- --agent codex --re "phase 3A" "body of the message"
//
// Append a Schema A handoff block to ai/inbox.md. Includes:
//   - ISO timestamp + agent tag (per the v2 stamping convention)
//   - git status --short snapshot so the receiver sees uncommitted state
//   - last QA.md block timestamp so they can cross-reference verification
//   - the message body the caller supplied
//
// Schema A header matches digest.mjs's inbox block format, so a single
// `^## ` split parses both.
//
// Auto-review: after appending a handoff, optionally invokes the peer agent
// once in headless mode. Codex handoffs launch Claude; Claude handoffs launch
// Codex. Guarded by AI_CHAIN_DEPTH to avoid loops. Disable per-call with
// --no-chain; disable globally with AI_AUTO_REVIEW=0.

import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const ROOT = process.cwd();
const INBOX_PATH = join(ROOT, "ai", "inbox.md");
const QA_PATH = join(ROOT, "ai", "QA.md");

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function argFlag(name) {
  return process.argv.includes(name);
}

function positionalArgs() {
  // Skip "node script.mjs" + any -- separators + recognized flag pairs +
  // standalone flags.
  const FLAG_PAIRS = new Set(["--agent", "--re"]);
  const STANDALONE_FLAGS = new Set(["--no-chain"]);
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--") continue;
    if (FLAG_PAIRS.has(arg)) {
      i++;
      continue;
    }
    if (STANDALONE_FLAGS.has(arg)) continue;
    out.push(arg);
  }
  return out;
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").replace(/[\r\n]+$/, "");
}

function lastQaTimestamp() {
  if (!existsSync(QA_PATH)) return null;
  const text = readFileSync(QA_PATH, "utf8");
  const matches = text.match(/^## (\S+) \[/gm);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const m = last.match(/^## (\S+) \[/);
  return m ? m[1] : null;
}

function ensureFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) appendFileSync(path, "");
}

function resolveClaudeCommand() {
  if (process.env.CLAUDE_CLI_PATH && existsSync(process.env.CLAUDE_CLI_PATH)) {
    return process.env.CLAUDE_CLI_PATH;
  }
  if (existsSync("/opt/homebrew/bin/claude")) return "/opt/homebrew/bin/claude";
  if (existsSync("/usr/local/bin/claude")) return "/usr/local/bin/claude";
  return "claude";
}

function resolveCodexCommand() {
  if (process.env.CODEX_CLI_PATH && existsSync(process.env.CODEX_CLI_PATH)) {
    return process.env.CODEX_CLI_PATH;
  }

  const home = process.env.HOME;
  if (home) {
    const extensionRoot = join(home, ".vscode", "extensions");
    try {
      const candidates = readdirSync(extensionRoot)
        .filter((name) => name.startsWith("openai.chatgpt-"))
        .sort()
        .reverse()
        .map((name) => join(extensionRoot, name, "bin", "macos-aarch64", "codex"));
      const extensionCodex = candidates.find((path) => existsSync(path));
      if (extensionCodex) return extensionCodex;
    } catch {
      // Fall through to common install locations / PATH lookup below.
    }

    const userLocal = join(home, ".local", "bin", "codex");
    if (existsSync(userLocal)) return userLocal;
  }

  if (existsSync("/opt/homebrew/bin/codex")) return "/opt/homebrew/bin/codex";
  if (existsSync("/usr/local/bin/codex")) return "/usr/local/bin/codex";
  return "codex";
}

function buildPeerReviewPrompt(fromAgent, stamp, re) {
  const peer = fromAgent === "codex" ? "Claude" : "Codex";
  // Detect implementation handoffs from the re: subject. When the handoff
  // says "queue X" / "kickoff Y" / "implement Z" / "pickup", the peer
  // should DO the work, not write a review note. Without this distinction
  // the auto-prompt's default "review pass" framing causes the chain to
  // stall: peer reviews → no implementation → next handoff repeats.
  const isImplementationRequest = /\b(queue|kickoff|pickup|implement|claim|next phase|complete; queue)\b/i.test(re);

  if (isImplementationRequest) {
    return [
      `${fromAgent} just handed off implementation work via ai/inbox.md (timestamp ${stamp}, re: ${re}).`,
      "Run `npm run ai:session-start --silent` to see the current coordination context.",
      "Read the most recent inbox handoff for the implementation spec.",
      "If a TODO line is claimed for you with a timestamp matching this handoff's stamp, that IS your work — implement it.",
      "Do NOT default to a review pass when a freshly-claimed implementation phase exists for you.",
      "When work is complete and verified (typecheck + relevant tests), send the completion handoff via `npm run ai:handoff` so the next round can fire.",
      "If you find a blocker, write a focused rework handoff with `--no-chain` so the loop doesn't recurse.",
      `You are the auto-invoked implementer (${peer}) for this one-shot chain.`,
    ].join(" ");
  }

  return [
    `${fromAgent} just handed off via ai/inbox.md (timestamp ${stamp}, re: ${re}).`,
    "Run `npm run ai:session-start --silent` to see the current coordination context.",
    "Review the most recent handoff against ai/TODO.md and the current git diff.",
    "If the handoff is good, queue or claim the next appropriate phase via ai/TODO.md and/or `npm run ai:handoff`.",
    "If there are issues, write a focused rework handoff explaining exactly what must change.",
    "Keep this as a review / coordination pass.",
    `You are the auto-invoked peer reviewer (${peer}) for this one-shot chain.`,
  ].join(" ");
}

function claudeIsAuthenticated(command) {
  const result = spawnSync(command, ["auth", "status"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return false;
  try {
    const status = JSON.parse(result.stdout || "{}");
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

function codexIsAuthenticated(command) {
  const result = spawnSync(command, ["login", "status"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return false;
  // Codex's `login status` writes "Logged in using ChatGPT" to stderr,
  // not stdout. Check both streams so the auth check doesn't false-negative
  // on an authenticated CLI.
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /logged in/i.test(combined);
}

function maybeRunAutoReview(fromAgent, stamp, re) {
  if (argFlag("--no-chain")) {
    console.log("[ai:handoff] auto-review disabled via --no-chain.");
    return;
  }
  if (process.env.AI_AUTO_REVIEW === "0") {
    console.log("[ai:handoff] auto-review disabled via AI_AUTO_REVIEW=0.");
    return;
  }

  // Chain depth guard. Each hop increments AI_CHAIN_DEPTH so a runaway
  // loop (claude→claude→...) terminates. The default cap of 13 allows
  // ~6 full round-trips of work — enough to auto-advance multiple
  // build/test/review phases before stopping for human inspection.
  // Lower via AI_CHAIN_DEPTH_LIMIT env var; set to 1 to revert to
  // single-hop behavior.
  const depthLimit = Number(process.env.AI_CHAIN_DEPTH_LIMIT ?? "13");
  const depth = Number(process.env.AI_CHAIN_DEPTH ?? "0");
  if (!Number.isFinite(depth) || depth >= depthLimit) {
    console.log(`[ai:handoff] auto-review skipped at AI_CHAIN_DEPTH=${process.env.AI_CHAIN_DEPTH ?? "0"} (limit=${depthLimit}).`);
    return;
  }

  const prompt = buildPeerReviewPrompt(fromAgent, stamp, re);
  const env = {
    ...process.env,
    AI_CHAIN_DEPTH: String(depth + 1),
  };

  let command = null;
  let args = [];
  if (fromAgent === "codex") {
    command = resolveClaudeCommand();
    args = ["-p", prompt];
    if (!claudeIsAuthenticated(command)) {
      console.error(
        `[ai:handoff] auto-review skipped: Claude CLI is not logged in. Run \`${command} auth login\`, verify with \`${command} auth status\`, then retry the handoff.`,
      );
      return;
    }
  } else if (fromAgent === "claude") {
    command = resolveCodexCommand();
    if (!codexIsAuthenticated(command)) {
      console.error(
        `[ai:handoff] auto-review skipped: Codex CLI is not logged in. Run \`${command} login\` or \`${command} login --device-auth\`, verify with \`${command} login status\`, then retry the handoff.`,
      );
      return;
    }
    // Sandbox = danger-full-access so the chain-fired codex can read Claude's
    // credential files (~/.claude/, ~/Library/Application Support/Claude/) when
    // it tries to spawn `claude -p` for the next review round. workspace-write
    // blocks reads outside the repo, which caused codex→claude chain-fires to
    // bail with "Claude CLI is not logged in" even when claude was authenticated.
    // Trusted-local-only: this is fine for chain-fire because the prompt comes
    // from handoff.mjs (not arbitrary user input). Override the default with
    // AI_CODEX_SANDBOX env var (e.g. "workspace-write" to revert).
    const codexSandbox = process.env.AI_CODEX_SANDBOX || "danger-full-access";
    args = [
      "--ask-for-approval", "never",
      "exec",
      "-C", ROOT,
      "--sandbox", codexSandbox,
      prompt,
    ];
  } else {
    console.log(`[ai:handoff] auto-review skipped for unrecognized agent "${fromAgent}".`);
    return;
  }

  // Fire-and-forget so the caller (Claude or Codex) isn't blocked for the
  // duration of the peer's session. The peer runs detached and writes its
  // stdout/stderr to a per-session log under ai/peer-sessions/ so the user
  // can tail it from another terminal if they want to watch live.
  const peerName = fromAgent === "codex" ? "claude" : "codex";
  const logsDir = join(ROOT, "ai", "peer-sessions");
  mkdirSync(logsDir, { recursive: true });
  const safeStamp = stamp.replace(/[:.]/g, "-");
  const logPath = join(logsDir, `${peerName}-${safeStamp}.log`);
  let logFd;
  try {
    logFd = openSync(logPath, "a");
  } catch (err) {
    console.error(`[ai:handoff] auto-review failed to open log ${logPath}: ${err.message}`);
    return;
  }
  appendFileSync(logFd, `[ai:handoff] auto-review starting peer=${peerName} cmd=${command} at ${isoNow()}\n`);

  console.log(`[ai:handoff] auto-review: launching ${peerName} for ${fromAgent} handoff.`);
  try {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    const relLog = logPath.replace(`${ROOT}/`, "");
    console.log(`[ai:handoff] auto-review: ${peerName} pid ${child.pid}, log ${relLog}.`);
  } catch (err) {
    console.error(`[ai:handoff] auto-review failed to launch ${command}: ${err.message}`);
  }
}

const agent = argValue("--agent") || process.env.AI_AGENT || "unknown";
const re = argValue("--re") || "handoff";
const body = positionalArgs().join(" ").trim();

if (!body) {
  console.error(
    `[ai:handoff] usage: npm run ai:handoff -- --agent <name> --re "<subject>" "<message>"`,
  );
  process.exit(2);
}

const stamp = isoNow();
const titleSource = body.split(/\r?\n/, 1)[0].slice(0, 80);
const title = titleSource || "handoff";
const gitStatus = git(["status", "--short"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const lastQa = lastQaTimestamp();

const lines = [
  `## ${stamp} [${agent}] handoff: ${title}`,
  "",
  "**Status:** open",
  `**Re:** ${re}`,
  "",
  body,
  "",
  `- branch: ${branch || "(unknown)"}`,
];
if (lastQa) lines.push(`- last verification: ai/QA.md @ ${lastQa}`);
else lines.push("- last verification: (no QA.md entries yet)");
if (gitStatus) {
  lines.push("", "<details><summary>git status --short</summary>", "", "```text");
  lines.push(gitStatus);
  lines.push("```", "", "</details>");
} else {
  lines.push("- working tree: clean");
}
lines.push("", "---", "");

ensureFile(INBOX_PATH);
appendFileSync(INBOX_PATH, lines.join("\n"), "utf8");
console.log(`[ai:handoff] appended ai/inbox.md (${stamp} [${agent}] re: ${re}).`);
maybeRunAutoReview(agent, stamp, re);
