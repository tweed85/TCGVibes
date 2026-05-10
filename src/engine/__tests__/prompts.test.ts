// Phase 2: prompt projection tests.
//
// Confirms that the adapter in `prompts.ts` projects each currently-
// supported pending state into the new union without losing fields the
// UI cares about. The adapter is structural — these tests pin the shape
// rather than re-asserting engine behavior (which is covered upstream).

import { describe, it, expect } from "vitest";
import { findByName } from "../../data/cards";
import {
  playTrainerByName,
  setupTestGame,
} from "./helpers/gameTestHelpers";
import {
  activePrompt,
  activePrompts,
  pendingPickToPrompt,
  type DeckPickPrompt,
  type DiscardPickPrompt,
} from "../prompts";

describe("PendingPrompt projection", () => {
  it("Buddy-Buddy Poffin → DeckPickPrompt with pickedDestination=bench", () => {
    const state = setupTestGame({ seed: 100 });
    const p = state.activePlayer;
    const card = findByName("Buddy-Buddy Poffin");
    if (!card) return;
    state.players[p].hand = [{ ...card }, ...state.players[p].hand];
    const hasEligible = state.players[p].deck.some(
      (c) =>
        c.supertype === "Pokémon" &&
        (c.subtypes ?? []).includes("Basic") &&
        c.hp <= 70,
    );
    if (!hasEligible) return;
    const r = playTrainerByName(state, p, "Buddy-Buddy Poffin");
    expect(r.ok).toBe(true);
    const prompt = activePrompt(state);
    expect(prompt).toBeTruthy();
    if (!prompt) return;
    expect(prompt.kind).toBe("deckPick");
    if (prompt.kind !== "deckPick") return;
    expect(prompt.player).toBe(p);
    expect(prompt.pickedDestination).toBe("bench");
    expect(prompt.unpicked).toBe("shuffleIntoDeck");
    expect(prompt.min).toBe(0);
    expect(prompt.max).toBeLessThanOrEqual(2);
    // Direct adapter invocation produces the same projection.
    const direct = pendingPickToPrompt(state.pendingPick!);
    expect(direct).toEqual(prompt);
  });

  it("Energy Search → DeckPickPrompt with pickedDestination=hand", () => {
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
    const prompt = activePrompt(state) as DeckPickPrompt | null;
    expect(prompt).toBeTruthy();
    if (!prompt) return;
    expect(prompt.kind).toBe("deckPick");
    expect(prompt.pickedDestination).toBe("hand");
  });

  it("Lana's Aid → DiscardPickPrompt with pickedDestination=hand", () => {
    const state = setupTestGame({ seed: 300 });
    const p = state.activePlayer;
    const card = findByName("Lana's Aid");
    if (!card) return;
    state.players[p].hand = [{ ...card }, ...state.players[p].hand];
    const energy = state.players[p].deck.find(
      (c) => c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic"),
    );
    if (!energy) return;
    state.players[p].discard.push({ ...energy });
    const r = playTrainerByName(state, p, "Lana's Aid");
    expect(r.ok).toBe(true);
    const prompt = activePrompt(state) as DiscardPickPrompt | null;
    expect(prompt).toBeTruthy();
    if (!prompt) return;
    expect(prompt.kind).toBe("discardPick");
    expect(prompt.pickedDestination).toBe("hand");
    expect(prompt.player).toBe(p);
  });

  it("activePrompts returns [] when no pending state is open", () => {
    const state = setupTestGame({ seed: 400 });
    expect(activePrompts(state)).toEqual([]);
    expect(activePrompt(state)).toBeNull();
  });

  it("activePrompt(state, viewer) prefers prompts owned by viewer", () => {
    const state = setupTestGame({ seed: 500 });
    const p = state.activePlayer;
    const card = findByName("Buddy-Buddy Poffin");
    if (!card) return;
    state.players[p].hand = [{ ...card }, ...state.players[p].hand];
    const hasEligible = state.players[p].deck.some(
      (c) =>
        c.supertype === "Pokémon" &&
        (c.subtypes ?? []).includes("Basic") &&
        c.hp <= 70,
    );
    if (!hasEligible) return;
    playTrainerByName(state, p, "Buddy-Buddy Poffin");
    const ownPrompt = activePrompt(state, p);
    expect(ownPrompt?.player).toBe(p);
    // Viewer = opponent → no prompt belongs to them, so it falls back to
    // the first available (which still has player = p).
    const opp = p === "p1" ? "p2" : "p1";
    const fallback = activePrompt(state, opp);
    expect(fallback?.player).toBe(p);
  });
});
