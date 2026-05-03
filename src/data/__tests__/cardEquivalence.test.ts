// gameplayKey — canonical equivalence test for "same card, different art".
// Two cards must have identical gameplay fields (name, attacks, abilities,
// HP, types, retreat, weaknesses, resistances, rules text) to share a key.
// Printing-specific fields (id, setCode, number, image) are excluded so
// different prints of the SAME card produce the same key.
//
// CRITICAL: name alone is NOT enough — multiple Pokémon share names with
// different attacks. The tests below lock in this contract.

import { describe, it, expect } from "vitest";
import { gameplayKey, variantsOf } from "../cardEquivalence";
import type { Card, PokemonCard, TrainerCard, EnergyCard } from "../../engine/types";

const mkPokemon = (id: string, opts: Partial<PokemonCard> = {}): PokemonCard =>
  ({
    id,
    name: opts.name ?? "Pikachu",
    supertype: "Pokémon",
    subtypes: opts.subtypes ?? ["Basic"],
    hp: opts.hp ?? 60,
    types: opts.types ?? ["Lightning"],
    attacks: opts.attacks ?? [
      { name: "Tackle", cost: ["Colorless"], damage: 10 },
    ],
    retreatCost: opts.retreatCost ?? ["Colorless"],
    setCode: opts.setCode ?? "set1",
    number: opts.number ?? "1",
    imageLarge: opts.imageLarge ?? `https://cdn/${id}.png`,
    weaknesses: opts.weaknesses,
    resistances: opts.resistances,
    abilities: opts.abilities,
    evolvesFrom: opts.evolvesFrom,
    rules: opts.rules,
  } as PokemonCard);

const mkTrainer = (id: string, opts: Partial<TrainerCard> = {}): TrainerCard =>
  ({
    id,
    name: opts.name ?? "Switch",
    supertype: "Trainer",
    subtypes: opts.subtypes ?? ["Item"],
    text: opts.text ?? "Switch your Active Pokémon with 1 of your Benched Pokémon.",
    rules: opts.rules ?? [],
    setCode: opts.setCode ?? "set1",
    number: opts.number ?? "1",
    imageLarge: opts.imageLarge ?? `https://cdn/${id}.png`,
  } as TrainerCard);

describe("gameplayKey — same card, different art", () => {
  it("two prints of the same card produce identical keys", () => {
    const a = mkPokemon("set1-25", { setCode: "set1", number: "25" });
    const b = mkPokemon("set2-93", { setCode: "set2", number: "93" });
    expect(gameplayKey(a)).toBe(gameplayKey(b));
  });

  it("ignores printing-specific fields (id, setCode, number, image)", () => {
    const a = mkPokemon("foo", { setCode: "x", number: "1", imageLarge: "a.png" });
    const b = mkPokemon("bar", { setCode: "y", number: "999", imageLarge: "b.png" });
    expect(gameplayKey(a)).toBe(gameplayKey(b));
  });
});

describe("gameplayKey — same name, different mechanics", () => {
  it("two Pikachus with different attacks have DIFFERENT keys", () => {
    const a = mkPokemon("set1-25", {
      attacks: [{ name: "Iron Tail", cost: ["Lightning"], damage: 60 }],
    });
    const b = mkPokemon("set2-25", {
      attacks: [{ name: "Spark", cost: ["Lightning"], damage: 30 }],
    });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });

  it("two Pikachus with same attacks but different HP have DIFFERENT keys", () => {
    const a = mkPokemon("a", { hp: 60 });
    const b = mkPokemon("b", { hp: 70 });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });

  it("two Pikachus with same attacks but different types have DIFFERENT keys", () => {
    const a = mkPokemon("a", { types: ["Lightning"] });
    const b = mkPokemon("b", { types: ["Colorless"] });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });

  it("two Pikachus with same attack name but different damage have DIFFERENT keys", () => {
    const a = mkPokemon("a", { attacks: [{ name: "Spark", cost: ["Lightning"], damage: 20 }] });
    const b = mkPokemon("b", { attacks: [{ name: "Spark", cost: ["Lightning"], damage: 40 }] });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });

  it("two Pikachus with same attack but different ability have DIFFERENT keys", () => {
    const a = mkPokemon("a", {
      abilities: [{ name: "Static", type: "Ability", text: "Paralyze on contact." }],
    });
    const b = mkPokemon("b", {
      abilities: [{ name: "Static", type: "Ability", text: "Different text." }],
    });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });

  it("two Pikachus with different weaknesses have DIFFERENT keys", () => {
    const a = mkPokemon("a", { weaknesses: [{ type: "Fighting", value: "×2" }] });
    const b = mkPokemon("b", { weaknesses: [{ type: "Fire", value: "×2" }] });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });

  it("two Pikachus with different retreat costs have DIFFERENT keys", () => {
    const a = mkPokemon("a", { retreatCost: ["Colorless"] });
    const b = mkPokemon("b", { retreatCost: ["Colorless", "Colorless"] });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });
});

