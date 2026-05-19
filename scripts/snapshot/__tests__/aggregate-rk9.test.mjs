// Unit tests for pure helpers in aggregate-rk9-matchups.mjs. Hard-to-verify
// integration (HTTP + full pipeline) is exercised by running the script
// against the live RK9 cache; these tests pin the math + name-normalization.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The aggregator script isn't exporting its helpers (it's a CLI). For
// testing we eval the relevant pure functions out of the source. This is
// ugly but keeps the script self-contained and easy to read; a future
// refactor can split helpers into a separate module like rk9-parser.mjs.
const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "aggregate-rk9-matchups.mjs",
);
const scriptSrc = readFileSync(scriptPath, "utf8");

// Extract a top-level declaration by anchoring on its keyword + name. Brittle
// — relies on `^(function|const) NAME` at column 0 and matched braces. Fine
// for this tiny script; keeps the aggregator a single self-contained CLI.
function extractDecl(keyword, name) {
  const startRx = new RegExp(`^${keyword} ${name}\\b`, "m");
  const start = scriptSrc.search(startRx);
  if (start < 0) throw new Error(`${keyword} ${name} not found in aggregator`);
  // Walk braces to find the matching close (works for `function f() {...}`
  // and `const X = {...}` — both end with `}` matched to first `{`).
  let depth = 0;
  let i = scriptSrc.indexOf("{", start);
  for (; i < scriptSrc.length; i++) {
    if (scriptSrc[i] === "{") depth++;
    else if (scriptSrc[i] === "}") {
      depth--;
      if (depth === 0) {
        // Const decls end with `};\n` — include the semicolon.
        const next = scriptSrc[i + 1];
        return scriptSrc.slice(start, i + 1) + (next === ";" ? ";" : "");
      }
    }
  }
  throw new Error(`unterminated ${keyword} ${name}`);
}

// Build a sandbox with the extracted helpers + the const STROKED_LETTERS
// dep that normalizeName closes over.
const helpers = new Function(
  `
  ${extractDecl("const", "STROKED_LETTERS")}
  ${extractDecl("function", "normalizeName")}
  ${extractDecl("function", "lookupKey")}
  ${extractDecl("function", "wilson95")}
  ${extractDecl("function", "confidenceLabel")}
  ${extractDecl("function", "archetypeSlug")}
  return { normalizeName, lookupKey, wilson95, confidenceLabel, archetypeSlug };
`,
)();

