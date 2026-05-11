# Agent Recommendations

> Status: v2 (2026-05-10) — superset of v1. Replaces v1's advisory-only stance
> with parseable file schemas, concrete Claude Code hook config, an executable
> `npm run ai:digest` script, and a conflict-avoidance protocol that doesn't
> rely on human discipline alone.

## Recommended Ownership

### Claude

Claude owns the **planning, review, and synthesis lane**:

- Requirements clarification and implementation plans before large changes
- Architecture/risk review for engine, AI, replay, backend, and workflow changes
- Audit documents in `docs/*_AUDIT.md`, `docs/FINDINGS.md`, and project plans
- QA reasoning: expected behavior, edge cases, xfail accounting, acceptance criteria
- Handoff writing for Codex, including file paths, invariants, tests, and rollback notes
- Cross-agent summaries in `/ai/PROJECT_STATE.md`, `/ai/CONTEXT_SUMMARY.md`, `/ai/inbox.md`

Claude should generally avoid direct code edits unless a task is explicitly documentation-only or the user asks Claude to implement. Highest value: reducing ambiguity before code changes happen.

### Codex

Codex owns the **implementation and verification lane**:

- Code edits in `src/engine`, `src/data`, `src/ui`, `e2e`, `supabase`, and config files
- Refactors, test additions, bug fixes, and automation scripts
- Static inspection with `rg`, `git diff`, `npm run typecheck`, `npm run test`, and targeted suites
- Updating implementation-adjacent docs after code changes (especially `docs/AI_CPU_BUILD_PLAN.md`, `docs/TESTS.md`, `docs/REPLAY.md`)
- Producing concise status notes in `/ai/QA.md` and handoff replies in `/ai/inbox.md`

Codex should treat Claude plans as reviewable input, not authority. If local code disagrees with a plan, inspect the code and report the mismatch in `inbox.md` before editing.

### ChatGPT / User-Facing Coordinator

ChatGPT (or whichever LLM the user is talking to) owns coordination when both agents are involved:

- Decide which plan to execute next
- Ask for review of Claude or Codex outputs
- Approve risky automation or broad refactors
- Keep the product intent visible: playable Pokémon TCG simulator first, workflow machinery second

## Recommended File Structure

Use `/ai` for cross-agent coordination only. Source-of-truth technical docs stay in `/docs`.

```text
/ai
  PROJECT_STATE.md          # current snapshot (overwrite)
  TODO.md                   # prioritized queue (append-claim-update pattern)
  DECISIONS.md              # append-only decision log
  CONTEXT_SUMMARY.md        # compressed memory for handoff
  QA.md                     # append-only test/verification log
  inbox.md                  # append-only cross-agent messages
  agent_ownership.md        # stable ownership map (mostly static)
  trigger_rules.md          # hook + cron rules (folds in scheduled_tasks)
  agent_recommendations.md  # this file
  MULTI_AGENT_COLLABORATION_PROPOSAL.md
```

Durable plans (AI phases, replay design, card audits, backend setup) belong in `/docs`, not `/ai`. The `/ai/` directory is for coordination ephemera.

## File Schemas (parseable formats)

Every `/ai/` file follows one of three schemas so automation (`scripts/ai-coordinator/digest.mjs`) can read it without regex tricks.

### Schema A — append-only timestamped blocks (`QA.md`, `DECISIONS.md`, `inbox.md`)

```md
## 2026-05-10T22:14:00Z [claude] {short title}

**Status:** open | in-progress | resolved | informational
**Re:** {what this is about}

{body}

---
```

Rules:
- ISO 8601 UTC timestamp + agent tag in the H2 header.
- Three-dash separator between blocks (parseable boundary).
- Never edit a previous block. To revise, append a new block referencing the old by timestamp.

### Schema B — GitHub-flavor checklist (`TODO.md`)

```md
- [ ] [unowned] Phase 3A immediate-win sequencing — verify: `npm run test` + new scenarios in `aiDecisionQuality.test.ts`
- [ ] [claimed:codex:2026-05-10T22:14:00Z] Wire `scripts/ai-coordinator/digest.mjs` — verify: `npm run ai:digest`
- [x] [claude:2026-05-10T20:00:00Z] Phase 2B threat overlays — verified: `npm run test` 901 passed
```

Rules:
- One task per line.
- Owner tag immediately after the checkbox: `[unowned]`, `[claimed:agent:ISO]`, or `[agent:ISO]` for done items.
- The verification command is part of the task, not an afterthought.

### Schema C — frontmatter snapshot (`PROJECT_STATE.md`, `CONTEXT_SUMMARY.md`, `agent_ownership.md`)

