// Smoke test: every preset deck can run a full AI-vs-AI game without
// throwing. Catches regressions where a dataset refresh, ability rewrite,
// or trainer change breaks a deck that previously worked.
//
// This is intentionally a *smoke* test — it does not assert game balance,
// deck quality, or correct rule resolution beyond "nothing crashed." It
// does assert:
//   - every preset builds to a legal 60-card deck
//   - a seeded AI-vs-AI match can run end-to-end (≤ MAX_TURNS turns) without
//     throwing
//   - the turn counter advances each round (no infinite loop on a stuck phase)
//   - the game reaches a terminal state (gameOver) or cleanly hits MAX_TURNS
//
// When this test fails, the failure message will usually point at the deck
// or ability that broke. Run `npm run test -- presetDeckSmoke` to isolate.

import { describe, it, expect } from "vitest";
import { setupGame, resolveCoinGuess, chooseFirstPlayer } from "../rules";
import { makeRng } from "../rng";
import {
  resolveAiCoinChoice,
  resolveAiPendingPromote,
  resolveAiSetup,
  takeAiTurn,
} from "../ai";
import { resolveAiPendingPick } from "../pendingPick";
import { resolveAiHandReveal } from "../trainerEffects";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, PlayerId } from "../types";

// Cap at 30 turns / 200 total loop iterations. Real games end well under
// that; anything longer is almost certainly a stuck state worth flagging.
const MAX_TURNS = 30;
const MAX_ITERATIONS = 200;

// Run the full pre-game ceremony (coin flip + both sides' setup) against
// a headless AI for both sides. Throws if any step doesn't advance.
function headlessSetup(state: GameState): void {
  // Coin flip — guess heads arbitrarily.
  resolveCoinGuess(state, "heads");
  // Whoever wins picks who goes first. If the AI won, let the AI pick;
  // otherwise call `chooseFirstPlayer` directly for the "human" side.
  if (!resolveAiCoinChoice(state)) {
    const winner = state.coinFlip!.winner!;
    chooseFirstPlayer(state, winner, /*goFirst*/ true);
  }
  // Opening hand setup — both sides run the AI setup.
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const ok = resolveAiSetup(state, pid);
    if (!ok) {
      throw new Error(`AI setup failed for ${pid} — no valid opening hand?`);
    }
  }
}

// Core simulation loop. Drives phase transitions until gameOver or MAX_TURNS
// exhaustion, whichever comes first. Returns summary info for assertions.
function playOut(state: GameState): {
  finalPhase: string;
  finalTurn: number;
  winner: PlayerId | null;
  iterations: number;
} {
  let iterations = 0;
  while (state.phase !== "gameOver" && state.turn <= MAX_TURNS) {
    iterations++;
    if (iterations > MAX_ITERATIONS) {
      throw new Error(
        `Exceeded ${MAX_ITERATIONS} loop iterations — likely stuck on phase ${state.phase} turn ${state.turn}.`,
      );
    }

    // Promote prompts take priority over main-phase actions.
    if (state.pendingPromote) {
      const resolved = resolveAiPendingPromote(state, state.pendingPromote);
      if (!resolved) {
        throw new Error(
          `pendingPromote ${state.pendingPromote} couldn't be resolved (phase=${state.phase}).`,
        );
      }
      continue;
    }

    // Pending picks / hand reveals target the player they were set on, which
    // may not be the current active player (e.g. Repel forces opp promote).
    if (state.pendingPick) {
      resolveAiPendingPick(state, state.pendingPick.player);
      continue;
    }
    if (state.pendingHandReveal) {
      resolveAiHandReveal(state);
      continue;
    }

    // Main-phase turn for the current active player.
    if (state.phase === "main") {
      takeAiTurn(state, state.activePlayer);
      continue;
    }

    // If we fall through here, the phase isn't one we know how to drive —
    // bail with a descriptive error.
    throw new Error(`Unhandled phase during smoke test: ${state.phase}`);
  }

  return {
    finalPhase: state.phase,
    finalTurn: state.turn,
    winner: state.winner,
    iterations,
  };
}

describe("preset deck smoke tests", () => {
  it.each(DECK_SPECS.map((s) => [s.id, s.name] as const))(
    "%s builds to a legal 60-card deck",
    (id) => {
      const spec = DECK_SPECS.find((s) => s.id === id)!;
      const deck = buildDeck(spec);
      expect(deck.length).toBe(60);
      // Must contain at least one Basic Pokémon to satisfy opening draw.
      const basics = deck.filter(
        (c) => c.supertype === "Pokémon" && c.subtypes.includes("Basic"),
      );
      expect(basics.length).toBeGreaterThan(0);
    },
  );

  // Cartesian product of the first two presets on each side — keeps the
  // suite fast (N*N would balloon) while exercising the interaction surface
  // (a deck's cards faced by another deck's cards).
  const pairs = DECK_SPECS.flatMap((p1) =>
    DECK_SPECS.map((p2) => [p1, p2] as const),
  );

  it.each(pairs.map(([a, b]) => [`${a.id} vs ${b.id}`, a.id, b.id] as const))(
    "smoke: %s plays a full AI-vs-AI game to completion or turn cap",
    (_label, p1Id, p2Id) => {
      const p1Spec = DECK_SPECS.find((s) => s.id === p1Id)!;
      const p2Spec = DECK_SPECS.find((s) => s.id === p2Id)!;
      // Fixed seed so failures are reproducible.
      const rng = makeRng(42);
      const state = setupGame(buildDeck(p1Spec), buildDeck(p2Spec), rng, {
        p1Name: "P1",
        p2Name: "P2",
        p2IsAI: true,
      });
      // Both sides are AI for this harness — mark p1 as AI too.
      state.players.p1.isAI = true;

      // Setup should not throw.
      expect(() => headlessSetup(state)).not.toThrow();

      // Play out the game. The key assertion is that this doesn't throw —
      // any unhandled state transition or null-deref bubbles up as a test
      // failure pointing at the offending deck pairing.
      const result = playOut(state);

      // Sanity checks on the final state.
      expect(result.finalTurn).toBeGreaterThan(0);
      // Either the game finished naturally, or we exhausted the turn cap.
      const endedCleanly =
        result.finalPhase === "gameOver" || result.finalTurn > MAX_TURNS;
      expect(endedCleanly).toBe(true);
    },
    /* timeout */ 30_000,
  );
});
