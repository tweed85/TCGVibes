// Meta Doctor — produces three independent grades from a DeckAnalysis +
// MetaSnapshot. Never folds them into one number:
//   structuralGrade — list-specific (derived from DeckAnalysis only)
//   matchupGrade    — archetype vs. selected opponent
//   metaGrade       — archetype-into-field weighted average
//
// List-level signals (stock deviations, missing tech, structural issues)
// are reported alongside but never affect metaGrade. Honest about sample
// size and recency — uses Wilson 95% CIs from the snapshot, gates on
// dataAgeDays (not generatedAt), refuses to grade fixture snapshots.

import type { Card, PokemonCard } from "../engine/types";
import {
  ARCHETYPE_PROFILES,
  type Archetype,
  type Confidence,
} from "../engine/aiArchetype";
import type { DeckAnalysis, DoctorContext } from "./deckDoctor";
import {
  dataAgeDays,
  generatedAgeDays,
  isSnapshotUnusable,
  type MetaSnapshot,
  type ResolvedAttackerRef,
} from "./metaSnapshot";
import {
  runStaticMatchupChecks,
  STATIC_MATCHUP_DISCLAIMER,
  type MatchupCheck,
} from "./matchupChecks";
import {
  compareToStockList,
  type StockListFinding,
} from "./stockComparison";

export { STATIC_MATCHUP_DISCLAIMER };

export type StructuralGrade = "A" | "B" | "C" | "D";
export type MatchupGrade = "favored" | "even" | "unfavored" | "unknown";
export type MetaGrade = "A" | "B" | "C" | "D" | "insufficient-data";

export interface MetaAnalysis {
  structuralGrade: StructuralGrade;
  matchupGrade: MatchupGrade;
  matchupGradeAgainst?: Archetype | "unknown";
  matchupCi95?: { low: number; high: number };
  matchupSampleSize?: number;
  matchupConfidence?: Confidence;

  metaGrade: MetaGrade;
  expectedWinRate?: number;
  expectedWinRateRange?: { low: number; high: number };
  metaConfidence: Confidence;
  fieldCoverage?: number;

  matchupChecks: MatchupCheck[];
  stockListFindings: StockListFinding[];
  techCoverageFindings: MatchupCheck[];

  snapshot: {
    id: string;
    generatedAt: string;
    coversThrough: string;
    generatedAgeDays: number;
    dataAgeDays: number;
    stale: boolean;
    unusable: boolean;
    usableForGrades: boolean;
    quality: "fixture" | "research";
  } | null;
}

// ---- Grade math helpers ---------------------------------------------------

function structuralGrade(a: DeckAnalysis): StructuralGrade {
  const errors = a.findings.filter((f) => f.severity === "error").length;
  const warnings = a.findings.filter((f) => f.severity === "warning").length;
  const suggestions = a.findings.filter((f) => f.severity === "suggestion").length;
  if (errors > 0) return "D";
  if (warnings >= 3) return "C";
  if (warnings > 0) return "B";
  // 0 errors AND 0 warnings — A only if suggestions are also light.
  return suggestions <= 2 ? "A" : "B";
}

function matchupGradeFromWinRate(winRate: number): MatchupGrade {
  if (winRate >= 0.55) return "favored";
  if (winRate >= 0.45) return "even";
  return "unfavored";
}

function metaGradeFromWinRate(winRate: number): Exclude<MetaGrade, "insufficient-data"> {
  if (winRate >= 0.55) return "A";
  if (winRate >= 0.5) return "B";
  if (winRate >= 0.45) return "C";
  return "D";
}

// metaConfidence formula:
//   weighted = sum(metaShare[v] * score(cell.confidence)) / fieldCoverage
//   high   if weighted ≥ 2.6 AND fieldCoverage ≥ 0.7
//   medium if weighted ≥ 1.8 AND fieldCoverage ≥ 0.5
//   else low
function deriveMetaConfidence(
  perCell: Array<{ share: number; cellConf: Confidence }>,
  fieldCoverage: number,
): Confidence {
  const score = (c: Confidence) => (c === "high" ? 3 : c === "medium" ? 2 : 1);
  if (fieldCoverage <= 0) return "low";
  const weighted =
    perCell.reduce((acc, c) => acc + c.share * score(c.cellConf), 0) /
    fieldCoverage;
  if (weighted >= 2.6 && fieldCoverage >= 0.7) return "high";
  if (weighted >= 1.8 && fieldCoverage >= 0.5) return "medium";
  return "low";
}