```md
<!-- freshness: 24h | last-touched: 2026-05-10T22:14:00Z | owner: claude -->

# Project State

{free-form body, overwritten on each update}
```

The frontmatter line lets `digest.mjs` warn when a snapshot is staler than its SLA.

## Conflict Avoidance — Atomic Claim Protocol

The path-based ownership table (below) handles the common case. For TODO items that cross paths:

1. **Before starting**, edit the TODO line in place to add `[claimed:agent:ISO]`. Commit (or save) immediately.
2. **While working**, only that agent edits the claim's target files.
3. **On completion**, replace `[ ]` with `[x]` and the claim tag with `[agent:ISO]`.
4. **To re-claim** a claim < 1 hour old, the new agent must first post a handoff message in `inbox.md` referencing the original claim timestamp. Older claims may be re-claimed silently.

This is git-tracked, human-readable, survives crashes, and requires no daemon.

### Path-based ownership table (static)

| Path | Primary | Reviewer |
|------|---------|----------|
| `src/engine/**` | Codex | Claude (plan / risk) |
| `src/ui/**` + `src/App.tsx` | Codex | Claude (UX / risk) |
| `src/data/**` | Codex | Claude (data / modeling) |
| `docs/**` plans + audits | Claude | Codex (post-impl status) |
| `docs/**` implementation-status updates | Codex | Claude (correctness) |
| `/ai/**` | append-only by default | active coordinator only rewrites snapshots |
| `supabase/**` | Codex | Claude (privacy / security) |
| `scripts/**` (automation) | Codex | Claude (scope review) |

## Event-Driven Trigger Plan (executable)

Replaces v1's prose triggers with **actual hook configurations**. Two surfaces:

### Surface 1: Claude Code hooks (`.claude/settings.json`)

