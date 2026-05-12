# PandaBananasTCG Refactor Plan

Reviewer input: Grok/xAI review, May 2026
Codex notes added from local repo inspection, May 2026
Status as of 2026-05-12: Items 1-4 landed in `pandabananastcg`; deferred items move forward in `/Users/tweed/.claude/plans/review-these-recommendations-from-ethereal-donut.md`

## Status

| Item | Status |
| --- | --- |
| Root README rewrite | ✅ Landed (`pandabananastcg`, commit 63f0c88) |
| `AI_CONFIG` extraction in `src/engine/aiConfig.ts` | ✅ Landed (commit ade330a) |
| `types.ts` split into `types/{cards,effects,pending,core}` behind barrel | ✅ Landed (commit 3f02176) |
| JSDoc on load-bearing public exports (rules / actions / effects) | ✅ Partial (~13 exports, commit 58d9072) |
| Branch strategy PR `pandabananastcg` → `main` (with Amplify check) | ⏳ Deferred — Stage 4A of `~/.claude/plans/review-these-recommendations-from-ethereal-donut.md` |
| `rules.ts` / `actions.ts` internal-module splits | ⏳ Deferred — Stage 5 of the same plan |
| `effects.ts` / `trainerEffects.ts` mechanical extraction | ⏳ Deferred — Stage 6A/6B (not in Codex's original review; surfaced by reviewer audit) |
| `ai.ts` mechanical extraction | ⏳ Deferred — Stage 6C |
| JSDoc sweep completion | ⏳ Deferred — Stage 7 |

## Purpose

This document captures the proposed repo-health, documentation, and engine
refactor work for TCGVibes / PandaBananasTCG. It is intended as a future
reference for Codex, Claude, or another engineer before implementation begins.

The current working branch is `pandabananastcg`. Local inspection confirmed
that `main` is still the sparse initial commit, while active development lives
on `pandabananastcg`.

## Summary

Implement the review as a staged, behavior-preserving cleanup:

- Improve public repo onboarding through a real root README.
- Prepare `pandabananastcg` to merge into `main`.
- Split oversized engine type modules behind compatibility barrels.
- Centralize AI/MCTS tunables without changing default behavior.
- Add targeted public API docs for mutation-heavy engine functions.

The implementation should avoid gameplay behavior changes except where needed
to preserve existing behavior after refactors.

## Current Repo Findings

- `README.md` currently contains only `# PandaBananasTCG`.
- `src/engine/types.ts` is about 105 kB.
- `src/engine/ai.ts` is about 157 kB.
- `src/engine/actions.ts` is about 60 kB.
- `src/engine/rules.ts` is about 53 kB.
- Most engine and test modules import types through `./types` or `../types`,
  so a barrel-preserving type split is feasible without broad consumer churn.
- Existing dirty files should be treated as user-owned and not reverted.

## Branch Strategy

Preferred path: merge `pandabananastcg` into `main` through a PR.

Implementation notes:

- Keep `pandabananastcg` as the active working branch during cleanup.
- Open a PR from `pandabananastcg` into `main` after the refactor/docs work is
  green.
- Verify Amplify branch settings before or during merge, since deploy config
  may currently assume a specific branch.
- Add a README note describing the active development branch until the merge is
  complete.

## README Improvements

Rewrite the root `README.md` with:

- One-paragraph elevator pitch.
- Tech stack table.
- Quick start: `npm install && npm run dev`.
- Common commands: `typecheck`, `test`, `e2e`, `build`.
- Links to `docs/`, `CLAUDE.md`, and `agents.md`.
- Badges for TypeScript, React, Capacitor, and Playwright.
- Screenshot/GIF placeholders using stable future paths, such as:
  - `docs/assets/gameplay-desktop.png`
  - `docs/assets/ai-match.gif`
  - `docs/assets/mobile-board.png`

Do not block this pass on capturing real screenshots. Placeholders are the
chosen default.

## Engine Type Split

Split `src/engine/types.ts` into a `src/engine/types/` directory while keeping
`src/engine/types.ts` as a compatibility barrel.

Proposed modules:

- `src/engine/types/cards.ts`
  - `EnergyType`
  - `Supertype`
  - `Attack`
  - `Ability`
  - `WeaknessResistance`
  - `Card`, `PokemonCard`, `EnergyCard`, `TrainerCard`
  - card-facing basic status aliases when needed
- `src/engine/types/effects.ts`
  - `AttackEffect`
  - `AbilityEffect`
  - `PokemonFilter`
  - `AttackSearchFilter`
  - `AttackPredicate`
  - `AbilityCondition`
- `src/engine/types/core.ts`
  - `PokemonInPlay`
  - `PlayerId`
  - `PlayerState`
  - `GameState`
  - `Phase`
  - `StatusCondition`
  - `TurnAttackBonus`
  - `TurnDamageReduction`
  - `StadiumInPlay`
  - `CoinFlipState`
  - `LogEntry`
  - `GameRng`
- `src/engine/types/pending.ts`
  - `PendingPick`
  - `PendingPickFallback`
  - `PendingPickEffectKind`
  - `PendingChoiceMenu`
  - `PendingChoiceMenuEffectKind`
  - `PendingHandReveal`
  - `PendingInPlayTarget`
  - `PendingSearchNotice`
  - `DeckSearchChainStep`
- `src/engine/types/ai.ts`
  - AI-only types only if they can be separated without creating awkward cycles.

Compatibility rule:

- Existing imports from `src/engine/types`, `./types`, and `../types` must keep
  working.
- Use type-only imports between split modules where possible.
- Run `npm run typecheck` immediately after this step before touching other
  refactors.

## Actions And Rules Split

Only start this after the type split is green.

For `rules.ts`:

- Extract focused internal modules for energy, status/checkup, and prize/KO
  logic.
- Preserve public exports from `rules.ts`, including:
  - `setupGame`
  - `resolveCoinGuess`
  - `chooseFirstPlayer`
  - `completeSetup`
  - `canPayCost`
  - `applyEvolveSideEffects`
  - `pokemonCheckup`
  - `knockOut`
  - `setPendingPromote`
  - `startTurnDraw`
  - `endTurn`
  - `passTurn`

For `actions.ts`:

- Extract attack pipeline internals into an internal attack module.
- Consider later extraction of stadium/tool/special-condition helpers, but keep
  the first pass narrow.
- Preserve public exports from `actions.ts`, including:
  - `playBasicToBench`
  - `evolve`
  - `attachEnergy`
  - `playTrainer`
  - `retreat`
  - `promoteBenchToActive`
  - `attackPreflight`
  - `attack`
  - `resumeDamageScalingAttack`
  - `resumeSecondAttack`
  - action-layer `endTurn`

Do not change UI or test import paths unless a cycle forces it.

## AI Config Polish

Add `src/engine/aiConfig.ts` to centralize tunables.

Suggested shape:

```ts
export const AI_CONFIG = {
  mctsProgressiveWideningTopK: 8,
  rolloutDepth: 3,
  endgameBudgetMultiplier: 4,
  debugMode: false,
} as const;
```

Important behavior guardrails:

- Do not enable MCTS by default.
- Preserve existing per-player `mctsBudgetMs` behavior.
- Replace inline constants only where doing so is behavior-preserving.
- Keep benchmark-only or test-only knobs out of production config unless they
  already affect production paths.

## Documentation And Maintainability

Add JSDoc to exported functions in:

- `src/engine/rules.ts`
- `src/engine/actions.ts`
- `src/engine/effects.ts`

Prioritize comments that clarify:

- mutation behavior
- phase requirements
- rule ordering
- pending picker side effects
- attack pipeline ordering
- public API contracts used by UI, AI, tests, or replay

Avoid restating obvious parameter names.

## Test Plan

After the type split:

```bash
npm run typecheck
```

After action/rules extraction:

```bash
npm run typecheck
npm run test
```

Before opening the PR into `main`:

```bash
npm run build
```

Run Playwright if UI boot, action bar, modal, or board behavior changes:

```bash
npm run e2e
```

## Assumptions

- Refactors are structural only.
- Any test failure caused by the refactor should be treated as a regression.
- Dirty local files that are unrelated to this work should not be reverted.
- README media placeholders are acceptable for the first documentation pass.
- The branch strategy is PR-based merge into `main`, not merely documenting the
  branch split.
