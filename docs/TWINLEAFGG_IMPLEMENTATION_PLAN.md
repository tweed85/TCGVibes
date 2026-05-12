# Twinleaf.gg Implementation Plan

Source repo: https://github.com/the-epsd/twinleafgg

Purpose: turn the Twinleaf review into a Claude-ready implementation plan for the parts that fit TCGVibes. This is not a port plan. TCGVibes should keep its local-first React + TypeScript app, pure engine functions, seeded RNG, undo snapshots, Deck Doctor, and current card data model. Twinleaf is most useful as a reference for rules-engine structure, reusable effect helpers, prompts, replay infrastructure, card test ergonomics, and deck-editor polish.

## Status — all 7 phases shipped

| Phase | Status | What landed |
| ----- | ------ | ----------- |
| 4 — Test DSL | ✅ shipped | [`src/engine/__tests__/helpers/gameTestHelpers.ts`](../src/engine/__tests__/helpers/gameTestHelpers.ts) — `setupTestGame`, `playTrainerByName`, `attachEnergyByName`, `useAttackByName`, `useAbilityByName`, `resolvePickByName`, `expectDamage`. Routes through production action surface (does NOT bypass preflight). [`dslSmoke.test.ts`](../src/engine/__tests__/dslSmoke.test.ts) covers it. |
| 1 — Preflight | ✅ shipped | [`src/engine/preflight.ts`](../src/engine/preflight.ts) — `canBenchBasic / canEvolve / canAttachEnergy / canPlayTrainer / canRetreat / computePlayerPlayability`, re-exporting `attackPreflight`. `canPlayTrainer` shares logic with `precheckTrainerEffect`. App.tsx hand cards dim + tooltip the reason; gated by `PREFLIGHT_UI_ENABLED` constant. [`preflightContract.test.ts`](../src/engine/__tests__/preflightContract.test.ts) pins reason parity. |
| 7 — Format-aware legality | ✅ shipped | `format?: "Standard" \| "Expanded" \| "Retro"` field on `DeckInput` (defaults to Standard). `formatLimits()` helper makes ACE SPEC / Radiant gates ready to relax per-format. `format` cited at the report level, not per-finding. |
| 6 — Deck builder polish | ✅ shipped | Keyboard affordances: `/` focuses search, Enter / `+` add the previewed card, `-` removes a copy, Esc closes variant picker first then modal. Single global window keydown handler, skipped while typing in inputs. |
| 5 — Replay | ✅ shipped | [`src/version.ts`](../src/version.ts) (`APP_VERSION`), [`src/engine/gameCommands.ts`](../src/engine/gameCommands.ts) (`GameCommand` union covering 15 kinds incl. all user-resolvable prompts + dispatcher), [`src/engine/replay.ts`](../src/engine/replay.ts) (`newReplay`, `loadReplay`, schema with `appVersion`/`dataVersion`/`schemaVersion` and typed errors). [`replay.test.ts`](../src/engine/__tests__/replay.test.ts) — 6 tests including the every-prompt-has-a-command guard. See [REPLAY.md](REPLAY.md) for the determinism contract. |
| 3 — Effect prefabs | ✅ shipped | [`src/engine/effectPrefabs.ts`](../src/engine/effectPrefabs.ts) — `searchDeckToBench`, `searchDeckToHand`, `recoverFromDiscardToHand`. Buddy-Buddy Poffin / Energy Search / Lana's Aid migrated. [`prefabBehavior.test.ts`](../src/engine/__tests__/prefabBehavior.test.ts) — 6 direct-behavior pins written **before** migration so byte-equivalent is objectively verified. |
| 2 — Prompt adapter | ✅ shipped | [`src/engine/prompts.ts`](../src/engine/prompts.ts) — full 9-kind `PendingPrompt` union (deckPick / discardPick / inPlayTarget / switch / promote / handReveal / searchNotice / rareCandyChoice / heavyBaton). `activePrompt(state, viewer?)` projection adapter. Engine continuations (`pendingPromoteQueue`, `pendingSecondAttack`, `onPromoteResolved`) intentionally excluded. [`prompts.test.ts`](../src/engine/__tests__/prompts.test.ts) covers projection. |

