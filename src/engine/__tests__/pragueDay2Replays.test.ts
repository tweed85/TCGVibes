// AI archetype updates derived from the Prague Regional 2026 Day 2 replays
// (top16, top8, top4, finals — see data/tournament-replays/). Five new
// archetypes seeded into aiArchetype.ts. Tests verify:
//   1. Archetype detection from signature cards (handles the
//      dragapult-blaziken vs dragapult-dudunsparce disambiguation).
//   2. T1-T3 playbook bonuses match the canonical opening-book lines.
//   3. The crustle archetype's "wall first, attack last" inversion is
//      reflected in playbook + bonus weights (no Ascension boost).

import { describe, it, expect } from "vitest";
import { setupGame } from "../rules";
import {
  detectArchetype,
  playbookCardBonus,
  playbookAbilityBonus,
  archetypeTrainerBonus,
  archetypeAttachBonus,
} from "../aiArchetype";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, PokemonCard, TrainerCard } from "../types";

const mkPokemon = (name: string, opts: Partial<PokemonCard> = {}): PokemonCard => ({
  id: name.toLowerCase().replace(/[^a-z]/g, "-"),
  name,
  supertype: "Pokémon",
  subtypes: ["Basic"],
  hp: 100,
  types: ["Colorless"],
  attacks: [],
  retreatCost: [],
  ...opts,
} as PokemonCard);

const mkTrainer = (name: string, subtype: "Item" | "Supporter" | "Stadium" | "Tool" | "ACE SPEC" = "Item"): TrainerCard => ({
  id: name.toLowerCase().replace(/[^a-z]/g, "-"),
  name,
  supertype: "Trainer",
  subtypes: [subtype],
} as TrainerCard);

const mkPokemonInPlay = (name: string, opts: Partial<PokemonCard> = {}) => ({
  instanceId: `inst-${name}`,
  card: mkPokemon(name, opts),
  damage: 0,
  attachedEnergy: [],
  evolvedFrom: [],
  tools: [],
  playedThisTurn: false,
  evolvedThisTurn: false,
  statuses: [],
  abilityUsedThisTurn: false,
});

function bootBlankState(seed = 9000): GameState {
  return setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: true },
  );
}

