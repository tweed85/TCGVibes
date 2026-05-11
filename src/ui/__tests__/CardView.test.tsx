// @vitest-environment jsdom

// M3 regression — energy-pip glyphs render distinct 2-letter codes for
// colorblind-collision pairs (Fire/Fighting, Darkness/Dragon, Fairy) and
// the layout-relevant CSS classes are present so pips can disambiguate
// without depending on color alone. We can't verify rendered pixel widths
// in jsdom (it doesn't lay out), but we can verify the className wiring +
// glyph contents — those are what M3 actually changed.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PokemonInPlayView } from "../CardView";
import type { Card, EnergyCard, EnergyType, PokemonCard, PokemonInPlay } from "../../engine/types";

function mkEnergy(provides: EnergyType[]): EnergyCard {
  const primary = provides[0];
  return {
    id: `e-${primary.toLowerCase()}`,
    name: `Basic ${primary} Energy`,
    supertype: "Energy",
    subtypes: ["Basic"],
    provides,
  } as EnergyCard;
}

function mkTool(name: string, imageSmall?: string): Card {
  return {
    id: `tool-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "",
    rules: [],
    imageSmall,
  } as Card;
}

function mkInPlay(attached: EnergyType[][], tools: Card[] = []): PokemonInPlay {
  const card: PokemonCard = {
    id: "test-pkmn",
    name: "TestMon",
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 100,
    types: ["Colorless"],
    attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10 }],
    retreatCost: [],
  } as PokemonCard;
  return {
    instanceId: "p1",
    card,
    damage: 0,
    attachedEnergy: attached.map(mkEnergy),
    evolvedFrom: [],
    tools,
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  } as PokemonInPlay;
}

describe("PokemonInPlayView energy pips (M3)", () => {
  it("renders 2-letter codes for collision-prone types", () => {
    const p = mkInPlay([
      ["Fire"], ["Fighting"], ["Darkness"], ["Dragon"],
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    expect(pips).toHaveLength(4);
    // Colorblind viewers must be able to read each pair without color.
    expect(pips[0].textContent).toBe("Fr"); // Fire
    expect(pips[1].textContent).toBe("Ft"); // Fighting
    expect(pips[2].textContent).toBe("Dk"); // Darkness
    expect(pips[3].textContent).toBe("Dr"); // Dragon
  });

  it("renders 2-letter code for Fairy", () => {
    const p = mkInPlay([["Fairy"]]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pip = container.querySelector(".energy-pip");
    expect(pip?.textContent).toBe("Fy");
  });

  it("renders single-letter glyphs for non-colliding types", () => {
    const p = mkInPlay([
      ["Water"], ["Grass"], ["Lightning"], ["Psychic"],
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    const text = Array.from(pips).map((el) => el.textContent);
    expect(text).toEqual(["W", "G", "L", "P"]);
  });

  it("renders single-letter glyphs for Metal and Colorless", () => {
    const p = mkInPlay([["Metal"], ["Colorless"]]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    const text = Array.from(pips).map((el) => el.textContent);
    expect(text).toEqual(["M", "C"]);
  });

  it("renders wildcard glyph for multi-type Special Energy", () => {
    const p = mkInPlay([["Fire", "Water", "Grass"]]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pip = container.querySelector(".energy-pip");
    expect(pip).not.toBeNull();
    expect(pip!.textContent).toBe("*");
    expect(pip!.classList.contains("energy-wild")).toBe(true);
  });

  it("each pip carries its type-specific class for color theming", () => {
    // Color-only differentiation isn't enough for a11y, but it's still the
    // primary visual signal for sighted users — verify it's wired.
    const p = mkInPlay([["Fire"], ["Fighting"]]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    expect(pips[0].classList.contains("energy-Fire")).toBe(true);
    expect(pips[1].classList.contains("energy-Fighting")).toBe(true);
  });

  it("a full board (5 attached energies) collapses into a readable count token", () => {
    // Premium board treatment shows the first few physical tokens and a
    // compact count token instead of wrapping tiny pips across the card text.
    const p = mkInPlay([
      ["Fire"], ["Fighting"], ["Water"], ["Grass"], ["Lightning"],
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    expect(pips).toHaveLength(3);
    const count = container.querySelector(".energy-stack-count");
    expect(count?.textContent).toBe("+2");
    expect(count?.getAttribute("aria-label")).toBe("2 additional attached Energy");
  });

  it("renders premium token classes for attached energy", () => {
    const p = mkInPlay([["Fire"]]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const token = container.querySelector(".energy-token");
    expect(token).not.toBeNull();
    expect(token!.classList.contains("energy-pip")).toBe(true);
    expect(token!.classList.contains("energy-Fire")).toBe(true);
  });

  it("renders tools as card-like chips with accessible names", () => {
    const p = mkInPlay([], [
      mkTool("Hero's Cape", "https://example.test/heros-cape.png"),
      mkTool("Air Balloon"),
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const chips = container.querySelectorAll(".tool-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].getAttribute("aria-label")).toBe("Hero's Cape");
    expect(chips[0].querySelector("img")?.getAttribute("src")).toBe("https://example.test/heros-cape.png");
    expect(chips[1].querySelector(".tool-icon")).not.toBeNull();
  });

  it("collapses extra attached tools into a count badge", () => {
    const p = mkInPlay([], [
      mkTool("Hero's Cape"),
      mkTool("Air Balloon"),
      mkTool("Rescue Board"),
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    expect(container.querySelectorAll(".tool-chip")).toHaveLength(2);
    expect(container.querySelector(".tool-more")?.textContent).toBe("+1");
  });
});
