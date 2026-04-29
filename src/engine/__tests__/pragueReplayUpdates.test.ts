// AI updates derived from the Prague Regional 2026 R9 replay analysis
// (data/tournament-replays/prague-2026-r9-rocket-mewtwo-vs-dragapult-blaziken.json).
// Findings encoded:
//   1. Two new archetypes detected: rocket-mewtwo, dragapult-blaziken.
//   2. T1-T3 playbook bonuses for those archetypes.
//   3. AI coin-flip: go FIRST when opp's deck contains a T1-supporter
//      exception card (deny opp's T1 Proton).
//   4. Gust priority ranks un-powered rule-box punchers (e.g. Mewtwo ex,
//      Dragapult ex on bench with 0 energy).

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
} from "../rules";
import { resolveAiCoinChoice } from "../ai";
import { detectArchetype, playbookCardBonus } from "../aiArchetype";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { Card, GameState, PokemonCard } from "../types";

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

function bootCoinFlipPhase(seed = 9000): GameState {
  return setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: true },
  );
}

describe("archetype detection (Prague replay seeds)", () => {
  it("detects rocket-mewtwo from TR Mewtwo + Spidops in deck", () => {
    const state = bootCoinFlipPhase(7001);
    state.players.p1.deck = [
      mkPokemon("Team Rocket's Mewtwo ex", { subtypes: ["Basic", "ex"] }),
      mkPokemon("Team Rocket's Spidops", { subtypes: ["Stage 1"] }),
      mkPokemon("Team Rocket's Tarountula"),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("rocket-mewtwo");
  });

  it("detects dragapult-blaziken from Dragapult + Blaziken + Drakloak", () => {
    const state = bootCoinFlipPhase(7002);
    state.players.p1.deck = [
      mkPokemon("Dragapult ex", { subtypes: ["Stage 2", "ex"] }),
      mkPokemon("Blaziken ex", { subtypes: ["Stage 2", "ex"] }),
      mkPokemon("Drakloak", { subtypes: ["Stage 1"] }),
    ];
    state.players.p1.hand = [];
    expect(detectArchetype(state, "p1")).toBe("dragapult-blaziken");
  });
});

describe("playbook bonuses — rocket-mewtwo opening sequence", () => {
  it("T1: Proton dominates supporter scoring", () => {
    expect(playbookCardBonus("rocket-mewtwo", 1, "Team Rocket's Proton")).toBeGreaterThan(50);
    // Ariana isn't the T1 play (would burn the T1 supporter on draw 5
    // instead of search 3 → hand). T1 bonus should be 0.
    expect(playbookCardBonus("rocket-mewtwo", 1, "Team Rocket's Ariana")).toBe(0);
  });

  it("T2: Ariana dominates over Proton (already played)", () => {
    expect(playbookCardBonus("rocket-mewtwo", 2, "Team Rocket's Ariana")).toBeGreaterThan(50);
    expect(playbookCardBonus("rocket-mewtwo", 2, "Team Rocket's Ariana"))
      .toBeGreaterThan(playbookCardBonus("rocket-mewtwo", 2, "Team Rocket's Proton"));
  });

  it("T3: Giovanni gust priority", () => {
    expect(playbookCardBonus("rocket-mewtwo", 3, "Team Rocket's Giovanni")).toBeGreaterThan(30);
  });
});

describe("playbook bonuses — dragapult-blaziken slow setup", () => {
  it("T1: Lillie + Poffin lead, no Crispin yet", () => {
    expect(playbookCardBonus("dragapult-blaziken", 1, "Buddy-Buddy Poffin")).toBeGreaterThan(30);
    expect(playbookCardBonus("dragapult-blaziken", 1, "Lillie's Determination")).toBeGreaterThan(20);
    // Crispin has no T1 line — saving for T2 attach setup.
    expect(playbookCardBonus("dragapult-blaziken", 1, "Crispin")).toBe(0);
  });

  it("T2: Crispin + Rare Candy peak (energize Drakloak / skip to Dragapult)", () => {
    expect(playbookCardBonus("dragapult-blaziken", 2, "Crispin")).toBeGreaterThan(35);
    expect(playbookCardBonus("dragapult-blaziken", 2, "Rare Candy")).toBeGreaterThan(30);
  });

  it("T3: Boss's Orders gust + Crispin energize", () => {
    expect(playbookCardBonus("dragapult-blaziken", 3, "Boss's Orders")).toBeGreaterThan(20);
    expect(playbookCardBonus("dragapult-blaziken", 3, "Crispin")).toBeGreaterThan(20);
  });
});

describe("AI coin-flip choice — T1 supporter denial", () => {
  // Helper: drive both players into the chooseFirst step, with p2 winning.
  function bootWithP2WinsFlip(seed: number): GameState {
    for (let attempts = 0; attempts < 12; attempts++) {
      for (const guess of ["heads", "tails"] as const) {
        const trial = bootCoinFlipPhase(seed + attempts);
        resolveCoinGuess(trial, guess);
        if (trial.coinFlip?.winner === "p2") return trial;
      }
    }
    throw new Error("Could not find seed where p2 wins coin flip");
  }

  it("default: AI goes second when opp deck has no T1-supporter exception", () => {
    const state = bootWithP2WinsFlip(8100);
    state.players.p2.aiVersion = "v2";
    // Sanity: opp's preset deck (DECK_SPECS[0]) does not contain Proton/Carmine.
    const oppCards = new Set(state.players.p1.deck.map((c) => c.name));
    expect(oppCards.has("Team Rocket's Proton")).toBe(false);
    expect(oppCards.has("Carmine")).toBe(false);

    const ok = resolveAiCoinChoice(state);
    expect(ok).toBe(true);
    expect(state.firstPlayer).toBe("p1"); // p2 chose to go second
  });

  it("v2: AI goes FIRST when opp deck contains Team Rocket's Proton", () => {
    const state = bootWithP2WinsFlip(8200);
    state.players.p2.aiVersion = "v2";
    // Salt opp deck with Proton — the T1-supporter exception card.
    const proton = mkPokemon("Team Rocket's Proton", {
      supertype: "Trainer" as never,
    }) as unknown as Card;
    state.players.p1.deck = [proton, ...state.players.p1.deck];

    const ok = resolveAiCoinChoice(state);
    expect(ok).toBe(true);
    expect(state.firstPlayer).toBe("p2"); // p2 chose to go first
  });

  it("v1 (baseline): keeps the always-go-second behavior even vs Proton", () => {
    const state = bootWithP2WinsFlip(8300);
    state.players.p2.aiVersion = "v1";
    const proton = mkPokemon("Team Rocket's Proton", {
      supertype: "Trainer" as never,
    }) as unknown as Card;
    state.players.p1.deck = [proton, ...state.players.p1.deck];

    resolveAiCoinChoice(state);
    expect(state.firstPlayer).toBe("p1"); // v1 still goes second
  });
});

// chooseFirstPlayer is imported so the test file's setup helpers compile
// cleanly even if a future test wants to bypass resolveAiCoinChoice.
void chooseFirstPlayer;
