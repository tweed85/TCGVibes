// Trainer-effect detection tests. The detector runs at card-mapping time and
// tags each Trainer with a `effectId`. These tests exercise the real dataset
// cards to make sure staples resolve to the expected effect id.

import { describe, it, expect } from "vitest";
import { detectTrainerEffect } from "../trainerEffects";
import { allCards } from "../../data/cards";

function findTrainer(name: string) {
  const c = allCards.find((c) => c.supertype === "Trainer" && c.name === name);
  return c ?? null;
}

// Convenience: for each [name, expected] pair, run the detection IF the card
// is in the current legal pool. Cards that rotated out are skipped silently —
// the dataset evolves with each Standard rotation, and we don't want tests
// that fail the moment a printing leaves.
function assertDetection(pairs: readonly (readonly [string, string])[]): void {
  for (const [name, expected] of pairs) {
    const c = findTrainer(name);
    if (!c) continue;
    expect(detectTrainerEffect(c as any), `${name} detection`).toBe(expected);
  }
}

describe("detectTrainerEffect — staples", () => {
  it("items detect correctly", () => {
    assertDetection([
      ["Nest Ball", "searchBasicPokemon1"],
      ["Buddy-Buddy Poffin", "searchBasicPokemon2Poffin"],
      ["Ultra Ball", "searchAnyPokemon"],
      ["Master Ball", "searchAnyPokemonFree"],
      ["Poké Ball", "searchPokemonCoinFlip"],
      ["Poké Pad", "searchNonRuleBoxPokemon"],
      ["Hyper Aroma", "searchStage1x3"],
      ["Tera Orb", "searchTeraPokemon"],
      ["Energy Search", "searchBasicEnergy1"],
      ["Switch", "simpleSwitch"],
      ["Pokémon Catcher", "flipGustOppBenched"],
      ["Night Stretcher", "nightStretcher"],
      ["Energy Retrieval", "energyRetrieval"],
      ["Enhanced Hammer", "enhancedHammer"],
      ["Crushing Hammer", "crushingHammer"],
      ["Tool Scrapper", "toolScrapper"],
      ["Potion", "heal30Active"],
      ["Rare Candy", "rareCandyEvolve"],
      ["Bug Catching Set", "bugCatchingSet"],
      ["Pokégear 3.0", "pokegear37"],
      ["Dusk Ball", "duskBall"],
    ]);
  });

  it("supporters detect correctly", () => {
    assertDetection([
      ["Iono", "drawUntilSeven"],
      ["Professor's Research", "drawUntilSeven"],
      ["Boss's Orders", "gustOppBenched"],
      ["Judge", "eachPlayerShuffleDraw4"],
      ["Lillie's Determination", "shuffleHandDraw6OrEight"],
      ["Lacey", "shuffleHandDraw4Or8Lacey"],
      ["Drasna", "shuffleHandDrawDrasna"],
      ["Carmine", "discardHandDraw5"],
      ["Iris's Fighting Spirit", "drawUntil6Discard"],
      ["Naveen", "naveenPreDiscardDraw5"],
      ["Picnicker", "drawCoinFlip42"],
      ["Emcee's Hype", "draw2Plus2IfOppFew"],
      ["Billy & O'Nare", "draw2Plus2IfHandBig"],
      ["Drayton", "draytonTop7"],
      ["Eri", "eriDiscardOppItems"],
      ["Kieran", "kieranChoice"],
      ["Colress's Tenacity", "searchStadiumAndEnergy"],
      ["Cook", "heal70Active"],
      ["Pokémon Center Lady", "heal60ActiveAndCure"],
      ["Fennel", "healEach40"],
      ["Lana's Aid", "recoverFromDiscardLana"],
      ["Cheren", "draw3"],
      ["Urbain", "draw3"],
      ["Friends in Paldea", "draw3"],
      ["Amarys", "draw4"],
    ]);
  });

  it("turn-scoped modifiers detect correctly", () => {
    assertDetection([
      ["Black Belt's Training", "buffPlus40VsExThisTurn"],
      ["Premium Power Pro", "buffFightingPlus30ThisTurn"],
      ["Jasmine's Gaze", "debuffMinus30OppTurn"],
      ["Iron Defender", "debuffMinus30OppTurnMetal"],
    ]);
  });
});