Verified state at landing: `npm run typecheck` clean, `npm run test` 742 passed (3 skipped), `npm run e2e` 5/5, `npm run build` clean.

## v2 follow-ups — all 5 shipped

| Item | Status | What landed |
| ---- | ------ | ----------- |
| v2.1 — DSL → FINDINGS gaps | ✅ shipped | [`src/engine/__tests__/findingsGaps.test.ts`](../src/engine/__tests__/findingsGaps.test.ts) — 6 tests covering `pendingPromoteQueue` AI lookahead, mid-queue game-over safety net, non-terminal (Run Away Draw) + terminal (attack-KO) `pendingPromote` mixing, passive attack bonus + damage reduction firing through real `executeAttackHit` (Powerful a-Salt + Solid Shell). The four "fix landed but not directly tested" bullets removed from [FINDINGS.md](FINDINGS.md). |
| v2.2 — Replay recorder + export | ✅ shipped | Three new `GameCommand` kinds (`resolveCoinGuess` / `chooseFirstPlayer` / `completeSetup`) so replays can walk through setup. App.tsx wires `recordCmd` into coin / first-player / setup modals + every in-game handler (handClick, attack, retreat, endTurn, ability, useStadium, all 5 prompt resolvers). New `Export Replay` Game-menu button downloads the structured replay. [`replay.test.ts`](../src/engine/__tests__/replay.test.ts) round-trip test reconstructs phase / activePlayer / actives / hand and deck sizes after setup + endTurn. |
| v2.3 — ActionBar preflight expansion | ✅ shipped | Extracted [`precheckAbility`](../src/engine/abilities.ts) and [`precheckStadium`](../src/engine/stadiumActivated.ts); the production `activateAbility` / `useStadium` route through them and `preflight.ts` exposes thin wrappers (`canActivateAbility` / `canActivateStadium`) plus a fresh `canEndTurn`. ActionBar consumes `playability.retreat / .endTurn` for disable + tooltip. Contract test extended with parity for the three new helpers. |
| v2.4 — `activePrompt` prompt banner | ✅ shipped | Tightened `activePrompt(state, viewer)` to never fall back to opponent-owned prompts (privacy contract for hot-seat / open-hands-off). `InPlayTargetPrompt` now carries `remaining`; the adapter formats labels with `— N left` byte-identically to the prior `formatPickerLabel`. App.tsx renders an additive `.prompt-banner` above the action bar; the existing `statusMsg` cascade is untouched. |
| v2.5 — More prefab migrations | ✅ shipped | Confident batch (Nest Ball / Poké Ball heads branch / Night Stretcher) migrated to [`effectPrefabs.ts`](../src/engine/effectPrefabs.ts). Pre-migration behavior pins added to [`prefabBehavior.test.ts`](../src/engine/__tests__/prefabBehavior.test.ts) and verified byte-equivalent post-migration. Held for v3: Super Rod / Energy Recycler (need `recycleDiscardToDeck` prefab), Pokégear 3.0 (peek pattern, not search), Brock's Scouting (branchy). [EFFECTS.md](EFFECTS.md) now points new card work at the prefab layer. |

Verified state after v2 landing: `npm run typecheck` clean, `npm run test` 758 passed across 45 files (3 skipped), `npm run build` clean.

The phase content below is preserved as the original plan + reviewer-refined guidance, so future re-reads can audit what was intended versus what shipped.

## Non-goals

- Do not import Twinleaf's Socket.IO server, database layer, Angular client, or full card implementation set.
- Do not rewrite TCGVibes around a server-authoritative model.
- Do not copy Twinleaf assets or code without attribution. README/package mark the repo MIT, but verify license details before copying files directly.
- Do not attempt every phase in one branch. Each phase below should ship with focused tests and no broad card-behavior churn.

## Current TCGVibes Context

Relevant existing files:

