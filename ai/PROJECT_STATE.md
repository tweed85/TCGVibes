<!-- freshness: 24h | last-touched: 2026-05-11T01:16:31Z | owner: codex -->

# Project State

## Current Snapshot

- Project: `PandaBananasTCG`, a Vite + React + TypeScript Pokemon TCG simulator.
- Main active workstream: CPU AI quality and multi-agent coordination.
- Code and tests remain the source of truth; `/docs` holds durable plans; `/ai` holds coordination state.

## AI Milestone Status

| Phase | Status | Notes |
|---|---|---|
| Phase 0 | Complete | 11 picker lanes covered; Glass Trumpet and Grand Tree picker bugs fixed; Stadium activation reachable in CPU turn loop and MCTS; Forest of Vitality replacement logic for v2 Arboliva. |
| Phase 1 | Complete | `aiDecisionQuality.test.ts` is green; Unfair Stamp timing and spread-aware bench discipline landed. |
| Phase 2A | Complete | `scorePosition` parity-extracted into named sub-scores with load-bearing constants. |
| Phase 2B | Complete | Targeted v2 overlays landed for immediate threats and attack readiness. |
| Phase 3A | Next | Immediate-win sequencing before setup/search/benching. |

## Latest Known Verification

- `npm run typecheck`: reported clean after Phase 2B.
- `npm run test`: reported `901 passed | 3 skipped` after Phase 2B.
- `AI_BENCH=quick npm run test -- src/engine/__tests__/aiBenchmark.test.ts`: reported `2 passed | 1 skipped`.

## Coordination Status

- `/ai/agent_recommendations.md` defines the multi-agent workflow.
- `scripts/ai-coordinator/digest.mjs` and `npm run ai:digest` have been added.
- `.claude/settings.json` has Claude Code hook recommendations.
- `.github/workflows/check.yml` runs typecheck and tests on push / PR.
