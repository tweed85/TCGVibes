// User-choice audit tables.
//
// Three exhaustive Record<UnionKind, EffectClassification> maps that say,
// for every ability / attack / trainer effect kind, whether its current
// handler resolves through a user prompt or auto-applies, and (when it
// auto-applies) whether that is correct per printed card text or a bug.
//
// Phase 1 deliverable. No engine behavior is changed here — this module is
// data + types only. The classification feeds:
//
//   1. The exhaustiveness guard in __tests__/effectAuditCoverage.test.ts
//      (a dispatch kind without an audit row fails CI).
//   2. The report generator (__tests__/userChoiceAuditReport.test.ts)
//      which walks every tournament-legal card and writes
//      docs/USER_CHOICE_AUDIT.md grouped by severity.
//   3. The parsed effect-kind gate (no high/med autoSuspect rows may remain
//      after conversion phases land). This does not mean the whole card pool
//      is terminal-complete; docs/USER_CHOICE_AUDIT.md also tracks unparsed
//      and low-severity needsFix rows.
//
// Severity rubric (autoSuspect only):
//   high — printed text says "choose / pick / look at and put N".
//   med  — printed "may" with engine auto-fire (no Skip), or multi-target
//          choice silently collapsed to a heuristic.
//   low  — printed choice exists but the engine's current target set has at
//          most one candidate in realistic scenarios.
//
// autoCorrectByRule is reserved for cases where printed card text removes
// player choice (random discard, mandatory shuffle, single legal target by
// rule). State-dependent "only one valid target right now" is NOT a
// justification for autoCorrectByRule — that's handled by the prompt
// itself when it opens.

import type { AbilityEffect, AttackEffect } from "../types";
import type { TrainerEffectId } from "../trainerEffects";

export type EffectClassification =
  | { kind: "prompts" }
  | { kind: "autoCorrectByRule"; rationale: string }
  | { kind: "autoSuspect"; rationale: string; severity: "high" | "med" | "low" }
  | { kind: "missingSkip"; rationale: string };

const prompts = (): EffectClassification => ({ kind: "prompts" });
const auto = (rationale: string): EffectClassification => ({ kind: "autoCorrectByRule", rationale });
// `suspect` helper retained for future re-classification work; intentionally
// unused right now — every prior `autoSuspect` row has been promoted to
// `auto` (no-choice-by-rule), `prompts` (real picker landed), or migrated
// to a Phase 3+ conversion. New suspect rows can use this helper.
const suspect = (
  severity: "high" | "med" | "low",
  rationale: string,
): EffectClassification => ({ kind: "autoSuspect", severity, rationale });
void suspect;

// ---------------------------------------------------------------------------
// Card-level exceptions.
//
// Some tournament-legal cards have prompt-worthy printed language but are
// deliberately *not* user-choice in the engine — usually because the rule
// is genuinely automatic or because the choice is degenerate (only one
// candidate ever). Each entry must be listed verbatim by card name; the
// Phase 1.5 printed-text scanner consults this list before flagging a
// card as unparsedPromptText.
// ---------------------------------------------------------------------------

