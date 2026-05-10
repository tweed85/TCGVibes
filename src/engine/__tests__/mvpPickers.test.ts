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
import { applyTrainerEffect, resolveHandReveal, resolveInPlayTarget } from "../trainerEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
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

describe("Crispin — interactive Energy and attachment choices", () => {
  it("Human path lets the player choose which Energy goes to hand and where the other attaches", async () => {
    const state = bootGameToMain(22);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    const active = state.players[ap].active!;
    active.card = { ...active.card, name: "Active Holder" } as PokemonCard;
    state.players[ap].bench = [
      {
        instanceId: "bench-target",
        card: mkCard("Bench Holder", "Pokémon", {
          subtypes: ["Basic"],
          hp: 80,
          types: ["Colorless"],
          attacks: [],
          retreatCost: [],
        }) as PokemonCard,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: false,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      } as PokemonInPlay,
    ];
    state.players[ap].deck = [
      mkBasicEnergy("Fire"),
      mkBasicEnergy("Water"),
      mkBasicEnergy("Psychic"),
    ];

    applyTrainerEffect(state, ap, mkSupporterCard("Crispin", "searchBasicEnergyX"));

    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Crispin.*1 of 2/i);
    expect(state.pendingPick!.pool.map((c) => c.name)).toEqual([
      "Basic Fire Energy",
      "Basic Water Energy",
      "Basic Psychic Energy",
    ]);

    const { resolvePendingPick } = await import("../pendingPick");
    const waterIdx = state.pendingPick!.pool.findIndex((c) => c.name === "Basic Water Energy");
    resolvePendingPick(state, ap, [waterIdx]);

    expect(state.players[ap].hand.map((c) => c.name)).toContain("Basic Water Energy");
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Crispin.*2 of 2/i);
    expect(state.pendingPick!.pool.map((c) => c.name)).not.toContain("Basic Water Energy");

    const fireIdx = state.pendingPick!.pool.findIndex((c) => c.name === "Basic Fire Energy");
    resolvePendingPick(state, ap, [fireIdx]);

    expect(state.pendingPick).toBeNull();
    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget!.label).toMatch(/Basic Fire Energy/);
    expect(active.attachedEnergy).toHaveLength(0);

    const r = resolveInPlayTarget(state, ap, ap, "bench-target");
    expect(r.ok).toBe(true);
    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.players[ap].bench[0].attachedEnergy.map((e) => e.name)).toEqual(["Basic Fire Energy"]);
    expect(active.attachedEnergy).toHaveLength(0);
  });

  it("AI path still resolves without opening human pickers", () => {
    const state = bootGameToMain(23);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].deck = [mkBasicEnergy("Fire"), mkBasicEnergy("Water")];

    applyTrainerEffect(state, ap, mkSupporterCard("Crispin", "searchBasicEnergyX"));

    expect(state.pendingPick).toBeNull();
    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.players[ap].hand.map((c) => c.name)).toContain("Basic Fire Energy");
    expect(state.players[ap].active!.attachedEnergy.map((e) => e.name)).toEqual(["Basic Water Energy"]);
  });
});

describe("Supporter choice audit — human choices stay interactive", () => {
  it("Kofu lets the player choose the 2 hand cards to bottom before drawing 4", () => {
    const state = bootGameToMain(24);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].hand = [
      mkCard("Keep Me", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Bottom A", "Trainer", { subtypes: ["Item"] }),
      mkCard("Bottom B", "Energy", { subtypes: ["Basic"], provides: ["Fire"] }),
    ];
    state.players[ap].deck = [
      mkCard("Draw 1", "Trainer", { subtypes: ["Item"] }),
      mkCard("Draw 2", "Trainer", { subtypes: ["Item"] }),
      mkCard("Draw 3", "Trainer", { subtypes: ["Item"] }),
      mkCard("Draw 4", "Trainer", { subtypes: ["Item"] }),
    ];

    applyTrainerEffect(state, ap, mkSupporterCard("Kofu", "kofuBottom2Draw4"));

    expect(state.pendingHandReveal).not.toBeNull();
    expect(state.pendingHandReveal!.label).toMatch(/Kofu/);
    const r = resolveHandReveal(state, ap, [1, 2]);
    expect(r.ok).toBe(true);
    expect(state.pendingHandReveal).toBeNull();
    expect(state.players[ap].hand.map((c) => c.name)).toContain("Keep Me");
    expect(state.players[ap].deck.slice(-2).map((c) => c.name)).toEqual(["Bottom A", "Bottom B"]);
  });

  it("Explorer's Guidance lets the player choose which top cards go to hand", async () => {
    const state = bootGameToMain(25);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].hand = [];
    state.players[ap].deck = [
      mkCard("Want A", "Trainer", { subtypes: ["Item"] }),
      mkCard("Discard A", "Energy", { subtypes: ["Basic"], provides: ["Fire"] }),
      mkCard("Want B", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Discard B", "Trainer", { subtypes: ["Item"] }),
      mkCard("Discard C", "Trainer", { subtypes: ["Item"] }),
      mkCard("Discard D", "Trainer", { subtypes: ["Item"] }),
    ];

    applyTrainerEffect(state, ap, mkSupporterCard("Explorer's Guidance", "top6Take2Discard4"));

    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.unpicked).toBe("discard");
    const { resolvePendingPick } = await import("../pendingPick");
    resolvePendingPick(state, ap, [0, 2]);
    expect(state.players[ap].hand.map((c) => c.name)).toEqual(["Want A", "Want B"]);
    expect(state.players[ap].discard.map((c) => c.name)).toEqual([
      "Discard A",
      "Discard B",
      "Discard C",
      "Discard D",
    ]);
  });

  it("Ciphermaniac's Codebreaking lets the player choose the two cards placed on top", async () => {
    const state = bootGameToMain(26);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].hand = [];
    state.players[ap].deck = [
      mkCard("First Choice", "Trainer", { subtypes: ["Item"] }),
      mkCard("Not This", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Second Choice", "Energy", { subtypes: ["Basic"], provides: ["Water"] }),
    ];

    applyTrainerEffect(state, ap, mkSupporterCard("Ciphermaniac's Codebreaking", "ciphermaniacSearch"));

    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.pickedDestination).toBe("topOfDeck");
    const { resolvePendingPick } = await import("../pendingPick");
    resolvePendingPick(state, ap, [0, 2]);
    expect(state.pendingPick).toBeNull();
    expect(state.players[ap].deck.slice(0, 2).map((c) => c.name)).toEqual([
      "First Choice",
      "Second Choice",
    ]);
    expect(state.players[ap].hand).toHaveLength(0);
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
    knockOut(state, oppId, { byOpponentAttack: true });
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
    knockOut(state, oppId, { byOpponentAttack: true });
    expect(state.pendingHeavyBaton).toBeNull();
    expect(state.players[oppId].bench[1].attachedEnergy.length).toBeGreaterThanOrEqual(2);
  });

  it("Human with only 1 bench → no choice, falls back to auto", () => {
    const state = setupHeavyBatonScenario(true, 1);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    knockOut(state, oppId, { byOpponentAttack: true });
    // Only one bench → no meaningful choice → auto-applies.
    expect(state.pendingHeavyBaton).toBeNull();
    expect(state.players[oppId].bench[0].attachedEnergy).toHaveLength(2);
  });
});

