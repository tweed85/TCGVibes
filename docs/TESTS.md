# Test suite

**Vitest — 938 tests passing across 57 files** (3 skipped, AI_BENCH-gated).
See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

## Engine tests — [../src/engine/__tests__/](../src/engine/__tests__/)

- abilityDetection, dawnChain, energy, gameFlow, integration,
  ongoingEffects, presetDeckSmoke (cartesian deck-vs-deck AI-vs-AI
  smoke matrix, now 12×12 across all curated + community presets),
  trainerDetection, weakness, undoRng, undoIntegration,
  phantomDiveHuman, attackPreflight, unspentTurnSlots, mvpPickers,
  aiScenarios, mcts, aiBenchmark (gated)
- **aiPickerLanes** — one scenario per Phase-0 picker card (Prime
  Catcher, Precious Trolley, Energy Search Pro, Glass Trumpet,
  Scramble Switch, Academy at Night, Prism Tower, Mystery Garden,
  Levincia, Surfing Beach, Grand Tree) — pins explicit AI choices,
  not just first-legal-option fallback.
- **aiDecisionQuality** — 49 shaped-state scenarios covering the AI
  build plan: Phase 1 baseline (gust into game-winning KO, energy
  attach next-turn attacker, archetype-Basic before filler, Unfair
  Stamp timing, promote-can-attack-soon, avoid over-benching under
  spread); Phase 3A-3D sequencing (immediate-win, search-before-attach,
  ability-before-Supporter, ACE SPEC conservation); Phase 4A-4C
  archetype playbooks (dragapult, crustle, remaining 10); Phase 5A-5G
  target scorers (gust, energy, search-pick, bench, evolution, attack
  choice, spread placement). Public AI entrypoints only — no private
  helper imports.
- **aiScorePosition** — 5+ behavior-path parity tests for the seven
  named sub-scores; pins won/lost terminal, prize-race gradient,
  catastrophic-no-mons no-throw, v2 threat-aware overlay.
- **findingsGaps** — pendingPromoteQueue AI lookahead, mid-queue
  game-over safety net, non-terminal (Run Away Draw) +
  terminal (attack-KO) pendingPromote phase mixing, passive
  attack-bonus + damage-reduction abilities firing through real
  `executeAttackHit` (Powerful a-Salt + Solid Shell)
- **teamRocketCards** — Spidops base damage, Ariana conditional draw,
  Proton T1 bypass + TR-Basic search
- **auditFixes** + **auditFixes2** — Carmine T1 / Prison Panic Confused /
  allOpponents Active / Potion + Super Potion pickers / Raifort /
  Lt. Surge's Bargain / Brock's branching / Future + Ancient Boosters /
  Rescue Board HP-threshold / TM Fluorite
- **pragueReplayUpdates** — Prague R9-derived archetype detection +
  playbook bonuses + v2 coin-flip T1-denial choice
- **pragueDay2Replays** — Day 2 Top 16 → Finals: dragapult-dudunsparce /
  crustle / cynthia-garchomp / grimmsnarl-froslass / mega-starmie-froslass
  detection + T1-T3 playbooks; covers the Dragapult disambiguation and
  Crustle's wall-first inversion
- **lucarioDeckFixes** — Heave-Ho Catcher picker, Defiant Horn picker,
  Nullifying Zero W/R on active, Lunar Cycle cross-copy lock
- **communityDeckFixes** + **communityDeckLowFixes** — Cynthia's Gabite
  tutor filter, Dusknoir 13-counter Cursed Blast, Hassel post-KO
  precheck, Tenacious Tail base zero, Xerosic's Machinations, Seething
  Spirit target-any picker, Tera bench immunity, Hilda Special-Energy
  filter, Mega Kangaskhan E[heads] estimator, Crustle name fix, Dwebble
  Ascension applyEvolveSideEffects, Destructive Drill Survival-Brace
  bypass, Genesect per-energy snipe, Duskull recur-from-discard,
  Send Flowers / Secret Box interactive pickers, Ignition Energy
  active-only discard, Froslass source-side suppression
- **hopsTrevenantArchetype** — archetype detection + T1-T3 playbook bonuses
- **hopsTrevenantDeckFixes** — Cruel Arrow Active+Bench targeting,
  Horrifying Revenge tracker uses `yourPokemonKoedByAttackLastOppTurnNames`,
  Choice Band cost reduction edge cases, Cramorant Fickle Spitting
  predicate + estimator, Latias ex Skyliner self-application
