# TCGVibes Agent Guide

This repo is a browser-based Pokemon TCG simulator named `PandaBananasTCG`.
It is a Vite + React + TypeScript app with a pure mutable game engine,
Standard-format card data, curated decks, in-app deck importing/building,
AI opponents, Playwright smoke tests, PWA support, and a Capacitor iOS shell.

The codebase is not a generic card-game framework. It is a pragmatic Pokemon
TCG clone tuned around the Play! Pokemon Standard pool snapshot stored in
`data/pokemon/`, with many specific card text interactions wired directly into
engine helpers.

## Commands

Use Node 18+ locally. Amplify deploys use Node 20.

```bash
npm install
npm run dev        # Vite dev server on http://localhost:5173
npm run typecheck  # tsc -b --noEmit
npm run test       # vitest run
npm run e2e        # playwright test, starts/reuses dev server
npm run build      # typecheck + production Vite build
```

Before handing off behavior changes, run `npm run typecheck` and `npm run test`
when feasible. Run `npm run e2e` for UI boot/action-bar changes.

## Project Map

- `src/engine/` contains the game rules. Keep React and browser APIs out of it.
- `src/data/` loads/maps card data, parses decklists, validates preset decks,
  groups art variants, and persists user imports.
- `src/ui/` contains focused React UI components such as cards, in-play Pokemon,
  deck builder, and art variant picker.
- `src/App.tsx` is the main command surface and modal conductor. It wires user
  actions to engine functions, runs paced AI steps, manages undo, and renders
  the board.
- `data/pokemon/` is the legal-card dataset and refresh documentation.
- `data/tournament-replays/` is replay/opening-book input for AI archetype work.
- `docs/` contains living design notes for AI, effects, decks, tests, mobile,
  and open findings.
- `ios/` is generated Capacitor iOS scaffolding.

The existing `CLAUDE.md` is a dense project brief. This file is the agent-facing
working guide and should stay in sync with major architecture changes.

## Runtime Architecture

The app starts in `src/main.tsx`. It renders a loader, dynamically imports
`data/pokemon/tournament-legal-cards.json` through `loadCards()`, then mounts
`App`. The dataset is intentionally lazy-loaded so the heavy JSON does not sit
in the initial engine bundle.

`GameState` in `src/engine/types.ts` is the center of the world. Engine
functions mutate it in place. React keeps the current state in `stateRef`, then
forces rerenders after actions. Do not assume immutable Redux-style updates.

The high-level game flow is:

1. `setupGame()` creates players, shuffled decks, RNG, and `phase = "coinFlip"`.
2. `resolveCoinGuess()` records the toss winner.
3. `chooseFirstPlayer()` sets first player, deals opening hands, handles
   mulligans, and moves to setup.
4. `completeSetup()` chooses Active/Bench for each player and starts turn 1.
5. Main-phase commands call `actions.ts`: play Basic, evolve, attach Energy,
   play Trainer, retreat, activate abilities, attack, promote, or end turn.
6. `rules.ts` handles draw, checkup, KO/prizes, promotion queues, turn passing,
   and win conditions.

## Engine Boundaries

Keep rule decisions in `src/engine/`. UI may preview or highlight legal actions,
but the engine must remain the authority. When adding a legality rule, wire it
into the engine first, then have the UI read the same gate.

Important modules:

- `types.ts`: card schema, `AttackEffect`, `AbilityEffect`, pending picker
  shapes, player state, phases, log entries, and full `GameState`.
- `rules.ts`: setup, mulligans, energy payment, statuses, checkup, damage,
  KO/prizes, bench KOs, promotion queue, end turn, and draw/pass turn.
- `actions.ts`: public action API and attack pipeline. `attackPreflight()` is
  the single attack-legality gate used by both engine and UI.
- `effects.ts`: resolves detected attack effects and post-damage hooks.
- `trainerEffects.ts`: detects and applies Trainer effects, including many
  interactive picker flows.
- `abilities.ts`: detects abilities, activated abilities, triggered-on-evolve,
  triggered-on-bench, triggered-on-move, and gust logic.
