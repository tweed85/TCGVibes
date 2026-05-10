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
  targets, bench Basics, and abilities. Plus T1-T3 turn-aware playbooks.
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
- Threat-aware `scorePosition`: penalize positions where our Active is in
  opp OHKO range (scaled by prize at risk); reward symmetric bonus for
  opp; count "ready bench attackers" (≥cost-1 energy + a payable attack).
  **Gust insurance**: redundant ready bench attackers (≥2) get a
  non-linear bonus — converts gust threats into swap-and-attack lines.
- Smart gust targeting — `bestGustTarget` boosts ramp engines (Bibarel,
  Dudunsparce, Fan Rotom, Teal Mask Ogerpon ex, Spidops, Blaziken ex)
  **and un-powered rule-box punchers on bench (TR Mewtwo ex,
  Dragapult ex, Mega Lucario ex, etc.) — KO before they boot**.
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