describe("aggregate-rk9-matchups helpers", () => {
  describe("normalizeName", () => {
    it("strips diacritics + lowercases", () => {
      expect(helpers.normalizeName("Mateusz Łaszkiewicz")).toBe("mateusz laszkiewicz");
      expect(helpers.normalizeName("João Pires")).toBe("joao pires");
      expect(helpers.normalizeName("Maé Brusasco")).toBe("mae brusasco");
    });

    it("collapses internal whitespace", () => {
      expect(helpers.normalizeName("Foo   Bar")).toBe("foo bar");
      expect(helpers.normalizeName("  Trim Me  ")).toBe("trim me");
    });

    it("handles all-caps RK9 names", () => {
      expect(helpers.normalizeName("ULADZIMIR MAZALEUSKI")).toBe("uladzimir mazaleuski");
    });
  });

  describe("lookupKey", () => {
    it("composes name + country for disambiguation", () => {
      expect(helpers.lookupKey("João Pires", "PT")).toBe("joao pires|PT");
    });

    it("falls back to name-only when country missing", () => {
      expect(helpers.lookupKey("João Pires", undefined)).toBe("joao pires");
      expect(helpers.lookupKey("João Pires", null)).toBe("joao pires");
    });

    it("uppercases country (RK9 sometimes lowercases)", () => {
      expect(helpers.lookupKey("Test", "us")).toBe("test|US");
    });
  });

  describe("wilson95", () => {
    it("returns [0, 1] for zero total (degenerate case)", () => {
      expect(helpers.wilson95(0, 0)).toEqual({ ci95Low: 0, ci95High: 1 });
    });

    it("centers near 0.5 for 50% with moderate sample", () => {
      const ci = helpers.wilson95(10, 20);
      expect(ci.ci95Low).toBeGreaterThan(0.27);
      expect(ci.ci95Low).toBeLessThan(0.32);
      expect(ci.ci95High).toBeGreaterThan(0.68);
      expect(ci.ci95High).toBeLessThan(0.73);
    });

    it("widens at extremes", () => {
      // 1 win in 2 — high uncertainty
      const lowSample = helpers.wilson95(1, 2);
      expect(lowSample.ci95High - lowSample.ci95Low).toBeGreaterThan(0.6);
      // 50 wins in 100 — much narrower
      const highSample = helpers.wilson95(50, 100);
      expect(highSample.ci95High - highSample.ci95Low).toBeLessThan(0.2);
    });

    it("never returns CI bounds outside [0, 1]", () => {
      expect(helpers.wilson95(0, 1).ci95Low).toBeGreaterThanOrEqual(0);
      expect(helpers.wilson95(1, 1).ci95High).toBeLessThanOrEqual(1);
    });
  });

  describe("confidenceLabel", () => {
    it("matches snapshot thresholds (high ≥30, medium ≥10, low <10)", () => {
      expect(helpers.confidenceLabel(30)).toBe("high");
      expect(helpers.confidenceLabel(50)).toBe("high");
      expect(helpers.confidenceLabel(29)).toBe("medium");
      expect(helpers.confidenceLabel(10)).toBe("medium");
      expect(helpers.confidenceLabel(9)).toBe("low");
      expect(helpers.confidenceLabel(0)).toBe("low");
    });
  });

  describe("archetypeSlug", () => {
    it("maps wired natural-language labels to engine slugs", () => {
      expect(helpers.archetypeSlug("Dragapult / Dudunsparce")).toBe("dragapult-dudunsparce");
      expect(helpers.archetypeSlug("Dragapult / Blaziken")).toBe("dragapult-blaziken");
      expect(helpers.archetypeSlug("Crustle")).toBe("crustle");
      expect(helpers.archetypeSlug("Garchomp")).toBe("cynthia-garchomp");
      expect(helpers.archetypeSlug("Cynthia's Garchomp ex")).toBe("cynthia-garchomp");
      expect(helpers.archetypeSlug("Grimmsnarl / Froslass")).toBe("grimmsnarl-froslass");
      expect(helpers.archetypeSlug("Alakazam / Dudunsparce")).toBe("alakazam");
      expect(helpers.archetypeSlug("Rocket Mewtwo ex")).toBe("rocket-mewtwo");
      expect(helpers.archetypeSlug("Mewtwo / Spidops")).toBe("rocket-mewtwo");
      expect(helpers.archetypeSlug("Starmie-Mega / Froslass")).toBe("mega-starmie-froslass");
      expect(helpers.archetypeSlug("Dipplin / Thwackey")).toBe("festival-leads");
    });

    it("routes unmapped variants to 'unknown'", () => {
      // These are real variants from the Top 16s but aren't in the engine's
      // Archetype union yet — same as in the snapshot's topFinishes.
      expect(helpers.archetypeSlug("Dragapult")).toBe("unknown");
      expect(helpers.archetypeSlug("Dragapult ex")).toBe("unknown");
      expect(helpers.archetypeSlug("Dragapult / Dusknoir")).toBe("unknown");
      expect(helpers.archetypeSlug("Starmie / Dusknoir")).toBe("unknown");
      expect(helpers.archetypeSlug("N's Zoroark")).toBe("unknown");
      expect(helpers.archetypeSlug("Lopunny / Dudunsparce")).toBe("unknown");
      expect(helpers.archetypeSlug("Lopunny-Mega / Dudunsparce")).toBe("unknown");
      expect(helpers.archetypeSlug("Honchkrow / Porygon2")).toBe("unknown");
      expect(helpers.archetypeSlug("Hydrapple")).toBe("unknown");
      expect(helpers.archetypeSlug("Raging Bolt / Ogerpon")).toBe("unknown");
      expect(helpers.archetypeSlug("Ogerpon Box")).toBe("unknown");
      expect(helpers.archetypeSlug("Ogerpon / Meganium")).toBe("unknown");
      expect(helpers.archetypeSlug("Ogerpon / Ogerpon-Wellspring")).toBe("unknown");
      expect(helpers.archetypeSlug("Noctowl / Ogerpon-Wellspring")).toBe("unknown");
      expect(helpers.archetypeSlug("Clefairy / Ogerpon")).toBe("unknown");
      expect(helpers.archetypeSlug("Lucario-Mega / Hariyama")).toBe("unknown");
      expect(helpers.archetypeSlug("Greninja")).toBe("unknown");
      expect(helpers.archetypeSlug("Slowking")).toBe("unknown");
      expect(helpers.archetypeSlug("Zoroark")).toBe("unknown");
    });

    it("returns 'unknown' for empty / undefined input", () => {
      expect(helpers.archetypeSlug(undefined)).toBe("unknown");
      expect(helpers.archetypeSlug(null)).toBe("unknown");
      expect(helpers.archetypeSlug("")).toBe("unknown");
    });
  });
});
