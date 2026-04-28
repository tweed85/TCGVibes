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
    ai.ts             Greedy step loop + 1-ply lookahead
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

- **Greedy step loop**: bench Basics → search Items → free abilities
  → evolve → bench → Supporter → Stadium → attach → switch → attack.
- **1-ply lookahead minimax**: clone state (`cloneStateForSearch`,
  rng/log stripped), apply candidate, opp greedy turn, our greedy
  follow-up, score via `scorePosition` (prizes ×250, HP ÷6, energy
  ×8, bench depth, terminal ±1M).
- **Damage estimator** includes passive bonuses/reductions, Stadium /
  Tool / turn-scoped modifiers — same order as real `executeAttackHit`.
- **Promote selection** opp-aware: penalize OHKO-able candidates
  (extra for ex/Mega), reward counter-OHKO.
- **Switch heuristics**: `tryDefensiveRetreat`, `tryOffensiveSwitch`.

## Test suite

- **Vitest — 247 tests across 19 files.**
  - `src/engine/__tests__/`: abilityDetection, dawnChain, energy,
    gameFlow, integration, ongoingEffects, presetDeckSmoke,
    trainerDetection, weakness, undoRng, undoIntegration,
    phantomDiveHuman, attackPreflight, unspentTurnSlots, mvpPickers
    (Colress / Perrin / Salvatore / Heavy Baton interactive paths).
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
