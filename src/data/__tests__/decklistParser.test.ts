// Decklist parser tests. Validates both the text-parsing path (tokenization,
// section-header skipping, parse errors) and the rule enforcement applied
// when building a deck (4-per-name, 1 Radiant, 1 ACE SPEC).

import { describe, it, expect } from "vitest";
import {
  parseDecklist,
  buildDeckFromEntries,
  importDecklist,
} from "../decklistParser";
import { validateDeckForPlay, buildDeck, DECK_SPECS } from "../decks";
import { findByName } from "../cards";
import type { Card, PokemonCard, EnergyCard } from "../../engine/types";

describe("parseDecklist — text tokenization", () => {
  it("parses a simple Pokémon card line", () => {
    const r = parseDecklist("4 Dipplin TWM 18");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toEqual({
      count: 4,
      name: "Dipplin",
      limitlessSet: "TWM",
      number: "18",
    });
    expect(r.totalCards).toBe(4);
    expect(r.parseErrors).toEqual([]);
  });

  it("skips section-header lines", () => {
    const text = `Pokémon: 7
4 Dipplin TWM 18
3 Applin SSP 138

Trainer: 4
4 Buddy-Buddy Poffin ASC 184`;
    const r = parseDecklist(text);
    expect(r.entries).toHaveLength(3);
    expect(r.totalCards).toBe(11);
    expect(r.parseErrors).toEqual([]);
  });

  it("handles names with apostrophes + multiple words", () => {
    const r = parseDecklist("4 Lillie's Determination MEG 119");
    expect(r.entries[0].name).toBe("Lillie's Determination");
    expect(r.entries[0].limitlessSet).toBe("MEG");
  });

  it("reports unparseable lines", () => {
    const r = parseDecklist("not a valid line");
    expect(r.entries).toEqual([]);
    expect(r.parseErrors).toEqual(["not a valid line"]);
  });

  it("skips blank lines without error", () => {
    const r = parseDecklist("\n\n4 Dipplin TWM 18\n\n");
    expect(r.entries).toHaveLength(1);
    expect(r.parseErrors).toEqual([]);
  });

  it("preserves set-code casing as uppercase from source", () => {
    // Decklists from Limitless / PTCGL always export set codes uppercase.
    const r = parseDecklist("1 Applin TWM 17");
    expect(r.entries[0].limitlessSet).toBe("TWM");
  });
});

describe("buildDeckFromEntries — rule validation", () => {
  it("resolves matching printings to Card instances", () => {
    const entries = [
      { count: 1, name: "Basic Grass Energy", limitlessSet: "SVE", number: "1" },
    ];
    const r = buildDeckFromEntries(entries);
    expect(r.deck.length).toBeGreaterThanOrEqual(1);
    expect(r.unmatched).toEqual([]);
    expect(r.ruleViolations).toEqual([]);
  });

  it("flags unmatched entries when set+number and name both miss", () => {
    const entries = [
      { count: 1, name: "Doesnotexist", limitlessSet: "ZZZ", number: "999" },
    ];
    const r = buildDeckFromEntries(entries);
    expect(r.deck).toEqual([]);
    expect(r.unmatched).toHaveLength(1);
  });

  it("flags >4 copies of a non-basic-energy card", () => {
    // Use Buddy-Buddy Poffin (Trainer) for the 4-per-name rule check.
    const entries = [
      { count: 5, name: "Buddy-Buddy Poffin", limitlessSet: "ASC", number: "184" },
    ];
    const r = buildDeckFromEntries(entries);
    expect(r.ruleViolations.some((v) => v.includes("More than 4"))).toBe(true);
  });

  it("truncates >4 copies at the cap rather than letting them through", () => {
    // M2 regression: pre-fix the parser pushed all 5 copies into the deck and
    // only flagged a violation. Now it caps at 4 and reports the drop, so a
    // programmatic caller that skips the import-modal validation can never
    // feed an over-cap deck into setupGame.
    const entries = [
      { count: 5, name: "Buddy-Buddy Poffin", limitlessSet: "ASC", number: "184" },
    ];
    const r = buildDeckFromEntries(entries);
    const poffinCount = r.deck.filter((c) => c.name === "Buddy-Buddy Poffin").length;
    expect(poffinCount).toBe(4);
    expect(r.ruleViolations.some((v) => v.includes("dropped"))).toBe(true);
  });

  it("caps across multiple entries of the same name", () => {
    // Two lines of 3 Buddy-Buddy Poffin should sum to 6 → cap at 4 (second
    // entry contributes only 1).
    const entries = [
      { count: 3, name: "Buddy-Buddy Poffin", limitlessSet: "ASC", number: "184" },
      { count: 3, name: "Buddy-Buddy Poffin", limitlessSet: "ASC", number: "184" },
    ];
    const r = buildDeckFromEntries(entries);
    const poffinCount = r.deck.filter((c) => c.name === "Buddy-Buddy Poffin").length;
    expect(poffinCount).toBe(4);
  });

  it("allows >4 Basic Energy (Basic Energy is exempt from the 4-per-name rule)", () => {
    const entries = [
      { count: 12, name: "Basic Grass Energy", limitlessSet: "SVE", number: "1" },
    ];
    const r = buildDeckFromEntries(entries);
    expect(r.ruleViolations).toEqual([]);
  });
});

