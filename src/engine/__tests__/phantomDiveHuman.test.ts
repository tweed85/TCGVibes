// Reproduce the user-reported Phantom Dive bug from a human-controlled
// attacker's perspective: "It auto puts 60 damage on an opponents pokemon
// then gives you another chance to put damage." If the engine matches the
// canonical TCG flow, attack() should apply 200 to opp Active and OPEN the
// picker for bench placement WITHOUT pre-applying any bench damage.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
} from "../rules";
import { attack } from "../actions";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, PokemonCard } from "../types";

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
  state.firstTurnNoAttack = false;
  state.turn = 2;
  return state;
}

describe("Phantom Dive — human path (user-reported bug repro)", () => {
  it("does NOT auto-apply bench damage; opens picker with full 6 hits remaining", () => {
    const state = bootGameToMain(33);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";

    // Critical: HUMAN attacker. The bug only matters here — AI auto-distribute
    // is the intended behavior for the AI side.
    state.players[ap].isAI = false;

    state.players[ap].active!.card = {
      id: "dragapult-test",
      name: "Dragapult ex",
      supertype: "Pokémon",
      subtypes: ["Stage 2", "ex"],
      hp: 320,
      types: ["Dragon"],
      attacks: [
        {
          name: "Phantom Dive",
          cost: ["Fire", "Psychic"],
          damage: 200,
          effects: [
            { kind: "distributeDamage", times: 6, perHit: 10, ignoreWR: true, benchOnly: true },
          ],
        },
      ],
      retreatCost: ["Colorless", "Colorless"],
    } as PokemonCard;
    state.players[ap].active!.attachedEnergy = [
      { id: "e-fire", name: "Basic Fire Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Fire"] } as never,
      { id: "e-psy", name: "Basic Psychic Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Psychic"] } as never,
    ];

    // Set up the opponent: one Active, three Bench targets.
    const benchCard: PokemonCard = {
      id: "opp-bench-test",
      name: "Opp Bench",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 80,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard;
    state.players[opp].active!.card = {
      id: "opp-active-test",
      name: "Opp Active",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 300,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard;
    state.players[opp].active!.damage = 0;
    state.players[opp].bench = [
      { instanceId: "ob1", card: benchCard, damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false },
      { instanceId: "ob2", card: benchCard, damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false },
      { instanceId: "ob3", card: benchCard, damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false },
    ];

    const benchDamageBefore = state.players[opp].bench.map((p) => p.damage);
    expect(benchDamageBefore).toEqual([0, 0, 0]);

    attack(state, ap, 0);

    // Active should have taken the 200 base hit (but capped at the Active's
    // remaining HP — 300 hp - 200 dmg leaves 100, so damage = 200).
    expect(state.players[opp].active!.damage).toBe(200);

    // The picker should be open, scoped to opp's bench, with all 6 hits
    // remaining. NO bench damage should have been pre-applied.
    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget!.player).toBe(ap);
    expect(state.pendingInPlayTarget!.scope).toBe("opp");
    expect(state.pendingInPlayTarget!.slot).toBe("bench");
    const action = state.pendingInPlayTarget!.action as { kind: string; remaining: number; perHit: number };
    expect(action.kind).toBe("distributeDamage");
    expect(action.remaining).toBe(6);
    expect(action.perHit).toBe(10);

    // CRITICAL: bench should be untouched until the human clicks targets.
    const benchDamageAfter = state.players[opp].bench.map((p) => p.damage);
    expect(benchDamageAfter).toEqual([0, 0, 0]);
  });
});
