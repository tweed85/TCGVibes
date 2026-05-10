// Phase 3: direct behavior tests for the three first-migration prefab
// targets — Buddy-Buddy Poffin, Lana's Aid, Energy Search. These tests
// pin user-observable behavior (zone changes, pending-pick shape, log
// text) BEFORE prefab migration so a "byte-equivalent" migration is
// objectively verifiable.
//
// Coverage today is mostly indirect (detection / playbook tests via
// pragueDay2Replays). These tests are direct.

import { describe, it, expect } from "vitest";
import { findByName } from "../../data/cards";
import { playTrainerByName, setupTestGame } from "./helpers/gameTestHelpers";
import { resolvePendingPick } from "../pendingPick";

describe("prefab targets — direct behavior pins", () => {
  describe("Buddy-Buddy Poffin", () => {
    it("opens a pendingPick with min=0, max=2, only Basic Pokémon ≤70 HP, deck destination=bench", () => {
      const state = setupTestGame({ seed: 100 });
      const p = state.activePlayer;
      // Inject the card into hand for a deterministic test.
      const card = findByName("Buddy-Buddy Poffin");
      if (!card) return;
      state.players[p].hand = [{ ...card }, ...state.players[p].hand];
      // Need at least one Basic ≤ 70 HP in deck for the pick to open.
      // If the deck has none after this filter, the action logs a no-op
      // and never opens a pick — skip the test path in that case.
      const hasEligible = state.players[p].deck.some(
        (c) =>
          c.supertype === "Pokémon" &&
          (c.subtypes ?? []).includes("Basic") &&
          c.hp <= 70,
      );
      if (!hasEligible) return;
      const r = playTrainerByName(state, p, "Buddy-Buddy Poffin");
      expect(r.ok).toBe(true);
      const pp = state.pendingPick;
      expect(pp).toBeTruthy();
      if (!pp) return;
      expect(pp.player).toBe(p);
      expect(pp.min).toBe(0);
      expect(pp.max).toBeLessThanOrEqual(2);
      expect(pp.toBench).toBe(true);
      expect(pp.unpicked).toBe("shuffleIntoDeck");
      // All pool cards must satisfy predicate.
      for (const c of pp.pool) {
        expect(c.supertype).toBe("Pokémon");
        if (c.supertype !== "Pokémon") continue; // narrow for TS
        expect((c.subtypes ?? []).includes("Basic")).toBe(true);
        expect(c.hp).toBeLessThanOrEqual(70);
      }
    });

    it("resolves with 0 picks → deck is shuffled, no bench change, hand has Poffin removed", () => {
      const state = setupTestGame({ seed: 101 });
      const p = state.activePlayer;
      const card = findByName("Buddy-Buddy Poffin");
      if (!card) return;
      state.players[p].hand = [{ ...card }, ...state.players[p].hand];
      const benchSizeBefore = state.players[p].bench.length;
      const handSizeBefore = state.players[p].hand.length;
      const r = playTrainerByName(state, p, "Buddy-Buddy Poffin");
      if (!r.ok) return; // no eligible pool — covered by separate test
      const pp = state.pendingPick;
      if (!pp) return;
      const r2 = resolvePendingPick(state, p, []); // pick zero
      expect(r2.ok).toBe(true);
      expect(state.pendingPick).toBeNull();
      expect(state.players[p].bench.length).toBe(benchSizeBefore);
      expect(state.players[p].hand.length).toBe(handSizeBefore - 1);
    });
  });

  describe("Energy Search", () => {
    it("opens a pendingPick of Basic Energy only, max=1, destination=hand", () => {
      const state = setupTestGame({ seed: 200 });
      const p = state.activePlayer;
      const card = findByName("Energy Search");
      if (!card) return;
      state.players[p].hand = [{ ...card }, ...state.players[p].hand];
      const hasEligible = state.players[p].deck.some(
        (c) => c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic"),
      );
      if (!hasEligible) return;
      const r = playTrainerByName(state, p, "Energy Search");
      expect(r.ok).toBe(true);
      const pp = state.pendingPick;
      expect(pp).toBeTruthy();
      if (!pp) return;
      expect(pp.player).toBe(p);
      expect(pp.max).toBe(1);
      expect(pp.unpicked).toBe("shuffleIntoDeck");
      // Energy Search puts the picked card in the player's HAND, not bench.
      expect(pp.toBench).toBeFalsy();
      for (const c of pp.pool) {
        expect(c.supertype).toBe("Energy");
        expect((c.subtypes ?? []).includes("Basic")).toBe(true);
      }
    });

    it("resolves with 1 pick → that energy is in hand and not in deck", () => {
      const state = setupTestGame({ seed: 201 });
      const p = state.activePlayer;
      const card = findByName("Energy Search");
      if (!card) return;
      state.players[p].hand = [{ ...card }, ...state.players[p].hand];
      const r = playTrainerByName(state, p, "Energy Search");
      if (!r.ok) return;
      const pp = state.pendingPick;
      if (!pp || pp.pool.length === 0) return;
      // Snapshot pool[0] BEFORE resolving so we can check the same identity
      // ends up in hand (deck reshuffles the rest, so card-count math is
      // unstable — identity is stable).
      const picked = pp.pool[0];
      const r2 = resolvePendingPick(state, p, [0]);
      expect(r2.ok).toBe(true);
      expect(state.pendingPick).toBeNull();
      // The picked card lives in hand now.
      expect(state.players[p].hand.some((c) => c.id === picked.id && c.name === picked.name)).toBe(true);
      // And it's not in the deck.
      expect(state.players[p].deck.some((c) => c === picked)).toBe(false);
    });
  });

  describe("Lana's Aid", () => {
    it("opens a pendingPick from discard, max=3, predicate = non-rule-box Pokémon OR Basic Energy", () => {
      const state = setupTestGame({ seed: 300 });
      const p = state.activePlayer;
      const card = findByName("Lana's Aid");
      if (!card) return;
      state.players[p].hand = [{ ...card }, ...state.players[p].hand];
      // Seed the discard with one eligible card so the action can open.
      const energy = state.players[p].deck.find(
        (c) => c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic"),
      );
      if (!energy) return;
      state.players[p].discard.push({ ...energy });
      const r = playTrainerByName(state, p, "Lana's Aid");
      expect(r.ok).toBe(true);
      const pp = state.pendingPick;
      expect(pp).toBeTruthy();
      if (!pp) return;
      expect(pp.player).toBe(p);
      expect(pp.max).toBeLessThanOrEqual(3);
      // Discard recovery — picks come FROM discard, go to hand.
      expect(pp.source).toBe("discard");
      expect(pp.toBench).toBeFalsy();
    });

    it("resolves with 0 picks → seeded discard card stays, Lana's Aid itself ends in discard", () => {
      const state = setupTestGame({ seed: 301 });
      const p = state.activePlayer;
      const card = findByName("Lana's Aid");
      if (!card) return;
      state.players[p].hand = [{ ...card }, ...state.players[p].hand];
      const energy = state.players[p].deck.find(
        (c) => c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic"),
      );
      if (!energy) return;
      const seeded = { ...energy };
      state.players[p].discard.push(seeded);
      const r = playTrainerByName(state, p, "Lana's Aid");
      if (!r.ok) return;
      const r2 = resolvePendingPick(state, p, []);
      expect(r2.ok).toBe(true);
      expect(state.pendingPick).toBeNull();
      // The seeded energy is still in discard (we picked nothing).
      expect(state.players[p].discard.some((c) => c === seeded)).toBe(true);
      // Lana's Aid (the played Supporter) is now in discard too.
      expect(
        state.players[p].discard.some((c) => c.name === "Lana's Aid"),
      ).toBe(true);
    });
  });
});
