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
    rng.ts            Seeded mulberry32
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
vite.config.ts        manualChunks split, vite-plugin-pwa
```

## Architecture

- **Card schema mirrors the Pokémon TCG API**; `cardMapper.ts` is the only
  translation layer.
- **Effects are data-driven.** Attack text regex-matched on first use,
  cached as `AttackEffect[]`, dispatched by `kind`. Same pattern for
  trainer + ability effects. Unmatched text preserved for display.
- **RNG on `GameState`** — all flips/shuffles via `state.rng` for seeded
  reproducibility.
- **Lazy dataset load** via dynamic `import()` keeps the 1.5MB JSON out
  of the boot bundle.
- **Wild Growth–aware cost checks** route through `energyPoolForCost`.
- **Memoized React renders** — `CardView` uses a custom comparator
  excluding `onClick`; click handlers read `stateRef.current` to avoid
  stale closures over preserved memo state.
- **Interactive picker pattern** — `PendingInPlayTarget` carries an
  action discriminated union; `resolveInPlayTarget` re-arms the picker
  between clicks until `remaining` hits 0.
- **Pause states.** Terminal promotes (attack/checkup KO) set
  `pendingPromote` + `phase = "promoteActive"` and queue
  `onPromoteResolved` (`endTurn` / `passTurn` / `secondAttack`).
  Non-terminal promotes (Run Away Draw, Cursed Blast) keep
  `phase = "main"` so the player keeps the turn.
- **Promote queue.** `pendingPromoteQueue: PlayerId[]` handles
  simultaneous KOs (Houndoom Dark Pulse / `bothActiveKnockedOut`).
  All pause sites route through `setPendingPromote` so the queue stays
  consistent; `promoteBenchToActive` drains FIFO before running
  `onPromoteResolved`.
- **Centralized evolve cleanup.** `applyEvolveSideEffects(state, p)`
  is the single source for: clear statuses (Confused persists under
  Dizzying Valley), reset `abilityUsedThisTurn`, set `evolvedThisTurn`,
  clear `scheduledKoOnTurn` / `shieldedUntilTurn` /
  `cantAttackUntilTurn` / `noWeaknessUntilTurn`. Used by
  `actions.ts:evolve` and both Rare Candy paths.
- **Triggered abilities honor instance suppressors.**
  `fireTriggered{OnEvolve,OnBench,OnMoveToActive,OnMoveToBench}` use
  `abilitiesActiveOnInstance` (not the card-only
  `abilitiesActiveOn`), so Sticky Bind / Initialization / Midnight
  Fluttering suppress triggered abilities, not just activated ones.
- **AI estimator matches real damage.** `estimateDamage` applies
  `passiveAttackBonus` + `passiveDamageReduction` in the same order as
  `executeAttackHit`, so the lookahead sees the same numbers the
  attack pipeline produces.

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
  (Phantom Dive / Oil Salvo, interactive), `placeCountersPerHandCard`
  (Powerful Hand, W/R bypass), copy-attack pipelines
  (`useAttackFromOppDeckTop`, `useBenchedAllyNamedAttack`,
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
- **Trainers**: 100+ effects. Hilda + Dawn chained pickers, Unfair
  Stamp ACE SPEC, all Standard staples (Nest/Poké/Master/Ultra Ball,
  Buddy-Buddy Poffin, Tera Orb, Rare Candy, Boss's Orders, Pokémon
  Catcher, heals, hammers, etc.), turn-scoped buffs.
- **Stadiums**: most passives wired (Festival Grounds, Forest of
  Vitality, Dizzying Valley, etc.). Activated framework exists; per-
  Stadium UI buttons partial.
- **Tools**: ~18 — HP boosters, retreat helpers, damage boosters,
  berries with auto-discard, KO-triggered (Survival Brace, Lillie's
  Pearl, Amulet of Hope, Heavy Baton).

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

Vitest — **212 tests across 13 files**:
- `src/engine/__tests__/`: abilityDetection, dawnChain, energy,
  gameFlow, integration, ongoingEffects, presetDeckSmoke,
  trainerDetection, weakness.
- `src/data/__tests__/`: decklistParser, effectPatterns.
- `src/ui/__tests__/`: CardView (energy-pip glyph rendering), aiPause
  (modal-pause useEffect under fake timers).

Coverage includes cost matching, passive bonuses, full-game setup +
Checkup, every wired AttackEffect / Ability / Trainer detected, AI-vs-AI
smoke for every preset cartesian pair, and end-to-end scenarios for
trickier flows: Phantom Dive split, Aura Jab 3-pick, Hilda chain,
Unfair Stamp KO gate, Wild Growth doubling, T1 evolve gate,
`bothActiveKnockedOut` promote queue, Sticky Bind suppression,
Dizzying Valley confused-on-evolve, parser >4 truncation,
`validateDeckForPlay` rejection paths.

DOM tests opt into jsdom via `// @vitest-environment jsdom` per file
(RTL + jest-dom matchers loaded by `test-setup.ts`); pure-engine tests
stay in node for speed. `npm run test` / `npm run test:watch`.

## Mobile / iOS / offline

- Capacitor scaffolded; `npx cap add ios` builds `dist/` into a
  WebView shell.
- PWA via vite-plugin-pwa: CacheFirst dataset + CDN images,
  NetworkFirst shell.
- Deck imports persist to IndexedDB (`idb-keyval`); UI settings to
  localStorage.
- Mobile-responsive CSS: floating Stadium overlay, horizontal bench
  scroll, right-to-left hand scroll, vertical action bar.

## Open pressure-test findings

These came out of a multi-agent QA pass and are not yet addressed.

**MVP scope cuts (intentional):**
- Ultra Ball auto-picks first 2 cards to discard (no chooser).
- Per-Stadium activated-effect UI buttons not wired (framework only).
- Fossils not modeled as 60-HP Basics.
- A few multi-step Supporters auto-pick (Perrin, Cassiopeia,
  Salvatore, Colress's Tenacity).
- `snipeOne` auto-targets most-damaged (newer `distributeDamage` IS
  interactive).
- No prize-pick UI (top prize always).
- Heavy Baton auto-target primitive.

**High:**
- `state.log: LogEntry[]` grows unbounded across turns; in 50+ turn
  games it bloats the canonical state. Cap to last ~30 entries.
- UX — irreversible actions fire on first click with no confirm:
  Boss's Orders / Counter Catcher target picker, Retreat, End Turn
  (no "unspent energy" reminder), attack declaration on coin-flip
  attacks. Misclick on Boss's Orders can lose the game.
- UX — first-turn / status-blocked attack rejection is post-click.
  T1, asleep, paralyzed, `cantAttackUntilTurn` should disable the
  attack button + tooltip the reason instead of erroring after click.

**Low:**
- Discard pile `onClick` without keyboard handler (Enter/Space) —
  not keyboard-navigable.
- Mobile bench horizontal scroll has no visual overflow hint.
- No in-game rules glossary / help button (terms like "Pokémon
  Checkup" assumed familiar).
- `AiActionBanner` can flash-and-vanish on fast AI steps.

**Test gaps (fix landed but not directly tested):**
- AI lookahead path through `pendingPromoteQueue` (`drainPending`
  iterates correctly in theory, no integration test).
- Mid-queue game-over (queued player has no bench when dequeued).
- Non-terminal + terminal `pendingPromote` phase mixing.
- Passive attack/damage abilities firing in actual `executeAttackHit`
  (helper functions unit-tested; integration path not).

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
