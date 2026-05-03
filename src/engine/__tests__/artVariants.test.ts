// Art variants — per-printing identity preserved through the deck-import
// pipeline and into setupGame's player.deck. The engine treats every
// printing as a distinct Card with the same effects; this suite locks in
// the contract that imported decks retain their chosen set+number all the
// way to in-game render.

import { describe, it, expect } from "vitest";
import { importDecklist, buildDeckFromEntries } from "../../data/decklistParser";
import { allCards, cardsByName } from "../../data/cards";
import { gameplayKey, variantsOf } from "../../data/cardEquivalence";
import { setupGame } from "../rules";
import { makeRng } from "../rng";

describe("Art variants — gameplay-key grouping (NOT name-only)", () => {
  it("two Abra prints (different attacks) have DIFFERENT gameplay keys", () => {
    // The dataset contains 2 Abras: me1-54 (Teleportation Attack) and
    // sv6-80 (Beam + Teleporter ability). They share a name but are
    // mechanically distinct. Grouping by name alone would offer them as
    // art variants of each other, which is wrong.
    const abras = cardsByName.get("Abra") ?? [];
    if (abras.length < 2) return; // Skip if dataset rotated this case out.
    const keys = new Set(abras.map(gameplayKey));
    expect(keys.size).toBeGreaterThan(1);
    // variantsOf must filter — the two Abras are NOT variants of each other.
    const variants = variantsOf(abras[0], abras);
    expect(variants.length).toBe(1);
    expect(variants[0].id).toBe(abras[0].id);
  });

  it("two prints of an actually-equivalent card share keys", () => {
    // Find any card with >=2 prints that are truly gameplay-equivalent
    // (same key). At least one should exist for the variant feature to be
    // meaningful — typically Trainers like Switch / Energy Search / basic
    // Energy reprint identically.
    let foundTrueVariantPair = false;
    for (const list of cardsByName.values()) {
      if (list.length < 2) continue;
      const keys = new Set(list.map(gameplayKey));
      if (keys.size < list.length) {
        foundTrueVariantPair = true;
        break;
      }
    }
    expect(foundTrueVariantPair).toBe(true);
  });
});

describe("Art variants — dataset has multiple printings per card name", () => {
  it("at least one card has >1 printing in the pool", () => {
    let multi = 0;
    for (const list of cardsByName.values()) {
      if (list.length > 1) multi++;
    }
    // Sanity: the dataset MUST contain multi-printing entries for the
    // variant feature to be useful. If this fails, dataset refresh dropped
    // the variants — investigate before the variant UI is meaningful.
    expect(multi).toBeGreaterThan(0);
  });

  it("the same card name maps to printings with distinct ids and image URLs", () => {
    const multi = [...cardsByName.values()].find((list) => list.length > 1);
    expect(multi).toBeDefined();
    if (!multi) return;
    const ids = new Set(multi.map((c) => c.id));
    const images = new Set(multi.map((c) => c.imageLarge));
    expect(ids.size).toBe(multi.length);
    expect(images.size).toBe(multi.length);
    // Names match across all printings.
    expect(new Set(multi.map((c) => c.name)).size).toBe(1);
  });
});

describe("Art variants — PTCGL parser preserves per-printing identity", () => {
  it("preserves the chosen set+number when both printings exist in the pool", () => {
    // Find a name with multiple printings; pick two distinct printings.
    const multi = [...cardsByName.entries()].find(([_, list]) => list.length >= 2);
    expect(multi).toBeDefined();
    if (!multi) return;
    const [name, prints] = multi;
    const a = prints[0];
    const b = prints[1];
    // Synthesize a 1-card "deck" with both printings (skipping the rule-of-4
    // realistically since this is a parser-level test).
    const limitlessOf = (setCode: string | undefined): string => {
      const map: Record<string, string> = {
        sv4pt5: "PAF", sv5: "TEF", sv6: "TWM", sv6pt5: "SFA", sv7: "SCR",
        sv8: "SSP", sv8pt5: "PRE", sv9: "JTG", sv10: "DRI",
        zsv10pt5: "BLK", rsv10pt5: "WHT",
        me1: "MEG", me2: "PFL", me2pt5: "ASC", me3: "POR",
        sve: "SVE", svp: "SVP",
      };
      return map[setCode ?? ""] ?? (setCode ?? "").toUpperCase();
    };
    const text = `Pokémon: 0\n\nTrainer: 2\n1 ${name} ${limitlessOf(a.setCode)} ${a.number}\n1 ${name} ${limitlessOf(b.setCode)} ${b.number}\n\nEnergy: 0`;
    const result = importDecklist(text);
    expect(result.unmatched).toEqual([]);
    // Deck has 2 cards; ids should be the two distinct printings (not
    // collapsed to a single canonical printing).
    expect(result.deck.length).toBe(2);
    const importedIds = new Set(result.deck.map((c) => c.id));
    expect(importedIds.has(a.id)).toBe(true);
    expect(importedIds.has(b.id)).toBe(true);
  });
});

