// @vitest-environment jsdom

// Stage 2b regression — AiActionBanner uses a stable React key derived
// from LogEntry.seq so duplicate-text entries don't collide and remount.
// The bug we guard against: key={`${state.log.length}-${i}`} caused the
// rendered banner items to remount on every log append, producing visible
// flicker. The fix encodes WHY: identical-text duplicates within a turn
// must keep their DOM identity across re-renders.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AiActionBanner } from "../../App";
import { logEvent } from "../../engine/rules";
import { makeRng } from "../../engine/rng";
import type { GameState, PlayerState } from "../../engine/types";

afterEach(() => cleanup());

function mkPlayer(id: "p1" | "p2", name: string, isAI: boolean): PlayerState {
  return {
    id,
    name,
    deck: [],
    hand: [],
    discard: [],
    prizes: [],
    bench: [],
    active: null,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    retreatedThisTurn: false,
    mulligans: 0,
    setupComplete: true,
    thisTurnAttackBonuses: [],
    nextOpponentTurnDamageReductions: [],
    itemsBlockedNextTurn: false,
    stadiumUsedThisTurn: false,
    lastDitchUsedThisTurn: false,
    lastSupporterNameThisTurn: null,
    yourPokemonKoedLastOppTurn: false,
    yourPokemonKoedByAttackLastOppTurnNames: [],
    lastTurnPrizesTaken: 0,
    legacyEnergyUsed: false,
    isAI,
  } as PlayerState;
}

function mkState(): GameState {
  return {
    players: {
      p1: mkPlayer("p1", "You", false),
      p2: mkPlayer("p2", "AI", true),
    },
    activePlayer: "p2",
    turn: 5,
    phase: "main",
    winner: null,
    log: [],
    firstPlayer: "p1",
    firstTurnNoAttack: false,
    stadium: null,
    pendingPromote: null,
    pendingPromoteQueue: [],
    pendingHeavyBaton: null,
    pendingAttachQueue: null,
    pendingHandheldFan: null,
    pendingAmuletOfHope: null,
    onPromoteResolved: null,
    pendingSecondAttack: null,
    pendingPick: null,
    pendingSwitchTarget: null,
    pendingChoiceMenu: null,
    preComputedDiscardForDamage: null,
    pendingInPlayTarget: null,
    pendingHandReveal: null,
    pendingSearchNotice: null,
    pendingRareCandyChoice: null,
    snipeTargetOverride: null,
    coinFlip: null,
    rng: makeRng(1),
  } as GameState;
}

describe("AiActionBanner key stability (Stage 2b)", () => {
  it("assigns a monotonic seq to each logEvent call", () => {
    const state = mkState();
    logEvent(state, "p2", "AI draws for turn.");
    logEvent(state, "p2", "AI attaches Energy.");
    logEvent(state, "p2", "AI attaches Energy."); // duplicate text on purpose
    const seqs = state.log.map((e) => e.seq);
    expect(seqs).toEqual([0, 1, 2]);
    // Duplicate text entries have DIFFERENT seq values — that's the
    // collision-resistance property we need.
    expect(state.log[1].seq).not.toBe(state.log[2].seq);
  });

  it("keeps banner items mounted across re-renders when keyed by seq", () => {
    const state = mkState();
    logEvent(state, "p2", "AI draws for turn.");
    logEvent(state, "p2", "AI attaches Lightning Energy to Pikachu.");

    const { container, rerender } = render(<AiActionBanner state={state} active={true} />);
    // Scope to .ai-banner-line — the banner-label is a separate node.
    const initial = container.querySelectorAll(".ai-banner-line");
    expect(initial.length).toBe(2);
    const firstRef = initial[0];

    // Append a new entry. The earlier rendered nodes must keep their DOM
    // identity (same DOM node reference) — React reuses them because the
    // key is stable. Without the fix, key={`${state.log.length}-${i}`}
    // would remount every node on every append.
    logEvent(state, "p2", "AI plays Boss's Orders.");
    rerender(<AiActionBanner state={state} active={true} />);
    const after = container.querySelectorAll(".ai-banner-line");
    expect(after.length).toBe(3);
    expect(after[0]).toBe(firstRef);
  });

  it("falls back to a legacy key when an entry has no seq", () => {
    const state = mkState();
    // Push raw entries WITHOUT seq — simulates a replay loaded from
    // pre-2026-05-12 IDB. The fallback key (`legacy-${turn}-${i}-${text}`)
    // must still produce stable DOM identity across appends.
    state.log.push({ turn: 5, player: "p2", text: "Legacy entry A" });
    state.log.push({ turn: 5, player: "p2", text: "Legacy entry B" });

    const { container, rerender } = render(<AiActionBanner state={state} active={true} />);
    const initial = container.querySelectorAll(".ai-banner-line");
    expect(initial.length).toBe(2);
    const aRef = initial[0];

    // Append another legacy entry. The first two should keep DOM identity.
    state.log.push({ turn: 5, player: "p2", text: "Legacy entry C" });
    rerender(<AiActionBanner state={state} active={true} />);
    const after = container.querySelectorAll(".ai-banner-line");
    expect(after.length).toBe(3);
    expect(after[0]).toBe(aRef);
  });

  it("renders nothing when active is false", () => {
    const state = mkState();
    logEvent(state, "p2", "AI does something.");
    const { container } = render(<AiActionBanner state={state} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
