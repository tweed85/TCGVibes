<!-- freshness: 24h | last-touched: 2026-05-11T16:20:00Z | owner: claude -->

# Project State

## Current Snapshot

- Project: `PandaBananasTCG`, a Vite + React + TypeScript Pokemon TCG simulator.
- Main active workstream: **CPU AI build plan Phases 0-5 complete.** Phase 6 (replay-informed tuning) deferred until cloud-replay corpus exists.
- Code and tests remain the source of truth; `/docs` holds durable plans; `/ai` holds coordination state.
- Multi-agent coordinator (digest / handoff / dashboard / session-start) is wired and stable. Async chain-fire between Claude ↔ Codex runs end-to-end with auth pre-checks + per-session logs at `ai/peer-sessions/`.

## AI Milestone Status

| Phase | Status | Notes |
|---|---|---|
| Phase 0 | Complete | 11 picker lanes covered; Glass Trumpet and Grand Tree picker bugs fixed; Stadium activation reachable in CPU turn loop and MCTS; Forest of Vitality replacement logic for v2 Arboliva. |
| Phase 1 | Complete | `aiDecisionQuality.test.ts` green (49 scenarios); Unfair Stamp timing + spread-aware bench discipline landed. |
| Phase 2A | Complete | `scorePosition` parity-extracted into seven named sub-scores with load-bearing constants. |
| Phase 2B | Complete | Targeted v2 overlays landed for immediate threats + attack readiness. |
| Phase 3 | Complete | 3A immediate-win; 3B search-before-attach; 3C ability-before-Supporter; 3D ACE SPEC conservation gate; 3E candidate-generator refactor (`enumerateAiActionCandidates`, `CANDIDATE_BAND=10000`). |
| Phase 4 | Complete | All 12 archetype playbooks wired with T1-T3 `cardBonus` / `abilityBonus`. |
| Phase 5 | Complete | 7 target scorers: 5A bestGustTarget v2, 5B scoreEnergyTarget v2, 5C search-pick v2, 5D bench target v2, 5E pickBestEvolution v2, 5F attackValue v2, 5G placeCountersOnOppBenchAny v2. All gated to v2. |
| Phase 6 | Deferred | Replay-informed tuning, contingent on cloud-replay corpus. |
| Phases 2c, 2e | Subsumed | Delivered by Phase 3E candidate-generator refactor. |

## Latest Known Verification

- `npm run typecheck`: clean after Phase 5G.
- `npm run test`: `938 passed | 3 skipped` after Phase 5G.
- `AI_BENCH=quick npm run test -- src/engine/__tests__/aiBenchmark.test.ts`: `2 passed | 1 skipped`.
- `aiDecisionQuality.test.ts`: 49 scenarios green, no `it.fails`.

## Coordination Status

- `/ai/agent_recommendations.md` defines the multi-agent workflow.
- `scripts/ai-coordinator/digest.mjs` + `npm run ai:digest` (Stop hook).
- `scripts/ai-coordinator/handoff.mjs` + `npm run ai:handoff` (async chain-fire with `AI_CHAIN_DEPTH_LIMIT=13`, sandbox `danger-full-access` for codex).
- `scripts/ai-coordinator/dashboard.mjs` + `npm run ai:dashboard` / `:watch` (live peer-process visibility, stuck-session heuristic, OpenClaw-cron false-positive filter).
- `scripts/ai-coordinator/session-start.mjs` (SessionStart hook).
- `.claude/settings.json` wires PostToolUse / Stop / SessionStart hooks.
- `.github/workflows/check.yml` runs typecheck + tests on push / PR.
