# PandaBananasTCG

Browser-based Pokémon TCG clone. Vite + React + TS. Human vs strategic AI,
local hot-seat, using the Play! Pokémon Standard pool (NA, snapshot
2026-05-08, 2,776 cards — includes Mega Evolution—Chaos Rising / me4,
mapped from the Japanese Ninja Spinner counterpart pending official
English data).

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # tsc -b --noEmit
npm run test       # vitest
npm run e2e        # playwright (boots dev server, headless Chromium)
npm run build
```

Node 18+.

## Layout

```
data/pokemon/                       # Card dataset, lazy-loaded
data/tournament-replays/            # Real-tournament replay logs
                                    # (Phase 8 opening-book input)
docs/                               # Detailed companions to this file
src/
  engine/                           # Pure rule logic, no React
    types.ts          Game-state + card types
    rules.ts          Setup, mulligans, prizes, KO, Checkup, prizeValue,
                        isPlayersFirstTurn, setPendingPromote,
                        applyEvolveSideEffects
    actions.ts        play/evolve/attach/retreat/attack/playTrainer/promote,
                        attackPreflight, T1_SUPPORTER_EXCEPTIONS
    effects.ts        Attack effect resolver
    trainerEffects.ts Trainer dispatch
    abilities.ts      Ability detection + activation + triggered dispatch
    ongoingEffects.ts Passives, energy-pool, damage estimator,
                        abilitiesActiveOn / abilitiesActiveOnInstance
    pendingPick.ts    Interactive deck-search picker
    stadiumActivated.ts
    ai.ts             v1 greedy + 1-ply lookahead, v2 MCTS hook,
                        scorePosition (threat-aware), shallow-clone
    aiArchetype.ts    Archetype detection + bonuses + T1-T3 playbooks
    mcts.ts           Determinized UCT, action-level tree, depth=0 leaf
    rng.ts            Seeded mulberry32 with getState/setState
  data/
    cards.ts          Lazy dynamic import()
    cardMapper.ts     API → engine types
    cardEquivalence.ts gameplayKey() canonical "same card different art"
    decklistParser.ts PTCGL importer (caps >4 copies at parse time)
    decks.ts          Curated + community decks + validateDeckForPlay
    persistence.ts    idb-keyval deck storage
    effectPatterns.ts
  ui/CardView.tsx     Card + in-play renderers (memoized)
  ui/DeckBuilderModal.tsx
  ui/VariantPicker.tsx Modal: pick which printing of a card to use
  App.tsx
  styles.css
  test-setup.ts       Loads dataset + jest-dom matchers
