// Deck Doctor — unit + adapter + reachability + role-validation + curated
// baseline + suppression + disjointness + stage chain tests.
//
// Test setup (src/test-setup.ts) loads the dataset via loadCards() before
// any spec runs, so cardsByName is populated when the role-validation test
// reads it.

import { describe, expect, it } from "vitest";
import { cardsByName, findByName } from "../cards";
import { gameplayKey } from "../cardEquivalence";
import { CARD_ROLES, getRoleTags } from "../cardRoles";
import {
  analyzeDeck,
  composeReport,
  DOCTOR_VERSION,
  engineIsReachable,
  pasteNoticesFromImport,
  serializeDoctorReport,
  type DeckInput,
  type DoctorContext,
} from "../deckDoctor";
import { hypergeometric, oddsAtLeast, oddsAtLeastOf } from "../deckMath";
import { DECK_SPECS, buildDeck } from "../decks";
import { importDecklist } from "../decklistParser";
import { ARCHETYPE_PROFILES } from "../../engine/aiArchetype";
import type { Card, PokemonCard } from "../../engine/types";

const ctx: DoctorContext = {
  get cardsByName() {
    return cardsByName;
  },
  gameplayKey,
};

// ---- Helpers --------------------------------------------------------------

function card(name: string): Card {
  const found = findByName(name);
  if (!found) throw new Error(`Test fixture: card not in dataset: ${name}`);
  return found;
}

function repeat(c: Card, n: number): Card[] {
  return Array.from({ length: n }, () => ({ ...c }));
}

// Build a 60-card Card[] from a list of {name, count} entries. Pads up to 60
// with basic Grass energy so partial fixtures still produce a 60-card deck.
function buildTestDeck(entries: Array<{ name: string; count: number }>): Card[] {
  const out: Card[] = [];
  for (const e of entries) out.push(...repeat(card(e.name), e.count));
  while (out.length < 60) out.push({ ...card("Basic Grass Energy") });
  return out;
}

function inputFor(cards: Card[]): DeckInput {
  return { cards, source: "preset", sourceName: "test" };
}

function findingIds(analysis: ReturnType<typeof analyzeDeck>): string[] {
  return analysis.findings.map((f) => f.id);
}

// ---- Math fixtures -------------------------------------------------------

describe("deckMath", () => {
  it("hypergeometric: 4 Basics in 60-card deck → mulligan ≈ 60%", () => {
    const p = hypergeometric({ deckSize: 60, successes: 4, draws: 7, want: 0 });
    expect(p).toBeGreaterThan(0.59);
    expect(p).toBeLessThan(0.61);
  });

  it("hypergeometric: 12 Basics in 60-card deck → mulligan ≈ 19%", () => {
    const p = hypergeometric({ deckSize: 60, successes: 12, draws: 7, want: 0 });
    expect(p).toBeGreaterThan(0.18);
    expect(p).toBeLessThan(0.20);
  });

  it("hypergeometric: 20 Basics in 60-card deck → mulligan ≈ 4.8%", () => {
    const p = hypergeometric({ deckSize: 60, successes: 20, draws: 7, want: 0 });
    expect(p).toBeGreaterThan(0.04);
    expect(p).toBeLessThan(0.06);
  });

  it("oddsAtLeast sums tail correctly", () => {
    // Sanity: P(≥1 of 4 in 7 draws) > P(≥2 of 4 in 7 draws).
    const a = oddsAtLeast(60, 4, 7, 1);
    const b = oddsAtLeast(60, 4, 7, 2);
    expect(a).toBeGreaterThan(b);
    // Single-bucket atLeast=1 equals 1 - hypergeometric want=0.
    const want0 = hypergeometric({ deckSize: 60, successes: 4, draws: 7, want: 0 });
    expect(Math.abs(a - (1 - want0))).toBeLessThan(1e-9);
  });

  it("oddsAtLeastOf with assertDisjoint: throws on overlapping cardRefs", () => {
    expect(() =>
      oddsAtLeastOf(
        60,
        [
          { cardRefs: [0, 1, 2], atLeast: 1 },
          { cardRefs: [2, 3, 4], atLeast: 1 },
        ],
        7,
        { assertDisjoint: true },
      ),
    ).toThrow(/disjoint/);
  });

  it("oddsAtLeastOf: disjoint buckets compute correctly", () => {
    // 60-card deck, 4 Basics (indices 0-3), 4 search items (indices 10-13).
    // P(≥1 Basic AND ≥1 search in 7 draws) > 0 and < min individual prob.
    const p = oddsAtLeastOf(
      60,
      [
        { cardRefs: [0, 1, 2, 3], atLeast: 1 },
        { cardRefs: [10, 11, 12, 13], atLeast: 1 },
      ],
      7,
      { assertDisjoint: true },
    );
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(oddsAtLeast(60, 4, 7, 1));
  });
});

