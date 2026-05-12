// @vitest-environment jsdom

// VariantPicker — renders all printings of a single card name and routes
// click → onPick. Used by DeckBuilderModal for both "add" and "swap" flows.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VariantPicker } from "../VariantPicker";
import type { Card, TrainerCard } from "../../engine/types";

function mkPrint(id: string, name: string, setCode: string, number: string): TrainerCard {
  return {
    id,
    name,
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "",
    rules: [],
    setCode,
    number,
    imageLarge: `https://cdn.example/${setCode}/${number}.png`,
    imageSmall: `https://cdn.example/${setCode}/${number}_sm.png`,
  } as TrainerCard;
}

describe("VariantPicker", () => {
  it("renders one tile per printing with set+number labels", () => {
    const variants: Card[] = [
      mkPrint("me1-113", "Acerola's Mischief", "me1", "113"),
      mkPrint("me1-165", "Acerola's Mischief", "me1", "165"),
      mkPrint("me2pt5-180", "Acerola's Mischief", "me2pt5", "180"),
    ];
    const { container, getByText } = render(
      <VariantPicker variants={variants} onPick={() => {}} onClose={() => {}} />,
    );
    // One tile per printing.
    expect(container.querySelectorAll(".variant-picker-tile")).toHaveLength(3);
    // Set + number labels visible (using Limitless-style codes).
    expect(getByText(/MEG 113/)).toBeTruthy();
    expect(getByText(/MEG 165/)).toBeTruthy();
    expect(getByText(/ASC 180/)).toBeTruthy();
  });

  it("marks the current printing with a 'current' class + checkmark", () => {
    const variants: Card[] = [
      mkPrint("me1-113", "Acerola's Mischief", "me1", "113"),
      mkPrint("me1-165", "Acerola's Mischief", "me1", "165"),
    ];
    const { container } = render(
      <VariantPicker variants={variants} currentId="me1-165" onPick={() => {}} onClose={() => {}} />,
    );
    const tiles = container.querySelectorAll(".variant-picker-tile");
    expect(tiles[0].className).not.toContain("current");
    expect(tiles[1].className).toContain("current");
    // Checkmark renders only on the current tile.
    expect(container.querySelectorAll(".variant-picker-check")).toHaveLength(1);
  });

  it("fires onPick with the clicked card", () => {
    const variants: Card[] = [
      mkPrint("me1-113", "Acerola's Mischief", "me1", "113"),
      mkPrint("me1-165", "Acerola's Mischief", "me1", "165"),
    ];
    const onPick = vi.fn();
    const { container } = render(
      <VariantPicker variants={variants} onPick={onPick} onClose={() => {}} />,
    );
    const tiles = container.querySelectorAll(".variant-picker-tile");
    fireEvent.click(tiles[1]);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].id).toBe("me1-165");
  });

  it("backdrop click fires onClose; tile click does NOT", () => {
    const variants: Card[] = [
      mkPrint("me1-113", "Acerola's Mischief", "me1", "113"),
    ];
    const onClose = vi.fn();
    const onPick = vi.fn();
    const { container } = render(
      <VariantPicker variants={variants} onPick={onPick} onClose={onClose} />,
    );
    fireEvent.click(container.querySelector(".variant-picker-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".variant-picker-modal")!);
    // Modal click is stopPropagation'd; should not trigger onClose.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("returns null when given an empty variant list", () => {
    const { container } = render(
      <VariantPicker variants={[]} onPick={() => {}} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
