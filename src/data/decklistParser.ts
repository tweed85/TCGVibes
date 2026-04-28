// Parses a standard Play! Pokémon decklist (as exported from Limitless / PTCGL)
// and resolves each entry against our card dataset.
//
// Input format:
//   Pokémon: 21
//   4 Dipplin TWM 18
//   4 Grookey TWM 14
//   ...
//
//   Trainer: 33
//   4 Buddy-Buddy Poffin ASC 184
//   ...
//
//   Energy: 6
//   6 Grass Energy SVE 1
//
// Each card line is: "<count> <name> <limitless_set_code> <number>". Section
// headers (and blank lines) are ignored — we just parse card lines.
//
// The set code in the decklist is Limitless's code (TWM, PRE, DRI, ...). Our
// dataset uses pokemon-tcg-data codes (sv6, sv8pt5, sv10, ...). The inverse
// mapping below handles that; cards whose printing isn't in our pool (e.g.
// "Switch SVI 194" when SVI has rotated) fall back to a name-only match.

import { allCards, findByName } from "./cards";
import type { Card } from "../engine/types";

export interface DeckListEntry {
  count: number;
  name: string;
  limitlessSet: string;
  number: string;
}

export interface ParseResult {
  entries: DeckListEntry[];
  totalCards: number;
  parseErrors: string[]; // lines that couldn't be parsed
}

export interface BuildResult {
  deck: Card[];
  unmatched: DeckListEntry[]; // entries we couldn't resolve
  nameOnlyMatches: DeckListEntry[]; // resolved by name (set/number didn't match)
  ruleViolations: string[]; // deckbuilding rule failures (4-per-name, 1 ACE SPEC, 1 Radiant)
}

// Inverse of SET_CODE_TO_LIMITLESS in cardImages.ts, plus a few extras for
// sets that appear on decklists but aren't in our current legal pool. For
// those, the resolver falls through to name-only matching.
const LIMITLESS_TO_SET_CODE: Record<string, string> = {
  PAF: "sv4pt5",
  TEF: "sv5",
  TWM: "sv6",
  SFA: "sv6pt5",
  SCR: "sv7",
  SSP: "sv8",
  PRE: "sv8pt5",
  JTG: "sv9",
  DRI: "sv10",
  BLK: "zsv10pt5",
  WHT: "rsv10pt5",
  MEG: "me1",
  PFL: "me2",
  ASC: "me2pt5",
  POR: "me3",
  SVE: "sve",
  SVP: "svp",
};

// Parse a raw decklist text blob. Section headers ("Pokémon: 21", "Trainer: 33",
// "Energy: 6") are read for a round-trip total but don't affect resolution.
export function parseDecklist(text: string): ParseResult {
  const entries: DeckListEntry[] = [];
  const parseErrors: string[] = [];
  let totalCards = 0;

  const lineRe = /^(\d+)\s+(.+?)\s+([A-Z]+)\s+([0-9A-Za-z]+)\s*$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Section header lines look like "Pokémon: 21" or "Trainer: 33". Skip.
    if (/^(pok[eé]mon|trainer|energy)s?\s*:\s*\d+/i.test(line)) continue;

    const m = line.match(lineRe);
    if (!m) {
      parseErrors.push(line);
      continue;
    }
    const count = parseInt(m[1], 10);
    const name = m[2].trim();
    const limitlessSet = m[3].toUpperCase();
    const number = m[4];
    entries.push({ count, name, limitlessSet, number });
    totalCards += count;
  }
  return { entries, totalCards, parseErrors };
}

// Find a Card in the dataset by Limitless set + printed number.
function findBySetAndNumber(limitlessSet: string, number: string): Card | undefined {
  const datasetSet = LIMITLESS_TO_SET_CODE[limitlessSet];
  if (!datasetSet) return undefined;
  return allCards.find(
    (c) => c.setCode === datasetSet && c.number === number,
  );
}

