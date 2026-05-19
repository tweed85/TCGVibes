#!/usr/bin/env node
// Fetch Limitless Labs standings — the source of full-field archetype
// labels for Pokémon TCG offline Regionals. Each labs standings page
// exposes ~500 ranked players per event with archetype slugs already
// derived by Limitless (no per-decklist parsing required).
//
// Coverage per event is ~Day 2 cut + drops with decklists (typically
// top 256–512 of a 1,500–2,500 player Regional). RK9 has the full
// field's pairings but no decklist data; Limitless labs has the field's
// archetype labels but no pairing data. Together: labeled pairings
// for the matchup aggregator.
//
// Usage:
//   node scripts/snapshot/fetch-limitless-labels.mjs <labs-id>
//        [--out <file>]
//
//   <labs-id>     Limitless labs ID (e.g. 0063 for LA Regional 2026).
//                 Find it on a tournament page (limitlesstcg.com/
//                 tournaments/NNN → labs link → /labs/<id>/standings).
//   --out <file>  Output JSON path. Default:
//                 data/rk9-pairings/labs-<labs-id>.json
//                 (intentionally sibling to RK9 cache for convenience;
//                 the aggregator already reads this dir.)

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const BASE = "https://labs.limitlesstcg.com";
const UA = "tcgvibes-snapshot-agent/1.0 (https://github.com/tweed85/TCGVibes)";

// ---- Parser ---------------------------------------------------------

// Each data row looks like:
//   <tr class="day2 topcut|day2|...">
//     <td>RANK</td>
//     <td><a href="/<labs>/player/PID">NAME</a></td>
//     <td>...flag with title="CC"...</td>
//     <td>POINTS</td>
//     <td>W - L - T</td>
//     ... (OPW% / OOPW%) ...
//     <td><a href="/<labs>/decks/ARCH-SLUG">...icons...</a></td>
//     <td><a href="/<labs>/player/PID/decklist">...</a></td>
//   </tr>
function parseStandingsRows(html, labsId) {
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [];
  for (const rowMatch of html.matchAll(rowRx)) {
    const rowHtml = rowMatch[1];
    const rankMatch = rowHtml.match(/^\s*<td>(\d+)<\/td>/);
    if (!rankMatch) continue;
    const rank = +rankMatch[1];

    const playerMatch = rowHtml.match(
      new RegExp(`<a href="/${labsId}/player/(\\d+)"[^>]*>([^<]+)</a>`),
    );
    if (!playerMatch) continue;
    const playerId = playerMatch[1];
    const name = playerMatch[2].trim();

    const countryMatch = rowHtml.match(/title="([A-Z]{2})"/);
    const country = countryMatch ? countryMatch[1] : undefined;

    const recordMatch = rowHtml.match(/(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/);
    const record = recordMatch
      ? { wins: +recordMatch[1], losses: +recordMatch[2], ties: +recordMatch[3] }
      : undefined;

    const deckMatch = rowHtml.match(
      new RegExp(`<a href="/${labsId}/decks/([a-z0-9-]+)"`),
    );
    const archetypeSlug = deckMatch ? deckMatch[1] : null;

    const decklistMatch = rowHtml.match(
      new RegExp(`<a href="(/${labsId}/player/\\d+/decklist)"`),
    );
    const decklistPath = decklistMatch ? decklistMatch[1] : null;

    rows.push({
      rank,
      playerId,
      name,
      country,
      record,
      archetypeSlug,
      decklistUrl: decklistPath ? `${BASE}${decklistPath}` : null,
    });
  }
  return rows;
}

// Map a labs slug to an engine `Archetype | "unknown"`. Labs slugs are
// more granular than the engine union; route variants we haven't wired
// to "unknown" while preserving the precise slug separately.
function labsSlugToEngineArchetype(slug) {
  if (!slug) return "unknown";
  const lookup = {
    // Pre-Stage-1 (12 wired archetypes)
    "dragapult-dudunsparce": "dragapult-dudunsparce",
    "dragapult-blaziken": "dragapult-blaziken",
    crustle: "crustle",
    "crustle-dri": "crustle",
    "cynthia-garchomp": "cynthia-garchomp",
    "cynthia-garchomp-ex": "cynthia-garchomp",
    garchomp: "cynthia-garchomp",
    "grimmsnarl-froslass": "grimmsnarl-froslass",
    "alakazam-dudunsparce": "alakazam",
    alakazam: "alakazam",
    "rocket-mewtwo": "rocket-mewtwo",
    "rocket-mewtwo-ex": "rocket-mewtwo",
    "mewtwo-spidops": "rocket-mewtwo",
    "rocket-mewtwo-spidops": "rocket-mewtwo",
    "rocket-spidops": "rocket-mewtwo",
    "starmie-mega-froslass": "mega-starmie-froslass",
    "mega-starmie-froslass": "mega-starmie-froslass",
    "starmie-froslass": "mega-starmie-froslass",
    "dipplin-thwackey": "festival-leads",
    "festival-leads": "festival-leads",
    "festival-lead": "festival-leads", // labs uses singular
    "hops-trevenant": "hops-trevenant",
    arboliva: "arboliva",
    "lucario-mega": "lucario-ex",
    "lucario-ex": "lucario-ex",
    "mega-lucario-ex": "lucario-ex",
    "lucario-hariyama": "lucario-ex",
    // Stage 1-5 expansion — slugs added 2026-05-19. Most labs slugs match
    // the engine slug exactly; the variants below are for labs-side
    // typos / alternate constructions.
    "starmie-dusknoir": "starmie-dusknoir",
    "n-zoroark": "n-zoroark",
    "raging-bolt-ogerpon": "raging-bolt-ogerpon",
    "rockets-honchkrow": "rockets-honchkrow",
    "rocket-honchkrow": "rockets-honchkrow",
    "okidogi-barbaracle": "okidogi-barbaracle",
    "slowking-scr": "slowking-scr",
    slowking: "slowking-scr",
    "lopunny-dudunsparce": "lopunny-dudunsparce",
    "lopunny-mega-dudunsparce": "lopunny-dudunsparce",
    "greninja-ex": "greninja-ex",
    "mega-greninja-ex": "greninja-ex",
    "clefairy-ogerpon": "clefairy-ogerpon",
    "ogerpon-box": "ogerpon-box",
    "stevens-metagross": "stevens-metagross",
    "diancie-dusknoir": "diancie-dusknoir",
    "ursaluna-lunatone": "ursaluna-lunatone",
    "flareon-noctowl": "flareon-noctowl",
    // Stage 6 expansion — 2 Dragapult variants + 4 box decks.
    "dragapult-ex": "dragapult-ex",
    "dragapult-dusknoir": "dragapult-dusknoir",
    "hydrapple-ogerpon": "hydrapple-ogerpon",
    hydrapple: "hydrapple-ogerpon",
    "ogerpon-meganium": "ogerpon-meganium",
    "meganium-ogerpon": "ogerpon-meganium",
    "mega-absol-box": "mega-absol-box",
    "absol-box": "mega-absol-box",
    "mega-absol-ex": "mega-absol-box",
    "tera-box": "tera-box",
  };
  return lookup[slug] ?? "unknown";
}

// Convert "lopunny-dudunsparce" → "Lopunny Dudunsparce" for display.
// Labs slugs are ambiguous as to single-vs-paired decks (e.g.
// "raging-bolt-ogerpon" = "Raging Bolt / Ogerpon", but
// "dragapult-ex" = "Dragapult ex" — both 2 hyphens). Title-case all
// segments, keep known suffix tokens lowercase (ex/scr/box/etc),
// then merge into a single space-separated label. The aggregator
// keys off the raw `archetypeSlug` field — this is display only.
const LOWERCASE_TOKENS = new Set(["ex", "scr", "box", "ev", "v"]);
function slugToLabel(slug) {
  if (!slug) return null;
  return slug
    .split("-")
    .map((s) => (LOWERCASE_TOKENS.has(s) ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(" ");
}

// ---- HTTP -----------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return await res.text();
}

// ---- CLI -----------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  let outPath = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out") outPath = argv[++i];
    else if (argv[i].startsWith("--out=")) outPath = argv[i].slice("--out=".length);
    else positional.push(argv[i]);
  }
  return { labsId: positional[0], outPath };
}