const mkItemCard = (name: string, effectId: string): TrainerCard => ({
  id: `i-${name}`,
  name,
  supertype: "Trainer",
  subtypes: ["Item"],
  text: "...",
  effectId,
} as TrainerCard);

describe("Precious Trolley — interactive Basic-to-bench picker", () => {
  it("AI auto-benches eligible Basics up to bench cap", () => {
    const state = bootGameToMain(40);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].bench = [];
    state.players[ap].deck = [
      mkCard("Pikachu", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Bulbasaur", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Squirtle", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Filler", "Trainer", { subtypes: ["Item"] }),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Precious Trolley", "searchAnyBasicsToBench"));
    expect(state.pendingPick).toBeNull();
    expect(state.players[ap].bench).toHaveLength(3);
  });

  it("Human path opens a deck picker with toBench:true and respects bench cap", () => {
    const state = bootGameToMain(41);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    // Bench already has 2 Pokémon → only 3 slots left.
    state.players[ap].bench = [
      {
        instanceId: "b0",
        card: mkCard("ExistingA", "Pokémon", { subtypes: ["Basic"], hp: 60, types: ["Colorless"], attacks: [], retreatCost: [] }) as PokemonCard,
        damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
        playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
      } as PokemonInPlay,
      {
        instanceId: "b1",
        card: mkCard("ExistingB", "Pokémon", { subtypes: ["Basic"], hp: 60, types: ["Colorless"], attacks: [], retreatCost: [] }) as PokemonCard,
        damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
        playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
      } as PokemonInPlay,
    ];
    state.players[ap].deck = [
      mkCard("Pikachu", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Bulbasaur", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Squirtle", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Charmander", "Pokémon", { subtypes: ["Basic"] }),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Precious Trolley", "searchAnyBasicsToBench"));
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.toBench).toBe(true);
    expect(state.pendingPick!.max).toBe(3); // 5 - 2 = 3
    expect(state.pendingPick!.min).toBe(0);
    expect(state.pendingPick!.pool).toHaveLength(4);
  });

  it("Human resolves picker with chosen Basics → only chosen ones go to bench", async () => {
    const state = bootGameToMain(42);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].bench = [];
    state.players[ap].deck = [
      mkCard("Pikachu", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Bulbasaur", "Pokémon", { subtypes: ["Basic"] }),
      mkCard("Squirtle", "Pokémon", { subtypes: ["Basic"] }),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Precious Trolley", "searchAnyBasicsToBench"));
    const { resolvePendingPick } = await import("../pendingPick");
    resolvePendingPick(state, ap, [0, 2]);
    expect(state.players[ap].bench.map((p) => p.card.name)).toEqual(["Pikachu", "Squirtle"]);
    expect(state.pendingPick).toBeNull();
  });
});

describe("Energy Search Pro — interactive different-type Energy picker", () => {
  it("AI auto-pulls one of each type", () => {
    const state = bootGameToMain(43);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].deck = [
      mkBasicEnergy("Fire"),
      mkBasicEnergy("Water"),
      mkBasicEnergy("Grass"),
      mkBasicEnergy("Fire"), // duplicate type — should not be picked
    ];
    applyTrainerEffect(state, ap, mkItemCard("Energy Search Pro", "searchEnergyVariety"));
    const handTypes = state.players[ap].hand
      .filter((c): c is EnergyCard => c.supertype === "Energy")
      .map((e) => e.provides[0]);
    expect(new Set(handTypes).size).toBe(handTypes.length);
    expect(handTypes).toContain("Fire");
    expect(handTypes).toContain("Water");
    expect(handTypes).toContain("Grass");
  });

  it("Human path opens a basic-Energy picker with uniqueByEnergyType flag", () => {
    const state = bootGameToMain(44);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].deck = [
      mkBasicEnergy("Fire"),
      mkBasicEnergy("Water"),
      mkBasicEnergy("Fire"),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Energy Search Pro", "searchEnergyVariety"));
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.pool).toHaveLength(3);
    expect(state.pendingPick!.min).toBe(0);
    expect(state.pendingPick!.uniqueByEnergyType).toBe(true);
  });

  it("Resolver rejects duplicate energy types", async () => {
    const state = bootGameToMain(45);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].deck = [
      mkBasicEnergy("Fire"),
      mkBasicEnergy("Water"),
      mkBasicEnergy("Fire"),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Energy Search Pro", "searchEnergyVariety"));
    const { resolvePendingPick } = await import("../pendingPick");
    // Try to pick two Fires (indexes 0 and 2) — should fail.
    const r = resolvePendingPick(state, ap, [0, 2]);
    expect(r.ok).toBe(false);
    // Picker still open.
    expect(state.pendingPick).not.toBeNull();
    // Valid pick (one of each type) succeeds.
    const r2 = resolvePendingPick(state, ap, [0, 1]);
    expect(r2.ok).toBe(true);
    expect(state.pendingPick).toBeNull();
  });
});