// ---- Card-roles dataset validation ----------------------------------------

describe("cardRoles dataset validation", () => {
  it("every name in CARD_ROLES resolves via cardsByName", () => {
    const missing: string[] = [];
    for (const name of Object.keys(CARD_ROLES)) {
      if (!ctx.cardsByName.get(name) || ctx.cardsByName.get(name)!.length === 0) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("getRoleTags(Lillie's Determination) tags it as draw:supporter (high confidence)", () => {
    const c = findByName("Lillie's Determination");
    expect(c).toBeDefined();
    const tags = getRoleTags(c!);
    expect(tags.some((t) => t.tag === "draw:supporter" && t.confidence === "high")).toBe(true);
  });

  it("Dudunsparce is draw:ability (whitelist), not search:ability", () => {
    const c = findByName("Dudunsparce");
    if (!c) return;
    const tags = getRoleTags(c).map((t) => t.tag);
    expect(tags).toContain("draw:ability");
    expect(tags).not.toContain("search:ability");
  });
});

// ---- Engine reachability --------------------------------------------------

describe("engineIsReachable", () => {
  // Stage 1 line: Dudunsparce (Stage 1) ← Dunsparce (Basic).
  it("Dudunsparce + Dunsparce = reachable", () => {
    const ddu = findByName("Dudunsparce") as PokemonCard | undefined;
    if (!ddu) return;
    const deck = buildTestDeck([
      { name: "Dunsparce", count: 4 },
      { name: "Dudunsparce", count: 2 },
    ]);
    expect(engineIsReachable(ddu, deck, ctx)).toBe(true);
  });

  it("Dudunsparce without Dunsparce = NOT reachable", () => {
    const ddu = findByName("Dudunsparce") as PokemonCard | undefined;
    if (!ddu) return;
    const deck = buildTestDeck([{ name: "Dudunsparce", count: 2 }]);
    expect(engineIsReachable(ddu, deck, ctx)).toBe(false);
  });

  // Stage 2 line: Flygon ← Vibrava ← Trapinch (or Trapinch + Rare Candy).
  it("Flygon + Trapinch + Rare Candy (no Vibrava) = reachable via Rare Candy", () => {
    const fly = findByName("Flygon") as PokemonCard | undefined;
    if (!fly) return;
    const deck = buildTestDeck([
      { name: "Trapinch", count: 4 },
      { name: "Rare Candy", count: 4 },
      { name: "Flygon", count: 2 },
    ]);
    expect(engineIsReachable(fly, deck, ctx)).toBe(true);
  });

  it("Flygon without Trapinch OR Rare Candy = NOT reachable", () => {
    const fly = findByName("Flygon") as PokemonCard | undefined;
    if (!fly) return;
    const deck = buildTestDeck([{ name: "Flygon", count: 2 }]);
    expect(engineIsReachable(fly, deck, ctx)).toBe(false);
  });
});

// ---- Per-finding unit tests ----------------------------------------------

describe("analyzeDeck — per-finding unit tests", () => {
  it("legal.card-count fires on non-60-card deck", () => {
    const cards = repeat(card("Basic Grass Energy"), 30);
    const r = analyzeDeck({ cards, source: "paste" }, ctx);
    expect(findingIds(r)).toContain("legal.card-count");
    expect(r.ok).toBe(false);
  });

  it("legal.no-basic fires when 0 Basic Pokémon", () => {
    const cards = repeat(card("Basic Grass Energy"), 60);
    const r = analyzeDeck({ cards, source: "paste" }, ctx);
    expect(findingIds(r)).toContain("legal.no-basic");
  });

  it("consistency.no-engine fires when no draw / search engine present", () => {
    const cards = buildTestDeck([
      { name: "Pikachu ex", count: 4 },
    ]);
    const r = analyzeDeck(inputFor(cards), ctx);
    expect(findingIds(r)).toContain("consistency.no-engine");
  });

  it("consistency.no-engine does NOT fire when reachable Dudunsparce is present", () => {
    const cards = buildTestDeck([
      { name: "Dunsparce", count: 4 },
      { name: "Dudunsparce", count: 2 },
      { name: "Pikachu ex", count: 4 },
    ]);
    const r = analyzeDeck(inputFor(cards), ctx);
    expect(findingIds(r)).not.toContain("consistency.no-engine");
  });

  it("stage.no-rare-candy fires on Stage 2 + no Rare Candy", () => {
    // Use Flygon line (Trapinch → Vibrava → Flygon).
    const cards = buildTestDeck([
      { name: "Trapinch", count: 4 },
      { name: "Vibrava", count: 2 },
      { name: "Flygon", count: 2 },
      { name: "Lillie's Determination", count: 4 },
    ]);
    const r = analyzeDeck(inputFor(cards), ctx);
    expect(findingIds(r)).toContain("stage.no-rare-candy");
  });

  it("stage.broken-chain fires when Flygon has no Trapinch AND no Rare Candy", () => {
    const cards = buildTestDeck([
      { name: "Flygon", count: 2 },
      { name: "Lillie's Determination", count: 4 },
      { name: "Pikachu ex", count: 2 },
    ]);
    const r = analyzeDeck(inputFor(cards), ctx);
    expect(findingIds(r)).toContain("stage.broken-chain");
  });

  it("prob.mulligan-rate fires with high severity at low Basic count", () => {
    const cards = buildTestDeck([
      { name: "Pikachu ex", count: 4 }, // 4 Basics total
      { name: "Lillie's Determination", count: 4 },
    ]);
    const r = analyzeDeck(inputFor(cards), ctx);
    const finding = r.findings.find((f) => f.id === "prob.mulligan-rate");
    expect(finding).toBeDefined();
    // 4 Basics in 60-card deck → ~35% mulligan, severity = error.
    expect(finding!.severity).toBe("error");
  });
});

// ---- pasteNoticesFromImport adapter --------------------------------------

describe("pasteNoticesFromImport adapter", () => {
  it("derives over-four for >4 copies of a non-basic-energy name", () => {
    // Lillie's Determination is in the legal pool (MEG 119). Pasting 7
    // copies should resolve through the parser and yield over-four.
    const text =
      "Pokémon: 4\n" +
      "4 Pikachu ex SSP 73\n" +
      "Trainer: 56\n" +
      "7 Lillie's Determination MEG 119\n";
    const importResult = importDecklist(text);
    const notices = pasteNoticesFromImport(importResult, ctx);
    const overFour = notices.find((n) => n.kind === "over-four");
    expect(overFour).toBeDefined();
    if (overFour && overFour.kind === "over-four") {
      expect(overFour.cardName).toBe("Lillie's Determination");
      expect(overFour.pastedCount).toBe(7);
    }
  });
});

// ---- Curated-deck baseline ------------------------------------------------

// Curated decks may reasonably trip a few heuristics (single-prize plans
// running thin Basic counts, Stage 2 lines that intentionally skip Rare
// Candy, etc.). Each entry documents an accepted warning with a typed
// reason. Tests fail loudly if a NEW warning creeps in.
const EXPECTED_WARNINGS: Record<string, Array<{ findingId: string; reason: string }>> = {
  "festival-leads": [
    {
      findingId: "prob.mulligan-rate",
      reason: "Festival Leads plays a thin Basic count to maximize Dipplin / Thwackey copies.",
    },
    {
      findingId: "prob.raw-energy-opening",
      reason: "Festival Leads attacks are mostly Colorless; raw matching-energy odds aren't load-bearing.",
    },
    {
      findingId: "stage.no-rare-candy",
      reason: "Festival Leads doesn't run Stage 2 Pokémon — only Stage 1 evolutions.",
    },
  ],
  "arboliva": [
    {
      findingId: "stage.no-rare-candy",
      reason: "Arboliva's only Stage 2 line uses Forest of Vitality acceleration instead of Rare Candy.",
    },
  ],
  "alakazam": [
    {
      findingId: "prob.raw-energy-opening",
      reason: "Alakazam decks rely on attach-time setup; raw T1 odds aren't the bottleneck.",
    },
    {
      findingId: "energy.thin-supply",
      reason: "Single-attacker Alakazam list runs thin Energy by design.",
    },
  ],
  "lucario-ex": [
    {
      findingId: "prob.mulligan-rate",
      reason: "Mega Lucario lists prioritize Riolu / accelerator copies over Basic count.",
    },
  ],
  "mateusz-dragapult-dudunsparce": [
    {
      findingId: "prob.mulligan-rate",
      reason: "Tournament-winning list ships ~10 Basics to maximize line-and-engine slots.",
    },
    {
      findingId: "prob.raw-energy-opening",
      reason: "Dragapult Phantom Dive is paid via Stage 2 setup, not opening attach.",
    },
    {
      findingId: "stage.no-rare-candy",
      reason: "Mateusz's list specifically does NOT run Rare Candy — Drakloak Stage 1 is the plan.",
    },
  ],
  "kosek-cynthia-garchomp": [
    {
      findingId: "prob.mulligan-rate",
      reason: "Cynthia's Garchomp lists run thin Basic counts to maximize evolution copies.",
    },
    {
      findingId: "stage.no-rare-candy",
      reason: "Cynthia's-prefix engine evolves naturally through Cynthia's Gabite — Rare Candy isn't needed.",
    },
  ],
  "pires-mega-starmie-dusknoir": [
    {
      findingId: "stage.no-rare-candy",
      reason: "Pires's list evolves Dusknoir naturally; Rare Candy slot is used for tech.",
    },
  ],
  "cipolla-dragapult-blaziken": [
    {
      findingId: "prob.raw-energy-opening",
      reason: "Dragapult / Blaziken pays via Charging Up; raw T1 odds aren't the gate.",
    },
  ],
  "zanchi-mega-starmie-froslass": [
    {
      findingId: "prob.mulligan-rate",
      reason: "Compound-spread plan ships ~10 Basics; mulligan rate is an accepted tradeoff.",
    },
  ],
  "tresp-crustle": [
    {
      findingId: "prob.raw-energy-opening",
      reason: "Crustle wall plan doesn't depend on a specific opening energy attach.",
    },
  ],
};

describe("curated-deck baseline", () => {
  for (const spec of DECK_SPECS) {
    it(`${spec.name} — 0 errors, warnings ⊆ allowlist`, () => {
      const cards = buildDeck(spec);
      // Skip if the dataset failed to assemble enough cards (drift / rotation).
      if (cards.length !== 60) return;
      const r = analyzeDeck(inputFor(cards), ctx);
      const errors = r.findings.filter((f) => f.severity === "error");
      expect(errors.map((f) => f.id)).toEqual([]);

      const warningIds = r.findings
        .filter((f) => f.severity === "warning")
        .map((f) => f.id);
      const allowed = new Set(
        (EXPECTED_WARNINGS[spec.id] ?? []).map((e) => e.findingId),
      );
      const unexpected = warningIds.filter((id) => !allowed.has(id));
      // Print the unexpected warnings inline so failure output explains itself.
      expect(
        unexpected,
        `Unexpected warnings for ${spec.id}: ${unexpected.join(", ")}`,
      ).toEqual([]);
    });
  }
});

// ---- Archetype profile coverage + exception guardrails -------------------

describe("archetype profile coverage", () => {
  for (const profile of Object.values(ARCHETYPE_PROFILES)) {
    const matchingSpec = DECK_SPECS.find((s) => s.id === profile.id) ??
      DECK_SPECS.find((s) => s.id.includes(profile.id));
    if (!matchingSpec) continue;
    it(`${profile.id} — detection + 0 missing-core for ${matchingSpec.id}`, () => {
      const cards = buildDeck(matchingSpec);
      if (cards.length !== 60) return;
      const r = analyzeDeck(inputFor(cards), ctx);
      expect(r.archetype.id).toBe(profile.id);
      expect(r.archetype.confidence).not.toBe("low");
      const missingCore = r.findings.filter(
        (f) => f.id === "archetype.missing-core",
      );
      expect(missingCore.map((f) => f.title)).toEqual([]);
    });

    if (profile.expectedExceptions && profile.expectedExceptions.length > 0) {
      it(`${profile.id} — every expectedException would fire if disabled`, () => {
        const cards = buildDeck(matchingSpec);
        if (cards.length !== 60) return;
        const withDisabled = analyzeDeck(inputFor(cards), ctx, {
          disableExceptions: true,
        });
        const firedIds = new Set(withDisabled.findings.map((f) => f.id));
        for (const exc of profile.expectedExceptions!) {
          expect(
            firedIds.has(exc.id),
            `Dead exception in ${profile.id}: ${exc.id} did not fire even with suppression disabled.`,
          ).toBe(true);
        }
      });

      it(`${profile.id} — no UNEXPECTED suppressions`, () => {
        const cards = buildDeck(matchingSpec);
        if (cards.length !== 60) return;
        const r = analyzeDeck(inputFor(cards), ctx);
        const declared = new Set(profile.expectedExceptions!.map((e) => e.id));
        const unexpected = r.suppressions
          .map((s) => s.findingId)
          .filter((id) => !declared.has(id));
        expect(unexpected).toEqual([]);
      });
    }
  }
});

// ---- composeReport / serializeDoctorReport -------------------------------

describe("compose / serialize", () => {
  it("composeReport is deterministic given fixed inputs", () => {
    const cards = buildTestDeck([
      { name: "Pikachu ex", count: 4 },
      { name: "Lillie's Determination", count: 4 },
    ]);
    const a = analyzeDeck(inputFor(cards), ctx);
    const r1 = composeReport(a, {
      generatedAt: "2026-05-09T00:00:00Z",
      datasetAsOf: "2026-05-08",
      doctorVersion: DOCTOR_VERSION,
    });
    const r2 = composeReport(a, {
      generatedAt: "2026-05-09T00:00:00Z",
      datasetAsOf: "2026-05-08",
      doctorVersion: DOCTOR_VERSION,
    });
    expect(r1).toEqual(r2);
  });

  it("serializeDoctorReport starts with the scope disclaimer", () => {
    const cards = buildTestDeck([
      { name: "Pikachu ex", count: 4 },
      { name: "Lillie's Determination", count: 4 },
    ]);
    const a = analyzeDeck(inputFor(cards), ctx);
    const r = composeReport(a, {
      generatedAt: "2026-05-09T00:00:00Z",
      datasetAsOf: "2026-05-08",
      doctorVersion: DOCTOR_VERSION,
    });
    const text = serializeDoctorReport(r);
    expect(text.split("\n")[0]).toMatch(
      /Structural review only — not a meta or matchup grade\./,
    );
    expect(text).toMatch(/Doctor version: 1/);
  });
});
