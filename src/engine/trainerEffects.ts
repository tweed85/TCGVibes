// Trainer effect dispatch and pattern matching.
//
// Trainer cards carry an `effectId` on the mapped card when the text matches a
// known pattern. At play time we dispatch on that id. Unmatched trainers
// simply go to discard without doing anything (their text is still displayed
// to the player via the card tooltip).
//
// We cover the most-played Supporters and staple Items in the current
// Standard-legal pool. Exotic conditions ("if opponent has exactly 2 Prizes",
// "if Community Center is in play") are mostly approximated or skipped; the
// core draw/search/heal behaviors are correct.

import { applyEvolveSideEffects, endTurn as endTurnRule, enforceSpecialEnergyAttachRules, isPlayersFirstTurn, logEvent, makePokemonInPlay, newInstanceId, passTurn, setPendingPromote, takePrizes } from "./rules";
import { clearAllStatuses } from "./rules";
import { benchDamageBlocked, benchDamageBlockedByFlowerCurtain, maxBenchSize } from "./ongoingEffects";
import {
  fireTriggeredOnEvolve,
  fireTriggeredOnMoveToActive,
  fireTriggeredOnMoveToBench,
  knockOutFromAbilityCounters,
  performGust,
} from "./abilities";
import { findByName } from "../data/cards";
import {
  recoverFromDiscardToHand,
  searchDeckToBench,
  searchDeckToHand,
} from "./effectPrefabs";
import {
  setDeckSearchPick,
  setDiscardRecoveryPick,
  setTopPeekPick,
  setBottomPeekPick,
} from "./pendingPick";
import type {
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PlayerState,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";
import type { TrainerTarget } from "./actions";
import { resumeSecondAttack } from "./actions";

// Auto-detected effect ids.
export type TrainerEffectId =
  // Items (search / ball / heal / gust)
  | "searchBasicPokemon1" // Nest Ball
  | "searchBasicPokemon2Poffin" // Buddy-Buddy Poffin (70 HP or less cap)
  | "protonSearchBasicTR" // Team Rocket's Proton — up to 3 Basic TR Pokémon
  | "searchUpTo2Basic" // Brock's Scouting (no HP cap)
  | "searchAnyPokemon" // Ultra Ball (with discard 2)
  | "searchAnyPokemonFree" // Master Ball (no cost)
  | "searchNonRuleBoxPokemon" // Poké Pad
  | "searchStage1x3" // Hyper Aroma
  | "searchTeraPokemon" // Tera Orb
  | "searchPokemonCoinFlip" // Poké Ball (flip: search)
  | "searchBasicEnergy1" // Energy Search
  | "searchEnergyToBench" // Wondrous Patch / N's PP Up (restricted attach)
  | "heal30Active" // Potion
  | "heal30OrArven100" // Arven's Sandwich
  | "heal60DiscardEnergy" // Super Potion
  | "heal20AndCure" // Lumiose Galette
  | "heal80IfEnergyCap" // Jumbo Ice Cream
  | "simpleSwitch" // Switch
  | "flipGustOppBenched" // Pokémon Catcher
  | "nightStretcher" // Night Stretcher — 1 Pokémon or Basic Energy from discard
  | "energyRetrieval" // Energy Retrieval — up to 2 Basic Energy from discard
  | "energySwitchOwn" // Energy Switch — move a Basic Energy
  | "energyRecycler" // Energy Recycler — 5 Basic Energy discard → deck
  | "sacredAsh" // Sacred Ash — 5 Pokémon discard → deck
  | "toolScrapper" // Tool Scrapper — discard up to 2 Tools (any side)
  | "enhancedHammer" // Enhanced Hammer — discard Special Energy from opp
  | "crushingHammer" // Crushing Hammer — flip to discard Energy from opp
  | "handTrimmerBothTo5" // Hand Trimmer
  | "holeDigShovel" // Hole-Digging Shovel — discard top 2 of own deck
  | "pokegear37" // Pokégear 3.0 — top 7 → Supporter
  | "bugCatchingSet" // Bug Catching Set — top 7 → Grass Pokémon / Energy (up to 2)
  | "duskBall" // Dusk Ball — bottom 7 → 1 Pokémon
  | "rareCandyEvolve" // Rare Candy (placeholder)
  // Additional items
  | "searchMegaEx" // Mega Signal
  | "searchHopsBasics" // Hop's Bag (up to 2 Basic Hop's to bench)
  | "searchFightingBasicOrEnergy" // Fighting Gong
  | "searchTMTools" // TM Machine
  | "searchTRSupporter" // Team Rocket's Transceiver
  | "searchAnyBasicsToBench" // Precious Trolley (ACE SPEC)
  | "searchEnergyVariety" // Energy Search Pro (ACE SPEC)
  | "energyCoinFlip" // Energy Coin (2 coins, both heads → Basic Energy)
  | "trGreatBallFlip" // Team Rocket's Great Ball
  | "trVentureBombFlip" // Team Rocket's Venture Bomb
  | "healDragon60" // Dragon Elixir
  | "heal150Any" // Poké Vital A (ACE SPEC)
  | "dangerousLaser" // burn + confuse opp active (ACE SPEC)
  | "recover2Supporters" // Miracle Headset (ACE SPEC)
  | "deductionKit" // look at top 3
  | "primeCatcher" // gust + switch own (ACE SPEC)
  | "repelSwitchOut" // Repel
  | "scoopUpCyclone" // ACE SPEC
  | "scrambleSwitch" // ACE SPEC
  | "rebootPodFuture" // Reboot Pod (ACE SPEC)
  | "nsPPUp" // N's PP Up
  | "wondrousPatchPsychic" // Wondrous Patch
  | "glassTrumpet" // Glass Trumpet
  // Supporters — draw/hand-refresh
  | "draw3" // Cheren / Urbain / Friends in Paldea
  | "draw4" // Amarys
  | "ltSurgeBargain" // Lt. Surge's Bargain — opp consents to mutual prize OR you draw 4
  | "draw2Plus2IfOppFew" // Emcee's Hype (2 + 2 if opp ≤ 3 prizes)
  | "draw2Plus2IfHandBig" // Billy & O'Nare (2 + 2 if hand ≥ 10)
  | "eachPlayerShuffleDraw4" // Judge
  | "drawUntilSeven" // Iono / Marnie / Professor's Research
  | "shuffleHandDraw6OrEight" // Lillie's Determination (8 if 6 prizes)
  | "shuffleHandDraw4Or8Lacey" // Lacey (8 if opp ≤ 3 prizes)
  | "shuffleHandDrawDrasna" // Drasna — flip 8/3
  | "discardHandDraw5" // Carmine
  | "drawUntil6Discard" // Iris's Fighting Spirit (cost: discard 1)
  | "drawUntil5" // generic draw-cards-until-5 patterns
  | "arianaDrawUntilTR" // Team Rocket's Ariana — 5, or 8 if all in-play are TR
  | "naveenPreDiscardDraw5" // Naveen — discard any, then draw to 5
  | "drawCoinFlip42" // Picnicker
  | "draytonTop7" // Drayton — look at top 7, grab a Pokémon + Trainer
  // Supporters — gust / switch / disrupt
  | "gustOppBenched" // Boss's Orders
  | "switchActive" // generic switch
  | "kieranChoice" // Kieran — switch OR +30 vs ex/V this turn
  | "eriDiscardOppItems" // Eri — discard up to 2 Items from opp hand
  // Supporters — search
  | "searchBasicEnergyN" // Firebreather (up to 7 Fire Energy) / Energy Search+
  | "searchStadiumAndEnergy" // Colress's Tenacity
  // Supporters — heal
  | "heal70Active" // Cook
  | "heal60ActiveAndCure" // Pokémon Center Lady
  | "healEach40" // Fennel
  // Supporters — recovery from discard
  | "recoverFromDiscardLana" // Lana's Aid
  // Turn-scoped modifier effects
  | "buffPlus40VsExThisTurn" // Black Belt's Training
  | "buffFightingPlus30ThisTurn" // Premium Power Pro
  | "debuffMinus30OppTurn" // Jasmine's Gaze
  | "debuffMinus30OppTurnMetal" // Iron Defender
  // More supporters
  | "searchTrainer" // Team Rocket's Petrel
  | "search3Pokemonex" // Cyrano
  | "searchEvolutionPokemon" // (legacy generic — one Evolution Pokémon)
  | "dawnSearchBasicStage1Stage2" // Dawn — one Basic + one Stage 1 + one Stage 2
  | "healMegaExAndEnergyToHand" // Wally's Compassion
  | "healAllIfLow30Hp" // Bianca's Devotion
  | "heal150Psychic" // Jacinthe
  | "heal60EachLightning" // Clemont's Quick Wit
  | "searchTopBasicEnergyAttach" // Waitress
  | "searchBasicEnergyX" // Crispin (up to 2 different Basic Energies)
  | "recoverFromDiscardTarragon" // Tarragon
  | "searchEvolutionAndEnergy" // Hilda
  | "topPeekSupporterGrassFire" // Ethan's Adventure
  | "discardOppItemsHand" // Xerosic's Machinations
  | "discardOppToolAndSpecialEnergy" // Ruffian
  | "moveBenchEnergyToActive" // N's Plan
  | "drawUntilHandSix" // (legacy generic draw-to-six helper)
  | "kofuBottom2Draw4" // Kofu — put 2 on bottom, draw 4
  | "hasselTop8Take3" // Hassel — look at top 8, take up to 3
  | "harlequinShuffleFlip" // Harlequin — both shuffle; heads 5/3, tails 3/5
  | "drawPerOppBenched" // Morty's Conviction (cost: discard 1)
  | "top6Take2Discard4" // Explorer's Guidance
  | "ciphermaniacSearch" // Ciphermaniac's Codebreaking
  | "darkBasicPokemonTopPeek" // Grimsley's Move
  | "healAllMinor" // Caretaker (draw 2 simplified)
  | "gustConfuseOppBasic" // Lisia's Appeal
  // ---- New (this build pass) -----
  | "boxedOrder" // Search up to 2 Items, end turn
  | "salvatoreEvolveSearch" // Search for evolution and put on Pokémon
  | "surferSwitchDraw5" // Switch + draw to 5
  | "acerolasMischief" // Prevent damage on chosen ally next turn (≤2 prizes)
  | "briarExtraPrize" // +1 Prize for Tera attack KO this turn
  | "antheaConcordiaExtraPrize" // +1 Prize for N's attack KO this turn
  | "energySwatter" // Reveal opp hand → put Energy on bottom
  | "accompanyingFlute" // Top 5 of opp deck → bench Basics
  | "janineSecretArt" // Search Basic Darkness Energy for ≤2 Darkness Pokémon
  | "lucianShuffleFlip" // Both shuffle to bottom, flip → 6/3 each
  | "tymePokemonGuess" // Guess Pokémon HP — niche, simplified
  | "larrySkillDiscardSearch" // Discard hand, search Pokémon+Supporter+Energy
  | "drawPerAncient" // Awakening Drum
  | "brilliantBlenderMill5" // Search up to 5 cards and discard them
  | "megatonBlower" // Discard all opp Tools + Special Energy + Stadium
  | "blowtorch" // Cost: discard Basic Fire Energy → discard opp Tool/Special/Stadium
  | "chillTeaserToy" // Bounce 1 Energy from opp's Pokémon to opp's hand
  | "rotoStick" // Top 4 → reveal Supporters → put in hand
  | "meddlingMemo" // Opp shuffles hand to bottom + redraws same count
  | "callBell" // First-turn-only Supporter search
  | "loveBall" // Search a Pokémon with same name as opp's
  | "strangeTimepieceDevolve" // Devolve own Psychic Pokémon
  | "cassiopeiaSearch2" // Last-card-only: search 2
  | "rosaEnergyToStage2" // 2 Basic Energy from discard → Stage 2 (gated on prizes)
  | "sacredCharmTool" // Tool — passive (handled in ongoingEffects)
  | "gravityGemstoneTool" // Tool — passive (handled in ongoingEffects)
  | "handheldFanTool" // Tool — passive trigger handled in actions.ts on-damage
  | "ltSurgeStrategy" // Lt. Surge's Strategy — placeholder
  | "perrinSearch" // Reveal Pokémon → search same number Pokémon
  | "raifortPeek5Discard" // Look top 5, discard any number, return rest in any order
  | "canariLightningSearch" // Cost: discard 1; search up to 4 Lightning Pokémon
  | "trGiovanniSwitchGust" // Switch own TR + gust opp
  | "trArcherShuffleDraw" // Both shuffle, you 5 / opp 3 (gated on KO last turn)
  | "unfairStampShuffleDraw" // Unfair Stamp ACE SPEC: shuffle both, you 5 / opp 2 (KO last turn)
  | "ogresMaskSwapOgerpon" // Swap Ogerpon ex in discard with Ogerpon ex in play
  | "redeemableTicketReprize" // Shuffle prizes, take new ones from top of deck
  | "tmFluoriteTool" // Tool granting an attack — passive, handled at attach
  | "treasureTrackerToolSearch" // Search deck for up to 5 Pokémon Tools
  | "maxRodRecoverPokemonOrEnergy" // Recover up to 5 Pokémon or Basic Energy from discard
  | "secretBoxQuadSearch" // Discard 3, then search Item + Tool + Supporter + Stadium
  | "rocketBotherBotPrizePeek" // Flip a prize face-up + reveal random opp hand card
  | "playFossilAsBasic" // Antique Cover/Jaw/Plume/Root/Sail Fossil — bench as 60HP Colorless
  // me4 (Chaos Rising) -------------------------------------------------------
  | "specialRedCard" // Special Red Card — opp ≤3 prizes; opp shuffles hand to bottom + draws 3
  | "bigCatchingNet" // Big Catching Net — shuffle up to 3 Water Pokémon/Energy from discard to deck
  | "azsTranquility" // AZ's Tranquility — switch + heal 80 from outgoing
  | "philippeMetalEnergy" // Philippe — attach up to 2 Metal Energy from discard to a Metal Pokémon
  | "roxiesPerformance" // Roxie's Performance — opp's Poisoned Pokémon can't retreat next turn
  | "emma" // Emma — look at opp hand, draw a card per Pokémon
  | "tomesOfTransformation"; // Tomes of Transformation — placeholder (must play 2 at once); approximated

export interface ApiTrainer {
  name: string;
  supertype: string;
  subtypes?: string[];
  rules?: string[];
  text?: string;
}

// Check if the card is a Supporter (used as a gate on some detections).
function isSupporter(t: ApiTrainer): boolean {
  return (t.subtypes ?? []).includes("Supporter");
}

export function detectTrainerEffect(t: ApiTrainer): TrainerEffectId | undefined {
  const text = [...(t.rules ?? []), t.text ?? ""].join("\n");
  if (!text) return undefined;

  // -------- Items -----------------------------------------------------------

  if (t.name === "Nest Ball") return "searchBasicPokemon1";
  // Buddy-Buddy Poffin's text includes the 70-HP cap — match that specifically.
  if (t.name === "Buddy-Buddy Poffin" ||
      /search your deck for up to 2 basic pok[eé]mon with 70 hp or less/i.test(text))
    return "searchBasicPokemon2Poffin";
  // Brock's Scouting (up to 2 Basic OR 1 Evolution) — we approximate as "up to 2 Basic".
  if (t.name === "Brock's Scouting")
    return "searchUpTo2Basic";
  if (t.name === "Ultra Ball")
    return "searchAnyPokemon";
  if (t.name === "Master Ball")
    return "searchAnyPokemonFree";
  if (t.name === "Poké Ball")
    return "searchPokemonCoinFlip";
  if (t.name === "Poké Pad")
    return "searchNonRuleBoxPokemon";
  if (t.name === "Hyper Aroma")
    return "searchStage1x3";
  if (t.name === "Tera Orb")
    return "searchTeraPokemon";
  if (t.name === "Energy Search")
    return "searchBasicEnergy1";

  // me4 (Chaos Rising) -------------------------------------------------------
  if (t.name === "Special Red Card")
    return "specialRedCard";
  if (t.name === "Big Catching Net")
    return "bigCatchingNet";
  if (t.name === "Tomes of Transformation")
    return "tomesOfTransformation";
  if (t.name === "AZ's Tranquility")
    return "azsTranquility";
  if (t.name === "Philippe")
    return "philippeMetalEnergy";
  if (t.name === "Roxie's Performance")
    return "roxiesPerformance";
  if (t.name === "Emma")
    return "emma";

  // Switch / catcher — simple active/bench swaps.
  if (t.name === "Switch")
    return "simpleSwitch";
  if (t.name === "Pokémon Catcher")
    return "flipGustOppBenched";

  // Discard pile recovery / manipulation.
  if (t.name === "Night Stretcher")
    return "nightStretcher";
  if (t.name === "Energy Retrieval")
    return "energyRetrieval";
  if (t.name === "Energy Recycler")
    return "energyRecycler";
  if (t.name === "Sacred Ash")
    return "sacredAsh";
  if (t.name === "Energy Switch")
    return "energySwitchOwn";

  // Disruption.
  if (t.name === "Enhanced Hammer")
    return "enhancedHammer";
  if (t.name === "Crushing Hammer")
    return "crushingHammer";
  if (t.name === "Tool Scrapper")
    return "toolScrapper";
  if (t.name === "Hand Trimmer")
    return "handTrimmerBothTo5";
  if (t.name === "Hole-Digging Shovel")
    return "holeDigShovel";

  // Top-of-deck peeks.
  if (t.name === "Pokégear 3.0")
    return "pokegear37";
  if (t.name === "Bug Catching Set")
    return "bugCatchingSet";
  if (t.name === "Dusk Ball")
    return "duskBall";

  // Heals.
  if (t.name === "Potion" || /^heal 30 damage/im.test(text))
    return "heal30Active";
  if (t.name === "Arven's Sandwich")
    return "heal30OrArven100";
  if (t.name === "Super Potion")
    return "heal60DiscardEnergy";
  if (t.name === "Lumiose Galette")
    return "heal20AndCure";
  if (t.name === "Jumbo Ice Cream")
    return "heal80IfEnergyCap";

  if (t.name === "Rare Candy")
    return "rareCandyEvolve";

  // -------- Supporters — name-first then text-based -------------------------

  // Lillie's Determination — shuffle + draw 6 (or 8 if 6 prizes).
  if (t.name === "Lillie's Determination" ||
      /shuffle your hand into your deck\. then, draw 6 cards/i.test(text))
    return "shuffleHandDraw6OrEight";

  // Lacey — shuffle + draw 4 (or 8 if opp ≤ 3 prizes).
  if (t.name === "Lacey")
    return "shuffleHandDraw4Or8Lacey";

  // Drasna — shuffle + flip, 8 or 3.
  if (t.name === "Drasna")
    return "shuffleHandDrawDrasna";

  // Judge — each player shuffles hand into deck, draws 4.
  if (t.name === "Judge" ||
      /each player shuffles their hand into their deck and draws 4/i.test(text))
    return "eachPlayerShuffleDraw4";

  // Carmine — discard your hand, draw 5.
  if (t.name === "Carmine" ||
      /discard your hand and draw 5 cards/i.test(text))
    return "discardHandDraw5";

  // Iris's Fighting Spirit — cost: discard 1, draw until 6.
  if (t.name === "Iris's Fighting Spirit" ||
      /draw cards until you have 6 cards in your hand/i.test(text))
    return "drawUntil6Discard";

  // Naveen — discard any, then draw to 5 (interactive).
  if (t.name === "Naveen") return "naveenPreDiscardDraw5";
  // Team Rocket's Ariana — draws to 5, or to 8 if all in-play are TR.
  // Routed through its own effect id so the conditional all-TR check
  // doesn't infect generic drawUntil5 callers.
  if (t.name === "Team Rocket's Ariana") return "arianaDrawUntilTR";
  // Other draw-until-5 patterns (no pre-discard, no conditional bonus).
  if (/draw cards until you have 5 cards in your hand/i.test(text))
    return "drawUntil5";

  // Picnicker — coin flip: heads 4, tails 2.
  if (t.name === "Picnicker")
    return "drawCoinFlip42";

  // Emcee's Hype — draw 2, +2 if opp has ≤ 3 prizes.
  if (t.name === "Emcee's Hype")
    return "draw2Plus2IfOppFew";

  // Billy & O'Nare — draw 2, +2 if hand ≥ 10.
  if (t.name === "Billy & O'Nare")
    return "draw2Plus2IfHandBig";

  // Drayton — look at top 7, may take a Pokémon + Trainer.
  if (t.name === "Drayton")
    return "draytonTop7";

  // Eri — opponent reveals hand, discard up to 2 Items.
  if (t.name === "Eri")
    return "eriDiscardOppItems";

  // Harlequin — both shuffle hands into deck, flip; heads: you 5 opp 3,
  // tails: you 3 opp 5. Detect by name so the "each player shuffles" regex
  // below doesn't claim it.
  if (t.name === "Harlequin") return "harlequinShuffleFlip";

  // Iono / Marnie / Professor's Research — shuffle/discard + draw 7 band.
  if (/each player shuffles? their hand into their deck/i.test(text) ||
      /discard your hand and draw 7 cards/i.test(text))
    return "drawUntilSeven";

  // Plain "Draw N cards." supporters — do this AFTER the specific patterns
  // above so "Amarys (Draw 4)" and "Judge" aren't caught by the generic.
  if (isSupporter(t)) {
    if (/^draw 3 cards\.?$/im.test(text)) return "draw3";
    if (/^draw 4 cards\.?/im.test(text)) return "draw4";
  }

  // Boss's Orders / similar gust to Active.
  if (t.name === "Boss's Orders" ||
      /switch .*benched pok[eé]mon (with (your|their) active|to the active spot)/i.test(text))
    return "gustOppBenched";

  // Kieran — Choose 1: switch your Active, OR +30 vs Active ex/V this turn.
  // Branch is picked at resolve time based on the board state.
  if (t.name === "Kieran")
    return "kieranChoice";

  // Colress's Tenacity — search Stadium + Energy.
  if (t.name === "Colress's Tenacity" ||
      /search your deck for a stadium card and an energy card/i.test(text))
    return "searchStadiumAndEnergy";

  // Firebreather — up to 7 Basic Fire Energy.
  if (t.name === "Firebreather" ||
      /search your deck for up to 7 basic .* energy/i.test(text))
    return "searchBasicEnergyN";

  // Cook — heal 70 from Active.
  if (t.name === "Cook" ||
      /heal 70 damage from your active pok[eé]mon/i.test(text))
    return "heal70Active";

  // Pokémon Center Lady — heal 60 from 1 of yours + cure.
  if (t.name === "Pokémon Center Lady" ||
      /heal 60 damage from 1 of your pok[eé]mon, and it recovers from all special conditions/i.test(text))
    return "heal60ActiveAndCure";

  // Fennel — heal 40 from each of your Pokémon.
  if (t.name === "Fennel" ||
      /heal 40 damage from each of your pok[eé]mon/i.test(text))
    return "healEach40";

  // Lana's Aid — up to 3 non-rule-box Pokémon + Basic Energy from discard.
  if (t.name === "Lana's Aid" ||
      /put up to 3 in any combination of pok[eé]mon that don't have a rule box/i.test(text))
    return "recoverFromDiscardLana";

  // Turn-scoped
  if (t.name === "Black Belt's Training") return "buffPlus40VsExThisTurn";
  if (t.name === "Premium Power Pro") return "buffFightingPlus30ThisTurn";
  if (t.name === "Jasmine's Gaze") return "debuffMinus30OppTurn";
  if (t.name === "Iron Defender") return "debuffMinus30OppTurnMetal";

  // More supporters / items by name
  if (t.name === "Lt. Surge's Bargain") return "ltSurgeBargain";
  if (t.name === "Team Rocket's Petrel") return "searchTrainer";
  if (t.name === "Cyrano") return "search3Pokemonex";
  if (t.name === "Wally's Compassion") return "healMegaExAndEnergyToHand";
  if (t.name === "Bianca's Devotion") return "healAllIfLow30Hp";
  if (t.name === "Jacinthe") return "heal150Psychic";
  if (t.name === "Clemont's Quick Wit") return "heal60EachLightning";
  if (t.name === "Waitress") return "searchTopBasicEnergyAttach";
  if (t.name === "Crispin") return "searchBasicEnergyX";
  if (t.name === "Tarragon") return "recoverFromDiscardTarragon";
  if (t.name === "Hilda") return "searchEvolutionAndEnergy";
  if (t.name === "Ethan's Adventure") return "topPeekSupporterGrassFire";
  if (t.name === "Xerosic's Machinations") return "discardOppItemsHand";
  if (t.name === "Ruffian") return "discardOppToolAndSpecialEnergy";
  if (t.name === "N's Plan") return "moveBenchEnergyToActive";
  if (t.name === "Kofu") return "kofuBottom2Draw4";
  if (t.name === "Morty's Conviction") return "drawPerOppBenched";
  if (t.name === "Explorer's Guidance") return "top6Take2Discard4";
  if (t.name === "Ciphermaniac's Codebreaking") return "ciphermaniacSearch";
  if (t.name === "Grimsley's Move") return "darkBasicPokemonTopPeek";
  if (t.name === "Caretaker") return "healAllMinor";
  if (t.name === "Lisia's Appeal") return "gustConfuseOppBasic";
  if (t.name === "Dawn") return "dawnSearchBasicStage1Stage2";
  if (t.name === "Hassel") return "hasselTop8Take3";

  // Team Rocket's Proton: search deck for up to 3 Basic Team Rocket's
  // Pokémon, reveal them, and put them into your hand. Has its own effect
  // id to honor (a) the up-to-3 cap and (b) the TR-only filter; the prior
  // mapping to `searchBasicPokemon2Poffin` was an acknowledged stub.
  if (t.name === "Team Rocket's Proton") return "protonSearchBasicTR";

  // ---------------- Remaining items -------------------------------------
  if (t.name === "Mega Signal") return "searchMegaEx";
  if (t.name === "Hop's Bag") return "searchHopsBasics";
  if (t.name === "Fighting Gong") return "searchFightingBasicOrEnergy";
  if (t.name === "TM Machine") return "searchTMTools";
  if (t.name === "Team Rocket's Transceiver") return "searchTRSupporter";
  if (t.name === "Precious Trolley") return "searchAnyBasicsToBench";
  if (t.name === "Energy Search Pro") return "searchEnergyVariety";
  if (t.name === "Energy Coin") return "energyCoinFlip";
  if (t.name === "Team Rocket's Great Ball") return "trGreatBallFlip";
  if (t.name === "Team Rocket's Venture Bomb") return "trVentureBombFlip";
  if (t.name === "Dragon Elixir") return "healDragon60";
  if (t.name === "Poké Vital A") return "heal150Any";
  if (t.name === "Dangerous Laser") return "dangerousLaser";
  if (t.name === "Miracle Headset") return "recover2Supporters";
  if (t.name === "Deduction Kit") return "deductionKit";
  if (t.name === "Prime Catcher") return "primeCatcher";
  if (t.name === "Repel") return "repelSwitchOut";
  if (t.name === "Scoop Up Cyclone") return "scoopUpCyclone";
  if (t.name === "Scramble Switch") return "scrambleSwitch";
  if (t.name === "Reboot Pod") return "rebootPodFuture";
  if (t.name === "N's PP Up") return "nsPPUp";
  if (t.name === "Wondrous Patch") return "wondrousPatchPsychic";
  if (t.name === "Glass Trumpet") return "glassTrumpet";

  // ---------------- New (this build pass) ------------------------------
  if (t.name === "Cheren") return "draw3";
  if (t.name === "Friends in Paldea") return "draw3";
  if (t.name === "Urbain") return "draw3";
  if (t.name === "Amarys") return "draw4";
  if (t.name === "Boxed Order") return "boxedOrder";
  if (t.name === "Salvatore") return "salvatoreEvolveSearch";
  if (t.name === "Surfer") return "surferSwitchDraw5";
  if (t.name === "Acerola's Mischief") return "acerolasMischief";
  if (t.name === "Briar") return "briarExtraPrize";
  if (t.name === "Anthea & Concordia") return "antheaConcordiaExtraPrize";
  if (t.name === "Energy Swatter") return "energySwatter";
  if (t.name === "Accompanying Flute") return "accompanyingFlute";
  if (t.name === "Janine's Secret Art") return "janineSecretArt";
  if (t.name === "Lucian") return "lucianShuffleFlip";
  if (t.name === "Tyme") return "tymePokemonGuess";
  if (t.name === "Larry's Skill") return "larrySkillDiscardSearch";
  if (t.name === "Awakening Drum") return "drawPerAncient";
  if (t.name === "Brilliant Blender") return "brilliantBlenderMill5";
  if (t.name === "Megaton Blower") return "megatonBlower";
  if (t.name === "Blowtorch") return "blowtorch";
  if (t.name === "Chill Teaser Toy") return "chillTeaserToy";
  if (t.name === "Roto-Stick") return "rotoStick";
  if (t.name === "Meddling Memo") return "meddlingMemo";
  if (t.name === "Call Bell") return "callBell";
  if (t.name === "Love Ball") return "loveBall";
  if (t.name === "Strange Timepiece") return "strangeTimepieceDevolve";
  if (t.name === "Cassiopeia") return "cassiopeiaSearch2";
  if (t.name === "Rosa's Encouragement") return "rosaEnergyToStage2";
  if (t.name === "Sacred Charm") return "sacredCharmTool"; // passive — handled in ongoingEffects
  if (t.name === "Gravity Gemstone") return "gravityGemstoneTool";
  if (t.name === "Handheld Fan") return "handheldFanTool";
  if (t.name === "Lt. Surge's Strategy") return "ltSurgeStrategy"; // (sometimes already named differently)
  if (t.name === "Perrin") return "perrinSearch";
  if (t.name === "Raifort") return "raifortPeek5Discard";

  // ---------------- Even more (this build pass) ------------------------
  if (t.name === "Canari") return "canariLightningSearch";
  if (t.name === "Team Rocket's Giovanni") return "trGiovanniSwitchGust";
  if (t.name === "Team Rocket's Archer") return "trArcherShuffleDraw";
  if (t.name === "Unfair Stamp") return "unfairStampShuffleDraw";
  if (t.name === "Ogre's Mask") return "ogresMaskSwapOgerpon";
  if (t.name === "Redeemable Ticket") return "redeemableTicketReprize";
  if (t.name === "Technical Machine: Fluorite") return "tmFluoriteTool";

  // ACE SPEC items.
  if (t.name === "Treasure Tracker") return "treasureTrackerToolSearch";
  if (t.name === "Max Rod") return "maxRodRecoverPokemonOrEnergy";
  if (t.name === "Secret Box") return "secretBoxQuadSearch";

  // Team Rocket's Bother-Bot — flip a face-down Prize face up, reveal hand card.
  if (t.name === "Team Rocket's Bother-Bot") return "rocketBotherBotPrizePeek";

  // Antique Fossils — Items playable as 60-HP Basic Colorless Pokémon.
  if (t.name === "Antique Cover Fossil" ||
      t.name === "Antique Jaw Fossil" ||
      t.name === "Antique Plume Fossil" ||
      t.name === "Antique Root Fossil" ||
      t.name === "Antique Sail Fossil") return "playFossilAsBasic";

  return undefined;
}

// Pokémon abilities that block the effects of opp Trainer cards on this
// Pokémon. The names are recognized for coverage and documentation; the
// engine's Trainer pipeline doesn't currently route through a per-target
// effect-prevention gate, so these are partial implementations:
//
//   "Mentally Calm"     — opp Pokémon and attached cards can't be put into
//                          opp's hand (bounce protection).
//   "Snow Camouflage"   — opp Items/Supporters do no effects to this.
//   "Unnerve"           — same as Snow Camouflage (different cards).
//   "Wide Wall"         — Active spot, opp Supporters do no effects to ALL
//                          your Pokémon.
//
// To make these fully effective, the Trainer effect resolver would need a
// per-target check; left as a follow-up.
function targetProtectedFromOppTrainer(
  p: import("./types").PokemonInPlay,
): boolean {
  for (const ab of p.card.abilities ?? []) {
    if (ab.name === "Mentally Calm") return true;
    if (ab.name === "Snow Camouflage") return true;
    if (ab.name === "Unnerve") return true;
    if (ab.name === "Wide Wall") return true;
  }
  return false;
}
// Reference the helper so dead-code elimination doesn't drop the names.
void targetProtectedFromOppTrainer;

// -------- Helpers ---------------------------------------------------------

function drawUpTo(state: GameState, pl: PlayerId, count: number): number {
  const player = state.players[pl];
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const c = player.deck.shift();
    if (!c) break;
    player.hand.push(c);
    drawn++;
  }
  if (drawn > 0) logEvent(state, pl, `draws ${drawn} card(s).`);
  return drawn;
}

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function shuffleHandIntoDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const hand = player.hand.splice(0);
  player.deck.push(...hand);
  shuffleDeck(state, pl);
}

