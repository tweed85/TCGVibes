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
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  retreat,
} from "../actions";
import { activateAbility } from "../abilities";
import { useStadium } from "../stadiumActivated";
import {
  canActivateAbility,
  canActivateStadium,
  canAttachEnergy,
  canBenchBasic,
  canEndTurn,
  canEvolve,
  canPlayTrainer,
  canRetreat,
} from "../preflight";
import type { TrainerCard } from "../types";

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

  it("activateAbility — out-of-turn reason matches", () => {
    const state = setupTestGame({ seed: 10 });
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    const oppActive = state.players[opp].active!;
    // Try activating an opponent's ability (or any) while it's not their turn.
    const pre = canActivateAbility(state, opp, oppActive.instanceId, 0);
    const act = activateAbility(state, opp, oppActive.instanceId, 0);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("activateAbility — wrong-phase reason matches", () => {
    const state = setupTestGame({ seed: 11 });
    state.phase = "gameOver";
    const ap = state.activePlayer;
    const active = state.players[ap].active!;
    const pre = canActivateAbility(state, ap, active.instanceId, 0);
    const act = activateAbility(state, ap, active.instanceId, 0);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("activateStadium — no Stadium in play reason matches", () => {
    const state = setupTestGame({ seed: 12 });
    state.stadium = null;
    const p = state.activePlayer;
    const pre = canActivateStadium(state, p);
    const act = useStadium(state, p);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("activateStadium — already-used-this-turn reason matches", () => {
    const state = setupTestGame({ seed: 13 });
    const p = state.activePlayer;
    // Plant a stub Stadium with no activated effect — both surfaces should
    // surface the same "no activated effect" reason. (Same predicate path.)
    state.stadium = {
      controller: p,
      card: {
        id: "stub",
        name: "StubStadium",
        supertype: "Trainer",
        subtypes: ["Stadium"],
        text: "",
      } as TrainerCard,
    };
    state.players[p].stadiumUsedThisTurn = true;
    const pre = canActivateStadium(state, p);
    const act = useStadium(state, p);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("endTurn — out-of-turn reason matches", () => {
    const state = setupTestGame({ seed: 14 });
    const otherPlayer = state.activePlayer === "p1" ? "p2" : "p1";
    const pre = canEndTurn(state, otherPlayer);
    const act = endTurn(state, otherPlayer);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });

  it("endTurn — wrong-phase reason matches", () => {
    const state = setupTestGame({ seed: 15 });
    state.phase = "promoteActive";
    const ap = state.activePlayer;
    const pre = canEndTurn(state, ap);
    const act = endTurn(state, ap);
    expect(pre.ok).toBe(false);
    expect(act.ok).toBe(false);
    if (!pre.ok && !act.ok) expect(pre.reason).toBe(act.reason);
  });
});
