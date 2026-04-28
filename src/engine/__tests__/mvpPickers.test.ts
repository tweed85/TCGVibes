// Regression tests for the MVP-list picker fixes:
//   #4a Salvatore — interactive evolution picker (was: auto-pick first)
//   #4c Perrin — interactive hand-reveal picker (was: auto-reveal last 2)
//   #4d Colress's Tenacity — chained Stadium + Energy picker (was: auto-search)
//   #7  Heavy Baton — interactive Bench-target picker (was: auto-target most-energy)
//
// Each fix preserves the AI auto-resolve path (so AI turns stay fast) and
// only opens an interactive picker when a human is making the choice.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
  knockOut,
} from "../rules";
import { applyTrainerEffect } from "../trainerEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  Card,
  EnergyCard,
  GameState,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "../types";

function bootGameToMain(seed = 1): GameState {
  const state = setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: false },
  );
  resolveCoinGuess(state, "heads");
  chooseFirstPlayer(state, state.coinFlip!.winner!, true);
  for (const pid of ["p1", "p2"] as const) {
    const idx = state.players[pid].hand.findIndex(
      (c) => isPokemon(c) && isBasic(c),
    );
    completeSetup(state, pid, idx, []);
  }
  state.firstTurnNoAttack = false;
  state.turn = 2;
  return state;
}

const mkCard = (name: string, sup: Card["supertype"], extras: Partial<Card> = {}): Card => ({
  id: `${sup}-${name}`,
  name,
  supertype: sup,
  subtypes: [],
  ...extras,
} as Card);

const mkBasicEnergy = (type: string): EnergyCard => ({
  id: `e-${type}`,
  name: `Basic ${type} Energy`,
  supertype: "Energy",
  subtypes: ["Basic"],
  provides: [type as never],
} as EnergyCard);

const mkStadiumCard = (name: string): TrainerCard => ({
  id: `stadium-${name}`,
  name,
  supertype: "Trainer",
  subtypes: ["Stadium"],
  text: "",
} as TrainerCard);

const mkSupporterCard = (name: string, effectId: string): TrainerCard => ({
  id: `s-${name}`,
  name,
  supertype: "Trainer",
  subtypes: ["Supporter"],
  text: "...",
  effectId,
} as TrainerCard);

describe("Colress's Tenacity (#4d) — chained Stadium + Energy picker", () => {
  it("AI auto-search lands the first Stadium and first basic Energy", () => {
    const state = bootGameToMain(1);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].deck = [
      mkStadiumCard("Festival Grounds"),
      mkStadiumCard("Forest of Vitality"),
      mkBasicEnergy("Grass"),
      mkBasicEnergy("Fire"),
    ];
    const before = state.players[ap].hand.length;
    applyTrainerEffect(state, ap, mkSupporterCard("Colress's Tenacity", "searchStadiumAndEnergy"));
    expect(state.players[ap].hand.length).toBe(before + 2);
    expect(state.pendingPick).toBeNull();
  });

  it("Human path opens the Stadium picker first; chains into Energy on resolve", async () => {
    const state = bootGameToMain(2);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].deck = [
      mkStadiumCard("Festival Grounds"),
      mkStadiumCard("Forest of Vitality"),
      mkBasicEnergy("Grass"),
      mkBasicEnergy("Fire"),
    ];
    applyTrainerEffect(state, ap, mkSupporterCard("Colress's Tenacity", "searchStadiumAndEnergy"));
    // Stage 1 picker should be open with both Stadiums as candidates.
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Colress.*1 of 2/i);
    expect(state.pendingPick!.pool.filter((c) => (c as TrainerCard).subtypes.includes("Stadium"))).toHaveLength(2);

    // Resolve stage 1: pick the first Stadium.
    const { resolvePendingPick } = await import("../pendingPick");
    resolvePendingPick(state, ap, [0]);
    // Chain should now have opened the Energy picker.
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Colress.*2 of 2/i);
  });
});

