# PandaBananasTCG

Browser-based Pokémon TCG clone. Vite + React + TS. Human vs strategic AI,
local hot-seat, using the Play! Pokémon Standard pool (NA, snapshot
2026-04-23, 2,693 cards).

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
src/
  engine/                           # Pure rule logic, no React
    types.ts          Game-state + card types
    rules.ts          Setup, mulligans, prizes, KO, Checkup, prizeValue,
                        isPlayersFirstTurn, setPendingPromote,
                        applyEvolveSideEffects
    actions.ts        play/evolve/attach/retreat/attack/playTrainer/promote
    effects.ts        Attack effect resolver
    trainerEffects.ts Trainer dispatch
    abilities.ts      Ability detection + activation + triggered dispatch
    ongoingEffects.ts Passives, energy-pool, damage estimator,
                        abilitiesActiveOn / abilitiesActiveOnInstance
    pendingPick.ts    Interactive deck-search picker
    stadiumActivated.ts
    ai.ts             v1 greedy + 1-ply lookahead, v2 MCTS hook,
                        scorePosition (threat-aware), shallow-clone
    aiArchetype.ts    Archetype detection + per-archetype score bonuses
                        + T1-T3 turn-aware playbooks
    mcts.ts           Determinized UCT, action-level tree, depth=0 leaf
    rng.ts            Seeded mulberry32 with getState/setState
  data/
    cards.ts          Lazy dynamic import()
    cardMapper.ts     API → engine types
    decklistParser.ts PTCGL importer (caps >4 copies at parse time)
    decks.ts          Curated decks + validateDeckForPlay
    persistence.ts    idb-keyval deck storage
    effectPatterns.ts
  ui/CardView.tsx     Card + in-play renderers (memoized)
  ui/DeckBuilderModal.tsx
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
- **Effects are data-driven.** Attack text regex-matched on first use,
  cached as `AttackEffect[]`, dispatched by `kind`. Same for trainer +
  ability effects. Unmatched text preserved for display.
- **RNG on `GameState`**, exposed via `next` / `int` / `getState` /
  `setState` (mulberry32 cursor is snapshottable for undo).
- **Lazy dataset load** via dynamic `import()` keeps the 1.5MB JSON out
  of the boot bundle.
- **Wild Growth–aware cost checks** route through `energyPoolForCost`.
- **Memoized React renders** — `CardView` uses a custom comparator
  excluding `onClick`; click handlers read `stateRef.current` so memo
  closures see fresh state.
- **Interactive picker pattern** — `PendingInPlayTarget` carries a
  discriminated-union action; `resolveInPlayTarget` re-arms between
  clicks until `remaining` hits 0. `formatPickerLabel` in App appends
  "— N left" so multi-click effects (Phantom Dive, Aura Jab) show
  progress.
- **Pause states.** Terminal promotes (attack/checkup KO) set
  `pendingPromote` + `phase = "promoteActive"` and queue
  `onPromoteResolved` (`endTurn` / `passTurn` / `secondAttack`).
  Non-terminal promotes (Run Away Draw, Cursed Blast) keep
  `phase = "main"`.
- **Promote queue.** `pendingPromoteQueue: PlayerId[]` handles
  simultaneous KOs (`bothActiveKnockedOut`). All pause sites route
  through `setPendingPromote`; `promoteBenchToActive` drains FIFO
  before running `onPromoteResolved`.
- **Centralized evolve cleanup.** `applyEvolveSideEffects(state, p)`
  in `rules.ts` clears statuses (Confused persists under Dizzying
  Valley), resets `abilityUsedThisTurn`, sets `evolvedThisTurn`, and
  clears scheduled flags (`scheduledKoOnTurn`, `shieldedUntilTurn`,
  `cantAttackUntilTurn`, `noWeaknessUntilTurn`). Used by the regular
  evolve action and both Rare Candy paths.
