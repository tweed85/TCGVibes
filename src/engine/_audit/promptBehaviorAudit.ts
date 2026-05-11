// Prompt-behavior audit.
//
// For each *unique prompt behavior shape* (the tuple of prompt family +
// parameters that materially affect prompting), require a behavior test.
// One effect kind may map to multiple shapes (different parameter
// signatures get separate coverage), and multiple kinds may share a
// shape — neither matters; what we guard is shape coverage.
//
// Per the plan §1.3: cards classified `prompts` in userChoiceAudit must,
// at Phase 1 close, point at a registered shape + a checked-in behavior
// test file, OR be listed in CARD_LEVEL_EXCEPTIONS with a written rationale.

import { existsSync } from "node:fs";

export const PROMPT_BEHAVIOR_SHAPES = [
  // ---- Deck-search picks (existing) ----
  "deckSearch_anyCard",                  // searchDeckAnyCard (ability)
  "deckSearch_pokemon",                  // searchDeckPokemon, searchAnyPokemon, etc.
  "deckSearch_pokemonNamePrefix",        // searchDeckPokemonNamePrefix
  "deckSearch_basicEnergy",              // searchBasicEnergy1, searchBasicEnergyN
  "deckSearch_stadium",                  // searchDeckStadium
  "deckSearch_trainerByName",            // searchDeckTrainerByName
  "deckSearch_evolutionGated",           // searchEvolutionPokemonGated
  "deckSearch_evolutionOfType",          // searchEvolutionPokemonOfType
  "deckSearch_anyToTopdeck",             // searchDeckAnyCardToTopdeck
  "deckSearch_energyIfSupporterPlayedName", // searchEnergyIfSupporterPlayedName
  "deckSearch_chain_basicStage1Stage2",  // dawnSearchBasicStage1Stage2
  "deckSearch_chain_stadiumAndEnergy",   // searchStadiumAndEnergy
  "deckSearch_megaEx",                   // searchMegaEx
  "deckSearch_secretBoxQuad",            // secretBoxQuadSearch
  "deckSearch_pokemonex3",               // search3Pokemonex
  "deckSearch_hopsBasics",               // searchHopsBasics
  "deckSearch_teraPokemon",              // searchTeraPokemon
  "deckSearch_TMTools",                  // searchTMTools
  "deckSearch_TRSupporter",              // searchTRSupporter
  "deckSearch_callForFamily",            // callForFamily (attack)
  "deckSearch_evolve",                   // searchEvolveSelf, searchEvolveBench
  "deckSearch_attackBuilder",            // searchDeckAttack
  "deckSearch_namedBasicToBench",        // searchDeckBasicNamedToBench
  "deckSearch_basicTypeToBench",         // searchDeckBasicTypeToBench
  "deckSearch_namedPokemonToBench",      // searchDeckNamedPokemonToBench
  "deckSearch_namedPokemonToHand",       // searchDeckNamedPokemonToHand
  "deckSearch_mixedToHand",              // searchDeckMixedToHand
  "deckSearch_namedTrainerToHand",       // searchAnyNamedTrainerToHand
  "deckSearch_basicEnergyAttach",        // searchBasicEnergyAttach* variants
  "deckSearch_energyForEachBench",       // searchEnergyForEachBench
  "deckSearch_anyEnergyToHand",          // searchAnyEnergyToHand
  "deckSearch_stadiumToHand",            // searchStadiumToHand
  "deckSearch_evolveAttackName",         // searchAndEvolve* variants
  "deckSearch_andTopdeckTwo",            // searchAndTopdeckTwo
  "deckSearch_anyBasicNamedToBench",     // searchAnyBasicNamedToBench
  "deckSearch_namedToBenchN",            // searchDeckNamedToBenchN

  // ---- Discard-recovery picks ----
  "discardRecover_pokemonToBench",       // recoverPokemonFromDiscardToBench
  "discardRecover_pokemonToHand",        // recoverPokemonFromDiscardToHand
  "discardRecover_trainerToHand",        // recoverTrainerFromDiscardToHand
  "discardRecover_trainer",              // recoverTrainerFromDiscard
  "discardRecover_basicEnergyType",      // recoverBasicEnergyTypeToHand
  "discardRecover_energyRetrieval",      // energyRetrieval
  "discardRecover_lanasAid",             // recoverFromDiscardLana
  "discardRecover_tarragon",             // recoverFromDiscardTarragon
  "discardRecover_sacredAsh",            // sacredAsh
  "discardRecover_nightStretcher",       // nightStretcher
  "discardRecover_2supporters",          // recover2Supporters
  "discardRecover_maxRod",               // maxRodRecoverPokemonOrEnergy
  "discardRecover_flipN",                // flipNRecoverDiscardToHand

  // ---- Top/bottom peek with various unpicked + pickedDest combos ----
  "topPeek_supporter",                   // pokegear37
  "topPeek_grassFireOrSimilar",          // topPeekSupporterGrassFire
  "topPeek_bugCatchingSet",              // bugCatchingSet
  "topPeek_hassel",                      // hasselTop8Take3
  "topPeek_drayton",                     // draytonTop7
  "topPeek_take2Discard4",               // top6Take2Discard4
  "topPeek_raifort5Discard",             // raifort5Discard
  "topPeek_darkBasicPokemon",            // darkBasicPokemonTopPeek
  "bottomPeek_duskBall",                 // duskBall

  // ---- Top-peek shapes Phase 3 adds (registered up-front) ----
  "topPeek_drakloak_recon",              // Phase 3.1 — Drakloak Recon Directive
  "topPeek_morpeko_snackSeek",           // Phase 3.3 — Morpeko peekTopMayDiscard

  // ---- Phase 6 — multi-step distribution pickers ----
  "rearmingAttachFromDiscardTyped",      // Overvolt Discharge (abilityAttachAnyBasicFromDiscardToTyped)
  "rearmingAttachMixedFromHand",         // Pyro Dance (abilityAttachMixedFromHand)
  "rearmingMoveEnergyAnywhereOwn",       // Energy Blender / Iron Shake-Up (attackMoveAnyEnergySource/Dest)
  "queuedAttachToAlly",                  // top4AttachEnergyType (abilityAttachQueuedEnergyToAlly)
  "rearmingAttachAllBasicFromHand",      // attachAnyBasicFromHandAll (attackAttachBasicFromHandToAlly)
  // ---- Phase 7 — pre-attack discard-for-damage picker ----
  "preAttackDiscardForDamage",           // Inferno X / Bellowing Thunder / Spill the Tea (attackDiscardForDamagePicker)

  // ---- In-play target pickers ----
  "inPlayTarget_pokemonCatcher",         // flipGustOppBenched + chosen target
  "inPlayTarget_boss",                   // gustOppBenched
  "inPlayTarget_potion",                 // heal30Active / Potion variants
  "inPlayTarget_superPotion",            // heal60DiscardEnergy
  "inPlayTarget_dragon60",               // healDragon60
  "inPlayTarget_psychicHeal",            // heal150Psychic
  "inPlayTarget_anyHeal",                // heal150Any
  "inPlayTarget_energySwitch",           // energySwitchOwn — two-step
  "inPlayTarget_toolScrapper",           // toolScrapper — multi-pick
  "inPlayTarget_enhancedHammer",         // enhancedHammer — opp Special Energy
  "inPlayTarget_crushingHammer",         // crushingHammer — opp Energy
  "inPlayTarget_bigCatchingNet",         // bigCatchingNet
  "inPlayTarget_devolveSingle",          // strangeTimepieceDevolve, devolveOneOppToHand
  "inPlayTarget_scoopUpCyclone",         // scoopUpCyclone
  "inPlayTarget_phantomDive",            // damageMultipleTargets
  "inPlayTarget_distribute",             // distributeDamage
  "inPlayTarget_placeCounterOpp",        // placeCountersOnOppBenchAny
  "inPlayTarget_snipeOne",               // snipeOne / snipeOnePerEnergy
  "inPlayTarget_switchOpp",              // switchOutOpponent
  "inPlayTarget_gustAttack",             // gustOppBenchedAttack
  "inPlayTarget_moveDamageOwnToOpp",     // moveDamageOwnToOpp ability
  "inPlayTarget_moveDamageOwnBenchToOpp", // moveDamageOwnBenchToOpp attack
  "inPlayTarget_attachEnergyDiscardSelf", // attachEnergyFromDiscardToSelf
  "inPlayTarget_discardOppTools",        // discardOppTools / discardOppToolsN
  "inPlayTarget_discardOppEnergy",       // discardOppEnergy
  "inPlayTarget_discardTypedOppEnergy",  // discardTypedOppEnergy
  "inPlayTarget_discardBenchEnergyForDamage", // discardBenchEnergyForDamage
  "inPlayTarget_discardEnergyFromHandForDamage", // discardEnergyFromHandForDamage
  "inPlayTarget_discardHandEnergyForDamage", // discardHandEnergyForDamage
  "inPlayTarget_glassTrumpet",           // glassTrumpet
  "inPlayTarget_wondrousPatch",          // wondrousPatchPsychic
  "inPlayTarget_healMegaExEnergyToHand", // healMegaExAndEnergyToHand
  "inPlayTarget_ogresMask",              // ogresMaskSwapOgerpon
  "inPlayTarget_revive",                 // (placeholder for revive cards)

  // ---- Hand-reveal pickers ----
  "handReveal_eriDiscardItems",          // eriDiscardOppItems
  "handReveal_naveenPreDiscard",         // naveenPreDiscardDraw5
  "handReveal_kofuBottom2",              // kofuBottom2Draw4
  "handReveal_ultraBall",                // searchAnyPokemon (Ultra Ball)
  "handReveal_oppChoosesHandToDeck",     // oppChoosesHandToDeck
  "handReveal_revealOppHandDiscard",     // revealOppHandDiscard
  "handReveal_academyAtNight",           // academyAtNight (existing effectKind)
  "handReveal_mysteryGarden",            // mysteryGarden (existing effectKind)
  "handReveal_prismTower",               // prismTower (existing effectKind)
  "handReveal_discardOppItems",          // discardOppItemsHand

  // ---- Switch / promote prompts ----
  "switch_simpleSwitch",                 // simpleSwitch
  "switch_repelSwitchOut",               // repelSwitchOut

  // ---- Rare Candy ----
  "rareCandy_evolveStage2",              // rareCandyEvolve

  // ---- Phase 3 shapes (registered up-front; tests land alongside conversions) ----
  "chooseStatus_threeWay",               // Phase 3.2 — Cradily (status menu)
  "handReveal_swapWithDeckTop",          // Phase 3.4 — Gumshoos
  "handReveal_oppBasicHpCap",            // Phase 3.5 — Mandibuzz
  "handEnergyDiscard_drawToN",           // Phase 3.6 — discardHandEnergyDrawToN
  "handEnergyDiscardThenInPlayTarget",   // Phase 3.7 — Mega Greninja ex
  "moveEnergySourceDest_typedBasic",     // Phase 3.8 — Blissey ex Happy Switch
  "moveEnergySourceDest_anyBasic_asOften", // Phase 3.9 — moveBasicEnergyAnywhere
  "inPlayTarget_switchTypedBenchedWithStatus", // Phase 3.10
  "inPlayTarget_swapWithBenchForceOppPromote", // Phase 3.11
  "handReveal_discardToolThenInPlayTarget", // Phase 3.12 — discardToolFromHandGustOpp
  "inPlayTarget_attachEnergyPerTop4",    // Phase 3.13 — top4AttachEnergyType
] as const;