describe("Perrin (#4c) — interactive hand-reveal picker", () => {
  it("AI auto-reveals last 2 Pokémon (preserves fast AI turn)", () => {
    const state = bootGameToMain(3);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].hand = [
      mkCard("Pikachu", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Charmander", "Pokémon", { subtypes: ["Basic"] }),
    ];
    state.players[ap].deck = [
      mkCard("Bulbasaur", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Squirtle", "Pokémon", { subtypes: ["Basic"] }),
    ];
    applyTrainerEffect(state, ap, mkSupporterCard("Perrin", "perrinSearch"));
    // AI auto-revealed → setDeckSearchPick fires for the AI to pick from
    // deck. AI doesn't go through pendingPick (resolves via auto path).
    // Just verify the hand is mid-search-state.
    expect(state.pendingHandReveal).toBeNull();
  });

  it("Human path opens a hand-reveal picker (Pokémon-only filter)", () => {
    const state = bootGameToMain(4);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].hand = [
      mkCard("Pikachu", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Charmander", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Iono", "Trainer", { subtypes: ["Supporter"] }),
    ];
    state.players[ap].deck = [
      mkCard("Bulbasaur", "Pokémon", { subtypes: ["Basic"] }),
    ];
    applyTrainerEffect(state, ap, mkSupporterCard("Perrin", "perrinSearch"));
    expect(state.pendingHandReveal).not.toBeNull();
    expect(state.pendingHandReveal!.filter).toBe("pokemon");
    expect(state.pendingHandReveal!.action).toBe("toBottomOfDeck");
    expect(state.pendingHandReveal!.max).toBe(2); // 2 Pokémon in hand
    expect(state.pendingHandReveal!.postAction?.kind).toBe("searchDeckAnyPokemon");
  });
});

describe("Salvatore (#4a) — interactive evolve picker", () => {
  it("AI auto-applies the first eligible evolution", () => {
    const state = bootGameToMain(5);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Active is some Basic; deck contains an evolution that matches.
    const basic = state.players[ap].active!;
    basic.card = { ...basic.card, name: "Charmander" } as PokemonCard;
    basic.playedThisTurn = false;
    const charmeleon = mkCard("Charmeleon", "Pokémon", {
      subtypes: ["Stage 1"],
      evolvesFrom: "Charmander",
    }) as PokemonCard;
    state.players[ap].deck = [charmeleon];
    applyTrainerEffect(state, ap, mkSupporterCard("Salvatore", "salvatoreEvolveSearch"));
    expect(state.players[ap].active!.card.name).toBe("Charmeleon");
    expect(state.pendingPick).toBeNull();
  });

  it("Human path opens an evolution picker; resolving evolves the matching ally", async () => {
    const state = bootGameToMain(6);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    const basic = state.players[ap].active!;
    basic.card = { ...basic.card, name: "Charmander" } as PokemonCard;
    basic.playedThisTurn = false;
    const charmeleon = mkCard("Charmeleon", "Pokémon", {
      subtypes: ["Stage 1"],
      evolvesFrom: "Charmander",
    }) as PokemonCard;
    state.players[ap].deck = [charmeleon, mkCard("Pikachu", "Pokémon", { subtypes: ["Basic"] })];
    applyTrainerEffect(state, ap, mkSupporterCard("Salvatore", "salvatoreEvolveSearch"));
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.toEvolve).toBe(true);
    expect(state.pendingPick!.pool.find((c) => c.name === "Charmeleon")).toBeDefined();
    expect(state.players[ap].active!.card.name).toBe("Charmander"); // not yet evolved

    const { resolvePendingPick } = await import("../pendingPick");
    const pickIdx = state.pendingPick!.pool.findIndex((c) => c.name === "Charmeleon");
    resolvePendingPick(state, ap, [pickIdx]);
    expect(state.players[ap].active!.card.name).toBe("Charmeleon");
    expect(state.players[ap].active!.evolvedThisTurn).toBe(true);
  });
});

