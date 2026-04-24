// Unit tests for energy-cost matching. The rulebook specifies: specific-type
// slots in a cost must be paid by Energy providing that exact type; Colorless
// slots can be paid by any Energy.

import { describe, it, expect } from "vitest";
import { canPayCost, effectiveEnergyProvides } from "../rules";
import { findByName } from "../../data/cards";
import type { EnergyCard, PokemonCard } from "../types";

describe("canPayCost", () => {
  it("empty cost is always payable", () => {
    expect(canPayCost([], [])).toBe(true);
    expect(canPayCost(["Grass"], [])).toBe(true);
  });

  it("specific Energy satisfies same-type cost", () => {
    expect(canPayCost(["Grass"], ["Grass"])).toBe(true);
    expect(canPayCost(["Fire", "Fire"], ["Fire", "Fire"])).toBe(true);
  });

  it("wrong type fails specific cost", () => {
    expect(canPayCost(["Water"], ["Grass"])).toBe(false);
  });

  it("Colorless slot pays with any type", () => {
    expect(canPayCost(["Grass"], ["Colorless"])).toBe(true);
    expect(canPayCost(["Fire", "Water"], ["Colorless", "Colorless"])).toBe(true);
  });

  it("mixed costs: specifics matched first, colorless pays the remainder", () => {
    // 1 Grass + 1 Colorless cost; provided Grass + Fire
    expect(canPayCost(["Grass", "Fire"], ["Grass", "Colorless"])).toBe(true);
    // Provided Grass + Grass; Grass + Colorless cost — second Grass pays Colorless
    expect(canPayCost(["Grass", "Grass"], ["Grass", "Colorless"])).toBe(true);
  });

  it("insufficient count fails", () => {
    expect(canPayCost(["Grass"], ["Grass", "Colorless"])).toBe(false);
    expect(canPayCost([], ["Colorless"])).toBe(false);
  });

  it("extra attached energy is fine", () => {
    expect(canPayCost(["Grass", "Grass", "Grass"], ["Grass"])).toBe(true);
  });
});

describe("enforceSpecialEnergyAttachRules — Team Rocket's Energy gate", () => {
  it("discards TRE from a non-Team-Rocket's Pokémon", async () => {
    const { enforceSpecialEnergyAttachRules } = await import("../rules");
    const { setupGame } = await import("../rules");
    const { makeRng } = await import("../rng");
    const { buildDeck, DECK_SPECS } = await import("../../data/decks");
    const { findByName } = await import("../../data/cards");
    const rng = makeRng(1);
    // Use any two decks — we won't run setup.
    const p1Deck = buildDeck(DECK_SPECS[0]);
    const p2Deck = buildDeck(DECK_SPECS[0]);
    const state = setupGame(p1Deck, p2Deck, rng);
    const pl = state.players.p1;
    const nonTrPoke = findByName("Miraidon ex");
    const tre = findByName("Team Rocket's Energy");
    if (!nonTrPoke || !tre) throw new Error("required cards not in pool");
    // Simulate a non-TR Pokémon with TRE attached (bypass legal attach).
    const { makePokemonInPlay } = await import("../rules");
    const inPlay = makePokemonInPlay(nonTrPoke as import("../types").PokemonCard);
    inPlay.attachedEnergy.push(tre as import("../types").EnergyCard);
    pl.bench.push(inPlay);
    enforceSpecialEnergyAttachRules(state);
    expect(inPlay.attachedEnergy).toHaveLength(0);
    expect(pl.discard.some((c) => c.name === "Team Rocket's Energy")).toBe(true);
  });

  it("leaves TRE attached to a Team Rocket's Pokémon", async () => {
    const { enforceSpecialEnergyAttachRules } = await import("../rules");
    const { setupGame } = await import("../rules");
    const { makeRng } = await import("../rng");
    const { buildDeck, DECK_SPECS } = await import("../../data/decks");
    const { findByName } = await import("../../data/cards");
    const rng = makeRng(1);
    const p1Deck = buildDeck(DECK_SPECS[0]);
    const p2Deck = buildDeck(DECK_SPECS[0]);
    const state = setupGame(p1Deck, p2Deck, rng);
    const trPoke = findByName("Team Rocket's Mewtwo ex");
    const tre = findByName("Team Rocket's Energy");
    if (!trPoke || !tre) throw new Error("required cards not in pool");
    const { makePokemonInPlay } = await import("../rules");
    const inPlay = makePokemonInPlay(trPoke as import("../types").PokemonCard);
    inPlay.attachedEnergy.push(tre as import("../types").EnergyCard);
    state.players.p1.bench.push(inPlay);
    enforceSpecialEnergyAttachRules(state);
    expect(inPlay.attachedEnergy).toHaveLength(1);
  });
});

