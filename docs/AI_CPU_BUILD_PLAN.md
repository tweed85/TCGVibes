# CPU AI build plan

Audience: implementation agent working in this repo. Do not treat this as a
brainstorm. It is a phased build plan for making the CPU opponent a stronger,
less mistake-prone player while preserving deterministic engine behavior.

Start here, then read:

- `docs/AI.md`
- `docs/FINDINGS.md`
- `docs/ITEM_AUDIT.md`
- `docs/STADIUM_AUDIT.md`
- `docs/TOOL_AUDIT.md`
- `src/engine/ai.ts`
- `src/engine/aiArchetype.ts`

## Status snapshot (2026-05-11)

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0 — picker AI lanes + bug fixes | ✅ Complete | All 11 cards have explicit AI lanes; Glass Trumpet + Grand Tree picker bugs fixed; Stadium activation reaches both the normal CPU turn loop and MCTS; v2 Arboliva can replace its own non-Forest Stadium with Forest of Vitality when it unlocks a same-turn Grass evolution chain. |
| Phase 1 — `aiDecisionQuality.test.ts` | ✅ Complete | 9/9 scenarios green. Unfair Stamp timing wired in `scoreTrainerForNow` (KO gate + tiered opp-hand-size). Spread-aware bench discipline shipped as the first additive overlay. |
| Phase 2A — `scorePosition` parity extraction | ✅ Complete | Seven named sub-scores; load-bearing OHKO penalty/bonus constants extracted; `scoreBenchRisk` carries the first additive v2 overlay. Behavior preserved. |
| Phase 2B — sub-score overlays | ✅ Complete | `scoreImmediateThreats` overlays (game-losing escalator, bench-counter mitigation, game-winning escalator) + `scoreAttackReadiness` overlays (active-can-attack-now, evolution-in-hand unlocks attacker). All gated to v2. |
| Phase 3 — turn sequencing | ✅ Complete | 3A immediate-win; 3B search-before-attach hardening; 3C ability-before-Supporter; 3D ACE SPEC conservation gate; 3E candidate-generator refactor (`enumerateAiActionCandidates` returns ranked candidates with `CANDIDATE_BAND=10000` priority multiplier). |
| Phase 4 — archetype playbooks | ✅ Complete | All 12 archetypes wired with T1-T3 `cardBonus` / `abilityBonus`. Dragapult, Crustle, plus the remaining 10 (festival-leads, arboliva, alakazam, lucario-ex, rocket-mewtwo, cynthia-garchomp, grimmsnarl-froslass, mega-starmie-froslass, hops-trevenant). |
| Phase 5 — tactical micro-search | ✅ Complete | All 7 target scorers shipped: 5A bestGustTarget v2, 5B scoreEnergyTarget v2 (next-turn weighting), 5C search target v2 (evolution + energy-gap), 5D bench target v2, 5E pickBestEvolution v2 (ability-unlock bonuses), 5F attackValue v2 (mid-game OHKO + bench-readiness), 5G placeCountersOnOppBenchAny v2 (KO priority + prize value). All gated to v2 via `v2Active`. |
| Phase 6 — replay-informed tuning | ⏳ Deferred | Contingent on cloud-replay volume. |
| Phases 2c, 2e | ✅ Subsumed | Multi-action reordering + ability scoring tune both delivered by Phase 3E candidate-generator refactor. |

Test ledger after Phase 5G: **938 passed | 3 skipped** in `npm run test`
(49 scenarios green in `aiDecisionQuality.test.ts`), no `it.fails`.
Quick `aiBenchmark.test.ts` run passes; full benchmark not re-run at
every PR (see Phase 2 strategy note).

## Phase 3 decomposition (active queue)

Phase 3 spec ("improve turn sequencing") is too broad for one PR. The
sub-phases below ship independently; 3A–3D are mostly orthogonal, 3E
depends on the prior four because it's a structural refactor that
benefits from per-rule scenario tests already pinning correct order.