- `src/engine/actions.ts` - main action functions and most rule guards.
- `src/engine/effects.ts` - attack-effect resolver.
- `src/engine/trainerEffects.ts` - trainer effect implementations.
- `src/engine/abilities.ts` - ability implementations.
- `src/engine/pendingPick.ts` - current interactive deck/discard/top-card picker system.
- `src/engine/types.ts` - engine state, cards, pending state types.
- `src/App.tsx` - action wiring, undo snapshots, pending pick UI.
- `src/ui/DeckBuilderModal.tsx` - deck builder, grouped printings, validation, side preview.
- `src/data/deckDoctor.ts` and `src/data/metaDoctor.ts` - deck analysis layers.
- `src/engine/__tests__/*` - broad mechanics tests; add helper DSL here before large new coverage.

## Phase 1: Playability Preflight

Twinleaf keeps a computed list of playable cards in hand. Add a TCGVibes-native version that tells the UI which actions are currently legal and why illegal actions are blocked.

### New module

Add `src/engine/preflight.ts`.

Suggested API:

```ts
import type { Card, GameState, PlayerId } from "./types";

export type PlayabilityKind =
  | "benchBasic"
  | "evolve"
  | "attachEnergy"
  | "playTrainer"
  | "playTool"
  | "rareCandy"
  | "retreat"
  | "attack"
  | "activateAbility"
  | "activateStadium";

export interface PlayabilityEntry {
  kind: PlayabilityKind;
  ok: boolean;
  reason?: string;
  card?: Card;
  handIndex?: number;
  instanceId?: string;
  targetInstanceIds?: string[];
}

export interface PlayerPlayability {
  player: PlayerId;
  hand: PlayabilityEntry[];
  attacks: PlayabilityEntry[];
  abilities: PlayabilityEntry[];
  retreat: PlayabilityEntry;
}

export function computePlayerPlayability(
  state: GameState,
  player: PlayerId,
): PlayerPlayability;
```

### Implementation notes

- Extract guard-only helpers from `actions.ts` where practical: `canBenchBasic`, `canEvolve`, `canAttachEnergy`, `canPlayTrainer`, `canRetreat`, `canAttack`.
- These helpers must not mutate state, draw/shuffle cards, open pending picks, consume RNG, or log events.
- The existing mutating actions should call the same guard helpers before mutating so UI preflight and action behavior do not drift.
- For target-dependent actions, return `ok: true` with `targetInstanceIds` when at least one legal target exists.
- For legal card but missing target, return a reason like "Choose a Pokemon to attach this Tool to." rather than marking the card permanently illegal.
- Do not call mutating action functions against cloned state as the preflight strategy. Many actions can open pending picks, shuffle, log, or trigger effects; guard extraction is safer.

### UI changes

- In `App.tsx`, compute playability for `viewingPlayer` with `useMemo`.
- Hand cards should use this for disabled/dim states and tooltips.
- Keep click handlers defensive: they should still call the real action and display the returned `ActionResult.reason`.
- Do not block drag affordances entirely if the card has legal target choices. Dim only truly illegal actions.

### Tests

Add `src/engine/__tests__/preflight.test.ts`.

Cover:

- Basic Pokemon playable to bench, blocked when bench is full.
- First-player turn-one Supporter blocked except current exceptions.
- Energy attach blocked after the one-per-turn slot is used.
- Evolution blocked by played-this-turn and first-turn rules, allowed by known exceptions.
- Trainer blocks from existing lock effects match `actions.ts`.
- Preflight does not mutate `GameState`, `rng.getState()`, hand size, deck order, or logs.

Acceptance:

- `npm run typecheck`
- `npm run test -- preflight`
- Existing engine tests pass.

## Phase 2: Prompt Model Consolidation

Twinleaf has explicit prompts for engine-to-UI decisions. TCGVibes already has `pendingPick`, `pendingInPlayTarget`, and search notices. Consolidate gradually instead of rewriting every picker at once.

### New module

Add `src/engine/prompts.ts`.

Suggested shape:

