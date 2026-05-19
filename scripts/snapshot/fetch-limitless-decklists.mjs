#!/usr/bin/env node
// Fetch Limitless decklists for every player cited in the labs files.
//
// Limitless serves a clean JSON API:
//   https://mew.limitlesstcg.com/labs/data/tcg/decklist?tournamentId=<id>&playerId=<id>
//
// returning `{ ok: true, message: { pokemon: [...], trainer: [...], energy: [...] } }`
// where each entry is `{ count, name, set, number }`. We pull every URL
// referenced by `decklistUrl` in the cached labs-*.json files (de-duped),
// then write the parsed lists keyed by URL to
// `src/data/aggregates/decklists.json` so the DeckDoctor drill-down can
// render them inline without round-tripping to Limitless at runtime.
//
// Usage:
//   npm run snapshot:fetch-limitless-decklists
// or with throttling override:
//   node scripts/snapshot/fetch-limitless-decklists.mjs --delay 200
//
// The delay defaults to 100ms between API requests — polite enough that
// the labs hosts haven't rate-limited the snapshot agent yet. Bump it
// higher if 429s start appearing.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RK9_DIR = join(REPO_ROOT, "data", "rk9-pairings");
const OUT_DIR = join(REPO_ROOT, "src", "data", "aggregates");
const OUT_PATH = join(OUT_DIR, "decklists.json");

const UA = "tcgvibes-snapshot-agent/1.0 (https://github.com/tweed85/TCGVibes)";

function parseArgs(argv) {
  const opts = { delay: 100, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--delay") opts.delay = parseInt(argv[++i], 10);
    else if (argv[i] === "--force") opts.force = true;
  }
  return opts;
}

// labs URL format: https://labs.limitlesstcg.com/<tournamentId>/player/<playerId>/decklist
// API URL format: https://mew.limitlesstcg.com/labs/data/tcg/decklist?tournamentId=<id>&playerId=<id>
function labsUrlToApiUrl(labsUrl) {
  const m = labsUrl.match(/labs\.limitlesstcg\.com\/([^/]+)\/player\/([^/]+)\/decklist/);
  if (!m) return null;
  const [, tournamentId, playerId] = m;
  return `https://mew.limitlesstcg.com/labs/data/tcg/decklist?tournamentId=${tournamentId}&playerId=${playerId}`;
}

async function fetchDecklist(labsUrl) {
  const apiUrl = labsUrlToApiUrl(labsUrl);
  if (!apiUrl) throw new Error(`could not parse labs URL: ${labsUrl}`);
  const res = await fetch(apiUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${apiUrl} → HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok || !data.message) {
    throw new Error(`labs API returned !ok for ${apiUrl}`);
  }
  const m = data.message;
  // Defensive: any of pokemon/trainer/energy may be missing for incomplete
  // decklists (early drops). Default to empty arrays so the UI can render
  // a partial view rather than crashing.
  return {
    pokemon: m.pokemon ?? [],
    trainer: m.trainer ?? [],
    energy: m.energy ?? [],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { delay, force } = parseArgs(process.argv);
  if (!existsSync(RK9_DIR)) {
    console.error(`[dl] ${RK9_DIR} missing — run snapshot:fetch-limitless-labels first`);
    process.exit(1);
  }

  // Collect every distinct decklistUrl from the cached labs files.
  const labsFiles = readdirSync(RK9_DIR).filter(
    (f) => f.startsWith("labs-") && f.endsWith(".json"),
  );
  if (labsFiles.length === 0) {
    console.error(`[dl] no labs-*.json files in ${RK9_DIR}; run snapshot:fetch-limitless-labels first`);
    process.exit(1);
  }
  const urls = new Set();
  for (const f of labsFiles) {
    const d = JSON.parse(readFileSync(join(RK9_DIR, f), "utf8"));
    for (const p of d.players ?? []) {
      if (p.decklistUrl) urls.add(p.decklistUrl);
    }
  }
  console.error(`[dl] ${urls.size} unique decklist URLs across ${labsFiles.length} labs file(s)`);

  // Resume support: if decklists.json already exists, skip URLs already
  // present unless --force was passed. Survives Ctrl-C mid-fetch without
  // re-downloading 1900 lists to retry the last 100.
  let existing = {};
  if (!force && existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
      existing = prev.decklists ?? {};
      console.error(`[dl] resuming — ${Object.keys(existing).length} decklists already cached`);
    } catch {
      console.error(`[dl] existing decklists.json is corrupt; ignoring and refetching`);
    }
  }

  const out = { ...existing };
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const total = urls.size;
  let i = 0;
  for (const url of urls) {
    i++;
    if (out[url]) {
      skipped++;
      continue;
    }
    try {
      out[url] = await fetchDecklist(url);
      fetched++;
      if (fetched % 50 === 0) {
        console.error(`[dl]  ${i}/${total} fetched (${fetched} new, ${skipped} cached, ${failed} failed)`);
      }
    } catch (err) {
      failed++;
      console.error(`[dl]   failed ${url}: ${err.message}`);
    }
    if (delay > 0) await sleep(delay);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceFiles: labsFiles,
    decklistCount: Object.keys(out).length,
    decklists: out,
  };
  // Minified — data file, not human-edited.
  writeFileSync(OUT_PATH, JSON.stringify(payload) + "\n");
  const bytes = statSync(OUT_PATH).size;
  console.error(`[dl] wrote ${OUT_PATH} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        urls: total,
        fetched,
        skipped,
        failed,
        decklistsCached: Object.keys(out).length,
        path: OUT_PATH,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`[dl] FATAL: ${err.stack ?? err.message}`);
  process.exit(1);
});