These fire when the Claude Code agent edits files. They run locally during the agent's turn, so feedback is in-context.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "filePaths": ["src/engine/**/*.ts", "src/data/**/*.ts"],
        "command": "npm run typecheck"
      },
      {
        "matcher": "Edit|Write",
        "filePaths": ["src/ui/**/*.tsx", "src/App.tsx"],
        "command": "npm run typecheck"
      }
    ],
    "Stop": [
      {
        "command": "npm run ai:digest"
      }
    ]
  }
}
```

- `PostToolUse` typecheck only — full test suite is too expensive for per-edit. The agent runs vitest manually at appropriate milestones.
- `Stop` digest emits a handoff candidate before the agent yields the turn.
- **Do not** add hooks for `supabase/**`, `data/pokemon/**` (large dataset), or generated Capacitor / iOS files.

### Surface 2: GitHub Action (`.github/workflows/check.yml`)

Cross-agent ground truth that doesn't require local runs. Any agent can quote the CI URL in `inbox.md` instead of re-running tests on their own machine.

```yaml
name: ai-coordinator
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test
```

Skip Playwright in CI initially — the smoke has a known mulligan-modal flake (see `docs/AUDIT_FIXES_REVIEW.md:25-27`). Add `npm run e2e` once stabilized.

### Surface 3: handoff peer auto-review (`scripts/ai-coordinator/handoff.mjs`)

`npm run ai:handoff` appends the Schema-A inbox block, then optionally launches
the peer agent for one headless review pass:

- `[codex]` handoffs spawn `claude -p "<review prompt>"`.
- `[claude]` handoffs spawn `codex --ask-for-approval never exec -C "$ROOT" --sandbox workspace-write "<review prompt>"`.
- CLI lookup honors `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH` first, then checks common install paths. For Codex it also discovers the VS Code ChatGPT extension binary under `~/.vscode/extensions/openai.chatgpt-*/bin/macos-aarch64/codex`, which covers shells where `codex` is not on `PATH`.
- Before launching, handoff preflights auth: `claude auth status` for Claude and `codex login status` for Codex. If either is logged out, the script skips the peer launch and prints the exact login command to run.
- `AI_AUTO_REVIEW=0` disables the launch and only writes the inbox block.
- `AI_CHAIN_DEPTH` caps chaining at one peer invocation, preventing Claude →
  Codex → Claude loops.

The auto-invoked peer should run `npm run ai:session-start`, inspect
`ai/inbox.md`, `ai/TODO.md`, and the diff, then either queue/claim the next
phase or write a rework handoff. It should not broaden into implementation
unless the handoff explicitly asks for that.

### Trigger policy

| Trigger | Action | Approval |
|---------|--------|----------|
| Edit/Write on `src/engine/**` | `npm run typecheck` via PostToolUse | automatic |
| Edit/Write on `src/ui/**` | `npm run typecheck` via PostToolUse | automatic |
| Agent session Stop | `npm run ai:digest` | automatic |
| `npm run ai:handoff -- --agent codex ...` | append inbox + launch Claude review unless disabled | automatic |
| `npm run ai:handoff -- --agent claude ...` | append inbox + launch Codex review unless disabled | automatic |
| `git push` | CI typecheck + test | automatic |
| `docs/AI_CPU_BUILD_PLAN.md` change | Manual: append PROJECT_STATE.md note | manual |
| `supabase/migrations/**` change | Manual SQL review; never auto-apply | manual |
| `data/pokemon/**` change | Manual: validate dataset version | manual |
| Dependency change | Manual `npm install` review | manual |
| Full `AI_BENCH=full` benchmark | Manual; PR-boundary only | manual |
| `git history` ops (rebase/reset) | Forbidden without explicit user approval | user-only |

## Implementation: `scripts/ai-coordinator/digest.mjs`

This is the single mechanical entry point both agents call. Ship it **first**, before seeding the markdown skeleton — without the script, the markdown is just paperwork.

Behavior spec:

1. Run `git diff --name-only HEAD~1..HEAD` (or `git status --short` if no commits since last digest).
2. Map changed paths to recommended checks using a static table:
   - `src/engine/**` → typecheck + vitest filter `engine`
   - `src/data/**` → typecheck + vitest filter `data`
   - `src/ui/**` + `src/App.tsx` → typecheck (e2e flag set if `App.tsx` action surface changed)
   - `supabase/**` → flag for manual review (no auto-run)
   - `docs/**` → no checks
   - `/ai/**` → no checks
3. Execute the checks; capture exit codes + last 30 lines of output.
4. Append a Schema-A block to `/ai/QA.md`:
   ```md
   ## 2026-05-10T22:14:00Z [codex] digest run

   **Status:** resolved
   **Re:** post-edit verification

   - changed: src/engine/ai.ts, src/engine/__tests__/aiScorePosition.test.ts
   - typecheck: ✅
   - vitest engine: ✅ 901 passed | 3 skipped
   - duration: 9.41s

   ---
   ```
5. Emit a one-line summary to stdout (so the calling agent / human sees it inline).

Expose via `package.json`:

```json
"scripts": {
  "ai:digest": "node scripts/ai-coordinator/digest.mjs"
}
```

The agent calling `npm run ai:digest` is identified via `--agent codex` / `--agent claude` flag (defaults to the user-set `AI_AGENT` env var, else `unknown`).

## Live dashboard: `scripts/ai-coordinator/dashboard.mjs`

Regenerates `ai/dashboard.md` to show **currently-running peer processes** (chain-fired codex / claude sessions) with their pid, elapsed time, log file path, and log size. Plus the three most recently modified peer-session logs.

Two refresh modes:

| Command | Behavior |
|---|---|
| `npm run ai:dashboard` | One-shot write, then exit. Fired automatically by the `Stop` hook after `ai:digest`. |
| `npm run ai:dashboard:watch` | Polls every 3 seconds (override: `npm run ai:dashboard:watch -- <seconds>`). Run in a dedicated terminal during active loop sessions. |

**Recommended viewing**: open `ai/dashboard.md` in VSCode's markdown preview pane (Cmd+Shift+V) — the preview auto-refreshes on file change, so the polling watch mode gives near-real-time visibility into peer-session lifecycles. Schema C frontmatter (freshness: 30s) means `digest.mjs` will warn if the file is left stale.

**Scope intentionally narrow**: peer-process status only. Phase progress, inbox tail, log-tail rendering are NOT shown — `ai:session-start` already surfaces inbox + actionable TODOs, and `ai/QA.md` carries the verification history. Add new sections inside `render()` if scope expands.

**Peer-process detection**: `ps -ax -o pid,etime,command` filtered for the `codex --ask-for-approval ... exec` and `claude -p|--print` cmdline shapes the chain-fire uses. The user-facing IDE Claude wrapper (different flag shape) is excluded. Each running peer is paired with its log file by reverse-chronological filename match within the same agent prefix.

## Scheduled Tasks (folded into trigger_rules)

Drop a separate `scheduled_tasks.md` — its entries are time-based triggers and belong alongside the file-based triggers above. The full schedule:

| Cadence | Task | Mechanism |
|---------|------|-----------|
| Per Edit/Write on src/** | typecheck | Claude Code `PostToolUse` hook |
| Per agent turn end | digest run | Claude Code `Stop` hook |
| Per push | typecheck + test | GitHub Action |
| Daily (if user active) | refresh `PROJECT_STATE.md` + `CONTEXT_SUMMARY.md` | manual or `/schedule` skill |
| Pre-broad-refactor | Claude plan + Codex inspection + user approval | manual ritual |
| Pre-merge to main | full `npm run e2e` + `AI_BENCH=quick` | manual or CI gate |

Avoid:
- "Every 15 minutes inbox check" — too noisy for a 1–2-agent workflow; replaced by claim/release + session-start inbox scan.
- Auto-applying migrations, auto-commits, auto-rebases, auto-history-edits.
- Auto-running long benchmarks every time AI files change.

## Memory System Reconciliation

Claude has a persistent memory system at `~/.claude/projects/-Users-tweed-Documents-TCGVibes/memory/` that already documents project layout and AI-refactor patterns. To avoid divergence with `/ai/CONTEXT_SUMMARY.md`:

- **`~/.claude/.../memory/` is Claude-internal.** Used for cross-session continuity *within Claude only*. Personal preferences, working agreements, lessons learned.
- **`/ai/CONTEXT_SUMMARY.md` is cross-agent.** Compressed factual project state any agent reads (Codex, ChatGPT, future tools). Single source of truth for "what's the current milestone."
- **When they conflict, code + tests win**, then `/docs/**`, then `/ai/CONTEXT_SUMMARY.md`, then Claude memory.

Claude's memory may reference `/ai/CONTEXT_SUMMARY.md` by path; the reverse is not required.

## Agent-Identity Stamping

Every append to `/ai/*` MUST begin with `[claude]`, `[codex]`, `[chatgpt]`, or `[user]` immediately after the timestamp. Without this, reply-to-inbox flows can't distinguish their own messages from peers.

Enforced by convention (and by `digest.mjs` warning when an append lacks the tag).

## Risks

- **Coordination files becoming stale.** Mitigation: `freshness` frontmatter + `digest.mjs` warning.
- **Hook storms.** Mitigation: scope `PostToolUse` to typecheck only; reserve test runs for explicit `ai:digest` or PR boundary.
- **Bot-only feedback loops.** Mitigation: keep `inbox.md` manual-write / manual-read; `digest` is the only auto-write.
- **Agents trusting docs over code.** Mitigation: code + tests are source of truth, always. `digest.mjs` re-derives state from `git diff`, not from `/ai/`.
- **Append-only files growing large.** Mitigation: daily/weekly compact into `CONTEXT_SUMMARY.md`; never delete the originals, archive under `/ai/archive/YYYY-MM.md`.
- **CI flakes leaking into QA.md.** Mitigation: tag known flakes with `flaky:` in the QA block so they don't pile up as "known failures."
- **Xfail tests forgotten.** Mitigation: `digest.mjs` warns when `it.fails` count > 0 and the file mtime is > 14 days old.

## First 5 Implementation Steps (re-sequenced)

The original v1 sequencing put the script as step 5. That was backwards — without the script, the markdown skeleton accumulates paperwork no one trusts. Reversed order:

1. **Add `scripts/ai-coordinator/digest.mjs` + `npm run ai:digest`** per the spec above. One PR, one new dir, one package.json edit. No `/ai/` writes from agents until this exists.

2. **Wire Claude Code hooks** in `.claude/settings.json` (`PostToolUse` typecheck, `Stop` digest). One PR, ~10 lines of JSON.

3. **Add the GitHub Action** at `.github/workflows/check.yml` (typecheck + test on push). One PR. Defer e2e until flake is fixed.

4. **Seed `/ai/PROJECT_STATE.md` + `/ai/agent_ownership.md`** using Schema C frontmatter. Reference the now-existing automation. One PR.

5. **Seed `/ai/TODO.md`** with the next 3–5 executable tasks in Schema B, including ownership tags. Examples to start with:
   - `[ ] [unowned] Phase 3A immediate-win sequencing — verify: new scenarios in aiDecisionQuality.test.ts`
   - `[ ] [unowned] Phase 4 archetype playbook: Dragapult — verify: archetype scenario test`
   - `[ ] [unowned] Stabilize Playwright mulligan-modal flake — verify: npm run e2e × 5 clean`

Steps 1–3 are mechanical and independent — can be parallel PRs. Step 4 depends on 1–3 landing. Step 5 depends on 4.

`DECISIONS.md`, `inbox.md`, and `CONTEXT_SUMMARY.md` get created lazily — on first use rather than during seeding. An empty file with just frontmatter is fine.
