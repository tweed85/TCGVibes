#!/usr/bin/env node
// Aggregate RK9 round-by-round pairings into matchup cells.
//
// Pipeline:
//   1. Read all cached RK9 pairing JSONs in data/rk9-pairings/
//   2. Read a player → archetype label lookup (--labels <file>, or
//      derived from a snapshot's tournaments[].topFinishes)
//   3. For each pairing where BOTH players have known archetypes, tally
//      (heroArchetype, villainArchetype) → wins / losses / ties
//   4. Compute Wilson 95% CI + confidence labels
//   5. Emit matchup cells in MatchupCell shape (see src/data/metaSnapshot.ts)
//
// Usage:
//   node scripts/snapshot/aggregate-rk9-matchups.mjs \
//        [--snapshot src/data/metaSnapshots/2026-05.json] \
//        [--labels data/rk9-pairings/labels.json] \
//        [--out data/rk9-pairings/aggregates.json]
//
// If --snapshot is provided, player→archetype labels are taken from
// snapshot.tournaments[].topFinishes (preferring archetype slug; fallback
// to "unknown" with archetypeLabel preserved separately).
// If --labels is provided ALSO, those override snapshot entries.
//
// Output (data/rk9-pairings/aggregates.json):
//   {
//     generatedAt, sourceEvents[], totalPairings, labeledPairings,
//     uniqueLabeledPlayers, cells: MatchupCell[], unmatched: [...]
//   }

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RK9_DIR = join(REPO_ROOT, "data", "rk9-pairings");

// ---- Player-name normalization ----------------------------------------

// Letter-with-stroke characters that NFD won't decompose because they're
// base letters, not letter+combining-mark pairs. Name matching across data
// sources commonly fails on these (Limitless vs RK9 normalize differently
// — RK9 keeps "Łaszkiewicz", some Limitless exports give "Laszkiewicz").
const STROKED_LETTERS = {
  Ł: "L",
  ł: "l",
  Ø: "O",
  ø: "o",
  Ð: "D",
  ð: "d",
  Þ: "Th",
  þ: "th",
  Æ: "AE",
  æ: "ae",
  Œ: "OE",
  œ: "oe",
  ß: "ss",
};

// Strip diacritics + stroked-letter base-form, lowercase, collapse whitespace.
// Used to join RK9 names against Limitless labels.
function normalizeName(name) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks (accents above/below)
    .replace(/[ŁłØøÐðÞþÆæŒœß]/g, (c) => STROKED_LETTERS[c] ?? c)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Compose lookup key. Country code disambiguates common names — "John Smith"
// from US and CA are different entries. Falls back to name-only if country
// is missing (Limitless sometimes lacks it for online events).
function lookupKey(name, country) {
  const n = normalizeName(name);
  return country ? `${n}|${country.toUpperCase()}` : n;
}

// ---- Wilson 95% CI ------------------------------------------------------

function wilson95(wins, total) {
  if (total === 0) return { ci95Low: 0, ci95High: 1 };
  const z = 1.96;
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { ci95Low: Math.max(0, center - margin), ci95High: Math.min(1, center + margin) };
}

function confidenceLabel(sampleSize) {
  if (sampleSize >= 30) return "high";
  if (sampleSize >= 10) return "medium";
  return "low";
}

// ---- Archetype slug mapping ------------------------------------------

// Same mapping as the snapshot's topFinishes work: natural-language deck
// names → engine Archetype slug. Variants not in the union route to
// "unknown" so the matchup matrix is consistent with the engine.
function archetypeSlug(label) {
  if (!label) return "unknown";
  const L = label.toLowerCase().trim();
  if (L === "dragapult / dudunsparce" || L === "dragapult/dudunsparce") return "dragapult-dudunsparce";
  if (L === "dragapult / blaziken" || L === "dragapult/blaziken") return "dragapult-blaziken";
  if (L === "crustle") return "crustle";
  if (L === "garchomp" || L.includes("cynthia's garchomp")) return "cynthia-garchomp";
  if (L.includes("grimmsnarl") && L.includes("froslass")) return "grimmsnarl-froslass";
  if (L === "alakazam / dudunsparce" || L === "alakazam/dudunsparce") return "alakazam";
  if (L === "rocket mewtwo ex" || L === "mewtwo / spidops" || L === "mewtwo/spidops") return "rocket-mewtwo";
  if (L === "starmie-mega / froslass" || L === "starmie-mega/froslass") return "mega-starmie-froslass";
  if (L === "dipplin / thwackey" || L === "dipplin/thwackey") return "festival-leads";
  return "unknown";
}