async function main() {
  const { labsId, outPath } = parseArgs(process.argv);
  if (!labsId) {
    console.error("Usage: fetch-limitless-labels.mjs <labs-id> [--out <file>]");
    process.exit(1);
  }
  console.error(`[labs] labs ID: ${labsId}`);

  const url = `${BASE}/${labsId}/standings`;
  console.error(`[labs] fetching ${url}`);
  const html = await fetchText(url);
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const tournamentName = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : `labs-${labsId}`;
  // Strip the trailing " – Limitless Labs" so the value is reusable as
  // a clean event label in the aggregator (which still has "Tournament
  // Pairings - RK9" as the RK9-side page title and needs labs to supply
  // the human-readable name).
  const cleanEventName = tournamentName.replace(/\s*[–-]\s*Limitless Labs\s*$/i, "");
  // The labs page header embeds a link to the RK9 pairings page —
  // extracting the RK9 tournament ID here lets the aggregator join
  // labs labels to RK9 pairings by that ID without an additional
  // operator-maintained mapping file.
  const rk9Match = html.match(/rk9\.gg\/(?:pairings|tournament)\/([A-Za-z0-9]+)/);
  const rk9TournamentId = rk9Match ? rk9Match[1] : null;
  if (rk9TournamentId) {
    console.error(`[labs] linked RK9 tournament: ${rk9TournamentId}`);
  } else {
    console.error(`[labs] no RK9 tournament link found on the labs page`);
  }

  const rows = parseStandingsRows(html, labsId);
  console.error(`[labs] parsed ${rows.length} ranked players`);

  // Annotate each row with engine archetype + display label
  const players = rows.map((r) => ({
    rank: r.rank,
    name: r.name,
    country: r.country,
    playerId: r.playerId,
    record: r.record,
    archetype: labsSlugToEngineArchetype(r.archetypeSlug),
    archetypeLabel: slugToLabel(r.archetypeSlug),
    archetypeSlug: r.archetypeSlug,
    decklistUrl: r.decklistUrl,
  }));

  const archCounts = {};
  for (const p of players) {
    archCounts[p.archetypeLabel ?? "?"] = (archCounts[p.archetypeLabel ?? "?"] ?? 0) + 1;
  }
  const topArchetypes = Object.entries(archCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const output = {
    schemaVersion: 1,
    source: "labs.limitlesstcg.com",
    labsId,
    tournamentName,
    cleanEventName,
    rk9TournamentId,
    standingsUrl: url,
    fetchedAt: new Date().toISOString(),
    playerCount: players.length,
    players,
  };

  const finalPath = outPath ?? join(REPO_ROOT, "data", "rk9-pairings", `labs-${labsId}.json`);
  if (!existsSync(dirname(finalPath))) mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, JSON.stringify(output, null, 2) + "\n");
  console.error(`[labs] wrote ${finalPath}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        labsId,
        path: finalPath,
        playerCount: players.length,
        topArchetypes,
        unmappedEngine: players.filter((p) => p.archetype === "unknown").length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`[labs] FATAL: ${err.stack ?? err.message}`);
  process.exit(1);
});