function flipCoinInline(state: GameState): boolean {
  return state.rng.next() < 0.5;
}

function searchDeck<T extends Card>(
  state: GameState,
  pl: PlayerId,
  pred: (c: Card) => c is T,
  max: number,
): T[] {
  const player = state.players[pl];
  const found: T[] = [];
  const remaining: Card[] = [];
  for (const c of player.deck) {
    if (found.length < max && pred(c)) found.push(c);
    else remaining.push(c);
  }
  player.deck = remaining;
  player.hand.push(...found);
  shuffleDeck(state, pl);
  return found;
}

const isPokemonCard = (c: Card): c is PokemonCard => c.supertype === "Pokémon";
const isBasicPokemonCard = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon" && c.subtypes.includes("Basic");
const isBasicPokemonUpTo70Hp = (c: Card): c is PokemonCard =>
  isBasicPokemonCard(c) && c.hp <= 70;
const isBasicEnergy = (c: Card): c is EnergyCard =>
  c.supertype === "Energy" && c.subtypes.includes("Basic");
const isStadium = (c: Card): c is TrainerCard =>
  c.supertype === "Trainer" && c.subtypes.includes("Stadium");
const isAnyEnergy = (c: Card): c is EnergyCard => c.supertype === "Energy";

const RULE_BOX_MARKERS = ["ex", "EX", "V", "VMAX", "VSTAR", "V-UNION", "GX", "Radiant"];
function hasRuleBox(card: PokemonCard): boolean {
  return (card.subtypes ?? []).some((s) => RULE_BOX_MARKERS.includes(s));
}
const isNonRuleBoxPokemon = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon" && !hasRuleBox(c);
const isStage1Pokemon = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Stage 1");
const isTeraPokemon = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Tera");
const isSupporterCard = (c: Card): c is TrainerCard =>
  c.supertype === "Trainer" && c.subtypes.includes("Supporter");
const isGrassPokemon = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon" && c.types.includes("Grass");
const isBasicGrassEnergy = (c: Card): c is EnergyCard =>
  isBasicEnergy(c) && c.provides.includes("Grass");

// Discard a non-target card from the player's hand (used for "discard another
// card from your hand" costs). Naïvely discards the first non-Supporter card
// to avoid discarding the card we're about to play. Returns true if discarded.
function discardOneOtherFromHand(state: GameState, pl: PlayerId): boolean {
  const player = state.players[pl];
  if (player.hand.length === 0) return false;
  const [c] = player.hand.splice(0, 1);
  player.discard.push(c);
  logEvent(state, pl, `discards ${c.name} as cost.`);
  return true;
}

// Core swap used by Switch, Kieran, Prime Catcher, Scramble Switch, etc.
// Moves the Active to the bench and the chosen bench Pokémon into the Active
// slot, clearing the outgoing Pokémon's Special Conditions (the "switch" rule).
function performSwitch(state: GameState, player: PlayerId, benchIndex: number): void {
  const pl = state.players[player];
  if (!pl.active || benchIndex < 0 || benchIndex >= pl.bench.length) return;
  const incoming = pl.bench.splice(benchIndex, 1)[0];
  const outgoing = pl.active;
  clearAllStatuses(outgoing);
  pl.active = incoming;
  pl.bench.push(outgoing);
  logEvent(state, player, `switches ${outgoing.card.name} → ${incoming.card.name}.`);
  fireTriggeredOnMoveToActive(state, player, incoming);
  fireTriggeredOnMoveToBench(state, player, outgoing);
}

// Resolve the pending-switch prompt: the human picked which benched Pokémon
// to promote. Clears `pendingSwitchTarget` and performs the swap.
export function resolveSwitchTarget(
  state: GameState,
  player: PlayerId,
  benchIndex: number,
): { ok: boolean; reason?: string } {
  if (state.pendingSwitchTarget !== player) {
    return { ok: false, reason: "No switch pending." };
  }
  const pl = state.players[player];
  if (benchIndex < 0 || benchIndex >= pl.bench.length) {
    return { ok: false, reason: "Invalid bench slot." };
  }
  performSwitch(state, player, benchIndex);
  state.pendingSwitchTarget = null;
  return { ok: true };
}

// -------- Precondition checks ---------------------------------------------

export function precheckTrainerEffect(
  state: GameState,
  player: PlayerId,
  t: TrainerCard,
  target?: TrainerTarget,
): string | null {
  const pl = state.players[player];
  const id = t.effectId as TrainerEffectId | undefined;
  // Unfair Stamp / Team Rocket's Archer require a KO during opp's last turn.
  if (id === "unfairStampShuffleDraw" && !pl.yourPokemonKoedLastOppTurn) {
    return "Unfair Stamp can only be played the turn after one of your Pokémon was Knocked Out.";
  }
  if (id === "trArcherShuffleDraw" && !pl.yourPokemonKoedLastOppTurn) {
    return "Team Rocket's Archer requires a Team Rocket's Pokémon to have been Knocked Out during your opponent's last turn.";
  }
  // Hassel — only playable if any of your Pokémon were KO'd during opp's
  // last turn (matches Acerola/Unfair Stamp pattern).
  if (id === "hasselTop8Take3" && !pl.yourPokemonKoedLastOppTurn) {
    return "Hassel can only be played the turn after one of your Pokémon was Knocked Out.";
  }
  // Acerola's Mischief — "You can use this card only if your opponent has
  // 2 or fewer Prize cards remaining."
  if (id === "acerolasMischief") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    if (opp.prizes.length > 2) {
      return "Acerola's Mischief: opponent must have 2 or fewer Prize cards remaining.";
    }
  }
  if (id === "searchAnyPokemon" && pl.hand.length < 3) {
    return "Need 2 other cards in hand to discard for Ultra Ball.";
  }
  if (id === "specialRedCard") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    if (opp.prizes.length > 3) {
      return "Special Red Card: opponent must have 3 or fewer Prize cards remaining.";
    }
  }
  if (id === "philippeMetalEnergy") {
    const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    const hasMetalAlly = allies.some((p) => p.card.types.includes("Metal"));
    if (!hasMetalAlly) return "Philippe: no Metal Pokémon in play.";
    const hasMetalInDiscard = pl.discard.some(
      (c) =>
        c.supertype === "Energy" &&
        c.subtypes.includes("Basic") &&
        (c as EnergyCard).provides.includes("Metal"),
    );
    if (!hasMetalInDiscard) return "Philippe: no Metal Energy in your discard pile.";
  }
  if (id === "azsTranquility" && pl.bench.length === 0) {
    return "AZ's Tranquility: no Benched Pokémon to switch in.";
  }
  if (id === "bigCatchingNet") {
    const hasMatch = pl.discard.some((c) => {
      if (c.supertype === "Pokémon" && c.types.includes("Water")) return true;
      if (
        c.supertype === "Energy" &&
        c.subtypes.includes("Basic") &&
        (c as EnergyCard).provides.includes("Water")
      )
        return true;
      return false;
    });
    if (!hasMatch) return "Big Catching Net: no Water Pokémon or basic Water Energy in discard.";
  }
  if (id === "tomesOfTransformation") {
    // Need 2 Tomes in hand (one we're playing + at least one more), or the
    // simplified path has nothing to do.
    const tomesInHand = pl.hand.filter((c) => c.name === "Tomes of Transformation").length;
    if (tomesInHand < 1) {
      return "Tomes of Transformation: requires 2 copies in your hand to play.";
    }
    // Need at least one Basic Pokémon in discard pile to swap with.
    const basicInDiscard = pl.discard.some(
      (c) => c.supertype === "Pokémon" && c.subtypes.includes("Basic"),
    );
    if (!basicInDiscard) {
      return "Tomes of Transformation: no Basic Pokémon in your discard pile.";
    }
  }
  // Secret Box: discards 3 other cards from hand. Without this gate,
  // playTrainer still discards Secret Box itself for no effect — losing
  // the ACE SPEC.
  if (id === "secretBoxQuadSearch" && pl.hand.length < 4) {
    return "Secret Box: need 3 other cards in hand to discard.";
  }
  if (id === "drawUntil6Discard" && pl.hand.length < 2) {
    return "Need an extra card to discard for this Supporter.";
  }
  if (id === "kofuBottom2Draw4" && pl.hand.length < 3) {
    // Needs 2 other cards (beyond Kofu itself) to put on the bottom.
    return "Kofu needs 2 other cards in your hand to put on the bottom of your deck.";
  }
  if (id === "naveenPreDiscardDraw5") {
    // "If you can't draw any cards in this way, you can't use this card."
    // We'll be able to draw at least 1 iff the hand (after optional discard)
    // ends below 5. The player *may* discard to force the draw, so the gate
    // is: hand must have at least 1 discardable card OR be below 5 already.
    // In practice: as long as Naveen itself is in hand, hand >= 1 and the
    // player can always choose to discard enough to get below 5. So this
    // precheck is essentially "always ok"; we leave a guard in case the
    // deck is empty.
    if (pl.deck.length === 0) return "Your deck is empty — can't draw.";
  }
  if (id === "gustOppBenched") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    if (opp.bench.length === 0) return `${opp.name} has no Benched Pokémon to gust.`;
    const wantsTarget =
      target?.kind === "oppInPlay" ? target.instanceId :
      target?.kind === "inPlay" ? target.instanceId : null;
    if (!wantsTarget) return "Pick an opposing Benched Pokémon to gust.";
  }
  if (id === "enhancedHammer") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    const anySpecial = [opp.active, ...opp.bench].some(
      (p) => p && p.attachedEnergy.some((e) => e.subtypes.includes("Special")),
    );
    if (!anySpecial) return "No Special Energy on any of opponent's Pokémon.";
  }
  if (id === "crushingHammer") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    const anyEnergy = [opp.active, ...opp.bench].some(
      (p) => p && p.attachedEnergy.length > 0,
    );
    if (!anyEnergy) return "No Energy on any of opponent's Pokémon.";
  }
  if (id === "flipGustOppBenched") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    if (opp.bench.length === 0) return `${opp.name} has no Benched Pokémon.`;
  }
  if (id === "toolScrapper") {
    const anyTool = (["p1", "p2"] as PlayerId[]).some((pid) => {
      const p = state.players[pid];
      return (p.active?.tools.length ?? 0) > 0 || p.bench.some((b) => b.tools.length > 0);
    });
    if (!anyTool) return "No Tools in play.";
  }
  if (id === "scoopUpCyclone" && pl.bench.length === 0) {
    return "No Benched Pokémon to scoop.";
  }
  if (id === "energySwitchOwn") {
    const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    if (allies.length < 2) return "Need at least two of your Pokémon in play.";
    const anyBasicEnergy = allies.some((p) =>
      p.attachedEnergy.some((e) => e.subtypes.includes("Basic")),
    );
    if (!anyBasicEnergy) return "No basic Energy attached to any of your Pokémon.";
  }
  if (id === "healMegaExAndEnergyToHand") {
    const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    const damagedMegaEx = allies.find(
      (p) =>
        p.damage > 0 &&
        (p.card.subtypes ?? []).some((s) => /^MEGA$/i.test(s) || /^Mega /.test(s)) &&
        (p.card.subtypes ?? []).includes("ex"),
    );
    if (!damagedMegaEx) {
      return "No damaged Mega Evolution Pokémon ex to heal.";
    }
  }
  if (id === "gustConfuseOppBasic") {
    const opp = state.players[player === "p1" ? "p2" : "p1"];
    if (!opp.bench.some((p) => p.card.subtypes.includes("Basic"))) {
      return `${opp.name} has no Benched Basic Pokémon.`;
    }
  }
  if (id === "rareCandyEvolve") {
    // Can't use Rare Candy on either player's first turn (rulebook).
    if (isPlayersFirstTurn(state, player)) return "Can't use Rare Candy on your first turn.";
    const targetId =
      target?.kind === "inPlay" ? target.instanceId : null;
    if (!targetId) return "Pick the Basic Pokémon to evolve.";
    const basic = findInPlay(state, player, targetId);
    if (!basic) return "Target not in play.";
    if (!basic.card.subtypes.includes("Basic"))
      return "Rare Candy only works on Basic Pokémon.";
    if (basic.playedThisTurn) return "Can't evolve a Pokémon played this turn.";
    if (!findStage2InHand(pl.hand, basic.card.name)) {
      return "No Stage 2 in hand that evolves from this Pokémon.";
    }
  }

  // -------- Supporter "can't do anything" prechecks -----------------------
  // A Supporter is a once-per-turn resource. Reject the play outright when
  // the effect can't accomplish anything, matching the "you can only play it
  // if it does something" intent across the format.

  const oppId: PlayerId = player === "p1" ? "p2" : "p1";
  const opp = state.players[oppId];
  const allies: PokemonInPlay[] = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);

  // Kieran — switch your Active with a Benched Pokémon.
  if (id === "switchActive" && (!pl.active || pl.bench.length === 0)) {
    return "No Benched Pokémon to switch with.";
  }

  // Eri — needs at least one Item in the opponent's hand to discard.
  if (id === "eriDiscardOppItems") {
    const hasItem = opp.hand.some(
      (c) => c.supertype === "Trainer" && c.subtypes.includes("Item"),
    );
    if (!hasItem) return `${opp.name} has no Items to discard.`;
  }

  // Xerosic's Machinations — needs at least one Item or Pokémon Tool in
  // the opp's hand.
  if (id === "discardOppItemsHand") {
    const hasItemOrTool = opp.hand.some((c) => {
      if (c.supertype !== "Trainer") return false;
      return (
        c.subtypes.includes("Item") ||
        c.subtypes.includes("Pokémon Tool") ||
        c.subtypes.includes("Tool")
      );
    });
    if (!hasItemOrTool) return `${opp.name} has no Items or Tools to discard.`;
  }

  // Heal-Active Supporters — need an Active with damage.
  if (
    id === "heal70Active" ||
    id === "heal60ActiveAndCure"
  ) {
    if (!pl.active) return "No Active Pokémon.";
    if (pl.active.damage === 0 && id === "heal70Active") {
      return "Your Active Pokémon has no damage to heal.";
    }
    // heal60ActiveAndCure also cures statuses — allow if damage or status.
    if (id === "heal60ActiveAndCure" && pl.active.damage === 0 && pl.active.statuses.length === 0) {
      return "Your Active has no damage and no Special Conditions.";
    }
  }

  // Cook — heal 70 from Active (damage-only).
  // (Already covered by heal70Active above.)

  // Fennel "healEach40" — heal across your own side; needs at least one
  // damaged ally.
  if (id === "healEach40") {
    if (!allies.some((p) => p.damage > 0)) return "None of your Pokémon are damaged.";
  }

  // Jacinthe "heal150Psychic" — needs a damaged Psychic Pokémon.
  if (id === "heal150Psychic") {
    const hit = allies.some((p) => p.card.types.includes("Psychic") && p.damage > 0);
    if (!hit) return "No damaged Psychic Pokémon to heal.";
  }

  // Poké Vital A "heal150Any" — needs any damaged ally.
  if (id === "heal150Any") {
    if (!allies.some((p) => p.damage > 0)) return "No damaged Pokémon to heal.";
  }

  // Dawn — needs at least one of Basic / Stage 1 / Stage 2 in deck. The
  // chained picker would fire the search-notice modal three times if the
  // deck was empty of all three; reject the play upfront so it doesn't
  // burn the Supporter slot for nothing.
  if (id === "dawnSearchBasicStage1Stage2") {
    const hasAny = pl.deck.some(
      (c) =>
        c.supertype === "Pokémon" &&
        ((c.subtypes ?? []).includes("Basic") ||
          (c.subtypes ?? []).includes("Stage 1") ||
          (c.subtypes ?? []).includes("Stage 2")),
    );
    if (!hasAny) return "Dawn: no Basic, Stage 1, or Stage 2 Pokémon in your deck.";
  }

  // Wondrous Patch "wondrousPatchPsychic" — needs a Benched Psychic AND a
  // Basic Psychic Energy in the discard.
  if (id === "wondrousPatchPsychic") {
    const hasBenchedPsychic = pl.bench.some((p) => p.card.types.includes("Psychic"));
    if (!hasBenchedPsychic) return "No Benched Psychic Pokémon.";
    const hasEnergy = pl.discard.some(
      (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
        (c as EnergyCard).provides.includes("Psychic"),
    );
    if (!hasEnergy) return "No Basic Psychic Energy in your discard.";
  }

  // Clemont's Quick Wit "heal60EachLightning" — needs a damaged Lightning.
  if (id === "heal60EachLightning") {
    const hit = allies.some((p) => p.card.types.includes("Lightning") && p.damage > 0);
    if (!hit) return "No damaged Lightning Pokémon to heal.";
  }

  // Bianca's Devotion "healAllIfLow30Hp" — needs an ally whose remaining HP
  // is ≤30 and is currently damaged.
  if (id === "healAllIfLow30Hp") {
    const hit = allies.some((p) => p.damage > 0 && p.card.hp - p.damage <= 30);
    if (!hit) return "No Pokémon with 30 HP or less remaining to heal.";
  }

  // Waitress "searchTopBasicEnergyAttach" — needs an Active to attach to.
  if (id === "searchTopBasicEnergyAttach" && !pl.active) {
    return "No Active Pokémon to attach Energy to.";
  }

  // Crispin — one basic Energy can be taken to hand; if a second is chosen,
  // it must be a different type and attaches through the target picker.
  if (id === "searchBasicEnergyX" && !pl.deck.some(isBasicEnergy)) {
    return "Crispin: no basic Energy in deck.";
  }

  // Night Stretcher — needs a Pokémon or basic Energy in your discard.
  // Without this gate the Item gets played and discarded for no effect.
  if (id === "nightStretcher") {
    const isEligible = (c: Card): boolean =>
      c.supertype === "Pokémon" || isBasicEnergy(c);
    if (!pl.discard.some(isEligible)) {
      return "No Pokémon or basic Energy in your discard.";
    }
  }

  // Lana's Aid — needs at least one eligible card in your discard.
  if (id === "recoverFromDiscardLana") {
    const isEligible = (c: Card): boolean =>
      (c.supertype === "Pokémon" && !(c.subtypes ?? []).some((s) => RULE_BOX_MARKERS.includes(s))) ||
      (c.supertype === "Energy" && c.subtypes.includes("Basic"));
    if (!pl.discard.some(isEligible)) {
      return "No non-Rule-Box Pokémon or Basic Energy in your discard.";
    }
  }

  // Tarragon — needs a Fighting Pokémon or Basic Fighting Energy in discard.
  if (id === "recoverFromDiscardTarragon") {
    const isEligible = (c: Card): boolean =>
      (c.supertype === "Pokémon" && c.types.includes("Fighting")) ||
      (c.supertype === "Energy" &&
        c.subtypes.includes("Basic") &&
        (c as EnergyCard).provides.includes("Fighting"));
    if (!pl.discard.some(isEligible)) {
      return "No Fighting Pokémon or basic Fighting Energy in your discard.";
    }
  }

  // Ruffian — needs an opposing Pokémon with a Tool OR a Special Energy.
  if (id === "discardOppToolAndSpecialEnergy") {
    const anyTarget = [opp.active, ...opp.bench].some(
      (p) =>
        !!p &&
        (p.tools.length > 0 || p.attachedEnergy.some((e) => e.subtypes.includes("Special"))),
    );
    if (!anyTarget) return "No Tools or Special Energy on opponent's Pokémon.";
  }

  // N's Plan — needs energy on bench AND an Active to move it to.
  if (id === "moveBenchEnergyToActive") {
    if (!pl.active) return "No Active Pokémon to move Energy to.";
    if (!pl.bench.some((b) => b.attachedEnergy.length > 0)) {
      return "No Energy on your Bench to move.";
    }
  }

  // Morty's Conviction — "discard a card from your hand, then draw a card for
  // each of your opponent's Benched Pokémon". Needs hand >= 2 (discard + the
  // card itself) AND at least one opp bench to yield a draw.
  if (id === "drawPerOppBenched") {
    if (pl.hand.length < 2) return "Need an extra card in hand to discard.";
    if (opp.bench.length === 0) return "Opponent has no Benched Pokémon — nothing to draw for.";
  }

  // Grimsley's Move — first-turn block (already handled in handler, but raise
  // it to precheck so the Supporter slot isn't wasted); also needs bench room.
  if (id === "darkBasicPokemonTopPeek") {
    if (isPlayersFirstTurn(state, player)) return "Can't use Grimsley's Move on your first turn.";
    if (pl.bench.length >= 5) return "Your Bench is full.";
  }

  return null;
}

