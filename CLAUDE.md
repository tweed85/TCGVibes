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
    actions.ts        play/evolve/attach/retreat/attack/playTrainer/promote,
                        attackPreflight, T1_SUPPORTER_EXCEPTIONS
    effects.ts        Attack effect resolver
    trainerEffects.ts Trainer dispatch (incl. arianaDrawUntilTR,
                        protonSearchBasicTR, ltSurgeBargain,
                        raifortPeek5Discard)
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
  disabled + tooltip on the attack button.
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
  Ancient Booster Energy Capsule (Ancient Pokémon).
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

## Effect coverage (2,693-card pool)

- **Attacks**: ~70 effect kinds — coin-flip variants, per-energy /
  per-bench / per-counter scaling, status, heal, snipe, multi-target,
  draw, locks, retreat manipulation. Bespoke: `distributeDamage`
  (Phantom Dive / Oil Salvo, interactive picker with "— N left"
  progress), `placeCountersPerHandCard` (Powerful Hand, W/R bypass),
  copy-attack pipelines, `discardDefenderEndOfOppNextTurn` (Corrosive
  Sludge), `bothActiveKnockedOut`, `attachNFromDiscardToBench`
  (Aura Jab, interactive), **`perPokemonFilter`** (Spidops Rocket
  Rush — multiplicative "N×" form correctly zeros base damage),
  `benchSnipe` with `target: "allOpponents"` hits opp Active too
  (W/R applied) plus bench (no W/R) — Frosmoth Chilling Wings, TR
  Arbok Spinning Tail.
- **Abilities**: ~70 activated + triggered-on-evolve / -on-bench /
  -on-move-to-active / -on-move-to-bench. Highlights: `attachEnergy
  FromHandThenDraw` (Teal Dance), `moveDamageOwnToOpp` (Adrena-Brain,
  interactive), `putCountersOnOppThenSelfKO` (Cursed Blast,
  interactive). Triggered: Jewel Seeker, Psychic Draw, Heave-Ho
  Catcher, Cast-Off Shell, Multiplying Cocoon, Emergency Evolution,
  **Brambleghast Prison Panic** (Confused, not Asleep).
- **Trainers**: 100+ effects. Hilda + Dawn chained pickers,
  **Colress's Tenacity** (Stadium → Energy chain), **Salvatore**
  (interactive Evolution via `toEvolve`), **Perrin** (interactive
  hand-reveal → search same count via `useRevealedCount` postAction),
  **Team Rocket's Proton** (interactive search up to 3 Basic TR
  Pokémon; T1-bypassed), **Team Rocket's Ariana** (draw to 5, or 8
  if all in-play are TR), **Brock's Scouting** (Evolution branch when
  in-play has matching deck Evo, else 2-Basic search), **Lt. Surge's
  Bargain** (opp consents only when at 1 prize and would win, else
  user draws 4), **Raifort** (top-5 peek; pick any to discard, rest
  back on top — uses new `pickedDestination: "discard"` +
  `unpicked: "topOfDeck"` plumbing), **Potion / Super Potion**
  (interactive bench picker for the heal target), Unfair Stamp ACE
  SPEC, all Standard staples. AI keeps the auto-resolve path on each.
- **Stadiums**: most passives wired. Activated framework exists;
  per-Stadium UI buttons partial.