export type PromptBehaviorShape = (typeof PROMPT_BEHAVIOR_SHAPES)[number];

// Behavior shape → registered test file path. Phase 1 ships the registry
// pointing at the existing tests; Phase 3/4 conversions land new tests and
// add their entries here. The Phase 1 vitest guard asserts every shape in
// PROMPT_BEHAVIOR_SHAPES has at least one resolvable test file in this map.

export const PROMPT_BEHAVIOR_TESTS: Record<PromptBehaviorShape, string[]> = {
  // Existing coverage — the bulk of these prompts are already tested in the
  // shared prompts.test.ts / mvpPickers.test.ts / prefabBehavior.test.ts
  // suites. Each entry lists the test files that exercise the shape. Empty
  // arrays are placeholders for shapes whose tests Phase 3/4 will land.
  deckSearch_anyCard: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_pokemon: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_pokemonNamePrefix: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_basicEnergy: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_stadium: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_trainerByName: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_evolutionGated: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_evolutionOfType: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_anyToTopdeck: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_energyIfSupporterPlayedName: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_chain_basicStage1Stage2: ["src/engine/__tests__/dawnChain.test.ts"],
  deckSearch_chain_stadiumAndEnergy: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_megaEx: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_secretBoxQuad: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_pokemonex3: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_hopsBasics: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_teraPokemon: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_TMTools: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_TRSupporter: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_callForFamily: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_evolve: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_attackBuilder: ["src/engine/__tests__/prompts.test.ts"],
  deckSearch_namedBasicToBench: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_basicTypeToBench: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_namedPokemonToBench: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_namedPokemonToHand: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_mixedToHand: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_namedTrainerToHand: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_basicEnergyAttach: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_energyForEachBench: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_anyEnergyToHand: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_stadiumToHand: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_evolveAttackName: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_andTopdeckTwo: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_anyBasicNamedToBench: ["src/engine/__tests__/prefabBehavior.test.ts"],
  deckSearch_namedToBenchN: ["src/engine/__tests__/prefabBehavior.test.ts"],

  discardRecover_pokemonToBench: ["src/engine/__tests__/prompts.test.ts"],
  discardRecover_pokemonToHand: ["src/engine/__tests__/prompts.test.ts"],
  discardRecover_trainerToHand: ["src/engine/__tests__/prompts.test.ts"],
  discardRecover_trainer: ["src/engine/__tests__/prompts.test.ts"],
  discardRecover_basicEnergyType: ["src/engine/__tests__/prompts.test.ts"],
  discardRecover_energyRetrieval: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_lanasAid: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_tarragon: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_sacredAsh: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_nightStretcher: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_2supporters: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_maxRod: ["src/engine/__tests__/prefabBehavior.test.ts"],
  discardRecover_flipN: ["src/engine/__tests__/prompts.test.ts"],

  topPeek_supporter: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_grassFireOrSimilar: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_bugCatchingSet: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_hassel: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_drayton: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_take2Discard4: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_raifort5Discard: ["src/engine/__tests__/prompts.test.ts"],
  topPeek_darkBasicPokemon: ["src/engine/__tests__/prompts.test.ts"],
  bottomPeek_duskBall: ["src/engine/__tests__/prompts.test.ts"],

  // Phase 3 conversions.
  topPeek_drakloak_recon: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  topPeek_morpeko_snackSeek: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],

  inPlayTarget_pokemonCatcher: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_boss: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_potion: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_superPotion: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_dragon60: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_psychicHeal: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_anyHeal: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_energySwitch: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_toolScrapper: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_enhancedHammer: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_crushingHammer: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_bigCatchingNet: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_devolveSingle: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_scoopUpCyclone: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_phantomDive: ["src/engine/__tests__/phantomDiveHuman.test.ts"],
  inPlayTarget_distribute: ["src/engine/__tests__/phantomDiveHuman.test.ts"],
  inPlayTarget_placeCounterOpp: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_snipeOne: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_switchOpp: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_gustAttack: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_moveDamageOwnToOpp: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_moveDamageOwnBenchToOpp: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_attachEnergyDiscardSelf: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_discardOppTools: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_discardOppEnergy: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_discardTypedOppEnergy: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_discardBenchEnergyForDamage: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_discardEnergyFromHandForDamage: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_discardHandEnergyForDamage: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_glassTrumpet: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_wondrousPatch: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_healMegaExEnergyToHand: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_ogresMask: ["src/engine/__tests__/mvpPickers.test.ts"],
  inPlayTarget_revive: ["src/engine/__tests__/mvpPickers.test.ts"],

  handReveal_eriDiscardItems: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_naveenPreDiscard: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_kofuBottom2: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_ultraBall: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_oppChoosesHandToDeck: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_revealOppHandDiscard: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_academyAtNight: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_mysteryGarden: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_prismTower: ["src/engine/__tests__/prompts.test.ts"],
  handReveal_discardOppItems: ["src/engine/__tests__/prompts.test.ts"],

  switch_simpleSwitch: ["src/engine/__tests__/mvpPickers.test.ts"],
  switch_repelSwitchOut: ["src/engine/__tests__/mvpPickers.test.ts"],

  rareCandy_evolveStage2: ["src/engine/__tests__/mvpPickers.test.ts"],

  // Phase 3 conversions.
  chooseStatus_threeWay: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  handReveal_swapWithDeckTop: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  handReveal_oppBasicHpCap: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  handEnergyDiscard_drawToN: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  handEnergyDiscardThenInPlayTarget: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  moveEnergySourceDest_typedBasic: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  moveEnergySourceDest_anyBasic_asOften: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  inPlayTarget_switchTypedBenchedWithStatus: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  inPlayTarget_swapWithBenchForceOppPromote: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  handReveal_discardToolThenInPlayTarget: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  inPlayTarget_attachEnergyPerTop4: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  rearmingAttachFromDiscardTyped: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  rearmingAttachMixedFromHand: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  rearmingMoveEnergyAnywhereOwn: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  queuedAttachToAlly: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  rearmingAttachAllBasicFromHand: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
  preAttackDiscardForDamage: ["src/engine/__tests__/userChoicePromptAbilities.test.ts"],
};