describe("Wave 2A — activated Stadium pickers", () => {
  function setStadium(state: GameState, name: string, controller: PlayerId) {
    state.stadium = { card: mkStadiumCard(name), controller };
    state.players[controller].stadiumUsedThisTurn = false;
  }

  describe("Academy at Night", () => {
    it("Human path opens hand picker (toTopOfDeck, max=1)", async () => {
      const state = bootGameToMain(60);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
        mkCard("HandB", "Trainer", { subtypes: ["Item"] }),
      ];
      setStadium(state, "Academy at Night", ap);
      const { useStadium } = await import("../stadiumActivated");
      const r = useStadium(state, ap);
      expect(r.ok).toBe(true);
      expect(state.pendingHandReveal).not.toBeNull();
      expect(state.pendingHandReveal!.action).toBe("toTopOfDeck");
      expect(state.pendingHandReveal!.max).toBe(1);
      expect(state.pendingHandReveal!.min).toBe(1);
    });

    it("Human resolver moves chosen card to top of deck", async () => {
      const state = bootGameToMain(61);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
        mkCard("HandB", "Trainer", { subtypes: ["Item"] }),
      ];
      const deckBefore = state.players[ap].deck.length;
      setStadium(state, "Academy at Night", ap);
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      // Pick HandB.
      const r = resolveHandReveal(state, ap, [1]);
      expect(r.ok).toBe(true);
      expect(state.players[ap].hand).toHaveLength(1);
      expect(state.players[ap].deck.length).toBe(deckBefore + 1);
      expect(state.players[ap].deck[0].name).toBe("HandB");
    });

    it("AI auto-picks first hand card", async () => {
      const state = bootGameToMain(62);
      const ap = state.activePlayer;
      state.players[ap].isAI = true;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
      ];
      setStadium(state, "Academy at Night", ap);
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      // AI: hand picker should NOT be open (auto-resolved or shortcut).
      // Card goes to top of deck.
      expect(state.players[ap].deck[0].name).toBe("HandA");
      expect(state.players[ap].hand).toHaveLength(0);
    });
  });

  describe("Prism Tower", () => {
    it("Human path opens hand discard picker (min=2, max=2, drawCards=1 postAction)", async () => {
      const state = bootGameToMain(63);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
        mkCard("HandB", "Trainer", { subtypes: ["Item"] }),
        mkCard("HandC", "Energy", { subtypes: ["Basic"], provides: ["Fire"] }),
      ];
      setStadium(state, "Prism Tower", ap);
      const { useStadium } = await import("../stadiumActivated");
      const r = useStadium(state, ap);
      expect(r.ok).toBe(true);
      expect(state.pendingHandReveal).not.toBeNull();
      expect(state.pendingHandReveal!.min).toBe(2);
      expect(state.pendingHandReveal!.max).toBe(2);
      expect(state.pendingHandReveal!.action).toBe("discard");
      expect(state.pendingHandReveal!.postAction?.kind).toBe("drawCards");
    });

    it("Human resolver discards chosen 2 and draws 1", async () => {
      const state = bootGameToMain(64);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
        mkCard("HandB", "Trainer", { subtypes: ["Item"] }),
        mkCard("HandC", "Energy", { subtypes: ["Basic"], provides: ["Fire"] }),
      ];
      state.players[ap].deck = [
        mkCard("DrawTop", "Trainer", { subtypes: ["Item"] }),
        mkCard("Other", "Pokémon", { subtypes: ["Basic"] }),
      ];
      setStadium(state, "Prism Tower", ap);
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      const r = resolveHandReveal(state, ap, [0, 1]);
      expect(r.ok).toBe(true);
      const handNames = state.players[ap].hand.map((c) => c.name);
      expect(handNames).toContain("HandC");
      expect(handNames).toContain("DrawTop");
      expect(handNames).not.toContain("HandA");
      expect(handNames).not.toContain("HandB");
    });
  });

  describe("Mystery Garden", () => {
    it("Human path opens hand reveal with 'energy' filter and drawUntilHand postAction", async () => {
      const state = bootGameToMain(65);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
        mkBasicEnergy("Psychic"),
      ];
      // Active is Psychic; bench has 1 Psychic.
      state.players[ap].active!.card = {
        ...state.players[ap].active!.card,
        types: ["Psychic"],
      } as PokemonCard;
      state.players[ap].bench = [
        {
          instanceId: "b0",
          card: mkCard("BenchPsy", "Pokémon", { subtypes: ["Basic"], hp: 60, types: ["Psychic"], attacks: [], retreatCost: [] }) as PokemonCard,
          damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
          playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
        } as PokemonInPlay,
      ];
      setStadium(state, "Mystery Garden", ap);
      const { useStadium } = await import("../stadiumActivated");
      const r = useStadium(state, ap);
      expect(r.ok).toBe(true);
      expect(state.pendingHandReveal).not.toBeNull();
      expect(state.pendingHandReveal!.filter).toBe("energy");
      expect(state.pendingHandReveal!.action).toBe("discard");
      expect(state.pendingHandReveal!.postAction?.kind).toBe("drawUntilHand");
      // 2 Psychic in play → targetSize 2.
      const post = state.pendingHandReveal!.postAction as { kind: string; targetSize: number };
      expect(post.targetSize).toBe(2);
    });

    it("Sequencing: discard runs first, then drawUntilHand measures remaining hand size", async () => {
      // Hand has 3 cards (1 Energy + 2 others), 2 Psychic Pokémon in play.
      // After: discard Energy → hand has 2; targetSize=2 → 0 draws → hand stays at 2.
      const state = bootGameToMain(66);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].hand = [
        mkCard("HandA", "Pokémon", { subtypes: ["Basic"] }),
        mkBasicEnergy("Psychic"),
        mkCard("HandC", "Trainer", { subtypes: ["Item"] }),
      ];
      state.players[ap].active!.card = {
        ...state.players[ap].active!.card,
        types: ["Psychic"],
      } as PokemonCard;
      state.players[ap].bench = [
        {
          instanceId: "b0",
          card: mkCard("BenchPsy", "Pokémon", { subtypes: ["Basic"], hp: 60, types: ["Psychic"], attacks: [], retreatCost: [] }) as PokemonCard,
          damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
          playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
        } as PokemonInPlay,
      ];
      state.players[ap].deck = [
        mkCard("DeckTop", "Pokémon", { subtypes: ["Basic"] }),
      ];
      setStadium(state, "Mystery Garden", ap);
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      // Discard the Energy at index 1.
      resolveHandReveal(state, ap, [1]);
      // After discard: 2 cards. Draw until size = 2 (psychic count) → 0 draws.
      expect(state.players[ap].hand).toHaveLength(2);
      expect(state.players[ap].deck).toHaveLength(1);
      expect(state.players[ap].discard.map((c) => c.name)).toContain("Basic Psychic Energy");
    });
  });

  describe("Levincia", () => {
    it("Human path opens discard recovery picker (max=2, basic Lightning)", async () => {
      const state = bootGameToMain(67);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].discard = [
        mkBasicEnergy("Lightning"),
        mkCard("Other", "Trainer", { subtypes: ["Item"] }),
        mkBasicEnergy("Lightning"),
        mkBasicEnergy("Fire"),
      ];
      setStadium(state, "Levincia", ap);
      const { useStadium } = await import("../stadiumActivated");
      const r = useStadium(state, ap);
      expect(r.ok).toBe(true);
      expect(state.pendingPick).not.toBeNull();
      expect(state.pendingPick!.source).toBe("discard");
      expect(state.pendingPick!.pool.map((c) => c.name)).toEqual([
        "Basic Lightning Energy",
        "Basic Lightning Energy",
      ]);
      expect(state.pendingPick!.max).toBe(2);
    });
  });
});

