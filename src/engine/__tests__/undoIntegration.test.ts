// Integration test for the full undo snapshot + restore round-trip. The
// previous-bug scenario: user plays a Trainer that shuffles their deck,
// undoes, replays the same Trainer — and gets a DIFFERENT shuffle order
// because the rng cursor wasn't rewound. This test simulates the App-level
// undo flow at the engine layer so we don't need React Testing Library.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
} from "../rules";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState } from "../types";

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

// Mirror App.tsx's snapshot/restore pattern at engine level.
function snapshot(state: GameState): { json: string; rngState: number } {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rng: _rng, ...serializable } = state;
  return {
    json: JSON.stringify(serializable),
    rngState: state.rng.getState(),
  };
}
function restore(state: GameState, snap: { json: string; rngState: number }): GameState {
  const restored = JSON.parse(snap.json);
  state.rng.setState(snap.rngState);
  return { ...restored, rng: state.rng };
}

// Inline Fisher-Yates using the engine's rng surface (GameRng exposes only
// `next`/`int`, not `shuffle`/`pick` — engine code shuffles inline too).
function shuffleInline<T>(rng: { int(n: number): number }, arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("Undo integration — snapshot + restore reproduces rng-dependent actions", () => {
  it("a deck shuffle replayed after undo produces identical order", () => {
    const state = bootGameToMain(99);
    const ap = state.activePlayer;

    // Snapshot before the rng-consuming action.
    const snap = snapshot(state);

    // First execution of a shuffle.
    const before = state.players[ap].deck.slice();
    const firstShuffle = shuffleInline(state.rng, before).map((c) => c.id);

    // Restore (the user clicks Undo).
    const restored = restore(state, snap);
    Object.assign(state, restored);

    // Re-execute the same shuffle on the same input.
    const replayShuffle = shuffleInline(state.rng, before).map((c) => c.id);

    expect(replayShuffle).toEqual(firstShuffle);
  });

  it("multiple nested rng calls round-trip correctly", () => {
    const state = bootGameToMain(7);
    const snap = snapshot(state);

    // First run: shuffle + several reads.
    const arr = [1, 2, 3, 4, 5];
    const s1 = shuffleInline(state.rng, arr);
    const f1 = [state.rng.next(), state.rng.next(), state.rng.next()];

    // Restore.
    Object.assign(state, restore(state, snap));

    // Replay → identical sequence.
    const s2 = shuffleInline(state.rng, arr);
    const f2 = [state.rng.next(), state.rng.next(), state.rng.next()];

    expect(s2).toEqual(s1);
    expect(f2).toEqual(f1);
  });

  it("snapshot preserves all GameState fields except rng (which is restored separately)", () => {
    const state = bootGameToMain(15);
    const ap = state.activePlayer;

    // Snapshot, mutate, restore.
    const snap = snapshot(state);
    state.players[ap].mulligans = 99; // arbitrary mutation
    state.turn = 999;
    state.players[ap].energyAttachedThisTurn = true;
    Object.assign(state, restore(state, snap));

    expect(state.players[ap].mulligans).not.toBe(99);
    expect(state.turn).not.toBe(999);
    expect(state.players[ap].energyAttachedThisTurn).toBe(false);
  });

  it("the bug-without-fix scenario fails — proves the test would catch a regression", () => {
    // Sanity: if the rng cursor weren't rewound, the replay would differ.
    // This guards against someone removing the setState call.
    const state = bootGameToMain(33);
    const arr = [1, 2, 3, 4, 5, 6, 7];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { rng: _rng, ...serializable } = state;
    const json = JSON.stringify(serializable);

    const first = shuffleInline(state.rng, arr);

    // "Buggy" restore: state restored, but rng cursor NOT rewound.
    const restored = JSON.parse(json);
    Object.assign(state, { ...restored, rng: state.rng }); // no setState!

    const replay = shuffleInline(state.rng, arr);
    // Without setState, replay differs from first — the original bug.
    expect(replay).not.toEqual(first);
  });
});