// ---- Top-finish loading -----------------------------------------------

// Pull player→{archetype, archetypeLabel, country} from a meta-snapshot's
// tournaments[].topFinishes. Returns a Map keyed by lookupKey.
function labelsFromSnapshot(snapshot) {
  const labels = new Map();
  for (const t of snapshot.tournaments ?? []) {
    if (!t.topFinishes) continue;
    for (const f of t.topFinishes) {
      const key = lookupKey(f.player, f.country);
      labels.set(key, {
        archetype: f.archetype ?? archetypeSlug(f.archetypeLabel),
        archetypeLabel: f.archetypeLabel ?? f.archetype,
        country: f.country,
        player: f.player,
        sourceEvent: t.id,
      });
    }
  }
  return labels;
}

// Merge an additional labels file (--labels). Each entry overrides any
// snapshot-sourced label with the same key.
function mergeLabelsFile(labels, path) {
  if (!existsSync(path)) {
    console.error(`[agg] labels file ${path} not found; using snapshot-only labels`);
    return labels;
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of json.players ?? []) {
    const key = lookupKey(entry.name, entry.country);
    labels.set(key, {
      archetype: entry.archetype ?? archetypeSlug(entry.archetypeLabel),
      archetypeLabel: entry.archetypeLabel,
      country: entry.country,
      player: entry.name,
      sourceEvent: entry.source ?? "labels.json",
    });
  }
  return labels;
}

// ---- Cell aggregation -----------------------------------------------

function emptyTally() {
  return { wins: 0, losses: 0, ties: 0 };
}

// One pairing produces TWO cells: (p1Arch vs p2Arch) and (p2Arch vs p1Arch).
// We're tallying both perspectives so the matrix is symmetric in counts but
// the win-rates are dual (a vs b winRate = 1 - b vs a winRate when no ties).
function tallyPairing(pairing, p1Label, p2Label, tallies) {
  const a = p1Label.archetype;
  const b = p2Label.archetype;
  const ab = `${a}|${b}`;
  const ba = `${b}|${a}`;
  if (!tallies.has(ab)) tallies.set(ab, emptyTally());
  if (!tallies.has(ba)) tallies.set(ba, emptyTally());
  const cellAB = tallies.get(ab);
  const cellBA = tallies.get(ba);
  if (pairing.result === "win") {
    cellAB.wins++;
    cellBA.losses++;
  } else if (pairing.result === "loss") {
    cellAB.losses++;
    cellBA.wins++;
  } else if (pairing.result === "tie") {
    cellAB.ties++;
    cellBA.ties++;
  }
}

function cellsFromTallies(tallies) {
  const cells = [];
  for (const [key, t] of tallies) {
    const [hero, villain] = key.split("|");
    if (hero === villain) continue; // mirror matches skipped — same archetype both sides
    const sampleSize = t.wins + t.losses + t.ties;
    if (sampleSize === 0) continue;
    const effectiveWins = t.wins + 0.5 * t.ties;
    const winRate = effectiveWins / sampleSize;
    const { ci95Low, ci95High } = wilson95(effectiveWins, sampleSize);
    cells.push({
      hero,
      villain,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      winRate: +winRate.toFixed(4),
      ci95Low: +ci95Low.toFixed(4),
      ci95High: +ci95High.toFixed(4),
      sampleSize,
      confidence: confidenceLabel(sampleSize),
    });
  }
  // Sort by hero asc, sample desc, villain asc for stable diffs.
  cells.sort(
    (a, b) =>
      a.hero.localeCompare(b.hero) ||
      b.sampleSize - a.sampleSize ||
      a.villain.localeCompare(b.villain),
  );
  return cells;
}

// ---- Main --------------------------------------------------------------