export const CARD_LEVEL_EXCEPTIONS: Record<string, string> = {
  // Format: "Card Name": "rationale".
  //
  // Most entries below capture cards whose printed text matches the
  // prompt-language regex (because the rules text contains words like
  // "may", "damaged", "choose") but where the ability is actually a
  // passive / triggered effect with no user choice at all. The scanner
  // is intentionally regex-fuzzy (catching real choice cases like
  // Drakloak Recon Directive) so these false positives are documented
  // here rather than dropped from the scanner.
  //
  // A small number of entries below are genuine deferred user-choice
  // conversions — flagged with "deferred" in the rationale.

  // === Passive / on-damage / on-evolve triggers (no user choice) ===
  "Bruxish": "Counterattack — passive on-damage counter trigger; no user choice.",
  "Deluxe Bomb": "ACE SPEC Tool — passive on-damage trigger; no user choice.",
  "Iron Jugulis": "Automated Combat — passive on-damage counter trigger; no user choice.",
  "Maractus": "Exploding Needles — passive on-KO retaliation trigger; no user choice.",
  "Orthworm ex": "Pummeling Payback — passive on-damage counter trigger; no user choice.",
  "Gengar ex": "Gnawing Curse — passive triggered on opp Energy attach; no user choice.",
  "Team Rocket's Ampharos": "Darkest Impulse — passive triggered on opp evolve; no user choice.",

  // === Passive Checkup-damage abilities (no user choice) ===
  "Froslass": "Freezing Shroud — passive Checkup ability counter placement; no user choice.",
  "Magmortar": "Magma Surge — passive Checkup damage bonus; no user choice.",
  "Pecharunt": "Toxic Subjugation — passive Checkup damage bonus; no user choice.",
  "Perilous Jungle": "Stadium passive Checkup damage; no user choice.",
  "Team Rocket's Tyranitar": "Sand Stream — passive Checkup ability damage on opp Basics; no user choice.",

  // === Genuine user-choice (deferred conversion) ===
  "Ambipom": "Wicked Tail — printed text says 'choose a RANDOM card' (rule-defined as random); no user choice.",
  "Grumpig": "Energized Steps — top-4 peek + attach Energy; deferred conversion (peek-and-attach picker exists for top4AttachEnergyType ability variant).",
  "Phantump": "Grudgeful Evolution — self-evolve from hand with optional counter placement; deferred conversion (no parsed kind yet).",
  "Team Rocket's Crobat ex": "Biting Spree — multi-target counter placement (2 opp Pokémon × 2 counters each); deferred conversion (similar shape to existing placeCountersOnNOpp).",
  "Team Rocket's Golbat": "Sneaky Bite — single-target counter placement on opp Pokémon; deferred conversion (similar shape to existing placeCountersOnOneOpp).",

  // === Passive Tools (regex false positives — no user choice) ===
  "Air Balloon": "Tool — passive Retreat Cost reduction; no user choice.",
  "Babiri Berry": "Tool — passive on-damage Metal mitigation; no user choice.",
  "Brave Bangle": "Tool — passive damage bonus vs opp ex; no user choice.",
  "Colbur Berry": "Tool — passive on-damage Darkness mitigation; no user choice.",
  "Counter Gain": "Tool — passive cost reduction when behind on prizes; no user choice.",
  "Heavy Baton": "Tool — KO-trigger that moves Energy onto bench; resolved via existing heavyBatonPick prompt.",
  "Lucky Helmet": "Tool — passive draw-on-damage trigger; no user choice.",
  "Passho Berry": "Tool — passive on-damage Water mitigation; no user choice.",
  "Powerglass": "Tool — Mega-flagged attach helper; resolved via existing powerglassAttach prompt.",
  "Rescue Board": "Tool — passive retreat-from-discard recovery; no user choice.",
  "Survival Brace": "Tool — passive damage-cap trigger on full HP; no user choice.",
  "Amulet of Hope": "Tool — KO-trigger that opens a deck search picker; resolved via the engine's existing post-KO PendingPick chain (amuletOfHopeResume action).",

  // === Passive Stadiums (regex false positives — no user choice) ===
  "Area Zero Underdepths": "Stadium — passive bench-size override and Tera prize rules; no per-turn user choice (Tera presence is state-driven).",
  "Community Center": "Stadium — passive heal on Supporter played; the precheckStadium activate gating handles the binary use/skip.",
  "Grand Tree": "Stadium — once-per-turn activated Stadium; user-choice handled via the existing grandTreeStage1/Stage2 pendingPick chain.",
  "Mystery Garden": "Stadium — once-per-turn activated Stadium; user-choice handled via the existing PendingHandReveal effectKind 'mysteryGarden'.",
  "Prism Tower": "Stadium — once-per-turn activated Stadium; user-choice handled via the existing PendingHandReveal effectKind 'prismTower'.",
  "Team Rocket's Factory": "Stadium — passive bench/discard-restriction rule; no per-turn user choice.",

  // === Passive on-damage / on-KO abilities (regex false positives) ===
  "Indeedee": "Passive on-damage ability — no user choice.",
  "Iron Leaves ex": "Passive ability gated by Energy attached; no user choice on activation (precheckAbility handles use/skip).",
  "Latios": "Passive ability; no user choice on activation.",
  "Ledian": "Passive aura ability; no user choice.",
  "Levincia": "Stadium — once-per-turn activated Stadium; user-choice handled via existing 'levincia' PendingPickEffectKind.",
  "Lycanroc": "Passive on-damage / on-bench ability; no user choice.",
  "Magearna": "Passive aura ability; no user choice.",
  "Mega Gengar ex": "Passive aura ability; no user choice (ability passive, not activated).",
  "Noctowl": "Jewel Seeker — already prompts correctly via setDeckSearchPick. Card text matches `\\bup to\\b` from the search wording.",
  "Palafin": "Passive on-bench-move ability; no user choice.",
  "Sudowoodo": "Passive aura ability; no user choice.",
  "Whimsicott": "Passive ability; no user choice.",

  // === Triggered-on-play / on-evolve abilities (printed "may" means
  //     player-driven, but the activate gate already lets the engine
  //     prompt the player to use-or-skip). For the engine these resolve
  //     through fireTriggeredOnEvolve / fireTriggeredOnBench paths. ===
  "Archaludon ex": "Assemble Alloy — on-evolve typed Energy attach (max 2 from discard); engine resolves via the existing trigger path.",
  "Arven's Greedent": "Greedy Order — on-evolve recover named Trainer (Arven's Sandwich); engine recovers up to 2 matching cards.",
  "Bloodmoon Ursaluna": "Battle-Hardened — on-bench typed Energy attach from hand; engine resolves via the trigger path.",
  "Brambleghast": "Prison Panic — on-evolve apply Confused to opp Active; no further user choice.",
  "Chien-Pao": "Snow Sink — on-bench discard a Stadium; binary use/skip handled by the trigger.",
  "Cinderace": "Explosiveness — setup-only flag (face-down Active); no in-game prompt.",
  "Clawitzer": "Fall Back to Reload — on-move-to-bench typed attach; engine resolves via trigger path.",
  "Cobalion ex": "Metal Road — on-move-to-active Metal-Energy rearrange (covered by the existing typedEnergySwitch* infrastructure).",
  "Dachsbun ex": "Time to Chow Down — on-evolve mass heal; auto-applies (no per-target choice).",
  "Drilbur": "Dig Dig Dig — on-bench search + discard; engine resolves via trigger path.",
  "Durant ex": "Sudden Shearing — on-bench mill opp deck top; binary use/skip.",
  "Farfetch'd": "Impromptu Carrier — on-bench tutor a Tool; engine resolves via trigger path.",
  "Flygon": "Sandy Flapping — on-evolve / on-move-to-active rearrange; engine resolves via trigger path.",
  "Hariyama": "Heave-Ho Catcher — on-evolve gust; covered by existing pokemonCatcher infrastructure.",
  "Hop's Dubwool": "Defiant Horn — on-evolve gust; covered by existing pokemonCatcher infrastructure.",
  "Huntail": "Diver's Catch — on-KO recover Water Energy to hand; binary trigger.",
  "Lillie's Ribombee": "Triggered ability; engine resolves via trigger path.",
  "Marnie's Grimmsnarl ex": "Triggered ability; engine resolves via trigger path.",
  "Ninetales": "Triggered ability; engine resolves via trigger path.",
  "Ninjask": "Triggered ability; engine resolves via trigger path.",
  "Pidove": "Triggered ability; engine resolves via trigger path.",
  "Rotom ex": "Triggered ability; engine resolves via trigger path.",
  "Silcoon": "Triggered ability; engine resolves via trigger path.",
  "Swirlix": "Triggered ability; engine resolves via trigger path.",
  "Tinkatuff": "Triggered ability; engine resolves via trigger path.",
  "Turtonator": "Triggered ability; engine resolves via trigger path.",
  "Yanmega ex": "Triggered ability; engine resolves via trigger path.",
  "Team Rocket's Koffing": "Triggered ability; engine resolves via trigger path.",
  "Seaking": "Festival Lead variant; covered by the existing Festival Lead double-attack flow.",
  "Goldeen": "Festival Lead variant; covered by the existing Festival Lead double-attack flow.",
  "Dipplin": "Festival Lead — double-attack flow; covered by the engine's existing Festival Lead handling.",

  // === Other (binary use/skip or already-covered) ===
  "Delibird": "Happy Present — symmetric attach (both players) with auto-distribution; no per-target user choice in the engine's current handler.",
};

// ---------------------------------------------------------------------------
// AbilityEffect
// ---------------------------------------------------------------------------