describe("Wave 2B — harder Stadium fixes", () => {
  function setStadium(state: GameState, name: string, controller: PlayerId) {
    state.stadium = { card: mkStadiumCard(name), controller };
    state.players[controller].stadiumUsedThisTurn = false;
  }
  const mkPokemonInPlay = (
    name: string,
    overrides: Partial<PokemonCard> = {},
    instanceId = `inst-${name}`,
  ): PokemonInPlay => ({
    instanceId,
    card: mkCard(name, "Pokémon", {
      subtypes: ["Basic"],
      hp: 80,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
      ...overrides,
    }) as PokemonCard,
    damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
    playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
  } as PokemonInPlay);

  describe("Surfing Beach", () => {
    it("Human with multiple Water bench → opens picker (not auto)", async () => {
      const state = bootGameToMain(70);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("ActiveWater", { types: ["Water"] }, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("WaterA", { types: ["Water"] }, "wa"),
        mkPokemonInPlay("DryFire", { types: ["Fire"] }, "df"),
        mkPokemonInPlay("WaterB", { types: ["Water"] }, "wb"),
      ];
      setStadium(state, "Surfing Beach", ap);
      const { useStadium } = await import("../stadiumActivated");
      const r = useStadium(state, ap);
      expect(r.ok).toBe(true);
      expect(state.pendingInPlayTarget).not.toBeNull();
      const action = state.pendingInPlayTarget!.action as { kind: string };
      expect(action.kind).toBe("surfingBeachSwitch");
      expect(state.pendingInPlayTarget!.scope).toBe("own");
      expect(state.pendingInPlayTarget!.slot).toBe("bench");
    });

    it("Resolver rejects non-Water bench targets and switches Water ones", async () => {
      const state = bootGameToMain(71);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("ActiveWater", { types: ["Water"] }, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("WaterA", { types: ["Water"] }, "wa"),
        mkPokemonInPlay("DryFire", { types: ["Fire"] }, "df"),
        mkPokemonInPlay("WaterB", { types: ["Water"] }, "wb"),
      ];
      setStadium(state, "Surfing Beach", ap);
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      // Try the Fire bench → reject.
      const reject = resolveInPlayTarget(state, ap, ap, "df");
      expect(reject.ok).toBe(false);
      expect(state.pendingInPlayTarget).not.toBeNull();
      // Now click a Water bench → switch.
      const ok = resolveInPlayTarget(state, ap, ap, "wb");
      expect(ok.ok).toBe(true);
      expect(state.players[ap].active!.instanceId).toBe("wb");
      expect(state.pendingInPlayTarget).toBeNull();
    });

    it("AI auto-picks first Water bench", async () => {
      const state = bootGameToMain(72);
      const ap = state.activePlayer;
      state.players[ap].isAI = true;
      state.players[ap].active = mkPokemonInPlay("ActiveWater", { types: ["Water"] }, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("WaterA", { types: ["Water"] }, "wa"),
      ];
      setStadium(state, "Surfing Beach", ap);
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      expect(state.pendingInPlayTarget).toBeNull();
      expect(state.players[ap].active!.instanceId).toBe("wa");
    });
  });

  describe("Grand Tree", () => {
    it("First-turn gate uses isPlayersFirstTurn (not state.turn === 1)", async () => {
      // Set up a state where state.turn !== 1 but it's still the active
      // player's first turn (going-second's first turn is engine turn 2).
      const state = bootGameToMain(73);
      const ap = state.activePlayer;
      // Manually rewind to a "going-second's first turn" scenario.
      state.firstPlayer = ap === "p1" ? "p2" : "p1";
      state.turn = 2;
      // Active is a Basic with a Stage 1 in deck.
      state.players[ap].active = mkPokemonInPlay("Charmander", { evolvesFrom: undefined }, "char");
      state.players[ap].deck = [
        mkCard("Charmeleon", "Pokémon", { subtypes: ["Stage 1"], evolvesFrom: "Charmander" }),
      ];
      setStadium(state, "Grand Tree", ap);
      const { precheckStadium } = await import("../stadiumActivated");
      const pre = precheckStadium(state, ap);
      expect(pre.ok).toBe(false);
      if (!pre.ok) expect(pre.reason).toMatch(/first turn/i);
    });

    it("Human path opens picker for Basic target (multi-step chain)", async () => {
      const state = bootGameToMain(74);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      // Two evolve-eligible Basics with the same name.
      state.players[ap].active = mkPokemonInPlay("Charmander", {}, "act-char");
      state.players[ap].active!.playedThisTurn = false;
      state.players[ap].bench = [
        mkPokemonInPlay("Charmander", {}, "bench-char"),
      ];
      state.players[ap].bench[0].playedThisTurn = false;
      state.players[ap].deck = [
        mkCard("Charmeleon", "Pokémon", { subtypes: ["Stage 1"], evolvesFrom: "Charmander" }),
      ];
      setStadium(state, "Grand Tree", ap);
      // Force engine into a non-first-turn state.
      state.firstTurnNoAttack = false;
      state.turn = 3;
      state.firstPlayer = ap;
      const { useStadium } = await import("../stadiumActivated");
      const r = useStadium(state, ap);
      expect(r.ok).toBe(true);
      expect(state.pendingInPlayTarget).not.toBeNull();
      const action = state.pendingInPlayTarget!.action as { kind: string };
      expect(action.kind).toBe("grandTreeBasicTarget");
    });

    it("Chain evolves the chosen Basic instance, not the first matching ally", async () => {
      const state = bootGameToMain(75);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("Charmander", {}, "act-char");
      state.players[ap].active!.playedThisTurn = false;
      state.players[ap].bench = [
        mkPokemonInPlay("Charmander", {}, "bench-char"),
      ];
      state.players[ap].bench[0].playedThisTurn = false;
      state.players[ap].deck = [
        mkCard("Charmeleon", "Pokémon", { subtypes: ["Stage 1"], evolvesFrom: "Charmander" }),
      ];
      setStadium(state, "Grand Tree", ap);
      state.firstTurnNoAttack = false;
      state.turn = 3;
      state.firstPlayer = ap;
      const { useStadium } = await import("../stadiumActivated");
      useStadium(state, ap);
      // Pick the Bench Charmander (NOT the active first match).
      resolveInPlayTarget(state, ap, ap, "bench-char");
      // Now a deck-search picker is open for Stage 1.
      expect(state.pendingPick).not.toBeNull();
      const { resolvePendingPick } = await import("../pendingPick");
      resolvePendingPick(state, ap, [0]);
      // Only the Bench instance should be evolved.
      expect(state.players[ap].active!.card.name).toBe("Charmander");
      expect(state.players[ap].bench[0].card.name).toBe("Charmeleon");
      // Side effects applied — evolvedThisTurn flag set.
      expect(state.players[ap].bench[0].evolvedThisTurn).toBe(true);
    });
  });

  describe("Ange Floette", () => {
    it("Cannot be played unless current Stadium is Prism Tower", async () => {
      const state = bootGameToMain(76);
      const ap = state.activePlayer;
      // Current Stadium is Festival Grounds.
      setStadium(state, "Festival Grounds", ap);
      const angeFloette: TrainerCard = {
        id: "stadium-ange-floette",
        name: "Ange Floette",
        supertype: "Trainer",
        subtypes: ["Stadium"],
        text: "...",
      } as TrainerCard;
      state.players[ap].hand.push(angeFloette);
      const handIndex = state.players[ap].hand.length - 1;
      const { playTrainer } = await import("../actions");
      const r = playTrainer(state, ap, handIndex);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Prism Tower/i);
    });

    it("Can be played when Prism Tower is in play (replaces it)", async () => {
      const state = bootGameToMain(77);
      const ap = state.activePlayer;
      setStadium(state, "Prism Tower", ap);
      const angeFloette: TrainerCard = {
        id: "stadium-ange-floette",
        name: "Ange Floette",
        supertype: "Trainer",
        subtypes: ["Stadium"],
        text: "...",
      } as TrainerCard;
      state.players[ap].hand.push(angeFloette);
      const handIndex = state.players[ap].hand.length - 1;
      const { playTrainer } = await import("../actions");
      const r = playTrainer(state, ap, handIndex);
      expect(r.ok).toBe(true);
      expect(state.stadium!.card.name).toBe("Ange Floette");
      // Prism Tower goes to its controller's discard.
      expect(state.players[ap].discard.map((c) => c.name)).toContain("Prism Tower");
    });
  });
});

