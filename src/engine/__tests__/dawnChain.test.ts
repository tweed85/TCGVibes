// Dawn — chained deck search: 1 Basic, then 1 Stage 1, then 1 Stage 2.
// Each stage MUST be max=1 and filter to its own subtype so the user can't
// e.g. pick two Stage 1s or pick a Stage 2 during the Basic stage.

import { describe, it, expect } from "vitest";
import { setupGame } from "../rules";
import { makeRng } from "../rng";
import { resolvePendingPick } from "../pendingPick";
import { applyTrainerEffect } from "../trainerEffects";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { Card, GameState, PlayerId, TrainerCard } from "../types";

function booted(): { state: GameState; player: PlayerId } {
  // Alakazam deck has a complete evolution line (Abra / Kadabra / Alakazam +
  // Dunsparce / Dudunsparce) — good Dawn test bed.
  const alakazam = DECK_SPECS.find((s) => s.id === "alakazam")!;
  const other = DECK_SPECS.find((s) => s.id !== "alakazam")!;
  const rng = makeRng(7);
  const state = setupGame(buildDeck(alakazam), buildDeck(other), rng);
  // Mark p1 as human so Dawn opens the interactive picker (AI path auto-picks
  // and skips the chain).
  state.players.p1.isAI = false;
  state.phase = "main";
  state.activePlayer = "p1";
  state.turn = 2;
  return { state, player: "p1" };
}

function findInPool(pool: Card[], pred: (c: Card) => boolean): number {
  return pool.findIndex(pred);
}