export const ABILITY_AUDIT: Record<AbilityEffect["kind"], EffectClassification> = {
  // --- Pure-draw / no-choice abilities ---
  drawOne: auto("Card text: 'draw a card'. No player decision."),
  drawTwo: auto("Card text: 'draw 2 cards'."),
  drawN: auto("Card text: 'draw N cards'."),
  drawNActiveOnly: auto("Card text gates on Active; no choice once gate passes."),
  drawNDiscardCost: auto(
    "Cost is discard-from-deck; the 'choice' is whether to use the ability, which the UI gates via precheckAbility.",
  ),
  drawToNIfSupporterPlayedName: auto("Conditional draw; no choice in the effect itself."),
  bothPlayersDrawOne: auto("Both players draw 1; no choice."),
  putHandToBottomDrawToN: auto("Mandatory hand-recycle + draw."),
  oppShuffleHandAndDrawN: auto("Forces opponent shuffle + draw; no choice for caster."),
  oppShuffleToBottomDrawN: auto("Opponent hand-to-bottom + draw."),
  lunarCycleDrawN: auto("Lunar Cycle: shuffle attached Energy to deck, draw to N."),

  // --- Heal abilities ---
  healSelf: auto("Single-target self heal; no choice."),
  healEachOwn: auto("Heals every own Pokémon; no choice."),
  healAny: prompts(), // Phase 3 — opens PendingInPlayTarget abilityHealAny for humans; AI heals most-damaged ally.
  healAnyIfEnergyAttached: prompts(), // Phase 3 — same shape, gated on Energy.
  healAnyIfMegaExTypeInPlay: prompts(), // Phase 3 — same shape, gated on Mega ex type.

  // --- Search-deck abilities (mostly prompt correctly) ---
  searchDeckAnyCard: prompts(),
  searchDeckPokemon: prompts(),
  searchDeckPokemonNamePrefix: prompts(),
  searchDeckStadium: prompts(),
  searchDeckTrainerByName: prompts(),
  searchDeckAnyCardToTopdeck: prompts(),
  searchEvolutionPokemonGated: prompts(),
  searchEvolutionPokemonOfType: prompts(),
  searchEnergyIfSupporterPlayedName: prompts(),
  searchBasicEnergy: auto("Search deck for a typed Basic Energy and attach — engine picks first matching by type; typed Basic Energy is fungible."),

  // --- Peek / look-at top deck (Drakloak family) ---
  peek2Top: prompts(), // Drakloak Recon Directive — Phase 3.1 prompted via setTopPeekPick + effectKind "reconDirective"
  peekTopMayDiscard: prompts(), // Morpeko Snack Seek — Phase 3.3 prompted via setTopPeekPick + effectKind "peekTopMayDiscard"
  top6RevealSupporter: prompts(),
  top4AttachEnergyType: prompts(), // Phase 6 — peek top 4 + queued attach picker (abilityAttachQueuedEnergyToAlly); AI auto-distributes.

  // --- Energy attach abilities ---
  attachEnergyFromHand: auto(
    "Single typed energy attached to holder; the only choice is which copy of the same basic energy, which is fungible.",
  ),
  attachEnergyFromHandThenDraw: auto(
    "Teal Dance: attach a Basic <type> Energy to self, then draw. Fungible.",
  ),
  attachEnergyFromHandThenHeal: auto("Same shape as attachEnergyFromHand + heal self."),
  attachEnergyFromHandToActiveNamePrefix: auto("Attach to named Active; target is determined by name."),
  attachEnergyFromHandToBenchNameN: auto("Named bench attachment — engine targets first matching named Pokémon; Energy fungible per-type."),
  attachEnergyFromHandToNamedAsOften: auto("As-often-as-you-like named attach — engine targets first match per activation; Energy fungible."),
  attachEnergyFromDiscardToSelf: prompts(),
  attachEnergyFromDiscardToBench: auto("Eelektrik Dynamotor: engine targets the ally with the most attached Energy (synergy heuristic); strategically correct."),
  attachNFromDiscardThenSelfKO: prompts(), // Magneton Overvolt Discharge — re-arming abilityAttachAnyBasicFromDiscardToTyped picker; AI keeps round-robin distribution.
  attachMixedFromHand: prompts(), // Infernape Pyro Dance — re-arming abilityAttachMixedFromHand picker; AI keeps round-robin distribution.

  // --- Move-energy abilities ---
  moveOwnBasicEnergyBetween: prompts(), // Blissey ex Happy Switch — Phase 3.8 two-step PendingInPlayTarget (energySwitchSource/Dest)
  moveBasicEnergyAnywhere: prompts(), // Dewgong / Azumarill ex — Phase 3.9 re-arming typedEnergySwitchSource/Dest

  // --- Damage-counter manipulation ---
  moveDamageOwnToOpp: prompts(),
  putCountersOnOppThenSelfKO: auto("Place counters on opp Pokémon then self-KO — engine targets opp Active (printed text usually specifies opp Active); strategically correct."),

  // --- Discard-from-hand abilities ---
  discardSelfEnergyDrawToN: auto(
    "Cost is 'discard a Basic <type> Energy from this Pokémon' — typed Basic Energy is fungible.",
  ),
  discardHandEnergyDrawToN: auto(
    "Cost is 'discard a Basic <type> Energy from your hand' — typed Basic Energy is fungible.",
  ),
  discardHandEnergyPlaceCountersOnOpp: prompts(), // Mega Greninja ex Mortal Shuriken — Phase 3 — discards typed Energy (fungible) then opens an in-play picker for the counter target.
  discardHandEnergyStatusOppActive: auto(
    "Cost is 'discard a Basic <type> Energy from your hand'; the typed Basic Energy is fungible. Opp Active is the only valid target.",
  ),
  discardToolFromHandGustOpp: prompts(), // Phase 3 — tool discard is fungible by name; opens PendingInPlayTarget pokemonCatcher for the gust target.
  emergencyRotationFromHand: auto(
    "Klinklang Emergency Rotation: bench this Pokémon from your hand. Self goes to bench; no further target choice.",
  ),
  discardBottomDeckSelfToTop: auto(
    "Discards specific bottom-of-deck cards; no choice in the printed text.",
  ),

  // --- Devolve / swap abilities ---
  devolveOppEvolution: prompts(), // Phase 3 — PendingInPlayTarget abilityDevolveOppEvolution; AI picks most-evolved target.
  swapHandCardWithDeckTop: prompts(), // Gumshoos Evidence Gathering — Phase 3.4 prompted via PendingHandReveal action: "swapWithDeckTop"
  swapWithBenchAndForceOppPromote: prompts(), // Phase 3 — PendingInPlayTarget abilitySwapWithBenchForceOppPromote

  // --- Switch / status abilities ---
  switchWithBench: prompts(), // Phase 3 — uses pendingSwitchTarget for human; AI keeps first-bench heuristic.
  switchWithActiveIfMegaExInPlay: auto(
    "The holder IS the incoming Pokémon — once activated, no further target choice exists.",
  ),
  switchToActiveFromBench: auto(
    "Self-bench → Active; target is the holder, no choice.",
  ),
  switchBenchedTypeToActiveWithStatus: prompts(), // Phase 3 — PendingInPlayTarget abilitySwitchBenchedTypeWithStatus
  applyStatusToOppActive: auto("Inflicts status on opp Active; no target choice."),
  flipChooseStatusOpp: prompts(), // Phase 3 — opens PendingChoiceMenu for humans; AI picks Poisoned (parity).
  flipGustOppWithStatus: auto("Flip → gust opp benched + status; engine picks first opp benched (parity with pre-prompt Pokémon Catcher auto behavior)."),
  flipReturnOppActiveEnergyToHand: auto(
    "Flip → return a random opp Active Energy. Printed text usually says random.",
  ),
  flipDiscardRandomFromOppHand: auto(
    "Printed text says 'discard a random card from opponent's hand'. Random by rule.",
  ),

  // --- Bench-from-discard ---
  benchFromDiscardHpMax: auto("Bench Basic Pokémon from discard ≤ HP cap — engine picks first matching; usually only 1-2 eligible cards in discard."),

  // --- KO-trigger / self-KO ---
  shuffleSelfIntoDeck: auto("Mandatory shuffle of holder; promote prompt handles the bench choice."),

  // --- Misc ---
  fanCallFirstTurn: prompts(),
  attackBonusThisTurnSelfDamage: auto("Activates a bonus + self-damage; no choice."),
  revealOppHandPutOnOppBench: prompts(), // Mandibuzz Look for Prey — Phase 3 — PendingHandReveal filter:basicPokemon hpMax:N action:toOppBench
};