// ---- Main entry -----------------------------------------------------------

export function analyzeMeta(
  analysis: DeckAnalysis,
  userDeck: Card[],
  snapshot: MetaSnapshot | null,
  ctx: DoctorContext,
  opponent?: Archetype | "unknown",
): MetaAnalysis {
  const structuralG = structuralGrade(analysis);

  const snapshotMeta = snapshot
    ? {
        id: snapshot.id,
        generatedAt: snapshot.generatedAt,
        coversThrough: snapshot.coversThrough,
        generatedAgeDays: generatedAgeDays(snapshot),
        dataAgeDays: dataAgeDays(snapshot),
        stale: dataAgeDays(snapshot) > 60,
        unusable: isSnapshotUnusable(snapshot),
        usableForGrades: snapshot.usableForGrades,
        quality: snapshot.quality,
      }
    : null;

  const heroId = analysis.archetype.id;
  const heroIsKnown = heroId !== "generic";

  // ---- matchupGrade ------------------------------------------------------
  let matchupGrade: MatchupGrade = "unknown";
  let matchupCi95: { low: number; high: number } | undefined;
  let matchupSampleSize: number | undefined;
  let matchupConfidence: Confidence | undefined;
  let matchupGradeAgainst: Archetype | "unknown" | undefined = opponent;

  if (snapshot && heroIsKnown && opponent) {
    const cell = snapshot.matchupMatrix.find(
      (c) => c.hero === heroId && c.villain === opponent,
    );
    if (cell && cell.sampleSize >= 10) {
      matchupGrade = matchupGradeFromWinRate(cell.winRate);
      matchupCi95 = { low: cell.ci95Low, high: cell.ci95High };
      matchupSampleSize = cell.sampleSize;
      matchupConfidence = cell.confidence;
    }
  }

  // ---- metaGrade ---------------------------------------------------------
  let metaGrade: MetaGrade = "insufficient-data";
  let expectedWinRate: number | undefined;
  let expectedWinRateRange: { low: number; high: number } | undefined;
  let metaConfidence: Confidence = "low";
  let fieldCoverage: number | undefined;

  const snapshotUsable = snapshot ? !isSnapshotUnusable(snapshot) : false;
  if (snapshot && snapshotUsable && heroIsKnown) {
    const heroRow = snapshot.matchupMatrix.filter(
      (c) => c.hero === heroId && c.sampleSize >= 10,
    );
    const villainShare = (villain: Archetype | "unknown") =>
      snapshot.archetypes.find((a) => a.id === villain)?.metaShare ?? 0;

    const usableCells = heroRow.filter((c) => villainShare(c.villain) > 0);
    fieldCoverage = usableCells.reduce((acc, c) => acc + villainShare(c.villain), 0);

    if (fieldCoverage >= 0.5) {
      const weightedRate =
        usableCells.reduce(
          (acc, c) => acc + villainShare(c.villain) * c.winRate,
          0,
        ) / fieldCoverage;
      const weightedLow =
        usableCells.reduce(
          (acc, c) => acc + villainShare(c.villain) * c.ci95Low,
          0,
        ) / fieldCoverage;
      const weightedHigh =
        usableCells.reduce(
          (acc, c) => acc + villainShare(c.villain) * c.ci95High,
          0,
        ) / fieldCoverage;
      expectedWinRate = weightedRate;
      expectedWinRateRange = { low: weightedLow, high: weightedHigh };
      metaConfidence = deriveMetaConfidence(
        usableCells.map((c) => ({
          share: villainShare(c.villain),
          cellConf: c.confidence,
        })),
        fieldCoverage,
      );
      metaGrade = metaGradeFromWinRate(weightedRate);
    }
  }

  // ---- List-level signals -----------------------------------------------
  const stockListFindings = snapshot
    ? compareToStockList(userDeck, heroId, snapshot, ctx)
    : [];

  // Tech coverage findings: for each archetype with metaShare ≥ 0.05, check
  // if the user's deck answers it. Cap at top 3 by metaShare to avoid noise.
  const techCoverageFindings: MatchupCheck[] = [];
  if (snapshot) {
    const topArchetypes = [...snapshot.archetypes]
      .filter((a) => a.metaShare >= 0.05 && a.id !== "unknown")
      .sort((a, b) => b.metaShare - a.metaShare)
      .slice(0, 3);
    for (const arch of topArchetypes) {
      const tc = snapshot.techCoverage.find(
        (t) => t.archetype === (arch.id as Archetype),
      );
      if (!tc) continue;
      const userMain = resolveMainAttackers(analysis, ctx)[0];
      const oppMain = resolveAttackersFromRefs(arch.mainAttackerCards, ctx);
      if (!userMain || oppMain.length === 0) continue;
      const checks = runStaticMatchupChecks(
        {
          user: {
            mainAttackers: [userMain],
            deckCards: userDeck,
            archetype: heroId as Archetype | "generic",
          },
          opponent: {
            mainAttackers: oppMain,
            archetype: arch.id as Archetype | "unknown",
          },
          stockLists: snapshot.stockLists,
          techCoverageForOpp: tc.threats,
        },
        ctx,
      );
      // Only the tech-coverage findings (not the OHKO / weakness ones) get
      // surfaced from this loop — those belong to the per-opponent panel.
      for (const c of checks) {
        if (c.id === "matchup.tech-coverage-missing") {
          techCoverageFindings.push(c);
        }
      }
    }
  }

  // ---- Per-opponent matchup checks --------------------------------------
  const matchupChecks: MatchupCheck[] = [];
  if (opponent && opponent !== "unknown") {
    const oppProfile = ARCHETYPE_PROFILES[opponent as Exclude<Archetype, "generic">];
    const userMain = resolveMainAttackers(analysis, ctx)[0];
    const oppMain = oppProfile
      ? resolveProfileAttackers(oppProfile.mainAttackers, ctx)
      : [];
    const snapshotTechs = snapshot?.techCoverage.find((t) => t.archetype === opponent)?.threats;
    if (userMain && oppMain.length > 0) {
      const checks = runStaticMatchupChecks(
        {
          user: {
            mainAttackers: [userMain],
            deckCards: userDeck,
            archetype: heroId as Archetype | "generic",
          },
          opponent: {
            mainAttackers: oppMain,
            archetype: opponent,
          },
          stockLists: snapshot?.stockLists,
          techCoverageForOpp: snapshotTechs,
        },
        ctx,
      );
      matchupChecks.push(...checks);
    }
  }

  return {
    structuralGrade: structuralG,
    matchupGrade,
    matchupGradeAgainst,
    matchupCi95,
    matchupSampleSize,
    matchupConfidence,
    metaGrade,
    expectedWinRate,
    expectedWinRateRange,
    metaConfidence,
    fieldCoverage,
    matchupChecks,
    stockListFindings,
    techCoverageFindings,
    snapshot: snapshotMeta,
  };
}