describe("Art variants — setupGame preserves per-printing ids in the deck", () => {
  it("a deck with mixed printings of one card lands in player.deck with both ids", () => {
    // Build minimal 60-card deck: 4 of one printing of "Lillie's Determination"
    // + 4 of another, padded with basic energies.
    const allLillie = cardsByName.get("Lillie's Determination") ?? [];
    if (allLillie.length < 2) {
      // Skip if dataset doesn't have multiple Lillie's printings.
      expect(true).toBe(true);
      return;
    }
    const a = allLillie[0];
    const b = allLillie[1];
    // Need a Basic Pokémon for setup to succeed.
    const basicPokemon = allCards.find(
      (c) => c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Basic"),
    );
    expect(basicPokemon).toBeDefined();
    if (!basicPokemon) return;
    // Find a basic energy to fill out.
    const basicEnergy = allCards.find(
      (c) => c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic"),
    );
    expect(basicEnergy).toBeDefined();
    if (!basicEnergy) return;

    // Build entries: 4 Pokemon + 2 Lillie A + 2 Lillie B + 52 energy.
    const limitlessOf = (setCode: string | undefined): string => {
      const map: Record<string, string> = {
        sv4pt5: "PAF", sv5: "TEF", sv6: "TWM", sv6pt5: "SFA", sv7: "SCR",
        sv8: "SSP", sv8pt5: "PRE", sv9: "JTG", sv10: "DRI",
        zsv10pt5: "BLK", rsv10pt5: "WHT",
        me1: "MEG", me2: "PFL", me2pt5: "ASC", me3: "POR",
        sve: "SVE", svp: "SVP",
      };
      return map[setCode ?? ""] ?? (setCode ?? "").toUpperCase();
    };
    const entries = [
      { count: 4, name: basicPokemon.name, limitlessSet: limitlessOf(basicPokemon.setCode), number: basicPokemon.number ?? "" },
      { count: 2, name: a.name, limitlessSet: limitlessOf(a.setCode), number: a.number ?? "" },
      { count: 2, name: b.name, limitlessSet: limitlessOf(b.setCode), number: b.number ?? "" },
      { count: 52, name: basicEnergy.name, limitlessSet: limitlessOf(basicEnergy.setCode), number: basicEnergy.number ?? "" },
    ];
    const built = buildDeckFromEntries(entries);
    expect(built.deck.length).toBe(60);
    // Sanity: the built deck has 2 of each printing.
    const lillieIds = built.deck.filter((c) => c.name === "Lillie's Determination").map((c) => c.id);
    expect(lillieIds.length).toBe(4);
    const aCount = lillieIds.filter((id) => id === a.id).length;
    const bCount = lillieIds.filter((id) => id === b.id).length;
    expect(aCount).toBe(2);
    expect(bCount).toBe(2);

    // Run setupGame and confirm both printings survive into state.players.p1.deck.
    const state = setupGame(built.deck, built.deck, makeRng(7), { p2IsAI: true });
    // After setup: hand=7, prizes=6, active=1, bench=0..5; deck has the rest.
    // Total cards across all zones = 60 (some cards moved to hand/prizes/active).
    const allP1Cards = [
      ...state.players.p1.hand,
      ...state.players.p1.deck,
      ...state.players.p1.prizes,
      ...(state.players.p1.active ? [state.players.p1.active.card] : []),
      ...state.players.p1.bench.map((p) => p.card),
    ];
    expect(allP1Cards.length).toBe(60);
    const lillieInPlay = allP1Cards.filter((c) => c.name === "Lillie's Determination");
    expect(lillieInPlay.length).toBe(4);
    const idsAfterSetup = lillieInPlay.map((c) => c.id);
    expect(idsAfterSetup.filter((id) => id === a.id).length).toBe(2);
    expect(idsAfterSetup.filter((id) => id === b.id).length).toBe(2);
  });
});
