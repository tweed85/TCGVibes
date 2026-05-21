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
    types.ts          Barrel — re-exports from types/{cards,effects,pending,core}.ts
    types/
      cards.ts        EnergyType, Supertype, StatusCondition, Card schema,
                        Attack, Ability + AbilityEffect / AbilityCondition
      effects.ts      AttackEffect, AttackPredicate, PokemonFilter,
                        AttackSearchFilter (data-driven dispatch unions)
      pending.ts      PendingPick / PendingInPlayTarget / PendingChoiceMenu /
                        PendingHandReveal / PendingSearchNotice /
                        DeckSearchChainStep + their *EffectKind unions
      core.ts         GameState, PlayerState, PokemonInPlay, Phase,
                        TurnAttackBonus, TurnDamageReduction, StadiumInPlay,
                        CoinFlipState, LogEntry, GameRng
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
    aiConfig.ts       Central registry of AI / MCTS tunable constants
                        (CANDIDATE_BAND, ACTIVE_OHKO_*, GUST_*, MCTS_*,
                        plus grouped AI_CONFIG object)
    aiArchetype.ts    Archetype detection + bonuses + T1-T3 playbooks
    mcts.ts           Determinized UCT, action-level tree, depth=0 leaf
    rng.ts            Seeded mulberry32 with getState/setState
    gameCommands.ts   GameCommand union + applyGameCommand dispatcher
                        (replay backbone)
    replay.ts         GameReplayV1/V2 schema, newReplay, loadReplay,
                        finalizeReplayIfDone, REPLAY_SCHEMA_VERSION
    preflight.ts      canBenchBasic/canEvolve/canAttachEnergy/...,
                        precheckAbility, precheckStadium, canEndTurn
    prompts.ts        PendingPrompt union + activePrompt(viewer)
    effectPrefabs.ts  searchDeckToBench/Hand, recoverFromDiscardToHand
  data/
    cards.ts          Lazy dynamic import()
    cardMapper.ts     API → engine types
    cardEquivalence.ts gameplayKey() canonical "same card different art"
    decklistParser.ts PTCGL importer (caps >4 copies at parse time)
    decks.ts          Curated + community decks + validateDeckForPlay
    persistence.ts    idb-keyval storage: imported decks + completed
                        replays (StoredReplay rows)
    identity.ts       Anonymous device-scoped UUID (cloud upload)
    replayUpload.ts   Supabase upload (lazy-loaded @supabase/supabase-js)
    effectPatterns.ts
  ui/CardView.tsx     Card + in-play renderers (memoized)
  ui/DeckBuilderModal.tsx
  ui/VariantPicker.tsx Modal: pick which printing of a card to use
  ui/ReplayHistoryModal.tsx  Past games + Download/Delete/Upload (lazy)
  App.tsx              Includes inline GameInspector right-rail panel,
                        outcome useEffect, CloudConsentModal
  styles.css           .game-layout grid + inspector + action-bar
  test-setup.ts       Loads dataset + jest-dom matchers
supabase/migrations/0001_replays.sql   Cloud replay table + RLS
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
  Actions spawned mid-attack (Phantom Dive, Aura Jab) carry a
  `finishTurn` flag; `finishHit` defers `endTurn` while a human picker
  is open and `resolveInPlayTarget` runs it on the final click.
- **Stable picker identity** — `PendingPickEffectKind`
  (`preciousTrolley` / `energySearchPro` / `academyAtNight` /
  `prismTower` / `mysteryGarden` / `levincia` / `grandTreeStage1` /
  `grandTreeStage2` / `glassTrumpetEnergyPick`) is set on `PendingPick`
  and `PendingHandReveal` via the `effectKind` field, joining the
  existing `PendingInPlayTarget.action.kind` discriminator. AI lanes
  and tests route off these kinds — never `label` text, which is
  display-only and shifts without notice. `setDeckSearchPick` takes
  `effectKind` as a builder option; in-place picks set it directly.
- **Optional-prompt skip commands** — Optional picker steps with a
  card-specific cleanup (Prime Catcher self-switch, Glass Trumpet
  attach) ship explicit `GameCommand` kinds (`skipPrimeCatcherSelfSwitch`,
  `skipGlassTrumpetAttach`) so replay exports don't stall on the
  prompt. Glass Trumpet's skip returns any queued (discard-pulled)
  Energy to the discard pile; the action-bar Cancel button is wired
  to route through `skipGlassTrumpetAttach` instead of plain
  `cancelInPlayTarget` so queued Energy never leaks. Optional
  `PendingPick` steps (Grand Tree Stage 2) use `min: 0` so the existing
  picker UI's Skip button covers them without a dedicated command.