```ts
import type { Card, PlayerId } from "./types";

export type PendingPrompt =
  | DeckPickPrompt
  | InPlayTargetPrompt
  | ConfirmPrompt
  | OrderCardsPrompt
  | DamageCounterPrompt
  | AttachEnergyPrompt;

export interface BasePrompt {
  id: string;
  player: PlayerId;
  label: string;
  source: string;
}

export interface DeckPickPrompt extends BasePrompt {
  kind: "deckPick";
  pool: Card[];
  min: number;
  max: number;
  unpicked: "shuffleIntoDeck" | "topOfDeck" | "bottomOfDeck" | "discard";
  pickedDestination?: "hand" | "bench" | "discard" | "lostZone" | "attach";
}
```

### Migration strategy

- First, create adapter functions that map the existing `pendingPick` into a `DeckPickPrompt` for UI rendering.
- Extract the current pending pick panel from `App.tsx` into a reusable UI component, for example `src/ui/PromptLayer.tsx` or `src/ui/PendingPickPanel.tsx`.
- Keep `state.pendingPick` as the source of truth during this phase.
- For new effects, prefer prompt builders from `prompts.ts`.
- In a later branch, replace `pendingPick`, `pendingInPlayTarget`, and notice state with one `state.pendingPrompt` discriminated union.

### Tests

Add `src/engine/__tests__/prompts.test.ts`.

Cover:

- Existing `pendingPick` adapts to the new prompt shape without losing min, max, pool, destination, or unpicked behavior.
- Resolving a prompt preserves current Dawn/Hilda/Secret Box chain behavior.
- AI auto-resolution still works.
- Human prompt UI tests still find accessible names for pick/confirm controls.

Acceptance:

- Existing `pendingPick` tests pass unchanged.
- No card behavior changes in this phase unless explicitly covered by a regression test.

## Phase 3: Effect Prefabs

Twinleaf's best long-term lesson is its prefab layer: common card effects should be reusable helpers, not bespoke code repeated across `effects.ts`, `trainerEffects.ts`, and `abilities.ts`.

### New module

Add `src/engine/effectPrefabs.ts`.

Start with helpers that match patterns already common in TCGVibes:

```ts
export function searchDeckToHand(...): boolean;
export function searchDeckToBench(...): boolean;
export function searchDeckToEvolve(...): boolean;
export function recoverFromDiscardToHand(...): number;
export function attachEnergyFromDiscard(...): number;
export function attachEnergyFromDeck(...): boolean;
export function discardFromHand(...): number;
export function moveDamageCounters(...): boolean;
export function benchSnipe(...): void;
export function markAbilityUsedOncePerTurn(...): boolean;
export function shuffleDeck(...): void;
```

Use signatures that accept `GameState`, `PlayerId`, predicates, labels, and options. Reuse existing `pendingPick` builders where appropriate; do not invent a separate picker pathway.

### Migration strategy

- Do not refactor all effects at once.
- Pick three low-risk, well-tested examples:
  - one deck-search-to-hand Trainer,
  - one deck-search-to-bench Trainer or Ability,
  - one attach-from-discard or attach-from-deck effect.
- Migrate only those call sites and keep behavior byte-for-byte equivalent from the user's perspective.
- Update `docs/EFFECTS.md` with a short "Effect prefabs" section after the first migration lands.

### Guardrails

- Preserve seeded RNG behavior.
- Preserve log text unless tests intentionally update it.
- Preserve AI auto-resolution behavior.
- Preserve pending pick labels where user-facing tests depend on them.
- Helpers must be engine-only. No React imports, no DOM assumptions.

### Tests

Add `src/engine/__tests__/effectPrefabs.test.ts`.

Cover:

- Each helper mutates only the intended zones.
- Deck search never exposes prize cards.
- Unpicked deck cards are returned/shuffled according to options.
- Bench cap is respected.
- Ability once-per-turn markers prevent duplicate use across same-name copies only when the card text requires it.

Acceptance:

- Existing migrated-card tests pass.
- A future card implementation can be written using prefabs without touching UI code.

## Phase 4: Engine Test DSL

