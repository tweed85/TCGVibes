# Open findings + deferred work

Pressure-test findings, MVP scope cuts, and deferred AI overhaul phases. See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

## MVP scope cuts (intentional / verified-not-applicable)

- Fossils not modeled as 60-HP Basics — pool has 0 fossil-line
  Pokémon, so wiring the play-as-Basic mechanic gives nothing useful
  to evolve into. Deferred until pool gets a fossil-line Pokémon.
- No prize-pick UI (top prize always taken). Only legal-pool card
  that interacts with specific prizes is Cresselia ("Crescent Purge"
  +80 if you flip a face-down Prize) — bonus intentionally not
  modeled (logged but no damage applied).

## High

- `state.log: LogEntry[]` grows unbounded across turns. Real but
  smaller than originally framed — AI clone strips the log, ~50KB
  total. Cap to last ~30 entries if you want to be tidy; not urgent.
- UX — pre-attack confirm on coin-flip-heavy attacks. Debatable: real
  TCG doesn't allow attack-undo either; current behavior is
  "successful attack locks the undo stack." Boss's Orders / Counter
  Catcher / Retreat misclicks are recoverable via per-action Undo.

## Low

- Discard pile `onClick` without keyboard handler (Enter/Space).
- Mobile bench scroll has no visual overflow hint.
- No in-game rules glossary / help button.
- `AiActionBanner` can flash-and-vanish on fast AI steps.

## Deferred AI work (Phases 2c, 2e, 7-12 of the AI overhaul plan)

Concrete build plan: [AI_CPU_BUILD_PLAN.md](AI_CPU_BUILD_PLAN.md). Use that
doc for implementation sequencing; this section is the older backlog map.

- **2c. Multi-action reordering** — replace fixed greedy step order
  with a score-then-pick loop.
- **2e. Ability scoring tuning** — defaults at 50-65 across ~70 kinds;
  tune per-impact via Phase 9 self-tuning.
- **7. Opp modeling** — route opp's MCTS-rollout moves through their
  detected archetype playbook instead of greedy.
- **8. Opening book from real tournament data** — *substantially
  seeded*: Prague Regional 2026 R9 + Day 2 (top16/top8/top4/finals)
  logged in
  [../data/tournament-replays/](../data/tournament-replays/). **12 archetype
  playbooks wired** in [../src/engine/aiArchetype.ts](../src/engine/aiArchetype.ts):
  festival-leads, arboliva, alakazam, lucario-ex, rocket-mewtwo,
  dragapult-blaziken, dragapult-dudunsparce, crustle, cynthia-garchomp,
  grimmsnarl-froslass, mega-starmie-froslass, hops-trevenant. Continue
  feeding via the `tournament-game-analyst` agent.
- **9. Self-tuning weights** — overnight AI-vs-AI loop that
  perturbation-searches the 20+ heuristic constants. Game 3 T12
  "intriguing pass" from Prague R9 is concrete training data for a
  low `passOnLethalConservatismFactor`.
- **10. Massive scenario suite** — expand from 12 → 200 handcrafted
  decision tests.
- **11. Game-log review pass** — manually read 100 AI-vs-AI logs,
  encode found mistakes as new heuristic rules / scenarios.
- **12. Self-play RL pipeline** — only path to genuine tournament-level
  play. AlphaZero-style policy + value network, millions of self-play
  games, ~3 months + GPU. Documented as the future ceiling.
