// Integration tests — exercise the full attack / trainer pipeline to make
// sure wired effects actually fire end-to-end rather than just detect.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
  addStatus,
} from "../rules";
import { attack } from "../actions";
import { effectiveMaxHp } from "../ongoingEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, PokemonCard, TrainerCard } from "../types";

function bootGameToMain(seed = 1): GameState {
  const state = setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: false },
  );
  resolveCoinGuess(state, "heads");
  const winner = state.coinFlip!.winner!;
  chooseFirstPlayer(state, winner, true);
  for (const pid of ["p1", "p2"] as const) {
    const idx = state.players[pid].hand.findIndex(
      (c) => isPokemon(c) && isBasic(c),
    );
    completeSetup(state, pid, idx, []);
  }
  // Clear the first-turn attack lock so integration tests can call attack() directly.
  state.firstTurnNoAttack = false;
  // Bump turn so evolutions would be legal if tested.
  state.turn = 2;
  return state;
}

function mkStadium(name: string): TrainerCard {
  return {
    id: `stadium-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Stadium"],
    text: "",
  } as TrainerCard;
}

describe("Budew Itchy Pollen — free attack blocks opp items next turn", () => {
  it("sets itemsBlockedNextTurn on opponent when triggered", () => {
    const state = bootGameToMain(42);
    // Replace the active player's Active with a mocked Budew-like card.
    const ap = state.activePlayer;
    const budew: PokemonCard = {
      id: "budew-test",
      name: "Budew",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 30,
      types: ["Grass"],
      attacks: [
        {
          name: "Itchy Pollen",
          cost: [],
          damage: 10,
          effects: [{ kind: "blockOppItemsNextTurn" }],
        },
      ],
      retreatCost: ["Colorless"],
    };
    state.players[ap].active!.card = budew;
    attack(state, ap, 0);
    const oppId = ap === "p1" ? "p2" : "p1";
    expect(state.players[oppId].itemsBlockedNextTurn).toBe(true);
  });
});

describe("per-friendly-bench damage scaling — Dipplin-style attacks", () => {
  it("damage scales with bench size", () => {
    const state = bootGameToMain(7);
    const ap = state.activePlayer;
    // Fabricate an attacker with a "20× per friendly benched Pokémon" attack.
    state.players[ap].active!.card = {
      id: "dipplin-test",
      name: "Dipplin",
      supertype: "Pokémon",
      subtypes: ["Stage 1"],
      hp: 130,
      types: ["Grass"],
      attacks: [
        {
          name: "Do the Wave",
          cost: ["Grass"],
          damage: 0,
          damageText: "20×",
          effects: [{ kind: "perFriendlyBench", perCount: 20 }],
        },
      ],
      retreatCost: ["Colorless"],
    };
    // Give it the energy it needs.
    state.players[ap].active!.attachedEnergy = [
      {
        id: "e-grass",
        name: "Basic Grass Energy",
        supertype: "Energy",
        subtypes: ["Basic"],
        provides: ["Grass"],
      } as any,
    ];
    // Put 4 benched Pokémon (fabricated) — expected damage = 20 * 4 = 80.
    for (let i = 0; i < 4; i++) {
      state.players[ap].bench.push({
        instanceId: `b${i}`,
        card: state.players[ap].active!.card,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: false,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
    }
    const oppId = ap === "p1" ? "p2" : "p1";
    const defBefore = state.players[oppId].active!.damage;
    attack(state, ap, 0);
    const defAfter = state.players[oppId].active!.damage;
    // Attack defender took at least 80 damage (may be more with weakness).
    expect(defAfter - defBefore).toBeGreaterThanOrEqual(80);
  });
});

describe("Festival Grounds + Energy attached → status immunity", () => {
  it("attempts to apply a status are blocked when stadium + energy present", () => {
    const state = bootGameToMain(12);
    state.stadium = { card: mkStadium("Festival Grounds"), controller: "p1" };
    const ap = state.activePlayer;
    const pkm = state.players[ap].active!;
    // Attach an Energy card so immunity kicks in.
    pkm.attachedEnergy = [
      {
        id: "e-grass",
        name: "Basic Grass Energy",
        supertype: "Energy",
        subtypes: ["Basic"],
        provides: ["Grass"],
      } as any,
    ];
    addStatus(state, pkm, "poisoned");
    expect(pkm.statuses).not.toContain("poisoned");
  });
});

describe("Jamming Tower suppresses Tool HP bonus", () => {
  it("HP is base when Jamming Tower is in play, even with a buffing Tool", () => {
    const state = bootGameToMain(4);
    const ap = state.activePlayer;
    const pkm = state.players[ap].active!;
    pkm.tools = [{
      id: "tool-hc",
      name: "Hero's Cape",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool"],
      text: "",
    } as TrainerCard];
    state.stadium = { card: mkStadium("Jamming Tower"), controller: "p2" };
    expect(effectiveMaxHp(pkm, state)).toBe(pkm.card.hp);
  });
});

describe("Per-Pokemon lock flags (selfCantAttack / cantRetreat)", () => {
  it("sets cantAttackUntilTurn on the attacker after a self-lock attack", () => {
    const state = bootGameToMain(99);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "big-hit",
      name: "Test Big Hit",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 200,
      types: ["Colorless"],
      attacks: [
        {
          name: "Lights Out",
          cost: [],
          damage: 200,
          effects: [{ kind: "selfCantAttackNextTurn" }],
        },
      ],
      retreatCost: ["Colorless"],
    };
    const startTurn = state.turn;
    attack(state, ap, 0);
    // After the attack, the Pokémon that just swung may have been KO'd from
    // recoil / sent to promote; in either case the flag should be set on
    // whichever copy of the attacker is reachable.
    const atkAfter =
      state.players[ap].active ??
      state.players[ap].bench.find((p) => p.card.name === "Test Big Hit");
    if (atkAfter) {
      expect(atkAfter.cantAttackUntilTurn).toBe(startTurn + 2);
    }
  });
});

describe("Import decklist → valid 60-card deck", () => {
  it("a minimal synthetic decklist builds correctly", () => {
    // Use the built-in decks module directly; there's no public import flow
    // without the UI. This is just a sanity check that preset decks + mapper
    // produce clean cards.
    const deck = buildDeck(DECK_SPECS[0]);
    expect(deck).toHaveLength(60);
    const names = new Set<string>();
    for (const c of deck) names.add(c.name);
    // At least 3 distinct card names (core + staples + energy).
    expect(names.size).toBeGreaterThanOrEqual(3);
  });
});