- `ongoingEffects.ts`: passives, ability/tool/stadium gates, attack-cost and
  retreat-cost adjustments, energy pools, max HP, damage estimation, Tera bench
  immunity, status immunity, and tool triggers.
- `pendingPick.ts`: deck/search/top-peek/discard-recovery picker plumbing.
- `stadiumActivated.ts`: activated Stadium effects.
- `ai.ts`, `aiArchetype.ts`, `mcts.ts`: greedy AI, archetype-aware heuristics,
  and optional time-budgeted MCTS.
- `rng.ts`: seeded mulberry32 with `getState()`/`setState()` for deterministic
  undo and search.

## State And Phases

Common phases are `coinFlip`, `setup`, `draw`, `main`, `pick`,
`promoteActive`, and `gameOver`.

Pending state is explicit on `GameState`: `pendingPromote`,
`pendingPromoteQueue`, `pendingPick`, `pendingSwitchTarget`,
`pendingInPlayTarget`, `pendingHandReveal`, `pendingSearchNotice`,
`pendingRareCandyChoice`, `pendingHeavyBaton`, and `pendingSecondAttack`.

Promotion has two flavors:

- Terminal promotes from attack/checkup KO set `phase = "promoteActive"` and
  use `onPromoteResolved` to continue with `endTurn`, `passTurn`, or a Festival
  Lead second attack.
- Non-terminal promotes can keep `phase = "main"` so the player may continue
  resolving a card effect or turn sequence.

Use `setPendingPromote()` instead of setting promotion fields by hand. It
supports simultaneous or chained KOs through `pendingPromoteQueue`.

## Card Data

Raw data mirrors the Pokemon TCG API and is mapped in `src/data/cardMapper.ts`.
The only translation layer from raw API fields to engine cards should stay
there. Attack effects are not all detected at load time; `getAttackEffects()`
does lazy regex matching and caches results on the attack.

The dataset in `data/pokemon/` is a North America Standard snapshot with H/I/J
regulation marks and SVE basic energies. It includes JSON, CSV, legal-set
metadata, and refresh instructions. Card images are derived from Limitless TCG
CDN URLs in `cardImages.ts`.

Decklists use Limitless/PTCGL text:

```text
4 Dipplin TWM 18
```

`decklistParser.ts` maps Limitless set codes to local set codes, resolves by
printing first, falls back to name-only matches, enforces the 4-per-name cap
except Basic Energy, and reports Radiant/ACE SPEC issues.

Art variants are grouped by `gameplayKey()` in `cardEquivalence.ts`, not by
name alone. Different printings of the same mechanical card can swap art; same
name with different attacks/HP/text must remain distinct.

## Preset Decks

`src/data/decks.ts` defines 12 curated presets:

- Baseline: Festival Leads, Arboliva, Alakazam, Mega Lucario ex.
- Prague/community: Dragapult-Dudunsparce, Crustle, Cynthia-Garchomp,
  Mega Starmie-Dusknoir, Dragapult-Blaziken, Grimmsnarl-Froslass,
  Mega Starmie-Froslass, Hop's Trevenant.

`validatedDeckSpecs()` filters presets that do not resolve to playable 60-card
decks. `validateDeckForPlay()` protects game start from malformed custom decks.

## Rules Coverage

Implemented core rules include 60-card decks, 7-card setup, mulligans, 6 prizes,
rule-box prize values, 5-card bench, one Energy/Supporter/retreat per turn,
first-turn attack and Supporter gates with explicit exceptions, first-turn
evolution gates, Weakness/Resistance, all five Special Conditions, Checkup,
retreat/evolution status cleanup, Stadium replacement, Tools, bench KOs,
simultaneous Active KOs, deck-out, prize-out, and no-Pokemon win conditions.

Many card-specific effects are modeled. The current effect surface includes
roughly 70 attack effect kinds, roughly 70 ability effects/triggers, 100+
Trainer effects, many Stadium passives/activated effects, and around two dozen
Tools. `docs/EFFECTS.md` is the best index before changing effect behavior.

