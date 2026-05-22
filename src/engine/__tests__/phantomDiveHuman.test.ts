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
import { resolveInPlayTarget } from "../trainerEffects";
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
    expect(state.activePlayer).toBe(ap);

    // CRITICAL: bench should be untouched until the human clicks targets.
    const benchDamageAfter = state.players[opp].bench.map((p) => p.damage);
    expect(benchDamageAfter).toEqual([0, 0, 0]);
  });

  it("does not pass turn until the human finishes all damage-placement clicks", () => {
    const state = bootGameToMain(34);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
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
          cost: [],
          damage: 200,
          effects: [
            { kind: "distributeDamage", times: 6, perHit: 10, ignoreWR: true, benchOnly: true },
          ],
        },
      ],
      retreatCost: ["Colorless", "Colorless"],
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
    state.players[opp].bench = [
      { instanceId: "ob1", card: benchCard, damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false },
    ];

    attack(state, ap, 0);
    expect(state.activePlayer).toBe(ap);
    expect(state.pendingInPlayTarget).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      const r = resolveInPlayTarget(state, ap, opp, "ob1");
      expect(r.ok).toBe(true);
      expect(state.activePlayer).toBe(ap);
    }

    const final = resolveInPlayTarget(state, ap, opp, "ob1");
    expect(final.ok).toBe(true);
    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.activePlayer).toBe(opp);
    expect(state.phase).toBe("main");
    expect(state.players[opp].bench[0].damage).toBe(60);
  });

  // Regression: when Phantom Dive's 200 base damage KOs the opp's Active,
  // `pendingPromote` is set on the opp side AND the spread picker is open on
  // the attacker's side. finishHit used to check pendingPromote FIRST and
  // queue onPromoteResolved="endTurn", which made the opp's auto-promote
  // flip the turn before the human placed the remaining 60 counters — the
  // picker became orphaned on the next player's turn. Now the picker check
  // wins; the picker's resolver chains into pendingPromote on its last click.
  it("KOs the Active + opens the spread picker; turn does NOT flip until both resolve", () => {
    const state = bootGameToMain(35);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
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
          cost: [],
          damage: 200,
          effects: [
            { kind: "distributeDamage", times: 6, perHit: 10, ignoreWR: true, benchOnly: true },
          ],
        },
      ],
      retreatCost: ["Colorless", "Colorless"],
    } as PokemonCard;
    // Active is a 1-prize Basic with 150 HP; 200 base damage KOs it outright
    // and arms pendingPromote on the opp side.
    state.players[opp].active!.card = {
      id: "opp-active-fragile",
      name: "Opp Active Fragile",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 150,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard;
    state.players[opp].active!.damage = 0;
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
    state.players[opp].bench = [
      { instanceId: "ob1", card: benchCard, damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false },
      { instanceId: "ob2", card: benchCard, damage: 0, attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false },
    ];

    attack(state, ap, 0);

    // Active KO'd → pendingPromote set on opp.
    expect(state.pendingPromote).toBe(opp);
    // Spread picker open on attacker, NOT orphaned by the KO.
    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget!.player).toBe(ap);
    const action = state.pendingInPlayTarget!.action as { kind: string; remaining: number };
    expect(action.kind).toBe("distributeDamage");
    expect(action.remaining).toBe(6);
    // Turn must still belong to the attacker — promote can't resolve into
    // endTurn while counters are still queued.
    expect(state.activePlayer).toBe(ap);
    // Bench should be untouched at this point (human hasn't clicked yet).
    expect(state.players[opp].bench.map((p) => p.damage)).toEqual([0, 0]);
  });
});
