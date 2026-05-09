// Meta Doctor + meta snapshot tests.
//
// Test setup loads the dataset (src/test-setup.ts) before any spec runs, so
// cardsByName / gameplayKey are ready when these helpers fire.

import { describe, expect, it } from "vitest";
import { cardsByName, findByName } from "../cards";
import { gameplayKey } from "../cardEquivalence";
import { analyzeDeck, type DoctorContext } from "../deckDoctor";
import { analyzeMeta } from "../metaDoctor";
import { runStaticMatchupChecks } from "../matchupChecks";
import { compareToStockList } from "../stockComparison";
import {
  allSnapshots,
  loadLatestSnapshotSync,
  matchupWinRate,
  wilson95FromRate,
  generatedAgeDays,
  dataAgeDays,
  isSnapshotStale,
  isSnapshotUnusable,
  type MetaSnapshot,
} from "../metaSnapshot";
import type { Card, PokemonCard } from "../../engine/types";
import type { Archetype } from "../../engine/aiArchetype";

const ctx: DoctorContext = {
  get cardsByName() {
    return cardsByName;
  },
  gameplayKey,
};

function card(name: string): Card {
  const found = findByName(name);
  if (!found) throw new Error(`fixture: card not in dataset: ${name}`);
  return found;
}

function pokemon(name: string): PokemonCard {
  const c = card(name);
  if (c.supertype !== "Pokémon") throw new Error(`${name} is not a Pokémon`);
  return c;
}

// ---- Snapshot validation -------------------------------------------------

