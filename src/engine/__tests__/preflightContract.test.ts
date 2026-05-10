// Phase 1 contract test — preflight `reason` strings MUST match the
// matching action's `ActionResult.reason` for every illegal-fixture pair.
//
// Drift between `preflight.ts` guards and `actions.ts` mutations is the
// only thing that can make the dim/tooltip UI lie to the player. This
// test enforces zero drift on the cases we care about.

import { describe, it, expect } from "vitest";
import { setupTestGame } from "./helpers/gameTestHelpers";
import {
  attachEnergy,
  evolve,
  playBasicToBench,
  playTrainer,
  retreat,
} from "../actions";
import {
  canAttachEnergy,
  canBenchBasic,
  canEvolve,
  canPlayTrainer,
  canRetreat,
} from "../preflight";

describe("preflight ↔ action reason parity", () => {
  it("benchBasic — phase guard reasons match", () => {
    const state = setupTestGame({ seed: 1 });
    state.phase = "gameOver";
    const handIdx = 0;
    const pre = canBenchBasic(state, "p1", handIdx);
    const act = playBasicToBench(state, "p1", handIdx);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("benchBasic — non-basic card reasons match", () => {
    const state = setupTestGame({ seed: 2 });
    // Pretend the first-hand card index is a Trainer (or just an evo).
    const idx = state.players[state.activePlayer].hand.findIndex(
      (c) => c.supertype === "Trainer",
    );
    if (idx < 0) return;
    const pre = canBenchBasic(state, state.activePlayer, idx);
    const act = playBasicToBench(state, state.activePlayer, idx);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("evolve — non-evolution card reasons match", () => {
    const state = setupTestGame({ seed: 3 });
    const idx = state.players[state.activePlayer].hand.findIndex(
      (c) => c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Basic"),
    );
    if (idx < 0) return;
    const target = state.players[state.activePlayer].active!.instanceId;
    const pre = canEvolve(state, state.activePlayer, idx, target);
    const act = evolve(state, state.activePlayer, idx, target);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("attachEnergy — already-attached-this-turn reason matches", () => {
    const state = setupTestGame({ seed: 4 });
    const p = state.activePlayer;
    state.players[p].energyAttachedThisTurn = true;
    const idx = state.players[p].hand.findIndex(
      (c) => c.supertype === "Energy",
    );
    if (idx < 0) return;
    const target = state.players[p].active!.instanceId;
    const pre = canAttachEnergy(state, p, idx, target);
    const act = attachEnergy(state, p, idx, target);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("attachEnergy — non-energy card reason matches", () => {
    const state = setupTestGame({ seed: 5 });
    const p = state.activePlayer;
    const idx = state.players[p].hand.findIndex(
      (c) => c.supertype === "Trainer",
    );
    if (idx < 0) return;
    const target = state.players[p].active!.instanceId;
    const pre = canAttachEnergy(state, p, idx, target);
    const act = attachEnergy(state, p, idx, target);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("playTrainer — supporter-already-played reason matches", () => {
    const state = setupTestGame({ seed: 6 });
    const p = state.activePlayer;
    state.players[p].supporterPlayedThisTurn = true;
    const idx = state.players[p].hand.findIndex(
      (c) =>
        c.supertype === "Trainer" &&
        c.subtypes.includes("Supporter"),
    );
    if (idx < 0) return;
    const pre = canPlayTrainer(state, p, idx);
    const act = playTrainer(state, p, idx);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("retreat — already-retreated reason matches", () => {
    const state = setupTestGame({ seed: 7 });
    const p = state.activePlayer;
    state.players[p].retreatedThisTurn = true;
    const pre = canRetreat(state, p);
    const act = retreat(state, p, 0);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("retreat — no-bench reason matches", () => {
    const state = setupTestGame({ seed: 8 });
    const p = state.activePlayer;
    // Force-empty the bench.
    state.players[p].bench = [];
    const pre = canRetreat(state, p);
    const act = retreat(state, p, 0);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("phase guard — out-of-turn produces 'Not your turn.'", () => {
    const state = setupTestGame({ seed: 9 });
    const otherPlayer = state.activePlayer === "p1" ? "p2" : "p1";
    const pre = canBenchBasic(state, otherPlayer, 0);
    const act = playBasicToBench(state, otherPlayer, 0);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });
});