Twinleaf's card tests are easy to read because they have helper verbs. Add the same kind of test vocabulary before expanding effect coverage further.

### New test helper

Add `src/engine/__tests__/helpers/gameTestHelpers.ts`.

Suggested helpers:

```ts
export function setupTestGame(options?: ...): GameState;
export function active(state: GameState, player: PlayerId): PokemonInPlay;
export function benchByName(state: GameState, player: PlayerId, name: string): PokemonInPlay;
export function handIndex(state: GameState, player: PlayerId, name: string): number;
export function playTrainerByName(state: GameState, player: PlayerId, name: string): ActionResult;
export function attachEnergyByName(state: GameState, player: PlayerId, energyName: string, targetName: string): ActionResult;
export function useAttackByName(state: GameState, player: PlayerId, attackName: string): ActionResult;
export function useAbilityByName(state: GameState, player: PlayerId, holderName: string, abilityName: string): ActionResult;
export function resolvePickByName(state: GameState, player: PlayerId, names: string[]): ActionResult;
export function expectDamage(state: GameState, player: PlayerId, pokemonName: string, damage: number): void;
```

### Migration strategy

- Add helpers with new tests first.
- Migrate two or three noisy existing tests as examples.
- Avoid sweeping test churn in the same branch as behavior changes.

### Tests

Add self-tests for the helper functions if needed, or validate through migrated tests.

Acceptance:

- New tests are easier to read than their pre-helper equivalents.
- Helpers fail with useful messages when a card/name cannot be found.

## Phase 5: Replay and Shareable Debug Exports

Twinleaf's replay serializer is larger than TCGVibes needs, but the concept is very valuable. Start with deterministic local replay before any server/share-link work.

### New modules

Add:

- `src/engine/gameCommands.ts`
- `src/engine/replay.ts`

Suggested command shape:

```ts
export type GameCommand =
  | { kind: "playBasicToBench"; player: PlayerId; handIndex: number }
  | { kind: "evolve"; player: PlayerId; handIndex: number; targetInstanceId: string }
  | { kind: "attachEnergy"; player: PlayerId; handIndex: number; targetInstanceId: string }
  | { kind: "playTrainer"; player: PlayerId; handIndex: number; targetInstanceId?: string }
  | { kind: "useAttack"; player: PlayerId; attackIndex: number }
  | { kind: "useAbility"; player: PlayerId; instanceId: string; abilityName: string }
  | { kind: "resolvePendingPick"; player: PlayerId; picked: number[] }
  | { kind: "retreat"; player: PlayerId; benchIndex: number }
  | { kind: "endTurn"; player: PlayerId };

export function applyGameCommand(state: GameState, command: GameCommand): ActionResult;
```

Suggested replay shape:

```ts
export interface GameReplay {
  schemaVersion: 1;
  appVersion: string;
  createdAt: string;
  initial: {
    p1DeckIds: string[];
    p2DeckIds: string[];
    rngSeedOrState: number;
    setupOptions?: unknown;
  };
  commands: GameCommand[];
  checkpoints?: Array<{ index: number; stateJson: string; rngState: number }>;
}
```

### Implementation strategy

- First, add `applyGameCommand` as a thin dispatcher over existing action functions.
- Update a small set of App click handlers to create commands and call the dispatcher.
- Record commands in a `useRef<GameCommand[]>` only after actions succeed.
- Export a debug replay JSON from the game menu. Import can come later, but tests should already prove replaying commands reconstructs the same state.
- Checkpoints/diffs are optional for the first branch. Full Twinleaf-style state diffs can be a v2 of this feature.

### Guardrails

- Include RNG state/seed so replay is deterministic.
- Commands should not contain whole card objects.
- Prefer stable card ids/instance ids. If a command uses a hand index, that is okay only because replay applies commands sequentially from the same initial state.
- Add a schema version from day one.

### Tests

Add `src/engine/__tests__/replay.test.ts`.

Cover:

- A short game sequence replays to the same serialized state.
- Coin flips replay deterministically after RNG restore.
- Pending pick resolution is included in the command stream.
- Failed commands are not recorded.

