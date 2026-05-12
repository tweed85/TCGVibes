# AI

Two AI versions, gated per-player by `PlayerState.aiVersion` (default
`"v1"`). MCTS is a separate opt-in via `PlayerState.mctsBudgetMs > 0`.
See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

For the implementation roadmap to make the CPU a stronger player, see
[AI_CPU_BUILD_PLAN.md](AI_CPU_BUILD_PLAN.md). That doc is written as a
Claude-ready build plan with phases, exact files, required tests, and
per-change guardrails.

## v1 (always-on)

- Greedy step loop + 1-ply lookahead minimax for attack choice (clone
  via shallow-clone, opp greedy turn, our greedy follow-up, score via
  `scorePosition`). Damage estimator includes passive bonuses /
  reductions / Stadium / Tool / turn-scoped modifiers in the same
  order as `executeAttackHit`.
- Opp-aware promote selection; `tryDefensiveRetreat` /
  `tryOffensiveSwitch`.

## v2 heuristics (fast, no extra search)

- Archetype awareness — **12 wired archetypes** in [../src/engine/aiArchetype.ts](../src/engine/aiArchetype.ts):
  Festival Lead, Arboliva, Alakazam, Mega Lucario, Rocket Mewtwo,
  Dragapult-Blaziken, Dragapult-Dudunsparce, Crustle, Cynthia-Garchomp,
  Grimmsnarl-Froslass, Mega-Starmie-Froslass, Hops-Trevenant. Each
  carries per-archetype bonuses on signature Trainers, Energy-attach
  targets, bench Basics, and abilities. Plus T1-T3 turn-aware playbooks
  (`cardBonus` + `abilityBonus` keyed on `state.turn`).
  Sources:
  - Rocket Mewtwo + Dragapult-Blaziken — Prague Regional 2026 R9 replay
  - Dragapult-Dudunsparce + Crustle + Cynthia-Garchomp +
    Grimmsnarl-Froslass + Mega-Starmie-Froslass — Prague Regional 2026
    Day 2 replays (top16 / top8 / top4 / finals)
  - Hops-Trevenant — Prague Regional 2026 community list
- Dragapult-Dudunsparce signature is `Dudunsparce ex` (sig[0]) so detection
  prefers it over plain Dragapult-Blaziken when Dudunsparce ex is present.
- Crustle's playbook intentionally inverts aggro: heavy T2-T3 Hero's Cape +
  Pokémon Center Lady + Colress's Tenacity weight with **no Ascension boost**
  ("wall first, attack last").
- **`scorePosition` parity-extracted into seven named sub-scores**
  (Phase 2A): `scorePrizeRace`, `scoreImmediateThreats`,
  `scoreAttackReadiness`, `scoreBoardDevelopment`, `scoreResourceQuality`,
  `scoreBenchRisk`, `scoreDisruptionTiming`. Load-bearing constants
  surfaced with provenance comments
  (`ACTIVE_OHKO_BASE_PENALTY = 60`, `ACTIVE_OHKO_PRIZE_PENALTY = 80`,
  `OPP_ACTIVE_OHKO_BASE_BONUS = 50`, `OPP_ACTIVE_OHKO_PRIZE_BONUS = 60`).
- Threat-aware overlays in `scoreImmediateThreats` /
  `scoreAttackReadiness` (Phase 2B): game-losing escalator, bench-counter
  mitigation, game-winning escalator, active-can-attack-now bonus,
  evolution-in-hand unlocks attacker.
- **Turn sequencing — candidate-generator loop (Phase 3)**:
  `tryStepAiTurn` is no longer a fixed greedy step order. Each step
  collects ranked candidates via `enumerateAiActionCandidates`
  (priority multiplier `CANDIDATE_BAND = 10000`), with
  `tryImmediateWinningLine` preserved at the top. Sub-phase guardrails:
  3A immediate-win short-circuit, 3B search-before-attach scoring
  (`searchWouldImproveAttachTarget`, `isSearchableAttachBasic`),
  3C ability-before-Supporter for `drawUntilSeven` etc., 3D ACE SPEC
  conservation gate (`isAceSpec` + 75/40 threshold via `meetsThreshold`).
- **Target scorers (Phase 5)** — small, explainable, deterministic:
  - `bestGustTarget` v2 (5A): game-winning KO, ramp engines, un-powered
    rule-box punchers (TR Mewtwo ex, Dragapult ex, Mega Lucario ex),
    future-threat prediction, protection penalty. Used by Boss's Orders
    + Prime Catcher.
  - `scoreEnergyTarget` v2 (5B): next-turn-reachable attacks +
    acceleration awareness, OHKO-range-waste penalty.
  - Search-pick scoring v2 (5C): playable evolution completions +
    bench-ready Basics + energy-type-gap-closers.
  - Bench target scorer v2 (5D): integrates Phase 4 playbook fields.
  - `pickBestEvolution` v2 (5E): `archetypeBenchBonus × 2` +
    `playbookCardBonusFromState` + ability-unlock bonuses (draw,
    `searchBasicEnergy`, energy-from-hand / discard variants).
  - `attackValue` v2 OHKO path (5F): mid-game prize-swing bonus
    (+40 when `oppPrize ≥ 2` AND `ourPrizes ≥ 3`), bench-readiness
    bonus (+30 for ≥1 ready, +15 for ≥2).
  - `placeCountersOnOppBenchAny` v2 (5G): KO + prize value, rule-box
    close-to-KO range, engine-piece names, most-damaged fallback.
- **Gust insurance**: redundant ready bench attackers (≥2) get a
  non-linear bonus in `scoreAttackReadiness` — converts gust threats
  into swap-and-attack lines.
- **AI coin-flip choice**: v2 chooses to go FIRST when opp's deck contains
  a T1-supporter exception (Team Rocket's Proton, Carmine, TR Mewtwo
  signatures) — denying that enabler is worth eating the T1 attack ban.
  v1 keeps the always-go-second baseline.
- Non-linear endgame prize weighting (4→6 worth more than 0→2).
- Endgame solver: when prizes ≤ 2, MCTS budget scales 4×.

## MCTS (opt-in)

- Determinized UCT in [../src/engine/mcts.ts](../src/engine/mcts.ts) —
  action-level tree, lazy expansion with progressive widening (top-K=8),
  per-iteration RNG re-seed.
- Action space: atomic engine actions.
- Depth=0 leaf eval (just `scorePosition` — no greedy playout, since
  per-iteration cost would otherwise drop iterations to 1-2).
- Time-budgeted; falls back to greedy on exhaustion.
- `lookaheadActive` re-entrancy guard prevents recursion.

## Measured win rates

Full N=50, 800 games each, 2026-04-28:

| Configuration | Win rate (p1) |
|---|---:|
| v1 vs v1 baseline | 53.0% (going-first edge ✓) |
| v2 heuristics vs v1 | 52.8% (≈ neutral) |
| **v2 + MCTS vs v1** | **65.5%** (+12.5pp) |

MCTS dominates in mirror matchups + Alakazam-driven games (decisions
compound). Lucario matchups stay flat — Lucario's plan is prescriptive
enough that greedy already plays it well.
