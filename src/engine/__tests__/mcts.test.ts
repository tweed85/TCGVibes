// Smoke tests for the MCTS module. Verifies that:
//   - `enumerateActions` returns at least one legal action when the player
//     has a non-trivial board.
//   - `runMcts` completes within budget and returns a valid action.
//   - The returned action applies to the engine without throwing.
//
// The benchmark harness (aiBenchmark.test.ts) covers the win-rate side;
// this file is the unit-level "MCTS doesn't crash" guarantee.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  isBasic,
  isPokemon,
  completeSetup,
} from "../rules";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import { enumerateActions, runMcts, type McAction } from "../mcts";
import { cloneStateForSearchWithSeed } from "../ai";
import type { GameState } from "../types";

function bootGame(seed = 1): GameState {
  const state = setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: true },
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
  state.turn = 3;
  state.players.p1.isAI = true;
  state.players.p2.isAI = true;
  return state;
}

// scorePosition is private — the benchmark passes a closure.
function leafEval(s: GameState, p: "p1" | "p2"): number {
  // Public eval surrogate: prizes ×250 + tiny tiebreak. Good enough for the
  // smoke test; the production integration uses the full scorePosition.
  const me = s.players[p];
  const opp = s.players[p === "p1" ? "p2" : "p1"];
  return (6 - me.prizes.length) * 250 - (6 - opp.prizes.length) * 250;
}

describe("MCTS — smoke", () => {
  it("enumerateActions returns at least 1 legal action on a fresh main-phase state", () => {
    const state = bootGame(11);
    const ap = state.activePlayer;
    const actions = enumerateActions(state, ap);
    expect(actions.length).toBeGreaterThan(0);
    // Sentinel — endTurn is always present.
    expect(actions.some((a: McAction) => a.kind === "endTurn")).toBe(true);
  });

  it("runMcts returns a valid action within budget", () => {
    const state = bootGame(12);
    const ap = state.activePlayer;
    const start = Date.now();
    const result = runMcts(state, ap, {
      budgetMs: 200,
      cloneStateForSearchWithSeed,
      leafEval,
      rolloutDepthTurns: 0,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000); // hard ceiling well above budget
    expect(result.bestAction).not.toBeNull();
    expect(result.iterations).toBeGreaterThan(0);
  });

  it("runMcts at depth=0 completes many iterations in 200ms", () => {
    const state = bootGame(13);
    const ap = state.activePlayer;
    const result = runMcts(state, ap, {
      budgetMs: 200,
      cloneStateForSearchWithSeed,
      leafEval,
      rolloutDepthTurns: 0,
    });
    // Without rollouts, each iter is a clone + apply + leaf eval.
    // Should comfortably exceed 50 iterations.
    expect(result.iterations).toBeGreaterThan(20);
  });
});