describe("Prime Catcher — chained gust + optional self-switch picker", () => {
  function setupPrimeCatcherScenario(opts: { humanGust: boolean; ownBench: number; oppBench: number }): GameState {
    const state = bootGameToMain(50);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    state.players[ap].isAI = !opts.humanGust;
    state.players[oppId].isAI = true; // opp side doesn't matter
    const mkBench = (name: string, hp: number): PokemonInPlay => ({
      instanceId: `inst-${name}`,
      card: mkCard(name, "Pokémon", { subtypes: ["Basic"], hp, types: ["Colorless"], attacks: [], retreatCost: [] }) as PokemonCard,
      damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
      playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
    } as PokemonInPlay);
    state.players[ap].bench = [];
    for (let i = 0; i < opts.ownBench; i++) {
      state.players[ap].bench.push(mkBench(`OwnBench${i}`, 70 + i * 10));
    }
    state.players[oppId].bench = [];
    for (let i = 0; i < opts.oppBench; i++) {
      state.players[oppId].bench.push(mkBench(`OppBench${i}`, 60 + i * 20));
    }
    return state;
  }

  it("AI auto-picks gust + self-switch", () => {
    const state = setupPrimeCatcherScenario({ humanGust: false, ownBench: 2, oppBench: 2 });
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    const oppActiveBefore = state.players[oppId].active!.card.name;
    applyTrainerEffect(state, ap, mkItemCard("Prime Catcher", "primeCatcher"));
    expect(state.pendingInPlayTarget).toBeNull();
    // Opp Active changed (gusted highest-HP bench in).
    expect(state.players[oppId].active!.card.name).not.toBe(oppActiveBefore);
  });

  it("Human with 2+ opp bench → opens gust picker first; self-switch picker chains after", async () => {
    const state = setupPrimeCatcherScenario({ humanGust: true, ownBench: 2, oppBench: 2 });
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    applyTrainerEffect(state, ap, mkItemCard("Prime Catcher", "primeCatcher"));
    expect(state.pendingInPlayTarget).not.toBeNull();
    const action1 = state.pendingInPlayTarget!.action as { kind: string };
    expect(action1.kind).toBe("primeCatcherGust");
    expect(state.pendingInPlayTarget!.scope).toBe("opp");

    // Resolve gust on opp bench[1].
    const oppBenchTarget = state.players[oppId].bench[1];
    const r = resolveInPlayTarget(state, ap, oppId, oppBenchTarget.instanceId);
    expect(r.ok).toBe(true);
    expect(state.players[oppId].active).not.toBeNull();
    expect(state.players[oppId].active!.instanceId).toBe(oppBenchTarget.instanceId);

    // Self-switch picker should chain.
    expect(state.pendingInPlayTarget).not.toBeNull();
    const action2 = state.pendingInPlayTarget!.action as { kind: string };
    expect(action2.kind).toBe("primeCatcherSelfSwitch");
    expect(state.pendingInPlayTarget!.scope).toBe("own");
  });

  it("Skip command clears self-switch picker without affecting gust", async () => {
    const state = setupPrimeCatcherScenario({ humanGust: true, ownBench: 2, oppBench: 2 });
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    applyTrainerEffect(state, ap, mkItemCard("Prime Catcher", "primeCatcher"));
    const oppBenchTarget = state.players[oppId].bench[1];
    resolveInPlayTarget(state, ap, oppId, oppBenchTarget.instanceId);
    // Now skip the self-switch.
    const oldOwnActive = state.players[ap].active!.instanceId;
    const { skipPrimeCatcherSelfSwitch } = await import("../trainerEffects");
    const r = skipPrimeCatcherSelfSwitch(state, ap);
    expect(r.ok).toBe(true);
    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.players[ap].active!.instanceId).toBe(oldOwnActive);
  });

  it("Empty own bench → no self-switch step opens", () => {
    const state = setupPrimeCatcherScenario({ humanGust: true, ownBench: 0, oppBench: 2 });
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    applyTrainerEffect(state, ap, mkItemCard("Prime Catcher", "primeCatcher"));
    expect(state.pendingInPlayTarget).not.toBeNull();
    const oppBenchTarget = state.players[oppId].bench[0];
    resolveInPlayTarget(state, ap, oppId, oppBenchTarget.instanceId);
    expect(state.pendingInPlayTarget).toBeNull();
  });
});

