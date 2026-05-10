# Audit-driven picker fixes — review packet for Codex

Branch: `pandabananastcg`. Most of the change set landed in commit
`249d1a2` ("major card mechanic improvements"); a small follow-up
`effectKind` plumbing pass on top is currently uncommitted in the working
tree (adds a stable AI-routing identity to `PendingPick` /
`PendingHandReveal` so the same picker shapes can be matched by AI without
string-sniffing labels).

Source audits driving this work:

- `docs/ITEM_AUDIT.md`
- `docs/STADIUM_AUDIT.md`
- `docs/TOOL_AUDIT.md`
- `docs/SUPPORTER_AUDIT.md` (last pass; Supporter debt still listed there)
- `docs/EFFECT_AUDIT.md`

Run gates before reviewing each item:

```bash
npm run typecheck
npm run test    # 851 passing, 3 skipped
```

The Playwright smoke (`npm run e2e`) has one pre-existing flake unrelated
to this change set (mulligan modal blocks Active-bar-visibility). The
other 4 e2e tests pass.

---

## Wave 1A — straightforward Item picker flows

### Wave 1A: Precious Trolley picker

**Problem.** `searchAnyBasicsToBench` (Precious Trolley) auto-benched every
Basic Pokémon found in the deck up to remaining bench slots, with zero
choice for the player.