// ---- Helpers --------------------------------------------------------------

function resolveMainAttackers(
  analysis: DeckAnalysis,
  ctx: DoctorContext,
): PokemonCard[] {
  const out: PokemonCard[] = [];
  for (const name of analysis.composition.attackersMain) {
    const card = (ctx.cardsByName.get(name) ?? []).find(
      (c): c is PokemonCard => c.supertype === "Pokémon",
    );
    if (card) out.push(card);
  }
  return out;
}

function resolveProfileAttackers(
  names: readonly string[],
  ctx: DoctorContext,
): PokemonCard[] {
  const out: PokemonCard[] = [];
  for (const name of names) {
    const card = (ctx.cardsByName.get(name) ?? []).find(
      (c): c is PokemonCard => c.supertype === "Pokémon",
    );
    if (card) out.push(card);
  }
  return out;
}

function resolveAttackersFromRefs(
  refs: ResolvedAttackerRef[],
  ctx: DoctorContext,
): PokemonCard[] {
  const out: PokemonCard[] = [];
  for (const ref of refs) {
    const candidates = (ctx.cardsByName.get(ref.cardName) ?? []).filter(
      (c): c is PokemonCard => c.supertype === "Pokémon",
    );
    // Prefer the printing whose gameplayKey matches; fall back to the first.
    const match =
      candidates.find((c) => ctx.gameplayKey(c) === ref.gameplayKey) ??
      candidates[0];
    if (match) out.push(match);
  }
  return out;
}