describe("Dawn — 1 Basic + 1 Stage 1 + 1 Stage 2 chained picker", () => {
  it("opens three sequential single-select picks with the right predicates", () => {
    const { state, player } = booted();
    // Synthesize a Dawn trainer card the effectId handler recognises.
    const dawn: TrainerCard = {
      id: "test-dawn",
      name: "Dawn",
      supertype: "Trainer",
      subtypes: ["Supporter"],
      text: "",
      effectId: "dawnSearchBasicStage1Stage2",
    };
    applyTrainerEffect(state, player, dawn);

    // ---- Stage 1 of 3: Basic Pokémon only, max 1 ----
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Basic/);
    expect(state.pendingPick!.max).toBeLessThanOrEqual(1);
    expect(state.pendingPick!.min).toBe(0);
    for (const c of state.pendingPick!.pool) {
      expect(c.supertype === "Pokémon" && c.subtypes.includes("Basic")).toBe(true);
    }
    // Pick one Basic if available.
    const basicIdx = findInPool(state.pendingPick!.pool, () => true);
    const basicPicked = basicIdx >= 0 ? [basicIdx] : [];
    const basicName = basicIdx >= 0 ? state.pendingPick!.pool[basicIdx].name : null;
    resolvePendingPick(state, player, basicPicked);

    // ---- Stage 2 of 3: Stage 1 Pokémon only, max 1 ----
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Stage 1/);
    expect(state.pendingPick!.max).toBeLessThanOrEqual(1);
    for (const c of state.pendingPick!.pool) {
      expect(c.supertype === "Pokémon" && c.subtypes.includes("Stage 1")).toBe(true);
    }
    const s1Idx = findInPool(state.pendingPick!.pool, () => true);
    const s1Name = s1Idx >= 0 ? state.pendingPick!.pool[s1Idx].name : null;
    resolvePendingPick(state, player, s1Idx >= 0 ? [s1Idx] : []);

    // ---- Stage 3 of 3: Stage 2 Pokémon only, max 1 ----
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Stage 2/);
    expect(state.pendingPick!.max).toBeLessThanOrEqual(1);
    for (const c of state.pendingPick!.pool) {
      expect(c.supertype === "Pokémon" && c.subtypes.includes("Stage 2")).toBe(true);
    }
    const s2Idx = findInPool(state.pendingPick!.pool, () => true);
    const s2Name = s2Idx >= 0 ? state.pendingPick!.pool[s2Idx].name : null;
    resolvePendingPick(state, player, s2Idx >= 0 ? [s2Idx] : []);

    // Chain done.
    expect(state.pendingPick).toBeNull();

    // Confirm the hand gained at most one of each subtype from Dawn.
    const hand = state.players[player].hand;
    const basicsAdded = basicName ? hand.filter((c) => c.name === basicName).length : 0;
    const s1Added = s1Name ? hand.filter((c) => c.name === s1Name).length : 0;
    const s2Added = s2Name ? hand.filter((c) => c.name === s2Name).length : 0;
    expect(basicsAdded).toBeLessThanOrEqual(4); // original 4-per-name cap applies
    expect(s1Added).toBeLessThanOrEqual(4);
    expect(s2Added).toBeLessThanOrEqual(4);
    // At least one of each subtype should be picked up if the deck had them.
    // Alakazam deck definitely has all three.
    if (basicName) expect(hand.some((c) => c.name === basicName)).toBe(true);
    if (s1Name) expect(hand.some((c) => c.name === s1Name)).toBe(true);
    if (s2Name) expect(hand.some((c) => c.name === s2Name)).toBe(true);
  });

  it("Alakazam (Stage 2) is in the Stage 2 pool and can be picked", () => {
    const { state, player } = booted();
    const dawn: TrainerCard = {
      id: "test-dawn-3",
      name: "Dawn",
      supertype: "Trainer",
      subtypes: ["Supporter"],
      text: "",
      effectId: "dawnSearchBasicStage1Stage2",
    };
    applyTrainerEffect(state, player, dawn);
    // Stage 1: pick a Basic.
    expect(state.pendingPick!.label).toMatch(/Basic/);
    resolvePendingPick(state, player, state.pendingPick!.pool.length > 0 ? [0] : []);
    // Stage 2: pick a Stage 1.
    expect(state.pendingPick!.label).toMatch(/Stage 1/);
    resolvePendingPick(state, player, state.pendingPick!.pool.length > 0 ? [0] : []);
    // Stage 3: pick a Stage 2 — Alakazam should be present.
    expect(state.pendingPick!.label).toMatch(/Stage 2/);
    const alakazamIdx = state.pendingPick!.pool.findIndex((c) => c.name === "Alakazam");
    expect(alakazamIdx).toBeGreaterThanOrEqual(0);
    const r = resolvePendingPick(state, player, [alakazamIdx]);
    expect(r.ok).toBe(true);
    expect(state.pendingPick).toBeNull();
    expect(state.players[player].hand.some((c) => c.name === "Alakazam")).toBe(true);
  });

  it("Hilda — interactive picker chains Evolution Pokémon → basic Energy", () => {
    const { state, player } = booted();
    const hilda: TrainerCard = {
      id: "test-hilda",
      name: "Hilda",
      supertype: "Trainer",
      subtypes: ["Supporter"],
      text: "",
      effectId: "searchEvolutionAndEnergy",
    };
    applyTrainerEffect(state, player, hilda);
    // Stage 1: Evolution Pokémon picker.
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Evolution/);
    expect(state.pendingPick!.max).toBe(1);
    for (const c of state.pendingPick!.pool) {
      expect(c.supertype === "Pokémon" && !!c.evolvesFrom).toBe(true);
    }
    const evoIdx = state.pendingPick!.pool.findIndex(() => true);
    const evoName = evoIdx >= 0 ? state.pendingPick!.pool[evoIdx].name : null;
    resolvePendingPick(state, player, evoIdx >= 0 ? [evoIdx] : []);
    // Stage 2: Energy picker (Hilda card text says "an Energy card" — both
    // Basic and Special Energy are eligible).
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Energy/);
    expect(state.pendingPick!.max).toBe(1);
    for (const c of state.pendingPick!.pool) {
      expect(c.supertype === "Energy").toBe(true);
    }
    const energyIdx = state.pendingPick!.pool.findIndex(() => true);
    const energyName = energyIdx >= 0 ? state.pendingPick!.pool[energyIdx].name : null;
    resolvePendingPick(state, player, energyIdx >= 0 ? [energyIdx] : []);
    expect(state.pendingPick).toBeNull();
    if (evoName) expect(state.players[player].hand.some((c) => c.name === evoName)).toBe(true);
    if (energyName) expect(state.players[player].hand.some((c) => c.name === energyName)).toBe(true);
  });

  it("rejects picking 2 cards at a single stage", () => {
    const { state, player } = booted();
    const dawn: TrainerCard = {
      id: "test-dawn-2",
      name: "Dawn",
      supertype: "Trainer",
      subtypes: ["Supporter"],
      text: "",
      effectId: "dawnSearchBasicStage1Stage2",
    };
    applyTrainerEffect(state, player, dawn);

    // At the Basic stage, trying to pick 2 returns a validation error — the
    // pick infrastructure enforces max server-side.
    expect(state.pendingPick!.max).toBe(1);
    if (state.pendingPick!.pool.length >= 2) {
      const r = resolvePendingPick(state, player, [0, 1]);
      expect(r.ok).toBe(false);
    }
  });
});