- **Triggered abilities honor instance suppressors.** Triggered-on-
  evolve / -on-bench / -on-move-to-active / -on-move-to-bench all
  use `abilitiesActiveOnInstance`, so Sticky Bind / Initialization /
  Midnight Fluttering suppress them.
- **AI estimator matches real damage.** `estimateDamage` applies
  `passiveAttackBonus` + `passiveDamageReduction` in the same order as
  `executeAttackHit`.
- **Single attack-legality gate.** `attackPreflight(state, player,
  attackIndex)` in `actions.ts` runs every pre-click rejection (T1
  ban, asleep, paralyzed, `cantAttackUntilTurn`, per-attack lock,
  Power Saver, Born to Slack, energy cost). `attack()` calls it
  first, and the UI calls it per-attack to drive the disabled +
  tooltip on the attack button — UI/engine can't disagree about
  legality.
- **End Turn pre-confirm.** `unspentTurnSlots(state, player)` in
  `rules.ts` returns warnings for any per-turn slot the player still
  has cards for in hand (Energy attach, Supporter). The App shows a
  small confirm modal before ending the turn when the list is
  non-empty; otherwise End Turn proceeds without an extra click.
- **Undo: per-action snapshot stack.** `undoStackRef` in App.tsx pushes
  `{state JSON, rngState, label}` BEFORE each player action (play /
  attach / evolve / retreat / playTrainer / activate ability). On undo,
  pop and restore both state AND `rng.setState(rngState)` — without the
  rng rewind, retried shuffles/flips consumed different entropy and
  undo behaved like a randomizer (the original user-reported bug).
  Stack resets at turn boundary; cleared on successful attack since
  post-attack side effects are intractable to reverse. Multiple undos
  walk back through the turn one action at a time.

## Rules implemented

- 60-card deck, max 4 per name (basic energy excepted).
- 7-card opening hand, mulligan for no-Basic; opponent draws N extra.
- 6 Prizes; ex/V/VSTAR/GX = 2, VMAX/V-UNION/Mega ex = 3 (`prizeValue`).
- 5-slot bench. 1 Energy / 1 Supporter / 1 retreat per turn.
- First player can't attack or play a Supporter on T1.
- First-turn evolve gate applies to **both** players' first turn
  (`isPlayersFirstTurn`); drives evolve, Rare Candy, Grimsley's Move.
- Weakness ×2, Resistance −N. All 5 Special Conditions with proper
  Checkup + attack-time confusion flip.
- Status immunity — Festival Grounds (any energy attached), Insomnia
  (no asleep), Antique Fossils (all blocked).
- Retreat + evolution clear statuses (Confused persists on evolve under
  Dizzying Valley; same gate for Rare Candy via the shared helper).
- Both-Active simultaneous KO — both players promote in sequence.
- Stadium zone (new replaces old). Tool attach (max 1; discarded with
  holder).
- Ability-disabling auras (Initialization, Midnight Fluttering, Sticky
  Bind) via `abilitiesActiveOnInstance`.
- Passive attack/damage modifying abilities evaluated in damage and
  in the AI estimator.
- Bench KOs from snipe / recoil / status / counter-placement resolve
  with prizes.
- Player picks Active on KO (AI auto-picks via `scorePromoteCandidate`).
- Win conditions: prizes=0, no Pokémon left, can't draw.

## Effect coverage (2,693-card pool)

