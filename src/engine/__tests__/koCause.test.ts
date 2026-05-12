import { describe, expect, it } from "vitest";
import { applyDamage, knockOut, makePokemonInPlay, prizeValue, setupGame } from "../rules";
import { makeRng } from "../rng";
import type { Card, EnergyCard, PokemonCard, TrainerCard } from "../types";

function pokemon(
  name: string,
  overrides: Partial<PokemonCard> = {},
): PokemonCard {
  return {
    id: `pkm-${name}`,
    name,
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 100,
    types: ["Colorless"],
    attacks: [],
    retreatCost: ["Colorless"],
    ...overrides,
  };
}

function tool(name: string): TrainerCard {
  return {
    id: `tool-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "",
  } as TrainerCard;
}

function energy(name: string, subtypes = ["Special"]): EnergyCard {
  return {
    id: `energy-${name}`,
    name,
    supertype: "Energy",
    subtypes,
    provides: ["Colorless"],
  } as EnergyCard;
}

function boot() {
  const filler = pokemon("Filler");
  const deck = Array.from({ length: 60 }, (_, i) => ({ ...filler, id: `f-${i}` }) as Card);
  const state = setupGame(deck, deck, makeRng(123), { p2IsAI: false });
  state.phase = "main";
  state.activePlayer = "p1";
  state.firstTurnNoAttack = false;
  state.players.p1.prizes = Array.from({ length: 6 }, (_, i) => ({ ...filler, id: `p1-prize-${i}` }) as Card);
  state.players.p2.prizes = Array.from({ length: 6 }, (_, i) => ({ ...filler, id: `p2-prize-${i}` }) as Card);
  state.players.p1.active = makePokemonInPlay(pokemon("Attacker"));
  state.players.p2.bench = [makePokemonInPlay(pokemon("Backup"))];
  return state;
}

describe("KO cause gates opponent-attack-only effects", () => {
  it("does not trigger Legacy Energy on a non-attack KO", () => {
    const state = boot();
    const defender = makePokemonInPlay(pokemon("Target ex", { subtypes: ["Basic", "ex"] }));
    defender.attachedEnergy = [energy("Legacy Energy")];
    state.players.p2.active = defender;

    knockOut(state, "p2");

    expect(state.players.p1.prizes).toHaveLength(4);
    expect(state.players.p2.legacyEnergyUsed).toBe(false);
    expect(state.log.some((e) => /Legacy Energy triggers/.test(e.text))).toBe(false);
  });

  it("does trigger Legacy Energy when attack damage KOs the holder", () => {
    const state = boot();
    const defender = makePokemonInPlay(pokemon("Target ex", { subtypes: ["Basic", "ex"] }));
    defender.attachedEnergy = [energy("Legacy Energy")];
    state.players.p2.active = defender;

    applyDamage(state, "p2", 999);

    expect(state.players.p1.prizes).toHaveLength(5);
    expect(state.players.p2.legacyEnergyUsed).toBe(true);
    expect(state.log.some((e) => /Legacy Energy triggers/.test(e.text))).toBe(true);
  });

  it("does not trigger KO Tools such as Heavy Baton on a non-attack KO", () => {
    const state = boot();
    const defender = makePokemonInPlay(
      pokemon("Four Retreat", {
        retreatCost: ["Colorless", "Colorless", "Colorless", "Colorless"],
      }),
    );
    defender.tools = [tool("Heavy Baton")];
    defender.attachedEnergy = [energy("Basic Grass Energy", ["Basic"])];
    state.players.p2.active = defender;

    knockOut(state, "p2");

    expect(state.players.p2.bench[0].attachedEnergy).toHaveLength(0);
    expect(state.players.p2.discard.map((c) => c.name)).toContain("Basic Grass Energy");
    expect(state.log.some((e) => /Heavy Baton moves/.test(e.text))).toBe(false);
  });
});

describe("rule-box prize values", () => {
  it("treats Mega Evolution ex as 3 prizes before the generic ex fallback", () => {
    expect(prizeValue(pokemon("Mega Lucario ex", { subtypes: ["Stage 1", "MEGA", "ex"] }))).toBe(3);
    expect(prizeValue(pokemon("Synthetic Mega ex", { subtypes: ["Stage 1", "Mega", "ex"] }))).toBe(3);
    expect(prizeValue(pokemon("Regular ex", { subtypes: ["Basic", "ex"] }))).toBe(2);
  });

  it("awards 3 prizes when a Mega Evolution ex is Knocked Out", () => {
    const state = boot();
    state.players.p2.active = makePokemonInPlay(
      pokemon("Mega Lucario ex", {
        subtypes: ["Stage 1", "MEGA", "ex"],
        hp: 330,
      }),
    );

    knockOut(state, "p2");

    expect(state.players.p1.prizes).toHaveLength(3);
    expect(state.log.filter((e) => /takes a Prize/.test(e.text))).toHaveLength(3);
  });
});