## Attack Pipeline

Use `attackPreflight()` for legality. It checks turn/phase, first-turn attack
ban, Debut Performance bypass, statuses, turn locks, per-attack locks, ability
gates such as Power Saver and Born to Slack, and effective energy cost.

`executeAttackHit()` in `actions.ts` handles damage and effects in a deliberate
order:

1. base attack damage
2. attacker-side Stadium/Tool/passive/turn bonuses
3. attack effect adjustments from `resolveAttackEffects()`
4. Weakness
5. Resistance
6. defender-side reductions and survival effects
7. damage application, on-damage hooks, post-damage effects, KOs, bench KOs

If you add damage math, check `estimateAttackDamage()` in `ongoingEffects.ts`
and AI scoring too. The attack button preview and AI both rely on estimators.

## Trainers, Abilities, And Pickers

Trainers are detected in `detectTrainerEffect()` and applied by
`applyTrainerEffect()`. Precondition checks belong in `precheckTrainerEffect()`
so cards fail before leaving hand.

Interactive effects generally use one of these paths:

- `pendingPick` for deck/search/top-peek/discard selection.
- `pendingInPlayTarget` for selecting Pokemon in play.
- `pendingHandReveal` for reveal-and-pick effects.
- `pendingSwitchTarget` for switch/promotion selection.
- `pendingRareCandyChoice` for choosing the Stage 2 after selecting a Basic.
- `pendingSearchNotice` for search acknowledgement/chain pauses.

AI paths should auto-resolve these where possible; humans should get a picker
when there is meaningful choice.

## AI

AI defaults to v1 greedy with one-ply lookahead for attack selection. v2
heuristics are enabled per `PlayerState.aiVersion` and can use archetype
playbooks from `aiArchetype.ts`. Optional MCTS is enabled by setting
`PlayerState.mctsBudgetMs > 0`.

`ai.ts` also resolves AI coin choices, setup, promotion, pending picks, ability
activation, trainer priorities, energy attachment, retreat/switching, attacks,
state cloning for search, and position scoring. MCTS uses determinized UCT over
atomic engine actions with progressive widening.

Be careful with search clones: clone helpers intentionally strip or simplify
expensive fields such as logs. If adding new mutable state to `GameState`, make
sure search/undo/serialization paths still preserve what matters.

## Undo And RNG

Undo is managed in `App.tsx`, not the engine. Before each undoable main-phase
human action, `snapshotForUndo()` serializes the state without RNG and stores
the RNG cursor via `rng.getState()`. Undo restores JSON state and rewinds the
live RNG with `setState()`.

Do not replace `rng` with `Math.random()` inside engine code. Any random action
that affects gameplay should consume `state.rng` so undo, tests, and AI search
stay deterministic.

Successful attacks clear the undo stack because attacks commit damage, KOs,
prizes, and opponent responses. Failed attacks leave undo intact.

## React UI

`App.tsx` is large and imperative by design. It keeps `GameState` in a ref and
uses a force rerender hook after engine mutations. Many click handlers read
live `stateRef.current` because memoized card components can otherwise hold
stale closures.

Major UI pieces:

- pre-game deck/mode modal
- coin flip and first-player choice modals
- setup and mulligan modals
- board, hands, discard viewers, card zoom
- action bar with attack previews, abilities, retreat, undo, end turn
- deck import modal
- lazy-loaded deck builder
- AI action banner and local hot-seat handoff modal

`CardView` memoizes cards and deliberately excludes `onClick` from its
comparator. It supports image fallback, shift/meta/right-click zoom, and touch
long-press zoom.

`DeckBuilderModal` is code-split with `React.lazy`. It filters all cards,
groups by gameplay equivalence, supports art selection through `VariantPicker`,
validates to 60 cards, and saves as persistable decklist entries.

## Styling, PWA, And Mobile

Styles live in `src/styles.css`. Mobile behavior includes safe-area padding,
touch-friendly controls, horizontal bench/hand scrolling, handoff/privacy for
local play, and narrow-width tightening. `index.html` uses `viewport-fit=cover`.

