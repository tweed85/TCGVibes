// Stock list comparison — compares a user's deck against per-archetype card
// inclusion stats from the meta snapshot. Distribution-driven (modeCount +
// countDistribution), not average-driven, because "most lists run 4 (8 of
// 11)" is more useful than "average 3.6".
//
// Lookups are gameplayKey-aware where the snapshot supplies one — same-name
// reprints with different attacks are NOT collapsed.

import type { Card } from "../engine/types";
import type { Archetype } from "../engine/aiArchetype";
import type { DoctorContext } from "./deckDoctor";
import type { MetaSnapshot, StockCardStats } from "./metaSnapshot";

export interface StockListFinding {
  id: string;                       // e.g. "stock.missing-core"
  severity: "warning" | "suggestion" | "info";
  cardName: string;
  inclusionRate: number;
  modeCount: number;
  modeCountDecks?: number;
  averageCount: number;
  userCount: number;
  detail: string;
}

// Two cards are "the same stock entry" when their names match — accounting
// for the fact that decklists / snapshots write "Grass Energy" while the
// dataset stores "Basic Grass Energy" (the parser already does this via a
// `Basic ${name}` fallback when resolving entries; we mirror it here so
// stock comparison doesn't undercount basic energies).
function nameMatches(cardName: string, entryName: string): boolean {
  if (cardName === entryName) return true;
  if (cardName === `Basic ${entryName}`) return true;
  if (`Basic ${cardName}` === entryName) return true;
  return false;
}

// Count user copies that match a stock entry. Uses gameplayKey when the
// stock entry supplies one (Pokémon — same-name reprints aren't equivalent),
// falls back to a name match (with "Basic" prefix tolerance) otherwise.
function countUserCopies(
  userDeck: Card[],
  entry: StockCardStats,
  ctx: DoctorContext,
): number {
  if (entry.gameplayKey) {
    return userDeck.filter((c) => ctx.gameplayKey(c) === entry.gameplayKey).length;
  }
  return userDeck.filter((c) => nameMatches(c.name, entry.cardName)).length;
}

// "Within central 80%" check: returns true if `userCount` is in the
// distribution's central 80% mass.
function inCentral80(userCount: number, dist: Record<number, number>): boolean {
  const entries = Object.entries(dist)
    .map(([k, v]) => ({ count: parseInt(k, 10), decks: v }))
    .sort((a, b) => a.count - b.count);
  const total = entries.reduce((acc, e) => acc + e.decks, 0);
  if (total === 0) return false;
  const lowCut = total * 0.1;
  const highCut = total * 0.9;
  let cum = 0;
  let lowBound = entries[0].count;
  let highBound = entries[entries.length - 1].count;
  for (const e of entries) {
    cum += e.decks;
    if (cum >= lowCut && lowBound === entries[0].count) lowBound = e.count;
    if (cum >= highCut) {
      highBound = e.count;
      break;
    }
  }
  return userCount >= lowBound && userCount <= highBound;
}

// Plural / singular helper so "1 copy" / "5 copies" reads correctly.
function copies(n: number): string {
  return n === 1 ? "1 copy" : `${n} copies`;
}

export function compareToStockList(
  userDeck: Card[],
  archetype: Archetype | "generic",
  snapshot: MetaSnapshot,
  ctx: DoctorContext,
): StockListFinding[] {
  if (archetype === "generic") return [];
  const stock = snapshot.stockLists.find((s) => s.archetype === archetype);
  if (!stock) return [];

  const out: StockListFinding[] = [];

  if (stock.decksObserved < 5) {
    out.push({
      id: "stock.unavailable",
      severity: "info",
      cardName: "",
      inclusionRate: 0,
      modeCount: 0,
      averageCount: 0,
      userCount: 0,
      detail: `Stock list comparison unavailable for ${archetype} (only ${stock.decksObserved} successful decks observed).`,
    });
    return out;
  }

  for (const entry of stock.cards) {
    const userCount = countUserCopies(userDeck, entry, ctx);

    if (entry.role === "core" && userCount === 0) {
      out.push({
        id: "stock.missing-core",
        severity: "warning",
        cardName: entry.cardName,
        inclusionRate: entry.inclusionRate,
        modeCount: entry.modeCount,
        modeCountDecks: entry.modeCountDecks,
        averageCount: entry.averageCount,
        userCount,
        detail: `Most successful lists run ${copies(entry.modeCount)} of ${entry.cardName}; yours has 0.`,
      });
      continue;
    }
    if (entry.role === "common" && userCount === 0) {
      out.push({
        id: "stock.missing-common",
        severity: "suggestion",
        cardName: entry.cardName,
        inclusionRate: entry.inclusionRate,
        modeCount: entry.modeCount,
        modeCountDecks: entry.modeCountDecks,
        averageCount: entry.averageCount,
        userCount,
        detail: `${(entry.inclusionRate * 100).toFixed(0)}% of successful lists include ${entry.cardName}; yours has 0.`,
      });
      continue;
    }
    if (entry.role === "spicy" && userCount > 0) {
      out.push({
        id: "stock.spicy-tech",
        severity: "info",
        cardName: entry.cardName,
        inclusionRate: entry.inclusionRate,
        modeCount: entry.modeCount,
        modeCountDecks: entry.modeCountDecks,
        averageCount: entry.averageCount,
        userCount,
        detail: `${entry.cardName} is a spicy tech (${(entry.inclusionRate * 100).toFixed(0)}% of successful lists run it).`,
      });
      continue;
    }
    // Unusual count: ≥2 away from modeCount AND outside the central 80% of
    // the distribution.
    if (userCount > 0 && Math.abs(userCount - entry.modeCount) >= 2) {
      const wide = entry.countDistribution
        ? inCentral80(userCount, entry.countDistribution)
        : false;
      if (!wide) {
        out.push({
          id: "stock.unusual-count",
          severity: "suggestion",
          cardName: entry.cardName,
          inclusionRate: entry.inclusionRate,
          modeCount: entry.modeCount,
          modeCountDecks: entry.modeCountDecks,
          averageCount: entry.averageCount,
          userCount,
          detail: `Most successful lists run ${copies(entry.modeCount)} of ${entry.cardName}; yours has ${userCount}.`,
        });
      }
    }
  }

  return out;
}