Acceptance:

- Manual debug export produces readable JSON.
- Replaying the JSON in a test produces equivalent state and logs.

## Phase 6: Deck Builder Ergonomics

Twinleaf's React client uses a virtualized library and structured deck-editor panes. TCGVibes already has grouped gameplay-equivalent printings, side preview, validation, and mobile tabs. Improve only the pain points that show up locally.

### Candidate improvements

- Replace the `showCount` "load more" pattern with lightweight windowing if card browsing becomes sluggish.
- Avoid a new dependency unless needed. A simple fixed-row virtual grid can be local code. If a dependency is justified, consider `@tanstack/react-virtual`, which Twinleaf uses.
- Add tighter keyboard affordances:
  - `/` focuses search,
  - Enter adds the focused representative card,
  - `+` and `-` adjust selected row count,
  - Escape closes variant picker first, then modal.
- Improve selected-deck status rows:
  - one-click "swap printing",
  - visible gameplay-equivalence grouping,
  - clearer legality chips from Deck Doctor or `buildDeckFromEntries`.
- Keep the first screen as the deck-building tool, not a marketing page.

### Tests

Add or extend UI tests under `src/ui/__tests__/`.

Cover:

- Keyboard search and add.
- Variant picker still groups by `gameplayKey`.
- Large card library render does not show duplicate gameplay-equivalent tiles.
- Mobile tab state still works.

Acceptance:

- `npm run typecheck`
- `npm run test -- deckBuilder`
- No noticeable layout shift in the modal when filters change.

## Phase 7: Legality Edge Cases for Future Formats

Twinleaf's deck analyzer handles several format-specific edge cases. TCGVibes should not add noisy warnings for formats it does not support yet, but should capture the cases as tests and future toggles.

### Add a format-aware legality backlog

Extend docs or tests for:

- ACE SPEC one-per-deck.
- Radiant one-per-deck.
- Prism Star one-per-name.
- Professor Juniper / Professor Sycamore / Professor's Research name-equivalence rules where relevant.
- Boss's Orders/Lysandre-style historical equivalences if expanded/retro support is added.
- Special singleton rules from older eras only behind explicit non-Standard format flags.

### Implementation strategy

- Keep current Standard behavior stable.
- Add `format` as an explicit option before enforcing retro/expanded rules.
- Deck Doctor findings should state the format assumption.

### Tests

Add future-facing fixtures in `src/data/__tests__/deckDoctor.test.ts` or a new format-legality test file.

Acceptance:

- No new Standard false positives.
- Every retro/expanded rule has an explicit format gate.

## Recommended Order

1. Phase 4 test DSL, because it makes every later phase safer.
2. Phase 1 playability preflight, because it improves UX immediately and forces guard extraction.
3. Phase 3 effect prefabs, using the test DSL and guard extraction momentum.
4. Phase 2 prompt consolidation, gradually, after prefabs reveal the common prompt shapes.
5. Phase 5 replay/debug exports, once commands and prompts are more regular.
6. Phase 6 deck builder polish.
7. Phase 7 format legality edge cases.

If Claude has only one implementation window, do this vertical slice:

1. Add the test DSL.
2. Add preflight for hand cards only: Basic bench, Energy attach, Trainer play, Evolution.
3. Wire dim/tooltip states in the hand UI.
4. Add tests proving preflight reasons match action failures for five common blocked plays.

That slice gives users immediate benefit and creates a foundation for the larger Twinleaf-inspired work.

## Verification Checklist

Run after each phase:

```bash
npm run typecheck
npm run test
```

Run after UI phases:

```bash
npm run e2e
npm run build
```

Manual checks:

- A hand card that is illegal is visibly dimmed and has a useful reason.
- Clicking an illegal card still reports the same reason as the preflight tooltip.
- Pending pick flows still pause the game and resolve cleanly.
- Undo still restores RNG state.
- AI still resolves pending choices.
- Deck Doctor and Meta Doctor still open lazily and copy reports.
