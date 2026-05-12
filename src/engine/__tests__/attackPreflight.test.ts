// Regression tests for the H3 fix: the UI's attack button must disable
// preemptively when an attack would fail. attackPreflight is the single
// gate both the UI and the engine consult, so checking its outputs here
// covers both surfaces.

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
import { attack, attackPreflight } from "../actions";
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

describe("attackPreflight (H3) — UI/engine parity for pre-click disable", () => {
  it("ok=true on a legal attack with energy + no status", () => {
    const state = bootGameToMain(1);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      retreatCost: [],
    } as PokemonCard;
    expect(attackPreflight(state, ap, 0).ok).toBe(true);
  });

  it("rejects with first-turn reason when firstTurnNoAttack is set", () => {
    const state = bootGameToMain(2);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      retreatCost: [],
    } as PokemonCard;
    const r = attackPreflight(state, ap, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/first turn/i);
  });

  it("Debut Performance bypasses the first-turn ban", () => {
    const state = bootGameToMain(3);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.players[ap].active!.card = {
      id: "meloetta-test", name: "Meloetta ex",
      supertype: "Pokémon", subtypes: ["Basic", "ex"],
      hp: 200, types: ["Psychic"],
      attacks: [{ name: "Verse Spin", cost: [], damage: 30 }],
      retreatCost: [],
      abilities: [{ name: "Debut Performance", text: "...", type: "Ability" }],
    } as PokemonCard;
    expect(attackPreflight(state, ap, 0).ok).toBe(true);
  });

  it("rejects with asleep reason when active is asleep", () => {
    const state = bootGameToMain(4);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      retreatCost: [],
    } as PokemonCard;
    addStatus(state, state.players[ap].active!, "asleep");
    const r = attackPreflight(state, ap, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/asleep/i);
  });

  it("rejects with paralyzed reason when active is paralyzed", () => {
    const state = bootGameToMain(5);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      retreatCost: [],
    } as PokemonCard;
    addStatus(state, state.players[ap].active!, "paralyzed");
    const r = attackPreflight(state, ap, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/paralyzed/i);
  });

  it("rejects when cantAttackUntilTurn is in the future", () => {
    const state = bootGameToMain(6);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      retreatCost: [],
    } as PokemonCard;
    state.players[ap].active!.cantAttackUntilTurn = state.turn + 1;
    const r = attackPreflight(state, ap, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't attack/i);
  });

  it("rejects when energy cost is unpayable", () => {
    const state = bootGameToMain(7);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Big Hit", cost: ["Fire", "Fire", "Fire"], damage: 200 }],
      retreatCost: [],
    } as PokemonCard;
    state.players[ap].active!.attachedEnergy = []; // none
    const r = attackPreflight(state, ap, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Energy/i);
  });

  it("rejects when activePlayer doesn't match (opp's turn)", () => {
    const state = bootGameToMain(8);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    expect(attackPreflight(state, opp, 0).ok).toBe(false);
  });

  it("attack() and attackPreflight() return the SAME error reason", () => {
    // Single source of truth — attack() routes through attackPreflight,
    // so any rejection produces an identical fail reason. This guards the
    // H3 invariant that the UI's "why is this disabled" tooltip text
    // matches the engine's actual error message.
    const state = bootGameToMain(9);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.players[ap].active!.card = {
      id: "test", name: "Test", supertype: "Pokémon", subtypes: ["Basic"],
      hp: 100, types: ["Colorless"],
      attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      retreatCost: [],
    } as PokemonCard;
    const pre = attackPreflight(state, ap, 0);
    const act = attack(state, ap, 0);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });
});
