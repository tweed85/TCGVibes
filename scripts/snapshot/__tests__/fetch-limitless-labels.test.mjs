// Unit tests for the pure parser/mapper helpers in fetch-limitless-labels.mjs.
// Mirrors the extract-and-eval pattern used by aggregate-rk9.test.mjs — the
// fetcher is a CLI that doesn't export its internals, so we pull them out by
// regex and sandbox them. A future refactor can split helpers into their own
// module; for now keeping the script self-contained is the priority.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptSrc = readFileSync(
  join(__dirname, "..", "fetch-limitless-labels.mjs"),
  "utf8",
);
const fixtureHtml = readFileSync(
  join(__dirname, "__fixtures__", "labs-standings.html"),
  "utf8",
);

// Same brace-walking extractor as the aggregator test — anchored to
// `^(function|const) NAME` at column 0.
function extractDecl(keyword, name) {
  const startRx = new RegExp(`^${keyword} ${name}\\b`, "m");
  const start = scriptSrc.search(startRx);
  if (start < 0) throw new Error(`${keyword} ${name} not found in fetcher`);
  let depth = 0;
  let i = scriptSrc.indexOf("{", start);
  for (; i < scriptSrc.length; i++) {
    if (scriptSrc[i] === "{") depth++;
    else if (scriptSrc[i] === "}") {
      depth--;
      if (depth === 0) {
        const next = scriptSrc[i + 1];
        return scriptSrc.slice(start, i + 1) + (next === ";" ? ";" : "");
      }
    }
  }
  throw new Error(`unterminated ${keyword} ${name}`);
}

// parseStandingsRows closes over the BASE constant (CDN host). The
// extractor only pulls function/const declarations; BASE is declared
// inline at the top of the script. Inject the value explicitly so the
// sandbox can reach it.
const helpers = new Function(
  `
  const BASE = "https://labs.limitlesstcg.com";
  ${extractDecl("function", "parseStandingsRows")}
  ${extractDecl("function", "labsSlugToEngineArchetype")}
  ${extractDecl("const", "LOWERCASE_TOKENS")}
  ${extractDecl("function", "slugToLabel")}
  return { parseStandingsRows, labsSlugToEngineArchetype, slugToLabel };
`,
)();

