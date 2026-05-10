# Effect audit

This is the reliability map for card effects. The goal is not to prove every
card is perfect in one document; it is to make effect coverage explicit enough
that new attack, ability, and Trainer effect kinds cannot quietly enter the
engine without a coverage decision.

## Current inventory

The guard test in
[effectAuditCoverage.test.ts](../src/engine/__tests__/effectAuditCoverage.test.ts)
extracts the implemented effect-kind unions from source and compares them to
this audited baseline:

| Surface | Source | Count | Inventory hash |
| --- | --- | ---: | --- |
| Attack effects | `src/engine/types.ts` `AttackEffect` | 306 | `11de4a1df0a3c0b1` |
| Ability effects | `src/engine/types.ts` `AbilityEffect` | 68 | `3c6119c0c8e1b247` |
| Trainer effects | `src/engine/trainerEffects.ts` `TrainerEffectId` | 162 | `16e315fe6c79e542` |

If a new effect kind is added, update this table and add or update the
appropriate coverage row below. A count/hash-only update is a smell unless the
new kind is intentionally documentation-only or aliases an already-covered
production path.

## Required coverage tiers

- **T0 detection**: card text/data maps to the intended effect kind.
- **T1 behavior pin**: production action opens the expected picker or mutates
  zones, flags, damage, logs, and turn state as expected.
- **T2 integration**: the effect runs through the real pipeline that players
  use, including damage ordering, KOs/prizes, continuation callbacks, and
  promotion queues where relevant.
- **T3 automation**: AI auto-resolution and replay command coverage exist for
  effects with prompts, randomness, or multi-step choices.
- **T4 UI smoke**: only for effects whose correctness depends on a visible UI
  picker, disabled action, or target affordance.

## Risk tiers

Use the highest applicable tier when deciding how much coverage a kind needs.

| Risk | Applies to | Minimum coverage |
| --- | --- | --- |
| Critical | Damage math, Weakness/Resistance, KOs, prize flow, game-over, promotion queues | T0 + T1 + T2 |
| High | Human pickers, AI choices, replay commands, RNG, undo-sensitive shuffles | T0 + T1 + T3 |
| Medium | Zone moves, draw/discard/recover/search, turn locks, once-per-turn gates | T0 + T1 |
| Low | Informational reveals, pure logs, display-only notices | T0 or explicit documented deferral |

## Coverage map

These rows name the effect families rather than every card printing. Tests may
cover multiple kinds at once; the important thing is that each high-risk family
has a named regression home.

| Family | Representative kinds/cards | Current coverage | Next hardening |
| --- | --- | --- | --- |
| Attack damage ordering | `per*` damage, `flip*Bonus`, attacker passives, Weakness, Resistance, defender reductions | `weakness.test.ts`, `findingsGaps.test.ts`, `ongoingEffects.test.ts` | Add more golden pipeline cases when new damage modifiers land. |
| Bench/spread/counter placement | `benchSnipe`, `snipeOne`, `distributeDamage`, `placeCounters*`, Tera bench immunity | `phantomDiveHuman.test.ts`, `lucarioDeckFixes.test.ts`, `communityDeckLowFixes.test.ts`, `EFFECTS.md` Tera notes | Ensure every new bench-damage kind states whether W/R applies. |
| Attack continuations | `bothActiveKnockedOut`, `selfSwitch`, `switchOutOpponent`, `selfCantUseAttack*`, Festival Lead second attack | `findingsGaps.test.ts`, `integration.test.ts`, `attackPreflight.test.ts` | Add replay round-trips for continuation-heavy attacks once replay playback grows. |
| Attack search/attach/recovery | `searchDeckAttack`, `callForFamily`, `attachNFromDiscard*`, `recoverPokemon*` | `prompts.test.ts`, card-specific tests, pending-pick command guard | Prefer prefabs or shared pending builders for new search/attach variants. |
| Ability activation gates | once-per-turn, phase, ability suppression, Damp/self-KO blocking, conditions | `preflightContract.test.ts`, `abilityDetection.test.ts` | Every new gate should route through `precheckAbility`. |
| Ability interactive effects | `moveDamageOwnToOpp`, `putCountersOnOppThenSelfKO`, `attachEnergyFromDiscardToBench`, gust/switch abilities | `mvpPickers.test.ts`, `prompts.test.ts`, card-specific suites | Require AI auto-resolution tests for new ability pickers. |
| Trainer search/recovery prefabs | Buddy-Buddy Poffin, Energy Search, Lana's Aid, Nest Ball, Poké Ball, Night Stretcher | `prefabBehavior.test.ts` | Migrate only after pre-migration behavior pins pass. |
| Trainer multi-step chains | Dawn, Hilda, Colress's Tenacity, Secret Box, Larry's Skill, Perrin | `dawnChain.test.ts`, `prompts.test.ts`, `replay.test.ts` prompt-command guard | Add replay/load tests once full prompt playback UI exists. |
| Trainer target pickers | Boss/gust, Potion/Super Potion, Energy Switch, Tool Scrapper, Wondrous Patch, Heavy Baton | `mvpPickers.test.ts`, `preflightContract.test.ts` | New picker fields must add `PendingPrompt` + `GameCommand` coverage. |
| Stadium activated effects | Postwick, Spikemuth Gym, activated Stadium framework | `preflightContract.test.ts`, stadium-specific card tests | Every activated Stadium should use `precheckStadium`. |
| Tools and passive hooks | damage boosters, HP modifiers, retreat modifiers, on-damage tools, KO-trigger tools | `ongoingEffects.test.ts`, `findingsGaps.test.ts`, card-specific tests | Add T2 integration for any new on-damage or KO-trigger tool. |
| RNG effects | coin flips, random discard, shuffles, top/bottom deck reveal | `undoRng.test.ts`, `undoIntegration.test.ts`, card-specific suites | Every new RNG effect must consume `state.rng` and get a replay/undo assertion. |
| AI/evaluator parity | `estimateAttackDamage`, archetype playbooks, attack scoring | `ongoingEffects.test.ts`, `aiScenarios.test.ts`, `mcts.test.ts` | Any actual damage change should check estimator parity. |

## New effect checklist

1. Add the effect kind and implementation.
2. Add or update T0 detection coverage.
3. Add the minimum behavior/integration tier from the risk table.
4. For prompts, update `PendingPrompt`, `GameCommand`, human resolution, and AI
   auto-resolution in the same PR.
5. For randomness, prove seed/undo/replay determinism.
6. Update the inventory count/hash above and the guard test constants.
7. Link the regression test in `docs/EFFECTS.md` or this audit map.
