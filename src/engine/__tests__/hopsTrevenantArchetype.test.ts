// hops-trevenant archetype playbook — Prague Regional 2026 community
// list. Plays + card text independently verified against
// data/pokemon/tournament-legal-cards.json before wiring.
//
// Key card-text-driven design decisions:
//   - Postwick + Hop's Choice Band layer +30/+30 onto Hop's attacks. Both
//     are signature[2] / signature[3] for detection.
//   - Hop's Trevenant Horrifying Revenge: 30+ dmg, +100 if any of your
//     Hop's Pokémon were KO'd by an attack last turn — turns lost prizes
//     into 130-dmg counter-attacks.
//   - Telepathic Psychic Energy = "Buddy-Buddy Poffin on an energy"
//     (attach + search 2 Basic Psychic to bench).
//   - Hop's Bag is an ITEM, not a supporter — search 2 Basic Hop's Pokémon
//     to bench (T1-friendly under the supporter ban).
//   - Hassel is conditional on losing a KO last turn — modest bonus, T3.

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

function bootBlankState(seed = 5000): GameState {
  return setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: true },
  );
}

describe("hops-trevenant — archetype detection", () => {
  it("detects from Hop's Trevenant + Hop's Phantump + Postwick + Hop's Choice Band", () => {
    const state = bootBlankState(8001);
    state.players.p1.deck = [
      mkPokemon("Hop's Trevenant", { subtypes: ["Stage 1"] }),
      mkPokemon("Hop's Phantump"),
      mkTrainer("Postwick", "Stadium"),
      mkTrainer("Hop's Choice Band", "Tool"),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("hops-trevenant");
  });

  it("does NOT misfire as alakazam (which has Dudunsparce as a non-Hop's signature)", () => {
    // Sanity check: a deck with only Phantump + Postwick (signature[1] + [2])
    // should still detect hops-trevenant, not fall through to a different
    // archetype that happens to share a card. (No current archetype shares
    // any of the 4 hops-trevenant signatures, but the test enforces it.)
    const state = bootBlankState(8002);
    state.players.p1.deck = [
      mkPokemon("Hop's Phantump"),
      mkTrainer("Postwick", "Stadium"),
      mkTrainer("Hop's Choice Band", "Tool"),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("hops-trevenant");
  });
});

describe("hops-trevenant — trainer bonuses (deck-specific signature cards)", () => {
  it("Postwick is the highest-priority stadium (signature deck buff)", () => {
    const postwick = mkTrainer("Postwick", "Stadium");
    expect(archetypeTrainerBonus("hops-trevenant", postwick)).toBeGreaterThanOrEqual(25);
  });

  it("Hop's Choice Band tool is heavily prioritized (cost reduction + +30 dmg)", () => {
    const choiceBand = mkTrainer("Hop's Choice Band", "Tool");
    expect(archetypeTrainerBonus("hops-trevenant", choiceBand)).toBeGreaterThan(20);
  });

  it("Hop's Bag — bench-fill item — outranks generic tutors", () => {
    const hopsBag = mkTrainer("Hop's Bag", "Item");
    const pokePad = mkTrainer("Poké Pad", "Item");
    expect(archetypeTrainerBonus("hops-trevenant", hopsBag))
      .toBeGreaterThan(archetypeTrainerBonus("hops-trevenant", pokePad));
  });

  it("Hassel (conditional draw) gets a modest bonus, lower than primary draw", () => {
    const hassel = mkTrainer("Hassel", "Supporter");
    const lillie = mkTrainer("Lillie's Determination", "Supporter");
    expect(archetypeTrainerBonus("hops-trevenant", hassel)).toBeGreaterThan(0);
    expect(archetypeTrainerBonus("hops-trevenant", hassel))
      .toBeLessThan(archetypeTrainerBonus("hops-trevenant", lillie));
  });
});

describe("hops-trevenant — attach bonuses (attacker priority)", () => {
  it("Hop's Trevenant is the primary attacker (highest attach bonus)", () => {
    const trevenant = mkPokemonInPlay("Hop's Trevenant", { subtypes: ["Stage 1"] });
    const snorlax = mkPokemonInPlay("Hop's Snorlax");
    expect(archetypeAttachBonus("hops-trevenant", trevenant))
      .toBeGreaterThan(archetypeAttachBonus("hops-trevenant", snorlax));
  });

  it("Hop's Snorlax is a secondary attacker (the big finisher)", () => {
    const snorlax = mkPokemonInPlay("Hop's Snorlax");
    expect(archetypeAttachBonus("hops-trevenant", snorlax)).toBeGreaterThan(10);
  });

  it("Hop's Zacian ex gets a smaller bonus (Brave Slash unreachable in this list)", () => {
    const zacian = mkPokemonInPlay("Hop's Zacian ex", { subtypes: ["Basic", "ex"] });
    const trevenant = mkPokemonInPlay("Hop's Trevenant", { subtypes: ["Stage 1"] });
    expect(archetypeAttachBonus("hops-trevenant", zacian))
      .toBeLessThan(archetypeAttachBonus("hops-trevenant", trevenant));
  });
});

describe("hops-trevenant — playbook (T1-T3)", () => {
  it("T1: Hop's Bag dominates (item-only T1, fill bench with Phantumps)", () => {
    expect(playbookCardBonus("hops-trevenant", 1, "Hop's Bag")).toBeGreaterThan(35);
    expect(playbookCardBonus("hops-trevenant", 1, "Postwick")).toBeGreaterThan(25);
    // Lillie's not yet — T1 supporter ban.
    expect(playbookCardBonus("hops-trevenant", 1, "Lillie's Determination")).toBe(0);
  });

  it("T2: Lillie's Determination peaks; Hop's Choice Band attach", () => {
    expect(playbookCardBonus("hops-trevenant", 2, "Lillie's Determination")).toBeGreaterThan(45);
    expect(playbookCardBonus("hops-trevenant", 2, "Hop's Choice Band")).toBeGreaterThan(30);
  });

  it("T3: Boss's Orders gust + Hassel as conditional refill", () => {
    expect(playbookCardBonus("hops-trevenant", 3, "Boss's Orders")).toBeGreaterThan(30);
    expect(playbookCardBonus("hops-trevenant", 3, "Hassel")).toBeGreaterThan(15);
  });

  it("Extra Helpings (Hop's Snorlax ability) ramps up T2-T3 priority", () => {
    expect(playbookAbilityBonus("hops-trevenant", 2, "Extra Helpings")).toBeGreaterThan(15);
    expect(playbookAbilityBonus("hops-trevenant", 3, "Extra Helpings")).toBeGreaterThan(20);
  });
});