| Sub | Title | Touches | Depends on |
|-----|-------|---------|------------|
| 3A | Immediate-win sequencing | `tryStepAiTurn` early-out + scenarios | — |
| 3B | Search-before-attach hardening | item-pick step + Stadium-replacement ordering | 3A |
| 3C | Ability-before-Supporter ordering | scenario tests pinning current order | 3A |
| 3D | ACE SPEC conservation gate | `scoreTrainerForNow` ACE SPEC threshold | 3A |
| 3E | Candidate-generator refactor | replace fixed greedy step order with score-then-pick loop | 3A–3D |

## Phase 4 decomposition (queued)

| Sub | Title | Touches |
|-----|-------|---------|
| 4A | Dragapult playbook fields | `aiArchetype.ts` `dragapult-blaziken` + `dragapult-dudunsparce` profiles + scenario test |
| 4B | Crustle playbook fields | `aiArchetype.ts` `crustle` profile (wall-first plan) + scenario test |
| 4C | Remaining 10 playbook profiles | Festival Leads, Arboliva, Alakazam, Lucario, Rocket Mewtwo, Cynthia Garchomp, Grimmsnarl-Froslass, Mega Starmie-Froslass, Hops-Trevenant + scenario tests |

## Phase 5 decomposition (queued)

| Sub | Title |
|-----|-------|
| 5A | Gust target scorer rewrite (tighten `bestGustTarget`) |
| 5B | Energy attach scorer rewrite (`scoreEnergyTarget` next-turn weighting) |
| 5C | Search target scorer rewrite (deck-pick scoring with archetype context) |
| 5D | Bench target scorer (which Pokémon to bench, integrates with Phase 4) |
| 5E | Evolution target scorer (which line to evolve, integrates with Phase 4) |
| 5F | Attack choice scorer with full lookahead context |
| 5G | Spread/counter placement scorer (Phantom Dive / Cursed Drop targeting) |

## Goal

The CPU should feel like a competent pilot of its deck, not a generic
first-legal-choice bot. It should:

- choose meaningful targets instead of silently taking the first legal option
- sequence turns in a human-like order
- understand prize race and immediate win/loss threats
- attach Energy to attackers that matter
- use archetype-specific plans for curated decks
- stay deterministic by using `state.rng`, never `Math.random()`

Do not begin by adding broad MCTS or machine learning. The fastest quality gain
is better action choice, better scoring, and better archetype rules.

## Non-negotiable constraints

- Engine remains authoritative. AI calls public engine actions; it does not
  mutate game state directly except in existing AI resolver lanes.
- Gameplay randomness uses `state.rng`.
- Every new prompt/action kind must include:
  - `src/engine/gameCommands.ts` command + dispatcher support if humans can
    resolve it
  - an AI auto-resolution path or explicit AI bypass
  - replay prompt-command guard coverage
- Every AI behavior change gets at least one scenario test. Do not ship only
  snapshot-free heuristic edits.
- Keep v1 behavior stable unless the change is a bug fix. New strategy should
  be gated through existing v2 surfaces where possible.

## Phase 0 — unblock hidden choice quality — ✅ COMPLETE

**Landed:**
- Stable picker discriminant: `PendingPickEffectKind` on `PendingPick` /
  `PendingHandReveal` (`src/engine/types.ts`) so AI lanes route off
  `effectKind` / `action.kind` — never label text.
- Explicit AI scoring lanes for all 11 listed cards (see "AI lane spec"
  below for the per-card rules). Wired inline in each card's `if (pl.isAI)`
  branch in `trainerEffects.ts` / `stadiumActivated.ts`.
- Picker bug fixes:
  - **Glass Trumpet** — distinct-target enforcement (`pickedInstanceIds` on
    the action variant) plus `skipGlassTrumpetAttach` engine function +
    `GameCommand`. Action-bar Cancel routes through the skip so queued
    Energy returns to discard.
  - **Grand Tree** — shuffle-on-skip fix in `grandTreeApplyStage2`
    resolver; human single-basic case now routes through the chained
    picker so the optional Stage 2 prompt always appears.