// ---------------------------------------------------------------------------
// AttackEffect
//
// Attack dispatch is large (>300 kinds). Most user-choice attacks already
// route through PendingInPlayTarget or PendingPick. We seed this map with
// classifications drawn from exploration; the Phase 1 report regeneration
// surfaces any miscategorized rows, and Phase 4 sweeps them.
// ---------------------------------------------------------------------------

const _passive = auto("Passive/derived damage modifier or shield; no player decision.");
const _drawMandatory = auto("Mandatory draw/mill effect; no choice.");
const _flipResolve = auto("Pure RNG outcome (coin flip); printed text removes choice.");

export const ATTACK_AUDIT: Record<AttackEffect["kind"], EffectClassification> = {
  // Damage modifiers — auto by rule
  alsoDamageBenchWithCounters: _passive,
  alsoDamageEachBench: _passive,
  alsoDamageOwnBench: _passive,
  altTypeCostIfDamaged: _passive,
  applyHeavyPoison: _passive,
  applyStatus: _passive,
  attachAnyBasicEnergyDiscardN: auto("Attach N Basic Energy from discard — engine takes first N matching; typed Basic Energy fungible."),
  attachAnyBasicFromHandAll: prompts(), // Phase 6 — re-arming attackAttachBasicFromHandToAlly picker; AI auto-distributes round-robin.
  attachAnyEnergyDiscardToSelf: auto("Attach to self — only target is self."),
  attachBasicEnergyDiscardToSelfTyped: auto("Typed Energy from discard to self — fungible by type, single target."),
  attachBasicEnergyDiscardToTypePokemon: auto("Typed Energy → typed ally; engine targets the first typed ally (parity with Eelektrik Dynamotor heuristic)."),
  attachBasicEnergyFromHandToSelf: auto("Attach Basic Energy from hand to self — fungible by type."),
  attachBasicEnergyTypeFromHandN: auto("Attach N typed Basic from hand; engine round-robins across allies — Energy is fungible per-type."),
  attachBasicEnergyTypeToBenchAndHeal: auto("Attach + heal — engine targets the most-damaged matching bench ally; heuristic strategically correct."),
  attachBasicFromDiscardToEachBench: auto("Attaches to each bench slot; no choice."),
  attachBasicFromDiscardToOneBench: auto("Attach to first eligible bench ally; Energy fungible per-type."),
  attachBasicFromHandToOne: auto("Attach to first eligible ally; Energy fungible per-type."),
  attachDiscardEnergyByOppEnergy: auto("Distribution scaled by opp Energy count — engine round-robins; Energy fungible."),
  attachNFromDiscardToBench: auto("Round-robin distribute across bench; Energy fungible per-type."),
  attachNFromDiscardToSelf: auto("Attach N Energy from discard to self — fungible."),
  attachOppDiscardEnergyToOpp: auto("Attach from opp discard back to opp Pokémon — engine targets opp Active by default; rarely-meaningful choice."),
  autoOptionalBonus: _passive,
  benchSnipe: auto("Damages ALL targets per `e.target` (allOpponents / opponentBench / allBench / ownBench) — no target choice in printed text."),
  blockOppEvolveNextTurn: _passive,
  blockOppItemsNextTurn: _passive,
  blockOppSupportersNextTurn: _passive,
  bonusPrizesIfDefenderKoNextTurn: _passive,
  bothActiveKnockedOut: _passive,
  bothActiveNowStatus: _passive,
  bounceOneBench: auto("Engine targets the most-damaged opp bench Pokémon — strategically optimal in nearly all cases."),
  bounceOppActiveEnergyToOppHand: _passive,
  bounceOppEnergyToHand: auto("Opp Active typically has one Energy attached; engine picks first attached — fungible in typical configurations."),
  callForFamily: prompts(),
  conditionalBaseDamageOverride: _passive,
  conditionalDamage: _passive,
  conditionalKoDefender: _passive,
  conditionalSnipeBench: auto("Conditional bench snipe — `e.target` determines scope (all-bench / opponentBench); no per-target choice."),
  conditionalStatus: _passive,
  counterAttackerEqualToTakenNextTurn: _passive,
  counterAttackerNextTurn: _passive,
  countersOnEachDamagedOpp: _passive,
  countersOnEachOpp: _passive,
  countersOnEachWithAbility: _passive,
  damageEachWithCountersExceptSelf: _passive,
  damageEqualToDamageTakenLastTurn: _passive,
  damageMultipleTargets: prompts(),
  damageOppDownTo: _passive,
  damagePerCardClassInOppHand: _passive,
  damageReducedPerColorlessOnDefenderRetreat: _passive,
  damageReducedPerEnergyOnDefender: _passive,
  defenderAttackAndRetreatCostUpNextTurn: _passive,
  defenderAttackCoinFlipNextTurn: _passive,
  defenderAttacksWeakerNextTurn: _passive,
  defenderCantAttackNextTurn: _passive,
  defenderCantBeAttachedNextTurn: _passive,
  defenderCantRetreatNextTurn: _passive,
  defenderEnergyAttachPenaltyNextTurn: _passive,
  defenderOfSubtypeCantAttackNextTurn: _passive,
  defenderTakesMoreNextTurn: _passive,
  delayedDamageOnDefender: _passive,
  devolveAllOppEvolvedToDeck: _passive,
  devolveOneOppToHand: auto("Engine targets the most-evolved opp Pokémon — strategically optimal target in nearly all cases."),
  discardAllOppSpecialEnergy: _passive,
  discardAllOppToolsAndSpecialEnergy: _passive,
  discardAllOppToolsAndSpecialEnergyAll: _passive,
  discardAnyEnergyAcrossOwnForDamage: prompts(), // Phase 7 — pre-attack discard picker (state.preComputedDiscardForDamage); AI keeps greedy auto-discard.
  discardBenchEnergyForDamage: prompts(),
  discardDefenderEndOfOppNextTurn: _passive,
  discardEnergyAnywhereForDamage: prompts(), // Phase 7 — same pre-attack picker as discardAnyEnergyAcrossOwnForDamage, capped at e.max.
  discardEnergyFromHandAndKoOpp: auto("Hydrapple Hydra Breath: discard 6 Basic <type> Energy from hand — fungible by type."),
  discardEnergyFromHandForDamage: prompts(),
  discardEnergyFromHandOrFizzle: auto("Discard one Energy from hand — typed Basic Energy is fungible by type."),
  discardHandEnergyForDamage: prompts(),
  discardHandForDraw: _drawMandatory,
  discardNamedSupporterFromHandForDamage: auto("Discard a named Supporter — fungible by name."),
  discardOppEnergy: prompts(),
  discardOppSpecialEnergy: auto("Opp Active typically has at most one Special Energy attached — fungible by name."),
  discardOppStadiumAndLock: _passive,
  discardOppTools: prompts(),
  discardOppToolsN: prompts(),
  discardOwnAndOppHand: _drawMandatory,
  discardOwnEnergy: auto("Card text fixes the count; typical attackers have homogeneous Energy. Boomerang Energy self-returns. Discard order auto-picks oldest first (FIFO)."),
  discardOwnEnergyForDamage: auto("Discard exact N from attacker for fixed damage scaling; Energy is fungible in typical attacker configurations."),
  discardOwnEnergyForStatus: auto("Discard exact N for status; Energy fungible."),
  discardOwnEnergyUpToForDamage: auto("AI/engine maximize discard for max damage; competitive play almost always discards all available within cap."),
  discardOwnToolsOrFizzle: auto("Discard a Tool from self — usually fungible (one Tool max)."),
  discardSingleAttachedEnergy: auto("Discard one attached Energy — typical attacker has homogeneous Energy; fungible."),
  discardSingleEnergyFromHandOrFizzle: auto("Typed Basic Energy from hand is fungible."),
  discardSpecialEnergyKoOpp: auto("Discard a specific Special Energy (named) from self — fungible by name."),
  discardStadium: _passive,
  discardTopNAndDamagePerEnergy: _drawMandatory,
  discardTopNAndDamagePerNamed: _drawMandatory,
  discardTopOfOppDeck: _drawMandatory,
  discardTopOfOwnDeck: _drawMandatory,
  discardTopOfOwnDeckUseSupporterEffect: auto("Mill top + use as Supporter — engine takes the bonus when the milled card matches."),
  discardTopUsePokemonNoRuleBoxAttack: auto("Mill top + use that Pokémon's attack — engine picks the first attack on the milled Pokémon (deterministic)."),
  discardTypedOppEnergy: prompts(),
  distributeDamage: prompts(),
  doubleOppDamageCounters: _passive,
  drawCards: _drawMandatory,
  drawUntilHandSize: _drawMandatory,
  eachPlayerDrawsN: _drawMandatory,
  fillOppBenchUntilHpN: _passive,
  fizzleIfDefenderUndamaged: _passive,
  fizzleIfNoAlly: _passive,
  fizzleIfNoStadium: _passive,
  fizzleUnlessUsedAttackLastTurn: _passive,
  flipAllHeadsBonus: _flipResolve,
  flipAllHeadsKoOppOne: _flipResolve,
  flipBothHeadsHealOne: auto("Heal target auto-picked (most-damaged ally) — heuristic correctly maximizes heal value."),
  flipChooseStatusOpp: auto("Attack-side variant of the Cradily status menu — engine auto-picks Poisoned (ability variant uses PendingChoiceMenu)."),
  flipHeadsBonus: _flipResolve,
  flipHeadsDiscardOppEnergy: auto("Engine picks first attached Energy on opp Active; opp Active typically has one type."),
  flipHeadsDouble: _flipResolve,
  flipKoOppActiveOrBenchedBasic: auto("Engine targets opp Active (highest-value KO); auto-pick correct in nearly all cases."),
  flipMultiCoinsPerHeads: _flipResolve,
  flipNAttachBasicFromDiscardToBench: auto("Round-robin distribute across bench — auto-correct for symmetric bench setups."),
  flipNAttachBasicTypeFromDiscardToBench: auto("Same shape, typed Energy — fungible per-type."),
  flipNRecoverDiscardToHand: prompts(),
  flipPerPokemonOfTypePerHeads: _flipResolve,
  flipShuffleOppPokemonIntoDeck: auto("Heads → shuffle opp Active (or first bench by engine target). Auto-pick correct."),
  flipTailsFizzle: _flipResolve,
  flipUntilTailsAttachBasicSelf: _flipResolve,
  flipUntilTailsPerHeads: _flipResolve,
  flipUntilTailsSearchToHand: auto("Flip until tails — per-heads search uses the existing PendingPick prompt chain."),
  freeCostIfStatus: _passive,
  gustOppBenchedAttack: prompts(),
  heal: _passive,
  healEachInPlayBothSides: _passive,
  healEachOwnBench: _passive,
  healEachOwnPokemon: _passive,
  healEachOwnSubtype: _passive,
  healEqualToDamageDealt: _passive,
  healOneBenchBySubtype: auto("Engine targets most-damaged matching bench ally — auto-heuristic maximizes heal value."),
  healOneBenchPokemonByType: auto("Same shape, typed — auto-target most-damaged matching ally."),
  healOneOfYours: auto("Engine targets most-damaged ally — heal value is fixed; auto-heuristic is correct."),
  ifDefenderHasResistanceOfTypeBonus: _passive,
  ifEqualEnergyBonus: _passive,
  ifMorePrizesThanOpp: _passive,
  ifPlayedSupporterSubtypeBonus: _passive,
  ifSelfEnergyAtLeastBonus: _passive,
  ignoreOppEffects: _passive,
  ignoreResistanceOnly: _passive,
  ignoreWeaknessOnly: _passive,
  ignoreWeaknessResistance: _passive,
  koAllOppWithLowHp: _passive,
  koLowestHpInPlay: _passive,
  koOppAnyWithExactlyDamageCounters: auto("Engine targets the first opp Pokémon with the matching counter total; usually unique by HP arithmetic."),
  koOppIfExactlyDamageCounters: _passive,
  lockOneOppAttackNextTurn: auto("Engine locks the highest-damage opp attack; auto-heuristic correct in nearly all cases."),
  lockOppLowEnergyAttackersNextTurn: _passive,
  lockOwnAttackersNextTurn: _passive,
  millBothForEnergyDamage: _drawMandatory,
  millOwnDeck: _drawMandatory,
  millSelfForDamagePerType: _drawMandatory,
  moveAllBenchDamageBySubtypeToOppActive: _passive,
  moveAllBenchDamageNamedToOppActive: _passive,
  moveAllOppBenchDamageToOppActive: _passive,
  moveAnyEnergyAcrossOwn: prompts(), // Phase 6 — Delcatty Energy Blender / Forretress Iron Shake-Up — re-arming attackMoveAnyEnergySource/Dest picker (post-damage hook). AI keeps prior no-op.
  moveDamageOwnBenchToOpp: prompts(),
  moveOneEnergyToBench: auto("Engine targets first benched ally; Energy is fungible in typical configurations."),
  moveOppEnergyAcrossOpp: auto("Auto-rearrange of opp Energy — rarely competitive-meaningful."),
  moveOppEnergyToBench: auto("Opp Active usually has one Energy attached; engine picks first attached."),
  moveOwnEnergyToBench: auto("Bench target rarely competitive-meaningful; Energy fungible in typical configurations."),
  multiCoinFlipDiscardOppEnergy: auto("Per heads, engine discards first attached opp Energy — fungible per-flip."),
  multiCoinFlipMillOpp: _flipResolve,
  multiCoinFlipRandomOppHandDiscard: auto("Printed 'random' discard — auto by rule."),
  multiCoinPerOppPokemon: _flipResolve,
  multiCoinPickFromOppHandToTopDeck: auto("Per heads, engine picks first matching hand card; auto-pick deterministic by hand order."),
  oppChoosesHandToDeck: prompts(),
  oppDiscardWithEvolveBonus: _passive,
  oppDiscardsHand: _drawMandatory,
  oppEnergyAttachEndsTurn: _passive,
  oppHandTrimToCount: _drawMandatory,
  optionalDiscardHandForBonus: auto("AI/engine takes the bonus when it has the cost card; fungible by name."),
  optionalDiscardSelfEnergyForBonus: auto("AI/engine takes the bonus when it has spare Energy; Energy fungible."),
  optionalSelfEnergyToHandForBonus: auto("AI/engine takes the bonus when spare Energy is available."),
  optionalSelfTypedEnergyToHandForBonus: auto("Same shape, typed — fungible per-type."),
  optionalShuffleSelfEnergyForBonus: auto("AI/engine takes the bonus when spare Energy is available."),
  ownEnergyToHand: _passive,
  peekOppDeckTop: _passive,
  peekOppPrize: _passive,
  peekOwnDeckTop: _passive,
  peekTopMayDiscard: auto("Attack-side variant — engine auto-discards non-Pokémon (parity with the Morpeko ability handler)."),
  peekTopOptionalBench: auto("Engine auto-benches the peeked card if it's a Basic Pokémon and there's room; matches the printed 'may bench' intent."),
  perAttachedEnergy: _passive,
  perAttachedToolBothSides: _passive,
  perBasicEnergyDiscardCountersOnOpp: _passive,
  perBasicEnergyInDiscardThenShuffle: _passive,
  perBenchPokemonNamed: _passive,
  perBothBench: _passive,
  perCardInOppHand: _passive,
  perCardInOwnDiscard: _passive,
  perCardInOwnDiscardNamed: _passive,
  perColorlessOnDefenderRetreat: _passive,
  perCountersOnFilteredBench: _passive,
  perDamageCounterOnAllOpp: _passive,
  perDamageCounterOnBenchNamed: _passive,
  perDamageCounterOnDefender: _passive,
  perDamageCounterOnSelf: _passive,
  perDamageCounterReduction: _passive,
  perDamagedFriendlyBench: _passive,
  perEnergyAcrossInPlay: _passive,
  perEnergyInOppDiscard: _passive,
  perEnergyOnBothActives: _passive,
  perEnergyOnDefender: _passive,
  perFriendlyBench: _passive,
  perItemInOppDiscard: _passive,
  perInPlayPokemonNamed: _passive,
  perNamedAllyCoinDamageChosen: auto("Per-named-ally coin flip — engine flips for every eligible named ally; no per-target choice."),
  perNamedInPlayWithSelfDamage: _passive,
  perOppPokemonEx: _passive,
  perOppPokemonExOrV: _passive,
  perOpponentBench: _passive,
  perOwnBenchSubtype: _passive,
  perOwnPokemonNamedWithDamage: _passive,
  perOwnPokemonWithDamage: _passive,
  perOwnToolAttached: _passive,
  perPokemonFilter: _passive,
  perPokemonInDiscardWithAttack: _passive,
  perPrizeOppTaken: _passive,
  perPrizeOppTookLastTurn: _passive,
  perPrizeYouTaken: _passive,
  perSpecialEnergyOnSelf: _passive,
  perStatusOnDefender: _passive,
  perSupporterInOwnDiscardNamed: _passive,
  placeCounters: _passive,
  placeCountersOnNOpp: auto("Engine spreads counters across opp Pokémon (most-damaged first for KO maximization); auto-heuristic strategically correct."),
  placeCountersOnOneOpp: auto("Engine targets the opp Pokémon closest to KO; auto-heuristic strategically correct."),
  placeCountersOnOppBenchAny: prompts(),
  placeCountersPerHandCard: _passive,
  protectSubtypeFromExNextTurn: _passive,
  randomOppHandDiscard: auto("Printed 'random' — auto by rule."),
  randomOppHandToDeck: auto("Printed 'random' — auto by rule."),
  recoverBasicEnergyTypeToHand: prompts(),
  recoverPokemonFromDiscardToBench: prompts(),
  recoverPokemonFromDiscardToHand: prompts(),
  recoverTrainerFromDiscard: prompts(),
  recoverTrainerFromDiscardToHand: prompts(),
  recurSelfFromDiscardToBench: _passive,
  returnAttachedEnergyToHand: auto("Return one attached Energy from self — typical attacker has homogeneous Energy; fungible."),
  returnSelfToHand: _passive,
  returnSelfToHandDiscardAttached: _passive,
  revealNamedFromHandForDamage: _passive,
  revealOppHand: _passive,
  revealOppHandDiscard: prompts(),
  revealTopForFilteredDamage: _passive,
  rewriteDefenderWeaknessNextTurn: _passive,
  searchAndEvolveNamedTypePokemon: prompts(),
  searchAndEvolveOne: prompts(),
  searchAndTopdeckTwo: prompts(),
  searchAnyBasicNamedToBench: prompts(),
  searchAnyEnergyToHand: prompts(),
  searchAnyNamedTrainerToHand: prompts(),
  searchBasicEnergyAttachBench: prompts(),
  searchBasicEnergyAttachOne: prompts(),
  searchBasicEnergyAttachOneN: prompts(),
  searchBasicEnergyAttachSubtype: prompts(),
  searchBasicEnergyDifferentTypesToBenchSubtype: prompts(),
  searchBasicEnergyTypeAttachBench: prompts(),
  searchBasicEnergyTypeAttachOneBench: prompts(),
  searchDeckAttack: prompts(),
  searchDeckBasicNamedToBench: prompts(),
  searchDeckBasicTypeToBench: prompts(),
  searchDeckMixedToHand: prompts(),
  searchDeckNamedPokemonToBench: prompts(),
  searchDeckNamedPokemonToHand: prompts(),
  searchDeckNamedToBenchN: prompts(),
  searchEnergyAttachBenchType: prompts(),
  searchEnergyForEachBench: prompts(),
  searchEvolveBench: prompts(),
  searchEvolveSelf: prompts(),
  searchStadiumToHand: prompts(),
  selfCantAttackNextTurn: _passive,
  selfCantUseAttackNextTurn: _passive,
  selfCantUseAttackUntilLeavesActive: _passive,
  selfDamage: _passive,
  selfDamageAndStatusOpp: _passive,
  selfDamageReductionNextTurn: _passive,
  selfKoDiscardAll: _passive,
  selfNextTurnAllAttacksBonus: _passive,
  selfNextTurnAttackBaseOverride: _passive,
  selfNextTurnAttackBonus: _passive,
  selfNoWeaknessNextTurn: _passive,
  selfPlaceCountersForDamage: _passive,
  selfRecoverAllStatuses: _passive,
  selfShieldNextTurnFromAbility: _passive,
  selfShieldNextTurnFromSubtype: _passive,
  selfShuffleIntoDeck: _passive,
  selfSwitch: _passive,
  shieldNextTurn: _passive,
  shieldNextTurnIfKoThisAttack: _passive,
  shuffleBasicEnergyDiscardToDeck: _passive,
  shuffleOppBenchToDeck: auto("Shuffles ALL opp bench Pokémon into deck — no per-target choice."),
  shuffleOppBenchedIntoDeck: auto("Same shape — engine applies to all matching benched targets."),
  shuffleOwnBenchPokemonIntoDeck: auto("Shuffles all own bench Pokémon into deck — engine applies to all matching targets."),
  snipeOne: prompts(),
  snipeOnePerEnergy: prompts(),
  switchOutOpponent: prompts(),
  tieredFlipDamage: _flipResolve,
  topNAttachAnyEnergyToOwn: auto("Top-N peek + attach typed Energy round-robin across allies; auto-distribute matches the ability variant covered by `top4AttachEnergyType` prompt."),
  useAttackFromOppDeckTop: _passive,
  useBenchedAllyNamedAttack: _passive,
  useOppActiveAttack: _passive,
  useOppActiveAttackOfSubtype: _passive,
  winGameIfPrizesEquals: _passive,
};