describe("metaSnapshot validation", () => {
  for (const s of allSnapshots()) {
    describe(`snapshot ${s.id}`, () => {
      it("schemaVersion + quality + usableForGrades wiring", () => {
        expect(s.schemaVersion).toBe(1);
        expect(["fixture", "research"]).toContain(s.quality);
        if (s.quality === "fixture") {
          expect(s.usableForGrades).toBe(false);
        }
      });

      it("metaShare sums ≤ 1.0001", () => {
        const sum = s.archetypes.reduce((acc, a) => acc + a.metaShare, 0);
        expect(sum).toBeLessThanOrEqual(1.0001);
      });

      it("matchup cells are tie-aware and Wilson-sane", () => {
        for (const cell of s.matchupMatrix) {
          const sample = cell.wins + cell.losses + cell.ties;
          expect(cell.sampleSize).toBe(sample);
          expect(sample).toBeGreaterThan(0);
          const expected = (cell.wins + 0.5 * cell.ties) / sample;
          // 1e-3 tolerates the JSON's 4-5 decimal rounding without letting
          // a real W/L/T mismatch sneak through.
          expect(Math.abs(cell.winRate - expected)).toBeLessThan(1e-3);
          expect(cell.ci95Low).toBeLessThanOrEqual(cell.winRate);
          expect(cell.winRate).toBeLessThanOrEqual(cell.ci95High);
        }
      });

      it("research+usable invariants hold when applicable", () => {
        if (s.quality !== "research" || !s.usableForGrades) return;
        expect(s.sources.length).toBeGreaterThan(0);
        expect(s.tournaments.length).toBeGreaterThan(0);
        expect(new Date(s.coversThrough).getTime()).toBeGreaterThanOrEqual(
          new Date(s.coversFrom).getTime(),
        );
        for (const cell of s.matchupMatrix) {
          expect(cell.sampleSize).toBeGreaterThan(0);
        }
      });

      it("coverage metadata in [0,1]", () => {
        for (const v of [
          s.unknownArchetypeShare,
          s.matchupCoverageShare,
          s.onlineShare,
          s.offlineShare,
          s.bo1Share,
          s.bo3Share,
        ]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      });

      it("stock list inclusion rates and modeCount sane", () => {
        for (const e of s.stockLists) {
          for (const c of e.cards) {
            expect(c.inclusionRate).toBeGreaterThanOrEqual(0);
            expect(c.inclusionRate).toBeLessThanOrEqual(1);
            expect(c.modeCount).toBeGreaterThanOrEqual(1);
          }
        }
      });
    });
  }
});

// ---- Wilson + tie math ---------------------------------------------------

describe("matchupWinRate / wilson95FromRate", () => {
  it("tie-aware win rate", () => {
    const r = matchupWinRate({ wins: 5, losses: 3, ties: 2 });
    expect(r.winRate).toBeCloseTo(0.6, 9);
    expect(r.sampleSize).toBe(10);
    expect(r.effectiveWins).toBeCloseTo(6, 9);
  });

  it("Wilson 95% CI for 60% in 10 trials matches reference", () => {
    const ci = wilson95FromRate(0.6, 10);
    expect(ci.ci95Low).toBeGreaterThan(0.30);
    expect(ci.ci95Low).toBeLessThan(0.32);
    expect(ci.ci95High).toBeGreaterThan(0.83);
    expect(ci.ci95High).toBeLessThan(0.85);
  });

  it("Wilson 95% CI for 8/11 BO1 record", () => {
    const ci = wilson95FromRate(8 / 11, 11);
    expect(ci.ci95Low).toBeGreaterThan(0.42);
    expect(ci.ci95Low).toBeLessThan(0.46);
    expect(ci.ci95High).toBeGreaterThan(0.89);
    expect(ci.ci95High).toBeLessThan(0.93);
  });

  it("zero-sample throws", () => {
    expect(() => matchupWinRate({ wins: 0, losses: 0, ties: 0 })).toThrow();
    expect(() => wilson95FromRate(0.5, 0)).toThrow();
  });
});

// ---- Loader fixture isolation --------------------------------------------

describe("loadLatestSnapshot fixture isolation", () => {
  it("default load returns no fixture-quality snapshot", () => {
    const s = loadLatestSnapshotSync();
    if (s) expect(s.quality).not.toBe("fixture");
  });

  it("allowFixture returns the fixture", () => {
    const s = loadLatestSnapshotSync({ allowFixture: true });
    expect(s).not.toBeNull();
    expect(s!.id).toBeTruthy();
  });
});

// ---- Freshness gating ----------------------------------------------------

function makeSnapshot(overrides: Partial<MetaSnapshot> = {}): MetaSnapshot {
  return {
    schemaVersion: 1,
    id: "test-snapshot",
    format: "Standard",
    region: "global",
    quality: "research",
    usableForGrades: true,
    generatedAt: new Date().toISOString(),
    coversFrom: new Date().toISOString(),
    coversThrough: new Date().toISOString(),
    sources: ["https://example.com"],
    minPlayerCount: 200,
    methodology: "synthetic test fixture",
    unknownArchetypeShare: 0,
    matchupCoverageShare: 0.8,
    onlineShare: 0.5,
    offlineShare: 0.5,
    bo1Share: 0.5,
    bo3Share: 0.5,
    tournaments: [],
    archetypes: [],
    matchupMatrix: [],
    stockLists: [],
    techCoverage: [],
    coverageNotes: [],
    ...overrides,
  };
}

describe("freshness gating", () => {
  it("60-day-old data → stale, 90+ → unusable", () => {
    const now = new Date("2026-05-09T00:00:00Z");
    const s30 = makeSnapshot({
      coversThrough: new Date("2026-04-09T00:00:00Z").toISOString(),
    });
    const s80 = makeSnapshot({
      coversThrough: new Date("2026-02-18T00:00:00Z").toISOString(),
    });
    const s100 = makeSnapshot({
      coversThrough: new Date("2026-01-29T00:00:00Z").toISOString(),
    });
    expect(dataAgeDays(s30, now)).toBe(30);
    expect(dataAgeDays(s80, now)).toBe(80);
    expect(dataAgeDays(s100, now)).toBe(100);
    expect(isSnapshotStale(s30, now)).toBe(false);
    expect(isSnapshotStale(s80, now)).toBe(true);
    expect(isSnapshotUnusable(s80, now)).toBe(false);
    expect(isSnapshotUnusable(s100, now)).toBe(true);
  });

  it("usableForGrades=false forces unusable", () => {
    const s = makeSnapshot({ usableForGrades: false });
    expect(isSnapshotUnusable(s)).toBe(true);
  });

  it("generatedAgeDays computes file-build age", () => {
    const now = new Date("2026-05-09T00:00:00Z");
    const s = makeSnapshot({
      generatedAt: new Date("2026-05-04T00:00:00Z").toISOString(),
    });
    expect(generatedAgeDays(s, now)).toBe(5);
  });
});

// ---- Grade math fixtures -------------------------------------------------

function buildTestDeck(entries: Array<{ name: string; count: number }>): Card[] {
  const out: Card[] = [];
  for (const e of entries) {
    const c = card(e.name);
    for (let i = 0; i < e.count; i++) out.push({ ...c });
  }
  while (out.length < 60) out.push({ ...card("Basic Grass Energy") });
  return out;
}

describe("metaDoctor grade math", () => {
  const userDeck = buildTestDeck([
    { name: "Pikachu ex", count: 4 },
    { name: "Lillie's Determination", count: 4 },
    { name: "Buddy-Buddy Poffin", count: 4 },
  ]);
  const dummyAnalysis = analyzeDeck(
    { cards: userDeck, source: "preset", sourceName: "test" },
    ctx,
  );

  it("structuralGrade=D when errors present", () => {
    const broken = analyzeDeck(
      { cards: [card("Basic Grass Energy")], source: "preset" },
      ctx,
    );
    const r = analyzeMeta(broken, broken.source as never, null, ctx);
    expect(r.structuralGrade).toBe("D");
  });

  it("metaGrade=insufficient-data when no snapshot", () => {
    const r = analyzeMeta(dummyAnalysis, userDeck, null, ctx);
    expect(r.metaGrade).toBe("insufficient-data");
  });

  it("synthetic snapshot 70/30 share with 60/40 win rates → expectedWR ≈ 54%", () => {
    const heroId: Archetype = "festival-leads";
    const villainA: Archetype = "crustle";
    const villainB: Archetype = "alakazam";
    const snapshot = makeSnapshot({
      archetypes: [
        { id: villainA, metaShare: 0.7, sampleSize: 50, confidence: "high", mainAttackerCards: [] },
        { id: villainB, metaShare: 0.3, sampleSize: 50, confidence: "high", mainAttackerCards: [] },
      ],
      matchupMatrix: [
        {
          hero: heroId,
          villain: villainA,
          wins: 30, losses: 20, ties: 0,
          winRate: 0.6,
          ci95Low: 0.46,
          ci95High: 0.72,
          sampleSize: 50,
          confidence: "high",
        },
        {
          hero: heroId,
          villain: villainB,
          wins: 20, losses: 30, ties: 0,
          winRate: 0.4,
          ci95Low: 0.27,
          ci95High: 0.54,
          sampleSize: 50,
          confidence: "high",
        },
      ],
    });
    // Force the user's archetype detection by giving them the right cards.
    // We synthesize a DeckAnalysis with festival-leads detection to bypass.
    const analysis = {
      ...dummyAnalysis,
      archetype: { id: heroId, confidence: "high" as const },
    };
    const r = analyzeMeta(analysis, userDeck, snapshot, ctx);
    expect(r.metaGrade).toBe("B");
    expect(r.expectedWinRate).toBeCloseTo(0.54, 2);
    expect(r.fieldCoverage).toBeCloseTo(1.0, 2);
    expect(r.metaConfidence).toBe("high");
  });

  it("fieldCoverage < 0.5 → insufficient-data", () => {
    const heroId: Archetype = "festival-leads";
    const snapshot = makeSnapshot({
      archetypes: [
        { id: "crustle", metaShare: 0.3, sampleSize: 30, confidence: "medium", mainAttackerCards: [] },
        { id: "alakazam", metaShare: 0.7, sampleSize: 50, confidence: "high", mainAttackerCards: [] },
      ],
      matchupMatrix: [
        // Only one cell — covers 30% of field.
        {
          hero: heroId,
          villain: "crustle",
          wins: 10, losses: 5, ties: 0,
          winRate: 10 / 15,
          ci95Low: 0.42,
          ci95High: 0.85,
          sampleSize: 15,
          confidence: "medium",
        },
      ],
    });
    const analysis = { ...dummyAnalysis, archetype: { id: heroId, confidence: "high" as const } };
    const r = analyzeMeta(analysis, userDeck, snapshot, ctx);
    expect(r.metaGrade).toBe("insufficient-data");
  });

  it("dataAgeDays > 90 → insufficient-data", () => {
    const old = new Date("2026-01-01T00:00:00Z").toISOString();
    const snapshot = makeSnapshot({
      coversThrough: old,
      archetypes: [
        { id: "crustle", metaShare: 1.0, sampleSize: 50, confidence: "high", mainAttackerCards: [] },
      ],
      matchupMatrix: [
        {
          hero: "festival-leads",
          villain: "crustle",
          wins: 30, losses: 20, ties: 0,
          winRate: 0.6,
          ci95Low: 0.46,
          ci95High: 0.72,
          sampleSize: 50,
          confidence: "high",
        },
      ],
    });
    const analysis = { ...dummyAnalysis, archetype: { id: "festival-leads" as Archetype, confidence: "high" as const } };
    const r = analyzeMeta(analysis, userDeck, snapshot, ctx);
    expect(r.metaGrade).toBe("insufficient-data");
  });

  it("fixture-quality snapshot → insufficient-data even if math computes", () => {
    const snapshot = makeSnapshot({
      quality: "fixture",
      usableForGrades: false,
      archetypes: [
        { id: "crustle", metaShare: 1.0, sampleSize: 50, confidence: "high", mainAttackerCards: [] },
      ],
      matchupMatrix: [
        {
          hero: "festival-leads",
          villain: "crustle",
          wins: 30, losses: 20, ties: 0,
          winRate: 0.6,
          ci95Low: 0.46,
          ci95High: 0.72,
          sampleSize: 50,
          confidence: "high",
        },
      ],
    });
    const analysis = { ...dummyAnalysis, archetype: { id: "festival-leads" as Archetype, confidence: "high" as const } };
    const r = analyzeMeta(analysis, userDeck, snapshot, ctx);
    expect(r.metaGrade).toBe("insufficient-data");
  });

  it("generic archetype → insufficient-data + matchup unknown, but static checks still run", () => {
    const snapshot = makeSnapshot({
      archetypes: [
        { id: "crustle", metaShare: 1.0, sampleSize: 50, confidence: "high", mainAttackerCards: [] },
      ],
    });
    const analysis = { ...dummyAnalysis, archetype: { id: "generic" as Archetype, confidence: "low" as const } };
    const r = analyzeMeta(analysis, userDeck, snapshot, ctx, "crustle");
    expect(r.metaGrade).toBe("insufficient-data");
    expect(r.matchupGrade).toBe("unknown");
    // Static checks still run when an opponent is selected.
    expect(r.matchupChecks.length).toBeGreaterThan(0);
  });
});

// ---- Static matchup checks -----------------------------------------------

describe("runStaticMatchupChecks", () => {
  it("weakness exposure fires when user attacker is weak to opp's type", () => {
    // Find a real attacker pair from the dataset where weakness applies.
    // Pikachu ex (Lightning) vs Latias ex (Colorless or Dragon weak?). Just
    // synthesize the assertion using available cards by checking weaknesses.
    const userMain = pokemon("Pikachu ex");
    const oppMains = userMain.weaknesses?.[0]?.type
      ? [...cardsByName.values()].flat().filter(
          (c): c is PokemonCard =>
            c.supertype === "Pokémon" &&
            c.types?.[0] === userMain.weaknesses![0].type,
        )
      : [];
    if (oppMains.length === 0) return; // dataset doesn't include a counter
    const oppMain = oppMains[0];
    const out = runStaticMatchupChecks(
      {
        user: { mainAttackers: [userMain], deckCards: [], archetype: "generic" },
        opponent: { mainAttackers: [oppMain], archetype: "unknown" },
      },
      ctx,
    );
    const weaknessFinding = out.find((c) => c.id === "matchup.weakness-exposure");
    expect(weaknessFinding).toBeDefined();
    expect(weaknessFinding!.detail).toMatch(/Static estimate/);
  });

  it("prize-race finding always emits with both totals", () => {
    const userMain = pokemon("Pikachu ex");
    const oppMain = pokemon("Pikachu ex");
    const out = runStaticMatchupChecks(
      {
        user: { mainAttackers: [userMain], deckCards: [], archetype: "generic" },
        opponent: { mainAttackers: [oppMain], archetype: "unknown" },
      },
      ctx,
    );
    const race = out.find((c) => c.id === "matchup.prize-race");
    expect(race).toBeDefined();
    expect(race!.detail).toMatch(/Static estimate/);
  });
});

// ---- Stock comparison ----------------------------------------------------

describe("stockComparison", () => {
  it("missing-core warning detail uses modeCount, not averageCount", () => {
    const synthSnapshot = makeSnapshot({
      stockLists: [
        {
          archetype: "crustle",
          decksObserved: 11,
          cards: [
            {
              cardName: "Boss's Orders",
              inclusionRate: 0.95,
              modeCount: 4,
              modeCountDecks: 8,
              averageCount: 3.6,
              role: "core",
            },
          ],
        },
      ],
    });
    const userDeck = buildTestDeck([
      { name: "Pikachu ex", count: 4 },
      { name: "Lillie's Determination", count: 4 },
    ]);
    const findings = compareToStockList(userDeck, "crustle", synthSnapshot, ctx);
    const missingCore = findings.find((f) => f.id === "stock.missing-core");
    expect(missingCore).toBeDefined();
    expect(missingCore!.detail).toMatch(/run 4 copies/);
    // Should NOT use the average.
    expect(missingCore!.detail).not.toMatch(/3\.6/);
  });

  it("decksObserved < 5 emits a single info finding only", () => {
    const synthSnapshot = makeSnapshot({
      stockLists: [
        {
          archetype: "crustle",
          decksObserved: 3,
          cards: [
            {
              cardName: "Boss's Orders",
              inclusionRate: 0.95,
              modeCount: 4,
              averageCount: 3.6,
              role: "core",
            },
          ],
        },
      ],
    });
    const userDeck = buildTestDeck([{ name: "Pikachu ex", count: 4 }]);
    const findings = compareToStockList(userDeck, "crustle", synthSnapshot, ctx);
    expect(findings.length).toBe(1);
    expect(findings[0].id).toBe("stock.unavailable");
  });
});