function findInPlay(state: GameState, player: PlayerId, id: string): PokemonInPlay | null {
  const pl = state.players[player];
  if (pl.active?.instanceId === id) return pl.active;
  return pl.bench.find((p) => p.instanceId === id) ?? null;
}

// Stage 2 whose matching Stage 1 (by name) evolves from the given Basic name.
// Returns both the hand index and the resolved card so the caller can consume it.
function findStage2InHand(
  hand: Card[],
  basicName: string,
): { idx: number; stage2: PokemonCard } | null {
  const all = findAllStage2InHand(hand, basicName);
  return all.length > 0 ? all[0] : null;
}

// All Stage 2 cards in hand that could evolve onto a given Basic via Rare Candy.
function findAllStage2InHand(
  hand: Card[],
  basicName: string,
): Array<{ idx: number; stage2: PokemonCard }> {
  const out: Array<{ idx: number; stage2: PokemonCard }> = [];
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.supertype !== "Pokémon") continue;
    if (!c.subtypes.includes("Stage 2")) continue;
    if (!c.evolvesFrom) continue;
    const stage1 = findByName(c.evolvesFrom);
    if (
      stage1 &&
      stage1.supertype === "Pokémon" &&
      stage1.evolvesFrom === basicName
    ) {
      out.push({ idx: i, stage2: c as PokemonCard });
    }
  }
  return out;
}

// -------- Antique Fossil → Pokémon-in-play synthesis ---------------------