PWA support is configured in `vite.config.ts` with `vite-plugin-pwa`.
Production builds precache the app shell and dataset and runtime-cache
Limitless card images with CacheFirst. Service worker registration happens
after mount in production only.

Capacitor config is in `capacitor.config.ts`, with `webDir = "dist"` and app id
`com.pandabananas.tcg`. iOS files under `ios/` are mostly generated shell
files; avoid hand-editing generated project details unless the task is
specifically mobile/native.

## Tests

Vitest tests cover engine rules/effects/AI/decks/data/UI. The suite is broad
and the docs enumerate current files:

- Engine tests: game flow, energy, weakness, trainer/ability detection,
  ongoing effects, attack preflight, undo RNG, MCTS, preset deck smoke,
  Prague replay/archetype updates, community deck fixes, Hop's Trevenant, art
  variants, and many card-specific audit fixes.
- Data tests: decklist parser, effect pattern detection, card equivalence, and
  community deck validation.
- UI tests: CardView, AI pause, VariantPicker, DeckBuilder variants.
- Playwright e2e: boot path, Undo smoke, and mobile viewport sanity.

DOM tests opt into jsdom per file. Pure engine tests run in node. The AI
benchmark file is gated by `AI_BENCH`.

## Deployment

`amplify.yml` uses Node 20, runs `npm install --no-audit --no-fund`, then
`npm run typecheck` and `npm run build`, and serves `dist`. It long-caches
fingerprinted assets and keeps `index.html` revalidated.

Vite manual chunks split React and `src/engine/` into stable chunks. The deck
builder is separately lazy-loaded.

## Working Conventions For Agents

- Preserve the engine/UI boundary: rules in engine, rendering in React.
- Prefer existing helpers over duplicating card-rule logic.
- Do not group cards by name when mechanical identity matters; use
  `gameplayKey()`.
- Route attack payability through `effectiveAttackCost()` and
  `energyPoolForCost()`, not raw attack cost.
- Route retreat through `effectiveRetreatCost()`.
- Route ability suppression through `abilitiesActiveOnInstance()` when the
  source instance matters.
- Use `applyEvolveSideEffects()` for every evolution path, including Rare
  Candy-like effects.
- Use `setPendingPromote()` for KOs and promotion queues.
- Use `state.rng` for gameplay randomness.
- Add prechecks before removing a Trainer from hand.
- If an effect can require a human choice, model the pending picker shape and
  keep AI auto-resolution in step.
- When adding fields to `GameState` or `PokemonInPlay`, check clone/search,
  undo serialization, tests, and UI render dependencies.
- Keep comments focused on rule quirks and ordering reasons.
- Do not casually edit generated iOS project files, card datasets, or lockfile
  churn unless the task requires it.

## Known Open Work

See `docs/FINDINGS.md` before starting cleanup work. Current notable items:

- `state.log` grows unbounded, though AI clones strip logs and the size is not
  urgent.
- Some accessibility polish remains, such as discard-pile keyboard handling.
- There are deferred AI phases for action reordering, tuning, opponent modeling,
  larger scenario suites, game-log review, and possible future RL work.

## Quick Orientation For New Tasks

For a new card effect, start in `docs/EFFECTS.md`, then inspect
`effectPatterns.ts`, `effects.ts`, `trainerEffects.ts`, or `abilities.ts`
depending on card type. Add or update focused tests near the existing
card-specific suites.

For a rules bug, start with `types.ts`, `rules.ts`, `actions.ts`, and
`ongoingEffects.ts`. Confirm whether the UI is only previewing the rule or
accidentally making an independent decision.

For a deck/import issue, start with `decklistParser.ts`, `decks.ts`,
`cardEquivalence.ts`, and the `src/data/__tests__/` files.

For UI flow problems, start in `App.tsx` and the component under `src/ui/`.
Watch for pending modal state, local hot-seat handoff, AI pause conditions,
and stale memoized click closures.