function parseArgs(argv) {
  const opts = { snapshot: null, labels: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--snapshot") opts.snapshot = argv[++i];
    else if (arg.startsWith("--snapshot=")) opts.snapshot = arg.slice("--snapshot=".length);
    else if (arg === "--labels") opts.labels = argv[++i];
    else if (arg.startsWith("--labels=")) opts.labels = arg.slice("--labels=".length);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
  }
  // Defaults
  opts.snapshot ??= join(REPO_ROOT, "src", "data", "metaSnapshots", "2026-05.json");
  opts.labels ??= join(RK9_DIR, "labels.json");
  opts.out ??= join(RK9_DIR, "aggregates.json");
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);

  // 1. Load all cached RK9 pairings
  if (!existsSync(RK9_DIR)) {
    console.error(`[agg] ${RK9_DIR} does not exist; run snapshot:fetch-rk9 first`);
    process.exit(1);
  }
  const files = readdirSync(RK9_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !f.startsWith("aggregates") && !f.startsWith("labels"))
    .map((f) => join(RK9_DIR, f));
  if (files.length === 0) {
    console.error(`[agg] no RK9 pairing files in ${RK9_DIR}`);
    process.exit(1);
  }
  console.error(`[agg] found ${files.length} RK9 event cache(s):`);
  for (const f of files) console.error(`  ${basename(f)}`);

  // 2. Load labels
  let labels = new Map();
  if (existsSync(opts.snapshot)) {
    const snap = JSON.parse(readFileSync(opts.snapshot, "utf8"));
    labels = labelsFromSnapshot(snap);
    console.error(`[agg] loaded ${labels.size} labels from snapshot`);
  } else {
    console.error(`[agg] snapshot ${opts.snapshot} not found; relying on --labels only`);
  }
  if (opts.labels && existsSync(opts.labels)) {
    const before = labels.size;
    labels = mergeLabelsFile(labels, opts.labels);
    console.error(`[agg] +${labels.size - before} labels from ${opts.labels}`);
  }
  console.error(`[agg] total labels: ${labels.size}`);

  // 3. Walk each event's pairings
  const tallies = new Map();
  let totalPairings = 0;
  let labeledPairings = 0;
  let labeledOneSide = 0;
  const perEvent = [];
  const labeledPlayersSeen = new Set();

  for (const file of files) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    let eventTotal = 0;
    let eventLabeled = 0;
    let eventOneSide = 0;
    for (const round of data.rounds) {
      for (const pairing of round.pairings) {
        if (!["win", "loss", "tie"].includes(pairing.result)) continue;
        eventTotal++;
        totalPairings++;
        const k1 = lookupKey(pairing.player1.name, pairing.player1.country);
        const k2 = lookupKey(pairing.player2.name, pairing.player2.country);
        const l1 = labels.get(k1);
        const l2 = labels.get(k2);
        if (l1) labeledPlayersSeen.add(k1);
        if (l2) labeledPlayersSeen.add(k2);
        if (l1 && l2) {
          tallyPairing(pairing, l1, l2, tallies);
          eventLabeled++;
          labeledPairings++;
        } else if (l1 || l2) {
          eventOneSide++;
          labeledOneSide++;
        }
      }
    }
    perEvent.push({
      tournamentId: data.tournamentId,
      tournamentName: data.tournamentName,
      totalPairings: eventTotal,
      labeledBothSides: eventLabeled,
      labeledOneSide: eventOneSide,
      labeledPlayers: data.standings.filter((s) =>
        labels.has(lookupKey(s.name, s.country)),
      ).length,
    });
  }

  // 4. Cells
  const cells = cellsFromTallies(tallies);

  // 5. Output
  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceEvents: files.map((f) => basename(f, ".json")),
    totalPairings,
    labeledPairings,
    labeledOneSide,
    uniqueLabeledPlayers: labeledPlayersSeen.size,
    perEvent,
    cells,
  };
  writeFileSync(opts.out, JSON.stringify(out, null, 2) + "\n");
  console.error(`[agg] wrote ${opts.out}`);

  // Summary
  console.log(
    JSON.stringify(
      {
        ok: true,
        events: files.length,
        totalPairings,
        labeledPairings,
        labeledOneSide,
        uniqueLabeledPlayers: labeledPlayersSeen.size,
        cells: cells.length,
      },
      null,
      2,
    ),
  );
}

main();