- **Tools**: ~22 — HP boosters, retreat helpers, damage boosters,
  berries with auto-discard, KO-triggered (Survival Brace, Lillie's
  Pearl, Amulet of Hope, **Heavy Baton** — interactive Bench-target
  picker that fires after the holder's owner promotes). On-damage
  hooks: Lucky Helmet, Punk Helmet, Deluxe Bomb, TR Hypnotizer,
  **Handheld Fan** (moves Energy from attacker to attacker's bench).
  Future-typed: **Future Booster Energy Capsule** (+20 damage, free
  retreat). Ancient-typed: **Ancient Booster Energy Capsule** (+60
  HP + status immunity + clears statuses on attach).
  HP-threshold helpers: **Rescue Board** (-1 retreat, free at HP ≤ 30).
  Self-discarding TM tools: **Technical Machine: Fluorite** (3-cost
  attack on holder; discards at end of turn; any tool whose name
  starts with "Technical Machine" auto-discards in `endTurn`).

## AI

Two AI versions, gated per-player by `PlayerState.aiVersion` (default
`"v1"`). MCTS is a separate opt-in via `PlayerState.mctsBudgetMs > 0`.

**v1 (always-on):**
- Greedy step loop + 1-ply lookahead minimax for attack choice (clone
  via shallow-clone, opp greedy turn, our greedy follow-up, score via
  `scorePosition`). Damage estimator includes passive bonuses /
  reductions / Stadium / Tool / turn-scoped modifiers in the same
  order as `executeAttackHit`.
- Opp-aware promote selection; `tryDefensiveRetreat` /
  `tryOffensiveSwitch`.

**v2 heuristics (fast, no extra search):**
- Archetype awareness (Festival Lead, Arboliva, Alakazam, Mega
  Lucario): per-archetype bonuses on signature Trainers, Energy-attach
  targets, bench Basics, abilities. Plus T1-T3 turn-aware playbooks
  in [aiArchetype.ts](src/engine/aiArchetype.ts).
- Threat-aware `scorePosition`: penalize positions where our Active
  is in opp OHKO range (scaled by prize at risk); reward symmetric
  bonus for opp; count "ready bench attackers" (≥cost-1 energy + a
  payable attack).
- Smart gust targeting — `bestGustTarget` boosts ramp engines
  (Bibarel, Dudunsparce, Fan Rotom, Teal Mask Ogerpon ex, etc.).
- Non-linear endgame prize weighting (4→6 worth more than 0→2).
- Endgame solver: when prizes ≤ 2, MCTS budget scales 4×.

**MCTS (opt-in):**
- Determinized UCT in [mcts.ts](src/engine/mcts.ts) — action-level
  tree, lazy expansion with progressive widening (top-K=8),
  per-iteration RNG re-seed.
- Action space: atomic engine actions.
- Depth=0 leaf eval (just `scorePosition` — no greedy playout, since
  per-iteration cost would otherwise drop iterations to 1-2).
- Time-budgeted; falls back to greedy on exhaustion.
- `lookaheadActive` re-entrancy guard prevents recursion.

**Measured win rates** (full N=50, 800 games each, 2026-04-28):

| Configuration | Win rate (p1) |
|---|---:|
| v1 vs v1 baseline | 53.0% (going-first edge ✓) |
| v2 heuristics vs v1 | 52.8% (≈ neutral) |
| **v2 + MCTS vs v1** | **65.5%** (+12.5pp) |

MCTS dominates in mirror matchups + Alakazam-driven games (decisions
compound). Lucario matchups stay flat — Lucario's plan is prescriptive
enough that greedy already plays it well.

## Test suite

- **Vitest — 296 tests across 23 files** (+ 3 AI_BENCH-gated).
  - `src/engine/__tests__/`: abilityDetection, dawnChain, energy,
    gameFlow, integration, ongoingEffects, presetDeckSmoke,
    trainerDetection, weakness, undoRng, undoIntegration,
    phantomDiveHuman, attackPreflight, unspentTurnSlots, mvpPickers,
    aiScenarios, mcts, aiBenchmark (gated), **teamRocketCards**
    (Spidops base damage, Ariana conditional draw, Proton T1 bypass
    + TR-Basic search), **auditFixes** (Carmine T1 / Prison Panic
    Confused / allOpponents Active / Potion + Super Potion pickers
    / Raifort / Lt. Surge's Bargain / Brock's branching / Future +
    Ancient Boosters / Rescue Board HP-threshold / TM Fluorite).
  - `src/data/__tests__/`: decklistParser, effectPatterns.
  - `src/ui/__tests__/`: CardView (energy-pip glyphs), aiPause
    (modal-pause useEffect under fake timers).
- **Playwright — 3 e2e tests in `e2e/smoke.spec.ts`.** Headless
  Chromium against the dev server: boot path, Undo round-trip, mobile
  viewport (375px) sanity.

DOM tests opt into jsdom via `// @vitest-environment jsdom` per file
(RTL + jest-dom matchers loaded by `test-setup.ts`); pure-engine tests
stay in node. `npm run test` / `npm run test:watch` / `npm run e2e`.

## Mobile / iOS / offline

- Capacitor scaffolded; `npx cap add ios` builds `dist/` into a
  WebView shell.
- PWA via vite-plugin-pwa: CacheFirst dataset + CDN images,
  NetworkFirst shell.
- Deck imports persist to IndexedDB; UI settings to localStorage.
- Mobile-responsive CSS: floating Stadium overlay, horizontal bench
  scroll with right-edge fade mask, right-to-left hand scroll with
  fade + scroll-snap, vertical action bar.
- Touch + safe-area hardening: `env(safe-area-inset-right)` baked
  into `.side` padding (clears iPhone X+ landscape notch and iPad
  Pro rounded corner); `touch-action: manipulation` on every
  interactive; landscape phones use 40px action-bar button minimum.
- Side-distinction tinting: opponent has a slightly darker bg + 1px
  red top accent.
- Narrow-width tightening (≤360px): pip min-width 14px,
  HP-badge font 11px; modal padding drops to 10px.
- Status-message dwell: ≥2.5s before allowing overwrite.

## Open pressure-test findings

Not yet addressed.

**MVP scope cuts (intentional / verified-not-applicable):**
- Fossils not modeled as 60-HP Basics — pool has 0 fossil-line
  Pokémon, so wiring the play-as-Basic mechanic gives nothing useful
  to evolve into. Deferred until pool gets a fossil-line Pokémon.
- No prize-pick UI (top prize always taken). Only legal-pool card
  that interacts with specific prizes is Cresselia ("Crescent Purge"
  +80 if you flip a face-down Prize) — bonus intentionally not
  modeled (logged but no damage applied).

**High:**
- `state.log: LogEntry[]` grows unbounded across turns. Real but
  smaller than originally framed — AI clone strips the log, ~50KB
  total. Cap to last ~30 entries if you want to be tidy; not urgent.
- UX — pre-attack confirm on coin-flip-heavy attacks. Debatable: real
  TCG doesn't allow attack-undo either; current behavior is
  "successful attack locks the undo stack." Boss's Orders / Counter
  Catcher / Retreat misclicks are recoverable via per-action Undo.

**Low:**
- Discard pile `onClick` without keyboard handler (Enter/Space).
- Mobile bench scroll has no visual overflow hint.
- No in-game rules glossary / help button.
- `AiActionBanner` can flash-and-vanish on fast AI steps.

**Test gaps (fix landed but not directly tested):**
- AI lookahead path through `pendingPromoteQueue`.
- Mid-queue game-over (queued player has no bench when dequeued).
- Non-terminal + terminal `pendingPromote` phase mixing.
- Passive attack/damage abilities firing in real `executeAttackHit`
  (helpers unit-tested; integration path not).

**Deferred AI work (Phases 2c, 2e, 7-12 of the AI overhaul plan):**
- **2c. Multi-action reordering** — replace fixed greedy step order
  with a score-then-pick loop.
- **2e. Ability scoring tuning** — defaults at 50-65 across ~70 kinds;
  tune per-impact via Phase 9 self-tuning.
- **7. Opp modeling** — route opp's MCTS-rollout moves through their
  detected archetype playbook instead of greedy.
- **8. Opening book from real tournament data** — hard-code first-3-turn
  sequences from Limitless winning decklists.
- **9. Self-tuning weights** — overnight AI-vs-AI loop that
  perturbation-searches the 20+ heuristic constants.
- **10. Massive scenario suite** — expand from 12 → 200 handcrafted
  decision tests.
- **11. Game-log review pass** — manually read 100 AI-vs-AI logs,
  encode found mistakes as new heuristic rules / scenarios.
- **12. Self-play RL pipeline** — only path to genuine tournament-level
  play. AlphaZero-style policy + value network, millions of self-play
  games, ~3 months + GPU. Documented as the future ceiling.

## Decks available

`src/data/decks.ts` — 4 curated archetypes (`festival-leads`,
`arboliva`, `alakazam`, `lucario-ex`). Custom decks via `decklistParser`
(PTCGL text), persisted to IndexedDB. Parser truncates over-cap entries;
`validateDeckForPlay` runs at the picker as defense-in-depth and rejects
≠60-card / zero-Basic decks before they reach `setupGame`.

## Dataset refresh

`.claude/agents/pokemon-tournament-cards.md` refreshes the legal pool.
WebFetch was truncating ~90 cards/set; current snapshot fetched
directly from `raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data`.
2,693 cards, reg marks H/I/J, as of 2026-04-23.

## Conventions

- Comments explain **why**, not what.
- No defensive error handling at internal boundaries — trust the engine.
  Validate at system boundaries (user input, persistence).
- UI is dumb — all rule decisions live in `src/engine/`.
- Prefer editing existing files over adding new ones.
- `npm run typecheck` and `npm run test` must pass before commit.

## Working branch

Active: `pandabananastcg`. `main` tracks the deployable build.
