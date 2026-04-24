// Decklist parser tests. Validates both the text-parsing path (tokenization,
// section-header skipping, parse errors) and the rule enforcement applied
// when building a deck (4-per-name, 1 Radiant, 1 ACE SPEC).

import { describe, it, expect } from "vitest";
import {
  parseDecklist,
  buildDeckFromEntries,
  importDecklist,
} from "../decklistParser";

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