- **AI turn = candidate-generator loop (Phase 3E).**
  `tryStepAiTurn` runs `tryImmediateWinningLine` (Phase 3A: take the
  game-winning attack or gust before any setup), then enumerates ranked
  action candidates from category-specific generators
  (`enumerateBenchBasicCandidates`, `enumerateItemCandidates`,
  `enumerateAbilityCandidates`, `enumerateEvolutionCandidates`,
  `enumerateSupporterCandidates`, `enumerateStadiumCandidates`,
  `enumerateEnergyAttachCandidates`). Each candidate's score is
  `priority × CANDIDATE_BAND + localScore` (CANDIDATE_BAND = 10000)
  so the original priority bands are preserved while still allowing
  in-category score ordering. Non-candidate fallbacks (tools,
  low-threshold Supporters, defensive/offensive retreat) run after
  the loop. ACE SPEC items need score ≥ 75 (vs 40 for regular Items)
  via `isAceSpec` predicate in the picker threshold callback.
- **`scorePosition` = parity-extracted leaf eval.** Seven named
  sub-scores: `scorePrizeRace`, `scoreImmediateThreats`,
  `scoreAttackReadiness`, `scoreBoardDevelopment`,
  `scoreResourceQuality`, `scoreBenchRisk`, `scoreDisruptionTiming`.
  Load-bearing constants (`ACTIVE_OHKO_BASE_PENALTY = 60`,
  `ACTIVE_OHKO_PRIZE_PENALTY = 80`, plus opp-side bonuses) carry
  provenance comments. v2-only overlays layered inside each helper:
  spread-aware bench risk (`opponentHasBenchSpreadThreat` +
  `shouldBenchBasicNow` gate the bench-play action), gust threat /
  bench-counter mitigation / game-winning escalator in
  `scoreImmediateThreats`, active-can-attack-now +
  evolution-in-hand-unlock in `scoreAttackReadiness`.
- **12 archetype playbooks fully wired.** All 12 detected archetypes
  in `aiArchetype.ts` (festival-leads, arboliva, alakazam, lucario-ex,
  rocket-mewtwo, dragapult-blaziken, dragapult-dudunsparce, crustle,
  cynthia-garchomp, grimmsnarl-froslass, mega-starmie-froslass,
  hops-trevenant) have T1–T3 `cardBonus` weights and
  `abilityBonus` entries. Dragapult variants prioritize
  Dreepy/Drakloak/Rare Candy paths; Crustle prioritizes wall-first
  heals (Powerglass / Berry tools / Sparkling Crystal). Playbook
  bonuses reach the search-pick scorer, attach-target scorer, and
  Phase 5E evolution scorer.
- **Target scorers (Phase 5).** Named v2 scorers for gust target
  (`bestGustTarget` — last-prize KO + ramp-engine + future-threat +
  full-protection penalty), Energy attach (`scoreEnergyTarget` —
  next-turn-reachable attacks + acceleration support + OHKO-range
  waste penalty), search target (`scorePickedPokemon`/`scorePickedEnergy`
  — evolution completion + bench-ready Basics + energy-type-gap-closers),
  bench target (`findPrimaryBasic` — archetype + evolution-base +
  attacker-readiness), evolution target (`pickBestEvolution` —
  archetype + ability-unlock bonuses), attack choice
  (`attackValue` — mid-game prize-swing bonus + bench-attacker
  backup), and spread/counter placement (`placeCountersOnOppBenchAny`
  in `effects.ts` — KO-priority + rule-box-close-to-KO +
  engine-piece names + most-damaged fallback).
- **Multi-agent coordinator workflow.** `scripts/ai-coordinator/`
  ships `digest.mjs` (post-edit verification + Schema A QA append),
  `handoff.mjs` (cross-agent inbox messages + async chain-fire),
  `session-start.mjs` (inbox tail + actionable TODOs surfaced on
  Claude Code SessionStart hook), and `dashboard.mjs` (live
  peer-process visibility, `--watch` mode rewrites `ai/dashboard.md`
  every 3s). `.claude/settings.json` hooks: PostToolUse typecheck on
  source edits, Stop runs digest + dashboard, SessionStart surfaces
  inbox. Claude→Codex / Codex→Claude chain-fires use detached
  spawning with per-session logs under `ai/peer-sessions/`. Auth
  pre-checks (claudeIsAuthenticated / codexIsAuthenticated)
  short-circuit before spawn when CLIs aren't logged in.
  Coordination files (`ai/PROJECT_STATE.md`, `ai/TODO.md`,
  `ai/QA.md`, `ai/inbox.md`, `ai/agent_ownership.md`,
  `ai/agent_recommendations.md`) follow Schema A/B/C parseable
  formats; the AI build plan is now fully complete through Phase 5.
