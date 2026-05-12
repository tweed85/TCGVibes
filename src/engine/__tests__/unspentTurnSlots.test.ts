// Tests for the End Turn pre-confirm warning (the surviving slice of H2).
// `unspentTurnSlots` returns the list the UI shows in the confirm modal;
// when empty, end turn proceeds without an extra click.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
  unspentTurnSlots,
} from "../rules";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, EnergyCard, TrainerCard } from "../types";

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

const energy = (): EnergyCard => ({
  id: "e-grass",
  name: "Basic Grass Energy",
  supertype: "Energy",
  subtypes: ["Basic"],
  provides: ["Grass"],
} as EnergyCard);

const supporter = (): TrainerCard => ({
  id: "iono",
  name: "Iono",
  supertype: "Trainer",
  subtypes: ["Supporter"],
  text: "...",
} as TrainerCard);

describe("unspentTurnSlots — End Turn pre-confirm warnings", () => {
  it("returns [] when both energy attach and Supporter slot are already spent", () => {
    const state = bootGameToMain(1);
    const ap = state.activePlayer;
    state.players[ap].energyAttachedThisTurn = true;
    state.players[ap].supporterPlayedThisTurn = true;
    state.players[ap].hand = [energy(), supporter()];
    expect(unspentTurnSlots(state, ap)).toEqual([]);
  });

  it("returns [] when player has nothing relevant in hand even if slots open", () => {
    const state = bootGameToMain(2);
    const ap = state.activePlayer;
    state.players[ap].energyAttachedThisTurn = false;
    state.players[ap].supporterPlayedThisTurn = false;
    state.players[ap].hand = []; // nothing playable
    expect(unspentTurnSlots(state, ap)).toEqual([]);
  });

  it("warns about energy attach when player holds Energy and hasn't attached", () => {
    const state = bootGameToMain(3);
    const ap = state.activePlayer;
    state.players[ap].energyAttachedThisTurn = false;
    state.players[ap].supporterPlayedThisTurn = true;
    state.players[ap].hand = [energy()];
    const warns = unspentTurnSlots(state, ap);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/Energy/i);
  });

  it("warns about Supporter when player holds one and hasn't played", () => {
    const state = bootGameToMain(4);
    const ap = state.activePlayer;
    state.players[ap].energyAttachedThisTurn = true;
    state.players[ap].supporterPlayedThisTurn = false;
    state.players[ap].hand = [supporter()];
    const warns = unspentTurnSlots(state, ap);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/Supporter/i);
  });

  it("warns about both when both slots are open and both card types are in hand", () => {
    const state = bootGameToMain(5);
    const ap = state.activePlayer;
    state.players[ap].energyAttachedThisTurn = false;
    state.players[ap].supporterPlayedThisTurn = false;
    state.players[ap].hand = [energy(), supporter()];
    expect(unspentTurnSlots(state, ap)).toHaveLength(2);
  });

  it("does NOT warn about Supporter on first player's T1 (Supporters banned anyway)", () => {
    const state = bootGameToMain(6);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.firstPlayer = ap;
    state.players[ap].supporterPlayedThisTurn = false;
    state.players[ap].hand = [supporter()];
    const warns = unspentTurnSlots(state, ap);
    // Supporter warning suppressed; energy may or may not warn depending on
    // hand. Verify the Supporter line specifically isn't present.
    expect(warns.some((w) => /Supporter/i.test(w))).toBe(false);
  });

  it("returns [] when called for the inactive player", () => {
    const state = bootGameToMain(7);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    state.players[opp].energyAttachedThisTurn = false;
    state.players[opp].supporterPlayedThisTurn = false;
    state.players[opp].hand = [energy(), supporter()];
    expect(unspentTurnSlots(state, opp)).toEqual([]);
  });
});