describe("archetype detection — Prague Day 2 replay seeds", () => {
  it("detects dragapult-dudunsparce when both Dragapult ex AND Dudunsparce ex are present", () => {
    // The disambiguation that matters: this deck shares Dragapult ex +
    // Drakloak with dragapult-blaziken, but Dudunsparce ex + Hero's Cape
    // are unique. Detection must NOT misfire as dragapult-blaziken.
    const state = bootBlankState(7100);
    state.players.p1.deck = [
      mkPokemon("Dudunsparce ex", { subtypes: ["Stage 1", "ex"] }),
      mkPokemon("Dragapult ex", { subtypes: ["Stage 2", "ex"] }),
      mkPokemon("Drakloak", { subtypes: ["Stage 1"] }),
      mkTrainer("Hero's Cape", "ACE SPEC"),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("dragapult-dudunsparce");
  });

  it("falls back to dragapult-blaziken when no Dudunsparce ex is present", () => {
    const state = bootBlankState(7101);
    state.players.p1.deck = [
      mkPokemon("Dragapult ex", { subtypes: ["Stage 2", "ex"] }),
      mkPokemon("Blaziken ex", { subtypes: ["Stage 2", "ex"] }),
      mkPokemon("Drakloak", { subtypes: ["Stage 1"] }),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("dragapult-blaziken");
  });

  it("detects crustle from Crustle + Dwebble + Cornerstone Mask Ogerpon ex", () => {
    const state = bootBlankState(7102);
    state.players.p1.deck = [
      mkPokemon("Crustle", { subtypes: ["Stage 1"] }),
      mkPokemon("Dwebble"),
      mkPokemon("Cornerstone Mask Ogerpon ex", { subtypes: ["Basic", "ex"] }),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("crustle");
  });

  it("detects cynthia-garchomp from the Cynthia's-prefix line", () => {
    const state = bootBlankState(7103);
    state.players.p1.deck = [
      mkPokemon("Cynthia's Garchomp", { subtypes: ["Stage 2"] }),
      mkPokemon("Cynthia's Gabite", { subtypes: ["Stage 1"] }),
      mkPokemon("Cynthia's Gible"),
      mkPokemon("Cynthia's Roserade", { subtypes: ["Stage 1"] }),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("cynthia-garchomp");
  });

  it("detects grimmsnarl-froslass from the Maman's-prefix line + Spike Muff Gym", () => {
    const state = bootBlankState(7104);
    state.players.p1.deck = [
      mkPokemon("Maman's Grimmsnarl ex", { subtypes: ["Stage 2", "ex"] }),
      mkPokemon("Maman's Morgrem", { subtypes: ["Stage 1"] }),
      mkPokemon("Maman's Impidimp"),
      mkTrainer("Spike Muff Gym", "Stadium"),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("grimmsnarl-froslass");
  });

  it("detects mega-starmie-froslass from Mega Starmie ex + Risky Ruins + Mega Frostlass", () => {
    const state = bootBlankState(7105);
    state.players.p1.deck = [
      mkPokemon("Mega Starmie ex", { subtypes: ["Mega", "ex"] }),
      mkTrainer("Risky Ruins", "Stadium"),
      mkPokemon("Mega Frostlass", { subtypes: ["Mega"] }),
      mkPokemon("Staryu"),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("mega-starmie-froslass");
  });
});

describe("playbook bonuses — dragapult-dudunsparce (Mateusz championship line)", () => {
  it("T1: Poffin + Poké Pad lead, no supporter (T1 ban)", () => {
    expect(playbookCardBonus("dragapult-dudunsparce", 1, "Buddy-Buddy Poffin")).toBeGreaterThan(35);
    expect(playbookCardBonus("dragapult-dudunsparce", 1, "Poké Pad")).toBeGreaterThan(20);
    expect(playbookCardBonus("dragapult-dudunsparce", 1, "Lillie's Determination")).toBe(0);
  });

  it("T2: Lillie's draw + Rare Candy + Hero's Cape attach", () => {
    expect(playbookCardBonus("dragapult-dudunsparce", 2, "Lillie's Determination")).toBeGreaterThan(45);
    expect(playbookCardBonus("dragapult-dudunsparce", 2, "Rare Candy")).toBeGreaterThan(35);
    // Hero's Cape on T2 is the matchup-defining ACE SPEC choice.
    expect(playbookCardBonus("dragapult-dudunsparce", 2, "Hero's Cape")).toBeGreaterThan(30);
  });

  it("T3: Boss's Orders gust + Recon Directive ability", () => {
    expect(playbookCardBonus("dragapult-dudunsparce", 3, "Boss's Orders")).toBeGreaterThan(30);
    expect(playbookAbilityBonus("dragapult-dudunsparce", 3, "Recon Directive")).toBeGreaterThan(15);
  });

  it("Hero's Cape trainer bonus is high (1-prize buffer favored over Unfair Stamp)", () => {
    const heroCape = mkTrainer("Hero's Cape", "ACE SPEC");
    expect(archetypeTrainerBonus("dragapult-dudunsparce", heroCape)).toBeGreaterThanOrEqual(20);
  });
});

describe("playbook bonuses — crustle (wall first, attack last)", () => {
  it("T1: Pokégear chain + Poffin lead, no Ascension boost", () => {
    expect(playbookCardBonus("crustle", 1, "Pokégear 3.0")).toBeGreaterThan(30);
    expect(playbookCardBonus("crustle", 1, "Buddy-Buddy Poffin")).toBeGreaterThan(25);
    // Crustle's plan inverts aggro — no Ascension boost. AI's greedy
    // step-loop will still attempt Ascension if energy is paid, but the
    // playbook does not amplify it.
    expect(playbookCardBonus("crustle", 1, "Ascension")).toBe(0);
  });

  it("T2: Hero's Cape (peak) + Pokémon Center Lady heal phase begins", () => {
    expect(playbookCardBonus("crustle", 2, "Hero's Cape")).toBeGreaterThan(40);
    expect(playbookCardBonus("crustle", 2, "Pokémon Center Lady")).toBeGreaterThan(20);
  });

  it("T3: heal + stadium chain (Colress's Tenacity), late-game gust", () => {
    expect(playbookCardBonus("crustle", 3, "Pokémon Center Lady")).toBeGreaterThan(30);
    expect(playbookCardBonus("crustle", 3, "Colress's Tenacity")).toBeGreaterThan(25);
    expect(playbookCardBonus("crustle", 3, "Boss's Orders")).toBeGreaterThan(15);
  });

  it("Mega Kangaskhan ex is the backup attacker — bench bonus, not lead bonus", () => {
    const kangaskhan = mkPokemonInPlay("Mega Kangaskhan ex", { subtypes: ["Mega", "ex"] });
    // Backup attacker: should get an attach bonus (it's a real attacker)
    // but not as high as Crustle (the wall).
    const kangBonus = archetypeAttachBonus("crustle", kangaskhan);
    const crustleBonus = archetypeAttachBonus(
      "crustle",
      mkPokemonInPlay("Crustle", { subtypes: ["Stage 1"] }),
    );
    expect(kangBonus).toBeGreaterThan(0);
    expect(crustleBonus).toBeGreaterThan(kangBonus);
  });
});

describe("playbook bonuses — cynthia-garchomp (Cynthia's-prefix engine)", () => {
  it("T1: heavy Poffin (often double-Poffin for wide Gible+Roselia bench)", () => {
    expect(playbookCardBonus("cynthia-garchomp", 1, "Buddy-Buddy Poffin")).toBeGreaterThan(45);
  });

  it("T2: Cynthia engine + Roserade ramp ability", () => {
    expect(playbookCardBonus("cynthia-garchomp", 2, "Cynthia")).toBeGreaterThan(45);
    expect(playbookAbilityBonus("cynthia-garchomp", 2, "Roserade")).toBeGreaterThan(20);
  });

  it("T3: Boss's Orders + Unfair Stamp ACE SPEC", () => {
    expect(playbookCardBonus("cynthia-garchomp", 3, "Boss's Orders")).toBeGreaterThan(30);
    expect(playbookCardBonus("cynthia-garchomp", 3, "Unfair Stamp")).toBeGreaterThan(20);
  });
});

describe("playbook bonuses — grimmsnarl-froslass (Spike Muff Gym + Punk Up)", () => {
  it("T1: Spike Muff Gym dominates (item-lock-immune stadium-search)", () => {
    expect(playbookCardBonus("grimmsnarl-froslass", 1, "Spike Muff Gym")).toBeGreaterThan(50);
    expect(playbookCardBonus("grimmsnarl-froslass", 1, "Buddy-Buddy Poffin")).toBeGreaterThan(30);
  });

  it("T2: Lillie's draw + Freezing Shroud passive comes online", () => {
    expect(playbookCardBonus("grimmsnarl-froslass", 2, "Lillie's Determination")).toBeGreaterThan(40);
    expect(playbookAbilityBonus("grimmsnarl-froslass", 2, "Freezing Shroud")).toBeGreaterThan(20);
  });

  it("T3: Punk Up energy acceleration on Grimmsnarl evolution", () => {
    expect(playbookAbilityBonus("grimmsnarl-froslass", 3, "Punk Up")).toBeGreaterThan(25);
  });
});

describe("playbook bonuses — mega-starmie-froslass (Risky Ruins compound)", () => {
  it("T1: Risky Ruins dominates (signature accelerator)", () => {
    expect(playbookCardBonus("mega-starmie-froslass", 1, "Risky Ruins")).toBeGreaterThan(50);
  });

  it("T2: Crispin is the primary energy attach trainer", () => {
    expect(playbookCardBonus("mega-starmie-froslass", 2, "Crispin")).toBeGreaterThan(45);
  });

  it("T3: Boss's Orders converts spread into KOs", () => {
    expect(playbookCardBonus("mega-starmie-froslass", 3, "Boss's Orders")).toBeGreaterThan(25);
    expect(playbookAbilityBonus("mega-starmie-froslass", 3, "Adrena-Brain")).toBeGreaterThan(15);
  });
});