- **Drag-and-drop: hand → in-play.** `useCardGesture` in
  [CardView.tsx](src/ui/CardView.tsx) is one state machine for tap +
  long-press-zoom + drag, dispatched off pointerdown: move >8px before
  500ms → DRAG, hold 500ms without movement → ZOOM, otherwise CLICK.
  Pointer capture keeps move/up firing on the source card so
  `clientX/Y` stays valid as the cursor crosses drop targets. App tags
  in-play tiles + empty bench slots with `data-droptarget="my:inPlay:<id>"`
  / `"my:bench:empty"`; `dispatchHandToInPlay` resolves drops via
  `document.elementFromPoint → closest("[data-droptarget]")` and routes
  to the same engine functions the click flow calls (`attachEnergy`,
  `evolve`, `playTrainer({ kind: "inPlay" })`, `playBasicToBench`).
  The drag pre-populates `selected` so the existing `legalTargets`
  memo lights up legal targets without duplicating its logic. A
  `.drag-ghost` portal in `document.body` follows the pointer.
  `<img draggable={false}>` + `pointer-events: none` on the hand-card
  image prevents the browser's native HTML5 drag from swallowing
  pointermove. Click flow stays as fallback for accessibility. **Touch
  input is excluded from the drag path** (gated on `pointerType !==
  "touch"` at the drag-promote check): on phones the finger covers the
  card + drop targets, so touch users fall through to the click flow.
  2-in-1 devices still get drag for the mouse — pointerType is
  per-event, not global.
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
- **Effective type / weakness math.** Runtime weakness math reads
  `effectiveTypes(attacker)` and `effectiveWeaknesses(defender, state)`
  rather than raw card types / weaknesses, so Fairy Zone (Dragons gain
  Psychic weakness) and type-rewriting abilities (Double Type, Dual
  Core) match between attack resolution and the AI / UI damage
  estimator.
- **Game layout = board + inspector rail.** `.game-layout` is a
  responsive grid: desktop pairs the play field with a right-side
  `GameInspector` (selected card or current Active — HP meter, energy /
  tool / status chips, attack previews, recent log); tablet / mobile
  collapse to a single column. The header collapses deck controls into
  a `Game` `<details>` menu (build / import / change / export) and only
  shows them pre-game. The log lives in the inspector, not the hand
  strip. The action bar has a status line, turn-resource chips
  (Energy / Supporter / Retreat), and an attack button with damage
  preview; on mobile it sticks as a bottom sheet. While `preGameOpen`
  is true, the SetupModal, AiActionBanner, opponent strip, and winner
  overlay are gated off so nothing leaks behind the lobby; the
  SetupModal additionally waits on `mulliganNoticeDismissed` so the
  mulligan toast clears before the setup hand reveals.
- **Mobile viewport hardening.** Mobile cascade lives at the END of
  [styles.css](src/styles.css) so it wins against the Arcade theme
  block that redefines card tokens above. Pattern: `min-width: 0` +
  `max-width: 100%` on every flex container in the app shell
  (`.app`, `.header`, `.opp-strip`, `.game-layout`, `.board`,
  `.side`, `.divider-band`, `.my-hand`, `.action-bar` and their
  child groups) so a single long token can't blow out the viewport.
  Modals use `svh` units with a `@supports not (height: 100svh)`
  `vh` fallback so iOS Safari's collapsing chrome doesn't clip
  content. Breakpoint ladder: ≤900px, ≤640px, ≤480px (home-tiles
  collapse + bottom-nav clearance), ≤360px (narrow iPhones), plus
  600–1024px portrait (tablet) and short-landscape phones
  (≤500px tall × ≤900px wide) get dedicated card-token sizes. Hand
  cards set `touch-action: none` + `-webkit-user-drag: none` +
  `pointer-events: none` on the inner `<img>` so the browser's
  native HTML5 drag can't swallow pointer events. The modal
  backdrop pads with `max(10px, env(safe-area-inset-*))` for
  notched devices. When adding new responsive rules, append to
  this block — don't interleave with Arcade theme overrides above.
- **KO cause attribution.** `knockOut` takes a `KoContext` so
  opponent-attack-only effects (Legacy Energy, Heavy Baton + Amulet of
  Hope discards, Lillie's Pearl prize reduction, Final Chain, Infinite
  Shadow) only fire when `applyDamage` calls it with
  `{ byOpponentAttack: true }`. Self-KOs from recoil / status / Cursed
  Blast no longer trigger them.
- **Deck builder = readable tiles + side-rail preview.** Grid uses
  medium tiles (~110px wide, 5:7 aspect ratio) — readable card text
  without losing scan density. The right rail pins a large
  `.builder-preview` block above the deck list that swaps to whichever
  tile (or deck-list row) the user hovers / focuses. Right-click still
  opens the existing fullscreen zoom. Mobile (≤768px) keeps the
  Browse / Your-deck tab toggle.
