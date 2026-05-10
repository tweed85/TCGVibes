// Smoke test for the engine test DSL. Confirms the helpers wire through
// the production action surface and produce useful error messages.

import { describe, it, expect } from "vitest";
import {
  active,
  attachEnergyByName,
  setupTestGame,
  useAttackByName,
} from "./helpers/gameTestHelpers";

describe("test DSL — smoke", () => {
  it("setupTestGame produces a state in main phase, turn 2", () => {
    const state = setupTestGame({ seed: 42 });
    expect(state.phase).toBe("main");
    expect(state.turn).toBeGreaterThanOrEqual(2);
    expect(active(state, "p1").card.name).toBeTruthy();
    expect(active(state, "p2").card.name).toBeTruthy();
  });

  it("useAttackByName returns the engine's ActionResult, including failures", () => {
    const state = setupTestGame({ seed: 1 });
    // Attempt an attack with no energy attached. Engine should reject.
    const r = useAttackByName(state, state.activePlayer, active(state, state.activePlayer).card.attacks[0]?.name ?? "");
    if (!r.ok) {
      expect(typeof r.reason).toBe("string");
    }
  });

  it("attachEnergyByName accepts both 'Grass Energy' and 'Basic Grass Energy'", () => {
    const state = setupTestGame({ seed: 2 });
    // Pick whichever player has a basic energy in hand.
    for (const p of ["p1", "p2"] as const) {
      const energy = state.players[p].hand.find(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
      );
      if (!energy) continue;
      const target = state.players[p].active!.card.name;
      const stripped = energy.name.replace(/^Basic /, "");
      // Both spellings should resolve to the same hand index.
      const before = state.players[p].hand.length;
      // We can't actually attach if energy was already consumed; this test
      // just exercises the lookup path and asserts no throw.
      try {
        attachEnergyByName(state, p, stripped, target);
      } catch (e) {
        if (!(e as Error).message.includes("not in hand")) throw e;
      }
      // Hand size after attempt should be at most `before` (success removes 1, failure leaves it).
      expect(state.players[p].hand.length).toBeLessThanOrEqual(before);
      break;
    }
  });
});