- **Stadium activation reachable in normal CPU turn loop AND MCTS**:
  `src/engine/ai.ts` calls `useStadium` whenever
  `stadiumHasActivatedEffect(state.stadium.card.name)` returns true and
  precheck passes; `mcts.ts` enumerates `useStadium` as an action kind.
- **Forest of Vitality replacement logic**: v2 Arboliva can displace its
  own non-Forest Stadium when Forest of Vitality immediately unlocks a
  Grass evolution chain this turn
  (`forestOfVitalityUnlocksGrassEvolution`).

**Tests:** `src/engine/__tests__/aiPickerLanes.test.ts` (one scenario per
card) + regression tests in `mvpPickers.test.ts` (Glass Trumpet distinct
targets, Grand Tree per-player T1 + optional Stage 2). Replay
round-trip for `skipGlassTrumpetAttach` in `replay.test.ts`.

Reference spec preserved below (do not re-implement; this is the
historical scope).

Dependency: the audit-driven card-picker fixes.

The CPU cannot become reliably stronger while important cards still auto-pick
first legal targets for humans and AI. Implement the high-impact Item/Stadium
fixes first, and add deliberate AI choices for each new picker.

Minimum cards before deeper AI work:

- Prime Catcher
- Precious Trolley
- Energy Search Pro
- Glass Trumpet
- Scramble Switch
- Academy at Night
- Prism Tower
- Mystery Garden
- Levincia
- Surfing Beach
- Grand Tree

For every picker, AI behavior must be explicitly scored:

- Prime Catcher: prefer game-winning KO; then high-prize vulnerable attacker;
  then engine piece such as draw/ramp support.
- Precious Trolley: bench setup Basics that match the deck archetype; do not
  fill bench with low-value liabilities when bench is nearly full.
- Energy Search Pro: pick missing attack colors for current and next-turn
  attackers, not just one of every available type.
- Glass Trumpet: attach to Benched Colorless Pokémon closest to useful attacks.
- Scramble Switch: switch into the best attacker and move Energy only when it
  improves attack readiness or survival.
- Grand Tree: evolve the selected line that most improves board state this
  turn, preferring attackers or engine Pokémon over low-impact evolutions.

Tests:

- Add focused tests near `src/engine/__tests__/mvpPickers.test.ts`.
- Add at least one AI-path test per card where AI choice is nontrivial.

## Phase 1 — add AI decision-quality scenarios — ✅ COMPLETE

**Landed** (`src/engine/__tests__/aiDecisionQuality.test.ts`):

- 9 scenarios, all green. Public AI entrypoints only (`takeAiTurn`,
  `resolveAiPendingPromote`) — no imports of private scoring helpers.
  Deterministic IDs (module-level counter, no `Math.random()`).
- **Unfair Stamp timing** wired in `scoreTrainerForNow` case
  `"unfairStampShuffleDraw"`: KO gate respects engine, score scales
  with opp hand size (≥6 → 80, ≤2 → 5, 3–5 → 35 below Item threshold 40).
- **Spread-aware bench discipline** shipped as the first additive
  overlay (covered under Phase 2A — see `shouldBenchBasicNow` and
  `opponentHasBenchSpreadThreat`). Scenario #5 (don't over-bench a
  dead-weight Basic under spread pressure) + positive control (v2 AI
  still benches an evolution-base Basic under no spread pressure)
  both green.

Reference spec preserved below.

Create `src/engine/__tests__/aiDecisionQuality.test.ts`.

These tests should build small deterministic states and run the AI action that
is being tested. Keep each test narrow. Do not require a full 60-card game when
a shaped state is enough.

Required initial scenarios:

- AI uses gust (`Boss's Orders` / Prime Catcher once implemented) to take a
  game-winning KO instead of attacking the Active.
- AI does not use a gust effect when the Active already gives the same or
  better prize outcome.