describe("Boomerang Energy — self-discard rebound", () => {
  it("stays on the attacker when a discardOwnEnergy effect would discard it", async () => {
    const { resolveAttackEffects } = await import("../effects");
    const { makeRng } = await import("../rng");
    const { setupGame, makePokemonInPlay } = await import("../rules");
    const { buildDeck, DECK_SPECS } = await import("../../data/decks");
    const { findByName } = await import("../../data/cards");
    const rng = makeRng(1);
    const state = setupGame(buildDeck(DECK_SPECS[0]), buildDeck(DECK_SPECS[0]), rng);
    const atkCard = findByName("Miraidon ex");
    const boomerang = findByName("Boomerang Energy");
    if (!atkCard || !boomerang) throw new Error("missing cards");
    const atk = makePokemonInPlay(atkCard as import("../types").PokemonCard);
    atk.attachedEnergy.push(boomerang as import("../types").EnergyCard);
    state.players.p1.active = atk;
    // Synthetic attack move that carries a discardOwnEnergy effect.
    const move = {
      name: "Test Attack",
      cost: [],
      damage: 30,
      effects: [{ kind: "discardOwnEnergy" as const, count: 1 }],
    };
    const res = resolveAttackEffects(state, {
      attacker: atk,
      attackerOwner: "p1",
      defender: null,
      defenderOwner: "p2",
      move,
      damage: 30,
    });
    res.postDamage?.();
    expect(atk.attachedEnergy.some((e) => e.name === "Boomerang Energy")).toBe(true);
    expect(state.players.p1.discard.some((c) => c.name === "Boomerang Energy")).toBe(false);
  });
});

describe("effectiveEnergyProvides — special energies from the dataset", () => {
  const energy = (name: string): EnergyCard => {
    const c = findByName(name);
    if (!c || c.supertype !== "Energy") throw new Error(`missing energy: ${name}`);
    return c as EnergyCard;
  };
  const poke = (name: string): PokemonCard => {
    const c = findByName(name);
    if (!c || c.supertype !== "Pokémon") throw new Error(`missing Pokémon: ${name}`);
    return c as PokemonCard;
  };

  it("Team Rocket's Energy provides Psychic + Darkness", () => {
    const e = energy("Team Rocket's Energy");
    const holder = poke("Team Rocket's Mewtwo ex");
    expect(effectiveEnergyProvides(e, holder)).toEqual(["Psychic", "Darkness"]);
  });

  it("Growing Grass Energy provides Grass", () => {
    const e = energy("Growing Grass Energy");
    const holder = poke("Miraidon ex"); // holder type irrelevant
    expect(effectiveEnergyProvides(e, holder)).toEqual(["Grass"]);
  });

  it("Rocky Fighting Energy provides Fighting", () => {
    const e = energy("Rocky Fighting Energy");
    const holder = poke("Koraidon ex");
    expect(effectiveEnergyProvides(e, holder)).toEqual(["Fighting"]);
  });

  it("Ignition Energy provides C on Basic, CCC on Evolution", () => {
    const e = energy("Ignition Energy");
    const basic = poke("Keldeo ex");
    expect(effectiveEnergyProvides(e, basic)).toEqual(["Colorless"]);
    // We need some Evolution Pokémon for the CCC branch.
    const evo = { ...basic, evolvesFrom: "Phantump" } as PokemonCard;
    expect(effectiveEnergyProvides(e, evo)).toEqual(["Colorless", "Colorless", "Colorless"]);
  });

  it("Prism Energy is wildcard on Basic, Colorless otherwise", () => {
    const e = energy("Prism Energy");
    const basic = poke("Keldeo ex");
    const evo = { ...basic, evolvesFrom: "Phantump", subtypes: ["Stage 1"] } as PokemonCard;
    expect(effectiveEnergyProvides(e, basic)).toEqual(["*"]);
    expect(effectiveEnergyProvides(e, evo)).toEqual(["Colorless"]);
  });

  it("Luminous Energy provides wildcard alone, Colorless if another Special attached", () => {
    const lum = energy("Luminous Energy");
    const holder = poke("Miraidon ex");
    expect(effectiveEnergyProvides(lum, holder, [lum])).toEqual(["*"]);
    const other = energy("Jet Energy");
    expect(effectiveEnergyProvides(lum, holder, [lum, other])).toEqual(["Colorless"]);
  });
});

describe("canPayCost — wildcard special energies", () => {
  const WILD = "*";

  it("wildcard pays any single specific cost", () => {
    expect(canPayCost([WILD], ["Fire"])).toBe(true);
    expect(canPayCost([WILD], ["Psychic"])).toBe(true);
    expect(canPayCost([WILD], ["Colorless"])).toBe(true);
  });

  it("wildcard consumed by specific cost first, leaves nothing for Colorless", () => {
    // 1 wildcard + 1 Grass specific cost: wildcard pays Grass, pool empty
    expect(canPayCost([WILD], ["Grass", "Colorless"])).toBe(false);
  });

  it("two wildcards pay two specific costs of different types", () => {
    expect(canPayCost([WILD, WILD], ["Fire", "Water"])).toBe(true);
  });

  it("basic energy preferred over wildcard to satisfy matching specifics", () => {
    // Pool = [Grass, Wild]; cost = [Grass, Water]. Grass matches exactly,
    // wildcard covers Water.
    expect(canPayCost(["Grass", WILD], ["Grass", "Water"])).toBe(true);
  });

  it("wildcard counts toward colorless slot when unused", () => {
    // Pool = [Wild, Wild]; cost = 2 Colorless.
    expect(canPayCost([WILD, WILD], ["Colorless", "Colorless"])).toBe(true);
  });
});