describe("Wave 1B — Item picker shape changes", () => {
  const mkItemCard = (name: string, effectId: string): TrainerCard => ({
    id: `i-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Item"],
    text: "...",
    effectId,
  } as TrainerCard);
  const mkPokemonInPlay = (
    name: string,
    overrides: Partial<PokemonCard> = {},
    instanceId = `inst-${name}`,
  ): PokemonInPlay => ({
    instanceId,
    card: mkCard(name, "Pokémon", {
      subtypes: ["Basic"],
      hp: 80,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
      ...overrides,
    }) as PokemonCard,
    damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [],
    playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
  } as PokemonInPlay);

  describe("Glass Trumpet", () => {
    it("Human path opens discard picker first; energies never touch hand", async () => {
      const state = bootGameToMain(80);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      // Active is non-Tera; bench has Tera + Colorless options.
      state.players[ap].active = mkPokemonInPlay("ActiveTera", { subtypes: ["Basic", "Tera"] }, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("ColorlessA", { types: ["Colorless"] }, "ca"),
        mkPokemonInPlay("ColorlessB", { types: ["Colorless"] }, "cb"),
      ];
      state.players[ap].discard = [
        mkBasicEnergy("Fire"),
        mkBasicEnergy("Grass"),
      ];
      const handBefore = state.players[ap].hand.slice();
      applyTrainerEffect(state, ap, mkItemCard("Glass Trumpet", "glassTrumpet"));
      // Discard recovery picker is open.
      expect(state.pendingPick).not.toBeNull();
      expect(state.pendingPick!.source).toBe("discard");
      expect(state.pendingPick!.max).toBe(2);
      // Pick both Energies.
      const { resolvePendingPick } = await import("../pendingPick");
      resolvePendingPick(state, ap, [0, 1]);
      // Energies are stashed in pendingAttachQueue, NOT in hand.
      expect(state.pendingAttachQueue).not.toBeNull();
      expect(state.pendingAttachQueue!.energies).toHaveLength(2);
      expect(state.players[ap].hand.length).toBe(handBefore.length);
      // Bench attach picker is open.
      expect(state.pendingInPlayTarget).not.toBeNull();
      const action = state.pendingInPlayTarget!.action as { kind: string; remaining: number };
      expect(action.kind).toBe("glassTrumpetAttach");
      expect(action.remaining).toBe(2);
    });

    it("Each click attaches one Energy; picker closes after queue drains", async () => {
      const state = bootGameToMain(81);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("ActiveTera", { subtypes: ["Basic", "Tera"] }, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("ColorlessA", { types: ["Colorless"] }, "ca"),
        mkPokemonInPlay("ColorlessB", { types: ["Colorless"] }, "cb"),
      ];
      state.players[ap].discard = [
        mkBasicEnergy("Fire"),
        mkBasicEnergy("Grass"),
      ];
      applyTrainerEffect(state, ap, mkItemCard("Glass Trumpet", "glassTrumpet"));
      const { resolvePendingPick } = await import("../pendingPick");
      resolvePendingPick(state, ap, [0, 1]);
      // Click ColorlessA: gets one energy.
      resolveInPlayTarget(state, ap, ap, "ca");
      expect(state.pendingInPlayTarget).not.toBeNull();
      // Click ColorlessB: gets the other energy.
      resolveInPlayTarget(state, ap, ap, "cb");
      expect(state.pendingInPlayTarget).toBeNull();
      expect(state.pendingAttachQueue).toBeNull();
      const a = state.players[ap].bench.find((p) => p.instanceId === "ca")!;
      const b = state.players[ap].bench.find((p) => p.instanceId === "cb")!;
      expect(a.attachedEnergy).toHaveLength(1);
      expect(b.attachedEnergy).toHaveLength(1);
    });

    it("Resolver rejects non-Colorless bench targets", async () => {
      const state = bootGameToMain(82);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("ActiveTera", { subtypes: ["Basic", "Tera"] }, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("FireBench", { types: ["Fire"] }, "fb"),
        mkPokemonInPlay("ColorlessA", { types: ["Colorless"] }, "ca"),
      ];
      state.players[ap].discard = [mkBasicEnergy("Fire")];
      applyTrainerEffect(state, ap, mkItemCard("Glass Trumpet", "glassTrumpet"));
      const { resolvePendingPick } = await import("../pendingPick");
      resolvePendingPick(state, ap, [0]);
      const reject = resolveInPlayTarget(state, ap, ap, "fb");
      expect(reject.ok).toBe(false);
    });
  });

  describe("Scramble Switch", () => {
    it("Human with multiple bench → opens switch-target picker", () => {
      const state = bootGameToMain(83);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("OldActive", {}, "act");
      state.players[ap].active!.attachedEnergy = [
        mkBasicEnergy("Fire"),
        mkBasicEnergy("Water"),
      ];
      state.players[ap].bench = [
        mkPokemonInPlay("BenchA", {}, "ba"),
        mkPokemonInPlay("BenchB", {}, "bb"),
      ];
      applyTrainerEffect(state, ap, mkItemCard("Scramble Switch", "scrambleSwitch"));
      expect(state.pendingInPlayTarget).not.toBeNull();
      const action = state.pendingInPlayTarget!.action as { kind: string };
      expect(action.kind).toBe("scrambleSwitchTarget");
      expect(state.pendingInPlayTarget!.scope).toBe("own");
      expect(state.pendingInPlayTarget!.slot).toBe("bench");
    });

    it("Resolver switches chosen bench and moves all energy (interim approximation)", () => {
      const state = bootGameToMain(84);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("OldActive", {}, "act");
      state.players[ap].active!.attachedEnergy = [
        mkBasicEnergy("Fire"),
        mkBasicEnergy("Water"),
      ];
      state.players[ap].bench = [
        mkPokemonInPlay("BenchA", {}, "ba"),
        mkPokemonInPlay("BenchB", {}, "bb"),
      ];
      applyTrainerEffect(state, ap, mkItemCard("Scramble Switch", "scrambleSwitch"));
      // Click BenchB → switch + move all energies.
      const r = resolveInPlayTarget(state, ap, ap, "bb");
      expect(r.ok).toBe(true);
      expect(state.players[ap].active!.instanceId).toBe("bb");
      expect(state.players[ap].active!.attachedEnergy).toHaveLength(2);
      const oldOnBench = state.players[ap].bench.find((p) => p.instanceId === "act");
      expect(oldOnBench!.attachedEnergy).toHaveLength(0);
      expect(state.pendingInPlayTarget).toBeNull();
    });

    it("AI keeps the existing bench[0] auto-switch", () => {
      const state = bootGameToMain(85);
      const ap = state.activePlayer;
      state.players[ap].isAI = true;
      state.players[ap].active = mkPokemonInPlay("OldActive", {}, "act");
      state.players[ap].bench = [
        mkPokemonInPlay("BenchA", {}, "ba"),
      ];
      applyTrainerEffect(state, ap, mkItemCard("Scramble Switch", "scrambleSwitch"));
      expect(state.pendingInPlayTarget).toBeNull();
      expect(state.players[ap].active!.instanceId).toBe("ba");
    });
  });
});

describe("Wave 3A — Handheld Fan defender-prompt lane", () => {
  const mkPokemonInPlay = (
    name: string,
    overrides: Partial<PokemonCard> = {},
    instanceId = `inst-${name}`,
  ): PokemonInPlay => ({
    instanceId,
    card: mkCard(name, "Pokémon", {
      subtypes: ["Basic"],
      hp: 80,
      types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10 }],
      retreatCost: [],
      ...overrides,
    }) as PokemonCard,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  } as PokemonInPlay);

  function setupHandheldFanScenario(opts: { humanDefender: boolean; attackerBench: number }): {
    state: GameState;
    attacker: PlayerId;
    defender: PlayerId;
  } {
    const state = bootGameToMain(90);
    const attacker = state.activePlayer;
    const defender: PlayerId = attacker === "p1" ? "p2" : "p1";
    state.players[defender].isAI = !opts.humanDefender;
    // Attacker active with attached Colorless energy, plus N bench Pokémon.
    const atk = mkPokemonInPlay("Attacker", { hp: 200 }, "atk");
    atk.attachedEnergy = [
      { id: "e-c1", name: "Basic Colorless Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Colorless"] } as EnergyCard,
      { id: "e-f1", name: "Basic Fire Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Fire"] } as EnergyCard,
    ];
    state.players[attacker].active = atk;
    state.players[attacker].bench = [];
    for (let i = 0; i < opts.attackerBench; i++) {
      state.players[attacker].bench.push(mkPokemonInPlay(`AttackerBench${i}`, {}, `ab${i}`));
    }
    // Defender holds a Pokémon with Handheld Fan.
    const def = mkPokemonInPlay("Defender", { hp: 80 }, "def");
    def.tools = [
      { id: "tool-handheld-fan", name: "Handheld Fan", supertype: "Trainer", subtypes: ["Pokémon Tool"], text: "..." } as TrainerCard,
    ];
    state.players[defender].active = def;
    state.players[defender].bench = [
      mkPokemonInPlay("DefenderBench", {}, "defb"),
    ];
    return { state, attacker, defender };
  }

  it("AI defender keeps the auto-move (no picker)", async () => {
    const { state, attacker } = setupHandheldFanScenario({ humanDefender: false, attackerBench: 2 });
    const { attack } = await import("../actions");
    const r = attack(state, attacker, 0);
    expect(r.ok).toBe(true);
    expect(state.pendingHandheldFan).toBeNull();
    // Attacker's bench[0] received an Energy (auto-pick).
    expect(state.players[attacker].bench[0].attachedEnergy.length).toBe(1);
    // Attacker's Active lost an Energy.
    expect(state.players[attacker].active!.attachedEnergy.length).toBe(1);
  });

  it("Single attacker bench → auto-move (no choice to make)", async () => {
    const { state, attacker } = setupHandheldFanScenario({ humanDefender: true, attackerBench: 1 });
    const { attack } = await import("../actions");
    const r = attack(state, attacker, 0);
    expect(r.ok).toBe(true);
    expect(state.pendingHandheldFan).toBeNull();
    expect(state.players[attacker].bench[0].attachedEnergy.length).toBe(1);
  });

  it("Human defender + multi-bench → picker pauses attacker's turn end", async () => {
    const { state, attacker, defender } = setupHandheldFanScenario({ humanDefender: true, attackerBench: 2 });
    const turnBefore = state.turn;
    const activeBefore = state.activePlayer;
    const { attack } = await import("../actions");
    attack(state, attacker, 0);
    // Picker is open for the defender; turn has NOT advanced.
    expect(state.pendingHandheldFan).not.toBeNull();
    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget!.player).toBe(defender);
    const action = state.pendingInPlayTarget!.action as { kind: string };
    expect(action.kind).toBe("handheldFanPick");
    expect(state.activePlayer).toBe(activeBefore);
    expect(state.turn).toBe(turnBefore);
    // Energy is still on the attacker's Active (auto-move was deferred).
    expect(state.players[attacker].active!.attachedEnergy.length).toBe(2);
  });

  it("Defender resolves picker → energy moves to chosen bench, attacker's turn ends", async () => {
    const { state, attacker, defender } = setupHandheldFanScenario({ humanDefender: true, attackerBench: 2 });
    const { attack } = await import("../actions");
    attack(state, attacker, 0);
    // Defender clicks attacker's bench[1].
    const r = resolveInPlayTarget(state, defender, attacker, "ab1");
    expect(r.ok).toBe(true);
    expect(state.pendingHandheldFan).toBeNull();
    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.players[attacker].bench[1].attachedEnergy.length).toBe(1);
    expect(state.players[attacker].active!.attachedEnergy.length).toBe(1);
    // Turn advanced to defender.
    expect(state.activePlayer).toBe(defender);
  });

  it("Resolver rejects clicks on the attacker's Active", async () => {
    const { state, attacker, defender } = setupHandheldFanScenario({ humanDefender: true, attackerBench: 2 });
    const { attack } = await import("../actions");
    attack(state, attacker, 0);
    // Click attacker's Active → reject (must be bench).
    const r = resolveInPlayTarget(state, defender, attacker, "atk");
    expect(r.ok).toBe(false);
    // Picker still open.
    expect(state.pendingInPlayTarget).not.toBeNull();
  });
});

describe("Wave 3B — Powerglass + Amulet of Hope", () => {
  const mkToolCard = (name: string): TrainerCard => ({
    id: `tool-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "...",
  } as TrainerCard);
  const mkPokemonInPlay = (
    name: string,
    overrides: Partial<PokemonCard> = {},
    instanceId = `inst-${name}`,
  ): PokemonInPlay => ({
    instanceId,
    card: mkCard(name, "Pokémon", {
      subtypes: ["Basic"],
      hp: 80,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
      ...overrides,
    }) as PokemonCard,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  } as PokemonInPlay);

  describe("Powerglass", () => {
    it("Human + Basic Energy in discard → endTurn pauses on optional picker", async () => {
      const state = bootGameToMain(100);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("Holder", {}, "act");
      state.players[ap].active!.tools = [mkToolCard("Powerglass")];
      state.players[ap].discard = [
        mkBasicEnergy("Fire"),
        mkBasicEnergy("Water"),
      ];
      const { endTurn } = await import("../actions");
      endTurn(state, ap);
      // Picker is open over the basic Energy in discard.
      expect(state.pendingPick).not.toBeNull();
      expect(state.pendingPick!.source).toBe("discard");
      expect(state.pendingPick!.min).toBe(0);
      expect(state.pendingPick!.max).toBe(1);
      // Turn has NOT advanced yet.
      expect(state.activePlayer).toBe(ap);
    });

    it("Resolving picker with chosen Energy attaches it; turn finishes", async () => {
      const state = bootGameToMain(101);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("Holder", {}, "act");
      state.players[ap].active!.tools = [mkToolCard("Powerglass")];
      state.players[ap].discard = [mkBasicEnergy("Fire")];
      const { endTurn } = await import("../actions");
      endTurn(state, ap);
      const { resolvePendingPick } = await import("../pendingPick");
      resolvePendingPick(state, ap, [0]);
      // Energy attached to Active.
      expect(state.players[ap].active!.attachedEnergy.map((e) => e.name)).toContain("Basic Fire Energy");
      // Turn advanced.
      expect(state.activePlayer).not.toBe(ap);
    });

    it("Resolving picker with no pick (decline) leaves Energy in discard; turn finishes", async () => {
      const state = bootGameToMain(102);
      const ap = state.activePlayer;
      state.players[ap].isAI = false;
      state.players[ap].active = mkPokemonInPlay("Holder", {}, "act");
      state.players[ap].active!.tools = [mkToolCard("Powerglass")];
      state.players[ap].discard = [mkBasicEnergy("Fire")];
      const { endTurn } = await import("../actions");
      endTurn(state, ap);
      const { resolvePendingPick } = await import("../pendingPick");
      resolvePendingPick(state, ap, []);
      // Energy stayed in discard.
      expect(state.players[ap].discard.map((c) => c.name)).toContain("Basic Fire Energy");
      expect(state.players[ap].active!.attachedEnergy).toHaveLength(0);
      // Turn advanced.
      expect(state.activePlayer).not.toBe(ap);
    });

    it("AI keeps the existing first-Energy auto-attach (no picker)", async () => {
      const state = bootGameToMain(103);
      const ap = state.activePlayer;
      state.players[ap].isAI = true;
      state.players[ap].active = mkPokemonInPlay("Holder", {}, "act");
      state.players[ap].active!.tools = [mkToolCard("Powerglass")];
      state.players[ap].discard = [mkBasicEnergy("Fire")];
      const { endTurn } = await import("../actions");
      endTurn(state, ap);
      expect(state.pendingPick).toBeNull();
      expect(state.players[ap].active!.attachedEnergy.map((e) => e.name)).toContain("Basic Fire Energy");
      expect(state.activePlayer).not.toBe(ap);
    });
  });

  describe("Amulet of Hope", () => {
    it("Human owner: KO opens deck-search picker after promote (max 3)", async () => {
      const state = bootGameToMain(110);
      const ap = state.activePlayer;
      const oppId: PlayerId = ap === "p1" ? "p2" : "p1";
      state.players[oppId].isAI = false;
      // Holder is the opponent's Active (will be KO'd by ap's attack).
      const holder = mkPokemonInPlay("Holder", { hp: 30 }, "holder");
      holder.tools = [mkToolCard("Amulet of Hope")];
      state.players[oppId].active = holder;
      state.players[oppId].bench = [
        mkPokemonInPlay("Bench0", {}, "b0"),
      ];
      state.players[oppId].deck = [
        mkCard("DeckA", "Trainer", { subtypes: ["Item"] }),
        mkCard("DeckB", "Pokémon", { subtypes: ["Basic"] }),
        mkCard("DeckC", "Energy", { subtypes: ["Basic"], provides: ["Fire"] }),
        mkCard("DeckD", "Trainer", { subtypes: ["Supporter"] }),
      ];
      // KO via opponent attack.
      knockOut(state, oppId, { byOpponentAttack: true });
      // Promote drains the queue; pendingAmuletOfHope stashed.
      expect(state.pendingPromote).toBe(oppId);
      const { promoteBenchToActive } = await import("../actions");
      promoteBenchToActive(state, oppId, 0);
      // After promote, Amulet of Hope picker should open.
      expect(state.pendingPick).not.toBeNull();
      expect(state.pendingPick!.player).toBe(oppId);
      expect(state.pendingPick!.max).toBe(3);
    });

    it("AI owner: KO auto-searches with priority sort (no picker)", async () => {
      const state = bootGameToMain(111);
      const ap = state.activePlayer;
      const oppId: PlayerId = ap === "p1" ? "p2" : "p1";
      state.players[oppId].isAI = true;
      const holder = mkPokemonInPlay("Holder", { hp: 30 }, "holder");
      holder.tools = [mkToolCard("Amulet of Hope")];
      state.players[oppId].active = holder;
      state.players[oppId].bench = [
        mkPokemonInPlay("Bench0", {}, "b0"),
      ];
      state.players[oppId].deck = [
        mkCard("DeckA", "Trainer", { subtypes: ["Item"] }),
        mkCard("DeckB", "Pokémon", { subtypes: ["Basic"] }),
        mkCard("DeckC", "Trainer", { subtypes: ["Supporter"] }),
      ];
      const handBefore = state.players[oppId].hand.length;
      knockOut(state, oppId, { byOpponentAttack: true });
      const { promoteBenchToActive } = await import("../actions");
      promoteBenchToActive(state, oppId, 0);
      // No picker — AI auto-search added 3 cards.
      expect(state.pendingPick).toBeNull();
      expect(state.players[oppId].hand.length).toBe(handBefore + 3);
    });
  });
});