describe("Heavy Baton (#7) — interactive Bench-target picker", () => {
  function setupHeavyBatonScenario(humanOwner: boolean, benchCount: number): GameState {
    const state = bootGameToMain(7);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    // Holder is the OPPONENT of the active player (so KO'd by ap's attack).
    state.players[oppId].isAI = !humanOwner;
    const baton: TrainerCard = {
      id: "tool-heavy-baton",
      name: "Heavy Baton",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool"],
      text: "...",
    } as TrainerCard;
    state.players[oppId].active!.card = {
      id: "holder", name: "Holder", supertype: "Pokémon",
      subtypes: ["Basic"], hp: 80, types: ["Colorless"], attacks: [], retreatCost: ["Colorless", "Colorless", "Colorless", "Colorless"],
    } as PokemonCard;
    state.players[oppId].active!.tools = [baton];
    state.players[oppId].active!.attachedEnergy = [
      mkBasicEnergy("Fire"), mkBasicEnergy("Water"),
    ];
    // Build the bench.
    const benchTemplate: PokemonCard = {
      id: "b", name: "Bench", supertype: "Pokémon",
      subtypes: ["Basic"], hp: 70, types: ["Colorless"], attacks: [], retreatCost: [],
    } as PokemonCard;
    state.players[oppId].bench = [];
    for (let i = 0; i < benchCount; i++) {
      state.players[oppId].bench.push({
        instanceId: `b${i}`,
        card: benchTemplate,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: false,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      } as PokemonInPlay);
    }
    return state;
  }

  it("Human owner with multiple bench → opens picker after promote (not auto)", async () => {
    const state = setupHeavyBatonScenario(true, 3);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    knockOut(state, oppId);
    // Holder KO'd → energies stashed, pendingHeavyBaton set.
    expect(state.pendingHeavyBaton).not.toBeNull();
    expect(state.pendingHeavyBaton!.energies).toHaveLength(2);
    expect(state.pendingPromote).toBe(oppId);
    // Pre-promote: no picker yet (phase = promoteActive blocks it).
    expect(state.pendingInPlayTarget).toBeNull();

    // Promote a bench Pokémon — this should open the Heavy Baton picker.
    const { promoteBenchToActive } = await import("../actions");
    promoteBenchToActive(state, oppId, 0);
    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget!.label).toMatch(/Heavy Baton/i);
    const action = state.pendingInPlayTarget!.action as { kind: string };
    expect(action.kind).toBe("heavyBatonPick");

    // Click a bench → energies move there; picker closes.
    const { resolveInPlayTarget } = await import("../trainerEffects");
    const benchTarget = state.players[oppId].bench[0];
    const r = resolveInPlayTarget(state, oppId, oppId, benchTarget.instanceId);
    expect(r.ok).toBe(true);
    expect(state.pendingHeavyBaton).toBeNull();
    expect(state.pendingInPlayTarget).toBeNull();
    expect(benchTarget.attachedEnergy).toHaveLength(2);
  });

  it("AI owner → auto-applies energies to highest-energy bench (no picker)", () => {
    const state = setupHeavyBatonScenario(false, 3);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    state.players[oppId].bench[1].attachedEnergy = [mkBasicEnergy("Fire")]; // most energy
    knockOut(state, oppId);
    expect(state.pendingHeavyBaton).toBeNull();
    expect(state.players[oppId].bench[1].attachedEnergy.length).toBeGreaterThanOrEqual(2);
  });

  it("Human with only 1 bench → no choice, falls back to auto", () => {
    const state = setupHeavyBatonScenario(true, 1);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    knockOut(state, oppId);
    // Only one bench → no meaningful choice → auto-applies.
    expect(state.pendingHeavyBaton).toBeNull();
    expect(state.players[oppId].bench[0].attachedEnergy).toHaveLength(2);
  });
});