- **Attacks**: ~70 effect kinds — coin-flip variants, per-energy /
  per-bench / per-counter scaling, status, heal, snipe, multi-target,
  draw, locks, retreat manipulation. Bespoke: `distributeDamage`
  (Phantom Dive / Oil Salvo, interactive — picker label says "click an
  opp X to place N damage" + "— N left" progress),
  `placeCountersPerHandCard` (Powerful Hand, W/R bypass), copy-attack
  pipelines (`useAttackFromOppDeckTop`, `useBenchedAllyNamedAttack`,
  `discardTopOfOwnDeckUseSupporterEffect`),
  `discardDefenderEndOfOppNextTurn` (Corrosive Sludge),
  `bothActiveKnockedOut`, `attachNFromDiscardToBench` (Aura Jab,
  interactive).
- **Abilities**: ~70 activated + triggered-on-evolve / -on-bench /
  -on-move-to-active / -on-move-to-bench. Highlights:
  `attachEnergyFromHandThenDraw` (Teal Dance), `moveDamageOwnToOpp`
  (Adrena-Brain, interactive), `putCountersOnOppThenSelfKO` (Cursed
  Blast, interactive). Triggered: Jewel Seeker, Psychic Draw,
  Heave-Ho Catcher, Cast-Off Shell, Multiplying Cocoon, Emergency
  Evolution.
- **Trainers**: 100+ effects. Hilda + Dawn chained pickers,
  **Colress's Tenacity** (Stadium → basic Energy chain),
  **Salvatore** (interactive Evolution → applied via `toEvolve`),
  **Perrin** (interactive hand-reveal → search same count via
  `useRevealedCount` postAction), Unfair Stamp ACE SPEC, all Standard
  staples (Nest/Poké/Master/Ultra Ball, Buddy-Buddy Poffin, Tera Orb,
  Rare Candy, Boss's Orders, Pokémon Catcher, heals, hammers, etc.),
  turn-scoped buffs. AI keeps the auto-resolve path on each so AI
  turns don't open hidden pickers.
- **Stadiums**: most passives wired (Festival Grounds, Forest of
  Vitality, Dizzying Valley, etc.). Activated framework exists; per-
  Stadium UI buttons partial.
- **Tools**: ~18 — HP boosters, retreat helpers, damage boosters,
  berries with auto-discard, KO-triggered (Survival Brace, Lillie's
  Pearl, Amulet of Hope, **Heavy Baton** — interactive Bench-target
  picker that fires after the holder's owner promotes).

## AI

The engine ships two AI strategy versions, gated per-player by
`PlayerState.aiVersion`. Default `"v1"` keeps the original behavior;
`"v2"` enables the strengthened heuristics described below. MCTS is a
separate opt-in via `PlayerState.mctsBudgetMs > 0`.

**v1 (always-on baseline):**
- **Greedy step loop**: bench Basics → search Items → free abilities
  → evolve → bench → Supporter → Stadium → attach → switch → attack.
- **1-ply lookahead minimax** for attack choice: clone state (now via
  shallow-clone, ~10× faster than the prior JSON-clone), apply
  candidate, opp greedy turn, our greedy follow-up, score via
  `scorePosition`.
- **Damage estimator** includes passive bonuses/reductions, Stadium /
  Tool / turn-scoped modifiers — same order as real `executeAttackHit`.
- **Promote selection** opp-aware: penalize OHKO-able candidates,
  reward counter-OHKO.
- **Switch heuristics**: `tryDefensiveRetreat`, `tryOffensiveSwitch`.

**v2 (heuristic upgrades, fast — no extra search cost):**
- **Archetype awareness** ([src/engine/aiArchetype.ts](src/engine/aiArchetype.ts)):
  detects the deck archetype from signature cards (Festival Lead,
  Arboliva ex, Alakazam, Mega Lucario ex) and applies modest score
  bonuses on the archetype's defining Trainers, Energy-attach targets,
  bench Basics, and abilities.
- **Turn-aware playbooks**: T1-T3 bonuses tighten priority for each
  archetype (e.g., Arboliva T1 always Teal Dance + Forest of Vitality;
  Mega Lucario T2 wants Premium Power Pro + Rare Candy).
- **Threat-aware position eval**: `scorePosition` penalizes positions
  where our Active is in OHKO range from opp's projected next attack
  (scaled by prize value at risk), mirrors the bonus when opp is in
  our OHKO range, and counts "ready bench attackers" (Pokémon with
  ≥cost-1 energy and a payable attack).
- **Endgame solver**: when prizes ≤ 2 on either side, MCTS budget
  scales 4× so the closing window gets exhaustive search.
- **Smart gust targeting**: `bestGustTarget` adds a "ramp engine"
  bonus (Bibarel, Dudunsparce, Fan Rotom, Teal Mask Ogerpon ex,
  Munkidori, Fezandipiti ex) so KOs on opp's tempo engines outrank
  KOs on inert benched Basics.
- **Non-linear endgame prize weighting**: prizes 4→6 worth more than
  prizes 0→2 (champions push harder for the close).

**MCTS (opt-in via `mctsBudgetMs`):**
- **Determinized UCT** ([src/engine/mcts.ts](src/engine/mcts.ts)):
  action-level tree, lazy expansion with progressive widening
  (top-K=8), per-iteration RNG re-seed so coin flips average across
  rollouts.
- **Action space**: atomic engine actions (`attack`, `attachEnergy`,
  `evolve`, `playBasic`, `playTrainer`, `retreat`, `activateAbility`,
  `endTurn`).
- **Leaf eval (default)**: depth=0 — evaluate `scorePosition` directly
  at the leaf, no greedy playout. ~100-200 iterations per 200ms
  budget. The greedy-rollout variant exists but at this codebase's
  per-iteration cost only delivers ~1-2 iterations, defeating
  exploration.
- **Time-budgeted**: `runMcts` checks the wall clock each iteration.
  Falls back to greedy when budget is exhausted before any complete
  iteration or `enumerateActions` returns empty.
- **Re-entrancy guard** (`lookaheadActive`): rollouts and the search's
  internal action applications skip the v2 MCTS branch so MCTS doesn't
  recurse into itself.

**Benchmarking** ([src/engine/__tests__/aiBenchmark.test.ts](src/engine/__tests__/aiBenchmark.test.ts)):
gated by `AI_BENCH=quick|full` env var so `npm run test` doesn't pay
the cost. Quick mode runs 5 games per deck-pair (16 pairs = 80 games);
full mode runs 50 per pair (800 games). Three benchmarks: v1-vs-v1
sanity (~50%), v2-vs-v1 (heuristics-only), v2+MCTS-vs-v1 (full mode
only — ~65 min runtime per benchmark on N=50).

**Measured results** (full N=50, 800 games each, 2026-04-28):

| Configuration | Win rate (p1 side) |
|---|---:|
| v1 vs v1 baseline | 53.0% (going-first edge ✓) |
| v2 heuristics vs v1 | 52.8% (≈ neutral — Phase 9 self-tuning needed) |
| **v2 + MCTS vs v1** | **65.5%** (+12.5pp over baseline) |

Largest per-pair shifts (vs v1 baseline) where MCTS pays off most:
- `alakazam vs festival-leads`: 22% → 57% (+35pp)
- `arboliva vs arboliva` (mirror): 49% → 76% (+27pp)
- `alakazam vs alakazam` (mirror): 59% → 84% (+25pp)
- `alakazam vs arboliva`: 28% → 49% (+21pp)

Pattern: MCTS dominates in **mirror matchups** and **Alakazam-driven**
games where decisions compound over many turns. Lucario matchups are
near-flat — Lucario's plan is prescriptive enough that greedy already
plays it well.

**Scenario tests** ([src/engine/__tests__/aiScenarios.test.ts](src/engine/__tests__/aiScenarios.test.ts)):
12 handcrafted board states with expected decisions (OHKO preference,
T1 attack ban, status-blocked attacker, energy unlock, bench-cap
respect, etc.). Some require v2 — tagged in test names.

## Test suite

- **Vitest — 262 tests across 21 files** (+ 3 AI_BENCH-gated).
  - `src/engine/__tests__/`: abilityDetection, dawnChain, energy,
    gameFlow, integration, ongoingEffects, presetDeckSmoke,
    trainerDetection, weakness, undoRng, undoIntegration,
    phantomDiveHuman, attackPreflight, unspentTurnSlots, mvpPickers
    (Colress / Perrin / Salvatore / Heavy Baton interactive paths),
    **aiScenarios** (12 handcrafted decision scenarios), **mcts**
    (MCTS smoke), **aiBenchmark** (gated AI-vs-AI win-rate harness).
  - `src/data/__tests__/`: decklistParser, effectPatterns.
  - `src/ui/__tests__/`: CardView (energy-pip glyph rendering),
    aiPause (modal-pause useEffect under fake timers).
- **Playwright — 2 e2e tests in `e2e/smoke.spec.ts`.** Boots a real
  headless Chromium against the dev server: app loads → coin flip →
  setup → main phase → Undo button starts disabled → play action →
  Undo enables → click Undo → Undo disables. Catches runtime errors
  the unit suite can't see.

Coverage includes cost matching, passive bonuses, full-game setup +
Checkup, every wired AttackEffect / Ability / Trainer detected, AI-vs-AI
smoke for every preset cartesian pair, and end-to-end scenarios for
trickier flows: Phantom Dive split (AI + human paths), Aura Jab 3-pick,
Hilda chain, Unfair Stamp KO gate, Wild Growth doubling, T1 evolve
gate, `bothActiveKnockedOut` promote queue, Sticky Bind suppression,
Dizzying Valley confused-on-evolve, parser >4 truncation,
`validateDeckForPlay` rejection paths, **rng cursor round-trip +
deterministic shuffle replay after undo**.

DOM tests opt into jsdom via `// @vitest-environment jsdom` per file
(RTL + jest-dom matchers loaded by `test-setup.ts`); pure-engine tests
stay in node for speed. `npm run test` / `npm run test:watch` /
`npm run e2e`.

## Mobile / iOS / offline

- Capacitor scaffolded; `npx cap add ios` builds `dist/` into a
  WebView shell.
- PWA via vite-plugin-pwa: CacheFirst dataset + CDN images,
  NetworkFirst shell.
- Deck imports persist to IndexedDB (`idb-keyval`); UI settings to
  localStorage.
- Mobile-responsive CSS: floating Stadium overlay, horizontal bench
  scroll with right-edge fade mask, right-to-left hand scroll with
  fade + scroll-snap, vertical action bar.
- Touch + safe-area hardening: `env(safe-area-inset-right)` baked
  into `.side` padding (clears iPhone X+ landscape notch and iPad
  Pro rounded corner); `touch-action: manipulation` on every
  interactive (kills the 300ms double-tap-zoom delay); landscape
  phones use a 40px action-bar button minimum.
- Side-distinction tinting: opponent side has a slightly darker
  background + 1px red top accent vs the player side, so "your /
  their" reads at a glance on a small screen.
- Narrow-width tightening (≤360px): energy pip min-width 14px and
  HP-badge font-size 11px so 2-3 pips fit alongside status badges
  on a 70px-wide bench card; modal padding drops to 10px to leave
  usable content width on iPhone SE-class viewports.
- Status-message dwell: the action-bar status line holds each
  non-empty message for at least 2.5s before allowing it to be
  overwritten, so rapid plays don't wipe what just happened. Empty
  clears bypass the dwell.

## Open pressure-test findings

Not yet addressed. Severity per the multi-agent QA pass.

**MVP scope cuts (intentional / verified-not-applicable):**
- Fossils not modeled as 60-HP Basics. Real but **the legal pool has zero
  Pokémon that evolve from Fossils**, so wiring the play-as-Basic
  mechanic gives the player nothing useful to evolve into. Deferred
  until the pool gets a fossil-line Pokémon.
- No prize-pick UI (top prize always taken). Niche relevance — the only
  legal-pool card that interacts with specific prizes is Cresselia
  ("Crescent Purge" +80 if you flip a face-down Prize face-up). Face-up
  prize tracking would be the right fix; Cresselia's bonus is
  intentionally not modeled (logged but no damage applied).

**High:**
- `state.log: LogEntry[]` grows unbounded across turns. Real but
  smaller-impact than originally framed: the AI clone strips the log,
  and ~50 turns × ~10 entries × ~100 bytes ≈ 50KB. Cap to last ~30
  entries if you want to be tidy; not urgent.
- UX — pre-attack confirm on coin-flip-heavy attacks. Debatable: real
  TCG doesn't allow attack-undo either; current behavior is
  "successful attack locks the undo stack." Not obviously wrong.
  (Boss's Orders / Counter Catcher / Retreat misclicks are already
  recoverable via the per-action Undo stack — superseded by the Undo
  fix.)

**Low:**
- Discard pile `onClick` without keyboard handler (Enter/Space) —
  not keyboard-navigable.
- Mobile bench horizontal scroll has no visual overflow hint.
- No in-game rules glossary / help button.
- `AiActionBanner` can flash-and-vanish on fast AI steps.

**Test gaps (fix landed but not directly tested):**
- AI lookahead path through `pendingPromoteQueue` (`drainPending`
  iterates correctly by inspection; no integration test).
- Mid-queue game-over (queued player has no bench when dequeued).
- Non-terminal + terminal `pendingPromote` phase mixing.
- Passive attack/damage abilities firing in real `executeAttackHit`
  (helpers unit-tested; integration path not).

**Deferred AI work (Phases 2c, 2e, 7-12 of the AI overhaul plan):**
- **2c. Multi-action reordering** — replace fixed greedy step order
  with a score-then-pick loop (let supporter-search-then-evolve emerge
  when the search would unlock the evolve piece).
- **2e. Ability scoring tuning** — defaults at 50-65 across ~70 ability
  kinds; should be tuned per-impact via Phase 9 self-tuning.
- **7. Opp modeling** — route opp's MCTS-rollout moves through their
  detected archetype playbook instead of greedy.
- **8. Opening book from real tournament data** — hard-code first-3-turn
  sequences scraped from Limitless winning decklists; AI follows the
  book until divergence.
- **9. Self-tuning weights** — overnight AI-vs-AI loop that
  perturbation-searches the 20+ heuristic constants in `scorePosition`,
  archetype bonuses, etc.
- **10. Massive scenario suite** — expand from 12 → 200 handcrafted
  decision tests covering every canonical TCG decision point.
- **11. Game-log review pass** — manually read 100 AI-vs-AI logs,
  encode found mistakes as new heuristic rules / scenarios.
- **12. Self-play RL pipeline** — the only path to genuine
  tournament-level play. AlphaZero-style policy + value network,
  millions of self-play games, ~3 months + GPU. Out of scope here;
  documented as the future ceiling.

## Decks available

`src/data/decks.ts` — 4 curated archetypes (`festival-leads`,
`arboliva`, `alakazam`, `lucario-ex`). Custom decks via `decklistParser`
(PTCGL text), persisted to IndexedDB. The parser truncates over-cap
entries; `validateDeckForPlay` runs at the picker as defense-in-depth
and rejects ≠60-card / zero-Basic decks before they reach `setupGame`.

## Dataset refresh

`.claude/agents/pokemon-tournament-cards.md` refreshes the legal pool.
WebFetch was truncating ~90 cards/set; current snapshot fetched
directly from `raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data`.
2,693 cards, reg marks H/I/J, as of 2026-04-23.

## Conventions

- Comments explain **why**, not what. Identifiers name themselves.
- No defensive error handling at internal boundaries — trust the
  engine. Validate at system boundaries (user input, persistence).
- UI is dumb — all rule decisions live in `src/engine/`.
- Prefer editing existing files over adding new ones.
- `npm run typecheck` and `npm run test` must pass before commit.

## Working branch

Active: `pandabananastcg`. `main` tracks the deployable build.