describe("gameplayKey — Trainers", () => {
  it("two prints of the same Trainer have identical keys", () => {
    const a = mkTrainer("svi-186", { setCode: "svi", number: "186" });
    const b = mkTrainer("meg-130", { setCode: "meg", number: "130" });
    expect(gameplayKey(a)).toBe(gameplayKey(b));
  });

  it("two Trainers with same name but different rules have DIFFERENT keys", () => {
    const a = mkTrainer("a", { rules: ["Heal 30 damage from one of your Pokémon."] });
    const b = mkTrainer("b", { rules: ["Heal 60 damage from one of your Pokémon."] });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });
});

describe("gameplayKey — Energies", () => {
  const mkEnergy = (id: string, opts: Partial<EnergyCard> = {}): EnergyCard =>
    ({
      id,
      name: opts.name ?? "Lightning Energy",
      supertype: "Energy",
      subtypes: opts.subtypes ?? ["Basic"],
      provides: opts.provides ?? ["Lightning"],
      setCode: opts.setCode ?? "set1",
      number: opts.number ?? "1",
      imageLarge: opts.imageLarge ?? `https://cdn/${id}.png`,
    } as EnergyCard);

  it("two basic Lightning energy prints have identical keys", () => {
    const a = mkEnergy("a", { setCode: "x", number: "1" });
    const b = mkEnergy("b", { setCode: "y", number: "200" });
    expect(gameplayKey(a)).toBe(gameplayKey(b));
  });

  it("a basic and a special energy with same name have DIFFERENT keys", () => {
    const a = mkEnergy("a", { subtypes: ["Basic"] });
    const b = mkEnergy("b", { subtypes: ["Special"] });
    expect(gameplayKey(a)).not.toBe(gameplayKey(b));
  });
});

describe("gameplayKey — whitespace normalization", () => {
  it("treats trailing whitespace + double-spaces as equivalent", () => {
    const a = mkPokemon("a", {
      attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10, text: "Knocks the opponent." }],
    });
    const b = mkPokemon("b", {
      attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10, text: "  Knocks the opponent.  " }],
    });
    expect(gameplayKey(a)).toBe(gameplayKey(b));
  });

  it("treats different whitespace mid-text as equivalent", () => {
    const a = mkPokemon("a", {
      attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10, text: "Foo bar." }],
    });
    const b = mkPokemon("b", {
      attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10, text: "Foo\n\nbar." }],
    });
    expect(gameplayKey(a)).toBe(gameplayKey(b));
  });
});

describe("variantsOf — pool filter", () => {
  it("returns only gameplay-equivalent prints from a same-name pool", () => {
    const target = mkPokemon("set1-25", {
      attacks: [{ name: "Spark", cost: ["Lightning"], damage: 30 }],
    });
    const sameNameButDifferent = mkPokemon("set2-25", {
      attacks: [{ name: "Iron Tail", cost: ["Lightning"], damage: 60 }],
    });
    const sameNameSameMechanics = mkPokemon("set3-25", {
      attacks: [{ name: "Spark", cost: ["Lightning"], damage: 30 }],
    });
    const pool: Card[] = [target, sameNameButDifferent, sameNameSameMechanics];
    const variants = variantsOf(target, pool);
    expect(variants.length).toBe(2);
    expect(variants.map((c) => c.id).sort()).toEqual(["set1-25", "set3-25"]);
  });
});