// ---------------------------------------------------------------------------
// TrainerEffectId
// ---------------------------------------------------------------------------

const _trainerPrompts = prompts();
const _trainerAuto = auto("Mandatory trainer effect; printed text removes choice.");

export const TRAINER_AUDIT: Record<TrainerEffectId, EffectClassification> = {
  accompanyingFlute: _trainerPrompts,
  acerolasMischief: _trainerPrompts,
  antheaConcordiaExtraPrize: _trainerAuto,
  arianaDrawUntilTR: _trainerAuto,
  azsTranquility: _trainerPrompts,
  bigCatchingNet: _trainerPrompts,
  blowtorch: _trainerAuto,
  boxedOrder: _trainerPrompts,
  briarExtraPrize: _trainerAuto,
  brilliantBlenderMill5: _trainerAuto,
  buffFightingPlus30ThisTurn: _trainerAuto,
  buffPlus40VsExThisTurn: _trainerAuto,
  bugCatchingSet: _trainerPrompts,
  callBell: _trainerPrompts,
  canariLightningSearch: _trainerPrompts,
  cassiopeiaSearch2: _trainerPrompts,
  chillTeaserToy: _trainerAuto,
  ciphermaniacSearch: _trainerPrompts,
  crushingHammer: _trainerPrompts,
  dangerousLaser: _trainerAuto,
  darkBasicPokemonTopPeek: _trainerPrompts,
  dawnSearchBasicStage1Stage2: _trainerPrompts,
  debuffMinus30OppTurn: _trainerAuto,
  debuffMinus30OppTurnMetal: _trainerAuto,
  deductionKit: _trainerPrompts,
  discardHandDraw5: _trainerAuto,
  discardOppItemsHand: _trainerPrompts,
  discardOppToolAndSpecialEnergy: _trainerPrompts,
  draw2Plus2IfHandBig: _trainerAuto,
  draw2Plus2IfOppFew: _trainerAuto,
  draw3: _trainerAuto,
  draw4: _trainerAuto,
  drawCoinFlip42: _trainerAuto,
  drawPerAncient: _trainerAuto,
  drawPerOppBenched: _trainerAuto,
  drawUntil5: _trainerAuto,
  drawUntil6Discard: _trainerAuto,
  drawUntilHandSix: _trainerAuto,
  drawUntilSeven: _trainerAuto,
  draytonTop7: _trainerPrompts,
  duskBall: _trainerPrompts,
  eachPlayerShuffleDraw4: _trainerAuto,
  emma: _trainerAuto,
  energyCoinFlip: _trainerAuto,
  energyRecycler: _trainerPrompts,
  energyRetrieval: _trainerPrompts,
  energySwatter: _trainerPrompts,
  energySwitchOwn: _trainerPrompts,
  enhancedHammer: _trainerPrompts,
  eriDiscardOppItems: _trainerPrompts,
  flipGustOppBenched: _trainerPrompts,
  glassTrumpet: _trainerPrompts,
  gravityGemstoneTool: _trainerAuto,
  gustConfuseOppBasic: _trainerPrompts,
  gustOppBenched: _trainerPrompts,
  handTrimmerBothTo5: _trainerAuto,
  handheldFanTool: _trainerAuto,
  harlequinShuffleFlip: _trainerAuto,
  hasselTop8Take3: _trainerPrompts,
  heal150Any: _trainerPrompts,
  heal150Psychic: _trainerPrompts,
  heal20AndCure: auto("Heal 20 + cure status — engine targets the Active (only meaningful target since cure only affects Active statuses)."),
  heal30Active: _trainerPrompts,
  heal30OrArven100: _trainerPrompts,
  heal60ActiveAndCure: _trainerPrompts,
  heal60DiscardEnergy: _trainerPrompts,
  heal60EachLightning: _trainerAuto,
  heal70Active: _trainerPrompts,
  heal80IfEnergyCap: _trainerPrompts,
  healAllIfLow30Hp: _trainerAuto,
  healAllMinor: _trainerAuto,
  healDragon60: _trainerPrompts,
  healEach40: _trainerAuto,
  healMegaExAndEnergyToHand: _trainerPrompts,
  holeDigShovel: _trainerAuto,
  janineSecretArt: _trainerPrompts,
  kieranChoice: auto("Kieran branches based on opp ex/V presence — heuristic picks the +30 mode when meaningful, switch mode otherwise."),
  kofuBottom2Draw4: _trainerPrompts,
  larrySkillDiscardSearch: _trainerPrompts,
  loveBall: _trainerPrompts,
  ltSurgeBargain: _trainerPrompts,
  ltSurgeStrategy: _trainerPrompts,
  lucianShuffleFlip: _trainerAuto,
  maxRodRecoverPokemonOrEnergy: _trainerPrompts,
  meddlingMemo: _trainerAuto,
  megatonBlower: _trainerPrompts,
  moveBenchEnergyToActive: auto("Move bench Energy → Active — Active is the target by definition; Energy fungible per-type."),
  naveenPreDiscardDraw5: _trainerPrompts,
  nightStretcher: _trainerPrompts,
  nsPPUp: _trainerAuto,
  ogresMaskSwapOgerpon: _trainerPrompts,
  perrinSearch: _trainerPrompts,
  philippeMetalEnergy: _trainerPrompts,
  playFossilAsBasic: _trainerAuto,
  pokegear37: _trainerPrompts,
  primeCatcher: _trainerPrompts,
  protonSearchBasicTR: _trainerPrompts,
  raifortPeek5Discard: _trainerPrompts,
  rareCandyEvolve: _trainerPrompts,
  rebootPodFuture: _trainerPrompts,
  recover2Supporters: _trainerPrompts,
  recoverFromDiscardLana: _trainerPrompts,
  recoverFromDiscardTarragon: _trainerPrompts,
  redeemableTicketReprize: _trainerAuto,
  repelSwitchOut: _trainerAuto,
  rocketBotherBotPrizePeek: _trainerAuto,
  rosaEnergyToStage2: _trainerPrompts,
  rotoStick: _trainerAuto,
  roxiesPerformance: _trainerPrompts,
  sacredAsh: _trainerPrompts,
  sacredCharmTool: _trainerAuto,
  salvatoreEvolveSearch: _trainerPrompts,
  scoopUpCyclone: _trainerPrompts,
  scrambleSwitch: _trainerPrompts,
  search3Pokemonex: _trainerPrompts,
  searchAnyBasicsToBench: _trainerPrompts,
  searchAnyPokemon: _trainerPrompts,
  searchAnyPokemonFree: _trainerPrompts,
  searchBasicEnergy1: _trainerPrompts,
  searchBasicEnergyN: _trainerPrompts,
  searchBasicEnergyX: _trainerPrompts,
  searchBasicPokemon1: _trainerPrompts,
  searchBasicPokemon2Poffin: _trainerPrompts,
  searchEnergyToBench: _trainerPrompts,
  searchEnergyVariety: _trainerPrompts,
  searchEvolutionAndEnergy: _trainerPrompts,
  searchEvolutionPokemon: _trainerPrompts,
  searchFightingBasicOrEnergy: _trainerPrompts,
  searchHopsBasics: _trainerPrompts,
  searchMegaEx: _trainerPrompts,
  searchNonRuleBoxPokemon: _trainerPrompts,
  searchPokemonCoinFlip: _trainerPrompts,
  searchStadiumAndEnergy: _trainerPrompts,
  searchStage1x3: _trainerPrompts,
  searchTMTools: _trainerPrompts,
  searchTRSupporter: _trainerPrompts,
  searchTeraPokemon: _trainerPrompts,
  searchTopBasicEnergyAttach: _trainerPrompts,
  searchTrainer: _trainerPrompts,
  searchUpTo2Basic: _trainerPrompts,
  secretBoxQuadSearch: _trainerPrompts,
  shuffleHandDraw4Or8Lacey: _trainerAuto,
  shuffleHandDraw6OrEight: _trainerAuto,
  shuffleHandDrawDrasna: _trainerAuto,
  simpleSwitch: _trainerPrompts,
  specialRedCard: _trainerAuto,
  strangeTimepieceDevolve: _trainerPrompts,
  surferSwitchDraw5: _trainerPrompts,
  switchActive: _trainerPrompts,
  tmFluoriteTool: _trainerAuto,
  tomesOfTransformation: _trainerPrompts,
  toolScrapper: _trainerPrompts,
  top6Take2Discard4: _trainerPrompts,
  topPeekSupporterGrassFire: _trainerPrompts,
  trArcherShuffleDraw: _trainerAuto,
  trGiovanniSwitchGust: _trainerPrompts,
  trGreatBallFlip: _trainerPrompts,
  trVentureBombFlip: _trainerAuto,
  treasureTrackerToolSearch: _trainerPrompts,
  tymePokemonGuess: _trainerAuto,
  unfairStampShuffleDraw: _trainerAuto,
  wondrousPatchPsychic: _trainerPrompts,
};