- **Card images: English-first with Japanese fallback.**
  [cardImages.ts](src/data/cardImages.ts) maps the local pokemon-tcg
  set codes to Limitless's English TPCi CDN
  (`tpci/<SET>/<SET>_<NNN>_R_EN_LG.png`, zero-padded number). For
  sets whose English images haven't landed on Limitless yet (e.g.
  `me4` / Chaos Rising — releases 2026-05-22), a parallel
  `SET_CODE_TO_LIMITLESS_JP` map points at the Japanese TPC bucket
  (`tpc/<SET>/<SET>_<N>_R_JP_LG.png`, NOT zero-padded, JP suffix).
  JP entries take precedence; flip a set EN-side by removing it from
  the JP map and adding to the EN map.
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
- **Replay capture + outcome.** Every successful `GameCommand` appends
  to `replayRef` in `App.tsx`. On `state.phase === "gameOver"` a
  render-keyed `useEffect` runs the pure `finalizeReplayIfDone` helper
  (idempotent; injectable clock for tests) to stamp `outcome.winner /
  completedAt / gameMode`, then `saveReplay()` lands the row in IDB.
  Catches AI-driven endings that bypass `handle()`. Schema is v2 with
  a v1 acceptance shim; loader takes `unknown` and validates.
- **Cloud replay aggregation (opt-in).** Toggle in the Game menu fires
  `uploadReplay()` after each completed game; Supabase client is
  lazy-loaded so the dep is in its own chunk, not the boot bundle.
  Anonymous `client_id` is a UUID stored at `tcgvibes.clientId.v1`.
  Anon clients can INSERT only (no SELECT, table CHECK + RLS enforce
  schema-v2 / valid winner / 200KB cap). Local delete does NOT
  propagate to the cloud — consent modal says so explicitly.

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

## Working principles

### Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

### Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

### Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

### Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

### Rule 5 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

### Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

### Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

### Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

### Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

### Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

### Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

### Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

## Where to look

For task-specific deep dives, read the relevant docs/ companion:

- **Effect coverage** (attacks / abilities / trainers / stadiums / tools, ~85 effect kinds incl. Chaos Rising additions, ~24 tools, special interactions; prefab layer for new card work): see [docs/EFFECTS.md](docs/EFFECTS.md)
- **AI internals** (v1 greedy, v2 archetype-aware heuristics, MCTS, the 12 wired archetype playbooks, measured win rates): see [docs/AI.md](docs/AI.md)
- **Deck library** (12 curated decks: 4 baseline + 8 Prague Regional 2026 community lists; deck-builder gameplay-equivalence grouping; dataset refresh): see [docs/DECKS.md](docs/DECKS.md)
- **Test suite** (~938 vitest + 5 Playwright e2e — full enumeration with what each file covers): see [docs/TESTS.md](docs/TESTS.md)
- **Replay determinism contract + cloud aggregation** (schema versions, v1→v2 migration, what's recorded vs not, opt-in upload): see [docs/REPLAY.md](docs/REPLAY.md) and [docs/REPLAY_BACKEND.md](docs/REPLAY_BACKEND.md) for the Supabase setup recipe
- **Twinleaf-inspired phases + v2 follow-ups** (preflight, prompt adapter, prefabs, replay, cloud aggregation — status table): see [docs/TWINLEAFGG_IMPLEMENTATION_PLAN.md](docs/TWINLEAFGG_IMPLEMENTATION_PLAN.md)
- **Mobile / iOS / offline** (Capacitor, PWA, responsive CSS, safe-area hardening; iPhone viewport QA matrix — 320×568 / 375×667 / 390×844 / 430×932 + landscape, plus the `documentElement.scrollWidth` vs `clientWidth` diagnostic, plus the Safari → Chrome → Firefox → Edge/Brave → PWA-installed → Capacitor WKWebView manual pass): see [docs/MOBILE.md](docs/MOBILE.md)
- **Open findings + deferred AI work** (MVP scope cuts, pressure-test findings, Phase 6 + 7-12 of the AI overhaul plan): see [docs/FINDINGS.md](docs/FINDINGS.md)
- **CPU AI build plan** (Phases 0–5 ✅ complete; Phase 6 deferred pending cloud-replay corpus): see [docs/AI_CPU_BUILD_PLAN.md](docs/AI_CPU_BUILD_PLAN.md)
- **Multi-agent coordinator workflow** (Claude + Codex handoff protocol, file schemas, hook config, live dashboard): see [ai/agent_recommendations.md](ai/agent_recommendations.md)

## Working branch

Active: `pandabananastcg`. `main` tracks the deployable build.