- **artVariants** — gameplayKey-based grouping; same name + different
  attacks → DIFFERENT keys via the dataset's two Abras with different
  attacks; per-printing identity through setupGame

### Twinleaf-inspired phases (all 7 shipped)

- **dslSmoke** — Phase 4 sanity: `setupTestGame` reaches main / turn ≥ 2;
  `useAttackByName` returns the engine's `ActionResult`;
  `attachEnergyByName` resolves both `Grass Energy` and `Basic Grass Energy`.
- **preflightContract** — Phase 1 reason-parity contract: for every
  illegal-action fixture (out-of-phase, supporter-already-played,
  non-evolution card, energy-already-attached, retreat-after-retreat,
  no-bench, etc.), `preflight.canX(...).reason === actions.X(...).reason`.
  Drift between dim/tooltip UI and engine fails this loudly. v2.3 added
  parity for `canActivateAbility` (out-of-turn, wrong-phase),
  `canActivateStadium` (no Stadium in play, already used), and
  `canEndTurn` (out-of-turn, wrong-phase).
- **prefabBehavior** — Phase 3 + v2.5 pre-migration pins for Buddy-Buddy
  Poffin / Energy Search / Lana's Aid (Phase 3) plus Nest Ball / Poké
  Ball (heads branch) / Night Stretcher (v2.5): pendingPick shape
  (min/max/predicate/destination), zone changes after resolution,
  log-text-equivalent Trainer discard. Locks "byte-equivalent" for the
  prefab migration.
- **prompts** — Phase 2 projection adapter: `state.pendingPick` /
  `pendingInPlayTarget` / etc. project into `PendingPrompt` discriminated
  union without losing min / max / pool / destination / source. Engine
  continuations (`pendingPromoteQueue`, `pendingSecondAttack`,
  `onPromoteResolved`) are NOT prompts and stay out of the union.
  v2.4 tightened `activePrompt(state, viewer)` so opponent-owned
  prompts never leak into the viewer's surface (privacy contract for
  hot-seat / open-hands-off).
- **replay** — Phase 5 + v2.2: short command stream reconstructs state
  via `applyGameCommand`; loader rejects newer schemas with `kind:
  "newer-schema"`; missing card ids → `kind: "missing-cards"`;
  appVersion / dataVersion mismatch warns but loads; corrupt stream →
  `kind: "malformed"`; static check that every `GameCommand["kind"]` is
  in the dispatcher. v2.2 added the three pre-game kinds
  (`resolveCoinGuess` / `chooseFirstPlayer` / `completeSetup`) so a
  replay starting from raw `setupGame` can walk all the way through to
  main phase.

## Data tests — [../src/data/__tests__/](../src/data/__tests__/)

- decklistParser
- effectPatterns
- **cardEquivalence** — gameplayKey + variantsOf — same vs different
  HP / types / attacks / abilities / weaknesses / retreat for Pokémon,
  rules for Trainers + Energies, whitespace normalization
- **communityDecks** — 8 Prague tournament lists pre-flight: 60-card
  parse, zero unmatched, zero rule violations, name-only-match
  informational logging

## UI tests — [../src/ui/__tests__/](../src/ui/__tests__/)

- CardView (energy-pip glyphs)
- aiPause (modal-pause useEffect under fake timers)
- **variantPicker** — popover renders all printings, current-marker,
  onPick wiring
- **deckBuilderVariants** — grid dedupe by gameplay-equivalence,
  "N arts" badge, click-to-pick / click-to-swap, rule-of-4 across
  printings

## E2E tests — [../e2e/](../e2e/)

**Playwright — 5 e2e tests.** Headless Chromium against the dev server:

- `smoke.spec.ts` — boot path, Undo round-trip, mobile viewport (375px) sanity.
- `deck-doctor.spec.ts` — Deck Doctor opens from PreGameModal, analyzes a
  preset, closes back to pre-game (no game started); Meta tab renders the
  snapshot grade banner with no fixture-leakage.

## Test environment

DOM tests opt into jsdom via `// @vitest-environment jsdom` per file
(RTL + jest-dom matchers loaded by `test-setup.ts`); pure-engine tests
stay in node. `npm run test` / `npm run test:watch` / `npm run e2e`.