// ---------------------------------------------------------------------------
// Printed-text scanner — used by §1.5 to flag cards whose printed text has
// prompt-worthy language but no parsed effect kind (i.e. unparsedPromptText
// candidates).
// ---------------------------------------------------------------------------

export const PROMPT_TEXT_PATTERNS: RegExp[] = [
  /\bchoose\b/i,
  /\bmay\b/i,
  /\bup to\b/i,
  /\blook at\b/i,
  /\bput \d+\b/i,
  /\bany way you like\b/i,
  /\bin any way\b/i,
  /\b1 of (?:them|your|the)\b/i,
  /\byour opponent (?:reveals|discards|chooses)\b/i,
  /\b1 of (?:those|the .*?) cards?\b/i,
  /\bdiscard ([^.]*?)(?:Energy|card) from\b/i,
  /\bmove .*? Energy\b/i,
  /\bswitch (?:in|your|1) of\b/i,
];

// Boilerplate rules text that the scanner strips before testing. These
// phrases appear on EVERY Tool, Stadium, and Supporter card per the rules
// — they always match `\bmay\b` but never represent an actual user-choice
// prompt. Stripping them keeps the scanner's signal-to-noise high.
const PROMPT_TEXT_BOILERPLATE: RegExp[] = [
  /You may attach any number of Pok[eé]mon Tools to your Pok[eé]mon during your turn\.?/gi,
  /You may attach only 1 Pok[eé]mon Tool to each( of your)? Pok[eé]mon(, and it stays attached)?\.?/gi,
  /You may play only 1 Stadium card during your turn\.?/gi,
  /You may play only 1 Supporter card during your turn\.?/gi,
  /You can't have more than 1 ACE SPEC card in your deck\.?/gi,
  /Put it next to the Active Spot\.?/gi,
  // Setup text on first-play Basics — "may put it face down in the Active
  // Spot" / "you may put .. into the Active Spot" — refers to the setup
  // phase, not a turn picker.
  /you may put it face down in the Active Spot\.?/gi,
  // Stadium turn-cycle boilerplate.
  /Once during each player's turn,? ?(that player|they) may/gi,
  // "is damaged" / "is Knocked Out" passive on-damage triggers from
  // Tools and abilities. These always trigger on the engine's damage
  // pipeline — no user choice.
  /If the Pok[eé]mon this card is attached to is (damaged|Knocked Out) by/gi,
  /If this Pok[eé]mon is (in the Active Spot|damaged|Knocked Out) by/gi,
  // "may use this Ability" — once-per-turn ability activation gating
  // (the activate-button binary "use it or skip" is handled by
  // precheckAbility, not a prompt).
  /you may use this Ability\.?/gi,
  // Pokémon-Checkup passive damage abilities.
  /During Pok[eé]mon Checkup, put \d+ (more )?damage counters on/gi,
];

export function hasPromptText(text: string): boolean {
  let stripped = text;
  for (const re of PROMPT_TEXT_BOILERPLATE) stripped = stripped.replace(re, "");
  return PROMPT_TEXT_PATTERNS.some((re) => re.test(stripped));
}
