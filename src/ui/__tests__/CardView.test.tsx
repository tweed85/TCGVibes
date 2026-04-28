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
import type { EnergyCard, EnergyType, PokemonCard, PokemonInPlay } from "../../engine/types";

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

function mkInPlay(attached: EnergyType[][]): PokemonInPlay {
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
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  } as PokemonInPlay;
}

describe("PokemonInPlayView energy pips (M3)", () => {
  it("renders 2-letter codes for collision-prone types", () => {
    const p = mkInPlay([
      ["Fire"], ["Fighting"], ["Darkness"], ["Dragon"], ["Fairy"],
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    expect(pips).toHaveLength(5);
    // Colorblind viewers must be able to read each pair without color.
    expect(pips[0].textContent).toBe("Fr"); // Fire
    expect(pips[1].textContent).toBe("Ft"); // Fighting
    expect(pips[2].textContent).toBe("Dk"); // Darkness
    expect(pips[3].textContent).toBe("Dr"); // Dragon
    expect(pips[4].textContent).toBe("Fy"); // Fairy
  });

  it("renders single-letter glyphs for non-colliding types", () => {
    const p = mkInPlay([
      ["Water"], ["Grass"], ["Lightning"], ["Psychic"], ["Metal"], ["Colorless"],
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    const text = Array.from(pips).map((el) => el.textContent);
    expect(text).toEqual(["W", "G", "L", "P", "M", "C"]);
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

  it("a full board (5 attached energies) renders all pips without dropping any", () => {
    // Pre-fix concern: widening the pip from 14px circle to 18px+ rounded
    // rectangle could overflow in-play-overlay. The CSS uses `flex-wrap:
    // wrap` to handle multi-line spillover; here we just confirm the DOM
    // contains the expected count regardless of how it wraps visually.
    const p = mkInPlay([
      ["Fire"], ["Fighting"], ["Water"], ["Grass"], ["Lightning"],
    ]);
    const { container } = render(<PokemonInPlayView p={p} />);
    const pips = container.querySelectorAll(".energy-pip");
    expect(pips).toHaveLength(5);
  });
});