// Shapes that are intentionally not yet tested. The registry guard tolerates
// these so the audit can keep shipping while follow-up picker work continues.
// These are not terminal-complete; docs/USER_CHOICE_AUDIT.md reports affected
// rows as `needsFix` until a behavior test is registered or an exception is
// written.
// All Phase 3/6/7 shapes now have behavior tests in
// userChoicePromptAbilities.test.ts. The placeholder list is empty —
// remaining `needsFix` rows in the report come from `(unmapped)` shapes
// (kinds whose `behaviorShapeFor` mapping isn't registered yet) and
// from `autoSuspect/low` rows, not from this list.
export const PHASE3_PHASE4_PLACEHOLDER_SHAPES: PromptBehaviorShape[] = [];

// Helper exposed for the guard test: every non-placeholder shape must list at
// least one existing test file. We check file existence at test time so
// renames don't silently drop coverage.
export function findMissingShapeTests(): {
  shape: PromptBehaviorShape;
  reason: "noTestRegistered" | "testFileMissing";
  files: string[];
}[] {
  const placeholders = new Set<PromptBehaviorShape>(PHASE3_PHASE4_PLACEHOLDER_SHAPES);
  const issues: ReturnType<typeof findMissingShapeTests> = [];
  for (const shape of PROMPT_BEHAVIOR_SHAPES) {
    if (placeholders.has(shape)) continue;
    const files = PROMPT_BEHAVIOR_TESTS[shape] ?? [];
    if (files.length === 0) {
      issues.push({ shape, reason: "noTestRegistered", files });
      continue;
    }
    for (const f of files) {
      if (!existsSync(f)) {
        issues.push({ shape, reason: "testFileMissing", files });
        break;
      }
    }
  }
  return issues;
}
