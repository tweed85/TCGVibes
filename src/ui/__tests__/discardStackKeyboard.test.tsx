// @vitest-environment jsdom

// Stage 2a regression — DiscardStack opens the discard viewer via Enter
// and Space on BOTH branches (empty pile + non-empty pile). The bug we
// guard against: only the click handler was wired, so keyboard users
// couldn't reach the discard pile.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { DiscardStack } from "../../App";

afterEach(() => cleanup());
import type { Card, PlayerState } from "../../engine/types";

function mkCard(name: string): Card {
  return {
    id: `c-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Item"],
    text: "",
  } as Card;
}

function mkPlayer(discardCards: Card[]): PlayerState {
  return {
    id: "p1",
    name: "Tester",
    deck: [],
    hand: [],
    discard: discardCards,
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
    isAI: false,
  } as PlayerState;
}

describe("DiscardStack keyboard accessibility", () => {
  describe("empty discard", () => {
    it("fires onView for click, Enter, and Space — same handler, all three paths", () => {
      const onView = vi.fn();
      render(<DiscardStack player={mkPlayer([])} onView={onView} />);
      const stack = screen.getByTestId("discard-stack-empty");
      fireEvent.click(stack);
      expect(onView).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(stack, { key: "Enter" });
      expect(onView).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(stack, { key: " " });
      expect(onView).toHaveBeenCalledTimes(3);
    });

    it("is keyboard-focusable with role=button", () => {
      render(<DiscardStack player={mkPlayer([])} onView={vi.fn()} />);
      const stack = screen.getByTestId("discard-stack-empty");
      expect(stack).toHaveAttribute("role", "button");
      expect(stack).toHaveAttribute("tabIndex", "0");
    });

    it("does not fire onView for unrelated keys", () => {
      const onView = vi.fn();
      render(<DiscardStack player={mkPlayer([])} onView={onView} />);
      const stack = screen.getByTestId("discard-stack-empty");
      fireEvent.keyDown(stack, { key: "Escape" });
      fireEvent.keyDown(stack, { key: "a" });
      expect(onView).not.toHaveBeenCalled();
    });
  });

  describe("non-empty discard", () => {
    it("fires onView for click, Enter, and Space — same handler, all three paths", () => {
      const onView = vi.fn();
      render(
        <DiscardStack
          player={mkPlayer([mkCard("Ultra Ball"), mkCard("Boss's Orders")])}
          onView={onView}
        />,
      );
      const stack = screen.getByTestId("discard-stack-nonempty");
      fireEvent.click(stack);
      expect(onView).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(stack, { key: "Enter" });
      expect(onView).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(stack, { key: " " });
      expect(onView).toHaveBeenCalledTimes(3);
    });

    it("is keyboard-focusable with role=button", () => {
      render(
        <DiscardStack player={mkPlayer([mkCard("Ultra Ball")])} onView={vi.fn()} />,
      );
      const stack = screen.getByTestId("discard-stack-nonempty");
      expect(stack).toHaveAttribute("role", "button");
      expect(stack).toHaveAttribute("tabIndex", "0");
    });
  });
});
