#!/usr/bin/env node
// Fetch Pokémon TCG tournament pairings + standings from RK9 Labs.
//
// Why this exists: Limitless's public API exposes top-cut decklists + final
// standings but NOT round-by-round Swiss pairings for offline Regionals.
// RK9 publishes the official Play! Pokémon tournament data including
// every Swiss round pairing with results. Combining the two:
//
//   RK9 pairings  (player vs player + result, every round)
//   + Limitless   (player -> archetype mapping for top finishers)
//   = partial matchup matrix for offline events
//
// Per-archetype win rates from this can fold into the snapshot's
// matchupMatrix[] alongside the existing online-event cells.
//
// Usage:
//   npm run snapshot:fetch-rk9 -- <tournament-id> [--out <file>]
//   node scripts/snapshot/fetch-rk9-pairings.mjs <tournament-id>
//
//   <tournament-id>    RK9 ID (e.g. PR01w1kJAMjLB09Ftxyj for Prague Regional)
//   --out <file>       Output JSON path. Default: data/rk9-pairings/<id>.json
//
// Find tournament IDs at https://rk9.gg/events/pokemon under /tournament/<ID>.
// Cache directory `data/rk9-pairings/` is gitignored — per-Regional files are
// ~3MB and would balloon repo history. Regenerate via this script.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverRounds,
  extractInlineRound,
  parseRound,
  parseStandings,
} from "./rk9-parser.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const BASE = "https://rk9.gg";
const UA = "tcgvibes-snapshot-agent/1.0 (https://github.com/tweed85/TCGVibes)";
const MASTERS_POD = 2;

async function fetchText(url, { hxRequest = false } = {}) {
  const headers = { "User-Agent": UA };
  if (hxRequest) headers["HX-Request"] = "true";
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return await res.text();
}

function parseArgs(argv) {
  const positional = [];
  let outPath = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out") {
      outPath = argv[++i];
    } else if (argv[i].startsWith("--out=")) {
      outPath = argv[i].slice("--out=".length);
    } else {
      positional.push(argv[i]);
    }
  }
  return { tournamentId: positional[0], outPath };
}

async function main() {
  const { tournamentId, outPath } = parseArgs(process.argv);
  if (!tournamentId) {
    console.error("Usage: fetch-rk9-pairings.mjs <tournament-id> [--out <file>]");
    process.exit(1);
  }
  console.error(`[rk9] tournament: ${tournamentId}`);

  // 1. Static page → enumerate Masters rounds + tournament name.
  const staticUrl = `${BASE}/pairings/${tournamentId}`;
  console.error(`[rk9] fetching static ${staticUrl}`);
  const staticHtml = await fetchText(staticUrl);
  const titleMatch = staticHtml.match(/<title>([^<]+)<\/title>/);
  const tournamentName = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : tournamentId;
  const rounds = discoverRounds(staticHtml, MASTERS_POD);
  console.error(`[rk9] Masters rounds discovered: ${rounds.length} (${rounds[0]}..${rounds.at(-1)})`);

  if (rounds.length === 0) {
    console.error("[rk9] no Masters rounds found — site structure may have changed");
    process.exit(2);
  }

  // 2. Per-round pairings. Try htmx first; fall back to extracting from the
  //    static HTML for rounds that RK9 inlines directly (typically the
  //    finals round on completed events).
  const roundData = [];
  for (const rnd of rounds) {
    process.stderr.write(`[rk9] round ${rnd}... `);
    let pairings = [];
    let source = "htmx";
    const url = `${BASE}/pairings/${tournamentId}?pod=${MASTERS_POD}&rnd=${rnd}`;
    try {
      const html = await fetchText(url, { hxRequest: true });
      pairings = parseRound(html);
    } catch (err) {
      console.error(`htmx SKIP (${err.message}); trying inline...`);
    }
    if (pairings.length === 0) {
      const inline = extractInlineRound(staticHtml, MASTERS_POD, rnd);
      if (inline && inline.length > 0) {
        pairings = inline;
        source = "inline";
      }
    }
    console.error(`${pairings.length} pairings (${source})`);
    roundData.push({ round: rnd, pairings });
    // Be polite to RK9 — 250ms between requests.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // 3. Standings from static HTML (already loaded).
  const standings = parseStandings(staticHtml, MASTERS_POD);
  console.error(`[rk9] standings parsed: ${standings.length} finishers`);

  // 4. Assemble + write.
  const output = {
    schemaVersion: 1,
    source: "rk9.gg",
    tournamentId,
    tournamentName,
    tournamentUrl: staticUrl,
    division: "masters",
    fetchedAt: new Date().toISOString(),
    roundCount: rounds.length,
    rounds: roundData,
    standings,
  };

  const finalPath = outPath ?? join(REPO_ROOT, "data", "rk9-pairings", `${tournamentId}.json`);
  if (!existsSync(dirname(finalPath))) mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, JSON.stringify(output, null, 2) + "\n");
  console.error(`[rk9] wrote ${finalPath}`);

  // Summary to stdout (for caller use)
  const pairingCount = roundData.reduce((sum, r) => sum + r.pairings.length, 0);
  console.log(
    JSON.stringify(
      {
        ok: true,
        tournamentId,
        path: finalPath,
        rounds: rounds.length,
        pairings: pairingCount,
        standings: standings.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`[rk9] FATAL: ${err.stack ?? err.message}`);
  process.exit(1);
});