e2e/smoke.spec.ts     Playwright boot + undo click-through
playwright.config.ts
vite.config.ts        manualChunks split, vite-plugin-pwa
```

## Architecture

- **Card schema mirrors the Pokémon TCG API**; `cardMapper.ts` is the only
  translation layer.
- **Effects are data-driven.** Attack/trainer/ability text regex-matched
  on first use, cached as `AttackEffect[]`, dispatched by `kind`.
  Unmatched text preserved for display.
- **RNG on `GameState`** — mulberry32 cursor exposed via `getState` /
  `setState` so undo can rewind entropy alongside board state.
- **Lazy dataset load** via dynamic `import()` keeps the 1.5MB JSON out
  of the boot bundle.
- **Wild Growth–aware cost checks** route through `energyPoolForCost`.
- **Memoized React renders** — `CardView` excludes `onClick` from its
  comparator; click handlers read `stateRef.current` so memo closures
  see fresh state.
- **Interactive picker pattern** — `PendingInPlayTarget` carries a
  discriminated-union action; `resolveInPlayTarget` re-arms between
  clicks until `remaining` hits 0. `formatPickerLabel` appends "— N left".
- **Pause states.** Terminal promotes (attack/checkup KO) set
  `pendingPromote` + `phase = "promoteActive"` and queue
  `onPromoteResolved` (`endTurn` / `passTurn` / `secondAttack`).
  Non-terminal promotes (Run Away Draw, Cursed Blast) keep `phase = "main"`.
- **Promote queue.** `pendingPromoteQueue: PlayerId[]` handles
  simultaneous KOs; all pause sites route through `setPendingPromote`;
  `promoteBenchToActive` drains FIFO before running `onPromoteResolved`.
- **Centralized evolve cleanup.** `applyEvolveSideEffects` clears
  statuses (Confused persists under Dizzying Valley), resets
  `abilityUsedThisTurn`, sets `evolvedThisTurn`, clears scheduled
  flags. Used by regular evolve and both Rare Candy paths.
- **Triggered abilities honor instance suppressors** — Sticky Bind /
  Initialization / Midnight Fluttering via `abilitiesActiveOnInstance`.
- **Single attack-legality gate.** `attackPreflight` runs every
  pre-click rejection (T1 ban + Debut Performance bypass, asleep,
  paralyzed, `cantAttackUntilTurn`, per-attack lock, Power Saver,
  Born to Slack, energy cost). UI calls it per-attack to drive the
  disabled + tooltip on the attack button. The UI's `payable` check
  uses `effectiveAttackCost` (not raw `move.cost`) so cost-reduction
  tools (Hop's Choice Band, Counter Gain, Sparkling Crystal) +
  ability-driven discounts (Bloodmoon Ursaluna ex Seasoned Skill,
  Veluza Food Prep, Sniper's Eye, Hustle Play) match the engine.
- **Damage estimator covers `conditionalDamage`** — projected damage
  on the attack-button label evaluates the attack's predicate via
  `evaluatePredicate`; fizzleIfNot zeroes the preview when the
  condition is unmet (Hop's Cramorant Fickle Spitting projects 0 at
  prizes ∉ {3,4} instead of misleading 120).
- **Art variants** — `gameplayKey(card)` in [cardEquivalence.ts](src/data/cardEquivalence.ts)
  produces a canonical signature from every gameplay-relevant field
  (name + supertype + subtypes + HP + types + retreat + attacks +
  abilities + weaknesses + resistances + rules text). Excludes
  printing-specific fields (id, setCode, number, image,
  regulationMark). Two prints of the SAME card produce the same key;
  two cards sharing a name but different attacks (e.g. multiple
  Pikachu prints) produce DIFFERENT keys. DeckBuilderModal groups the
  grid by gameplayKey, opens VariantPicker on click for multi-print
  groups, and surfaces a swap-art button on each entry in the right
  panel. Per-printing identity flows end-to-end through PTCGL parser
  → IDB persistence → setupGame → in-game render (every CardView
  reads `card.imageLarge` from the chosen printing).
- **Supporter T1 gate** — `supporterAllowsFirstTurn(card)` reads
  `T1_SUPPORTER_EXCEPTIONS` (Team Rocket's Proton, Carmine). Mirrors
  the Debut Performance attack-ban exception.
- **End Turn pre-confirm.** `unspentTurnSlots` returns warnings for
  Energy attach / Supporter slots the player still has cards for.
- **Undo: per-action snapshot stack.** `undoStackRef` pushes
  `{state JSON, rngState, label}` BEFORE each action. Undo restores
  state AND rewinds `rng.setState(rngState)` — without the rng rewind
  retried shuffles consumed different entropy. Stack resets at turn
  boundary; cleared on successful attack. Multiple undos walk back
  through the turn one action at a time.

## Rules implemented

- 60-card deck, max 4 per name (basic energy excepted).
- 7-card opening hand, mulligan for no-Basic; opponent draws N extra.
- 6 Prizes; ex/V/VSTAR/GX = 2, VMAX/V-UNION/Mega ex = 3.
- 5-slot bench. 1 Energy / 1 Supporter / 1 retreat per turn.
- First player can't attack or play a Supporter on T1 (per-card
  exceptions: Debut Performance, Team Rocket's Proton, Carmine).
- First-turn evolve gate applies to **both** players' first turn.
- Weakness ×2, Resistance −N. All 5 Special Conditions with proper
  Checkup + attack-time confusion flip.
- Status immunity — Festival Grounds, Insomnia, Antique Fossils,
  Ancient Booster Energy Capsule (Ancient Pokémon), Bubble Water Energy
  (Water Pokémon).
- Retreat + evolution clear statuses (Confused persists on evolve under
  Dizzying Valley; same gate for Rare Candy).
- Both-Active simultaneous KO — both players promote in sequence.
- Stadium zone (new replaces old). Tool attach (max 1; discarded with
  holder).
- Ability-disabling auras via `abilitiesActiveOnInstance`.
- Passive attack/damage modifying abilities evaluated in damage and
  in the AI estimator.
- Bench KOs from snipe / recoil / status / counter-placement resolve
  with prizes.
- Win conditions: prizes=0, no Pokémon left, can't draw.

## Conventions

- Comments explain **why**, not what.
- No defensive error handling at internal boundaries — trust the engine.
  Validate at system boundaries (user input, persistence).
- UI is dumb — all rule decisions live in `src/engine/`.
- Prefer editing existing files over adding new ones.
- `npm run typecheck` and `npm run test` must pass before commit.

## Where to look

For task-specific deep dives, read the relevant docs/ companion:

- **Effect coverage** (attacks / abilities / trainers / stadiums / tools, ~85 effect kinds incl. Chaos Rising additions, ~24 tools, special interactions): see [docs/EFFECTS.md](docs/EFFECTS.md)
- **AI internals** (v1 greedy, v2 archetype-aware heuristics, MCTS, the 12 wired archetype playbooks, measured win rates): see [docs/AI.md](docs/AI.md)
- **Deck library** (12 curated decks: 4 baseline + 8 Prague Regional 2026 community lists; deck-builder gameplay-equivalence grouping; dataset refresh): see [docs/DECKS.md](docs/DECKS.md)
- **Test suite** (626 vitest across 37 files + 3 Playwright e2e — full enumeration with what each file covers): see [docs/TESTS.md](docs/TESTS.md)
- **Mobile / iOS / offline** (Capacitor, PWA, responsive CSS, safe-area hardening): see [docs/MOBILE.md](docs/MOBILE.md)
- **Open findings + deferred AI work** (MVP scope cuts, pressure-test findings, Phases 2c / 2e / 7-12 of the AI overhaul plan): see [docs/FINDINGS.md](docs/FINDINGS.md)

## Working branch

Active: `pandabananastcg`. `main` tracks the deployable build.