- AI attaches Energy to the Pokémon closest to attacking next turn, not the
  first Pokémon in play.
- AI benches an archetype-critical Basic from a search effect before generic
  filler.
- AI uses `Unfair Stamp` only when its condition is legal and the disruption is
  useful.
- AI chooses a promotion target that can attack soon over a higher-HP target
  that cannot attack.
- AI avoids over-benching when the extra Basic has no clear setup value and the
  opponent has spread pressure.

Use existing helpers where possible:

- `setupGame`
- `playTrainerByName`
- `attachEnergyByName`
- `useAttackByName`
- `resolvePickByName`

If the DSL cannot express the state cleanly, shape the state directly in the
test, but keep all actual actions routed through production engine functions.

## Phase 2 — refactor scoring into named sub-scores

### Phase 2A — `scorePosition` parity extraction — ✅ COMPLETE

**Landed** (`src/engine/ai.ts`):

- `scorePosition` is now a terminal short-circuit + sum of seven named
  helpers: `scorePrizeRace`, `scoreImmediateThreats`,
  `scoreAttackReadiness`, `scoreBoardDevelopment`, `scoreResourceQuality`,
  `scoreBenchRisk`, `scoreDisruptionTiming`.
- Behavior parity preserved (verified by `aiBenchmark.test.ts` quick run
  + full suite holding green).