describe("fetch-limitless-labels helpers", () => {
  describe("parseStandingsRows", () => {
    const rows = helpers.parseStandingsRows(fixtureHtml, "0063");

    it("extracts every data row (skips header)", () => {
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    });

    it("captures name + country + record", () => {
      const r0 = rows[0];
      expect(r0.name).toBe("Andrew Hedrick");
      expect(r0.country).toBe("US");
      expect(r0.record).toEqual({ wins: 14, losses: 0, ties: 3 });
    });

    it("captures labs player id + archetype slug + decklist url", () => {
      const r0 = rows[0];
      expect(r0.playerId).toBe("0546");
      expect(r0.archetypeSlug).toBe("dragapult-ex");
      expect(r0.decklistUrl).toBe("https://labs.limitlesstcg.com/0063/player/0546/decklist");
    });

    it("handles a multi-segment paired-deck slug", () => {
      const r1 = rows[1];
      expect(r1.archetypeSlug).toBe("dragapult-dudunsparce");
    });

    it("nulls out archetypeSlug + decklistUrl when row has no deck link", () => {
      // Row 3 is an early-drop player with no submitted decklist.
      const r2 = rows[2];
      expect(r2.name).toBe("Pat Drop");
      expect(r2.archetypeSlug).toBeNull();
      expect(r2.decklistUrl).toBeNull();
    });

    it("preserves non-ASCII characters in player names", () => {
      // The fetcher itself doesn't normalize names — that's the aggregator's
      // job. Pin the raw value so downstream normalization stays consistent.
      expect(rows[3].name).toBe("Łukasz Polish");
      expect(rows[3].archetypeSlug).toBe("raging-bolt-ogerpon");
    });
  });

  describe("labsSlugToEngineArchetype", () => {
    it("maps wired labs slugs to engine archetypes", () => {
      // Pre-Stage-1 (the original 12 wired archetypes).
      expect(helpers.labsSlugToEngineArchetype("dragapult-dudunsparce")).toBe("dragapult-dudunsparce");
      expect(helpers.labsSlugToEngineArchetype("dragapult-blaziken")).toBe("dragapult-blaziken");
      expect(helpers.labsSlugToEngineArchetype("crustle")).toBe("crustle");
      expect(helpers.labsSlugToEngineArchetype("garchomp")).toBe("cynthia-garchomp");
      expect(helpers.labsSlugToEngineArchetype("grimmsnarl-froslass")).toBe("grimmsnarl-froslass");
      expect(helpers.labsSlugToEngineArchetype("alakazam")).toBe("alakazam");
      expect(helpers.labsSlugToEngineArchetype("rocket-mewtwo")).toBe("rocket-mewtwo");
      expect(helpers.labsSlugToEngineArchetype("mewtwo-spidops")).toBe("rocket-mewtwo");
      expect(helpers.labsSlugToEngineArchetype("dipplin-thwackey")).toBe("festival-leads");
      expect(helpers.labsSlugToEngineArchetype("starmie-mega-froslass")).toBe("mega-starmie-froslass");
      // Stage 1-5 expansion (14 new engine slugs). The labs URL slug
      // matches the engine slug exactly for most — these assertions guard
      // against accidental table deletion.
      expect(helpers.labsSlugToEngineArchetype("starmie-dusknoir")).toBe("starmie-dusknoir");
      expect(helpers.labsSlugToEngineArchetype("n-zoroark")).toBe("n-zoroark");
      expect(helpers.labsSlugToEngineArchetype("raging-bolt-ogerpon")).toBe("raging-bolt-ogerpon");
      expect(helpers.labsSlugToEngineArchetype("rockets-honchkrow")).toBe("rockets-honchkrow");
      expect(helpers.labsSlugToEngineArchetype("okidogi-barbaracle")).toBe("okidogi-barbaracle");
      expect(helpers.labsSlugToEngineArchetype("slowking-scr")).toBe("slowking-scr");
      expect(helpers.labsSlugToEngineArchetype("lopunny-dudunsparce")).toBe("lopunny-dudunsparce");
      expect(helpers.labsSlugToEngineArchetype("greninja-ex")).toBe("greninja-ex");
      expect(helpers.labsSlugToEngineArchetype("clefairy-ogerpon")).toBe("clefairy-ogerpon");
      expect(helpers.labsSlugToEngineArchetype("ogerpon-box")).toBe("ogerpon-box");
      expect(helpers.labsSlugToEngineArchetype("stevens-metagross")).toBe("stevens-metagross");
      expect(helpers.labsSlugToEngineArchetype("diancie-dusknoir")).toBe("diancie-dusknoir");
      expect(helpers.labsSlugToEngineArchetype("ursaluna-lunatone")).toBe("ursaluna-lunatone");
      expect(helpers.labsSlugToEngineArchetype("flareon-noctowl")).toBe("flareon-noctowl");
      // Stage 6 expansion — 2 Dragapult variants + 4 box decks.
      expect(helpers.labsSlugToEngineArchetype("dragapult-ex")).toBe("dragapult-ex");
      expect(helpers.labsSlugToEngineArchetype("dragapult-dusknoir")).toBe("dragapult-dusknoir");
      expect(helpers.labsSlugToEngineArchetype("hydrapple-ogerpon")).toBe("hydrapple-ogerpon");
      expect(helpers.labsSlugToEngineArchetype("ogerpon-meganium")).toBe("ogerpon-meganium");
      expect(helpers.labsSlugToEngineArchetype("mega-absol-box")).toBe("mega-absol-box");
      expect(helpers.labsSlugToEngineArchetype("tera-box")).toBe("tera-box");
      // Labs slug variants (labs uses singular "festival-lead" but engine
      // is plural "festival-leads"; labs has "-ex" / "-mega" suffix forms).
      expect(helpers.labsSlugToEngineArchetype("festival-lead")).toBe("festival-leads");
      expect(helpers.labsSlugToEngineArchetype("cynthia-garchomp-ex")).toBe("cynthia-garchomp");
      expect(helpers.labsSlugToEngineArchetype("rocket-mewtwo-ex")).toBe("rocket-mewtwo");
      expect(helpers.labsSlugToEngineArchetype("lucario-hariyama")).toBe("lucario-ex");
      expect(helpers.labsSlugToEngineArchetype("starmie-froslass")).toBe("mega-starmie-froslass");
      expect(helpers.labsSlugToEngineArchetype("crustle-dri")).toBe("crustle");
    });

    it("routes truly-unwired variants to 'unknown'", () => {
      // Real labs slugs that the engine doesn't yet recognize. These must
      // route to "unknown" rather than silently misdetecting as another
      // wired archetype. Pulled from the long-tail unknown-slug analysis
      // run on 2026-05-19 (~35 players spread across 18 singleton
      // variants).
      expect(helpers.labsSlugToEngineArchetype("ethan-typhlosion")).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("mega-venusaur-ex")).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("archaludon-ex")).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("toxtricity-box")).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("kangaskhan-bouffalant")).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("decidueye-ex")).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("ceruledge-ex")).toBe("unknown");
    });

    it("returns 'unknown' for null/undefined/empty", () => {
      expect(helpers.labsSlugToEngineArchetype(null)).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype(undefined)).toBe("unknown");
      expect(helpers.labsSlugToEngineArchetype("")).toBe("unknown");
    });
  });

  describe("slugToLabel", () => {
    it("title-cases hyphen-separated segments", () => {
      expect(helpers.slugToLabel("dragapult-dudunsparce")).toBe("Dragapult Dudunsparce");
      expect(helpers.slugToLabel("alakazam-dudunsparce")).toBe("Alakazam Dudunsparce");
      expect(helpers.slugToLabel("crustle")).toBe("Crustle");
    });

    it("preserves lowercase suffix tokens (ex / scr / box)", () => {
      // The labs site uses lowercase for these category tokens; matching it
      // keeps display labels readable instead of mangling to "Ex" / "Scr".
      expect(helpers.slugToLabel("dragapult-ex")).toBe("Dragapult ex");
      expect(helpers.slugToLabel("lucario-ex")).toBe("Lucario ex");
      expect(helpers.slugToLabel("slowking-scr")).toBe("Slowking scr");
      expect(helpers.slugToLabel("ogerpon-box")).toBe("Ogerpon box");
    });

    it("returns null for empty input", () => {
      expect(helpers.slugToLabel(null)).toBeNull();
      expect(helpers.slugToLabel(undefined)).toBeNull();
      expect(helpers.slugToLabel("")).toBeNull();
    });
  });
});