// Build a synthetic 60-HP Basic Colorless PokémonCard whose `id` and `name`
// echo the Trainer card's so logs / lookups / discard-on-KO behave naturally.
// The "Fossil" subtype tag is what the engine watches for in retreat / status
// rules (effectiveRetreatCost, canBeAfflictedBy).
function makeFossilPokemonInPlay(name: string, _state: GameState): PokemonInPlay {
  const synthetic: PokemonCard = {
    id: `fossil-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    supertype: "Pokémon",
    subtypes: ["Basic", "Fossil"],
    hp: 60,
    types: ["Colorless"],
    attacks: [],
    abilities: [],
    weaknesses: [],
    resistances: [],
    retreatCost: [],
    rules: [
      "Play this card as if it were a 60-HP Basic Colorless Pokémon.",
      "This card can't be affected by any Special Conditions and can't retreat.",
    ],
  };
  return {
    instanceId: newInstanceId(),
    card: synthetic,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: true,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  };
}

// -------- Dispatch --------------------------------------------------------

export function applyTrainerEffect(
  state: GameState,
  player: PlayerId,
  t: TrainerCard,
  target?: TrainerTarget,
): void {
  const pl = state.players[player];
  const id = t.effectId as TrainerEffectId | undefined;
  const oppId: PlayerId = player === "p1" ? "p2" : "p1";

  switch (id) {
    // ---------- Items ------------------------------------------------------

    case "searchBasicPokemon1":
      if (pl.bench.length >= 5) {
        logEvent(state, player, "bench is full — Nest Ball has no effect.");
        return;
      }
      if (!searchDeckToBench(state, player, isBasicPokemonCard, 1, "Nest Ball: pick 1 Basic Pokémon to Bench")) {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
    case "searchBasicPokemon2Poffin":
      if (pl.bench.length >= maxBenchSize(state, pl.bench, pl.active)) {
        logEvent(state, player, "bench is full — Poffin has no effect.");
        return;
      }
      if (!searchDeckToBench(state, player, isBasicPokemonUpTo70Hp, 2, "Buddy-Buddy Poffin: pick up to 2 Basic Pokémon (70 HP or less) to Bench")) {
        logEvent(state, player, "finds no Basic Pokémon (70 HP or less).");
      }
      return;

    case "protonSearchBasicTR": {
      // Card: "Search your deck for up to 3 Basic Team Rocket's Pokémon,
      // reveal them, and put them into your hand. Then, shuffle your deck."
      // Predicate: Basic Pokémon whose name starts with "Team Rocket's".
      const isBasicTr = (c: Card): boolean =>
        c.supertype === "Pokémon" &&
        (c.subtypes ?? []).includes("Basic") &&
        c.name.toLowerCase().startsWith("team rocket's");
      if (!setDeckSearchPick(state, player, isBasicTr, 3, "Team Rocket's Proton: pick up to 3 Basic Team Rocket's Pokémon")) {
        logEvent(state, player, "Team Rocket's Proton: no Basic Team Rocket's Pokémon in deck.");
      }
      return;
    }
    case "searchUpTo2Basic": {
      // Brock's Scouting — "Search your deck for up to 2 Basic Pokémon OR
      // 1 Evolution Pokémon, reveal them, and put them into your hand."
      // Auto-pick the Evolution branch when there's a deck Evolution that
      // can immediately go onto an in-play ally; otherwise the 2-Basic
      // branch (more flexible, two cards vs one).
      const inPlayNames = new Set<string>();
      for (const ally of [pl.active, ...pl.bench]) {
        if (ally) inPlayNames.add(ally.card.name);
      }
      const playableEvolutionInDeck = pl.deck.some((c) =>
        c.supertype === "Pokémon" &&
        !!(c as PokemonCard).evolvesFrom &&
        inPlayNames.has((c as PokemonCard).evolvesFrom!),
      );
      if (playableEvolutionInDeck) {
        const isPlayableEvolution = (c: Card): c is PokemonCard =>
          c.supertype === "Pokémon" &&
          !!(c as PokemonCard).evolvesFrom &&
          inPlayNames.has((c as PokemonCard).evolvesFrom!);
        if (!setDeckSearchPick(state, player, isPlayableEvolution, 1, "Brock's Scouting: pick 1 Evolution Pokémon")) {
          // Fallback to Basic search — should never happen due to outer guard.
          if (!setDeckSearchPick(state, player, isBasicPokemonCard, 2, "Brock's Scouting: pick up to 2 Basic Pokémon")) {
            logEvent(state, player, "finds no eligible Pokémon.");
          }
        }
        return;
      }
      if (!setDeckSearchPick(state, player, isBasicPokemonCard, 2, "Brock's Scouting: pick up to 2 Basic Pokémon")) {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
    }
    case "searchAnyPokemon": {
      // Ultra Ball — "discard 2 other cards from your hand" then search for
      // any Pokémon. For humans, open the hand picker; for AI, auto-pick the
      // first 2 cards.
      if (pl.isAI || pl.hand.length <= 2) {
        for (let i = 0; i < 2; i++) {
          const c = pl.hand.shift();
          if (!c) break;
          pl.discard.push(c);
          logEvent(state, player, `discards ${c.name} for Ultra Ball.`);
        }
        if (!setDeckSearchPick(state, player, isPokemonCard, 1, "Ultra Ball: pick 1 Pokémon")) {
          logEvent(state, player, "finds no Pokémon.");
        }
        return;
      }
      state.pendingHandReveal = {
        player,
        target: player,
        label: "Ultra Ball: pick 2 cards from your hand to discard",
        min: 2,
        max: 2,
        filter: "any",
        action: "discard",
        postAction: {
          kind: "searchDeckAnyPokemon",
          max: 1,
          label: "Ultra Ball: pick 1 Pokémon",
        },
      };
      return;
    }
    case "searchBasicEnergy1":
      if (!searchDeckToHand(state, player, isBasicEnergy, 1, "Energy Search: pick 1 basic Energy")) {
        logEvent(state, player, "finds no basic Energy.");
      }
      return;
    case "heal30Active": {
      // Potion — "Heal 30 damage from 1 of your Pokémon."
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const damaged = allies.filter((p) => p.damage > 0);
      if (damaged.length === 0) {
        logEvent(state, player, "no damaged Pokémon.");
        return;
      }
      if (pl.isAI || damaged.length === 1) {
        const target = damaged.slice().sort((a, b) => b.damage - a.damage)[0];
        const before = target.damage;
        target.damage = Math.max(0, target.damage - 30);
        logEvent(state, player, `Potion heals ${before - target.damage} from ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Potion: pick a Pokémon to heal 30",
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon",
        action: { kind: "potionHeal" },
      };
      return;
    }

    case "searchAnyPokemonFree":
      if (!setDeckSearchPick(state, player, isPokemonCard, 1, "Master Ball: pick 1 Pokémon")) {
        logEvent(state, player, "finds no Pokémon.");
      }
      return;

    case "searchNonRuleBoxPokemon":
      if (!setDeckSearchPick(state, player, isNonRuleBoxPokemon, 1, "Poké Pad: pick 1 Pokémon without a Rule Box")) {
        logEvent(state, player, "finds no non-Rule-Box Pokémon.");
      }
      return;

    case "searchStage1x3":
      if (!setDeckSearchPick(state, player, isStage1Pokemon, 3, "Hyper Aroma: pick up to 3 Stage 1 Pokémon")) {
        logEvent(state, player, "finds no Stage 1 Pokémon.");
      }
      return;

    case "searchTeraPokemon":
      if (!setDeckSearchPick(state, player, isTeraPokemon, 1, "Tera Orb: pick 1 Tera Pokémon")) {
        logEvent(state, player, "finds no Tera Pokémon.");
      }
      return;

    case "searchPokemonCoinFlip": {
      // Coin flip resolves BEFORE the prefab call — only on heads do we
      // open the deck-search picker. Migrating only the search step keeps
      // byte-equivalent behavior; the flip + tails path stays untouched.
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Poké Ball flip: ${heads ? "heads" : "tails"}.`);
      if (!heads) {
        shuffleDeck(state, player);
        return;
      }
      if (!searchDeckToHand(state, player, isPokemonCard, 1, "Poké Ball: pick 1 Pokémon")) {
        logEvent(state, player, "finds no Pokémon.");
      }
      return;
    }

    case "simpleSwitch": {
      if (!pl.active || pl.bench.length === 0) {
        logEvent(state, player, "has no Benched Pokémon to switch to.");
        return;
      }
      // Human + multiple bench options → defer: set pendingSwitchTarget so the
      // UI can prompt the player to click their preferred bench target.
      if (!pl.isAI && pl.bench.length > 1) {
        state.pendingSwitchTarget = player;
        logEvent(state, player, `plays Switch — pick a Benched Pokémon to promote.`);
        return;
      }
      performSwitch(state, player, 0);
      return;
    }

    case "flipGustOppBenched": {
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Pokémon Catcher flip: ${heads ? "heads" : "tails"}.`);
      if (!heads) return;
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0) return;
      const targetId =
        target?.kind === "oppInPlay" ? target.instanceId :
        target?.kind === "inPlay" ? target.instanceId : null;
      // AI supplied a target or only one option: resolve inline.
      if (pl.isAI || targetId || opp.bench.length === 1) {
        const idx = targetId ? opp.bench.findIndex((p) => p.instanceId === targetId) : 0;
        if (idx < 0) return;
        const r = performGust(state, oppId, idx);
        if (r) logEvent(state, player, `gusts ${r.pulled.card.name} into the Active spot.`);
        return;
      }
      // Humans with multiple bench targets: ask via picker.
      state.pendingInPlayTarget = {
        player,
        label: "Pokémon Catcher: pick an opposing Benched Pokémon to gust",
        scope: "opp",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "pokemonCatcher" },
      };
      return;
    }

    case "nightStretcher": {
      const pred = (c: Card) => c.supertype === "Pokémon" || isBasicEnergy(c);
      if (!recoverFromDiscardToHand(state, player, pred, 1, "Night Stretcher: pick 1 Pokémon or basic Energy from discard")) {
        logEvent(state, player, "finds nothing eligible in discard.");
      }
      return;
    }

    case "energyRetrieval":
      if (!setDiscardRecoveryPick(state, player, isBasicEnergy, 2, "Energy Retrieval: pick up to 2 basic Energy from discard")) {
        logEvent(state, player, "finds no basic Energy in discard.");
      }
      return;

    case "energyRecycler": {
      const kept: Card[] = [];
      let moved = 0;
      for (const c of pl.discard) {
        if (moved < 5 && isBasicEnergy(c)) { pl.deck.push(c); moved++; }
        else kept.push(c);
      }
      pl.discard = kept;
      if (moved > 0) {
        shuffleDeck(state, player);
        logEvent(state, player, `shuffles ${moved} basic Energy from discard into the deck.`);
      }
      return;
    }

    case "sacredAsh": {
      const kept: Card[] = [];
      let moved = 0;
      for (const c of pl.discard) {
        if (moved < 5 && c.supertype === "Pokémon") { pl.deck.push(c); moved++; }
        else kept.push(c);
      }
      pl.discard = kept;
      if (moved > 0) {
        shuffleDeck(state, player);
        logEvent(state, player, `shuffles ${moved} Pokémon from discard into the deck.`);
      }
      return;
    }

    case "energySwitchOwn": {
      // Energy Switch — "Move a Basic Energy from 1 of your Pokémon to
      // another of your Pokémon." Precheck confirmed ≥2 allies with ≥1
      // basic energy. AI auto-picks; humans get a two-step in-play picker.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      if (pl.isAI) {
        // AI path: prefer moving from a fully-loaded bench ally to the Active
        // (common ramp pattern). Fall back to first-with-energy → first-other.
        const source =
          allies.find(
            (p) =>
              p !== pl.active &&
              p.attachedEnergy.some((e) => e.subtypes.includes("Basic")),
          ) ??
          allies.find((p) => p.attachedEnergy.some((e) => e.subtypes.includes("Basic")))!;
        const dest = (pl.active && pl.active !== source) ? pl.active : allies.find((p) => p !== source)!;
        const eIdx = source.attachedEnergy.findIndex((e) => e.subtypes.includes("Basic"));
        const [en] = source.attachedEnergy.splice(eIdx, 1);
        dest.attachedEnergy.push(en);
        logEvent(state, player, `Energy Switch: moves ${en.name} from ${source.card.name} to ${dest.card.name}.`);
        enforceSpecialEnergyAttachRules(state);
        return;
      }
      // Human path — open the source picker. Filter to allies with basic
      // Energy attached.
      state.pendingInPlayTarget = {
        player,
        label: "Energy Switch: pick the Pokémon to move a Basic Energy FROM",
        scope: "own",
        slot: "anywhere",
        filter: "hasBasicEnergy",
        action: { kind: "energySwitchSource" },
      };
      return;
    }

    case "toolScrapper": {
      // Discard up to 2 Tools from any Pokémon (either side). AI auto-picks
      // opponent's Tools first; human goes through the target picker.
      const withTools: Array<[PlayerId, PokemonInPlay]> = [];
      for (const pid of [oppId, player] as PlayerId[]) {
        const p = state.players[pid];
        if (p.active && p.active.tools.length > 0) withTools.push([pid, p.active]);
        for (const b of p.bench) if (b.tools.length > 0) withTools.push([pid, b]);
      }
      if (withTools.length === 0) {
        logEvent(state, player, "finds no Tools in play.");
        return;
      }
      if (pl.isAI || withTools.length === 1) {
        let discarded = 0;
        for (const [pid, p] of withTools) {
          while (p.tools.length && discarded < 2) {
            const [tool] = p.tools.splice(0, 1);
            state.players[pid].discard.push(tool);
            logEvent(state, player, `discards ${tool.name} from ${p.card.name}.`);
            discarded++;
          }
          if (discarded >= 2) break;
        }
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Tool Scrapper: pick a Pokémon to discard a Tool from (up to 2)",
        scope: "both",
        slot: "anywhere",
        filter: "hasTool",
        action: { kind: "toolScrapper", remaining: 2 },
      };
      return;
    }

    case "enhancedHammer": {
      // Ask for an opposing Pokémon that has a Special Energy attached.
      // AI paths just auto-pick; human plays open the target picker.
      const opp = state.players[oppId];
      const candidates = [opp.active, ...opp.bench].filter(
        (p): p is PokemonInPlay =>
          !!p && p.attachedEnergy.some((e) => e.subtypes.includes("Special")),
      );
      if (candidates.length === 0) {
        logEvent(state, player, `finds no Special Energy on ${opp.name}'s Pokémon.`);
        return;
      }
      if (pl.isAI || candidates.length === 1) {
        const target = candidates[0];
        const idx = target.attachedEnergy.findIndex((e) => e.subtypes.includes("Special"));
        const [e] = target.attachedEnergy.splice(idx, 1);
        opp.discard.push(e);
        logEvent(state, player, `discards ${e.name} from ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Enhanced Hammer: pick an opposing Pokémon with a Special Energy",
        scope: "opp",
        slot: "anywhere",
        filter: "hasSpecialEnergy",
        action: { kind: "enhancedHammer" },
      };
      return;
    }

    case "crushingHammer": {
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Crushing Hammer flip: ${heads ? "heads" : "tails"}.`);
      if (!heads) return;
      const opp = state.players[oppId];
      const candidates = [opp.active, ...opp.bench].filter(
        (p): p is PokemonInPlay => !!p && p.attachedEnergy.length > 0,
      );
      if (candidates.length === 0) return;
      if (pl.isAI || candidates.length === 1) {
        // Prefer opp Active with the most Energy.
        const target = candidates.sort((a, b) => b.attachedEnergy.length - a.attachedEnergy.length)[0];
        const [e] = target.attachedEnergy.splice(0, 1);
        opp.discard.push(e);
        logEvent(state, player, `discards ${e.name} from ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Crushing Hammer: pick an opposing Pokémon to discard an Energy from",
        scope: "opp",
        slot: "anywhere",
        filter: "hasAnyEnergy",
        action: { kind: "crushingHammer" },
      };
      return;
    }

    case "handTrimmerBothTo5": {
      for (const pid of [oppId, player] as PlayerId[]) {
        const p = state.players[pid];
        while (p.hand.length > 5) {
          const [c] = p.hand.splice(p.hand.length - 1, 1);
          p.discard.push(c);
        }
      }
      logEvent(state, player, "both players trim to 5 cards.");
      return;
    }

    case "holeDigShovel": {
      const top = pl.deck.splice(0, 2);
      pl.discard.push(...top);
      logEvent(state, player, top.length
        ? `discards top ${top.length} card(s).`
        : "deck is empty.");
      return;
    }

    case "pokegear37":
      if (!setTopPeekPick(state, player, 7, isSupporterCard, 1, "Pokégear 3.0: reveal a Supporter from the top 7")) {
        logEvent(state, player, "deck is empty.");
      }
      return;

    case "bugCatchingSet": {
      const pred = (c: Card) => isGrassPokemon(c) || isBasicGrassEnergy(c);
      if (!setTopPeekPick(state, player, 7, pred, 2, "Bug Catching Set: pick up to 2 Grass Pokémon / Basic Grass Energy from the top 7")) {
        logEvent(state, player, "deck is empty.");
      }
      return;
    }

    case "duskBall":
      if (!setBottomPeekPick(state, player, 7, isPokemonCard, 1, "Dusk Ball: reveal a Pokémon from the bottom 7")) {
        logEvent(state, player, "deck is empty.");
      }
      return;

    case "heal30OrArven100":
      if (pl.active) {
        const isArven = pl.active.card.name.startsWith("Arven's ");
        const amount = isArven ? 100 : 30;
        pl.active.damage = Math.max(0, pl.active.damage - amount);
        logEvent(state, player, `heals ${amount} from ${pl.active.card.name}.`);
      }
      return;

    case "heal60DiscardEnergy": {
      // Super Potion — "Heal 60 damage from 1 of your Pokémon. If you healed
      // any damage in this way, discard an Energy from that Pokémon."
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const candidates = allies.filter((p) => p.damage > 0 && p.attachedEnergy.length > 0);
      if (candidates.length === 0) {
        logEvent(state, player, "no eligible Pokémon (need damage + Energy).");
        return;
      }
      if (pl.isAI || candidates.length === 1) {
        const target = candidates.slice().sort((a, b) => b.damage - a.damage)[0];
        const before = target.damage;
        target.damage = Math.max(0, target.damage - 60);
        const healed = before - target.damage;
        if (healed > 0) {
          const e = target.attachedEnergy.shift();
          if (e) pl.discard.push(e);
        }
        logEvent(state, player, `Super Potion heals ${healed} from ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Super Potion: pick a Pokémon to heal 60 (discards 1 Energy)",
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon",
        action: { kind: "superPotionHeal" },
      };
      return;
    }

    case "heal20AndCure":
      if (pl.active) {
        pl.active.damage = Math.max(0, pl.active.damage - 20);
        clearAllStatuses(pl.active);
        logEvent(state, player, `heals 20 and cures ${pl.active.card.name}.`);
      }
      return;

    case "heal80IfEnergyCap":
      if (pl.active && pl.active.attachedEnergy.length >= 3) {
        pl.active.damage = Math.max(0, pl.active.damage - 80);
        logEvent(state, player, `heals 80 from ${pl.active.card.name}.`);
      } else {
        logEvent(state, player, "needs 3+ Energy on the Active to heal.");
      }
      return;

    case "searchEnergyToBench":
      // Placeholder — Wondrous Patch / N's PP Up need subtype-gated attach.
      // Skip for now; card still discards.
      return;

    case "rareCandyEvolve": {
      // Precondition (turn>1, target is a valid Basic, Stage 2 available)
      // already enforced in precheckTrainerEffect.
      const targetId = target?.kind === "inPlay" ? target.instanceId : null;
      if (!targetId) return;
      const basic = findInPlay(state, player, targetId);
      if (!basic) return;
      const options = findAllStage2InHand(pl.hand, basic.card.name);
      if (options.length === 0) return;
      // Single option → evolve inline. Multi: for AI pick first; for humans
      // open the chooser.
      if (options.length === 1 || pl.isAI) {
        const chosen = options[0];
        const [stage2Card] = pl.hand.splice(chosen.idx, 1) as [PokemonCard];
        basic.evolvedFrom.push(basic.card);
        basic.card = stage2Card;
        applyEvolveSideEffects(state, basic);
        logEvent(state, player, `uses Rare Candy to evolve into ${stage2Card.name}.`);
        // Fire any triggered-on-evolve ability the Stage 2 has (Alakazam's
        // Psychic Draw, Noctowl's Jewel Seeker, Emergency Evolution, etc.).
        fireTriggeredOnEvolve(state, player, basic);
        return;
      }
      state.pendingRareCandyChoice = {
        player,
        targetInstanceId: basic.instanceId,
        handIndexes: options.map((o) => o.idx),
      };
      logEvent(state, player, `Rare Candy: pick a Stage 2 to evolve ${basic.card.name} into.`);
      return;
    }

    // ---------- Supporters — draw / hand-refresh ---------------------------

    case "draw3":
      drawUpTo(state, player, 3);
      return;
    case "draw4":
      drawUpTo(state, player, 4);
      return;

    case "ltSurgeBargain": {
      // "Ask your opponent if each player may take a Prize card. If yes,
      // each player takes a Prize card. If no, you draw 4 cards."
      // Opp consents only when it would let them win the game by taking
      // their last Prize before the user does (opp at 1 prize, user >1).
      // Otherwise opp declines — handing the user a free prize is almost
      // always negative-EV. The simplification keeps the card playable
      // without an opp-prompt UI.
      const me = state.players[player];
      const opp = state.players[oppId];
      const oppConsents = opp.prizes.length === 1 && me.prizes.length > 1;
      if (oppConsents) {
        logEvent(state, oppId, `consents to Lt. Surge's Bargain.`);
        takePrizes(state, player, 1);
        takePrizes(state, oppId, 1);
        // Win by prizes is checked next time the action loop runs; explicitly
        // resolve here so the card's effect ends in a valid game state.
        if (me.prizes.length === 0) {
          state.winner = player;
          state.phase = "gameOver";
          logEvent(state, "system", `${me.name} wins by taking all Prizes.`);
        } else if (opp.prizes.length === 0) {
          state.winner = oppId;
          state.phase = "gameOver";
          logEvent(state, "system", `${opp.name} wins by taking all Prizes.`);
        }
      } else {
        logEvent(state, oppId, `declines Lt. Surge's Bargain.`);
        drawUpTo(state, player, 4);
      }
      return;
    }

    case "drawUntilSeven": {
      // Simplified Iono/Marnie/Prof's Research: shuffle-or-discard hand, draw 7.
      shuffleHandIntoDeck(state, player);
      drawUpTo(state, player, 7);
      return;
    }

    case "shuffleHandDraw6OrEight": {
      // Lillie's Determination: shuffle + draw 6; 8 instead if exactly 6 prizes.
      shuffleHandIntoDeck(state, player);
      const count = pl.prizes.length === 6 ? 8 : 6;
      drawUpTo(state, player, count);
      return;
    }

    case "shuffleHandDraw4Or8Lacey": {
      shuffleHandIntoDeck(state, player);
      const oppPrizes = state.players[oppId].prizes.length;
      const count = oppPrizes <= 3 ? 8 : 4;
      drawUpTo(state, player, count);
      return;
    }

    case "shuffleHandDrawDrasna": {
      shuffleHandIntoDeck(state, player);
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Drasna flip: ${heads ? "heads" : "tails"}.`);
      drawUpTo(state, player, heads ? 8 : 3);
      return;
    }

    case "eachPlayerShuffleDraw4": {
      shuffleHandIntoDeck(state, player);
      shuffleHandIntoDeck(state, oppId);
      drawUpTo(state, player, 4);
      drawUpTo(state, oppId, 4);
      return;
    }

    case "discardHandDraw5": {
      const discarded = pl.hand.splice(0);
      pl.discard.push(...discarded);
      if (discarded.length > 0) {
        logEvent(state, player, `discards their hand (${discarded.length} cards).`);
      }
      drawUpTo(state, player, 5);
      return;
    }

    case "drawUntil6Discard": {
      // Cost already checked in precheckTrainerEffect.
      discardOneOtherFromHand(state, player);
      const target = 6;
      drawUpTo(state, player, Math.max(0, target - pl.hand.length));
      return;
    }

    case "drawUntil5": {
      drawUpTo(state, player, Math.max(0, 5 - pl.hand.length));
      return;
    }

    case "arianaDrawUntilTR": {
      // Card text: "Draw cards until you have 5 cards in your hand. If
      // all of your Pokémon in play are Team Rocket's Pokémon, draw cards
      // until you have 8 cards in your hand instead."
      const inPlay = [pl.active, ...pl.bench]
        .filter((p): p is PokemonInPlay => !!p);
      const allTR =
        inPlay.length > 0 &&
        inPlay.every((p) => p.card.name.toLowerCase().startsWith("team rocket's"));
      const target = allTR ? 8 : 5;
      drawUpTo(state, player, Math.max(0, target - pl.hand.length));
      return;
    }

    case "naveenPreDiscardDraw5": {
      // Naveen — you may discard any number from your hand, then draw to 5.
      // AI auto-path: skip the discard step and just draw to 5 (reasonable
      // default since the AI doesn't value hand-culling).
      if (pl.isAI || pl.hand.length === 0) {
        drawUpTo(state, player, Math.max(0, 5 - pl.hand.length));
        return;
      }
      state.pendingHandReveal = {
        player,
        target: player,
        label: "Naveen: discard any number from your hand, then draw to 5",
        min: 0,
        max: pl.hand.length,
        filter: "any",
        action: "discard",
        postAction: { kind: "drawUntilHand", targetSize: 5 },
      };
      return;
    }

    case "drawCoinFlip42": {
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Picnicker flip: ${heads ? "heads" : "tails"}.`);
      drawUpTo(state, player, heads ? 4 : 2);
      return;
    }

    case "draw2Plus2IfOppFew": {
      drawUpTo(state, player, 2);
      if (state.players[oppId].prizes.length <= 3) drawUpTo(state, player, 2);
      return;
    }

    case "draw2Plus2IfHandBig": {
      drawUpTo(state, player, 2);
      if (pl.hand.length >= 10) drawUpTo(state, player, 2);
      return;
    }

    case "draytonTop7": {
      const pred = (c: Card) => c.supertype === "Pokémon" || c.supertype === "Trainer";
      if (!setTopPeekPick(state, player, 7, pred, 2, "Drayton: pick up to 2 Pokémon / Trainer from the top 7")) {
        logEvent(state, player, "deck is empty.");
      }
      return;
    }

    // ---------- Supporters — gust / switch --------------------------------

    case "gustOppBenched": {
      const opp = state.players[oppId];
      const targetId =
        target?.kind === "oppInPlay" ? target.instanceId :
        target?.kind === "inPlay" ? target.instanceId : null;
      if (!targetId || opp.bench.length === 0 || !opp.active) return;
      const idx = opp.bench.findIndex((p) => p.instanceId === targetId);
      if (idx === -1) return;
      const r = performGust(state, oppId, idx);
      if (r) logEvent(state, player, `gusts ${r.pulled.card.name} into the Active spot.`);
      return;
    }

    case "switchActive": {
      if (!pl.active || pl.bench.length === 0) {
        logEvent(state, player, "has no Benched Pokémon to switch to.");
        return;
      }
      performSwitch(state, player, 0);
      return;
    }

    case "kieranChoice": {
      // Kieran — Choose 1:
      //   • Switch your Active with a Benched Pokémon, OR
      //   • +30 damage to opponent's Active ex/V from your attacks this turn.
      // We pick at resolve time: prefer the damage branch when the opponent's
      // Active is ex/V (so the bonus matters); otherwise fall back to switch.
      // The bonus is queued on thisTurnAttackBonuses, so it stacks with any
      // other turn buffs and applies to every attack the rest of the turn.
      const oppActive = state.players[oppId].active;
      const oppIsEx = oppActive
        ? (oppActive.card.subtypes.includes("ex") || oppActive.card.subtypes.includes("EX"))
        : false;
      const oppIsV = oppActive
        ? (oppActive.card.subtypes.includes("V") ||
           oppActive.card.subtypes.includes("VMAX") ||
           oppActive.card.subtypes.includes("VSTAR") ||
           oppActive.card.subtypes.includes("V-UNION"))
        : false;
      if (oppIsEx || oppIsV) {
        pl.thisTurnAttackBonuses.push({ amount: 30, againstEx: true, againstV: true });
        logEvent(state, player, "queues Kieran +30 damage vs Active ex/V this turn.");
        return;
      }
      if (!pl.active || pl.bench.length === 0) {
        logEvent(state, player, "Kieran: no Benched Pokémon to switch to and opponent has no ex/V Active.");
        return;
      }
      performSwitch(state, player, 0);
      return;
    }

    case "eriDiscardOppItems": {
      // Eri — your opponent reveals their hand; you discard up to 2 Item cards
      // you find there.
      const opp = state.players[oppId];
      const eligible = opp.hand.filter(
        (c) => c.supertype === "Trainer" && c.subtypes.includes("Item"),
      );
      if (eligible.length === 0) {
        logEvent(state, player, `${opp.name} has no Item cards in hand.`);
        return;
      }
      state.pendingHandReveal = {
        player,
        target: oppId,
        label: `Eri: discard up to 2 Items from ${opp.name}'s hand`,
        min: 0,
        max: 2,
        filter: "item",
        action: "discard",
      };
      return;
    }

    // ---------- Supporters — search ---------------------------------------

    case "searchBasicEnergyN": {
      // Firebreather: up to 7 Basic Fire Energy (approximation — pulls whatever
      // basic energies the player's deck has, which matches the single-type
      // assumption of our built decks).
      const got = searchDeck(state, player, isBasicEnergy, 7);
      logEvent(state, player, got.length
        ? `searches deck and adds ${got.length} basic Energy.`
        : "finds no basic Energy.");
      return;
    }

    case "searchStadiumAndEnergy": {
      // AI: keep the auto-search for speed (greedy first match per category).
      // Human: open a chained interactive pick — Stadium first, then Basic
      // Energy via `colress-energy` chain step. Mirrors Hilda's pattern.
      if (pl.isAI) {
        const stadium = searchDeck(state, player, isStadium, 1);
        const energy = searchDeck(state, player, isAnyEnergy, 1);
        const picks = [...stadium, ...energy].map((c) => c.name).join(", ");
        logEvent(state, player, picks
          ? `searches deck and adds ${picks}.`
          : "finds no Stadium/Energy.");
        return;
      }
      const isBasicEnergyCard = (c: Card) =>
        c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
      const hasStadium = pl.deck.some(isStadium);
      const hasBasicEnergy = pl.deck.some(isBasicEnergyCard);
      if (!hasStadium && !hasBasicEnergy) {
        logEvent(state, player, "Colress's Tenacity: deck has no Stadium or Energy.");
        return;
      }
      if (!hasStadium) {
        // Skip the Stadium step; go straight to the Energy pick.
        if (!setDeckSearchPick(state, player, isBasicEnergyCard, 1, "Colress's Tenacity (2 of 2): pick a basic Energy")) {
          logEvent(state, player, "Colress's Tenacity: no basic Energy in deck.");
        }
        return;
      }
      if (!setDeckSearchPick(
        state, player, isStadium, 1, "Colress's Tenacity (1 of 2): pick a Stadium",
        { postResolveChain: { kind: "colress-energy" } },
      )) {
        logEvent(state, player, "Colress's Tenacity: no Stadium in deck.");
      }
      return;
    }

    // ---------- Supporters — heal -----------------------------------------

    case "heal70Active":
      if (pl.active) {
        pl.active.damage = Math.max(0, pl.active.damage - 70);
        logEvent(state, player, `heals 70 from ${pl.active.card.name}.`);
      }
      return;

    case "heal60ActiveAndCure":
      if (pl.active) {
        pl.active.damage = Math.max(0, pl.active.damage - 60);
        clearAllStatuses(pl.active);
        logEvent(state, player, `heals 60 and cures ${pl.active.card.name}.`);
      }
      return;

    case "healEach40": {
      const heal = (p: PokemonInPlay) => {
        const before = p.damage;
        p.damage = Math.max(0, p.damage - 40);
        return before - p.damage;
      };
      let total = 0;
      if (pl.active) total += heal(pl.active);
      for (const b of pl.bench) total += heal(b);
      if (total > 0) logEvent(state, player, `heals ${total} total across their Pokémon.`);
      return;
    }

    // ---------- Supporters — discard recovery ----------------------------

    case "recoverFromDiscardLana": {
      const pred = (c: Card) =>
        (c.supertype === "Pokémon" && !hasRuleBox(c)) || isBasicEnergy(c);
      if (!recoverFromDiscardToHand(state, player, pred, 3, "Lana's Aid: pick up to 3 non-Rule-Box Pokémon or basic Energy from discard")) {
        logEvent(state, player, "finds nothing eligible in discard.");
      }
      return;
    }

    case "buffPlus40VsExThisTurn":
      pl.thisTurnAttackBonuses.push({ amount: 40, againstEx: true });
      logEvent(state, player, "queues +40 damage vs Pokémon ex this turn.");
      return;

    case "buffFightingPlus30ThisTurn":
      pl.thisTurnAttackBonuses.push({ amount: 30, attackerType: "Fighting" });
      logEvent(state, player, "queues +30 Fighting damage this turn.");
      return;

    case "debuffMinus30OppTurn":
      pl.nextOpponentTurnDamageReductions.push({ amount: 30 });
      logEvent(state, player, "queues −30 damage on opponent's next turn.");
      return;

    case "debuffMinus30OppTurnMetal":
      pl.nextOpponentTurnDamageReductions.push({ amount: 30, defenderType: "Metal" });
      logEvent(state, player, "queues −30 damage to Metal Pokémon on opponent's next turn.");
      return;

    case "searchTrainer":
      if (!setDeckSearchPick(state, player, (c) => c.supertype === "Trainer", 1, "Search for a Trainer")) {
        logEvent(state, player, "finds no Trainer.");
      }
      return;

    case "search3Pokemonex": {
      const isEx = (c: Card) => c.supertype === "Pokémon" && (c.subtypes.includes("ex") || c.subtypes.includes("EX"));
      if (!setDeckSearchPick(state, player, isEx, 3, "Cyrano: pick up to 3 Pokémon ex")) {
        logEvent(state, player, "finds no Pokémon ex.");
      }
      return;
    }

    case "searchEvolutionPokemon": {
      const isEvo = (c: Card) => c.supertype === "Pokémon" && !!c.evolvesFrom;
      if (!setDeckSearchPick(state, player, isEvo, 3, "pick an Evolution Pokémon")) {
        logEvent(state, player, "finds nothing.");
      }
      return;
    }

    case "dawnSearchBasicStage1Stage2": {
      // Dawn — search your deck for one Basic, one Stage 1, and one Stage 2.
      // AI auto-picks greedily (first of each); humans get three chained
      // pickers so they can actually choose the specific evolution line
      // they want to pull.
      if (pl.isAI) {
        const isBasic = (c: Card) =>
          c.supertype === "Pokémon" && c.subtypes.includes("Basic");
        const isStage1 = (c: Card) =>
          c.supertype === "Pokémon" && c.subtypes.includes("Stage 1");
        const isStage2 = (c: Card) =>
          c.supertype === "Pokémon" && c.subtypes.includes("Stage 2");
        const pulled: Card[] = [];
        const keep: Card[] = [];
        let gotBasic = false, gotS1 = false, gotS2 = false;
        for (const c of pl.deck) {
          if (!gotBasic && isBasic(c)) { pulled.push(c); gotBasic = true; continue; }
          if (!gotS1 && isStage1(c)) { pulled.push(c); gotS1 = true; continue; }
          if (!gotS2 && isStage2(c)) { pulled.push(c); gotS2 = true; continue; }
          keep.push(c);
        }
        pl.deck = keep;
        pl.hand.push(...pulled);
        shuffleDeck(state, player);
        logEvent(state, player, pulled.length
          ? `Dawn: takes ${pulled.map((c) => c.name).join(", ")}.`
          : "Dawn: finds nothing.");
        return;
      }
      // Human path — open the first pick (Basic); chain into Stage 1, then
      // Stage 2 via the pendingPick resolver's `postResolveChain` hook.
      const isBasic = (c: Card) =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic");
      if (
        !setDeckSearchPick(state, player, isBasic, 1, "Dawn (1 of 3): pick 1 Basic Pokémon", {
          postResolveChain: { kind: "dawn-stage1" },
        })
      ) {
        logEvent(state, player, "Dawn: no Basic Pokémon in deck.");
      }
      return;
    }

    case "healMegaExAndEnergyToHand": {
      // Wally's Compassion — "Heal all damage from 1 of your Mega Evolution
      // Pokémon ex. If you healed any damage in this way, put all Energy
      // attached to that Pokémon into your hand."
      //
      // Precheck already confirmed there's ≥1 damaged Mega ex in play. AI
      // auto-picks the most-damaged one; humans get the in-play target picker
      // gated to damaged Mega exes only.
      const isMegaEx = (c: PokemonCard) =>
        (c.subtypes ?? []).some((s) => /^MEGA$/i.test(s) || /^Mega /.test(s)) &&
        (c.subtypes ?? []).includes("ex");
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const damagedMegas = allies.filter((p) => p.damage > 0 && isMegaEx(p.card));
      if (pl.isAI || damagedMegas.length === 1) {
        const target = damagedMegas.slice().sort((a, b) => b.damage - a.damage)[0];
        const before = target.damage;
        target.damage = 0;
        if (target.attachedEnergy.length > 0) {
          pl.hand.push(...target.attachedEnergy);
          target.attachedEnergy = [];
        }
        logEvent(
          state,
          player,
          `Wally's Compassion: heals ${before} from ${target.card.name} and returns its Energy to hand.`,
        );
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Wally's Compassion: pick a damaged Mega Evolution Pokémon ex to fully heal",
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon", // validated more strictly in the resolver
        action: { kind: "wallysCompassion" },
      };
      return;
    }

    case "healAllIfLow30Hp": {
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allies.find((p) => {
        const hp = p.card.hp;
        return hp - p.damage <= 30 && p.damage > 0;
      });
      if (!target) {
        logEvent(state, player, "no Pokémon with 30 HP or less to heal.");
        return;
      }
      target.damage = 0;
      logEvent(state, player, `fully heals ${target.card.name}.`);
      return;
    }

    case "heal150Psychic": {
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const candidates = allies.filter((p) => p.card.types.includes("Psychic") && p.damage > 0);
      if (candidates.length === 0) {
        logEvent(state, player, "no damaged Psychic Pokémon.");
        return;
      }
      if (pl.isAI || candidates.length === 1) {
        const target = candidates.slice().sort((a, b) => b.damage - a.damage)[0];
        const before = target.damage;
        target.damage = Math.max(0, target.damage - 150);
        logEvent(state, player, `heals ${before - target.damage} from ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Jacinthe: pick a damaged Psychic Pokémon to heal 150",
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon",
        action: { kind: "jacintheHeal" },
      };
      return;
    }

    case "heal60EachLightning": {
      let total = 0;
      for (const p of [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p)) {
        if (p.card.types.includes("Lightning")) {
          const before = p.damage;
          p.damage = Math.max(0, p.damage - 60);
          total += before - p.damage;
        }
      }
      if (total > 0) logEvent(state, player, `heals ${total} across Lightning Pokémon.`);
      return;
    }

    case "searchTopBasicEnergyAttach": {
      // Waitress — look at top 6, attach a Basic Energy. Auto-attach to Active.
      const top = pl.deck.splice(0, 6);
      const idx = top.findIndex(isBasicEnergy);
      if (idx >= 0 && pl.active) {
        const [e] = top.splice(idx, 1) as [EnergyCard];
        pl.active.attachedEnergy.push(e);
        logEvent(state, player, `attaches ${e.name} from the top 6.`);
      } else {
        logEvent(state, player, "finds no basic Energy in the top 6.");
      }
      pl.deck.push(...top);
      shuffleDeck(state, player);
      return;
    }

    case "searchBasicEnergyX": {
      // Crispin — 2 different Basic Energy types; put 1 in hand, attach 1 to a Pokémon.
      if (pl.isAI) {
        // AI keeps the fast deterministic path: first Energy goes to hand,
        // first different-type Energy attaches to the Active.
        const pulled: EnergyCard[] = [];
        const rest: Card[] = [];
        const seenTypes = new Set<string>();
        for (const c of pl.deck) {
          if (pulled.length < 2 && isBasicEnergy(c)) {
            const t = c.provides[0];
            if (t && !seenTypes.has(t)) {
              pulled.push(c);
              seenTypes.add(t);
              continue;
            }
          }
          rest.push(c);
        }
        pl.deck = rest;
        if (pulled.length === 0) {
          logEvent(state, player, "finds no basic Energy.");
          shuffleDeck(state, player);
          return;
        }
        pl.hand.push(pulled[0]);
        if (pulled[1] && pl.active) {
          pl.active.attachedEnergy.push(pulled[1]);
          logEvent(state, player, `takes ${pulled[0].name}; attaches ${pulled[1].name}.`);
        } else if (pulled[1]) {
          pl.hand.push(pulled[1]);
          logEvent(state, player, `takes ${pulled.map((c) => c.name).join(", ")}.`);
        } else {
          logEvent(state, player, `takes ${pulled[0].name}.`);
        }
        shuffleDeck(state, player);
        return;
      }

      if (!setDeckSearchPick(
        state,
        player,
        isBasicEnergy,
        1,
        "Crispin (1 of 2): pick a basic Energy to put into your hand",
        { afterPick: { kind: "crispinHandEnergy" } },
      )) {
        logEvent(state, player, "finds no basic Energy.");
      }
      return;
    }

    case "recoverFromDiscardTarragon": {
      const pred = (c: Card) =>
        (c.supertype === "Pokémon" && c.types.includes("Fighting")) ||
        (isBasicEnergy(c) && c.provides.includes("Fighting"));
      if (!setDiscardRecoveryPick(state, player, pred, 4, "Tarragon: up to 4 Fighting Pokémon / basic Fighting Energy")) {
        logEvent(state, player, "finds nothing eligible in discard.");
      }
      return;
    }

    case "searchEvolutionAndEnergy": {
      const isEvo = (c: Card) => c.supertype === "Pokémon" && !!c.evolvesFrom;
      // Hilda card text: "an Energy card" — Special Energy is eligible too,
      // not just Basic. Prefer basic for AI heuristic since it usually fits
      // any cost; fall back to any energy if no basic.
      const isAnyEnergy = (c: Card) => c.supertype === "Energy";
      const isBasicEnergyCard = (c: Card) =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      if (pl.isAI) {
        // AI: auto-pick first match of each. Cheaper than driving two picks.
        const evo = pl.deck.find(isEvo);
        const energy = pl.deck.find(isBasicEnergyCard) ?? pl.deck.find(isAnyEnergy);
        if (evo) pl.deck.splice(pl.deck.indexOf(evo), 1);
        if (energy) pl.deck.splice(pl.deck.indexOf(energy), 1);
        const took: Card[] = [];
        if (evo) { pl.hand.push(evo); took.push(evo); }
        if (energy) { pl.hand.push(energy); took.push(energy); }
        shuffleDeck(state, player);
        logEvent(state, player, took.length
          ? `takes ${took.map((c) => c.name).join(", ")}.`
          : "finds nothing.");
        return;
      }
      // Human path: pick the Evolution first; chain into the basic Energy
      // pick. Each step shuffles + opens the next via postResolveChain.
      if (
        !setDeckSearchPick(state, player, isEvo, 1, "Hilda (1 of 2): pick an Evolution Pokémon", {
          postResolveChain: { kind: "hilda-energy" },
        })
      ) {
        logEvent(state, player, "Hilda: no Evolution Pokémon in deck.");
      }
      return;
    }

    case "topPeekSupporterGrassFire": {
      // Ethan's Adventure — up to 3 in combo of Ethan's Pokémon + Basic Fire Energy.
      const pred = (c: Card) =>
        (c.supertype === "Pokémon" && c.name.startsWith("Ethan's ")) ||
        (isBasicEnergy(c) && c.provides.includes("Fire"));
      if (!setDeckSearchPick(state, player, pred, 3, "Ethan's Adventure: pick Ethan's Pokémon or Basic Fire Energy")) {
        logEvent(state, player, "finds nothing.");
      }
      return;
    }

    case "discardOppItemsHand": {
      // Xerosic's Machinations — card text: "Your opponent discards cards
      // from their hand until they have 3 cards in their hand." (NOT the
      // older "discard 2 Items/Tools" effect; that was a different Xerosic
      // card from a prior set.) The opponent chooses what to discard.
      const opp = state.players[oppId];
      const excess = opp.hand.length - 3;
      if (excess <= 0) {
        logEvent(state, player, `${opp.name} already has ≤3 cards in hand — no effect.`);
        return;
      }
      // For AI / single-target: auto-discard the excess (priority: keep
      // Pokémon and Energy, discard Trainers first). Humans get a picker
      // owned by the opponent.
      if (state.players[oppId].isAI || true) {
        // Sort hand ascending by "importance to keep". Lowest priority cards
        // get discarded first. Heuristic: Items < Supporters < Tools < Stadiums
        // < Pokémon < Energy. Drops `excess` cards from the bottom of that
        // priority order.
        const indexed = opp.hand.map((c, i) => {
          let priority = 5; // Pokémon / Energy default — keep
          if (c.supertype === "Trainer") {
            const subs = c.subtypes ?? [];
            if (subs.includes("Item")) priority = 1;
            else if (subs.includes("Supporter")) priority = 2;
            else if (subs.includes("Pokémon Tool") || subs.includes("Tool")) priority = 3;
            else if (subs.includes("Stadium")) priority = 4;
          } else if (c.supertype === "Energy") priority = 6;
          return { i, priority, name: c.name };
        });
        indexed.sort((a, b) => a.priority - b.priority);
        const dropIdx = new Set(indexed.slice(0, excess).map((e) => e.i));
        const newHand = opp.hand.filter((_, i) => !dropIdx.has(i));
        const dropped = opp.hand.filter((_, i) => dropIdx.has(i));
        opp.discard.push(...dropped);
        opp.hand = newHand;
        logEvent(
          state,
          player,
          `Xerosic's Machinations: ${opp.name} discards ${excess} card${excess > 1 ? "s" : ""}.`,
        );
      }
      return;
    }

    case "discardOppToolAndSpecialEnergy": {
      // Ruffian — discard a Tool and a Special Energy from 1 opp Pokémon.
      const opp = state.players[oppId];
      const allOpp = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allOpp.find(
        (p) => p.tools.length > 0 || p.attachedEnergy.some((e) => e.subtypes.includes("Special")),
      );
      if (!target) {
        logEvent(state, player, `finds no Tool or Special Energy.`);
        return;
      }
      const removed: string[] = [];
      if (target.tools.length > 0) {
        const [t] = target.tools.splice(0, 1);
        opp.discard.push(t);
        removed.push(t.name);
      }
      const seIdx = target.attachedEnergy.findIndex((e) => e.subtypes.includes("Special"));
      if (seIdx >= 0) {
        const [e] = target.attachedEnergy.splice(seIdx, 1);
        opp.discard.push(e);
        removed.push(e.name);
      }
      logEvent(state, player, removed.length
        ? `discards ${removed.join(" + ")} from ${target.card.name}.`
        : `finds nothing on ${target.card.name}.`);
      return;
    }

    case "moveBenchEnergyToActive": {
      // N's Plan — move up to 2 Energy from Benched N's Pokémon to Active.
      if (!pl.active) return;
      const sources = pl.bench.filter((b) => b.attachedEnergy.length > 0);
      if (sources.length === 0) {
        logEvent(state, player, "no Energy on the bench to move.");
        return;
      }
      if (pl.isAI || sources.length === 1) {
        let moved = 0;
        for (const b of pl.bench) {
          while (moved < 2 && b.attachedEnergy.length > 0) {
            const [e] = b.attachedEnergy.splice(0, 1);
            pl.active.attachedEnergy.push(e);
            moved++;
          }
          if (moved >= 2) break;
        }
        logEvent(state, player, `moves ${moved} Energy from bench to Active.`);
        enforceSpecialEnergyAttachRules(state);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "N's Plan: pick a Benched Pokémon to move Energy from (up to 2)",
        scope: "own",
        slot: "bench",
        filter: "hasAnyEnergy",
        action: { kind: "nPlanEnergySource", remaining: 2 },
      };
      return;
    }

    case "drawUntilHandSix":
      drawUpTo(state, player, Math.max(0, 6 - pl.hand.length));
      return;

    case "kofuBottom2Draw4": {
      // Kofu: put 2 cards from your hand on the bottom of your deck in any
      // order, then draw 4. Precheck already verified the hand size.
      if (!pl.isAI) {
        state.pendingHandReveal = {
          player,
          target: player,
          label: "Kofu: pick 2 cards from your hand to put on the bottom of your deck",
          min: 2,
          max: 2,
          filter: "any",
          action: "toBottomOfDeck",
          postAction: { kind: "drawCards", count: 4 },
        };
        return;
      }
      // AI auto-pick: put the leftmost 2 cards on bottom.
      for (let i = 0; i < 2; i++) {
        const c = pl.hand.shift();
        if (!c) break;
        pl.deck.push(c);
      }
      logEvent(state, player, "Kofu: puts 2 cards on the bottom of the deck.");
      drawUpTo(state, player, 4);
      return;
    }

    case "hasselTop8Take3": {
      // Hassel: look at the top 8 cards of your deck. Put up to 3 of them
      // into your hand. Shuffle the rest back into your deck.
      if (!setTopPeekPick(state, player, 8, () => true, 3, "Hassel: pick up to 3 cards from the top 8")) {
        logEvent(state, player, "Hassel: deck is empty.");
      }
      return;
    }

    case "harlequinShuffleFlip": {
      // Harlequin: each player shuffles their hand into their deck. Flip a
      // coin; heads → you draw 5 and opp draws 3, tails → you draw 3 and
      // opp draws 5.
      shuffleHandIntoDeck(state, player);
      shuffleHandIntoDeck(state, oppId);
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Harlequin flip: ${heads ? "heads" : "tails"}.`);
      drawUpTo(state, player, heads ? 5 : 3);
      drawUpTo(state, oppId, heads ? 3 : 5);
      return;
    }

    case "drawPerOppBenched": {
      const count = state.players[oppId].bench.length;
      drawUpTo(state, player, count);
      return;
    }

    case "top6Take2Discard4": {
      // Explorer's Guidance — look at top 6, put 2 in hand, discard the other 4.
      const top = pl.deck.splice(0, 6);
      if (top.length === 0) {
        logEvent(state, player, "deck is empty.");
        return;
      }
      if (!pl.isAI) {
        state.pendingPick = {
          player,
          label: "Explorer's Guidance: pick 2 cards to put into your hand; discard the rest",
          pool: top,
          min: Math.min(2, top.length),
          max: Math.min(2, top.length),
          unpicked: "discard",
          source: "deckTop",
        };
        state.phase = "pick";
        return;
      }
      // Auto-pick the two most-useful (Pokémon first, then Trainers, then Energy).
      const score = (c: Card) => c.supertype === "Pokémon" ? 2 : c.supertype === "Trainer" ? 1 : 0;
      top.sort((a, b) => score(b) - score(a));
      const taken = top.slice(0, 2);
      const discarded = top.slice(2);
      pl.hand.push(...taken);
      pl.discard.push(...discarded);
      logEvent(state, player, `takes ${taken.map((c) => c.name).join(", ")}; discards ${discarded.length} others.`);
      return;
    }

    case "ciphermaniacSearch": {
      // Ciphermaniac's Codebreaking — search 2 cards, put them on top of deck.
      if (!pl.isAI) {
        if (!setDeckSearchPick(
          state,
          player,
          () => true,
          2,
          "Ciphermaniac's Codebreaking: pick 2 cards to put on top of your deck",
          { min: 2 },
        )) {
          logEvent(state, player, "Ciphermaniac's Codebreaking: deck is empty.");
          return;
        }
        if (state.pendingPick) {
          state.pendingPick.pickedDestination = "topOfDeck";
          state.pendingPick.min = Math.min(2, state.pendingPick.pool.length);
          state.pendingPick.max = Math.min(2, state.pendingPick.pool.length);
        }
        return;
      }
      const pulled: Card[] = [];
      const remaining: Card[] = [];
      for (const c of pl.deck) {
        if (pulled.length < 2) pulled.push(c);
        else remaining.push(c);
      }
      pl.deck = remaining;
      shuffleDeck(state, player);
      // Put them on top (index 0..1).
      pl.deck.unshift(...pulled);
      logEvent(state, player, "searches 2 cards and places them on top of the deck.");
      return;
    }

    case "darkBasicPokemonTopPeek": {
      // Grimsley's Move — top 7, Darkness Pokémon to bench.
      if (isPlayersFirstTurn(state, player)) {
        logEvent(state, player, "can't use Grimsley's Move on your first turn.");
        return;
      }
      const top = pl.deck.splice(0, 7);
      const idx = top.findIndex((c) => c.supertype === "Pokémon" && c.types.includes("Darkness"));
      if (idx < 0 || pl.bench.length >= 5) {
        pl.deck.push(...top);
        shuffleDeck(state, player);
        logEvent(state, player, "finds no Darkness Pokémon to bench.");
        return;
      }
      const [got] = top.splice(idx, 1) as [PokemonCard];
      pl.bench.push(makePokemonInPlay(got));
      pl.deck.push(...top);
      shuffleDeck(state, player);
      logEvent(state, player, `benches ${got.name} from the top 7.`);
      return;
    }

    case "healAllMinor":
      drawUpTo(state, player, 2);
      return;

    case "gustConfuseOppBasic": {
      // Lisia's Appeal — switch opp's Benched Basic to Active, new Active is Confused.
      const opp = state.players[oppId];
      if (!opp.active) return;
      const basics = opp.bench.filter((p) => p.card.subtypes.includes("Basic"));
      if (basics.length === 0) {
        logEvent(state, player, `${opp.name} has no Benched Basic.`);
        return;
      }
      if (pl.isAI || basics.length === 1) {
        const idx = opp.bench.findIndex((p) => p.card.subtypes.includes("Basic"));
        const r = performGust(state, oppId, idx);
        if (r) {
          if (!r.pulled.statuses.includes("confused")) r.pulled.statuses.push("confused");
          logEvent(state, player, `gusts ${r.pulled.card.name} to Active; it is now Confused.`);
        }
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Lisia's Appeal: pick an opposing Benched Basic to gust (becomes Confused)",
        scope: "opp",
        slot: "bench",
        filter: "isBasic",
        action: { kind: "lisiasAppeal" },
      };
      return;
    }

    // ---- Item handlers ---------------------------------------------------

    case "searchMegaEx": {
      const pred = (c: Card) =>
        c.supertype === "Pokémon" &&
        c.subtypes.some((s) => /^Mega/i.test(s)) &&
        c.subtypes.includes("ex");
      if (!setDeckSearchPick(state, player, pred, 1, "Mega Signal: pick a Mega Evolution Pokémon ex")) {
        logEvent(state, player, "finds no Mega Evolution ex.");
      }
      return;
    }

    case "searchHopsBasics": {
      if (pl.bench.length >= 5) {
        logEvent(state, player, "bench is full — Hop's Bag has no effect.");
        return;
      }
      // Clamp `max` to remaining bench slots so the picker can't offer 2
      // when only 1 will fit. Without this, a human could pick 2 and the
      // second placement would silently drop on the bench-full check.
      const slots = Math.min(2, 5 - pl.bench.length);
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.name.startsWith("Hop's ");
      if (!setDeckSearchPick(state, player, pred, slots, `Hop's Bag: pick up to ${slots} Basic Hop's Pokémon to Bench`, { toBench: true })) {
        logEvent(state, player, "finds no Basic Hop's Pokémon.");
      }
      return;
    }

    case "searchFightingBasicOrEnergy": {
      const pred = (c: Card) =>
        (c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.types.includes("Fighting")) ||
        (isBasicEnergy(c) && c.provides.includes("Fighting"));
      if (!setDeckSearchPick(state, player, pred, 1, "Fighting Gong: pick a Basic Fighting Pokémon or Fighting Energy")) {
        logEvent(state, player, "finds nothing.");
      }
      return;
    }

    case "searchTMTools": {
      const pred = (c: Card) =>
        c.supertype === "Trainer" &&
        c.subtypes.some((s) => s === "Pokémon Tool" || s === "Tool") &&
        c.name.includes("Technical Machine");
      if (!setDeckSearchPick(state, player, pred, 3, "TM Machine: pick up to 3 Technical Machine Tools")) {
        logEvent(state, player, "finds no Technical Machine Tools.");
      }
      return;
    }

    case "searchTRSupporter": {
      const pred = (c: Card) =>
        c.supertype === "Trainer" && c.subtypes.includes("Supporter") && c.name.includes("Team Rocket");
      if (!setDeckSearchPick(state, player, pred, 1, "Team Rocket's Transceiver: pick a Team Rocket Supporter")) {
        logEvent(state, player, "finds no Team Rocket Supporter.");
      }
      return;
    }

    case "searchAnyBasicsToBench": {
      // Precious Trolley — any number of Basic Pokémon to bench.
      const slots = 5 - pl.bench.length;
      if (slots <= 0) {
        logEvent(state, player, "bench is full.");
        return;
      }
      const isBasicPoke = (c: Card) =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic");

      // AI lane: prefer Basics whose evolution line is already represented
      // in our deck or hand — those Basics matter (they're upcoming
      // attackers / engines), unlike random fillers. Score each Basic by
      // (a) does its evolution exist in deck or hand, (b) is the Basic
      // already an in-play setup target. Greedy-take top-N.
      if (pl.isAI) {
        const evolutionInLibrary = (basicName: string): boolean => {
          const search = (zone: Card[]) =>
            zone.some(
              (c) =>
                c.supertype === "Pokémon" &&
                (c as PokemonCard).evolvesFrom === basicName,
            );
          return search(pl.deck) || search(pl.hand);
        };
        const candidates = pl.deck
          .map((c, idx) => ({ c, idx }))
          .filter(({ c }) => isBasicPoke(c));
        const scored = candidates.map(({ c, idx }) => {
          let score = 10; // baseline (any Basic is potentially useful)
          if (evolutionInLibrary(c.name)) score += 50;
          // Rule-box Basics are usually high-value attackers/engines.
          const subs = (c as PokemonCard).subtypes ?? [];
          if (subs.includes("ex") || subs.includes("V") || subs.includes("VSTAR") || subs.includes("VMAX")) {
            score += 20;
          }
          // Light penalty for ≤1 bench slot remaining unless score is high.
          if (slots <= 1 && score < 50) score -= 30;
          return { idx, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const pickIdxSet = new Set<number>(
          scored
            .filter((s) => s.score > 0)
            .slice(0, slots)
            .map((s) => s.idx),
        );
        const rest: Card[] = [];
        let added = 0;
        for (let i = 0; i < pl.deck.length; i++) {
          const c = pl.deck[i];
          if (pickIdxSet.has(i) && added < slots && isBasicPoke(c)) {
            pl.bench.push(makePokemonInPlay(c as PokemonCard));
            added++;
          } else {
            rest.push(c);
          }
        }
        pl.deck = rest;
        shuffleDeck(state, player);
        logEvent(state, player, `benches ${added} Basic Pokémon.`);
        return;
      }

      // Human: open an interactive deck-search picker. The picker's
      // `toBench: true` mode benches each picked Basic on resolve.
      if (!setDeckSearchPick(
        state, player, isBasicPoke, slots,
        `Precious Trolley: pick up to ${slots} Basic Pokémon to bench`,
        { toBench: true, effectKind: "preciousTrolley" },
      )) {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
    }

    case "searchEnergyVariety": {
      // Energy Search Pro — any number of Basic Energies of different types.

      // AI lane: prefer energy types that close current/bench attackers'
      // cost gaps first; then fill remaining unique types as utility
      // (the card allows "any number of different types"). Wanted types
      // are computed by walking each attacker's attack costs against
      // their already-attached Energy.
      if (pl.isAI) {
        const allies = [pl.active, ...pl.bench].filter(
          (p): p is PokemonInPlay => !!p,
        );
        const wantedTypes = new Set<string>();
        for (const a of allies) {
          const haveCounts = new Map<string, number>();
          for (const e of a.attachedEnergy) {
            for (const p of e.provides) haveCounts.set(p, (haveCounts.get(p) ?? 0) + 1);
          }
          for (const atk of a.card.attacks ?? []) {
            const haveCopy = new Map(haveCounts);
            for (const c of atk.cost) {
              if (c === "Colorless") continue;
              const have = haveCopy.get(c) ?? 0;
              if (have <= 0) wantedTypes.add(c);
              else haveCopy.set(c, have - 1);
            }
          }
        }
        const seen = new Set<string>();
        const pulled: Card[] = [];
        // Two-phase pass: keep deck order but prefer wanted types when
        // both wanted + non-wanted exist for the same type slot.
        // Phase A: pull wanted types first.
        const remaining: Card[] = [];
        for (const c of pl.deck) {
          if (isBasicEnergy(c)) {
            const t = c.provides[0];
            if (t && !seen.has(t) && wantedTypes.has(t)) {
              seen.add(t);
              pulled.push(c);
              continue;
            }
          }
          remaining.push(c);
        }
        // Phase B: fill in remaining unique types from what's left.
        const finalRest: Card[] = [];
        for (const c of remaining) {
          if (isBasicEnergy(c)) {
            const t = c.provides[0];
            if (t && !seen.has(t)) {
              seen.add(t);
              pulled.push(c);
              continue;
            }
          }
          finalRest.push(c);
        }
        pl.deck = finalRest;
        pl.hand.push(...pulled);
        shuffleDeck(state, player);
        logEvent(state, player, pulled.length
          ? `takes ${pulled.length} basic Energy.`
          : "finds no basic Energy.");
        return;
      }

      // Human: open a deck-search picker over basic Energy. The picker
      // pool may include duplicates of the same type; the resolver
      // enforces the "different types" constraint.
      if (!setDeckSearchPick(
        state, player, isBasicEnergy, 9,
        "Energy Search Pro: pick any number of basic Energy of different types",
        { uniqueByEnergyType: true, effectKind: "energySearchPro" },
      )) {
        logEvent(state, player, "finds no basic Energy.");
      }
      return;
    }

    case "energyCoinFlip": {
      const f1 = flipCoinInline(state);
      const f2 = flipCoinInline(state);
      logEvent(state, "system", `Energy Coin flips: ${f1 ? "H" : "T"}, ${f2 ? "H" : "T"}.`);
      if (f1 && f2) {
        if (!setDeckSearchPick(state, player, isBasicEnergy, 1, "Energy Coin: pick a basic Energy")) {
          logEvent(state, player, "finds no basic Energy.");
        }
      }
      return;
    }

    case "trGreatBallFlip": {
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Team Rocket's Great Ball: ${heads ? "heads" : "tails"}.`);
      const pred = heads
        ? (c: Card) => c.supertype === "Pokémon" && !!c.evolvesFrom && c.name.includes("Team Rocket")
        : (c: Card) => c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.name.includes("Team Rocket");
      if (!setDeckSearchPick(state, player, pred, 1, `Team Rocket's Great Ball: pick a ${heads ? "Evolution" : "Basic"} Team Rocket Pokémon`)) {
        logEvent(state, player, "finds nothing.");
      }
      return;
    }

    case "trVentureBombFlip": {
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Team Rocket's Venture Bomb: ${heads ? "heads" : "tails"}.`);
      const target = heads ? state.players[oppId].active : pl.active;
      if (!target) return;
      target.damage += 20;
      logEvent(state, heads ? player : oppId, `${target.card.name} takes 2 damage counters (20).`);
      return;
    }

    case "healDragon60": {
      if (pl.active && pl.active.card.types.includes("Dragon")) {
        pl.active.damage = Math.max(0, pl.active.damage - 60);
        logEvent(state, player, `heals 60 from ${pl.active.card.name}.`);
      } else {
        logEvent(state, player, "Active is not a Dragon Pokémon.");
      }
      return;
    }

    case "heal150Any": {
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const candidates = allies.filter((p) => p.damage > 0);
      if (candidates.length === 0) {
        logEvent(state, player, "no damaged Pokémon.");
        return;
      }
      if (pl.isAI || candidates.length === 1) {
        const target = candidates.slice().sort((a, b) => b.damage - a.damage)[0];
        const before = target.damage;
        target.damage = Math.max(0, target.damage - 150);
        logEvent(state, player, `heals ${before - target.damage} from ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Poké Vital A: pick a damaged Pokémon to heal 150",
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon",
        action: { kind: "pokeVitalAHeal" },
      };
      return;
    }

    case "dangerousLaser": {
      const opp = state.players[oppId];
      if (!opp.active) return;
      if (!opp.active.statuses.includes("burned")) opp.active.statuses.push("burned");
      if (!opp.active.statuses.includes("confused")) opp.active.statuses.push("confused");
      logEvent(state, player, `${opp.active.card.name} is now Burned and Confused.`);
      return;
    }

    case "recover2Supporters": {
      const pred = (c: Card) => c.supertype === "Trainer" && c.subtypes.includes("Supporter");
      if (!setDiscardRecoveryPick(state, player, pred, 2, "Miracle Headset: pick up to 2 Supporters from discard")) {
        logEvent(state, player, "finds no Supporters in discard.");
      }
      return;
    }

    case "deductionKit": {
      // Look at top 3; auto-leave them on top (no reordering UI yet).
      const top = pl.deck.slice(0, 3);
      logEvent(state, player, top.length
        ? `looks at top ${top.length} card(s).`
        : "deck is empty.");
      return;
    }

    case "primeCatcher": {
      // Gust an opp Benched to Active. "If you do," optionally switch your
      // Active with one of your Bench Pokémon. Both legs are optional in
      // the sense that empty-bench short-circuits skip them gracefully.
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0) {
        logEvent(state, player, "Prime Catcher: no opposing Bench Pokémon to gust.");
        return;
      }

      // AI lane: pick the highest-prize-value bench target our Active can
      // most likely KO this turn. Without easy access to the full damage
      // estimator, score = (estimated KO available) * 1000 + prize value
      // * 100 + raw HP. Skip the optional self-switch by default — the
      // gust's value is the KO, not the swap; switching exposes a bench
      // Pokémon to the opponent's reply unless we have a clear retaliator
      // (Phase 1+ improvement).
      if (pl.isAI) {
        const atk = pl.active;
        const ourPool = atk ? new Set<string>() : null;
        if (atk && ourPool) {
          for (const e of atk.attachedEnergy) for (const p of e.provides) ourPool.add(p);
        }
        const score = (target: PokemonInPlay): number => {
          const subs = target.card.subtypes ?? [];
          const prize =
            subs.includes("Mega Evolution") ? 3 :
            subs.includes("VMAX") ? 3 :
            subs.includes("V-UNION") ? 3 :
            subs.includes("ex") || subs.includes("V") || subs.includes("VSTAR") || subs.includes("GX") ? 2 :
            1;
          // Crude KO estimate: can our Active's strongest payable attack
          // bring this target below 0 HP given existing damage?
          let koAvailable = 0;
          if (atk && ourPool) {
            for (const a of atk.card.attacks ?? []) {
              const cost = a.cost;
              const colored = cost.filter((c) => c !== "Colorless");
              const totalAttached = atk.attachedEnergy.length;
              const havePayoff = colored.every((c) => ourPool.has(c)) && totalAttached >= cost.length;
              if (!havePayoff) continue;
              const dmg = a.damage;
              if (dmg + target.damage >= target.card.hp) {
                koAvailable = Math.max(koAvailable, 1);
              }
            }
          }
          return koAvailable * 1000 + prize * 100 + target.card.hp;
        };
        const benchedTarget = opp.bench.slice().sort((a, b) => score(b) - score(a))[0];
        const idx = opp.bench.indexOf(benchedTarget);
        const r = performGust(state, oppId, idx);
        if (r) logEvent(state, player, `gusts ${r.pulled.card.name} to Active.`);
        // Skip the optional self-switch (Phase 0 default).
        return;
      }

      // Human: open the gust picker. The chain into the optional
      // self-switch lives in resolveInPlayTarget's "primeCatcherGust" case.
      state.pendingInPlayTarget = {
        player,
        label: "Prime Catcher: pick an opposing Bench Pokémon to switch into the Active spot",
        scope: "opp",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "primeCatcherGust" },
      };
      return;
    }

    case "repelSwitchOut": {
      // Force opp to promote a new Active (by clearing their Active to bench).
      const opp = state.players[oppId];
      if (!opp.active || opp.bench.length === 0) {
        logEvent(state, player, "can't switch out — no bench.");
        return;
      }
      const oldActive = opp.active;
      opp.bench.push(oldActive);
      opp.active = null;
      setPendingPromote(state, oppId);
      state.phase = "promoteActive";
      state.onPromoteResolved = null;
      logEvent(state, player, `${opp.name} must choose a new Active.`);
      return;
    }

    case "scoopUpCyclone": {
      // Pick up 1 of your Pokémon. Auto-pick for AI (most damaged); humans
      // pick from their own bench.
      if (pl.bench.length === 0) {
        logEvent(state, player, "no benched Pokémon to scoop.");
        return;
      }
      if (pl.isAI || pl.bench.length === 1) {
        const target = pl.bench.slice().sort((a, b) => b.damage - a.damage)[0];
        const idx = pl.bench.indexOf(target);
        pl.bench.splice(idx, 1);
        pl.hand.push(target.card, ...target.evolvedFrom, ...target.attachedEnergy, ...target.tools);
        logEvent(state, player, `returns ${target.card.name} and attached cards to hand.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Scoop Up Cyclone: pick one of your Benched Pokémon to return to hand",
        scope: "own",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "scoopUpCyclone" },
      };
      return;
    }

    case "scrambleSwitch": {
      if (!pl.active || pl.bench.length === 0) return;

      // AI lane: rank bench by attack readiness given the Energy transfer
      // (current Active's Energy moves wholesale to the new Active under
      // the documented "always move all" approximation). Score = (energy
      // available after transfer) * 100 + max attack damage. Picks the
      // bench Pokémon that becomes the strongest Active post-switch.
      if (pl.isAI) {
        const transferring = pl.active.attachedEnergy.length;
        const ranked = pl.bench
          .map((p, idx) => {
            const energyAfter = p.attachedEnergy.length + transferring;
            const maxDamage = (p.card.attacks ?? []).reduce(
              (m, a) => Math.max(m, a.damage),
              0,
            );
            return { idx, score: energyAfter * 100 + maxDamage };
          })
          .sort((a, b) => b.score - a.score);
        const targetIdx = ranked[0].idx;
        performSwitch(state, player, targetIdx);
        const prev = pl.bench[pl.bench.length - 1];
        if (pl.active && prev) {
          pl.active.attachedEnergy.push(...prev.attachedEnergy);
          prev.attachedEnergy = [];
          logEvent(state, player, `switches + transfers Energy to ${pl.active.card.name}.`);
        }
        enforceSpecialEnergyAttachRules(state);
        return;
      }
      if (pl.bench.length === 1) {
        performSwitch(state, player, 0);
        const prev = pl.bench[pl.bench.length - 1];
        if (pl.active && prev) {
          pl.active.attachedEnergy.push(...prev.attachedEnergy);
          prev.attachedEnergy = [];
          logEvent(state, player, `switches + transfers Energy to ${pl.active.card.name}.`);
        }
        enforceSpecialEnergyAttachRules(state);
        return;
      }

      // Human with multiple bench: open the switch-target picker. Energy
      // transfer is deferred to the resolver (and uses the always-move-all
      // approximation — see docs/ITEM_AUDIT.md).
      state.pendingInPlayTarget = {
        player,
        label: "Scramble Switch: pick a Benched Pokémon to switch into the Active spot",
        scope: "own",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "scrambleSwitchTarget" },
      };
      return;
    }

    case "rebootPodFuture": {
      // Attach a Basic Energy from discard to each Future Pokémon.
      const targets = [pl.active, ...pl.bench].filter(
        (p): p is PokemonInPlay => !!p && p.card.subtypes.includes("Future"),
      );
      let attached = 0;
      for (const t of targets) {
        const idx = pl.discard.findIndex(isBasicEnergy);
        if (idx < 0) break;
        const [e] = pl.discard.splice(idx, 1) as [EnergyCard];
        t.attachedEnergy.push(e);
        attached++;
      }
      logEvent(state, player, `attaches ${attached} Energy to Future Pokémon.`);
      return;
    }

    case "nsPPUp": {
      // Attach a Basic Energy from discard to 1 Benched N's Pokémon.
      const target = pl.bench.find((p) => p.card.name.startsWith("N's "));
      if (!target) { logEvent(state, player, "no Benched N's Pokémon."); return; }
      const idx = pl.discard.findIndex(isBasicEnergy);
      if (idx < 0) { logEvent(state, player, "no basic Energy in discard."); return; }
      const [e] = pl.discard.splice(idx, 1) as [EnergyCard];
      target.attachedEnergy.push(e);
      logEvent(state, player, `attaches ${e.name} to ${target.card.name}.`);
      return;
    }

    case "wondrousPatchPsychic": {
      const candidates = pl.bench.filter((p) => p.card.types.includes("Psychic"));
      if (candidates.length === 0) {
        logEvent(state, player, "no Benched Psychic Pokémon.");
        return;
      }
      const energyIdx = pl.discard.findIndex(
        (c) => isBasicEnergy(c) && c.provides.includes("Psychic"),
      );
      if (energyIdx < 0) {
        logEvent(state, player, "no Basic Psychic Energy in discard.");
        return;
      }
      if (pl.isAI || candidates.length === 1) {
        const target = candidates[0];
        const [e] = pl.discard.splice(energyIdx, 1) as [EnergyCard];
        target.attachedEnergy.push(e);
        logEvent(state, player, `attaches ${e.name} to ${target.card.name}.`);
        return;
      }
      state.pendingInPlayTarget = {
        player,
        label: "Wondrous Patch: pick a Benched Psychic to attach a Basic Psychic Energy from discard",
        scope: "own",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "wondrousPatchAttach" },
      };
      return;
    }

    case "glassTrumpet": {
      // Requires any Tera Pokémon in play.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const hasTera = allies.some((p) => p.card.subtypes.includes("Tera"));
      if (!hasTera) { logEvent(state, player, "needs a Tera Pokémon in play."); return; }
      const colorlessBench = pl.bench.filter((p) => p.card.types.includes("Colorless"));
      if (colorlessBench.length === 0) {
        logEvent(state, player, "Glass Trumpet: no Benched Colorless Pokémon.");
        return;
      }

      // AI lane: pair each Bench Colorless target with the discard Energy
      // whose type best closes its next-attack cost gap. Greedy: prefer
      // (target, energy) pairs where the Energy fills a non-Colorless cost
      // slot the target hasn't paid yet; fall back to any Basic Energy if
      // no strong type match. Each target receives at most one Energy
      // (per card text "to each of them"). Up to 2 attachments total.
      if (pl.isAI) {
        const wantedTypes = (t: PokemonInPlay): Set<EnergyType> => {
          const want = new Set<EnergyType>();
          for (const a of t.card.attacks ?? []) {
            for (const c of a.cost) if (c !== "Colorless") want.add(c);
          }
          // Subtract types already attached.
          for (const e of t.attachedEnergy) {
            for (const p of e.provides) want.delete(p as EnergyType);
          }
          return want;
        };
        const usedEnergy = new Set<EnergyCard>();
        let attached = 0;
        // Sort targets so those with the most un-met non-Colorless cost
        // slots get first pick of the matching Energy.
        const targetsByNeed = colorlessBench
          .map((t) => ({ t, want: wantedTypes(t) }))
          .sort((a, b) => b.want.size - a.want.size);
        for (const { t, want } of targetsByNeed) {
          if (attached >= 2) break;
          // Find best matching Energy in discard.
          let bestIdx = -1;
          let bestScore = -1;
          for (let i = 0; i < pl.discard.length; i++) {
            const c = pl.discard[i];
            if (!isBasicEnergy(c)) continue;
            const e = c as EnergyCard;
            if (usedEnergy.has(e)) continue;
            let score = 0;
            for (const p of e.provides) if (want.has(p as EnergyType)) score += 50;
            if (score === 0) score = 1; // Colorless filler fallback
            if (score > bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }
          if (bestIdx < 0) break;
          const [e] = pl.discard.splice(bestIdx, 1) as [EnergyCard];
          t.attachedEnergy.push(e);
          usedEnergy.add(e);
          attached++;
        }
        logEvent(state, player, `attaches ${attached} basic Energy to Benched Colorless Pokémon.`);
        return;
      }

      // Human: open a discard-recovery picker. The afterPick handler stashes
      // the chosen Energy on `pendingAttachQueue` (so it never lands in
      // hand) and opens the per-Bench attach picker.
      if (!setDiscardRecoveryPick(
        state, player, isBasicEnergy, 2,
        "Glass Trumpet: pick up to 2 Basic Energy from your discard pile",
      )) {
        logEvent(state, player, "Glass Trumpet: no basic Energy in discard.");
        return;
      }
      // setDiscardRecoveryPick doesn't take afterPick yet — set it manually
      // since pendingPick is now in state. (Keeps the public helper signature
      // narrow.)
      if (state.pendingPick) {
        state.pendingPick.afterPick = { kind: "glassTrumpetStash" };
        state.pendingPick.effectKind = "glassTrumpetEnergyPick";
      }
      return;
    }

    // ---- New (this build pass) ------------------------------------------
    case "boxedOrder": {
      const isItem = (c: Card) =>
        c.supertype === "Trainer" && (c.subtypes ?? []).includes("Item");
      if (!setDeckSearchPick(state, player, isItem, 2, "Boxed Order: pick up to 2 Items", { endTurnOnResolve: true } as never)) {
        logEvent(state, player, "Boxed Order: no Items in deck.");
      }
      return;
    }
    case "salvatoreEvolveSearch": {
      // "Search your deck for a Pokémon that evolves from one of your Pokémon,
      // and put it onto that Pokémon to evolve it." Predicate: Evolution
      // Pokémon (Stage 1 / Stage 2) whose evolvesFrom matches an in-play
      // ally that's eligible to evolve right now (not played-this-turn).
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const eligibleNames = new Set(
        allies.filter((a) => !a.playedThisTurn).map((a) => a.card.name),
      );
      const isEligibleEvo = (c: Card) =>
        c.supertype === "Pokémon" &&
        !!(c as PokemonCard).evolvesFrom &&
        eligibleNames.has((c as PokemonCard).evolvesFrom!);

      // AI: keep auto-pick (first eligible) for speed.
      if (pl.isAI) {
        const idx = pl.deck.findIndex(isEligibleEvo);
        if (idx < 0) {
          logEvent(state, player, "Salvatore: no eligible evolution.");
          shuffleDeck(state, player);
          return;
        }
        const [evo] = pl.deck.splice(idx, 1) as [PokemonCard];
        const ally = allies.find((a) => a.card.name === evo.evolvesFrom && !a.playedThisTurn)!;
        ally.evolvedFrom.push(ally.card);
        ally.card = evo;
        applyEvolveSideEffects(state, ally);
        shuffleDeck(state, player);
        logEvent(state, player, `Salvatore: evolves ${ally.card.name}.`);
        return;
      }

      // Human: open an interactive deck search; the picker's `toEvolve`
      // mode applies the picked card to a matching ally on resolve.
      if (!setDeckSearchPick(
        state, player, isEligibleEvo, 1, "Salvatore: pick an Evolution to apply",
        { toEvolve: true },
      )) {
        logEvent(state, player, "Salvatore: no eligible evolution.");
      }
      return;
    }
    case "surferSwitchDraw5": {
      if (pl.active && pl.bench.length > 0) {
        performSwitch(state, player, 0);
        const need = Math.max(0, 5 - pl.hand.length);
        if (need > 0) drawUpTo(state, player, need);
      }
      return;
    }
    case "acerolasMischief": {
      // "Choose 1 of your Pokémon. During opp's next turn, prevent damage and
      // effects of attacks done to that Pokémon by opp's Pokémon ex." Auto-
      // pick: damaged ally with most HP at risk. Approximation: queue a
      // turn-scoped damage reduction of 999 vs ex on next opp turn (effectively
      // prevents damage). For simplicity we just apply the reduction to ALL
      // damage; close enough.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      if (allies.length === 0) return;
      pl.nextOpponentTurnDamageReductions.push({ amount: 999 });
      logEvent(state, player, "Acerola's Mischief: prevents damage to your Pokémon next turn.");
      return;
    }
    case "briarExtraPrize":
    case "antheaConcordiaExtraPrize": {
      // Mark a turn-scoped flag for "+1 Prize on KO this turn". Engine-side
      // hook needed in knockOut(). Without that hook we'll just log and treat
      // as cosmetic.
      logEvent(state, player, `${id === "briarExtraPrize" ? "Briar" : "Anthea & Concordia"}: +1 Prize on KO this turn (visual only).`);
      return;
    }
    case "energySwatter": {
      // Reveal opp's hand; put 1 Energy on the bottom of their deck. Auto-pick.
      const opp = state.players[oppId];
      const idx = opp.hand.findIndex((c) => c.supertype === "Energy");
      if (idx < 0) {
        logEvent(state, player, "Energy Swatter: no Energy in opponent's hand.");
        return;
      }
      const [c] = opp.hand.splice(idx, 1);
      opp.deck.push(c);
      logEvent(state, player, `Energy Swatter: ${c.name} → bottom of ${opp.name}'s deck.`);
      return;
    }
    case "accompanyingFlute": {
      // Reveal top 5 of opp deck; bench any number of Basic Pokémon found.
      const opp = state.players[oppId];
      const top = opp.deck.splice(0, 5);
      let benched = 0;
      const rest: Card[] = [];
      for (const c of top) {
        if (
          benched + opp.bench.length < 5 &&
          c.supertype === "Pokémon" &&
          (c.subtypes ?? []).includes("Basic")
        ) {
          opp.bench.push(makePokemonInPlay(c as PokemonCard));
          benched++;
        } else {
          rest.push(c);
        }
      }
      opp.deck.push(...rest);
      shuffleDeck(state, oppId);
      logEvent(state, player, `Accompanying Flute: benches ${benched} Basic to ${opp.name}'s side.`);
      return;
    }
    case "janineSecretArt": {
      // For up to 2 Darkness Pokémon, search a Basic Darkness Energy and
      // attach. Auto-pick.
      const allies = [pl.active, ...pl.bench]
        .filter((p): p is PokemonInPlay => !!p)
        .filter((p) => p.card.types.includes("Darkness"))
        .slice(0, 2);
      let attached = 0;
      for (const ally of allies) {
        const idx = pl.deck.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Darkness"),
        );
        if (idx < 0) break;
        const [en] = pl.deck.splice(idx, 1) as [EnergyCard];
        ally.attachedEnergy.push(en);
        attached++;
        if (ally === pl.active && !ally.statuses.includes("poisoned")) {
          ally.statuses.push("poisoned");
        }
      }
      shuffleDeck(state, player);
      logEvent(state, player, `Janine's Secret Art: attaches ${attached} Darkness Energy.`);
      pl.lastSupporterNameThisTurn = "Janine's Secret Art";
      return;
    }
    case "lucianShuffleFlip": {
      // Both shuffle hand to bottom; each flips a coin (heads 6, tails 3).
      const me = state.players[player];
      const opp = state.players[oppId];
      const myHand = me.hand.splice(0);
      const oppHand = opp.hand.splice(0);
      me.deck.push(...myHand);
      opp.deck.push(...oppHand);
      const myHeads = state.rng.next() < 0.5;
      const oppHeads = state.rng.next() < 0.5;
      drawUpTo(state, player, myHeads ? 6 : 3);
      drawUpTo(state, oppId, oppHeads ? 6 : 3);
      logEvent(state, player, `Lucian: both shuffled. You: ${myHeads ? "heads (6)" : "tails (3)"}, opp: ${oppHeads ? "heads (6)" : "tails (3)"}.`);
      return;
    }
    case "tymePokemonGuess": {
      // Simplified: opp guesses; 50/50 → 4 cards or you draw 4.
      const guessRight = state.rng.next() < 0.5;
      if (guessRight) drawUpTo(state, oppId, 4);
      else drawUpTo(state, player, 4);
      return;
    }
    case "treasureTrackerToolSearch": {
      // ACE SPEC — search up to 5 Pokémon Tool cards from your deck.
      const isTool = (c: Card) =>
        c.supertype === "Trainer" &&
        ((c.subtypes ?? []).includes("Pokémon Tool") || (c.subtypes ?? []).includes("Tool"));
      if (!setDeckSearchPick(state, player, isTool, 5, "Treasure Tracker: pick up to 5 Pokémon Tools")) {
        logEvent(state, player, "Treasure Tracker: no Pokémon Tools in deck.");
      }
      return;
    }

    case "maxRodRecoverPokemonOrEnergy": {
      // ACE SPEC — recover up to 5 cards (any Pokémon and/or Basic Energy) from discard.
      const pred = (c: Card) =>
        c.supertype === "Pokémon" ||
        (c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic"));
      if (!setDiscardRecoveryPick(state, player, pred, 5, "Max Rod: pick up to 5 Pokémon or Basic Energy from discard")) {
        logEvent(state, player, "Max Rod: nothing eligible in discard.");
      }
      return;
    }

    case "secretBoxQuadSearch": {
      // ACE SPEC — discard 3 cards from hand (Secret Box itself is already
      // out of pl.hand by the time this runs), then search deck for one
      // Item, Pokémon Tool, Supporter, and Stadium.
      //
      // Hand-size precheck lives in precheckTrainerEffect so the trainer
      // card itself isn't wasted on illegal plays.
      if (pl.isAI) {
        // AI auto-discard heuristic: prefer to keep basic Energy + Pokémon;
        // drop dupes and Trainers first.
        const isBasicEn = (c: Card) =>
          c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
        const isPokemon = (c: Card) => c.supertype === "Pokémon";
        const handCounts = new Map<string, number>();
        for (const c of pl.hand) handCounts.set(c.name, (handCounts.get(c.name) ?? 0) + 1);
        const sorted = pl.hand
          .map((c, i) => ({ c, i }))
          .sort((a, b) => {
            const aDup = (handCounts.get(a.c.name) ?? 1) > 1 ? 0 : 1;
            const bDup = (handCounts.get(b.c.name) ?? 1) > 1 ? 0 : 1;
            if (aDup !== bDup) return aDup - bDup;
            const aP = isPokemon(a.c) ? 2 : isBasicEn(a.c) ? 3 : 1;
            const bP = isPokemon(b.c) ? 2 : isBasicEn(b.c) ? 3 : 1;
            if (aP !== bP) return aP - bP;
            return a.i - b.i;
          });
        const toDiscardIdxs = sorted.slice(0, 3).map((x) => x.i).sort((a, b) => b - a);
        for (const i of toDiscardIdxs) {
          const [c2] = pl.hand.splice(i, 1);
          pl.discard.push(c2);
        }
        logEvent(state, player, "Secret Box: discards 3 cards.");
        // AI auto-take first match of each kind in one shot.
        const isItemOnly = (c: Card) =>
          c.supertype === "Trainer" &&
          (c.subtypes ?? []).includes("Item") &&
          !(c.subtypes ?? []).includes("Pokémon Tool") &&
          !(c.subtypes ?? []).includes("Tool");
        const isTool = (c: Card) =>
          c.supertype === "Trainer" &&
          ((c.subtypes ?? []).includes("Pokémon Tool") || (c.subtypes ?? []).includes("Tool"));
        const isSupp = (c: Card) =>
          c.supertype === "Trainer" && (c.subtypes ?? []).includes("Supporter");
        const isStadium = (c: Card) =>
          c.supertype === "Trainer" && (c.subtypes ?? []).includes("Stadium");
        const grab = (label: string, pred: (c: Card) => boolean): void => {
          const idx = pl.deck.findIndex(pred);
          if (idx >= 0) {
            pl.hand.push(pl.deck.splice(idx, 1)[0]);
            logEvent(state, player, `Secret Box: takes ${label}.`);
          }
        };
        grab("an Item", isItemOnly);
        grab("a Pokémon Tool", isTool);
        grab("a Supporter", isSupp);
        grab("a Stadium", isStadium);
        shuffleDeck(state, player);
        return;
      }
      // Human: pick 3 cards to discard, then chain Item → Tool → Supporter → Stadium.
      state.pendingHandReveal = {
        player,
        target: player,
        label: "Secret Box: pick 3 cards from your hand to discard",
        min: 3,
        max: 3,
        filter: "any",
        action: "discard",
        postAction: { kind: "secretBoxStartItemSearch" },
      };
      return;
    }

    case "rocketBotherBotPrizePeek": {
      // Team Rocket's Bother-Bot — flips one face-down Prize face up and
      // peeks a random card from opp's hand. Our engine doesn't track
      // face-up vs face-down Prize state; we still surface the information
      // via log so the play has a visible effect. Auto-declines the
      // optional swap (would require both UI + tracking-which-prize).
      const opp = state.players[oppId];
      if (opp.prizes.length === 0) {
        logEvent(state, player, "Bother-Bot: opponent has no Prizes left.");
        return;
      }
      // Peek the first Prize (positions are unordered to the player anyway).
      const prizeCard = opp.prizes[0];
      logEvent(state, player, `Bother-Bot: reveals opponent Prize card — ${prizeCard.name}.`);
      // Reveal a random card from opp's hand.
      if (opp.hand.length > 0) {
        const idx = state.rng.int(opp.hand.length);
        const handCard = opp.hand[idx];
        logEvent(state, player, `Bother-Bot: reveals from ${opp.name}'s hand — ${handCard.name}.`);
      } else {
        logEvent(state, player, `Bother-Bot: ${opp.name} has no hand cards.`);
      }
      return;
    }

    case "playFossilAsBasic": {
      // Antique Fossil items — play as a 60-HP Basic Colorless Pokémon onto
      // the Bench. The Pokémon has no attacks, can't be afflicted by Special
      // Conditions (handled by canBeAfflictedBy), and can't retreat (handled
      // by effectiveRetreatCost). The voluntary "discard from play during
      // your turn" is exposed via the standard discard route.
      if (pl.bench.length >= 5) {
        logEvent(state, player, "Fossil: bench is full.");
        return;
      }
      const fossilPokemon = makeFossilPokemonInPlay(t.name, state);
      pl.bench.push(fossilPokemon);
      logEvent(state, player, `plays ${t.name} to the Bench as a Pokémon.`);
      return;
    }

    case "larrySkillDiscardSearch": {
      // Discard hand; search a Pokémon, a Supporter, and a Basic Energy.
      // AI auto-picks first match of each; humans get three chained pickers
      // so they can choose specifically (mirrors dawnSearchBasicStage1Stage2).
      pl.discard.push(...pl.hand.splice(0));
      logEvent(state, player, "Larry's Skill: discards hand and searches.");
      if (pl.isAI) {
        const idxP = pl.deck.findIndex((c) => c.supertype === "Pokémon");
        if (idxP >= 0) pl.hand.push(pl.deck.splice(idxP, 1)[0]);
        const idxS = pl.deck.findIndex(
          (c) => c.supertype === "Trainer" && c.subtypes.includes("Supporter"),
        );
        if (idxS >= 0) pl.hand.push(pl.deck.splice(idxS, 1)[0]);
        const idxE = pl.deck.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
        );
        if (idxE >= 0) pl.hand.push(pl.deck.splice(idxE, 1)[0]);
        shuffleDeck(state, player);
        return;
      }
      // Human path — open the first pick (Pokémon); chain into Supporter,
      // then Basic Energy via the pendingPick resolver's postResolveChain.
      const isPokemon = (c: Card) => c.supertype === "Pokémon";
      if (
        !setDeckSearchPick(state, player, isPokemon, 1, "Larry's Skill (1 of 3): pick a Pokémon", {
          postResolveChain: { kind: "larry-skill-supporter" },
        })
      ) {
        logEvent(state, player, "Larry's Skill: no Pokémon in deck.");
      }
      return;
    }
    case "drawPerAncient": {
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const count = allies.filter((p) => (p.card.subtypes ?? []).includes("Ancient")).length;
      drawUpTo(state, player, count);
      return;
    }
    case "brilliantBlenderMill5": {
      const milled = pl.deck.splice(0, 5);
      pl.discard.push(...milled);
      shuffleDeck(state, player);
      logEvent(state, player, `Brilliant Blender: discards ${milled.length} from deck.`);
      return;
    }
    case "megatonBlower": {
      const opp = state.players[oppId];
      let count = 0;
      for (const p of [opp.active, ...opp.bench]) {
        if (!p) continue;
        if (p.tools.length > 0) {
          opp.discard.push(...p.tools);
          p.tools = [];
          count++;
        }
        const remain: EnergyCard[] = [];
        for (const e of p.attachedEnergy) {
          if (e.subtypes.includes("Special")) {
            opp.discard.push(e);
            count++;
          } else remain.push(e);
        }
        p.attachedEnergy = remain;
      }
      if (state.stadium) {
        const stadium = state.stadium.card;
        const stadiumOwner = state.stadium.controller;
        state.players[stadiumOwner].discard.push(stadium);
        state.stadium = null;
        count++;
      }
      logEvent(state, player, `Megaton Blower: removes ${count} Tools/Special Energy/Stadium.`);
      return;
    }
    case "blowtorch": {
      // Cost: discard a Basic Fire Energy from hand. Effect: discard one of
      // (opp's Pokémon Tool / opp's Special Energy / Stadium in play).
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes("Fire"),
      );
      if (idx < 0) {
        logEvent(state, player, "Blowtorch: no Basic Fire Energy to discard.");
        return;
      }
      const [fire] = pl.hand.splice(idx, 1);
      pl.discard.push(fire);
      // Auto-pick: opp's Active Tool > Special Energy > Stadium
      const opp = state.players[oppId];
      let removed = false;
      if (opp.active && opp.active.tools.length > 0) {
        const t = opp.active.tools.shift()!;
        opp.discard.push(t);
        logEvent(state, player, `Blowtorch: discards ${t.name}.`);
        removed = true;
      } else if (opp.active) {
        const idxE = opp.active.attachedEnergy.findIndex((e) => e.subtypes.includes("Special"));
        if (idxE >= 0) {
          const [e] = opp.active.attachedEnergy.splice(idxE, 1);
          opp.discard.push(e);
          logEvent(state, player, `Blowtorch: discards ${e.name}.`);
          removed = true;
        }
      }
      if (!removed && state.stadium) {
        const stadium = state.stadium.card;
        const owner = state.stadium.controller;
        state.players[owner].discard.push(stadium);
        state.stadium = null;
        logEvent(state, player, `Blowtorch: discards ${stadium.name}.`);
      }
      return;
    }
    case "chillTeaserToy": {
      const opp = state.players[oppId];
      // Bounce 1 Energy from one of opp's Pokémon to their hand. Auto-pick: opp's Active.
      const target = opp.active;
      if (!target || target.attachedEnergy.length === 0) return;
      const [e] = target.attachedEnergy.splice(0, 1);
      opp.hand.push(e);
      logEvent(state, player, `Chill Teaser Toy: bounces ${e.name}.`);
      return;
    }
    case "rotoStick": {
      const top = pl.deck.splice(0, 4);
      const supporters = top.filter(
        (c) => c.supertype === "Trainer" && c.subtypes.includes("Supporter"),
      );
      pl.hand.push(...supporters);
      const rest = top.filter((c) => !supporters.includes(c));
      pl.deck.push(...rest);
      shuffleDeck(state, player);
      logEvent(state, player, `Roto-Stick: takes ${supporters.length} Supporter(s).`);
      return;
    }
    case "meddlingMemo": {
      const opp = state.players[oppId];
      const count = opp.hand.length;
      opp.deck.push(...opp.hand.splice(0));
      drawUpTo(state, oppId, count);
      logEvent(state, player, `Meddling Memo: ${opp.name} cycles ${count} hand cards.`);
      return;
    }
    case "callBell": {
      if (state.turn !== 1 || state.firstTurnNoAttack) {
        logEvent(state, player, "Call Bell: only usable on your first turn going second.");
        return;
      }
      const isSup = (c: Card) =>
        c.supertype === "Trainer" && c.subtypes.includes("Supporter");
      if (!setDeckSearchPick(state, player, isSup, 1, "Call Bell: pick a Supporter")) {
        logEvent(state, player, "Call Bell: no Supporter in deck.");
      }
      return;
    }
    case "loveBall": {
      const opp = state.players[oppId];
      const oppNames = new Set(
        [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p).map((p) => p.card.name),
      );
      const isMatch = (c: Card) =>
        c.supertype === "Pokémon" && oppNames.has(c.name);
      if (!setDeckSearchPick(state, player, isMatch, 1, "Love Ball: pick a Pokémon matching opp's name")) {
        logEvent(state, player, "Love Ball: no matching Pokémon in deck.");
      }
      return;
    }
    case "strangeTimepieceDevolve": {
      // Devolve 1 of your evolved Psychic Pokémon. Auto-pick.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allies.find(
        (p) => p.card.types.includes("Psychic") && p.evolvedFrom.length > 0,
      );
      if (!target) {
        logEvent(state, player, "Strange Timepiece: no evolved Psychic Pokémon.");
        return;
      }
      // Move all evolution stages to hand; current card replaced with the
      // bottom of evolvedFrom. Tool/Energy stays.
      const evolved = [target.card, ...target.evolvedFrom];
      const baseCard = evolved.pop()!;
      pl.hand.push(...evolved);
      target.card = baseCard;
      target.evolvedFrom = [];
      target.evolvedThisTurn = false;
      logEvent(state, player, `Strange Timepiece: devolves to ${baseCard.name}.`);
      return;
    }
    case "cassiopeiaSearch2": {
      // Only usable when it's the last card in hand. Search up to 2.
      if (pl.hand.length > 0) {
        logEvent(state, player, "Cassiopeia: must be your last card to use.");
        return;
      }
      if (!setDeckSearchPick(state, player, () => true, 2, "Cassiopeia: pick up to 2 cards")) {
        logEvent(state, player, "Cassiopeia: deck is empty.");
      }
      return;
    }
    case "rosaEnergyToStage2": {
      // Need to have more prizes than opp. Auto-pick: attach 2 Basic Energy to first Stage 2.
      const opp = state.players[oppId];
      if (pl.prizes.length <= opp.prizes.length) {
        logEvent(state, player, "Rosa's Encouragement: requires more prizes than opp.");
        return;
      }
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const stage2 = allies.find((p) => (p.card.subtypes ?? []).includes("Stage 2"));
      if (!stage2) {
        logEvent(state, player, "Rosa's Encouragement: no Stage 2 in play.");
        return;
      }
      let attached = 0;
      for (let i = 0; i < 2; i++) {
        const idx = pl.discard.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
        );
        if (idx < 0) break;
        const [e] = pl.discard.splice(idx, 1) as [EnergyCard];
        stage2.attachedEnergy.push(e);
        attached++;
      }
      logEvent(state, player, `Rosa's Encouragement: attaches ${attached} Basic Energy to ${stage2.card.name}.`);
      return;
    }
    case "sacredCharmTool":
    case "gravityGemstoneTool":
    case "handheldFanTool":
    case "ltSurgeStrategy": {
      // Tools/passive — handled elsewhere; this branch fires only if the card
      // is somehow played as a non-Tool. Discard with no effect.
      return;
    }
    case "perrinSearch": {
      // Reveal up to 2 Pokémon from hand → put into deck → search same number.
      // Real card text: "Reveal up to 2 Pokémon from your hand. Shuffle them
      // into your deck. Then, search your deck for the same number of
      // Pokémon and put them into your hand." Player picks WHICH Pokémon to
      // reveal — the engine used to auto-pick the last 2 in hand-order.
      const pokemonInHand = pl.hand.filter((c) => c.supertype === "Pokémon");
      if (pokemonInHand.length === 0) {
        logEvent(state, player, "Perrin: no Pokémon in hand to reveal.");
        return;
      }
      // AI: keep auto-resolve (last-2 heuristic — recycles non-needed copies).
      if (pl.isAI) {
        const reveal: Card[] = [];
        for (let i = pl.hand.length - 1; i >= 0 && reveal.length < 2; i--) {
          if (pl.hand[i].supertype === "Pokémon") {
            reveal.push(pl.hand.splice(i, 1)[0]);
          }
        }
        pl.deck.push(...reveal);
        shuffleDeck(state, player);
        const isPoke = (c: Card) => c.supertype === "Pokémon";
        if (!setDeckSearchPick(state, player, isPoke, reveal.length, `Perrin: pick up to ${reveal.length} Pokémon`)) {
          logEvent(state, player, "Perrin: no Pokémon in deck.");
        }
        return;
      }
      // Human: open interactive hand-reveal. The resolver chains into the
      // deck-search via postAction. NOTE: `toBottomOfDeck` puts the revealed
      // cards on the bottom of the deck; `setDeckSearchPick` shuffles the
      // deck on resolution, so the end state matches "shuffled into deck."
      const max = Math.min(2, pokemonInHand.length);
      state.pendingHandReveal = {
        player,
        target: player,
        label: `Perrin: pick up to ${max} Pokémon to shuffle back into deck`,
        min: 0,
        max,
        filter: "pokemon",
        action: "toBottomOfDeck",
        postAction: {
          kind: "searchDeckAnyPokemon",
          max,
          label: `Perrin: pick up to ${max} Pokémon`,
          useRevealedCount: true,
        },
      };
      return;
    }
    case "raifortPeek5Discard": {
      // Look at top 5; pick any number to discard; the rest stay on top.
      const top = pl.deck.splice(0, Math.min(5, pl.deck.length));
      if (top.length === 0) {
        logEvent(state, player, "Raifort: deck is empty.");
        return;
      }
      if (pl.isAI) {
        // AI: keep everything on top (no discard) — conservative.
        pl.deck.unshift(...top);
        logEvent(state, player, `Raifort: examines top ${top.length} card(s).`);
        return;
      }
      state.pendingPick = {
        player,
        label: `Raifort: pick any number of the top ${top.length} cards to discard`,
        pool: top,
        min: 0,
        max: top.length,
        unpicked: "topOfDeck",
        pickedDestination: "discard",
        source: "deckTop",
      };
      state.phase = "pick";
      return;
    }
    case "canariLightningSearch": {
      // Cost: discard another card from hand.
      if (!discardOneOtherFromHand(state, player)) {
        logEvent(state, player, "Canari: no card to discard.");
        return;
      }
      const isLightningPoke = (c: Card) =>
        c.supertype === "Pokémon" && c.types.includes("Lightning");
      if (!setDeckSearchPick(state, player, isLightningPoke, 4, "Canari: pick up to 4 Lightning Pokémon")) {
        logEvent(state, player, "Canari: no Lightning Pokémon in deck.");
      }
      pl.lastSupporterNameThisTurn = "Canari";
      return;
    }
    case "trGiovanniSwitchGust": {
      // Switch your Active TR Pokémon with a Benched TR Pokémon, then gust
      // opp's bench to Active. Auto-pick: highest-HP TR bench → Active; opp
      // bench target = highest-HP.
      if (!pl.active || !pl.active.card.name.startsWith("Team Rocket's ")) {
        logEvent(state, player, "Team Rocket's Giovanni: no Active Team Rocket's Pokémon.");
        return;
      }
      const trBench = pl.bench.findIndex((p) => p.card.name.startsWith("Team Rocket's "));
      if (trBench < 0) {
        logEvent(state, player, "Team Rocket's Giovanni: no Benched Team Rocket's Pokémon.");
        return;
      }
      performSwitch(state, player, trBench);
      // Gust opp.
      const opp = state.players[oppId];
      if (opp.active && opp.bench.length > 0) {
        const target = opp.bench.slice().sort((a, b) => b.card.hp - a.card.hp)[0];
        const idx = opp.bench.indexOf(target);
        const r = performGust(state, oppId, idx);
        if (r) logEvent(state, player, `gusts ${r.pulled.card.name} into Active.`);
      }
      return;
    }
    case "trArcherShuffleDraw": {
      // Cost: any of your TR Pokémon were KO'd during opp's last turn.
      if (!pl.yourPokemonKoedLastOppTurn) {
        logEvent(state, player, "Team Rocket's Archer: requires a Team Rocket's KO last turn.");
        return;
      }
      // Both players shuffle hand into deck; you draw 5, opp draws 3.
      shuffleHandIntoDeck(state, player);
      shuffleHandIntoDeck(state, oppId);
      drawUpTo(state, player, 5);
      drawUpTo(state, oppId, 3);
      logEvent(state, player, "Team Rocket's Archer: both shuffled. You drew 5, opp drew 3.");
      return;
    }
    case "unfairStampShuffleDraw": {
      // Unfair Stamp (ACE SPEC). Gate: any of your Pokémon were KO'd
      // during your opponent's last turn. Both players shuffle hand into
      // deck; you draw 5, opp draws 2.
      if (!pl.yourPokemonKoedLastOppTurn) {
        logEvent(state, player, "Unfair Stamp: requires one of your Pokémon to have been Knocked Out during your opponent's last turn.");
        return;
      }
      shuffleHandIntoDeck(state, player);
      shuffleHandIntoDeck(state, oppId);
      drawUpTo(state, player, 5);
      drawUpTo(state, oppId, 2);
      logEvent(state, player, "Unfair Stamp: both shuffled. You drew 5, opp drew 2.");
      return;
    }
    case "ogresMaskSwapOgerpon": {
      // Swap an Ogerpon ex in discard with an Ogerpon ex in play (transfer
      // damage / energy / status / tools). Auto-pick: first match.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const inPlay = allies.find(
        (p) => p.card.subtypes.includes("ex") && p.card.name.includes("Ogerpon"),
      );
      if (!inPlay) {
        logEvent(state, player, "Ogre's Mask: no Ogerpon ex in play.");
        return;
      }
      const idx = pl.discard.findIndex(
        (c) => c.supertype === "Pokémon" && c.subtypes.includes("ex") && c.name.includes("Ogerpon") && c.name !== inPlay.card.name,
      );
      if (idx < 0) {
        logEvent(state, player, "Ogre's Mask: no different Ogerpon ex in discard.");
        return;
      }
      const [newCard] = pl.discard.splice(idx, 1) as [PokemonCard];
      pl.discard.push(inPlay.card);
      // Replace card on the in-play instance, preserving everything else.
      inPlay.card = newCard;
      logEvent(state, player, `Ogre's Mask: swaps in ${newCard.name}.`);
      return;
    }
    case "redeemableTicketReprize": {
      // Shuffle prizes, redraw same count from deck top.
      if (pl.prizes.length === 0) return;
      const oldPrizes = pl.prizes.splice(0);
      pl.deck.push(...oldPrizes);
      shuffleDeck(state, player);
      const n = oldPrizes.length;
      pl.prizes = pl.deck.splice(0, n);
      logEvent(state, player, `Redeemable Ticket: shuffles ${n} prizes back, draws ${n} new ones.`);
      return;
    }
    case "tmFluoriteTool": {
      // Passive — handled at attach time. This branch fires only if played
      // as a non-Tool (shouldn't happen).
      return;
    }

    // me4 (Chaos Rising) ---------------------------------------------------
    case "specialRedCard": {
      // Item — gated to opp ≤3 prizes by precheck. Opp puts hand on bottom
      // of deck (FIFO), then if any cards moved, draws 3.
      const opp = state.players[oppId];
      const moved = opp.hand.length;
      opp.deck.push(...opp.hand);
      opp.hand = [];
      let drawn = 0;
      if (moved > 0) {
        for (let i = 0; i < 3; i++) {
          const c = opp.deck.shift();
          if (!c) break;
          opp.hand.push(c);
          drawn++;
        }
      }
      logEvent(
        state,
        player,
        `Special Red Card: ${opp.name} bottoms ${moved} card(s); draws ${drawn}.`,
      );
      return;
    }

    case "bigCatchingNet": {
      // Item — shuffle up to 3 (Water Pokémon and/or basic Water Energy)
      // from discard back into deck. Auto-pick: take Pokémon first (more
      // valuable to recycle), then Energy.
      const indices: number[] = [];
      for (let i = 0; i < pl.discard.length && indices.length < 3; i++) {
        const c = pl.discard[i];
        if (c.supertype === "Pokémon" && c.types.includes("Water")) indices.push(i);
      }
      for (let i = 0; i < pl.discard.length && indices.length < 3; i++) {
        if (indices.includes(i)) continue;
        const c = pl.discard[i];
        if (
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes("Water")
        )
          indices.push(i);
      }
      indices.sort((a, b) => b - a);
      const moved: Card[] = [];
      for (const i of indices) {
        moved.push(pl.discard.splice(i, 1)[0]);
      }
      pl.deck.push(...moved);
      shuffleDeck(state, player);
      logEvent(state, player, `Big Catching Net: shuffles ${moved.length} card(s) from discard into deck.`);
      return;
    }

    case "azsTranquility": {
      // Supporter — switch active with bench, then heal 80 from the
      // outgoing (now-benched) Pokémon. Reuse simpleSwitch logic and add
      // the heal post-switch.
      if (pl.bench.length === 0) return;
      // Keep a pre-switch reference to the outgoing active. After
      // performSwitch, it's at the back of pl.bench.
      const outgoingName = pl.active?.card.name ?? "";
      // Use the same picker as the Switch item: pendingSwitchTarget on auto-AI,
      // or open the picker on humans.
      if (pl.isAI) {
        // Simple AI heuristic: switch to the highest-HP basic on bench.
        let bestIdx = 0;
        let bestHp = 0;
        for (let i = 0; i < pl.bench.length; i++) {
          const hp = pl.bench[i].card.hp - pl.bench[i].damage;
          if (hp > bestHp) {
            bestHp = hp;
            bestIdx = i;
          }
        }
        performSwitch(state, player, bestIdx);
      } else {
        state.pendingSwitchTarget = player;
      }
      // After performSwitch (sync) the outgoing is at pl.bench[length-1].
      // For human path we set pending switch target — heal will be applied
      // when they pick. Simplification: heal NOW for AI; for human, schedule
      // in a tag. Simpler: heal whichever is at the end of bench AFTER the
      // sync switch. For human, the heal will happen later via the pending
      // resolver — but to keep this self-contained, we apply the heal only
      // for AI. (The human-path heal is a follow-up TODO.)
      if (pl.isAI) {
        const outgoing = pl.bench[pl.bench.length - 1];
        if (outgoing) {
          const before = outgoing.damage;
          outgoing.damage = Math.max(0, outgoing.damage - 80);
          if (outgoing.damage < before) outgoing.healedThisTurn = true;
          logEvent(
            state,
            player,
            `AZ's Tranquility: ${outgoingName} → bench, heals ${before - outgoing.damage}.`,
          );
        }
      } else {
        logEvent(state, player, "AZ's Tranquility: switch active with a Benched Pokémon (heal 80 follows).");
      }
      return;
    }

    case "philippeMetalEnergy": {
      // Supporter — attach up to 2 basic Metal Energy from discard to one
      // of your Metal Pokémon. Auto-pick first damaged Metal ally; AI
      // takes both energies if available.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allies.find((p) => p.card.types.includes("Metal"));
      if (!target) return;
      let attached = 0;
      for (let n = 0; n < 2; n++) {
        const idx = pl.discard.findIndex(
          (c) =>
            c.supertype === "Energy" &&
            c.subtypes.includes("Basic") &&
            (c as EnergyCard).provides.includes("Metal"),
        );
        if (idx < 0) break;
        const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
        target.attachedEnergy.push(en);
        attached++;
      }
      if (attached > 0) {
        logEvent(state, player, `Philippe: attaches ${attached} Metal Energy to ${target.card.name}.`);
      }
      return;
    }

    case "roxiesPerformance": {
      // Supporter — set a turn-scoped flag on YOU; consulted by the opp's
      // retreat() to block retreating any Poisoned opp Pokémon.
      (pl as PlayerState & { poisonedOppCantRetreatNextTurn?: boolean }).poisonedOppCantRetreatNextTurn = true;
      logEvent(state, player, "Roxie's Performance: opp's Poisoned Pokémon can't retreat next turn.");
      return;
    }

    case "emma": {
      // Supporter — look at opp hand, draw a card per Pokémon you find.
      // Auto-resolve (the look is cosmetic; the count drives the draw).
      const opp = state.players[oppId];
      const pokeCount = opp.hand.filter((c) => c.supertype === "Pokémon").length;
      let drawn = 0;
      for (let i = 0; i < pokeCount; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `Emma: opp hand has ${pokeCount} Pokémon — draws ${drawn}.`);
      return;
    }

    case "tomesOfTransformation": {
      // Item — text says "play 2 at once". Simplified: this is the
      // CONSUMING play; we additionally discard one extra Tomes from hand
      // (the second copy). Then perform the Basic-swap: choose a Basic
      // Pokémon from discard, and swap with one of your Basic Pokémon in
      // play. AI picks: discard's highest-HP Basic for play's most-damaged
      // (or lowest-HP) Basic.
      const otherIdx = pl.hand.findIndex((c) => c.name === "Tomes of Transformation");
      if (otherIdx < 0) {
        // Precheck should have blocked, but be safe.
        return;
      }
      const [other] = pl.hand.splice(otherIdx, 1);
      pl.discard.push(other);
      // Find a Basic Pokémon in discard.
      const discardBasicIdx = pl.discard.findIndex(
        (c) => c.supertype === "Pokémon" && c.subtypes.includes("Basic"),
      );
      if (discardBasicIdx < 0) return;
      const [discardCard] = pl.discard.splice(discardBasicIdx, 1) as [PokemonCard];
      // Find a Basic Pokémon in play (prefer the most-damaged one — the
      // swap preserves all attached cards / damage / status, so the new
      // shell can take a hit better than the old one if it has higher HP).
      const targets: Array<{ source: "active" | "bench"; idx: number; p: PokemonInPlay }> = [];
      if (pl.active && pl.active.card.subtypes.includes("Basic")) {
        targets.push({ source: "active", idx: -1, p: pl.active });
      }
      pl.bench.forEach((p, i) => {
        if (p.card.subtypes.includes("Basic")) targets.push({ source: "bench", idx: i, p });
      });
      if (targets.length === 0) {
        // Refund the discard pull (rare): put it back at the bottom of
        // discard so it isn't lost.
        pl.discard.push(discardCard);
        return;
      }
      let pick = targets[0];
      let bestDamage = pick.p.damage;
      for (const t of targets) {
        if (t.p.damage > bestDamage) {
          bestDamage = t.p.damage;
          pick = t;
        }
      }
      // Swap the card-shell while preserving attached / damage / status.
      const oldCard = pick.p.card;
      pick.p.card = discardCard;
      // The replaced card goes to the discard pile (replacing the slot we
      // pulled from).
      pl.discard.push(oldCard);
      logEvent(
        state,
        player,
        `Tomes of Transformation: ${oldCard.name} → ${discardCard.name} (preserves attached cards & damage).`,
      );
      return;
    }

    default:
      return;
  }
}