- Load-bearing constants extracted with provenance comment
  ("Load-bearing MCTS leaf-eval weights; change only with benchmark
  evidence."): `ACTIVE_OHKO_BASE_PENALTY = 60`,
  `ACTIVE_OHKO_PRIZE_PENALTY = 80`, `OPP_ACTIVE_OHKO_BASE_BONUS = 50`,
  `OPP_ACTIVE_OHKO_PRIZE_BONUS = 60`.
- **First additive v2 overlay shipped in `scoreBenchRisk`** —
  spread-aware bench-risk eval. Shared helpers
  (`opponentHasBenchSpreadThreat`, `hasEvolutionInLibrary`,
  `basicCouldAttackSoon`) feed both `scoreBenchRisk` (position penalty)
  and the new `shouldBenchBasicNow` gate at the bench-play call site,
  so leaf eval and greedy path can't drift. Detection uses resolved
  `AttackEffect[]` (`placeCountersOnOppBenchAny`, `placeCountersOnNOpp`,
  `snipeOne {benchOnly}`, `snipeOnePerEnergy`, `placeCounters
  {target: oppBench|anyOpp}`, `distributeDamage {benchOnly}`) — no
  text parsing.

**Parity tests:** `src/engine/__tests__/aiScorePosition.test.ts` (5
behavior-path tests covering won/lost terminal, prize-race gradient,
catastrophic-no-mons no-throw, v2 threat-aware scenario).

### Phase 2B — sub-score overlays — ⏭ NEXT RECOMMENDED

Now that the seams are in place, the next additive overlays land inside
the named helpers. The two highest-leverage targets:

1. **`scoreImmediateThreats`** — extend to detect:
   - opponent gust threat when our bench has un-shielded multi-prizers
     (gust + their best attack → 2-prize swing in our bench);
   - bench Pokémon already in OHKO range of opp's projected attack
     (Phantom Dive numbers, Sinistcha Cursed Drop scatter).
2. **`scoreAttackReadiness`** — extend to:
   - count attackers at cost-minus-one with a clearly accessible Energy
     (acceleration ability, basic in hand, search Trainer in hand);
   - reward "two ready attackers of complementary types" (handles weakness
     coverage in the leaf eval).

Test pattern: extend `aiScorePosition.test.ts` with focused parity +
overlay-gradient tests (same shape — public behavior paths only, no
private helper imports).

### Reference spec — original Phase 2

Current AI scoring is spread through `src/engine/ai.ts`. Refactor carefully.
Do not change behavior and refactor in the same commit unless the test pins
already prove the behavior.

Add or expose named scoring helpers in `ai.ts`:

- `scorePrizeRace(state, player)`
- `scoreImmediateThreats(state, player)`
- `scoreAttackReadiness(state, player)`
- `scoreBoardDevelopment(state, player)`
- `scoreResourceQuality(state, player)`
- `scoreBenchRisk(state, player)`
- `scoreDisruptionTiming(state, player)`

Expected signals:

- Prize race:
  - reward ability to take remaining prizes this turn
  - weight late prizes more than early prizes
  - penalize exposing multi-prize Pokémon that can be KO'd next turn
- Immediate threats:
  - detect opponent OHKO range on Active
  - detect ready bench attackers
  - detect opponent gust threat when our bench has vulnerable prizes
- Attack readiness:
  - count Energy needed for each attack after `effectiveAttackCost()`
  - reward attackers at cost or cost minus one
  - include acceleration cards already in hand/discard when simple to see
- Board development:
  - reward Basics that support the archetype
  - reward evolutions that unlock abilities or main attackers
  - penalize dead bench filler when bench space is scarce
- Resource quality:
  - prefer playable hand over raw hand size
  - value search/draw cards based on current need
- Bench risk:
  - penalize over-benching into spread or Risky Ruins-style pressure
  - penalize leaving damaged low-HP rule-box Pokémon exposed
- Disruption timing:
  - use hand disruption when opponent has a strong hand or low prizes
  - avoid wasting one-shot disruption when opponent is already weak

Tests:

- Unit-test at least three helpers with shaped states.
- Keep the full AI behavior scenarios from Phase 1 green.

## Phase 3 — improve turn sequencing

The CPU should choose actions in a better order. Implement this in `ai.ts`
without bypassing engine legality checks.

Target sequencing:

1. Check for immediate winning attack.
2. Check for gust/switch needed to enable an immediate winning KO.
3. Use draw/search that can improve the current turn before committing manual
   Energy, unless Energy is already obviously forced.
4. Bench archetype-critical Basics before generic deck thinning.
5. Evolve before actions that depend on type/subtype/counts in play.
6. Use abilities before Supporter when the ability may draw/search into a
   better Supporter.
7. Save ACE SPEC / once-per-game effects unless their score clears a high
   threshold.
8. Attach Energy to the best current or next-turn attacker.
9. Attack only after no higher-value setup action remains.

Implementation shape:

- Add small candidate generators for action categories instead of one large
  monolithic branch.
- Score candidates, execute the best legal one, then rerun the loop.
- Stop when no positive-scoring action remains, then attack/end turn.

Do not:

- hardcode card names in the main loop when an archetype profile or helper can
  own the name list
- play every playable Trainer just because it is legal
- discard resources as costs before scoring the follow-up effect

Tests:

- Add scenario tests for action order:
  - search before attach when search can find the correct attacker
  - evolve before using an ability unlocked by the evolution
  - hold ACE SPEC when no meaningful target exists

## Phase 4 — deepen archetype playbooks

Work in `src/engine/aiArchetype.ts`.

Existing archetypes:

- festival-leads
- arboliva
- alakazam
- lucario-ex
- rocket-mewtwo
- dragapult-blaziken
- dragapult-dudunsparce
- crustle
- cynthia-garchomp
- grimmsnarl-froslass
- mega-starmie-froslass
- hops-trevenant

For each archetype, add a compact playbook profile:

- `primaryAttackers`
- `backupAttackers`
- `setupBasics`
- `enginePokemon`
- `preferredEnergyTargets`
- `conserveCards`
- `preferredStadiums`
- `gustPriorityTargets`
- `benchLiabilityNames`
- `earlyTurnPriorities`
- `lateGamePriorities`

Do not require perfect card knowledge. Add only facts already present in the
curated deck specs, existing `aiArchetype.ts`, or audit docs.

Initial playbook improvements:

- Dragapult variants:
  - prioritize Dreepy/Drakloak setup
  - value Rare Candy paths
  - choose spread counters for multi-KO math
- Crustle:
  - wall first, attack last
  - preserve healing and defensive tools
  - avoid exposing unnecessary rule-box liabilities
- Festival Leads:
  - prioritize Festival Grounds and Dipplin line
  - value double-attack readiness
- Mega Lucario:
  - prioritize Lucario line, Mega attacker, Fighting Energy acceleration
- Mega Starmie-Froslass:
  - value Risky Ruins spread and bench-snipe compound damage
- Hops-Trevenant:
  - preserve Hop's line setup and post-KO counterattack plan

Tests:

- Add one scenario per improved archetype.
- Assertions should be about chosen action/target, not just score number.

## Phase 5 — tactical micro-search for high-impact choices

Do not run broad tree search for every action. Add small, explainable scoring
for high-impact target decisions.

Targets:

- gust target
- Energy attachment target
- search target
- bench target
- evolution target
- attack choice
- spread/counter placement target

Each target scorer should return a number and a reason-like structure in code
comments or test names. Keep it deterministic and cheap.

Examples:

- Gust target score:
  - +10000 if KO wins the game
  - +prize value if KO available this turn
  - +engine value for draw/ramp support Pokémon
  - +future threat if target can attack next turn
  - -large if target has protection that prevents meaningful damage
- Energy attachment score:
  - +large if it enables an attack this turn or next turn
  - +archetype preferred target bonus
  - -penalty for attaching to likely KO target without payoff
- Search target score:
  - +evolution completion
  - +attack readiness
  - +archetype setup priority
  - +missing Energy type

Tests:

- Build shaped states with two legal targets where only one is strategically
  correct.
- Assert the chosen target, not the numeric score.

## Phase 6 — replay-informed tuning later

Do this only after local AI behavior is cleaner and cloud replay collection has
real volume.

Use replay corpus to tune:

- opening search targets
- Energy attachment targets
- archetype-specific sequencing
- common winning board states
- card timing thresholds

Do not train on all games blindly. Filter by:

- completed games only
- outcome winner
- archetype
- human-vs-CPU games where the human won, for mistake mining
- high-confidence replay schema/app version

Keep generated weights/data out of hand-written strategy code unless the import
format is documented and tested.

## Per-change checklist

Before marking any AI change done:

- Does it call public engine actions instead of mutating state directly?
- Does it use `state.rng` for gameplay randomness?
- Does it preserve v1 behavior or intentionally gate the change to v2?
- Is there a scenario test that fails before the change and passes after?
- If a new prompt/action was added, are `gameCommands.ts`, AI resolver, and
  replay guard coverage updated?
- Does `npm run typecheck` pass?
- Does `npm run test` pass, or did you document the exact failing test and why?

## Recommended next PRs

PRs 1–3 below all landed during Phase 0–2A; they're kept here as the
chronological record. Active next-step list starts at PR 4.

1. ~~Add `aiDecisionQuality.test.ts` with 4–6 failing/xfailing scenarios
   that describe the desired CPU behavior. Keep implementation
   untouched.~~ ✅ Landed; flipped to all-green after the Unfair Stamp
   scoring + spread-aware bench-risk overlays.
2. ~~Implement AI target scoring for Prime Catcher / gust decisions after
   the Prime Catcher picker fix lands.~~ ✅ Landed in Phase 0.
3. ~~Refactor attack/attachment target scoring into named helpers and
   pin with tests.~~ ✅ Landed in Phase 2A (`scorePosition` extraction +
   `aiScorePosition.test.ts`).
4. **Phase 2B sub-score overlays** — extend `scoreImmediateThreats`
   (opponent gust threat against our bench, bench-Pokémon-in-OHKO-range)
   and `scoreAttackReadiness` (acceleration-aware readiness, weakness-
   coverage pairs). Behavior-test in `aiScorePosition.test.ts`.
5. **Phase 4 archetype playbooks (narrow first)** — add playbook fields
   for two archetypes only: Dragapult and Crustle. Prove value before
   expanding to all 12.
6. **Phase 4 expansion** — playbooks for the remaining curated archetypes.
