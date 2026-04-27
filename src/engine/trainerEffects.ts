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

import { enforceSpecialEnergyAttachRules, logEvent, makePokemonInPlay, newInstanceId } from "./rules";
import { clearAllStatuses } from "./rules";
import {
  fireTriggeredOnEvolve,
  fireTriggeredOnMoveToActive,
  fireTriggeredOnMoveToBench,
} from "./abilities";
import { findByName } from "../data/cards";
import {
  setDeckSearchPick,
  setDiscardRecoveryPick,
  setTopPeekPick,
  setBottomPeekPick,
} from "./pendingPick";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";
import type { TrainerTarget } from "./actions";

// Auto-detected effect ids.
export type TrainerEffectId =
  // Items (search / ball / heal / gust)
  | "searchBasicPokemon1" // Nest Ball
  | "searchBasicPokemon2Poffin" // Buddy-Buddy Poffin (70 HP or less cap)
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
  | "draw2Plus2IfOppFew" // Emcee's Hype (2 + 2 if opp ≤ 3 prizes)
  | "draw2Plus2IfHandBig" // Billy & O'Nare (2 + 2 if hand ≥ 10)
  | "eachPlayerShuffleDraw4" // Judge
  | "drawUntilSeven" // Iono / Marnie / Professor's Research
  | "shuffleHandDraw6OrEight" // Lillie's Determination (8 if 6 prizes)
  | "shuffleHandDraw4Or8Lacey" // Lacey (8 if opp ≤ 3 prizes)
  | "shuffleHandDrawDrasna" // Drasna — flip 8/3
  | "discardHandDraw5" // Carmine
  | "drawUntil6Discard" // Iris's Fighting Spirit (cost: discard 1)
  | "drawUntil5" // Team Rocket's Ariana (no pre-discard)
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
  | "ogresMaskSwapOgerpon" // Swap Ogerpon ex in discard with Ogerpon ex in play
  | "redeemableTicketReprize" // Shuffle prizes, take new ones from top of deck
  | "tmFluoriteTool" // Tool granting an attack — passive, handled at attach
  | "treasureTrackerToolSearch" // Search deck for up to 5 Pokémon Tools
  | "maxRodRecoverPokemonOrEnergy" // Recover up to 5 Pokémon or Basic Energy from discard
  | "secretBoxQuadSearch" // Discard 3, then search Item + Tool + Supporter + Stadium
  | "rocketBotherBotPrizePeek" // Flip a prize face-up + reveal random opp hand card
  | "playFossilAsBasic"; // Antique Cover/Jaw/Plume/Root/Sail Fossil — bench as 60HP Colorless

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
  // Other draw-until-5 patterns (Team Rocket's Ariana, etc.) — no pre-discard.
  if (t.name === "Team Rocket's Ariana" ||
      /draw cards until you have 5 cards in your hand/i.test(text))
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
  if (t.name === "Lt. Surge's Bargain") return "draw4";
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

  // Team Rocket's Proton on first turn — simplify
  if (t.name === "Team Rocket's Proton") return "searchBasicPokemon2Poffin"; // approx — 2 Basics

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
  if (id === "searchAnyPokemon" && pl.hand.length < 3) {
    return "Need 2 other cards in hand to discard for Ultra Ball.";
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
    // Can't use Rare Candy on turn 1 (rulebook).
    if (state.turn === 1) return "Can't use Rare Candy on the first turn.";
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
    if (state.turn === 1) return "Can't use Grimsley's Move on the first turn.";
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
      if (!setDeckSearchPick(state, player, isBasicPokemonCard, 1, "Nest Ball: pick 1 Basic Pokémon to Bench", { toBench: true })) {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
    case "searchBasicPokemon2Poffin":
      if (pl.bench.length >= 5) {
        logEvent(state, player, "bench is full — Poffin has no effect.");
        return;
      }
      if (!setDeckSearchPick(state, player, isBasicPokemonUpTo70Hp, 2, "Buddy-Buddy Poffin: pick up to 2 Basic Pokémon (70 HP or less) to Bench", { toBench: true })) {
        logEvent(state, player, "finds no Basic Pokémon (70 HP or less).");
      }
      return;
    case "searchUpTo2Basic":
      if (!setDeckSearchPick(state, player, isBasicPokemonCard, 2, "Brock's Scouting: pick up to 2 Basic Pokémon")) {
        logEvent(state, player, "finds no Basic Pokémon.");
      }
      return;
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
      if (!setDeckSearchPick(state, player, isBasicEnergy, 1, "Energy Search: pick 1 basic Energy")) {
        logEvent(state, player, "finds no basic Energy.");
      }
      return;
    case "heal30Active":
      if (pl.active) {
        pl.active.damage = Math.max(0, pl.active.damage - 30);
        logEvent(state, player, `heals 30 from ${pl.active.card.name}.`);
      }
      return;

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
      const heads = flipCoinInline(state);
      logEvent(state, "system", `Poké Ball flip: ${heads ? "heads" : "tails"}.`);
      if (!heads) {
        shuffleDeck(state, player);
        return;
      }
      if (!setDeckSearchPick(state, player, isPokemonCard, 1, "Poké Ball: pick 1 Pokémon")) {
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
        const pulled = opp.bench.splice(idx, 1)[0];
        const wasActive = opp.active;
        opp.active = pulled;
        opp.bench.push(wasActive);
        logEvent(state, player, `gusts ${pulled.card.name} into the Active spot.`);
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
      if (!setDiscardRecoveryPick(state, player, pred, 1, "Night Stretcher: pick 1 Pokémon or basic Energy from discard")) {
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

    case "heal60DiscardEnergy":
      if (pl.active) {
        const before = pl.active.damage;
        pl.active.damage = Math.max(0, pl.active.damage - 60);
        const healed = before - pl.active.damage;
        if (healed > 0) {
          const e = pl.active.attachedEnergy.shift();
          if (e) pl.discard.push(e);
        }
        logEvent(state, player, `heals ${healed} from ${pl.active.card.name}.`);
      }
      return;

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
        clearAllStatuses(basic);
        basic.abilityUsedThisTurn = false;
        basic.evolvedThisTurn = true;
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
      const pulled = opp.bench.splice(idx, 1)[0];
      const wasActive = opp.active;
      opp.active = pulled;
      opp.bench.push(wasActive);
      logEvent(state, player, `gusts ${pulled.card.name} into the Active spot.`);
      return;
    }

    case "switchActive": {
      if (!pl.active || pl.bench.length === 0) {
        logEvent(state, player, "has no Benched Pokémon to switch to.");
        return;
      }
      const incoming = pl.bench.shift()!;
      const outgoing = pl.active;
      clearAllStatuses(outgoing);
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(state, player, `switches ${outgoing.card.name} → ${incoming.card.name}.`);
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
      const incoming = pl.bench.shift()!;
      const outgoing = pl.active;
      clearAllStatuses(outgoing);
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(state, player, `Kieran: switches ${outgoing.card.name} → ${incoming.card.name}.`);
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
      const stadium = searchDeck(state, player, isStadium, 1);
      const energy = searchDeck(state, player, isAnyEnergy, 1);
      const picks = [...stadium, ...energy].map((c) => c.name).join(", ");
      logEvent(state, player, picks
        ? `searches deck and adds ${picks}.`
        : "finds no Stadium/Energy.");
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
      if (!setDiscardRecoveryPick(state, player, pred, 3, "Lana's Aid: pick up to 3 non-Rule-Box Pokémon or basic Energy from discard")) {
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
      // Simplification: grab the first 2 different-type Basic Energies, put one
      // in hand, attach the other to Active.
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
      const isEnergy = (c: Card) => c.supertype === "Energy";
      // Two sequential picks would need chained UI; auto-pick first of each.
      const evo = pl.deck.find(isEvo);
      const energy = pl.deck.find(isEnergy);
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
      // Xerosic's Machinations — your opponent reveals their hand; you
      // discard 1 Item and 1 Pokémon Tool card you find there. We model it
      // as a single "up to 2 Item-or-Tool" pick.
      const opp = state.players[oppId];
      const eligible = opp.hand.filter((c) => {
        if (c.supertype !== "Trainer") return false;
        const subs = c.subtypes;
        return subs.includes("Item") || subs.includes("Pokémon Tool") || subs.includes("Tool");
      });
      if (eligible.length === 0) {
        logEvent(state, player, `${opp.name} has no Items or Tools in hand.`);
        return;
      }
      state.pendingHandReveal = {
        player,
        target: oppId,
        label: `Xerosic's Machinations: discard up to 2 Items/Tools from ${opp.name}'s hand`,
        min: 0,
        max: 2,
        filter: "itemOrTool",
        action: "discard",
      };
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
      // Auto-pick: put the leftmost 2 cards (non-Supporter-preferring to
      // avoid dumping high-value plays, but scope is small — just take first).
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
      if (state.turn === 1) {
        logEvent(state, player, "can't use Grimsley's Move on the first turn.");
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
        const pulled = opp.bench.splice(idx, 1)[0];
        const wasActive = opp.active;
        opp.active = pulled;
        opp.bench.push(wasActive);
        if (!pulled.statuses.includes("confused")) pulled.statuses.push("confused");
        logEvent(state, player, `gusts ${pulled.card.name} to Active; it is now Confused.`);
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
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.name.startsWith("Hop's ");
      if (!setDeckSearchPick(state, player, pred, 2, "Hop's Bag: pick up to 2 Basic Hop's Pokémon to Bench", { toBench: true })) {
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
      const cap = pl.bench.length;
      const slots = 5 - cap;
      if (slots <= 0) {
        logEvent(state, player, "bench is full.");
        return;
      }
      const rest: Card[] = [];
      let added = 0;
      for (const c of pl.deck) {
        if (added < slots && c.supertype === "Pokémon" && c.subtypes.includes("Basic")) {
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

    case "searchEnergyVariety": {
      // Energy Search Pro — any number of Basic Energies of different types.
      const seen = new Set<string>();
      const pulled: Card[] = [];
      const rest: Card[] = [];
      for (const c of pl.deck) {
        if (isBasicEnergy(c)) {
          const t = c.provides[0];
          if (t && !seen.has(t)) {
            seen.add(t);
            pulled.push(c);
            continue;
          }
        }
        rest.push(c);
      }
      pl.deck = rest;
      pl.hand.push(...pulled);
      shuffleDeck(state, player);
      logEvent(state, player, pulled.length
        ? `takes ${pulled.length} basic Energy (one of each type).`
        : "finds no basic Energy.");
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
      // Gust an opp Benched to Active, then switch your Active with bench.
      const opp = state.players[oppId];
      const benchedTarget = opp.bench.find((p) => p);
      if (opp.active && benchedTarget) {
        const idx = opp.bench.indexOf(benchedTarget);
        const pulled = opp.bench.splice(idx, 1)[0];
        const oppOld = opp.active;
        opp.active = pulled;
        opp.bench.push(oppOld);
        logEvent(state, player, `gusts ${pulled.card.name} to Active.`);
      }
      if (pl.active && pl.bench.length > 0) {
        const incoming = pl.bench.shift()!;
        const outgoing = pl.active;
        clearAllStatuses(outgoing);
        pl.active = incoming;
        pl.bench.push(outgoing);
        logEvent(state, player, `switches ${outgoing.card.name} → ${incoming.card.name}.`);
      }
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
      state.pendingPromote = oppId;
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
      const incoming = pl.bench.shift()!;
      const outgoing = pl.active;
      clearAllStatuses(outgoing);
      pl.active = incoming;
      pl.bench.push(outgoing);
      // Move all energy from the outgoing (now on bench) to the new Active.
      const prev = pl.bench[pl.bench.length - 1];
      pl.active.attachedEnergy.push(...prev.attachedEnergy);
      prev.attachedEnergy = [];
      logEvent(state, player, `switches + transfers Energy to ${pl.active.card.name}.`);
      enforceSpecialEnergyAttachRules(state);
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
      const colorless = pl.bench.filter((p) => p.card.types.includes("Colorless")).slice(0, 2);
      let attached = 0;
      for (const c of colorless) {
        const idx = pl.discard.findIndex(isBasicEnergy);
        if (idx < 0) break;
        const [e] = pl.discard.splice(idx, 1) as [EnergyCard];
        c.attachedEnergy.push(e);
        attached++;
      }
      logEvent(state, player, `attaches ${attached} basic Energy to Benched Colorless Pokémon.`);
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
      // Auto-pick: find any Evolution Pokémon in deck whose evolvesFrom matches
      // any of your Pokémon. Apply to first match.
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const candidatePairs: Array<{ deckIdx: number; ally: PokemonInPlay; evo: PokemonCard }> = [];
      pl.deck.forEach((c, i) => {
        if (c.supertype !== "Pokémon") return;
        if (!(c.abilities ?? []).length || (c.abilities ?? []).length === 0) {
          // requires no abilities
          if ((c.abilities ?? []).length > 0) return;
        }
        for (const a of allies) {
          if (c.evolvesFrom === a.card.name && !a.playedThisTurn) {
            candidatePairs.push({ deckIdx: i, ally: a, evo: c as PokemonCard });
            break;
          }
        }
      });
      if (candidatePairs.length === 0) {
        logEvent(state, player, "Salvatore: no eligible evolution.");
        shuffleDeck(state, player);
        return;
      }
      const pick = candidatePairs[0];
      const [evo] = pl.deck.splice(pick.deckIdx, 1) as [PokemonCard];
      pick.ally.evolvedFrom.push(pick.ally.card);
      pick.ally.card = evo;
      pick.ally.evolvedThisTurn = true;
      shuffleDeck(state, player);
      logEvent(state, player, `Salvatore: evolves ${pick.ally.card.name}.`);
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
          opp.bench.push({
            instanceId: `af-${Date.now()}-${Math.random()}`,
            card: c as PokemonCard,
            damage: 0,
            attachedEnergy: [],
            evolvedFrom: [],
            tools: [],
            playedThisTurn: false,
            evolvedThisTurn: false,
            statuses: [],
            abilityUsedThisTurn: false,
          });
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
      // Item, Pokémon Tool, Supporter, and Stadium. Auto-discards the 3
      // lowest-priority cards (Basic Energy first, then by hand index).
      // The 4-card search auto-takes the first match of each kind so the
      // play resolves in one click.
      if (pl.hand.length < 3) {
        logEvent(state, player, "Secret Box: not enough cards in hand to discard 3.");
        return;
      }
      const isBasicEn = (c: Card) =>
        c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
      const sorted = pl.hand
        .map((c, i) => ({ c, i }))
        .sort((a, b) => {
          const av = isBasicEn(a.c) ? 0 : 1;
          const bv = isBasicEn(b.c) ? 0 : 1;
          if (av !== bv) return av - bv;
          return a.i - b.i;
        });
      const toDiscardIdxs = sorted.slice(0, 3).map((x) => x.i).sort((a, b) => b - a);
      for (const i of toDiscardIdxs) {
        const [c2] = pl.hand.splice(i, 1);
        pl.discard.push(c2);
      }
      logEvent(state, player, "Secret Box: discards 3 cards.");
      // Search for one of each: Item, Tool, Supporter, Stadium.
      const grab = (label: string, pred: (c: Card) => boolean): void => {
        const idx = pl.deck.findIndex(pred);
        if (idx >= 0) {
          pl.hand.push(pl.deck.splice(idx, 1)[0]);
          logEvent(state, player, `Secret Box: takes ${label}.`);
        }
      };
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
      grab("an Item", isItemOnly);
      grab("a Pokémon Tool", isTool);
      grab("a Supporter", isSupp);
      grab("a Stadium", isStadium);
      shuffleDeck(state, player);
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
      pl.discard.push(...pl.hand.splice(0));
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
      logEvent(state, player, "Larry's Skill: discards hand and searches.");
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
      const reveal: Card[] = [];
      for (let i = pl.hand.length - 1; i >= 0 && reveal.length < 2; i--) {
        if (pl.hand[i].supertype === "Pokémon") {
          reveal.push(pl.hand.splice(i, 1)[0]);
        }
      }
      pl.deck.push(...reveal);
      shuffleDeck(state, player);
      const isPoke = (c: Card) => c.supertype === "Pokémon";
      if (reveal.length === 0) {
        logEvent(state, player, "Perrin: no Pokémon in hand to reveal.");
        return;
      }
      if (!setDeckSearchPick(state, player, isPoke, reveal.length, `Perrin: pick up to ${reveal.length} Pokémon`)) {
        logEvent(state, player, "Perrin: no Pokémon in deck.");
      }
      return;
    }
    case "raifortPeek5Discard": {
      // Look at top 5; auto-discard nothing, return all.
      const top = pl.deck.slice(0, 5);
      logEvent(state, player, `Raifort: examines top ${top.length} card(s).`);
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
        const pulled = opp.bench.splice(idx, 1)[0];
        const wasActive = opp.active;
        opp.active = pulled;
        opp.bench.push(wasActive);
        logEvent(state, player, `gusts ${pulled.card.name} into Active.`);
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
      const pulled = opp.bench.splice(idx, 1)[0];
      const wasActive = opp.active;
      opp.active = pulled;
      opp.bench.push(wasActive);
      logEvent(state, clicker, `gusts ${pulled.card.name} into the Active spot.`);
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
      const pulled = opp.bench.splice(idx, 1)[0];
      const wasActive = opp.active;
      opp.active = pulled;
      opp.bench.push(wasActive);
      if (!pulled.statuses.includes("confused")) pulled.statuses.push("confused");
      logEvent(state, clicker, `gusts ${pulled.card.name} to Active; it is now Confused.`);
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
  }
}

// Cancel a pending in-play target (user backed out / the UI dismissed it).
// We don't refund the trainer card — that's already been discarded — but we
// clear the prompt so the game can continue. Some effects leave state partially
// applied (e.g. Crushing Hammer's coin flip already happened); that's fine.
export function cancelInPlayTarget(state: GameState): void {
  state.pendingInPlayTarget = null;
}

// -------- Hand-reveal resolver -------------------------------------------

function handCardMatches(c: Card, filter: "item" | "tool" | "itemOrTool" | "supporter" | "any"): boolean {
  if (filter === "any") return true;
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
  } else if (postAction?.kind === "searchDeckAnyPokemon") {
    if (!setDeckSearchPick(state, clicker, isPokemonCard, postAction.max, postAction.label)) {
      logEvent(state, clicker, "finds no Pokémon.");
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
  clearAllStatuses(basic);
  basic.abilityUsedThisTurn = false;
  basic.evolvedThisTurn = true;
  logEvent(state, clicker, `uses Rare Candy to evolve into ${card.name}.`);
  fireTriggeredOnEvolve(state, clicker, basic);
  state.pendingRareCandyChoice = null;
  return { ok: true };
}

export function cancelRareCandyChoice(state: GameState): void {
  state.pendingRareCandyChoice = null;
}