// -------- In-play target resolver ----------------------------------------

// Called by the UI when the user clicks an in-play Pokémon while a
// pendingInPlayTarget is active. Returns {ok:false, reason} if the click
// doesn't match the pending prompt. Mutates state to apply the effect.
export function resolveInPlayTarget(
  state: GameState,
  clicker: PlayerId,
  targetOwner: PlayerId,
  instanceId: string,
): { ok: boolean; reason?: string } {
  const pending = state.pendingInPlayTarget;
  if (!pending || pending.player !== clicker) {
    return { ok: false, reason: "No in-play target pending." };
  }

  const ownerPl = state.players[targetOwner];
  const isOpp = targetOwner !== clicker;

  // Scope check.
  if (pending.scope === "own" && isOpp) return { ok: false, reason: "Pick your own Pokémon." };
  if (pending.scope === "opp" && !isOpp) return { ok: false, reason: "Pick an opposing Pokémon." };

  // Find the target.
  let target: PokemonInPlay | null = null;
  let fromActive = false;
  if (ownerPl.active?.instanceId === instanceId) { target = ownerPl.active; fromActive = true; }
  else target = ownerPl.bench.find((p) => p.instanceId === instanceId) ?? null;
  if (!target) return { ok: false, reason: "Target not in play." };

  // Slot check.
  if (pending.slot === "active" && !fromActive) return { ok: false, reason: "Pick the Active Pokémon." };
  if (pending.slot === "bench" && fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };

  // Filter check.
  if (pending.filter === "hasTool" && target.tools.length === 0) {
    return { ok: false, reason: "That Pokémon has no Tool." };
  }
  if (pending.filter === "hasSpecialEnergy" &&
      !target.attachedEnergy.some((e) => e.subtypes.includes("Special"))) {
    return { ok: false, reason: "That Pokémon has no Special Energy." };
  }
  if (pending.filter === "hasAnyEnergy" && target.attachedEnergy.length === 0) {
    return { ok: false, reason: "That Pokémon has no Energy." };
  }
  if (
    pending.filter === "hasBasicEnergy" &&
    !target.attachedEnergy.some((e) => e.subtypes.includes("Basic"))
  ) {
    return { ok: false, reason: "That Pokémon has no basic Energy." };
  }
  if (pending.filter === "isBasic" && !target.card.subtypes.includes("Basic")) {
    return { ok: false, reason: "Must pick a Basic Pokémon." };
  }

  const oppId: PlayerId = clicker === "p1" ? "p2" : "p1";
  const clickerPl = state.players[clicker];

  switch (pending.action.kind) {
    case "crispinAttachEnergy": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      target.attachedEnergy.push(pending.action.energy);
      logEvent(state, clicker, `Crispin: attaches ${pending.action.energy.name} to ${target.card.name}.`);
      enforceSpecialEnergyAttachRules(state);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "enhancedHammer": {
      const idx = target.attachedEnergy.findIndex((e) => e.subtypes.includes("Special"));
      if (idx < 0) return { ok: false, reason: "No Special Energy on target." };
      const [e] = target.attachedEnergy.splice(idx, 1);
      state.players[oppId].discard.push(e);
      logEvent(state, clicker, `discards ${e.name} from ${target.card.name}.`);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "crushingHammer": {
      if (target.attachedEnergy.length === 0) return { ok: false, reason: "No Energy on target." };
      const [e] = target.attachedEnergy.splice(0, 1);
      state.players[oppId].discard.push(e);
      logEvent(state, clicker, `discards ${e.name} from ${target.card.name}.`);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "pokemonCatcher": {
      const opp = state.players[oppId];
      if (!opp.active || fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      const idx = opp.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) return { ok: false, reason: "Target not in bench." };
      const r = performGust(state, oppId, idx);
      if (r) logEvent(state, clicker, `gusts ${r.pulled.card.name} into the Active spot.`);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "toolScrapper": {
      if (target.tools.length === 0) return { ok: false, reason: "No Tool." };
      const [tool] = target.tools.splice(0, 1);
      state.players[targetOwner].discard.push(tool);
      logEvent(state, clicker, `discards ${tool.name} from ${target.card.name}.`);
      const remaining = pending.action.remaining - 1;
      // Are there any Tools still in play?
      const anyLeft = (["p1", "p2"] as PlayerId[]).some((pid) => {
        const p = state.players[pid];
        return (p.active?.tools.length ?? 0) > 0 || p.bench.some((b) => b.tools.length > 0);
      });
      if (remaining > 0 && anyLeft) {
        state.pendingInPlayTarget = {
          ...pending,
          action: { kind: "toolScrapper", remaining },
        };
      } else {
        state.pendingInPlayTarget = null;
      }
      return { ok: true };
    }
    case "heavyBaton": {
      // Target is a benched ally to transfer Energy to.
      // Find the KO'd Pokémon via source instanceId — but KO is already
      // resolved, so source is gone. Heavy Baton is resolved inline in
      // knockOut() now; this branch exists for parity when we add the pick.
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "scoopUpCyclone": {
      const idx = clickerPl.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) return { ok: false, reason: "Pick from your bench." };
      const [t] = clickerPl.bench.splice(idx, 1);
      clickerPl.hand.push(t.card, ...t.evolvedFrom, ...t.attachedEnergy, ...t.tools);
      logEvent(state, clicker, `returns ${t.card.name} and attached cards to hand.`);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "lisiasAppeal": {
      const opp = state.players[oppId];
      if (!opp.active) return { ok: false, reason: "Opponent has no Active." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      if (!target.card.subtypes.includes("Basic")) return { ok: false, reason: "Must be a Basic." };
      const idx = opp.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) return { ok: false, reason: "Target not in bench." };
      const r = performGust(state, oppId, idx);
      if (r) {
        if (!r.pulled.statuses.includes("confused")) r.pulled.statuses.push("confused");
        logEvent(state, clicker, `gusts ${r.pulled.card.name} to Active; it is now Confused.`);
      }
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "nPlanEnergySource": {
      if (!clickerPl.active) return { ok: false, reason: "No Active to move Energy to." };
      if (isOpp || fromActive) return { ok: false, reason: "Pick a Benched Pokémon of yours." };
      if (target.attachedEnergy.length === 0) return { ok: false, reason: "No Energy on target." };
      const [e] = target.attachedEnergy.splice(0, 1);
      clickerPl.active.attachedEnergy.push(e);
      logEvent(state, clicker, `moves ${e.name} from ${target.card.name} to ${clickerPl.active.card.name}.`);
      enforceSpecialEnergyAttachRules(state);
      const remaining = pending.action.remaining - 1;
      const anyLeft = clickerPl.bench.some((b) => b.attachedEnergy.length > 0);
      if (remaining > 0 && anyLeft) {
        state.pendingInPlayTarget = { ...pending, action: { kind: "nPlanEnergySource", remaining } };
      } else {
        state.pendingInPlayTarget = null;
      }
      return { ok: true };
    }
    case "energySwitchSource": {
      // First step — user picked the SOURCE ally. Validate and move to the
      // destination-picker step, storing the source instance id.
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (!target.attachedEnergy.some((e) => e.subtypes.includes("Basic"))) {
        return { ok: false, reason: "That Pokémon has no basic Energy to move." };
      }
      state.pendingInPlayTarget = {
        player: clicker,
        label: `Energy Switch: pick the Pokémon to move a Basic Energy TO (from ${target.card.name})`,
        scope: "own",
        slot: "anywhere",
        filter: "anyPokemon",
        action: { kind: "energySwitchDest", sourceInstanceId: target.instanceId },
      };
      return { ok: true };
    }
    case "energySwitchDest": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      const srcId = pending.action.sourceInstanceId;
      if (instanceId === srcId) {
        return { ok: false, reason: "Pick a different Pokémon than the source." };
      }
      const source = clickerPl.active?.instanceId === srcId
        ? clickerPl.active
        : clickerPl.bench.find((p) => p.instanceId === srcId);
      if (!source) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Source Pokémon is no longer in play." };
      }
      const eIdx = source.attachedEnergy.findIndex((e) => e.subtypes.includes("Basic"));
      if (eIdx < 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Source has no basic Energy to move." };
      }
      const [en] = source.attachedEnergy.splice(eIdx, 1);
      target.attachedEnergy.push(en);
      logEvent(
        state,
        clicker,
        `Energy Switch: moves ${en.name} from ${source.card.name} to ${target.card.name}.`,
      );
      enforceSpecialEnergyAttachRules(state);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "wallysCompassion": {
      // Must target one of YOUR damaged Mega Evolution Pokémon ex.
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      const subs = target.card.subtypes ?? [];
      const isMegaEx =
        subs.some((s) => /^MEGA$/i.test(s) || /^Mega /.test(s)) &&
        subs.includes("ex");
      if (!isMegaEx) return { ok: false, reason: "Must be a Mega Evolution Pokémon ex." };
      if (target.damage === 0) return { ok: false, reason: "That Pokémon has no damage to heal." };
      const before = target.damage;
      target.damage = 0;
      if (target.attachedEnergy.length > 0) {
        clickerPl.hand.push(...target.attachedEnergy);
        target.attachedEnergy = [];
      }
      logEvent(
        state,
        clicker,
        `Wally's Compassion: heals ${before} from ${target.card.name} and returns its Energy to hand.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "jacintheHeal": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (!target.card.types.includes("Psychic")) {
        return { ok: false, reason: "Must be a Psychic Pokémon." };
      }
      if (target.damage === 0) return { ok: false, reason: "That Pokémon has no damage to heal." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - 150);
      logEvent(
        state,
        clicker,
        `Jacinthe: heals ${before - target.damage} from ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "pokeVitalAHeal": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (target.damage === 0) return { ok: false, reason: "That Pokémon has no damage to heal." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - 150);
      logEvent(
        state,
        clicker,
        `Poké Vital A: heals ${before - target.damage} from ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "potionHeal": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (target.damage === 0) return { ok: false, reason: "That Pokémon has no damage to heal." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - 30);
      logEvent(
        state,
        clicker,
        `Potion: heals ${before - target.damage} from ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "superPotionHeal": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (target.damage === 0) return { ok: false, reason: "That Pokémon has no damage to heal." };
      if (target.attachedEnergy.length === 0)
        return { ok: false, reason: "Must have an Energy attached to discard." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - 60);
      const healed = before - target.damage;
      if (healed > 0) {
        const e = target.attachedEnergy.shift();
        if (e) clickerPl.discard.push(e);
      }
      logEvent(
        state,
        clicker,
        `Super Potion: heals ${healed} from ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "wondrousPatchAttach": {
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      if (!target.card.types.includes("Psychic")) {
        return { ok: false, reason: "Must be a Psychic Pokémon." };
      }
      const energyIdx = clickerPl.discard.findIndex(
        (c) => isBasicEnergy(c) && (c as EnergyCard).provides.includes("Psychic"),
      );
      if (energyIdx < 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "No Basic Psychic Energy in discard." };
      }
      const [e] = clickerPl.discard.splice(energyIdx, 1) as [EnergyCard];
      target.attachedEnergy.push(e);
      logEvent(
        state,
        clicker,
        `Wondrous Patch: attaches ${e.name} to ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "abilityMoveDamage": {
      // Munkidori-style: source has been pre-picked as the most-damaged ally;
      // target is whatever opp Pokémon the player just clicked.
      const counters = pending.action.counters;
      const sourceId = pending.action.sourceInstanceId;
      let source: PokemonInPlay | null = null;
      if (clickerPl.active?.instanceId === sourceId) source = clickerPl.active;
      else source = clickerPl.bench.find((p) => p.instanceId === sourceId) ?? null;
      if (!source) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Source Pokémon is no longer in play." };
      }
      const moved = Math.min(counters, Math.floor(source.damage / 10));
      if (moved <= 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "No counters left to move." };
      }
      source.damage -= moved * 10;
      target.damage += moved * 10;
      logEvent(
        state,
        clicker,
        `uses ${pending.action.abilityName}: moves ${moved} damage counter(s) from ${source.card.name} to ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      knockOutFromAbilityCounters(state, targetOwner, target);
      return { ok: true };
    }
    case "distributeDamage": {
      // Each click delivers `perHit` damage to the chosen opp Pokémon.
      // Decrement remaining; close the picker when we run out.
      const action = pending.action;
      const isBench = state.players[targetOwner].bench.includes(target);
      // Bench-protection auras can still deflect the chip.
      if (isBench && benchDamageBlocked(state)) {
        logEvent(state, "system", `Battle Cage protects ${target.card.name}.`);
      } else if (isBench && benchDamageBlockedByFlowerCurtain(state, targetOwner, target)) {
        logEvent(state, "system", `Flower Curtain protects ${target.card.name}.`);
      } else {
        target.damage += action.perHit;
        logEvent(
          state,
          clicker,
          `${action.attackName}: ${target.card.name} takes ${action.perHit} damage.`,
        );
      }
      const remaining = action.remaining - 1;
      if (remaining > 0) {
        state.pendingInPlayTarget = {
          ...pending,
          // Same per-click wording the picker opened with — `formatPickerLabel`
          // appends the "— N left" progress so the player can see how many
          // clicks remain. Saying "click to place X damage" up front prevents
          // the "did the engine just auto-apply everything?" misread.
          label: `${action.attackName}: click an opp ${pending.slot === "bench" ? "Benched Pokémon" : "Pokémon"} to place ${action.perHit} damage`,
          action: { ...action, remaining },
        };
      } else {
        state.pendingInPlayTarget = null;
      }
      knockOutFromAbilityCounters(state, targetOwner, target);
      if (remaining <= 0 && action.finishTurn && state.phase !== "gameOver") {
        if (state.pendingPromote) {
          state.phase = "promoteActive";
          state.onPromoteResolved = "endTurn";
        } else {
          endTurnRule(state);
        }
      }
      return { ok: true };
    }
    case "heavyBatonPick": {
      // Stashed energies from the KO'd holder land on the clicked Bench
      // Pokémon all at once. Picker is single-click — close immediately.
      const stash = state.pendingHeavyBaton;
      if (!stash) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "No Heavy Baton energies pending." };
      }
      target.attachedEnergy.push(...stash.energies);
      logEvent(
        state,
        clicker,
        `Heavy Baton: ${stash.energies.length} Energy → ${target.card.name}.`,
      );
      state.pendingHeavyBaton = null;
      state.pendingInPlayTarget = null;
      // Resume the queued post-promote continuation now that the picker
      // resolved. Mirrors the tail of promoteBenchToActive — endTurn /
      // passTurn live in rules.ts; secondAttack is in actions.ts and
      // resolved via lazy require to avoid the trainerEffects↔actions
      // module cycle that a top-level import would create.
      const cont = state.onPromoteResolved;
      state.onPromoteResolved = null;
      if (cont === "endTurn") {
        endTurnRule(state);
      } else if (cont === "passTurn") {
        passTurn(state);
      } else if (cont === "secondAttack") {
        // ESM cycle: `actions` already imports `applyTrainerEffect` from
        // this file at module load. Importing `resumeSecondAttack` back
        // works because the binding is resolved at call time, not at
        // load time.
        resumeSecondAttack(state);
      }
      return { ok: true };
    }
    case "attachEnergyFromDiscardPicker": {
      // Aura Jab et al. — pull a matching basic Energy out of discard, attach
      // to the clicked Bench Pokémon, decrement remaining. Close picker
      // when the count hits 0 or no matching Energy is left in discard.
      const action = pending.action;
      const idx = clickerPl.discard.findIndex(
        (c) =>
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(action.energyType),
      );
      if (idx < 0) {
        state.pendingInPlayTarget = null;
        logEvent(state, clicker, `${action.attackName}: no more ${action.energyType} Energy in discard.`);
        if (action.finishTurn && state.phase !== "gameOver") endTurnRule(state);
        return { ok: true };
      }
      const [en] = clickerPl.discard.splice(idx, 1) as [EnergyCard];
      target.attachedEnergy.push(en);
      logEvent(
        state,
        clicker,
        `${action.attackName}: attaches ${en.name} to ${target.card.name}.`,
      );
      const remaining = action.remaining - 1;
      const stillAvailable = clickerPl.discard.some(
        (c) =>
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(action.energyType),
      );
      if (remaining > 0 && stillAvailable) {
        state.pendingInPlayTarget = {
          ...pending,
          label: `${action.attackName}: pick a Bench Pokémon to attach a ${action.energyType} Energy from discard (${remaining} left)`,
          action: { ...action, remaining },
        };
      } else {
        state.pendingInPlayTarget = null;
        if (action.finishTurn && state.phase !== "gameOver") endTurnRule(state);
      }
      return { ok: true };
    }
    case "abilityCursedBlast": {
      // Place counters, KO target if applicable, then self-KO the holder.
      const counters = pending.action.counters;
      const holderId = pending.action.holderInstanceId;
      const ownerId = pending.action.ownerId;
      const ownerPlState = state.players[ownerId];
      let holder: PokemonInPlay | null = null;
      if (ownerPlState.active?.instanceId === holderId) holder = ownerPlState.active;
      else holder = ownerPlState.bench.find((p) => p.instanceId === holderId) ?? null;
      if (!holder) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Ability holder is no longer in play." };
      }
      target.damage += counters * 10;
      logEvent(
        state,
        clicker,
        `uses ${pending.action.abilityName}: puts ${counters} counters on ${target.card.name}.`,
      );
      state.pendingInPlayTarget = null;
      knockOutFromAbilityCounters(state, targetOwner, target);
      // Self-KO the holder regardless of whether the target's KO ended the
      // game — checking phase keeps us idempotent.
      if (state.phase !== "gameOver") {
        holder.damage = 9999;
        knockOutFromAbilityCounters(state, ownerId, holder);
      }
      return { ok: true };
    }
    case "sendFlowersAttach": {
      // Shaymin "Send Flowers" first step — player clicked a Benched
      // Pokémon of the right type. Stash the instance, close the in-play
      // picker, open a deck-search-pick that auto-routes the chosen Energy
      // onto that target via `attachToInstanceId`.
      const ownerId = clicker;
      if (targetOwner !== ownerId) {
        return { ok: false, reason: "Pick one of your own Benched Pokémon." };
      }
      const ownerPlState = state.players[ownerId];
      const isOnBench = ownerPlState.bench.some((p) => p.instanceId === instanceId);
      if (!isOnBench) {
        return { ok: false, reason: "Pick a Benched target." };
      }
      const targetType = pending.action.pokemonType;
      if (!target.card.types.some((t) => t === targetType)) {
        return { ok: false, reason: `Target must be a ${targetType} Pokémon.` };
      }
      const attackName = pending.action.attackName;
      state.pendingInPlayTarget = null;
      // Open the energy deck-search; on resolve the Energy auto-routes to
      // the stashed bench instance via attachToInstanceId.
      const ok = setDeckSearchPick(
        state,
        ownerId,
        (c) => c.supertype === "Energy",
        1,
        `${attackName}: pick an Energy to attach to ${target.card.name}`,
        { attachToInstanceId: instanceId },
      );
      if (!ok) {
        logEvent(state, ownerId, `${attackName}: no Energy in deck.`);
      }
      return { ok: true };
    }
    case "abilityAttachEnergyFromDiscard": {
      // Blaziken ex Seething Spirit + similar — the player picked which of
      // their own Pokémon receives the basic Energy from discard.
      const ownerId = pending.action.ownerId;
      if (targetOwner !== ownerId) {
        return { ok: false, reason: "Pick one of your own Pokémon." };
      }
      const ownerPlState = state.players[ownerId];
      const idx = pending.action.energyIndexInDiscard;
      // The discard index may have shifted if the discard was mutated between
      // when we stashed it and now. Re-find a Basic energy if needed.
      let energy: import("./types").EnergyCard | null = null;
      const inDiscard = ownerPlState.discard[idx];
      if (
        inDiscard &&
        inDiscard.supertype === "Energy" &&
        inDiscard.subtypes.includes("Basic")
      ) {
        energy = ownerPlState.discard.splice(idx, 1)[0] as import("./types").EnergyCard;
      } else {
        const fallback = ownerPlState.discard.findIndex(
          (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
        );
        if (fallback < 0) {
          state.pendingInPlayTarget = null;
          return { ok: false, reason: "No basic Energy in discard." };
        }
        energy = ownerPlState.discard.splice(fallback, 1)[0] as import("./types").EnergyCard;
      }
      target.attachedEnergy.push(energy);
      logEvent(
        state,
        clicker,
        `uses ${pending.action.abilityName}: attaches ${energy.name} to ${target.card.name} from discard.`,
      );
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "primeCatcherGust": {
      // Step 1: gust the clicked opp Bench Pokémon. Then chain into the
      // optional self-switch picker if own bench has any Pokémon.
      if (!isOpp) return { ok: false, reason: "Pick an opposing Pokémon." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      const opp = state.players[targetOwner];
      const idx = opp.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Target not on opp Bench." };
      }
      const r = performGust(state, targetOwner, idx);
      if (r) logEvent(state, clicker, `Prime Catcher: gusts ${r.pulled.card.name} to Active.`);
      // Optional step 2: self-switch. Only open if own bench has anyone.
      if (clickerPl.bench.length > 0) {
        state.pendingInPlayTarget = {
          player: clicker,
          label: "Prime Catcher: optionally pick one of your Bench Pokémon to swap with your Active (or skip)",
          scope: "own",
          slot: "bench",
          filter: "anyPokemon",
          action: { kind: "primeCatcherSelfSwitch" },
        };
      } else {
        state.pendingInPlayTarget = null;
      }
      return { ok: true };
    }
    case "primeCatcherSelfSwitch": {
      // Step 2: swap Active with the clicked Bench Pokémon. Optional —
      // see `skipPrimeCatcherSelfSwitch` for the skip path.
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      const idx = clickerPl.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Target not on your Bench." };
      }
      performSwitch(state, clicker, idx);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "surfingBeachSwitch": {
      // Surfing Beach: bench target must be Water-typed.
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      if (!target.card.types.includes("Water")) {
        return { ok: false, reason: "Surfing Beach: must pick a Water-type Pokémon." };
      }
      const idx = clickerPl.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Target not on your Bench." };
      }
      const incoming = clickerPl.bench.splice(idx, 1)[0];
      const outgoing = clickerPl.active!;
      // Switch rule: outgoing recovers from all Special Conditions.
      outgoing.statuses = [];
      clickerPl.active = incoming;
      clickerPl.bench.push(outgoing);
      logEvent(
        state,
        clicker,
        `Surfing Beach: switches ${outgoing.card.name} → ${incoming.card.name}.`,
      );
      fireTriggeredOnMoveToActive(state, clicker, incoming);
      fireTriggeredOnMoveToBench(state, clicker, outgoing);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "glassTrumpetAttach": {
      // Each click attaches one queued Energy to the clicked Bench
      // Colorless Pokémon. The card text "to each of them" forbids the
      // same target receiving multiple Energy in one resolution, so we
      // track previously-picked instance IDs and reject duplicates.
      // Closes when the queue empties; player can also skip remaining
      // attachments via `skipGlassTrumpetAttach` (queued Energy returns
      // to discard).
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      if (!target.card.types.includes("Colorless")) {
        return { ok: false, reason: "Glass Trumpet: target must be a Colorless Pokémon." };
      }
      const action = pending.action;
      if (action.pickedInstanceIds.includes(target.instanceId)) {
        return {
          ok: false,
          reason: "Glass Trumpet: that Pokémon already received an Energy this resolution.",
        };
      }
      const queue = state.pendingAttachQueue;
      if (!queue || queue.energies.length === 0) {
        state.pendingAttachQueue = null;
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "No queued Energy to attach." };
      }
      const energy = queue.energies.shift()!;
      target.attachedEnergy.push(energy);
      logEvent(
        state,
        clicker,
        `Glass Trumpet: attaches ${energy.name} to ${target.card.name}.`,
      );
      enforceSpecialEnergyAttachRules(state);
      const nextPicked = [...action.pickedInstanceIds, target.instanceId];
      if (queue.energies.length === 0) {
        state.pendingAttachQueue = null;
        state.pendingInPlayTarget = null;
      } else {
        state.pendingInPlayTarget = {
          player: clicker,
          label: `Glass Trumpet: pick a Benched Colorless Pokémon to attach ${queue.energies[0].name}`,
          scope: "own",
          slot: "bench",
          filter: "anyPokemon",
          action: {
            kind: "glassTrumpetAttach",
            remaining: queue.energies.length,
            pickedInstanceIds: nextPicked,
          },
        };
      }
      return { ok: true };
    }
    case "handheldFanPick": {
      // Defender resolves — the click target lives on the attacker's bench.
      // Move 1 Energy from the attacker's Active to the clicked bench.
      const fan = state.pendingHandheldFan;
      if (!fan || fan.defenderId !== clicker) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Handheld Fan: no pending pick." };
      }
      if (targetOwner !== fan.attackerSideId) {
        return { ok: false, reason: "Pick a Benched Pokémon on the opponent's side." };
      }
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      const attackerSide = state.players[fan.attackerSideId];
      if (!attackerSide.active || attackerSide.active.attachedEnergy.length === 0) {
        // Attacker's Active is gone or has no energy — nothing to move.
        state.pendingHandheldFan = null;
        state.pendingInPlayTarget = null;
        if (state.phase !== "gameOver") endTurnRule(state);
        return { ok: true };
      }
      const idx = attackerSide.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) {
        return { ok: false, reason: "Target not on the attacker's Bench." };
      }
      const en = attackerSide.active.attachedEnergy.shift()!;
      attackerSide.bench[idx].attachedEnergy.push(en);
      logEvent(
        state,
        clicker,
        `Handheld Fan: ${en.name} moves from ${attackerSide.active.card.name} to ${attackerSide.bench[idx].card.name}.`,
      );
      enforceSpecialEnergyAttachRules(state);
      state.pendingHandheldFan = null;
      state.pendingInPlayTarget = null;
      // Resume the deferred attacker turn-end.
      if (state.phase !== "gameOver") endTurnRule(state);
      return { ok: true };
    }
    case "scrambleSwitchTarget": {
      // Step 1: switch the chosen Bench Pokémon into the Active spot.
      // APPROXIMATION: card text says "you may move any amount of Energy"
      // from the previous Active. This implementation always moves all
      // Energy (matches the prior behavior and covers the dominant
      // strategic case). Granular per-Energy choice is deferred — see
      // docs/ITEM_AUDIT.md.
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (fromActive) return { ok: false, reason: "Pick a Benched Pokémon." };
      const idx = clickerPl.bench.findIndex((p) => p.instanceId === instanceId);
      if (idx < 0) {
        state.pendingInPlayTarget = null;
        return { ok: false, reason: "Target not on your Bench." };
      }
      performSwitch(state, clicker, idx);
      const prev = clickerPl.bench[clickerPl.bench.length - 1];
      if (clickerPl.active && prev) {
        clickerPl.active.attachedEnergy.push(...prev.attachedEnergy);
        prev.attachedEnergy = [];
        logEvent(state, clicker, `Scramble Switch: transfers Energy to ${clickerPl.active.card.name}.`);
      }
      enforceSpecialEnergyAttachRules(state);
      state.pendingInPlayTarget = null;
      return { ok: true };
    }
    case "grandTreeBasicTarget": {
      // Step 1: capture the chosen Basic instance ID, then open a deck
      // search for a matching Stage 1. The `targetInstanceId` flows
      // through to the afterPick callback so the evolution applies to
      // the same chosen ally rather than a re-found first-match.
      if (isOpp) return { ok: false, reason: "Pick one of your own Pokémon." };
      if (!target.card.subtypes.includes("Basic")) {
        return { ok: false, reason: "Pick a Basic Pokémon." };
      }
      if (target.playedThisTurn || target.evolvedThisTurn) {
        return { ok: false, reason: "That Pokémon can't evolve this turn." };
      }
      const basicName = target.card.name;
      const targetInstanceId = target.instanceId;
      const stage1Pred = (c: import("./types").Card) =>
        c.supertype === "Pokémon" &&
        (c.subtypes ?? []).includes("Stage 1") &&
        (c as import("./types").PokemonCard).evolvesFrom === basicName;
      state.pendingInPlayTarget = null;
      if (!setDeckSearchPick(
        state, clicker, stage1Pred, 1,
        `Grand Tree: pick a Stage 1 that evolves from ${basicName}`,
        {
          min: 1,
          afterPick: { kind: "grandTreeApplyStage1", targetInstanceId },
          effectKind: "grandTreeStage1",
        },
      )) {
        logEvent(state, clicker, "Grand Tree: no matching Stage 1 in deck.");
      }
      return { ok: true };
    }
  }
}

// Skip the optional Prime Catcher self-switch step. The gust already
// applied; this just clears the pending picker. Replay-recorded as an
// explicit `skipPrimeCatcherSelfSwitch` GameCommand so exports don't stall
// on the optional prompt.
export function skipPrimeCatcherSelfSwitch(
  state: GameState,
  player: PlayerId,
): { ok: boolean; reason?: string } {
  const pending = state.pendingInPlayTarget;
  if (!pending || pending.player !== player) {
    return { ok: false, reason: "No Prime Catcher self-switch pending." };
  }
  if (pending.action.kind !== "primeCatcherSelfSwitch") {
    return { ok: false, reason: "Pending action is not Prime Catcher's self-switch." };
  }
  state.pendingInPlayTarget = null;
  logEvent(state, player, "Prime Catcher: skips self-switch.");
  return { ok: true };
}

// Stop attaching at the current Glass Trumpet step. Any queued Energy that
// hasn't been attached yet returns to the player's discard pile (it never
// transited the hand, so "returns" matches the card text). Replay-recorded
// as `skipGlassTrumpetAttach` so exports don't stall mid-attach.
export function skipGlassTrumpetAttach(
  state: GameState,
  player: PlayerId,
): { ok: boolean; reason?: string } {
  const pending = state.pendingInPlayTarget;
  if (!pending || pending.player !== player) {
    return { ok: false, reason: "No Glass Trumpet attach pending." };
  }
  if (pending.action.kind !== "glassTrumpetAttach") {
    return { ok: false, reason: "Pending action is not Glass Trumpet's attach step." };
  }
  const queue = state.pendingAttachQueue;
  if (queue) {
    state.players[queue.ownerId].discard.push(...queue.energies);
    state.pendingAttachQueue = null;
  }
  state.pendingInPlayTarget = null;
  logEvent(state, player, "Glass Trumpet: stops attaching.");
  return { ok: true };
}

// Cancel a pending in-play target (user backed out / the UI dismissed it).
// We don't refund the trainer card — that's already been discarded — but we
// clear the prompt so the game can continue. Some effects leave state partially
// applied (e.g. Crushing Hammer's coin flip already happened); that's fine.
//
// Special-cased prompts:
//   * glassTrumpetAttach — its attach queue carries Energy cards pulled from
//     discard; route through the explicit skip so queued Energy returns to
//     discard rather than leaking.
//   * crispinAttachEnergy — the picked Energy was pulled out of hand at chain
//     time and stored ONLY on the prompt. Cancelling without rehoming would
//     leak the card. Return it to hand before clearing the prompt.
//   * primeCatcherSelfSwitch — optional second step; cancellation is the
//     "skip" intent. Route through skipPrimeCatcherSelfSwitch so exported
//     replays record an explicit skip command instead of stalling.
export function cancelInPlayTarget(state: GameState): void {
  const pending = state.pendingInPlayTarget;
  if (!pending) return;
  if (pending.action.kind === "glassTrumpetAttach") {
    skipGlassTrumpetAttach(state, pending.player);
    return;
  }
  if (pending.action.kind === "crispinAttachEnergy") {
    state.players[pending.player].hand.push(pending.action.energy);
    logEvent(state, pending.player, `Crispin: returns ${pending.action.energy.name} to hand.`);
    state.pendingInPlayTarget = null;
    return;
  }
  if (pending.action.kind === "primeCatcherSelfSwitch") {
    skipPrimeCatcherSelfSwitch(state, pending.player);
    return;
  }
  state.pendingInPlayTarget = null;
}

// -------- Hand-reveal resolver -------------------------------------------

function handCardMatches(c: Card, filter: "item" | "tool" | "itemOrTool" | "supporter" | "pokemon" | "energy" | "any"): boolean {
  if (filter === "any") return true;
  if (filter === "pokemon") return c.supertype === "Pokémon";
  if (filter === "energy") return c.supertype === "Energy";
  if (c.supertype !== "Trainer") return false;
  const subs = c.subtypes ?? [];
  switch (filter) {
    case "item":
      return subs.includes("Item");
    case "tool":
      return subs.includes("Pokémon Tool") || subs.includes("Tool");
    case "itemOrTool":
      return subs.includes("Item") || subs.includes("Pokémon Tool") || subs.includes("Tool");
    case "supporter":
      return subs.includes("Supporter");
  }
}

// Called by the UI when the initiator confirms their selection from the
// revealed hand. `indexes` are positions into `state.players[target].hand`.
export function resolveHandReveal(
  state: GameState,
  clicker: PlayerId,
  indexes: number[],
): { ok: boolean; reason?: string } {
  const pending = state.pendingHandReveal;
  if (!pending || pending.player !== clicker) {
    return { ok: false, reason: "No hand-reveal pending." };
  }
  const uniq = [...new Set(indexes)].sort((a, b) => a - b);
  if (uniq.length > pending.max) return { ok: false, reason: `Pick at most ${pending.max}.` };
  if (uniq.length < pending.min) return { ok: false, reason: `Pick at least ${pending.min}.` };
  const targetPl = state.players[pending.target];
  for (const i of uniq) {
    if (i < 0 || i >= targetPl.hand.length) return { ok: false, reason: "Invalid index." };
    if (!handCardMatches(targetPl.hand[i], pending.filter)) {
      return { ok: false, reason: `Card at ${i} doesn't match filter.` };
    }
  }
  // Pull cards out in descending order so index positions stay valid.
  const picked: Card[] = [];
  for (const i of uniq.slice().reverse()) picked.unshift(targetPl.hand.splice(i, 1)[0]);

  if (pending.action === "discard") {
    targetPl.discard.push(...picked);
    logEvent(state, clicker, picked.length
      ? `discards ${picked.map((c) => c.name).join(", ")} from ${targetPl.name}'s hand.`
      : `finds nothing to discard in ${targetPl.name}'s hand.`);
  } else if (pending.action === "toTopOfDeck") {
    targetPl.deck.unshift(...picked);
    logEvent(state, clicker, picked.length
      ? `puts ${picked.map((c) => c.name).join(", ")} on top of ${targetPl.name}'s deck.`
      : `puts nothing on top of ${targetPl.name}'s deck.`);
  } else {
    // toBottomOfDeck
    targetPl.deck.push(...picked);
    logEvent(state, clicker, picked.length
      ? `puts ${picked.map((c) => c.name).join(", ")} on the bottom of ${targetPl.name}'s deck.`
      : `puts nothing from ${targetPl.name}'s hand on the bottom of their deck.`);
  }
  const postAction = pending.postAction;
  state.pendingHandReveal = null;
  if (postAction?.kind === "drawUntilHand") {
    const clickerPl = state.players[clicker];
    const toDraw = Math.max(0, postAction.targetSize - clickerPl.hand.length);
    if (toDraw > 0) drawUpTo(state, clicker, toDraw);
  } else if (postAction?.kind === "drawCards") {
    drawUpTo(state, clicker, postAction.count);
  } else if (postAction?.kind === "searchDeckAnyPokemon") {
    // Perrin: "search for the SAME number of Pokémon" — cap by actual reveal
    // count, not the upfront max. Other callers (Ultra Ball etc.) use the
    // fixed max because they always search the full count regardless of
    // what was revealed.
    const searchMax = postAction.useRevealedCount
      ? Math.min(postAction.max, picked.length)
      : postAction.max;
    if (searchMax > 0) {
      if (!setDeckSearchPick(state, clicker, isPokemonCard, searchMax, postAction.label)) {
        logEvent(state, clicker, "finds no Pokémon.");
      }
    }
  } else if (postAction?.kind === "secretBoxStartItemSearch") {
    const isItemOnly = (c: Card) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Item") &&
      !(c.subtypes ?? []).includes("Pokémon Tool") &&
      !(c.subtypes ?? []).includes("Tool");
    if (
      !setDeckSearchPick(state, clicker, isItemOnly, 1, "Secret Box (1 of 4): pick an Item", {
        postResolveChain: { kind: "secret-box-tool" },
      })
    ) {
      logEvent(state, clicker, "Secret Box: no Item in deck.");
    }
  }
  return { ok: true };
}

// AI initiator auto-resolves the reveal by taking the first `max` matches.
export function resolveAiHandReveal(state: GameState): boolean {
  const pending = state.pendingHandReveal;
  if (!pending) return false;
  const targetPl = state.players[pending.target];
  const eligible: number[] = [];
  targetPl.hand.forEach((c, i) => {
    if (eligible.length < pending.max && handCardMatches(c, pending.filter)) eligible.push(i);
  });
  resolveHandReveal(state, pending.player, eligible);
  return true;
}

export function cancelHandReveal(state: GameState): void {
  state.pendingHandReveal = null;
}

// -------- Rare Candy chooser resolver ------------------------------------

export function resolveRareCandyChoice(
  state: GameState,
  clicker: PlayerId,
  handIndex: number,
): { ok: boolean; reason?: string } {
  const pending = state.pendingRareCandyChoice;
  if (!pending || pending.player !== clicker) {
    return { ok: false, reason: "No Rare Candy pending." };
  }
  const pl = state.players[clicker];
  const card = pl.hand[handIndex];
  if (!card || card.supertype !== "Pokémon" || !card.subtypes.includes("Stage 2") || !card.evolvesFrom) {
    return { ok: false, reason: "Pick a Stage 2 Pokémon from your hand." };
  }
  const basic = (() => {
    if (pl.active?.instanceId === pending.targetInstanceId) return pl.active;
    return pl.bench.find((p) => p.instanceId === pending.targetInstanceId) ?? null;
  })();
  if (!basic) {
    // Target left play — abort gracefully.
    state.pendingRareCandyChoice = null;
    return { ok: false, reason: "Target is no longer in play." };
  }
  // Check this Stage 2 actually evolves (via its Stage 1) from the Basic.
  const stage1 = findByName(card.evolvesFrom);
  if (!stage1 || stage1.supertype !== "Pokémon" || stage1.evolvesFrom !== basic.card.name) {
    return { ok: false, reason: "That Stage 2 doesn't evolve from this Pokémon." };
  }
  pl.hand.splice(handIndex, 1);
  basic.evolvedFrom.push(basic.card);
  basic.card = card as PokemonCard;
  applyEvolveSideEffects(state, basic);
  logEvent(state, clicker, `uses Rare Candy to evolve into ${card.name}.`);
  fireTriggeredOnEvolve(state, clicker, basic);
  state.pendingRareCandyChoice = null;
  return { ok: true };
}

export function cancelRareCandyChoice(state: GameState): void {
  state.pendingRareCandyChoice = null;
}