**Fix.** Inline AI/human split in
[trainerEffects.ts:2709-2747](src/engine/trainerEffects.ts#L2709-L2747).
- AI keeps the existing greedy auto-bench loop.
- Human path opens `setDeckSearchPick` with `toBench: true` and
  `max: 5 - bench.length`. The picker's `toBench` mode in
  [pendingPick.ts](src/engine/pendingPick.ts) handles the bench placement
  on resolve.

**Tests.** Three pin tests in
[mvpPickers.test.ts](src/engine/__tests__/mvpPickers.test.ts):
- AI auto-benches eligible Basics.
- Human path: picker has `toBench: true`, `max: 5 - bench.length`,
  `min: 0`.
- Human resolve: only chosen Basics go to bench.

**Audit checklist hits.**
- ✅ Calls public engine actions (no direct state mutation outside the
  picker path).
- ✅ AI auto-resolution preserved.
- ✅ No new prompt kind — reuses existing `pendingPick` + `toBench`.

---

### Wave 1A: Energy Search Pro picker + resolver validation

**Problem.** `searchEnergyVariety` auto-pulled one of each basic Energy
type from the deck. No human choice; couldn't selectively skip types.

**Fix.**
- Type extension in [types.ts](src/engine/types.ts): added
  `PendingPick.uniqueByEnergyType?: boolean`.
- Resolver validation in
  [pendingPick.ts:resolvePendingPick](src/engine/pendingPick.ts) —
  **mandatory correctness layer**. Picked basic Energy with duplicate
  `provides` types → `fail("Energy types must be different.")` and
  picker stays open.
- `setDeckSearchPick` accepts and propagates `uniqueByEnergyType`.
- AI keeps the existing one-of-each-type auto-pull
  ([trainerEffects.ts:2733-2773](src/engine/trainerEffects.ts#L2733-L2773)).
- Human path opens `setDeckSearchPick` with
  `uniqueByEnergyType: true`, `max: 9`.

**UI greying note.** The new flag is ALSO surfaced for the renderer to
grey out same-type tiles after a selection — but the resolver-side
validation is the load-bearing correctness layer; UI is best-effort.

**Tests.** Three pin tests:
- AI auto-pull (no picker; no duplicate types).
- Human path: picker pool has duplicates allowed; flag is set.
- Resolver rejects duplicate types; valid one-of-each picks succeed.

---

### Wave 1A: Prime Catcher chained pickers + skip command

**Problem.** `primeCatcher` auto-gusted highest-HP opp bench and
auto-switched own `bench[0]`. Both decisions were strategic.

**Fix.**
- Two new `PendingInPlayTarget.action` kinds in
  [types.ts](src/engine/types.ts): `primeCatcherGust` and
  `primeCatcherSelfSwitch`.
- AI keeps the existing heuristic
  ([trainerEffects.ts:primeCatcher case](src/engine/trainerEffects.ts)).
- Human path opens an opp-bench picker for the gust step. On resolve
  (`primeCatcherGust` case in `resolveInPlayTarget`), the gust performs
  via `performGust`, then chains into a `primeCatcherSelfSwitch` picker
  on own bench (only when own bench is non-empty). Empty own bench →
  skip cleanly.
- **Optional second step** is the audit-flagged risk: replay would stall
  on an unresolved optional prompt. Fix:
  - New `skipPrimeCatcherSelfSwitch(state, player)` exported from
    [trainerEffects.ts](src/engine/trainerEffects.ts).
  - New `GameCommand` case `skipPrimeCatcherSelfSwitch` in
    [gameCommands.ts](src/engine/gameCommands.ts) calling that
    function.
  - Replay prompt-command coverage updated in
    [replay.test.ts:266-314](src/engine/__tests__/replay.test.ts#L266-L314)
    so the static `Record<GameCommand["kind"], true>` enumerates the
    new kind.

**Tests.** Four pin tests:
- AI auto-picks both legs.
- Human gust picker → chains into self-switch picker.
- Skip command clears the self-switch picker without affecting gust.
- Empty own bench → no self-switch step.

**Audit checklist hits.**
- ✅ Skip command + `GameCommand` + replay guard all updated.
- ✅ AI auto-resolution preserved.

---

## Wave 2A — simple Stadium hand/discard pickers

### Wave 2A: Academy at Night hand picker

**Problem.** Auto-picked the first hand card and put it on top of deck.

**Fix.**
- Extended `PendingHandReveal.action` in [types.ts](src/engine/types.ts)
  with new value `"toTopOfDeck"`.
- Extended `resolveHandReveal` in
  [trainerEffects.ts](src/engine/trainerEffects.ts) with
  `pl.deck.unshift(...picked)` branch for the new action.
- AI keeps the auto-pick of `hand[0]`. Human path opens
  `pendingHandReveal` with `min: 1, max: 1, filter: "any",
  action: "toTopOfDeck"`
  ([stadiumActivated.ts](src/engine/stadiumActivated.ts) "Academy at
  Night").

**Tests.** Three pin tests in `mvpPickers.test.ts` covering: AI auto,
human picker shape, human resolve places card on top of deck.

---

### Wave 2A: Prism Tower hand discard picker

**Problem.** Auto-discarded the first 2 hand cards.

**Fix.** Human path opens `pendingHandReveal` with
`min: 2, max: 2, filter: "any", action: "discard",
postAction: { kind: "drawCards", count: 1 }`. Mirrors the Ultra Ball /
Kofu pattern — the resolver discards then runs `drawUpTo`. AI keeps
auto-discard.

**Tests.** Two pin tests covering picker shape + resolve flow.

---

### Wave 2A: Mystery Garden energy filter + drawUntilHand

**Problem.** Auto-picked the first Energy from hand to discard. The card
text was correctly identified as discard from **hand**, not in-play —
the audit verified against
[tournament-legal-cards.json:5628](data/pokemon/tournament-legal-cards.json#L5628).

**Fix.**
- Extended `PendingHandReveal.filter` in
  [types.ts](src/engine/types.ts) with new value `"energy"`.
- Extended `handCardMatches` in
  [trainerEffects.ts](src/engine/trainerEffects.ts):
  `if (filter === "energy") return c.supertype === "Energy"`.
- Human path opens `pendingHandReveal` with
  `filter: "energy", action: "discard", min: 1, max: 1,
  postAction: { kind: "drawUntilHand", targetSize: psychicCount }`
  where `psychicCount` = Psychic Pokémon in play, computed at picker
  setup. AI keeps auto-discard with manual draw loop.

**Sequencing pin** (audit-flagged concern). The `drawUntilHand`
postAction MUST measure hand size **after** the discard. The existing
`resolveHandReveal` already discards before applying postAction, so
this falls out — but a pin test asserts the contract explicitly.
Scenario: hand has 3 cards (1 Energy + 2 others), 2 Psychic in play →
after discard hand is 2 cards → targetSize 2 → 0 draws → final hand
size 2. A future refactor that flipped the order would zero-draw to
`max(0, 2 - 3)` and also leave the energy in hand.

---

### Wave 2A: Levincia discard recovery picker

**Problem.** Auto-pulled the first 2 Basic Lightning Energies from
discard.

**Fix.** Human path uses `setDiscardRecoveryPick(state, player,
isBasicLightning, 2, label)` — same shape as Miracle Headset. AI keeps
the existing greedy auto-pull.

**Tests.** One pin test covering picker source = "discard", pool
filtered to Basic Lightning, max=2.

---

## Wave 4 — guard tests (in/Stadium/Tool inventories)

Three new inventory guard tests, each modeled on
[effectAuditCoverage.test.ts](src/engine/__tests__/effectAuditCoverage.test.ts):

- [itemAudit.test.ts](src/engine/__tests__/itemAudit.test.ts) — every
  Standard Item classified `covered` / `approximate` / `unsupported`.
  Asserts `Object.keys(table).sort() === datasetItemNames.sort()` so
  any added/removed Item must be triaged.
- [stadiumAudit.test.ts](src/engine/__tests__/stadiumAudit.test.ts) —
  Stadiums classified `passive` / `activated` / `approximate` /
  `unsupported`. Activated/approximate entries additionally must be
  present in
  [stadiumActivated.ts](src/engine/stadiumActivated.ts) (verified via
  source read, not via importing private state).
- [toolAudit.test.ts](src/engine/__tests__/toolAudit.test.ts) —
  Tools classified `covered` / `approximate` / `intentionally-passive` /
  `unsupported`.

Each guard test fails loudly if the dataset diverges from the table
(catches new dataset additions and rotted entries).

---

## Wave 2B — harder Stadium fixes

### Wave 2B: Surfing Beach water bench picker

**Problem.** Auto-picked the first Water-typed Benched Pokémon.

**Fix.**
- New `PendingInPlayTarget.action` kind `surfingBeachSwitch` in
  [types.ts](src/engine/types.ts).
- The resolver in `resolveInPlayTarget` enforces the Water-type
  constraint at click time (chosen over extending the
  `PendingInPlayTarget.filter` enum, since this is a one-off
  type-narrow).
- AI / single-Water-bench → auto-switch with `performSwitch` +
  `fireTriggeredOnMoveTo*`.
- Human + multiple Water bench → opens picker.
  [stadiumActivated.ts](src/engine/stadiumActivated.ts) "Surfing Beach"
  filters bench by `types.includes("Water")` before deciding the path.

**Tests.** Three pin tests: human picker opens, resolver rejects
Fire-typed bench but accepts Water, AI auto-switch.

---

### Wave 2B: Grand Tree multi-step picker + first-turn fix

**Two issues**, both fixed in this entry:

1. **First-turn gate bug** — Grand Tree used `state.turn === 1` which
   diverges from the per-player first-turn rule used everywhere else.
   Fixed in
   [stadiumActivated.ts](src/engine/stadiumActivated.ts) "Grand Tree"
   precheck: now uses `isPlayersFirstTurn(state, player)` from
   [rules.ts](src/engine/rules.ts).
2. **Auto-pick first matching Basic** — naive `toEvolve: true` chain
   would re-find the first matching ally instead of evolving the
   user's chosen Basic. Fixed via captured `targetInstanceId` flowing
   through the chain:
   - New `PendingInPlayTarget.action` kind `grandTreeBasicTarget` —
     captures the Basic's instanceId.
   - New afterPick kinds `grandTreeApplyStage1` / `grandTreeApplyStage2`
     in [types.ts](src/engine/types.ts) (parameterized with
     `targetInstanceId`).
   - The Stage 1 deck-search picker carries
     `afterPick: { kind: "grandTreeApplyStage1", targetInstanceId }`.
     The handler in
     [pendingPick.ts](src/engine/pendingPick.ts) finds the captured
     instance, pulls Stage 1 from hand, applies as evolution, calls
     `applyEvolveSideEffects`, fires `fireTriggeredOnEvolve`, then
     opens an optional Stage 2 search keyed off the just-evolved
     instance.
   - The Stage 2 handler does the same, then shuffles the deck.

**Audit-flagged concerns addressed.**
- ✅ `applyEvolveSideEffects` is called for each evolution hop — same
  contract as Rare Candy / Salvatore.
- ✅ `targetInstanceId` is the carried key, not card name — handles the
  "two Charmanders, one user-chosen" case.

**Tests.** Three pin tests: first-turn gate uses player-relative check;
human path opens `grandTreeBasicTarget` picker; chain evolves the
user-chosen instance (NOT the first matching ally) and sets
`evolvedThisTurn`.

---

### Wave 2B: Ange Floette Prism Tower play exception

**Problem.** Card text required discarding Prism Tower from play to
play Ange Floette; the engine had no enforcement.

**Fix.** Single guard added inside the Stadium block of `playTrainer`
in [actions.ts:485-497](src/engine/actions.ts#L485-L497):

```ts
if (t.name === "Ange Floette" &&
    (!state.stadium || state.stadium.card.name !== "Prism Tower")) {
  return fail("Ange Floette can only be played by discarding Prism Tower.");
}
```

The "same-turn after Prism Tower" exception is implicit — the existing
same-name gate at lines 486-487 only blocks identical names; Prism
Tower → Ange Floette have different names so the replacement path
runs. **Verified** that no separate "one Stadium per turn" gate exists
(`grep playTrainer Stadium` only shows the same-name guard).

**Tests.** Two pin tests: rejects when current Stadium is anything
other than Prism Tower; allows when Prism Tower is in play (and Prism
Tower goes to its controller's discard).

---

## Wave 1B — Item picker shape changes

### Wave 1B: Glass Trumpet pending-attach queue

**Problem.** Auto-attached the first 2 Basic Energies from discard to
the first 2 Colorless Bench Pokémon. Card text gives the player BOTH
choices ("in any way you like").

**Fix.** New transient state field plus a chained picker:

- New `state.pendingAttachQueue: { ownerId, energies, sourceLabel } |
  null` in [types.ts](src/engine/types.ts) — a buffer that holds
  selected discard Energy without ever putting them in hand.
- New `PendingPick.afterPick` kind `glassTrumpetStash` in
  [types.ts](src/engine/types.ts).
- New `PendingInPlayTarget.action` kind
  `glassTrumpetAttach` (with `remaining` counter).
- Glass Trumpet flow
  ([trainerEffects.ts](src/engine/trainerEffects.ts)):
  - AI keeps existing greedy auto-attach.
  - Human path opens
    `setDiscardRecoveryPick(state, player, isBasicEnergy, 2, label)`
    then sets `state.pendingPick.afterPick = { kind: "glassTrumpetStash" }`.
- The afterPick handler in
  [pendingPick.ts](src/engine/pendingPick.ts):
  pulls picked Energy out of hand (resolvePendingPick deposited it
  there as default), stashes on `pendingAttachQueue`, opens a
  multi-pick `pendingInPlayTarget` (`glassTrumpetAttach`,
  `remaining: energies.length`).
- The `glassTrumpetAttach` resolver in
  [trainerEffects.ts](src/engine/trainerEffects.ts) verifies the
  click target is Colorless-typed Bench, pops the queue head, attaches.
  Closes when the queue empties.

**Audit-flagged concern addressed.** Energy never visibly transits
hand. The afterPick handler runs synchronously within
`resolvePendingPick`'s tail, splicing the Energy back out of hand
before any UI can render the in-between state. A pin test asserts
`hand.length` is unchanged after the discard picker resolves.

**Tests.** Three pin tests: discard picker opens; energies bypass hand;
each click attaches one; resolver rejects non-Colorless bench.

---

### Wave 1B: Scramble Switch all/none choice prompt

**Problem.** Auto-switched `bench[0]` and auto-moved ALL energy. The
audit flagged both decisions.

**Fix shape.**
- New `PendingInPlayTarget.action` kind `scrambleSwitchTarget` in
  [types.ts](src/engine/types.ts).
- Human path opens a switch-target picker; resolver does the
  `performSwitch` and then transfers all attached Energy from the
  outgoing (now at end of bench) to the new Active.
- AI / single-bench → keeps the existing auto-switch + move-all.

**Documented APPROXIMATION.** Card text says "you may move any amount
of Energy" — the granular per-Energy choice is NOT implemented; the
engine always moves all energy on switch. This is documented in:

- An inline `// APPROXIMATION:` comment in
  [trainerEffects.ts](src/engine/trainerEffects.ts) Scramble Switch
  resolver case.
- [docs/ITEM_AUDIT.md](docs/ITEM_AUDIT.md) under "Simplified or
  cosmetic Items".
- The `itemAudit.test.ts` classification table marks Scramble Switch
  as `approximate` (with the reason in the inline comment).

**Tests.** Three pin tests: human picker opens; resolver switches +
moves all energy; AI keeps bench[0] auto-switch.

---

## Wave 3A — Tool trigger: Handheld Fan defender prompt lane

**Problem.** Handheld Fan moved 1 Energy from the attacker's Active to
the attacker's `bench[0]` automatically. The card lets the holder's
owner (defender, while attacker is taking their turn) choose the
target. This is the engine's first **defender-side prompt during the
attacker's turn**.

**New infrastructure.**
- `state.pendingHandheldFan: { defenderId, attackerSideId } | null` in
  [types.ts](src/engine/types.ts).
- New `PendingInPlayTarget.action` kind `handheldFanPick` (note:
  `player` on the prompt is the defender; `targetOwner` is the
  attacker).
- Initialized in [rules.ts](src/engine/rules.ts) `setupGame` and
  cloned in [ai.ts](src/engine/ai.ts) `cloneStateForSearchWithSeed`.

**Pause/resume model** (mirrors Heavy Baton's
[promoteBenchToActive](src/engine/actions.ts) pattern, but at the
attack-end boundary instead of the promote boundary):

1. In `executeAttackHit`'s
   `moveEnergyAttackerToAttackerBench` branch
   ([actions.ts:988-1012](src/engine/actions.ts#L988-L1012)):
   - AI defender or single-bench attacker → auto-move (preserved).
   - Human defender + 2+ attacker bench → set
     `state.pendingHandheldFan = { defenderId, attackerSideId }`,
     skip auto-move.
2. In `finishHit`
   ([actions.ts](src/engine/actions.ts)) — runs after the attack's
   damage / KO / promote chain — if `pendingHandheldFan` is set,
   open `pendingInPlayTarget` for the defender (`scope: "opp",
   slot: "bench", action: "handheldFanPick"`) and **return without
   calling `endTurnRule`**. The attacker's turn waits.
3. The `handheldFanPick` case in `resolveInPlayTarget`
   ([trainerEffects.ts](src/engine/trainerEffects.ts)) validates the
   defender clicker, validates the click is on the attacker's bench
   (not Active), moves the first attached Energy to the chosen bench,
   clears `pendingHandheldFan`, and resumes by calling `endTurnRule`.

**Edge cases handled.**
- Attacker's Active is gone or has no Energy when picker resolves →
  drop to the no-op path, still call `endTurnRule`.
- Holder is KO'd by the attack → trigger still fires (per card text
  "even if this Pokémon is Knocked Out") because Tool dispatch happens
  before the KO-discard step.

**Tests.** Five pin tests: AI defender auto-moves; single-bench
auto-moves; human + multi-bench defers (turn does NOT advance);
resolve moves Energy and turn ends; resolver rejects clicks on
attacker's Active.

**Approximation noted.** The energy itself is auto-picked (first
attached). The audit identified destination as the meaningful choice;
energy choice is preserved as a future improvement.

---

## Wave 3B — Tool trigger: Powerglass + Amulet of Hope

### Powerglass — pausable endTurn refactor

**Problem.** End-of-turn auto-attached the first Basic Energy from
discard. Card says "you may attach", so humans should be able to
decline AND choose which Basic Energy.

**Refactor.** Split `endTurn` into two functions in
[rules.ts](src/engine/rules.ts):
- `endTurn(state)` — runs Powerglass first. If a human picker is
  needed, sets `pendingPick` and returns.
- `finishEndTurn(state)` — exported. Runs the post-Powerglass body:
  Ignition Energy discard, Technical Machine discard, turn-flag
  resets, Glaceon Permeating Chill, Corrosive Sludge, Pokémon Checkup,
  pendingPromote-or-passTurn dispatch.

**Powerglass dispatch in `endTurn`:**
- AI + Basic Energy in discard → auto-attach first (preserved).
- Human + Basic Energy in discard → open
  `pendingPick` with `min: 0, max: 1`, source `"discard"`, pool
  filtered to basic Energy, `afterPick: { kind: "powerglassAttach" }`.
  Returns without calling `finishEndTurn`.

**Resume.** New afterPick kind `powerglassAttach` in
[pendingPick.ts](src/engine/pendingPick.ts):
pulls picked basic Energy out of hand (default deposit destination),
attaches to Active (or returns to discard if Active is gone), then
calls `finishEndTurn(state)`.

**Audit-flagged concern addressed.** End-turn substeps are tested:
- A pin test asserts that after the picker resolves, the active
  player's turn passes (i.e. `passTurn` runs). The full Checkup /
  TM / flag-reset path is exercised by the existing test suite — any
  silent regression there fails the existing tests.
- Declining the picker (`max=1, picked=0`) produces an identical
  resumed-turn state to the auto-decline path. Pin test scenario:
  picker resolves with `[]`, energy stays in discard, turn advances.

### Amulet of Hope — post-promote deck-search picker

**Problem.** KO trigger auto-searched 3 cards from deck using a
priority-based heuristic. Human owner had no choice.

**Fix.** Same defer pattern as Heavy Baton — the picker can't open
mid-KO (pendingPromote owns the phase), so it's deferred until after
`promoteBenchToActive` drains.

- New `state.pendingAmuletOfHope: { ownerId } | null` in
  [types.ts](src/engine/types.ts), cloned in `ai.ts`.
- New afterPick kind `amuletOfHopeResume` in
  [types.ts](src/engine/types.ts).
- In [rules.ts:knockOut](src/engine/rules.ts) Tool-on-KO loop's
  `searchDeckAnyN` branch:
  - AI → existing priority sort (Basic → Supporter → Pokémon → Energy).
  - Human → set `state.pendingAmuletOfHope = { ownerId }`, log a
    "pick after you promote" notice, do not auto-search.
- In [actions.ts:promoteBenchToActive](src/engine/actions.ts), AFTER
  the Heavy Baton drain block: if `pendingAmuletOfHope.ownerId === player`,
  clear it and open `setDeckSearchPick(state, player, () => true, 3,
  ..., { afterPick: { kind: "amuletOfHopeResume" } })`. Returns ok
  without running the `onPromoteResolved` continuation — the picker's
  afterPick will.
- The `amuletOfHopeResume` afterPick handler in `pendingPick.ts`
  consumes `state.onPromoteResolved` and calls `endTurnRule` (the
  common case). Lazy-routing of `passTurn` / `secondAttack` is
  documented as deferred — it's not exercised by Amulet of Hope's
  text in any current scenario (KO from opp attack always sets
  `onPromoteResolved = "endTurn"` in `finishHit`).

**Tests.** Two pin tests: human owner picker opens after promote with
`max: 3`; AI owner auto-searches with priority sort and adds 3 cards
to hand.

---

## Cross-cutting changes

- **Replay prompt-command guard** at
  [replay.test.ts:266-314](src/engine/__tests__/replay.test.ts#L266-L314) —
  enumerates every `GameCommand["kind"]` via a `Record` literal that
  TypeScript forces the author to enumerate. New kinds added:
  `skipPrimeCatcherSelfSwitch`. Updated to keep the guard tight.
- **Tool audit doc** ([docs/TOOL_AUDIT.md](docs/TOOL_AUDIT.md)) updated
  to reflect Wave 3 changes — Handheld Fan / Powerglass / Amulet of
  Hope moved out of "High-Priority Choice Debt".
- **Item audit doc** ([docs/ITEM_AUDIT.md](docs/ITEM_AUDIT.md))
  updated to reflect Prime Catcher / Scramble Switch / Glass Trumpet
  changes; Scramble Switch explicitly moved to "approximate (interim
  all/none)".
- **`effectKind` plumbing** (uncommitted follow-up) — adds a stable
  string identity field to `PendingPick` and `PendingHandReveal` so AI
  can route based on `effectKind` rather than label-string-sniffing.
  Threaded through `setDeckSearchPick` options and the Stadium
  callsites that need it (Academy at Night, Levincia, Mystery Garden,
  …).

## Things to focus on for review

1. **Pause/resume ordering**. Wave 3A and 3B introduce three new
   pause points (defender-prompt lane, pausable endTurn, post-promote
   Amulet of Hope). All three follow the Heavy Baton precedent of
   storing a small context object and re-entering a continuation in
   the resolver. Verify:
   - The continuation (`endTurnRule` / `finishEndTurn` /
     `onPromoteResolved`) is always called exactly once.
   - Game-over and double-KO interleavings still terminate.
   - The state clones in [ai.ts](src/engine/ai.ts) include all new
     pending fields.

2. **Handheld Fan defender-side prompt**. The picker has
   `player: defenderId` while `state.activePlayer` is the attacker.
   Verify that the `resolveInPlayTarget` gating (`pending.player !== clicker`)
   correctly admits the defender's click and that no other surface
   silently treats the prompt as belonging to the active player.

3. **Grand Tree instance carryover**. The captured `targetInstanceId`
   is the only thing keying which Basic gets evolved. Verify that
   intermediate steps (e.g., a triggered ability that KOs the captured
   ally between picker steps) fail closed, not closed-and-still-evolve.

4. **Energy Search Pro resolver validation**. The
   `uniqueByEnergyType` rejection at resolve time is the correctness
   layer. Verify it handles edge cases:
   - Energy with empty `provides` array.
   - Energy with multiple `provides` (e.g. dual-type basic Energy if
     the dataset ever has any) — current code uses
     `energyTypes(c).every(...)` semantics.

5. **Audit guard tests as gatekeepers**. The Item / Stadium / Tool
   guards will now fail on any dataset addition until the new card is
   classified. This is intentional — verify the failure messages are
   actionable.