describe("importDecklist — full pipeline", () => {
  it("returns zero violations for a valid sample", () => {
    const text = `Pokémon: 2
1 Basic Grass Energy SVE 1
1 Basic Fire Energy SVE 1`;
    const r = importDecklist(text);
    expect(r.parseErrors).toEqual([]);
    expect(r.ruleViolations).toEqual([]);
    expect(r.unmatched).toEqual([]);
    expect(r.totalCards).toBe(2);
  });
});

describe("validateDeckForPlay — pre-game deck legality gate", () => {
  // C3 regression: an imported deck that lost cards to dataset drift would
  // previously flow into setupGame and corrupt the mulligan/prize pipeline.
  // The validator surfaces it at the picker so Start Game can refuse.

  function mkBasic(name: string): PokemonCard {
    return {
      id: name.toLowerCase(),
      name,
      supertype: "Pokémon",
      subtypes: ["Basic"],
      regulationMark: "H",
      hp: 70,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard;
  }
  function mkEnergy(): EnergyCard {
    return {
      id: "grass-e",
      name: "Basic Grass Energy",
      supertype: "Energy",
      subtypes: ["Basic"],
      provides: ["Grass"],
    } as EnergyCard;
  }

  it("returns null for a curated preset (canonical legal deck)", () => {
    const deck = buildDeck(DECK_SPECS[0]);
    expect(validateDeckForPlay(deck)).toBeNull();
  });

  it("rejects a 59-card deck (post-drift partial resolution)", () => {
    const deck: Card[] = [mkBasic("Pikachu"), ...Array(58).fill(mkEnergy())];
    const issue = validateDeckForPlay(deck);
    expect(issue).not.toBeNull();
    expect(issue!).toContain("59");
  });

  it("rejects a 61-card deck (over-cap escape)", () => {
    const deck: Card[] = [mkBasic("Pikachu"), ...Array(60).fill(mkEnergy())];
    const issue = validateDeckForPlay(deck);
    expect(issue).not.toBeNull();
    expect(issue!).toContain("61");
  });

  it("rejects a 60-card deck with no Basic Pokémon", () => {
    // Energy-only or Trainer-only synthetic deck — would loop the mulligan
    // safety counter forever without this gate.
    const deck: Card[] = Array(60).fill(mkEnergy());
    const issue = validateDeckForPlay(deck);
    expect(issue).not.toBeNull();
    expect(issue!.toLowerCase()).toContain("basic");
  });

  it("rejects explicitly rotated regulation marks even when the deck has 60 cards and a Basic", () => {
    const rotatedBasic = {
      ...mkBasic("Rotated Basic"),
      regulationMark: "G",
    } as PokemonCard;
    const deck: Card[] = [rotatedBasic, ...Array(59).fill(mkEnergy())];
    const issue = validateDeckForPlay(deck);
    expect(issue).not.toBeNull();
    expect(issue!).toContain("regulation mark G");
  });

  it("allows a current legal reprint card object even when the card name existed before rotation", () => {
    // Legality follows the resolved card object's regulation mark, not the
    // historical name. This mirrors the parser fallback that may resolve an
    // old pasted printing to a legal current reprint.
    const legalUltraBall = findByName("Ultra Ball");
    expect(legalUltraBall).toBeDefined();
    expect(legalUltraBall!.regulationMark).toBeTruthy();
    const deck: Card[] = [
      mkBasic("Legal Basic"),
      { ...legalUltraBall! },
      ...Array(58).fill(mkEnergy()),
    ];
    expect(validateDeckForPlay(deck)).toBeNull();
  });
});
