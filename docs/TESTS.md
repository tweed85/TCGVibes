# Test suite

**Vitest — 625 tests across 37 files** (+ 3 AI_BENCH-gated).
See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

## Engine tests — [../src/engine/__tests__/](../src/engine/__tests__/)

- abilityDetection, dawnChain, energy, gameFlow, integration,
  ongoingEffects, presetDeckSmoke (cartesian deck-vs-deck AI-vs-AI
  smoke matrix, now 12×12 across all curated + community presets),
  trainerDetection, weakness, undoRng, undoIntegration,
  phantomDiveHuman, attackPreflight, unspentTurnSlots, mvpPickers,
  aiScenarios, mcts, aiBenchmark (gated)
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

## E2E tests — [../e2e/smoke.spec.ts](../e2e/smoke.spec.ts)

**Playwright — 3 e2e tests.** Headless Chromium against the dev server:
boot path, Undo round-trip, mobile viewport (375px) sanity.

## Test environment

DOM tests opt into jsdom via `// @vitest-environment jsdom` per file
(RTL + jest-dom matchers loaded by `test-setup.ts`); pure-engine tests
stay in node. `npm run test` / `npm run test:watch` / `npm run e2e`.