// Resolve parsed entries into a concrete deck (one Card instance per copy).
// Entries whose specific printing is missing try name-only match as a fallback.
// Completely unresolved entries are reported so the UI can tell the user.
// Also enforces deckbuilding rules: 4-per-name (except Basic Energy),
// 1 Radiant Pokémon total, 1 ACE SPEC total.
export function buildDeckFromEntries(entries: DeckListEntry[]): BuildResult {
  const deck: Card[] = [];
  const unmatched: DeckListEntry[] = [];
  const nameOnlyMatches: DeckListEntry[] = [];
  const ruleViolations: string[] = [];

  // Per-name count (for the 4-per-name rule).
  const nameCounts = new Map<string, number>();
  let radiantTotal = 0;
  let aceSpecTotal = 0;

  for (const entry of entries) {
    const byPrinting = findBySetAndNumber(entry.limitlessSet, entry.number);
    // Name fallbacks: exact match first; then try "Basic <name>" since some
    // decklist tools export basic energies as "Grass Energy" while the pool
    // ships "Basic Grass Energy" (SVE printings).
    const resolved =
      byPrinting ??
      findByName(entry.name) ??
      findByName(`Basic ${entry.name}`);
    if (!resolved) {
      unmatched.push(entry);
      continue;
    }
    if (!byPrinting) nameOnlyMatches.push(entry);

    const isBasicEnergy =
      resolved.supertype === "Energy" && resolved.subtypes.includes("Basic");
    const isRadiant = resolved.subtypes.includes("Radiant");
    const isAceSpec = resolved.subtypes.includes("ACE SPEC");

    const priorCount = nameCounts.get(entry.name) ?? 0;
    nameCounts.set(entry.name, priorCount + entry.count);
    if (isRadiant) radiantTotal += entry.count;
    if (isAceSpec) aceSpecTotal += entry.count;

    // Per-name cap: 4 copies (basic Energy excluded). Truncate at the parser
    // so an over-cap decklist always produces a legal 60-card-or-less deck —
    // record the violation so the UI surfaces it but never push more than
    // the cap into the engine. Without this, a programmatic caller that
    // skipped the import-modal validation could feed an illegal deck into
    // setupGame.
    let allowedFromEntry = entry.count;
    if (!isBasicEnergy) {
      const remainingCap = Math.max(0, 4 - priorCount);
      if (entry.count > remainingCap) {
        ruleViolations.push(
          `More than 4 copies of ${entry.name} — extra ${entry.count - remainingCap} dropped.`,
        );
      }
      allowedFromEntry = Math.min(entry.count, remainingCap);
    }
    for (let i = 0; i < allowedFromEntry; i++) {
      deck.push({ ...resolved } as Card);
    }
  }

  if (radiantTotal > 1) {
    ruleViolations.push(`${radiantTotal} Radiant Pokémon — deck may contain only 1.`);
  }
  if (aceSpecTotal > 1) {
    ruleViolations.push(`${aceSpecTotal} ACE SPEC cards — deck may contain only 1.`);
  }

  return { deck, unmatched, nameOnlyMatches, ruleViolations };
}

// Convenience: parse + build in one step. Returns the parsed entries so
// callers can persist the raw decklist (useful for re-resolving against a
// later-updated dataset).
export function importDecklist(text: string): {
  entries: DeckListEntry[];
  deck: Card[];
  totalCards: number;
  unmatched: DeckListEntry[];
  ruleViolations: string[];
  nameOnlyMatches: DeckListEntry[];
  parseErrors: string[];
} {
  const parsed = parseDecklist(text);
  const built = buildDeckFromEntries(parsed.entries);
  return {
    entries: parsed.entries,
    deck: built.deck,
    totalCards: parsed.totalCards,
    unmatched: built.unmatched,
    nameOnlyMatches: built.nameOnlyMatches,
    ruleViolations: built.ruleViolations,
    parseErrors: parsed.parseErrors,
  };
}
