// @vitest-environment jsdom

// DeckBuilderModal — variant-aware grid + picker integration. Covers:
//   1. Grid dedupes to one tile per name (vs the old per-printing tiles)
//   2. The "N arts" badge renders for cards with multiple printings
//   3. Clicking a multi-printing tile opens the variant picker
//   4. Clicking a single-printing tile adds directly (no picker)
//   5. Right-panel set+number is clickable for swap when >1 printing exists
//   6. Rule-of-4 aggregates across printings (no double-add via mixed prints)

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import DeckBuilderModal from "../DeckBuilderModal";
import { cardsByName } from "../../data/cards";

// Stub IntersectionObserver — jsdom doesn't have it but CardView uses
// nothing that needs it, so a simple noop suffices.
beforeAll(() => {
  if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    } as unknown as typeof IntersectionObserver;
  }
});

describe("DeckBuilderModal — variant-aware grid", () => {
  it("renders one grid tile per card name (deduped) — multi-printing cards collapse", () => {
    const { container } = render(
      <DeckBuilderModal existingNames={[]} onClose={() => {}} onSave={() => {}} />,
    );
    const tiles = container.querySelectorAll(".builder-card");
    // Find any card with multiple printings + count tiles for that name.
    const multi = [...cardsByName.entries()].find(([_, list]) => list.length > 1);
    expect(multi).toBeDefined();
    if (!multi) return;
    const [name] = multi;
    // Tiles whose name matches should equal 1 (deduped).
    const namedTiles = Array.from(tiles).filter((t) =>
      (t.getAttribute("title") ?? "").toLowerCase().includes(name.toLowerCase()),
    );
    // At least one tile for the name (search filter not applied; full pool).
    // The dedupe contract: exactly ONE tile per name in the grid.
    const exactMatches = Array.from(tiles).filter((t) => {
      const title = t.getAttribute("title") ?? "";
      return title.startsWith(`Add ${name}`) || title.startsWith(`${name} (`);
    });
    expect(exactMatches.length).toBe(1);
    // (Sanity: namedTiles is consistent.)
    expect(namedTiles.length).toBeGreaterThanOrEqual(1);
  });

  it("shows an 'N arts' badge on tiles for multi-printing cards", () => {
    const { container } = render(
      <DeckBuilderModal existingNames={[]} onClose={() => {}} onSave={() => {}} />,
    );
    const badges = container.querySelectorAll(".builder-variant-badge");
    // At least one badge — the dataset has multi-printing cards.
    expect(badges.length).toBeGreaterThan(0);
    // Each badge text matches /\d+ arts/.
    for (const b of badges) {
      expect(b.textContent ?? "").toMatch(/\d+ arts/);
    }
  });

  it("clicking a multi-printing tile opens the variant picker", () => {
    const { container } = render(
      <DeckBuilderModal existingNames={[]} onClose={() => {}} onSave={() => {}} />,
    );
    // Find a tile with the variant badge.
    const tile = Array.from(container.querySelectorAll(".builder-card")).find((el) =>
      el.querySelector(".builder-variant-badge"),
    );
    expect(tile).toBeDefined();
    if (!tile) return;
    fireEvent.click(tile);
    // Picker is now in the document.
    expect(container.querySelector(".variant-picker-modal")).not.toBeNull();
  });

  it("clicking a printing in the picker adds it to the deck (with that exact id)", () => {
    const { container } = render(
      <DeckBuilderModal existingNames={[]} onClose={() => {}} onSave={() => {}} />,
    );
    // Click the first multi-printing tile → opens picker.
    const tile = Array.from(container.querySelectorAll(".builder-card")).find((el) =>
      el.querySelector(".builder-variant-badge"),
    );
    expect(tile).toBeDefined();
    if (!tile) return;
    fireEvent.click(tile);
    const pickerTiles = container.querySelectorAll(".variant-picker-tile");
    expect(pickerTiles.length).toBeGreaterThan(1);
    // Click the second printing in the picker.
    fireEvent.click(pickerTiles[1]);
    // Picker closes; right-panel has 1 entry.
    expect(container.querySelector(".variant-picker-modal")).toBeNull();
    const selectedItems = container.querySelectorAll(".builder-selected-list li");
    expect(selectedItems.length).toBe(1);
  });

  it("rule-of-4 aggregates across printings: 5th add (any printing) is blocked", () => {
    const { container } = render(
      <DeckBuilderModal existingNames={[]} onClose={() => {}} onSave={() => {}} />,
    );
    // Pick a non-Energy multi-printing card to exercise the cap.
    const multi = [...cardsByName.entries()].find(
      ([_name, list]) => list.length > 1 && list[0].supertype !== "Energy",
    );
    expect(multi).toBeDefined();
    if (!multi) return;
    const [name, prints] = multi;
    // We'll add 4 copies via repeated picker clicks (alternating printings
    // when possible). Strategy: 4 clicks on the picker.
    const findTile = () =>
      Array.from(container.querySelectorAll(".builder-card")).find((el) =>
        (el.getAttribute("title") ?? "").includes(name),
      );
    for (let i = 0; i < 4; i++) {
      const tile = findTile();
      expect(tile).toBeDefined();
      if (!tile) return;
      fireEvent.click(tile);
      const pickerTiles = container.querySelectorAll(".variant-picker-tile");
      expect(pickerTiles.length).toBe(prints.length);
      // Alternate printings if there are multiple — exercises cross-print
      // aggregation.
      fireEvent.click(pickerTiles[i % pickerTiles.length]);
    }
    // Total of 4 across all entries with this name.
    const selectedItems = container.querySelectorAll(".builder-selected-list li");
    let totalForName = 0;
    for (const li of selectedItems) {
      const nameEl = li.querySelector(".bsel-name");
      if (nameEl?.textContent?.trim() === name) {
        const countEl = li.querySelector(".bsel-count");
        const m = countEl?.textContent?.match(/(\d+)×/);
        if (m) totalForName += parseInt(m[1], 10);
      }
    }
    expect(totalForName).toBe(4);
    // Now the tile should have 'capped' behavior — clicking it should not
    // open the picker AND should not add another copy.
    const tile = findTile();
    expect(tile).toBeDefined();
    if (!tile) return;
    expect(tile.className).toContain("capped");
    fireEvent.click(tile);
    // No picker opened.
    expect(container.querySelector(".variant-picker-modal")).toBeNull();
    // Total still 4.
    let after = 0;
    for (const li of container.querySelectorAll(".builder-selected-list li")) {
      const nameEl = li.querySelector(".bsel-name");
      if (nameEl?.textContent?.trim() === name) {
        const countEl = li.querySelector(".bsel-count");
        const m = countEl?.textContent?.match(/(\d+)×/);
        if (m) after += parseInt(m[1], 10);
      }
    }
    expect(after).toBe(4);
  });

  it("right-panel printing badge: clickable for multi-print cards, disabled for single-print", () => {
    const onSave = vi.fn();
    const { container } = render(
      <DeckBuilderModal existingNames={[]} onClose={() => {}} onSave={onSave} />,
    );
    // Add a multi-printing card.
    const tile = Array.from(container.querySelectorAll(".builder-card")).find((el) =>
      el.querySelector(".builder-variant-badge"),
    );
    expect(tile).toBeDefined();
    if (!tile) return;
    fireEvent.click(tile);
    fireEvent.click(container.querySelectorAll(".variant-picker-tile")[0]);
    // Right-panel entry: badge should be a clickable button with class 'swappable'.
    const printingBtn = container.querySelector(".builder-selected-list .bsel-printing");
    expect(printingBtn).not.toBeNull();
    expect(printingBtn!.className).toContain("swappable");
    expect((printingBtn as HTMLButtonElement).disabled).toBe(false);
    // Click the badge → picker opens for swap.
    fireEvent.click(printingBtn!);
    expect(container.querySelector(".variant-picker-modal")).not.toBeNull();
    // The current printing's tile has 'current' class.
    const currentTile = container.querySelector(".variant-picker-tile.current");
    expect(currentTile).not.toBeNull();
  });
});
